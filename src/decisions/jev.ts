// Jev Decision Adapter — decision-ONLY module for the native agent router.
//
// Talks to the official documented endpoint POST https://api.typesafe.ai/v1/systemone
// (docs.typesafe.ai/api.md). Self-contained: zero runtime deps, hand-rolled
// validation tied to the documented wire schema. Cannot execute, authorize,
// relax constraints, or route to arbitrary URLs. The API key is constructor-only
// and is never read from worker-inheritable environment, logged, or audited.

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone" as const;
export const JEV_MODEL_PINNED = "jev-1.13.0" as const;
export const JEV_SCHEMA_VERSION = "jev-decision-adapter/1" as const;

// ---------- errors ----------

export type JevErrorCode =
  | "JEV_CONFIG" // bad local configuration (e.g. empty key)
  | "JEV_TRANSPORT" // fetch-level failure (no body surfaced)
  | "JEV_TIMEOUT" // per-call or total deadline exceeded
  | "JEV_HTTP" // non-2xx status; error body is never read/logged
  | "JEV_OVERSIZE" // response exceeded byte cap
  | "JEV_BAD_RESPONSE"; // well-formed transport but schema/semantic violation

export class JevError extends Error {
  readonly code: JevErrorCode;
  readonly status?: number;
  constructor(code: JevErrorCode, message: string, opts?: { status?: number; cause?: unknown }) {
    super(message);
    this.name = "JevError";
    this.code = code;
    if (opts?.status !== undefined) this.status = opts.status;
    if (opts?.cause !== undefined) this.cause = opts.cause;
  }
}

// ---------- wire types (docs.typesafe.ai/api.md) ----------

export type Question =
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "score"; instructions: string; criteria: string[] };

export type NoulAnswer = { type: "noul"; noul: number };
export type ChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  // Distribution-derived certainty only. NEVER a task-success probability.
  confidence: number;
};
export type ScoreAnswer = {
  type: "score";
  score: number; // fractional probability-weighted level index, [0, levels-1]
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  // Distribution-derived certainty only. NEVER a task-success probability.
  confidence: number;
};
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface SystemOneResponse {
  model: string; // actual model that answered (may differ from requested)
  answers: Record<string, Answer>;
  usage: { input_tokens: number; output_tokens: number };
}

export interface FetchInitLike {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}
export interface ResponseLike {
  ok: boolean;
  status: number;
  body: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } } | null;
  arrayBuffer(): Promise<ArrayBuffer>;
}
export type FetchLike = (url: string, init: FetchInitLike) => Promise<ResponseLike>;

// ---------- validation helpers ----------

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const PROB_SUM_TOL = 0.01;

function bad(msg: string): never {
  throw new JevError("JEV_BAD_RESPONSE", msg);
}

function prob01(v: unknown, what: string): number {
  if (!finite(v) || v < 0 || v > 1) bad(`${what} out of [0,1] or non-finite`);
  return v;
}

function exactKeys(obj: Record<string, unknown>, expected: string[], what: string): void {
  const got = Object.keys(obj);
  if (got.length !== expected.length) bad(`${what}: expected ${expected.length} keys, got ${got.length}`);
  for (const k of expected) if (!(k in obj)) bad(`${what}: missing key ${JSON.stringify(k)}`);
}

function checkProbabilities(
  probs: unknown,
  expectedKeys: string[],
  what: string,
): Record<string, number> {
  if (!isObj(probs)) bad(`${what}: probabilities not an object`);
  exactKeys(probs, expectedKeys, `${what} probability keys`);
  let sum = 0;
  const out: Record<string, number> = {};
  for (const k of expectedKeys) {
    const p = prob01(probs[k], `${what} probability ${JSON.stringify(k)}`);
    out[k] = p;
    sum += p;
  }
  if (Math.abs(sum - 1) > PROB_SUM_TOL) bad(`${what} probabilities sum ${sum} != 1`);
  return out;
}

function validateQuestion(id: string, q: Question): void {
  if (!isStr(id) || id.length === 0 || id.length > 128) bad(`bad question id ${JSON.stringify(id)}`);
  if (!isObj(q) || !isStr(q.instructions)) bad(`question ${id}: bad instructions`);
  if (q.type === "choice") {
    const keys = Object.keys(q.criteria ?? {});
    if (keys.length === 0 || keys.length > 128) bad(`question ${id}: bad choice criteria`);
    for (const k of keys) {
      if (k.length === 0 || k.length > 256) bad(`question ${id}: bad option key`);
      const v = q.criteria[k];
      if (v !== null && !isStr(v)) bad(`question ${id}: bad option description`);
    }
  } else if (q.type === "score") {
    if (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.length > 64)
      bad(`question ${id}: score needs >=2 and <=64 levels`);
    for (const c of q.criteria) if (!isStr(c)) bad(`question ${id}: non-string level`);
  } else if (q.type === "noul") {
    if (q.criteria !== undefined && !isObj(q.criteria)) bad(`question ${id}: bad noul criteria`);
  } else bad(`question ${id}: unknown type`);
}

