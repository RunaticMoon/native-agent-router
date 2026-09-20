// Authenticated HTTP Job API + SSE. All routes bearer-protected; principal
// scopes jobs/workspaces/policies/approver authority. Loopback by default.
import * as http from "node:http";
import { createHash } from "node:crypto";
import { Store, isTerminal } from "../storage/store.js";
import { Runtime } from "../runtime/runtime.js";
import { ApprovalBroker } from "../approval/broker.js";
import { RouterConfig, Principal } from "../config.js";
import { CreateJobRequest, check, CanonicalEvent } from "../contracts/index.js";

const MAX_BODY = 64 * 1024;
const SSE_PAGE = 500;

// Canonical JSON (sorted keys, no whitespace) so idempotency hashing does not
// depend on client key order or formatting.
function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

export class Api {
  private server: http.Server;
  private executing = new Set<string>();
  // every open SSE response — shutdown ends them explicitly instead of
  // waiting on job deadlines or client disconnects
  private sseConns = new Set<http.ServerResponse>();

  constructor(
    private store: Store,
    private runtime: Runtime,
    private approvals: ApprovalBroker,
    private config: RouterConfig,
  ) {
    this.server = http.createServer((req, res) => void this.handle(req, res));
  }

  listen(): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(this.config.http.port, this.config.http.host, () => {
        resolve((this.server.address() as { port: number }).port);
      });
    });
  }
  // Bounded close: stop accepting connections, end tracked SSE responses
  // immediately, and force-destroy any that linger past `graceMs` — an SSE
  // held open by a hanging job must not block shutdown past the deadline.
  close(graceMs = 2000): Promise<void> {
    for (const res of [...this.sseConns]) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    const deadline = setTimeout(() => {
      for (const res of [...this.sseConns]) {
        try {
          res.destroy();
        } catch {
          /* ignore */
        }
      }
      this.server.closeAllConnections?.();
    }, graceMs);
    deadline.unref();
    return new Promise((r) =>
      this.server.close(() => {
        clearTimeout(deadline);
        r();
      }),
    );
  }

  private auth(req: http.IncomingMessage): Principal | null {
    const h = req.headers.authorization;
    if (!h?.startsWith("Bearer ")) return null;
    const tok = h.slice(7);
    const hash = createHash("sha256").update(tok).digest("hex");
    return this.config.principals.find((p) => createHash("sha256").update(p.token).digest("hex") === hash) ?? null;
  }

  private async body(req: http.IncomingMessage): Promise<unknown> {
    const deadlineMs = this.config.http.request_deadline_ms ?? 10_000;
    return new Promise((resolve, reject) => {
      let data = "";
      let over = false;
      const timer = setTimeout(() => {
        reject(new Error("request deadline"));
        req.destroy();
      }, deadlineMs);
      req.setEncoding("utf8");
      req.on("data", (c) => {
        data += c;
        if (data.length > MAX_BODY && !over) {
          over = true;
          clearTimeout(timer);
          reject(new Error("body too large"));
          req.destroy();
        }
      });
      req.on("end", () => {
        clearTimeout(timer);
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch {
          reject(new Error("invalid JSON"));
        }
      });
      req.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  private json(res: http.ServerResponse, code: number, obj: unknown) {
    const s = JSON.stringify(obj);
    res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
    res.end(s);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? "/", "http://x");
    const p = this.auth(req);
    if (!p) return this.json(res, 401, { error: "unauthorized" });
    try {
      // POST /v1/jobs
      if (req.method === "POST" && url.pathname === "/v1/jobs") {
        if (!p.scopes.includes("jobs:write")) return this.json(res, 403, { error: "forbidden" });
        const raw = await this.body(req);
        const jobReq = check(CreateJobRequest, raw, "job request");
        const idemKey = req.headers["idempotency-key"] as string | undefined;
        const bodySha = createHash("sha256").update(canonicalJson(raw)).digest("hex");
        // fixed admission caps: per-principal and global non-terminal jobs.
        // The guard runs INSIDE the new-job transaction — after idempotency
        // replay resolution — so a replayed key still returns the original
        // job at a full cap, and concurrent new submissions cannot both pass.
        const maxP = this.config.http.max_active_jobs_per_principal ?? 16;
        const maxG = this.config.http.max_active_jobs_global ?? 64;
        const admitNew = () => {
          if (this.store.countActiveJobs(p.id) >= maxP) throw new Error("CAP_PRINCIPAL");
          if (this.store.countActiveJobs() >= maxG) throw new Error("CAP_GLOBAL");
        };
        let jobId: string;
        let replayed = false;
        if (idemKey) {
          const r = this.store.idempotentJob(p.id, idemKey, bodySha, () => {
            const sub = this.runtime.submit(p.id, jobReq);
            return sub.job_id;
          }, admitNew);
          jobId = r.job_id;
          replayed = r.replayed;
        } else {
          jobId = this.store.tx(() => {
            admitNew();
            return this.runtime.submit(p.id, jobReq).job_id;
          });
        }
        if (!replayed) this.kick(jobId);
        return this.json(res, replayed ? 200 : 201, { job_id: jobId, replayed });
      }

      const m = url.pathname.match(/^\/v1\/jobs\/([^/]+)(\/events|\/cancel|\/permissions\/([^/]+))?$/);
      if (m) {
        const jobId = m[1]!;
        const job = this.store.getJob(jobId);
        if (!job || job.principal !== p.id) return this.json(res, 404, { error: "not found" });

        if (req.method === "GET" && !m[2]) {
          if (!p.scopes.includes("jobs:read")) return this.json(res, 403, { error: "forbidden" });
          return this.json(res, 200, {
            job_id: job.job_id, status: job.status, role: job.role, policy: job.policy,
            workspace_mode: job.workspace_mode, cancel_requested: job.cancel_requested === 1, created_at: job.created_at,
            result: job.result_json ? JSON.parse(job.result_json) : null,
            attempts: this.store.attemptsForJob(jobId).map((a) => ({
              attempt_id: a.attempt_id, candidate_id: a.candidate_id, status: a.status,
              side_effects: a.side_effects, retry_safety: a.retry_safety,
              native_session_id: a.native_session_id,
              error: a.error_json ? JSON.parse(a.error_json) : null,
            })),
            approvals: this.store.approvalsForJob(jobId).map((a) => ({
              approval_id: a.approval_id, action: a.action, target: a.target,
              status: a.status, chosen_option: a.chosen_option, delivery_state: a.delivery_state,
              options: JSON.parse(a.options_json), expires_at: a.expires_at,
            })),
          });
        }
        if (req.method === "GET" && m[2] === "/events") return this.sse(req, res, jobId, p);
        if (req.method === "POST" && m[2] === "/cancel") {
          if (!p.scopes.includes("jobs:write")) return this.json(res, 403, { error: "forbidden" });
          return this.json(res, 200, await this.runtime.cancel(jobId));
        }
        if (req.method === "POST" && m[2]?.startsWith("/permissions/")) {
          if (!p.scopes.includes("approve")) return this.json(res, 403, { error: "approver authority required" });
          const body = (await this.body(req)) as { option?: string };
          if (typeof body.option !== "string") return this.json(res, 400, { error: "option required" });
          // actor derives from authenticated principal, not the body
          return this.json(res, 200, this.approvals.decide(m[3]!, p.id, body.option, jobId));
        }
      }
      return this.json(res, 404, { error: "not found" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("IDEMPOTENCY_CONFLICT")) {
        return this.json(res, 409, { error: "idempotency key conflict" });
      }
      if (msg.includes("CAP_PRINCIPAL")) return this.json(res, 429, { error: "principal active job cap" });
      if (msg.includes("CAP_GLOBAL")) return this.json(res, 429, { error: "global active job cap" });
      if (msg.includes("schema validation failed")) return this.json(res, 400, { error: msg.slice(0, 300) });
      if (msg.includes("body too large")) return this.json(res, 413, { error: "body too large" });
      if (msg.includes("request deadline")) return this.json(res, 408, { error: "request deadline" });
      if (
        msg.includes("not approved") || msg.includes("not owned") || msg.includes("may not use") ||
        msg.includes("already locked") || msg.includes("escapes") || msg.includes("not admitted") ||
        msg.includes("unknown policy") || msg.includes("not admitted by policy") ||
        msg.includes("operating-disabled") || msg.includes("not in admitted") ||
        msg.includes("not offered") || msg.includes("not an admitted")
      ) {
        return this.json(res, 403, { error: msg.slice(0, 300) });
      }
      // never return raw exception text to clients — opaque internal error
      return this.json(res, 500, { error: "internal error" });
    }
  }

  private kick(jobId: string) {
    if (this.executing.has(jobId)) return;
    this.executing.add(jobId);
    // Async kick failures land in durable recovery — never an unhandled
    // rejection or silent no-op.
    this.runtime
      .execute(jobId)
      .catch((e) => {
        try {
          const j = this.store.getJob(jobId);
          if (j && !isTerminal(j.status) && j.status !== "needs_recovery") {
            this.store.transitionJob(jobId, "needs_recovery");
            this.store.setJobResult(jobId, { recovery_required: true, reason: "execution error" });
          }
        } catch {
          /* store closed */
        }
        void e;
      })
      .finally(() => this.executing.delete(jobId));
  }

  private sse(req: http.IncomingMessage, res: http.ServerResponse, jobId: string, p: Principal) {
    if (!p.scopes.includes("jobs:read")) return this.json(res, 403, { error: "forbidden" });
    // Job-scoped Last-Event-ID: numeric = sequence; ev_* = strict event_id
    // lookup — an unknown id is a hard 400, never a silent full replay.
    const lastId = req.headers["last-event-id"];
    let afterSeq = -1;
    if (typeof lastId === "string" && lastId.length) {
      if (/^\d+$/.test(lastId)) {
        afterSeq = Number(lastId);
      } else if (lastId.startsWith("ev_")) {
        const ev = this.store.eventById(jobId, lastId);
        if (!ev) return this.json(res, 400, { error: "unknown Last-Event-ID for this job" });
        afterSeq = ev.sequence;
      } else {
        return this.json(res, 400, { error: "malformed Last-Event-ID" });
      }
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    this.sseConns.add(res);
    let closed = false;
    const done = () => {
      closed = true;
      this.sseConns.delete(res);
    };
    req.on("close", done);
    res.on("close", done);
    // Bounded in-memory buffering: one page at a time, socket backpressure
    // honored via 'drain' before the next write burst.
    const writeEv = async (ev: CanonicalEvent) => {
      const ok = res.write(`id: ${ev.sequence}\nevent: ${ev.kind}\ndata: ${JSON.stringify(ev)}\n\n`);
      if (!ok) await new Promise((r) => res.once("drain", r));
    };
    const pump = async () => {
      while (!closed) {
        // drain every available page before deciding anything
        for (;;) {
          const evs = this.store.eventsForJob(jobId, afterSeq, SSE_PAGE);
          if (!evs.length) break;
          for (const ev of evs) {
            if (closed) return;
            await writeEv(ev);
            afterSeq = ev.sequence;
          }
        }
        const job = this.store.getJob(jobId);
        if (!job || isTerminal(job.status) || job.status === "needs_recovery") {
          // terminal (incl. needs_recovery): final drain then close — never
          // triggers execution or replay loops
          for (;;) {
            const rest = this.store.eventsForJob(jobId, afterSeq, SSE_PAGE);
            if (!rest.length) break;
            for (const ev of rest) {
              if (closed) return;
              await writeEv(ev);
              afterSeq = ev.sequence;
            }
          }
          res.end();
          return;
        }
        if (closed) {
          this.sseConns.delete(res);
          res.end();
          return;
        }
        res.write(`: heartbeat\n\n`);
        await new Promise((r) => setTimeout(r, 120));
      }
    };
    void pump();
  }
}
