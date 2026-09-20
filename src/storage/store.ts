// SQLite durable store. Single DB owner guard, append-only events,
// jobs/attempts/native-sessions separation, idempotency, capacity reservations.
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { CanonicalEvent, QuotaObservation, PermissionOption, normalizePermissionOptions } from "../contracts/index.js";

export const JOB_STATES = [
  "queued",
  "running",
  "awaiting_approval",
  "verifying",
  "succeeded",
  "failed",
  "cancelled",
  "needs_recovery",
] as const;
export type JobState = (typeof JOB_STATES)[number];
const TERMINAL = new Set<JobState>(["succeeded", "failed", "cancelled"]);
export const isTerminal = (s: JobState) => TERMINAL.has(s);

// Allowed transitions; terminal states never return to running.
const TRANSITIONS: Record<JobState, JobState[]> = {
  queued: ["running", "cancelled", "failed", "needs_recovery"],
  running: ["awaiting_approval", "verifying", "succeeded", "failed", "cancelled", "needs_recovery"],
  awaiting_approval: ["running", "cancelled", "failed", "needs_recovery"],
  verifying: ["succeeded", "failed", "needs_recovery"],
  succeeded: [],
  failed: [],
  cancelled: [],
  needs_recovery: ["queued", "failed", "cancelled"], // operator/recovery only; never auto running
};