function validateAnswer(id: string, q: Question, a: unknown): Answer {
  if (!isObj(a)) bad(`answer ${id}: not an object`);
  if (a.type !== q.type) bad(`answer ${id}: type mismatch ${JSON.stringify(a.type)} vs ${q.type}`);
  if (q.type === "noul") {
    return { type: "noul", noul: prob01(a.noul, `answer ${id} noul`) };
  }
  if (q.type === "choice") {
    const allowed = Object.keys(q.criteria);
    if (!isStr(a.choice) || !allowed.includes(a.choice)) bad(`answer ${id}: choice not in allowed option set`);
    const probabilities = checkProbabilities(a.probabilities, allowed, `answer ${id}`);
    const confidence = prob01(a.confidence, `answer ${id} confidence`);
    return { type: "choice", choice: a.choice, probabilities, confidence };
  }
  const levels = q.criteria.length;
  if (!finite(a.score) || a.score < 0 || a.score > levels - 1)
    bad(`answer ${id}: score out of [0,${levels - 1}] or non-finite`);
  if (!isObj(a.legend)) bad(`answer ${id}: legend not an object`);
  const idx = Array.from({ length: levels }, (_, i) => String(i));
  exactKeys(a.legend, idx, `answer ${id} legend keys`);
  for (let i = 0; i < levels; i++) {
    if (a.legend[String(i)] !== q.criteria[i]) bad(`answer ${id}: legend[${i}] does not match sent rubric`);
  }
  const probabilities = checkProbabilities(a.probabilities, idx, `answer ${id}`);
  const confidence = prob01(a.confidence, `answer ${id} confidence`);
  return { type: "score", score: a.score, legend: a.legend as Record<string, string>, probabilities, confidence };
}

export function validateSystemOneResponse(raw: unknown, questions: Record<string, Question>): SystemOneResponse {
  if (!isObj(raw)) bad("response not an object");
  if (!isStr(raw.model) || raw.model.length === 0 || raw.model.length > 256) bad("bad response model");
  if (!isObj(raw.answers)) bad("missing answers");
  const qids = Object.keys(questions);
  exactKeys(raw.answers, qids, "answer ids"); // missing AND extra ids rejected
  const answers: Record<string, Answer> = {};
  for (const id of qids) answers[id] = validateAnswer(id, questions[id]!, raw.answers[id]);
  if (!isObj(raw.usage)) bad("missing usage");
  const it = raw.usage.input_tokens;
  const ot = raw.usage.output_tokens;
  if (!Number.isInteger(it) || (it as number) < 0 || !Number.isInteger(ot) || (ot as number) < 0)
    bad("bad usage tokens");
  return { model: raw.model, answers, usage: { input_tokens: it as number, output_tokens: ot as number } };
}

// ---------- low-level client ----------

