// Generic worker client: Job API only — no model/provider/CLI names anywhere.
// worker({url,token}, {task,role,policy,workspace}) -> handle with
// events/cancel/result; every call bounded by a finite client timeout.
// A client-generated Idempotency-Key makes submit retry-safe.
import { randomUUID } from "node:crypto";

export class WorkerError extends Error {
  constructor(
    message: string,
    readonly status: number, // 0 = client-side timeout/network, else HTTP status
  ) {
    super(message);
    this.name = "WorkerError";
  }
}

export interface WorkerRequest {
  task: string;
  role: string;
  policy: string;
  workspace: { mode: "fresh" } | { mode: "locked"; handle: string };
  preferred?: Record<string, string>;
  deadline_seconds?: number;
}

export interface SseEvent {
  id?: string;
  kind?: string;
  data: Record<string, unknown>;
}

export interface JobView {
  job_id: string;
  status: string;
  result: Record<string, unknown> | null;
  [k: string]: unknown;
}

export interface WorkerHandle {
  job_id: string;
  events(): Promise<SseEvent[]>;
  cancel(): Promise<Record<string, unknown>>;
  result(timeoutMs?: number): Promise<JobView>;
}

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "needs_recovery"]);

async function call(
  endpoint: { url: string; token: string },
  method: string,
  path_: string,
  body: unknown,
  extraHeaders: Record<string, string>,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${endpoint.url}${path_}`, {
      method,
      headers: {
        authorization: `Bearer ${endpoint.token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...extraHeaders,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new WorkerError(`${method} ${path_} -> ${res.status} ${txt.slice(0, 200)}`, res.status);
    }
    return res;
  } catch (e) {
    if (e instanceof WorkerError) throw e;
    throw new WorkerError(`${method} ${path_} failed: ${String(e).slice(0, 120)}`, 0);
  } finally {
    clearTimeout(t);
  }
}

export async function worker(
  endpoint: { url: string; token: string },
  request: WorkerRequest,
  opts: { timeoutMs?: number; idempotencyKey?: string } = {},
): Promise<WorkerHandle> {
  const timeout = opts.timeoutMs ?? 15_000;
  const key = opts.idempotencyKey ?? randomUUID();
  const res = await call(endpoint, "POST", "/v1/jobs", request, { "idempotency-key": key }, timeout);
  const { job_id } = (await res.json()) as { job_id: string };

  return {
    job_id,
    async events() {
      const r = await call(endpoint, "GET", `/v1/jobs/${job_id}/events`, undefined, {}, timeout);
      const text = await r.text();
      return text
        .split("\n\n")
        .filter((p) => p.includes("data: "))
        .map((p) => ({
          id: p.match(/^id: (.+)$/m)?.[1],
          kind: p.match(/^event: (.+)$/m)?.[1],
          data: JSON.parse(p.match(/^data: (.+)$/m)![1]!) as Record<string, unknown>,
        }));
    },
    async cancel() {
      const r = await call(endpoint, "POST", `/v1/jobs/${job_id}/cancel`, {}, {}, timeout);
      return (await r.json()) as Record<string, unknown>;
    },
    async result(timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const r = await call(endpoint, "GET", `/v1/jobs/${job_id}`, undefined, {}, timeout);
        const job = (await r.json()) as JobView;
        if (TERMINAL.has(job.status)) return job;
        if (Date.now() > deadline) {
          throw new WorkerError(`result timeout after ${timeoutMs}ms (status=${job.status})`, 0);
        }
        await new Promise((r2) => setTimeout(r2, 150));
      }
    },
  };
}