const SCHEMA = `
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS db_owner(
  id INTEGER PRIMARY KEY CHECK(id=1),
  owner_id TEXT NOT NULL,
  pid INTEGER NOT NULL,
  acquired_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs(
  job_id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  task TEXT NOT NULL,
  role TEXT NOT NULL,
  policy TEXT NOT NULL,
  workspace_mode TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  workspace_handle TEXT,
  request_json TEXT,
  status TEXT NOT NULL,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  deadline_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  result_json TEXT
);
CREATE TABLE IF NOT EXISTS attempts(
  attempt_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  status TEXT NOT NULL,
  native_session_id TEXT,
  pid INTEGER, pgid INTEGER, exe_realpath TEXT, proc_start TEXT,
  child_pid INTEGER, child_pgid INTEGER, child_start TEXT, child_exe TEXT,
  side_effects TEXT, retry_safety TEXT,
  error_json TEXT, result_json TEXT,
  created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
);
CREATE TABLE IF NOT EXISTS events(
  event_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  attempt_id TEXT,
  run_id TEXT,
  sequence INTEGER NOT NULL,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  native_session_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_job ON events(job_id, sequence);
CREATE TRIGGER IF NOT EXISTS events_immutable_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT,'events append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_immutable_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT,'events append-only'); END;
CREATE TABLE IF NOT EXISTS idempotency_keys(
  principal TEXT NOT NULL, key TEXT NOT NULL,
  body_sha256 TEXT NOT NULL, job_id TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(principal, key)
);
CREATE TABLE IF NOT EXISTS approvals(
  approval_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL, attempt_id TEXT NOT NULL, run_id TEXT NOT NULL,
  native_request_id TEXT NOT NULL,
  action TEXT NOT NULL, target TEXT NOT NULL, options_json TEXT NOT NULL,
  status TEXT NOT NULL,           -- pending|approved|denied|expired|invalidated
  chosen_option TEXT,             -- the exact option id decided (verbatim)
  delivery_state TEXT NOT NULL DEFAULT 'pending', -- pending|delivered|failed|invalidated
  actor TEXT, decided_at TEXT, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS quota_observations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_id TEXT NOT NULL, model_id TEXT NOT NULL,
  pool_id TEXT NOT NULL, status TEXT NOT NULL,
  remaining INTEGER, "limit" INTEGER, unit TEXT NOT NULL,
  source TEXT NOT NULL, observed_at TEXT NOT NULL, expires_at TEXT, estimated INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS capacity_reservations(
  reservation_id TEXT PRIMARY KEY,
  pool_key TEXT NOT NULL,           -- e.g. plugin:<id> or quota pool id
  attempt_id TEXT NOT NULL, job_id TEXT NOT NULL,
  state TEXT NOT NULL,              -- held|released|quarantined
  created_at TEXT NOT NULL, released_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_capacity_pool ON capacity_reservations(pool_key, state);
CREATE TABLE IF NOT EXISTS decision_records(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL, kind TEXT NOT NULL,       -- route|fallback|lead_handoff
  adapter TEXT NOT NULL, detail_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workspaces(
  handle TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  realpath TEXT NOT NULL,
  locked_by TEXT,                  -- job_id holding serialized use
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS artifacts(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
  kind TEXT NOT NULL, ref TEXT NOT NULL, meta_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS candidate_observations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id TEXT NOT NULL, plugin_id TEXT NOT NULL, model_id TEXT NOT NULL,
  kind TEXT NOT NULL,             -- probe|run|quota|error
  latency_ms INTEGER, error_json TEXT, detail_json TEXT,
  observed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cand_obs ON candidate_observations(candidate_id, id);
CREATE TABLE IF NOT EXISTS evaluations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,             -- model|candidate|task
  subject_id TEXT NOT NULL,       -- model_id or candidate_id
  catalog_fingerprint TEXT,
  rubric_version TEXT, fit INTEGER, confidence INTEGER,
  reasons_json TEXT, provenance TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

export interface JobRow {
  job_id: string; principal: string; task: string; role: string; policy: string;
  workspace_mode: string; workspace_path: string; workspace_handle: string | null;
  request_json: string | null; cancel_requested: number;
  status: JobState; deadline_ms: number; created_at: string; updated_at: string;
  result_json: string | null;
}
export interface AttemptRow {
  attempt_id: string; job_id: string; candidate_id: string; plugin_id: string;
  model_id: string; status: JobState; native_session_id: string | null;
  pid: number | null; pgid: number | null; exe_realpath: string | null; proc_start: string | null;
  child_pid: number | null; child_pgid: number | null; child_start: string | null; child_exe: string | null;
  side_effects: string | null; retry_safety: string | null;
  error_json: string | null; result_json: string | null;
  created_at: string; started_at: string | null; finished_at: string | null;
}

export class Store {
  readonly db: DatabaseSync;
  readonly ownerId = randomUUID();

  constructor(readonly dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
    this.acquireOwner();
  }

  // Single owner guard: one live daemon owns the DB. Owner liveness is checked
  // via pid + recorded acquire time; a dead pid releases the lock.
  private acquireOwner() {
    const row = this.db
      .prepare("SELECT owner_id, pid FROM db_owner WHERE id=1")
      .get() as { owner_id: string; pid: number } | undefined;
    if (row) {
      let alive = false;
      try {
        process.kill(row.pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
      if (alive && row.owner_id !== this.ownerId) {
        throw new Error(`DB owned by live router pid=${row.pid}; refusing second owner`);
      }
      this.db.prepare("DELETE FROM db_owner WHERE id=1").run();
    }
    this.db
      .prepare("INSERT INTO db_owner(id,owner_id,pid,acquired_at) VALUES(1,?,?,?)")
      .run(this.ownerId, process.pid, new Date().toISOString());
  }

  close() {
    try {
      this.db.prepare("DELETE FROM db_owner WHERE id=1 AND owner_id=?").run(this.ownerId);
    } finally {
      this.db.close();
    }
  }

  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // ---------- jobs ----------
  createJob(j: Omit<JobRow, "created_at" | "updated_at" | "result_json" | "status" | "cancel_requested"> & { status?: JobState }) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO jobs(job_id,principal,task,role,policy,workspace_mode,workspace_path,workspace_handle,request_json,status,deadline_ms,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(j.job_id, j.principal, j.task, j.role, j.policy, j.workspace_mode, j.workspace_path,
        j.workspace_handle, j.request_json ?? null, j.status ?? "queued", j.deadline_ms, now, now);
  }
  getJob(id: string): JobRow | undefined {
    return this.db.prepare("SELECT * FROM jobs WHERE job_id=?").get(id) as JobRow | undefined;
  }
  transitionJob(id: string, to: JobState): boolean {
    const j = this.getJob(id);
    if (!j) throw new Error(`job ${id} not found`);
    if (!TRANSITIONS[j.status].includes(to)) return false;
    this.db.prepare("UPDATE jobs SET status=?, updated_at=? WHERE job_id=?")
      .run(to, new Date().toISOString(), id);
    return true;
  }
  setJobResult(id: string, result: unknown) {
    this.db.prepare("UPDATE jobs SET result_json=?, updated_at=? WHERE job_id=?")
      .run(JSON.stringify(result), new Date().toISOString(), id);
  }

  // ---------- attempts ----------
  createAttempt(a: Pick<AttemptRow, "attempt_id" | "job_id" | "candidate_id" | "plugin_id" | "model_id">) {
    this.db
      .prepare(
        `INSERT INTO attempts(attempt_id,job_id,candidate_id,plugin_id,model_id,status,created_at)
         VALUES(?,?,?,?,?,'queued',?)`,
      )
      .run(a.attempt_id, a.job_id, a.candidate_id, a.plugin_id, a.model_id, new Date().toISOString());
  }
  getAttempt(id: string): AttemptRow | undefined {
    return this.db.prepare("SELECT * FROM attempts WHERE attempt_id=?").get(id) as AttemptRow | undefined;
  }
  attemptsForJob(jobId: string): AttemptRow[] {
    return this.db.prepare("SELECT * FROM attempts WHERE job_id=? ORDER BY created_at").all(jobId) as unknown as AttemptRow[];
  }
  markAttemptRunning(id: string, ident: { pid: number; pgid: number; exe: string; start: string }) {
    const ok = this.db
      .prepare(
        `UPDATE attempts SET status='running', pid=?, pgid=?, exe_realpath=?, proc_start=?, started_at=?
         WHERE attempt_id=? AND status='queued'`,
      )
      .run(ident.pid, ident.pgid, ident.exe, ident.start, new Date().toISOString(), id);
    return ok.changes === 1;
  }
  finishAttempt(id: string, to: JobState, fields: { side_effects?: string; retry_safety?: string; error?: unknown; result?: unknown; native_session_id?: string }) {
    const a = this.getAttempt(id);
    if (!a) throw new Error("attempt not found");
    if (isTerminal(a.status)) return false; // terminal immutable
    if (!TRANSITIONS[a.status].includes(to)) return false;
    this.db
      .prepare(
        `UPDATE attempts SET status=?, side_effects=?, retry_safety=?, error_json=?, result_json=?,
           native_session_id=COALESCE(?,native_session_id), finished_at=? WHERE attempt_id=?`,
      )
      .run(to, fields.side_effects ?? a.side_effects, fields.retry_safety ?? a.retry_safety,
        fields.error ? JSON.stringify(fields.error) : a.error_json,
        fields.result ? JSON.stringify(fields.result) : a.result_json,
        fields.native_session_id ?? null, new Date().toISOString(), id);
    return true;
  }
  setAttemptChildPgid(id: string, pgid: number) {
    // raw compat setter: a naked pgid carries NO verified identity — signal
    // paths must ignore rows without child_pid+child_start.
    this.db.prepare("UPDATE attempts SET child_pgid=? WHERE attempt_id=?").run(pgid, id);
  }
  setAttemptChildIdentity(id: string, ident: { pid: number; pgid: number; proc_start: string; exe_realpath: string | null }) {
    this.db
      .prepare("UPDATE attempts SET child_pid=?, child_pgid=?, child_start=?, child_exe=? WHERE attempt_id=?")
      .run(ident.pid, ident.pgid, ident.proc_start, ident.exe_realpath, id);
  }
  // Verified native child identity, or null when any required field is absent.
  // exe_realpath "" means "not recorded" — verifiers skip the exe check then.
  attemptChildIdentity(a: AttemptRow): { pid: number; pgid: number; proc_start: string; exe_realpath: string } | null {
    if (a.child_pid === null || a.child_pgid === null || !a.child_start) return null;
    return { pid: a.child_pid, pgid: a.child_pgid, proc_start: a.child_start, exe_realpath: a.child_exe ?? "" };
  }
  setAttemptState(id: string, to: JobState) {
    const a = this.getAttempt(id);
    if (!a || isTerminal(a.status) || !TRANSITIONS[a.status].includes(to)) return false;
    this.db.prepare("UPDATE attempts SET status=? WHERE attempt_id=?").run(to, id);
    return true;
  }
  nonTerminalAttempts(): AttemptRow[] {
    return this.db
      .prepare("SELECT * FROM attempts WHERE status IN ('queued','running','awaiting_approval','verifying')")
      .all() as unknown as AttemptRow[];
  }

  // ---------- events (append-only) ----------
  nextSequence(jobId: string): number {
    const r = this.db.prepare("SELECT COALESCE(MAX(sequence),-1)+1 AS s FROM events WHERE job_id=?").get(jobId) as { s: number };
    return r.s;
  }
  appendEvent(ev: CanonicalEvent) {
    this.db
      .prepare(
        `INSERT INTO events(event_id,job_id,attempt_id,run_id,sequence,ts,kind,payload_json,native_session_id)
         VALUES(?,?,?,?,?,?,?,?,?)`,
      )
      .run(ev.event_id, ev.job_id, ev.attempt_id, ev.run_id, ev.sequence, ev.ts, ev.kind,
        JSON.stringify((ev as { payload?: unknown }).payload ?? {}), ev.native_session_id ?? null);
  }
  eventsForJob(jobId: string, afterSeq = -1, limit = 1000): CanonicalEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE job_id=? AND sequence>? ORDER BY sequence LIMIT ?")
      .all(jobId, afterSeq, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      schema_version: 1,
      job_id: r.job_id as string,
      attempt_id: (r.attempt_id as string) ?? "",
      run_id: (r.run_id as string) ?? "",
      event_id: r.event_id as string,
      sequence: r.sequence as number,
      ts: r.ts as string,
      kind: r.kind as CanonicalEvent["kind"],
      native_session_id: (r.native_session_id as string) ?? undefined,
      payload: JSON.parse(r.payload_json as string),
    })) as CanonicalEvent[];
  }

  // ---------- idempotency ----------
  // Returns {job_id} on same-body replay; throws on different body with same
  // key. Replay is resolved BEFORE any admission-cap guard: admitNew runs
  // inside this transaction only when a genuinely new job would be created,
  // so a replayed key is never rejected for capacity and the cap check +
  // insert cannot race a concurrent new submission.
  idempotentJob(principal: string, key: string, bodySha: string, createJobId: () => string, admitNew?: () => void): { job_id: string; replayed: boolean } {
    return this.tx(() => {
      const existing = this.db
        .prepare("SELECT job_id, body_sha256 FROM idempotency_keys WHERE principal=? AND key=?")
        .get(principal, key) as { job_id: string; body_sha256: string } | undefined;
      if (existing) {
        if (existing.body_sha256 !== bodySha) throw new Error("IDEMPOTENCY_CONFLICT");
        return { job_id: existing.job_id, replayed: true };
      }
      admitNew?.();
      const job_id = createJobId();
      this.db
        .prepare("INSERT INTO idempotency_keys(principal,key,body_sha256,job_id,created_at) VALUES(?,?,?,?,?)")
        .run(principal, key, bodySha, job_id, new Date().toISOString());
      return { job_id, replayed: false };
    });
  }

  // ---------- quota observations ----------
  recordQuota(o: { plugin_id: string; model_id: string; pool_id: string; status: string; remaining: number | null; limit: number | null; unit: string; source: string; observed_at: string; expires_at?: string; estimated: boolean }) {
    this.db
      .prepare(
        `INSERT INTO quota_observations(plugin_id,model_id,pool_id,status,remaining,"limit",unit,source,observed_at,expires_at,estimated)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(o.plugin_id, o.model_id, o.pool_id, o.status, o.remaining, o.limit, o.unit, o.source,
        o.observed_at, o.expires_at ?? null, o.estimated ? 1 : 0);
  }
  latestQuota(pluginId: string, modelId: string): QuotaObservation | undefined {
    return this.db
      .prepare("SELECT pool_id,status,remaining,\"limit\",unit,source,observed_at,expires_at,estimated FROM quota_observations WHERE plugin_id=? AND model_id=? ORDER BY id DESC LIMIT 1")
      .get(pluginId, modelId) as QuotaObservation | undefined;
  }

  // ---------- capacity reservations (atomic) ----------
  reserveCapacity(poolKey: string, max: number, attemptId: string, jobId: string): string | null {
    return this.tx(() => {
      const held = this.db
        .prepare("SELECT COUNT(*) AS n FROM capacity_reservations WHERE pool_key=? AND state IN ('held','quarantined')")
        .get(poolKey) as { n: number };
      if (held.n >= max) return null;
      const rid = randomUUID();
      this.db
        .prepare("INSERT INTO capacity_reservations(reservation_id,pool_key,attempt_id,job_id,state,created_at) VALUES(?,?,?,?,'held',?)")
        .run(rid, poolKey, attemptId, jobId, new Date().toISOString());
      return rid;
    });
  }
  releaseCapacity(reservationId: string, quarantine = false) {
    this.db
      .prepare("UPDATE capacity_reservations SET state=?, released_at=? WHERE reservation_id=? AND state='held'")
      .run(quarantine ? "quarantined" : "released", new Date().toISOString(), reservationId);
  }
  // Atomic multi-pool reservation: every pool must have a free slot or NO
  // reservation is created. Local slot estimate only — never a provider-side
  // quota guarantee.
  reserveCapacityMulti(pools: { key: string; max: number }[], attemptId: string, jobId: string): string[] | null {
    return this.tx(() => {
      const ids: string[] = [];
      for (const p of pools) {
        const held = this.db
          .prepare("SELECT COUNT(*) AS n FROM capacity_reservations WHERE pool_key=? AND state IN ('held','quarantined')")
          .get(p.key) as { n: number };
        if (held.n >= p.max) {
          return null; // whole transaction rolls back — nothing held
        }
        ids.push(randomUUID());
      }
      const now = new Date().toISOString();
      pools.forEach((p, i) => {
        this.db
          .prepare("INSERT INTO capacity_reservations(reservation_id,pool_key,attempt_id,job_id,state,created_at) VALUES(?,?,?,?,'held',?)")
          .run(ids[i]!, p.key, attemptId, jobId, now);
      });
      return ids;
    });
  }
  reservationsForAttempt(attemptId: string): { reservation_id: string; pool_key: string; state: string }[] {
    return this.db
      .prepare("SELECT reservation_id,pool_key,state FROM capacity_reservations WHERE attempt_id=?")
      .all(attemptId) as never;
  }

  // ---------- decisions ----------
  recordDecision(jobId: string, kind: string, adapter: string, detail: unknown) {
    this.db
      .prepare("INSERT INTO decision_records(job_id,kind,adapter,detail_json,created_at) VALUES(?,?,?,?,?)")
      .run(jobId, kind, adapter, JSON.stringify(detail), new Date().toISOString());
  }
  decisionsForJob(jobId: string): { kind: string; adapter: string; detail_json: string; created_at: string }[] {
    return this.db.prepare("SELECT kind,adapter,detail_json,created_at FROM decision_records WHERE job_id=?").all(jobId) as never;
  }

  // ---------- workspaces ----------
  registerWorkspace(handle: string, principal: string, realpath: string) {
    this.db
      .prepare("INSERT OR IGNORE INTO workspaces(handle,principal,realpath,created_at) VALUES(?,?,?,?)")
      .run(handle, principal, realpath, new Date().toISOString());
  }
  getWorkspace(handle: string): { handle: string; principal: string; realpath: string; locked_by: string | null } | undefined {
    return this.db.prepare("SELECT * FROM workspaces WHERE handle=?").get(handle) as never;
  }
  lockWorkspace(handle: string, jobId: string): boolean {
    const r = this.db
      .prepare("UPDATE workspaces SET locked_by=? WHERE handle=? AND locked_by IS NULL")
      .run(jobId, handle);
    return r.changes === 1;
  }
  unlockWorkspace(handle: string, jobId: string) {
    this.db.prepare("UPDATE workspaces SET locked_by=NULL WHERE handle=? AND locked_by=?").run(handle, jobId);
  }

  // ---------- approvals ----------
  createApproval(a: { approval_id: string; job_id: string; attempt_id: string; run_id: string; native_request_id: string; action: string; target: string; options: (string | PermissionOption)[]; ttl_ms: number }) {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO approvals(approval_id,job_id,attempt_id,run_id,native_request_id,action,target,options_json,status,expires_at,created_at)
         VALUES(?,?,?,?,?,?,?,?,'pending',?,?)`,
      )
      .run(a.approval_id, a.job_id, a.attempt_id, a.run_id, a.native_request_id, a.action, a.target,
        JSON.stringify(normalizePermissionOptions(a.options)), new Date(now + a.ttl_ms).toISOString(), new Date(now).toISOString());
  }
  approvalsForJob(jobId: string) {
    return this.db.prepare("SELECT * FROM approvals WHERE job_id=?").all(jobId) as unknown as {
      approval_id: string; job_id: string; action: string; target: string; options_json: string; status: string; chosen_option: string | null; delivery_state: string; expires_at: string;
    }[];
  }
  getApproval(id: string) {
    return this.db.prepare("SELECT * FROM approvals WHERE approval_id=?").get(id) as
      | { approval_id: string; job_id: string; attempt_id: string; run_id: string; native_request_id: string; action: string; target: string; options_json: string; status: string; chosen_option: string | null; delivery_state: string; actor: string | null; decided_at: string | null; expires_at: string }
      | undefined;
  }
  // Atomic first-decision-wins; also enforces expiry. Returns "already" for
  // repeat decisions (existing decision stands — never re-delivered).
  decideApproval(id: string, actor: string, option: string): "approved" | "denied" | "expired" | "invalid" | "already" {
    return this.tx(() => {
      const a = this.getApproval(id);
      if (!a) return "invalid";
      if (a.status !== "pending") {
        return a.status === "approved" || a.status === "denied" ? "already" : "invalid";
      }
      if (new Date(a.expires_at).getTime() < Date.now()) {
        this.db.prepare("UPDATE approvals SET status='expired', decided_at=? WHERE approval_id=?").run(new Date().toISOString(), id);
        return "expired";
      }
      const options = normalizePermissionOptions(JSON.parse(a.options_json) as (string | PermissionOption)[]);
      const chosen = options.find((o) => o.id === option);
      if (!chosen) return "invalid"; // must be an offered option
      // typed verdict: explicit kind wins; only the legacy "unknown" path
      // falls back to the id prefix heuristic.
      const status = chosen.kind === "allow" ? "approved" : chosen.kind !== "unknown" ? "denied" : /^allow/i.test(option) ? "approved" : "denied";
      const r = this.db
        .prepare("UPDATE approvals SET status=?, chosen_option=?, actor=?, decided_at=? WHERE approval_id=? AND status='pending'")
        .run(status, option, actor, new Date().toISOString(), id);
      if (r.changes !== 1) return "invalid"; // lost race
      return status;
    });
  }
  setApprovalDelivery(id: string, state: "delivered" | "failed" | "invalidated") {
    this.db.prepare("UPDATE approvals SET delivery_state=? WHERE approval_id=?").run(state, id);
  }
  invalidatePendingApprovals(attemptId: string) {
    this.db
      .prepare("UPDATE approvals SET status='invalidated', delivery_state='invalidated', decided_at=? WHERE attempt_id=? AND status='pending'")
      .run(new Date().toISOString(), attemptId);
  }

  // ---------- admission counting ----------
  countActiveJobs(principal?: string): number {
    const row = principal
      ? (this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE principal=? AND status IN ('queued','running','awaiting_approval','verifying')").get(principal) as { n: number })
      : (this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running','awaiting_approval','verifying')").get() as { n: number });
    return row.n;
  }
  cancelRequested(jobId: string): boolean {
    const r = this.db.prepare("SELECT cancel_requested FROM jobs WHERE job_id=?").get(jobId) as { cancel_requested: number } | undefined;
    return r?.cancel_requested === 1;
  }
  markCancelRequested(jobId: string) {
    this.db.prepare("UPDATE jobs SET cancel_requested=1, updated_at=? WHERE job_id=?").run(new Date().toISOString(), jobId);
  }
  eventById(jobId: string, eventId: string): { event_id: string; sequence: number } | undefined {
    return this.db.prepare("SELECT event_id, sequence FROM events WHERE job_id=? AND event_id=?").get(jobId, eventId) as never;
  }
  recordCandidateObservation(o: { candidate_id: string; plugin_id: string; model_id: string; kind: string; latency_ms?: number; error?: unknown; detail?: unknown }) {
    this.db
      .prepare("INSERT INTO candidate_observations(candidate_id,plugin_id,model_id,kind,latency_ms,error_json,detail_json,observed_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(o.candidate_id, o.plugin_id, o.model_id, o.kind, o.latency_ms ?? null,
        o.error ? JSON.stringify(o.error) : null, o.detail ? JSON.stringify(o.detail) : null,
        new Date().toISOString());
  }
  latestObservationLatency(candidateId: string): number | null {
    const r = this.db
      .prepare("SELECT latency_ms FROM candidate_observations WHERE candidate_id=? AND latency_ms IS NOT NULL ORDER BY id DESC LIMIT 1")
      .get(candidateId) as { latency_ms: number } | undefined;
    return r?.latency_ms ?? null;
  }
  recordEvaluation(e: { kind: string; subject_id: string; catalog_fingerprint?: string; rubric_version?: string; fit?: number; confidence?: number; reasons?: unknown; provenance: string }) {
    this.db
      .prepare("INSERT INTO evaluations(kind,subject_id,catalog_fingerprint,rubric_version,fit,confidence,reasons_json,provenance,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(e.kind, e.subject_id, e.catalog_fingerprint ?? null, e.rubric_version ?? null,
        e.fit ?? null, e.confidence ?? null, JSON.stringify(e.reasons ?? null), e.provenance,
        new Date().toISOString());
  }
  recordArtifact(a: { job_id: string; attempt_id: string; kind: string; ref: string; meta: unknown }) {
    this.db
      .prepare("INSERT INTO artifacts(job_id,attempt_id,kind,ref,meta_json,created_at) VALUES(?,?,?,?,?,?)")
      .run(a.job_id, a.attempt_id, a.kind, a.ref, JSON.stringify(a.meta), new Date().toISOString());
  }
  artifactsForJob(jobId: string): { kind: string; ref: string; meta_json: string }[] {
    return this.db.prepare("SELECT kind,ref,meta_json FROM artifacts WHERE job_id=?").all(jobId) as never;
  }
}