export interface JevClientOptions {
  /** Constructor-only. Never read from env; never logged/audited. */
  apiKey: string;
  /** Injectable for tests only. The URL is fixed to JEV_ENDPOINT and cannot be rerouted. */
  fetch?: FetchLike;
  /** Max wait for response headers. Default 10_000. */
  callTimeoutMs?: number;
  /** Whole-call deadline including body read. Default 15_000. */
  totalTimeoutMs?: number;
  /** Response byte cap. Default 64 KiB. */
  maxResponseBytes?: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function raceSignal<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof JevError ? signal.reason : new JevError("JEV_TIMEOUT", "aborted"));
      return;
    }
    const onAbort = () =>
      reject(signal.reason instanceof JevError ? signal.reason : new JevError("JEV_TIMEOUT", "aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

export class JevClient {
  readonly model: string = JEV_MODEL_PINNED;
  private readonly key: string;
  private readonly fetchImpl: FetchLike;
  private readonly callTimeoutMs: number;
  private readonly totalTimeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(opts: JevClientOptions) {
    if (!isStr(opts.apiKey) || opts.apiKey.length === 0)
      throw new JevError("JEV_CONFIG", "apiKey required (constructor-only; never env-inherited)");
    this.key = opts.apiKey;
    this.fetchImpl = opts.fetch ?? ((globalThis.fetch as unknown) as FetchLike);
    this.callTimeoutMs = opts.callTimeoutMs ?? 10_000;
    this.totalTimeoutMs = opts.totalTimeoutMs ?? 15_000;
    this.maxResponseBytes = opts.maxResponseBytes ?? 64 * 1024;
    for (const [n, v] of [["callTimeoutMs", this.callTimeoutMs], ["totalTimeoutMs", this.totalTimeoutMs], ["maxResponseBytes", this.maxResponseBytes]] as const)
      if (!Number.isFinite(v) || v <= 0) throw new JevError("JEV_CONFIG", `${n} must be positive finite`);
  }

  timeouts(): { callTimeoutMs: number; totalTimeoutMs: number; maxResponseBytes: number } {
    return { callTimeoutMs: this.callTimeoutMs, totalTimeoutMs: this.totalTimeoutMs, maxResponseBytes: this.maxResponseBytes };
  }

  /** Single attempt. No retries by default. Never surfaces error bodies. */
  async systemOne(req: { state: unknown; questions: Record<string, Question> }): Promise<SystemOneResponse> {
    const questions = req.questions ?? {};
    const qids = Object.keys(questions);
    if (qids.length === 0 || qids.length > 128) throw new JevError("JEV_CONFIG", "questions must be 1..128 entries");
    for (const id of qids) validateQuestion(id, questions[id]!);

    const ctrl = new AbortController();
    let phase: "headers" | "body" = "headers";
    const callTimer = setTimeout(
      () => ctrl.abort(new JevError("JEV_TIMEOUT", `jev per-call timeout waiting for response headers`)),
      this.callTimeoutMs,
    );
    const totalTimer = setTimeout(
      () => ctrl.abort(new JevError("JEV_TIMEOUT", `jev total deadline exceeded during ${phase}`)),
      this.totalTimeoutMs,
    );
    try {
      const res = await raceSignal(
        this.fetchImpl(JEV_ENDPOINT, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.key}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({ state: req.state, model: this.model, questions }),
          signal: ctrl.signal,
        }),
        ctrl.signal,
      );
      clearTimeout(callTimer);
      if (!res.ok) throw new JevError("JEV_HTTP", `jev http status ${res.status}`, { status: res.status });
      phase = "body";
      const bytes = await this.readBounded(res, ctrl.signal);
      let parsed: unknown;
      try {
        parsed = JSON.parse(dec.decode(bytes));
      } catch {
        throw new JevError("JEV_BAD_RESPONSE", "response is not valid JSON");
      }
      return validateSystemOneResponse(parsed, questions);
    } catch (e) {
      if (e instanceof JevError) throw e;
      if (ctrl.signal.aborted) throw new JevError("JEV_TIMEOUT", `jev call aborted during ${phase}`);
      const msg = isStr((e as { message?: unknown })?.message) ? String((e as Error).message).slice(0, 120) : "transport failure";
      throw new JevError("JEV_TRANSPORT", msg, { cause: e });
    } finally {
      clearTimeout(callTimer);
      clearTimeout(totalTimer);
    }
  }

  private async readBounded(res: ResponseLike, signal: AbortSignal): Promise<Uint8Array> {
    const stream = res.body;
    if (stream && typeof stream.getReader === "function") {
      const reader = stream.getReader();
      const onAbort = () => void reader.cancel().catch(() => undefined);
      signal.addEventListener("abort", onAbort, { once: true });
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        for (;;) {
          const { done, value } = await raceSignal(reader.read(), signal);
          if (done) break;
          if (value) {
            total += value.byteLength;
            if (total > this.maxResponseBytes) {
              await reader.cancel().catch(() => undefined);
              throw new JevError("JEV_OVERSIZE", `jev response exceeded ${this.maxResponseBytes} bytes`);
            }
            chunks.push(value);
          }
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.byteLength;
      }
      return out;
    }
    const buf = await raceSignal(res.arrayBuffer(), signal);
    if (buf.byteLength > this.maxResponseBytes)
      throw new JevError("JEV_OVERSIZE", `jev response exceeded ${this.maxResponseBytes} bytes`);
    return new Uint8Array(buf);
  }
}

// ---------- bounded/redacted input helpers ----------

const REDACT_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /Bearer\s+\S+/gi,
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]+\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b[0-9a-f]{48,}\b/gi,
];

/** Redact common secret shapes. Best-effort; not a DLP guarantee. */
export function redactText(s: string): string {
  let out = s;
  for (const re of REDACT_PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
}

export function boundText(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + "…[truncated]";
}

export function redactAndBound(s: string, max = 512): string {
  return boundText(redactText(s), max);
}

const bstr = (v: unknown, max = 256): string | undefined =>
  isStr(v) ? boundText(redactText(v), max) : undefined;

// ---------- decision-facing types ----------

/** Minimal structured task features. NEVER the full task text/repo/code. */
export interface TaskFeatures {
  task_type_hint?: "coding" | "review" | "research" | "planning" | "other";
  role?: string;
  declared_scope?: "file" | "module" | "repo" | "unknown";
  touches_secrets?: boolean;
  has_tests?: boolean;
  tools_required?: string[]; // bounded capability labels
  /** Optional operator-approved short summary. Bounded + redacted before sending. */
  summary?: string;
}

export interface TaskJudgment {
  task_type: "coding" | "review" | "research" | "planning" | "other";
  complexity: number; // 0..1 normalized
  risk: number; // 0..1
  uncertainty: number; // 0..1
  needs_review: number; // noul probability — review likelihood, NOT success probability
  /** Per-question distribution confidence. NEVER a task-success probability. */
  confidence: Record<string, number>;
  model: string; // actual model that answered
}

export interface ModelEvidence {
  model_id: string;
  catalog_fingerprint: string;
  /** Sourced catalog claims: doc/help/catalog lines with provenance. */
  sourced_evidence: { claim: string; source: string; observed_at?: string }[];
  /** Local eval/benchmark evidence, provenance-labelled. Never invented. */
  eval_evidence?: { name: string; kind: "fixture" | "synthetic" | "local_benchmark" | "measured"; score?: number; note?: string }[];
}

export interface ModelEvaluation {
  eval_id: string; // deterministic from fingerprint+rubric version — persistable
  model_id: string;
  catalog_fingerprint: string;
  rubric: string[];
  rubric_version: string;
  scores: Record<string, number>; // 0..1 per rubric dimension
  insufficient_evidence: boolean;
  provenance: "jev-model-judge"; // Jev estimate — NOT a measured benchmark
  model: string; // actual jev model
  evaluated_at: string;
}

/**
 * Evidence-only candidate for judgement. Deliberately a small PLAIN object:
 * the native Candidate class (plugin manifest, env, workspace handles) must
 * never be serialized to Jev. Build via toEvidenceCandidate().
 */
export interface EvidenceCandidate {
  id: string;
  model_id: string;
  roles: string[];
  billing_model: string;
  incremental_cost: number | null;
  execution_mode: "agent" | "text";
  effort?: string;
  quota_status: "known" | "unknown" | "exhausted";
  quota_fresh: boolean;
  latency_ms_p50: number | null;
  eval_fit: Record<string, number>; // role -> 0..1 from ModelEvaluation
  capability_flags: string[]; // supported capability labels only
  observations_fresh: boolean;
  unknowns: string[]; // explicit unknown fields
}

/** Structural shape of the main project's Candidate (whitelist fields only). */
export interface CandidateLike {
  candidate_id: string;
  model_id: string;
  roles: string[];
  billing_model: string;
  incremental_cost: number | null;
  execution_mode: "agent" | "text";
  effort?: string;
}

export interface CandidateObservation {
  quota_status?: "known" | "unknown" | "exhausted";
  quota_fresh?: boolean;
  latency_ms_p50?: number | null;
  eval_fit?: Record<string, number>;
  capability_flags?: string[];
  observations_fresh?: boolean;
  unknowns?: string[];
}

/**
 * Maps a native Candidate to an evidence-only plain object. Reads ONLY
 * whitelisted fields — plugin manifest, env, argv, paths are never touched.
 */
export function toEvidenceCandidate(c: CandidateLike, obs: CandidateObservation = {}): EvidenceCandidate {
  const unknowns = [...(obs.unknowns ?? [])].map((u) => boundText(String(u), 64));
  const quota = obs.quota_status ?? "unknown";
  if (quota === "unknown") unknowns.push("quota");
  const lat = finite(obs.latency_ms_p50) ? (obs.latency_ms_p50 as number) : null;
  if (lat === null) unknowns.push("latency");
  if (c.incremental_cost === null) unknowns.push("cost");
  const evalFit: Record<string, number> = {};
  for (const [k, v] of Object.entries(obs.eval_fit ?? {}).slice(0, 8))
    if (finite(v)) evalFit[boundText(k, 64)] = Math.min(1, Math.max(0, v));
  return {
    id: boundText(c.candidate_id, 256),
    model_id: boundText(c.model_id, 128),
    roles: c.roles.slice(0, 8).map((r) => boundText(r, 64)),
    billing_model: boundText(c.billing_model, 64),
    incremental_cost: c.incremental_cost === null ? null : Math.max(0, c.incremental_cost),
    execution_mode: c.execution_mode,
    effort: c.effort === undefined ? undefined : boundText(c.effort, 32),
    quota_status: quota,
    quota_fresh: obs.quota_fresh === true,
    latency_ms_p50: lat,
    eval_fit: evalFit,
    capability_flags: (obs.capability_flags ?? []).slice(0, 16).map((f) => boundText(f, 64)),
    observations_fresh: obs.observations_fresh === true,
    unknowns: [...new Set(unknowns)],
  };
}

// ---------- rubrics ----------

const TASK_TYPES = ["coding", "review", "research", "planning", "other"] as const;
const COMPLEXITY_LEVELS = ["trivial", "small", "moderate", "large", "extreme"];
const RISK_LEVELS = ["low", "medium", "high", "critical"];
const UNCERTAINTY_LEVELS = ["clear", "some_uncertainty", "high_uncertainty"];
const FIT_LEVELS = ["unfit", "poor", "adequate", "good", "excellent"];
export const DEFAULT_MODEL_RUBRIC = ["coding", "review", "research", "planning"] as const;
export const DEFAULT_RUBRIC_VERSION = "rubric-v1";

const norm = (score: number, levels: number): number => score / (levels - 1);

function minimizeTask(t: TaskFeatures): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (t.task_type_hint) out.task_type_hint = t.task_type_hint;
  if (t.role) out.role = boundText(t.role, 64);
  if (t.declared_scope) out.declared_scope = t.declared_scope;
  if (t.touches_secrets !== undefined) out.touches_secrets = t.touches_secrets === true;
  if (t.has_tests !== undefined) out.has_tests = t.has_tests === true;
  if (t.tools_required) out.tools_required = t.tools_required.slice(0, 8).map((x) => boundText(x, 64));
  if (t.summary) out.summary = redactAndBound(t.summary, 512);
  return out;
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// ---------- decision service: the three logically distinct judges ----------

export interface JevDecisionServiceOptions {
  modelRubric?: string[];
  rubricVersion?: string;
  evalCacheSize?: number; // bounded; default 128
}

export class JevDecisionService {
  private readonly client: JevClient;
  private readonly modelRubric: string[];
  private readonly rubricVersion: string;
  private readonly evalCacheSize: number;
  private readonly evalCache = new Map<string, ModelEvaluation>();

  constructor(client: JevClient, opts: JevDecisionServiceOptions = {}) {
    this.client = client;
    this.modelRubric = (opts.modelRubric ?? [...DEFAULT_MODEL_RUBRIC]).slice(0, 8);
    this.rubricVersion = opts.rubricVersion ?? DEFAULT_RUBRIC_VERSION;
    this.evalCacheSize = opts.evalCacheSize ?? 128;
  }

  /** Task Judge: minimal structured features only; bounded redacted summary. */
  async judgeTask(task: TaskFeatures): Promise<TaskJudgment> {
    const questions: Record<string, Question> = {
      task_type: {
        type: "choice",
        instructions: "Which category best describes this software task?",
        criteria: {
          coding: "Write or modify code",
          review: "Review/audit existing changes",
          research: "Investigate, read, summarize",
          planning: "Design/plan without editing",
          other: "None of the above",
        },
      },
      complexity: { type: "score", instructions: "Implementation complexity of the task", criteria: COMPLEXITY_LEVELS },
      risk: { type: "score", instructions: "Blast radius / risk if done badly", criteria: RISK_LEVELS },
      uncertainty: { type: "score", instructions: "How underspecified is the task", criteria: UNCERTAINTY_LEVELS },
      needs_review: { type: "noul", instructions: "Does this task need human review before/after execution?" },
    };
    const res = await this.client.systemOne({ state: { task: minimizeTask(task) }, questions });
    const a = res.answers;
    const tt = a.task_type as ChoiceAnswer;
    return {
      task_type: (TASK_TYPES as readonly string[]).includes(tt.choice) ? (tt.choice as TaskJudgment["task_type"]) : "other",
      complexity: norm((a.complexity as ScoreAnswer).score, COMPLEXITY_LEVELS.length),
      risk: norm((a.risk as ScoreAnswer).score, RISK_LEVELS.length),
      uncertainty: norm((a.uncertainty as ScoreAnswer).score, UNCERTAINTY_LEVELS.length),
      needs_review: (a.needs_review as NoulAnswer).noul,
      confidence: {
        task_type: tt.confidence,
        complexity: (a.complexity as ScoreAnswer).confidence,
        risk: (a.risk as ScoreAnswer).confidence,
        uncertainty: (a.uncertainty as ScoreAnswer).confidence,
      },
      model: res.model,
    };
  }

  /**
   * Model Judge: evaluates one model from sourced evidence. Cached per
   * (catalog_fingerprint, rubric_version) in a bounded LRU — catalog changes
   * trigger re-evaluation, never a whole-catalog pass per job. The returned
   * evaluation is persistable and provenance-tagged as a Jev estimate.
   */
  async judgeModel(ev: ModelEvidence): Promise<ModelEvaluation> {
    // keyed by model identity + fingerprint + rubric: different models sharing
    // a catalog fingerprint must never collide
    const cacheKey = `${boundText(ev.model_id, 128)}|${ev.catalog_fingerprint}|${this.rubricVersion}|${this.modelRubric.join(",")}`;
    const hit = this.evalCache.get(cacheKey);
    if (hit) {
      this.evalCache.delete(cacheKey);
      this.evalCache.set(cacheKey, hit); // LRU touch
      return hit;
    }

    const state = {
      model_id: boundText(ev.model_id, 128),
      sourced_evidence: ev.sourced_evidence.slice(0, 16).map((e) => ({
        claim: boundText(redactText(e.claim), 256),
        source: boundText(e.source, 256),
        observed_at: bstr(e.observed_at, 64),
      })),
      eval_evidence: (ev.eval_evidence ?? []).slice(0, 16).map((e) => ({
        name: boundText(e.name, 128),
        kind: e.kind,
        score: finite(e.score) ? Math.min(1, Math.max(0, e.score as number)) : undefined,
        note: bstr(e.note, 256),
      })),
    };
    const questions: Record<string, Question> = {
      sufficient: {
        type: "noul",
        instructions: "Is the supplied evidence sufficient to rate this model's fitness?",
      },
    };
    this.modelRubric.forEach((dim, i) => {
      questions[`dim_${i}`] = {
        type: "score",
        instructions: `Rate the model's fitness for the "${dim}" role from the evidence`,
        criteria: FIT_LEVELS,
      };
    });
    const res = await this.client.systemOne({ state, questions });
    const scores: Record<string, number> = {};
    this.modelRubric.forEach((dim, i) => {
      scores[dim] = norm((res.answers[`dim_${i}`] as ScoreAnswer).score, FIT_LEVELS.length);
    });
    const evaluation: ModelEvaluation = {
      eval_id: `jev-model-${fnv1a(cacheKey)}`,
      model_id: ev.model_id,
      catalog_fingerprint: ev.catalog_fingerprint,
      rubric: [...this.modelRubric],
      rubric_version: this.rubricVersion,
      scores,
      insufficient_evidence: (res.answers.sufficient as NoulAnswer).noul < 0.5,
      provenance: "jev-model-judge",
      model: res.model,
      evaluated_at: new Date().toISOString(),
    };
    if (this.evalCache.size >= this.evalCacheSize) {
      const oldest = this.evalCache.keys().next();
      if (!oldest.done) this.evalCache.delete(oldest.value);
    }
    this.evalCache.set(cacheKey, evaluation);
    return evaluation;
  }

  evalCacheLength(): number {
    return this.evalCache.size;
  }

  clientTimeouts(): { callTimeoutMs: number; totalTimeoutMs: number } {
    const t = this.client.timeouts();
    return { callTimeoutMs: t.callTimeoutMs, totalTimeoutMs: t.totalTimeoutMs };
  }

  /**
   * Candidate Judge: scores ONLY the supplied hard-filtered evidence-only
   * candidates on a fixed fit rubric. Returns candidate-id -> rubric score;
   * never commands, providers, paths, or fabricated ids (answer-id exactness
   * is enforced by wire validation).
   */
  async judgeCandidates(input: {
    task: TaskFeatures;
    candidates: EvidenceCandidate[];
  }): Promise<{ scores: Record<string, { fit: number; confidence: number }>; model: string }> {
    const cands = input.candidates.slice(0, 64);
    const ids = new Set<string>();
    for (const c of cands) {
      if (ids.has(c.id)) throw new JevError("JEV_CONFIG", `duplicate candidate id ${JSON.stringify(c.id)}`);
      ids.add(c.id);
    }
    const questions: Record<string, Question> = {};
    cands.forEach((c, i) => {
      questions[`cand_${i}`] = {
        type: "score",
        instructions: `Rate fitness of candidates[${i}] for the described task`,
        criteria: FIT_LEVELS,
      };
    });
    // Whitelist-project each candidate: only evidence fields go on the wire.
    // Even if a caller attached extra JS properties, they cannot leak into
    // the request body.
    const wireCands = cands.map((c) => ({
      id: boundText(c.id, 256),
      model_id: boundText(c.model_id, 128),
      roles: c.roles.slice(0, 8).map((r) => boundText(r, 64)),
      billing_model: boundText(c.billing_model, 64),
      incremental_cost: finite(c.incremental_cost) ? c.incremental_cost : null,
      execution_mode: c.execution_mode,
      effort: c.effort === undefined ? undefined : boundText(c.effort, 64),
      quota_status: c.quota_status,
      quota_fresh: c.quota_fresh === true,
      latency_ms_p50: finite(c.latency_ms_p50) ? c.latency_ms_p50 : null,
      eval_fit: Object.fromEntries(
        Object.entries(c.eval_fit).slice(0, 8).map(([k, v]) => [boundText(k, 64), finite(v) ? Math.min(1, Math.max(0, v)) : 0]),
      ),
      capability_flags: c.capability_flags.slice(0, 16).map((f) => boundText(f, 64)),
      observations_fresh: c.observations_fresh === true,
      unknowns: c.unknowns.slice(0, 16).map((u) => boundText(u, 64)),
    }));
    const res = await this.client.systemOne({
      state: { task: minimizeTask(input.task), candidates: wireCands },
      questions,
    });
    const scores: Record<string, { fit: number; confidence: number }> = {};
    cands.forEach((c, i) => {
      const a = res.answers[`cand_${i}`] as ScoreAnswer;
      scores[c.id] = { fit: norm(a.score, FIT_LEVELS.length), confidence: a.confidence };
    });
    return { scores, model: res.model };
  }
}

// ---------- deterministic ranking ----------

export interface RankWeights {
  fit: number;
  cost: number;
  quota: number;
  latency: number;
  stale_penalty: number;
  unknown_penalty: number;
}
export const DEFAULT_RANK_WEIGHTS: RankWeights = {
  fit: 1.0,
  cost: 0.3,
  quota: 0.4,
  latency: 0.2,
  stale_penalty: 0.3,
  unknown_penalty: 0.15,
};

export interface RankedCandidate {
  candidate_id: string;
  rank_score: number;
  fit: number | null; // Jev fit, or eval_fit/0.5 fallback — never a "performance" claim
  flags: string[]; // fresh-info/unknown flags, e.g. "quota-unknown", "observations-stale"
}

/**
 * Deterministic rank: combines fit with explicit operator cost/quota/latency
 * weights, plus stale/unknown penalties. IDs only — callers must map back to
 * their own Candidate objects and re-run final validation.
 */
export function rankCandidates(
  candidates: EvidenceCandidate[],
  fitScores: Record<string, { fit: number }> | null,
  opts: { role?: string; weights?: RankWeights } = {},
): RankedCandidate[] {
  const w = opts.weights ?? DEFAULT_RANK_WEIGHTS;
  const out: RankedCandidate[] = candidates.map((c) => {
    const flags: string[] = [];
    let fit: number;
    const jev = fitScores?.[c.id]?.fit;
    if (jev !== undefined) fit = jev;
    else if (opts.role && finite(c.eval_fit[opts.role])) fit = c.eval_fit[opts.role]!;
    else {
      fit = 0.5;
      flags.push("fit-unknown");
    }
    let costScore = 0.5;
    if (c.incremental_cost === null) flags.push("cost-unknown");
    else costScore = 1 / (1 + Math.max(0, c.incremental_cost));
    let quotaScore: number;
    if (c.quota_status === "exhausted") {
      quotaScore = 0;
      flags.push("quota-exhausted");
    } else if (c.quota_status === "unknown") {
      quotaScore = 0.25;
      flags.push("quota-unknown");
    } else {
      quotaScore = c.quota_fresh ? 1 : 0.5;
      if (!c.quota_fresh) flags.push("quota-stale");
    }
    let latScore = 0.5;
    if (c.latency_ms_p50 === null) flags.push("latency-unknown");
    else latScore = 1 / (1 + c.latency_ms_p50 / 5000);
    let score = w.fit * fit + w.cost * costScore + w.quota * quotaScore + w.latency * latScore;
    if (!c.observations_fresh) {
      score -= w.stale_penalty;
      flags.push("observations-stale");
    }
    const extraUnknowns = c.unknowns.filter((u) => !flags.includes(`${u}-unknown`)).length;
    if (extraUnknowns > 0) score -= w.unknown_penalty * Math.min(extraUnknowns, 3);
    return { candidate_id: c.id, rank_score: score, fit, flags };
  });
  out.sort((a, b) => b.rank_score - a.rank_score || a.candidate_id.localeCompare(b.candidate_id));
  return out;
}

// ---------- rule-based adapter (mandatory; same constraints on fallback) ----------

export interface RuleInput {
  role?: string;
  effortAliasOrder?: string[]; // policy alias model order (preference, not intelligence rank)
}

/** Deterministic rule adapter — mirrors main-project RuleBasedAdapter scoring. */
export class RuleAdapter {
  readonly name = "rule-based";
  rank(input: RuleInput, candidates: EvidenceCandidate[]): string[] {
    const aliasOrder = input.effortAliasOrder ?? [];
    const score = (c: EvidenceCandidate): number => {
      let s = 0;
      if (input.role && c.roles.includes(input.role)) s += 100;
      const ai = aliasOrder.indexOf(c.model_id);
      if (ai >= 0) s += 50 - ai;
      if (c.billing_model === "free") s += 10;
      else if (c.billing_model === "subscription_included") s += 5;
      if (c.incremental_cost !== null) s += Math.max(0, 5 - c.incremental_cost);
      return s;
    };
    return [...candidates]
      .sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id))
      .map((c) => c.id);
  }
}

// ---------- decision coordinator: off / active / shadow ----------

export type DecisionMode = "off" | "active" | "shadow";

/** Safe audit record: ids, versions, codes — never key, prompt/state, or error bodies. */
export interface DecisionAuditRecord {
  schema_version: typeof JEV_SCHEMA_VERSION;
  mode: DecisionMode;
  adapter_used: "rule-based" | "jev" | "jev-fallback-rules";
  jev_model_requested: string | null;
  jev_model_actual: string | null;
  candidate_ids: string[]; // sorted, bounded
  chosen: string | null;
  timeout_ms: number;
  duration_ms: number;
  error_code: JevErrorCode | "JEV_UNKNOWN" | null;
  shadow_disagreement: boolean | null; // shadow only: jev top != rule top
  fit_source: "jev" | "rules" | "none";
  reason: string;
}

export interface DecideInput extends RuleInput {
  task?: TaskFeatures;
}

export interface DecideResult {
  ordered_ids: string[]; // subset-ordering of input candidate ids ONLY
  adapter_used: DecisionAuditRecord["adapter_used"];
  audit: DecisionAuditRecord;
}

export class DecisionCoordinator {
  private readonly mode: DecisionMode;
  private readonly jev: JevDecisionService | null;
  private readonly rules: RuleAdapter;
  private readonly weights: RankWeights;
  private readonly auditSink?: (r: DecisionAuditRecord) => void;
  private readonly records: DecisionAuditRecord[] = [];
  private readonly recordCap = 256;

  constructor(opts: {
    mode: DecisionMode;
    jev?: JevDecisionService | null;
    rules?: RuleAdapter;
    weights?: RankWeights;
    audit?: (r: DecisionAuditRecord) => void;
  }) {
    this.mode = opts.mode;
    this.jev = opts.jev ?? null;
    this.rules = opts.rules ?? new RuleAdapter();
    this.weights = opts.weights ?? DEFAULT_RANK_WEIGHTS;
    this.auditSink = opts.audit;
  }

  /**
   * Ranks hard-filtered candidates. Returns IDs ONLY — the caller must map ids
   * back to its own candidates and re-run final validation. Never executes
   * workers, never changes the candidate set, permissions, or budget. On any
   * Jev timeout/error/bad output: same hard-filtered rule-based ordering.
   */
  async decide(input: DecideInput, candidates: EvidenceCandidate[]): Promise<DecideResult> {
    const t0 = Date.now();
    const idSet = candidates.map((c) => c.id);
    const ruleInput: RuleInput = { role: input.role, effortAliasOrder: input.effortAliasOrder };
    let ordered: string[];
    let adapterUsed: DecisionAuditRecord["adapter_used"] = "rule-based";
    let jevActual: string | null = null;
    let errorCode: DecisionAuditRecord["error_code"] = null;
    let disagreement: boolean | null = null;
    let reason = "rule-based ranking";

    const tryJev = async (): Promise<string[] | null> => {
      if (!this.jev) return null;
      const fit = await this.jev.judgeCandidates({ task: input.task ?? {}, candidates });
      jevActual = fit.model;
      return rankCandidates(candidates, fit.scores, { role: input.role, weights: this.weights }).map(
        (r) => r.candidate_id,
      );
    };

    if (this.mode === "off") {
      ordered = this.rules.rank(ruleInput, candidates);
    } else if (this.mode === "shadow") {
      ordered = this.rules.rank(ruleInput, candidates);
      try {
        const jevOrder = await tryJev();
        if (jevOrder === null) {
          reason = "shadow: jev not configured — rule ranking returned";
        } else {
          disagreement = jevOrder[0] !== ordered[0];
          reason = disagreement ? "shadow: jev top differs from rules (rules kept)" : "shadow: jev agrees";
          // adapter_used stays "rule-based": the returned order is always the
          // rule ranking in shadow mode. jev_model_actual records that jev ran.
        }
      } catch (e) {
        errorCode = e instanceof JevError ? e.code : "JEV_UNKNOWN";
        reason = `shadow: jev failed (${errorCode}) — rule ranking returned`;
      }
    } else {
      // active
      try {
        const jevOrder = await tryJev();
        if (jevOrder === null) {
          ordered = this.rules.rank(ruleInput, candidates);
          reason = "active: jev not configured — rule fallback";
          adapterUsed = "jev-fallback-rules";
        } else {
          ordered = jevOrder;
          adapterUsed = "jev";
          reason = "active: jev fit ranking";
        }
      } catch (e) {
        errorCode = e instanceof JevError ? e.code : "JEV_UNKNOWN";
        ordered = this.rules.rank(ruleInput, candidates);
        adapterUsed = "jev-fallback-rules";
        reason = `active: jev failed (${errorCode}) — rule fallback, same hard-filtered set`;
      }
    }

    // Defensive invariant: output ids must be exactly the input set reordered.
    const inSet = new Set(idSet);
    ordered = ordered.filter((id) => inSet.has(id));
    for (const id of idSet) if (!ordered.includes(id)) ordered.push(id);

    const audit: DecisionAuditRecord = {
      schema_version: JEV_SCHEMA_VERSION,
      mode: this.mode,
      adapter_used: adapterUsed,
      jev_model_requested: this.jev ? JEV_MODEL_PINNED : null,
      jev_model_actual: jevActual,
      candidate_ids: [...idSet].sort(),
      chosen: ordered[0] ?? null,
      timeout_ms: this.jev ? this.jev.clientTimeouts().totalTimeoutMs : 0,
      duration_ms: Date.now() - t0,
      error_code: errorCode,
      shadow_disagreement: disagreement,
      fit_source: adapterUsed === "jev" ? "jev" : "rules",
      reason,
    };
    this.records.push(audit);
    if (this.records.length > this.recordCap) this.records.shift();
    try {
      this.auditSink?.(audit);
    } catch {
      // audit sink must never break decisions
    }
    return { ordered_ids: ordered, adapter_used: adapterUsed, audit };
  }

  auditRecords(): readonly DecisionAuditRecord[] {
    return this.records;
  }
}
