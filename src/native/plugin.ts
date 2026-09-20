// Shared plugin runtime: JSON-RPC 2.0 over stdio (stdout carries ONLY
// protocol frames; stderr is bounded diagnostics). Methods:
//   handshake / probe / run / cancel            (required)
//   respondPermission                           (optional, Devin only)
// One active run per plugin process — attempt-specific, no pooling.
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import {
  WireProcess, ChildWireProcess, LineDecoder, ProtocolBoundError,
  sha256File, MAX_LINE_BYTES,
} from "./wire.js";
import { AcpClient, AcpProtocolError, PermissionDecision } from "./acp.js";
import { AgyStreamClient, agyArgs } from "./agy.js";
import {
  CanonicalEvent, Capabilities, NativeError, NativeSpec, PluginInfo,
  ProbeResult, RunRequest, RunResult, Usage,
} from "./types.js";

export const PLUGIN_PROTOCOL_VERSION = 1;

export class RpcFail extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}
const RPC = { PARSE: -32700, INVALID: -32600, NO_METHOD: -32601, PARAMS: -32602, INTERNAL: -32603 };

// ---------- minimal stdio JSON-RPC server ----------
export class StdioRpcServer {
  private handlers = new Map<string, (p: unknown) => Promise<unknown> | unknown>();
  private decoder = new LineDecoder();
  constructor(
    private input: NodeJS.ReadableStream = process.stdin,
    private output: NodeJS.WritableStream = process.stdout,
  ) {}
  method(name: string, fn: (p: unknown) => Promise<unknown> | unknown) {
    this.handlers.set(name, fn);
  }
  notify(method: string, params: unknown) {
    const f = JSON.stringify({ jsonrpc: "2.0", method, params });
    if (Buffer.byteLength(f) <= MAX_LINE_BYTES) this.output.write(f + "\n");
  }
  private respond(id: unknown, result?: unknown, error?: { code: number; message: string; data?: unknown }) {
    const msg: Record<string, unknown> = { jsonrpc: "2.0", id: id ?? null };
    if (error) msg.error = error;
    else msg.result = result ?? null;
    this.output.write(JSON.stringify(msg) + "\n");
  }
  start() {
    this.input.on("data", (chunk: Buffer) => {
      let lines: string[];
      try {
        lines = this.decoder.push(chunk);
      } catch (e) {
        if (e instanceof ProtocolBoundError) process.exit(2);
        throw e;
      }
      for (const l of lines) if (l.length) void this.frame(l);
    });
  }
  private async frame(line: string) {
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
      return this.respond(null, undefined, { code: RPC.INVALID, message: "frame too large" });
    }
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      return this.respond(null, undefined, { code: RPC.PARSE, message: "malformed JSON" });
    }
    if (msg == null || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string" || !("id" in msg)) {
      return this.respond(msg?.id ?? null, undefined, { code: RPC.INVALID, message: "expected request with id" });
    }
    const h = this.handlers.get(msg.method);
    if (!h) return this.respond(msg.id, undefined, { code: RPC.NO_METHOD, message: msg.method });
    try {
      this.respond(msg.id, await h(msg.params));
    } catch (e) {
      if (e instanceof RpcFail) this.respond(msg.id, undefined, { code: e.code, message: e.message, data: e.data });
      else this.respond(msg.id, undefined, { code: RPC.INTERNAL, message: String(e).slice(0, 500) });
    }
  }
}

// ---------- native spec verification ----------
function parseVer(s: string): [number, number, number] | null {
  const m = s.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function cmpVer(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}
// CLOSED range parser: every whitespace/comma-separated token must be a full
// comparator (>=|<=|>|<|= optional, then x.y.z with optional -/+ suffix).
// Blank ranges, partial versions, and any unparsable token fail closed.
export function versionInRange(version: string, range: string): boolean {
  const v = parseVer(version);
  if (!v) return false;
  const trimmed = range.trim();
  if (!trimmed) return false;
  const tokens = trimmed.split(/[\s,]+/);
  if (!tokens.length || tokens.some((t) => t === "")) return false;
  for (const part of tokens) {
    const m = part.match(/^(>=|<=|>|<|=)?(\d+)\.(\d+)\.(\d+)([-+][0-9A-Za-z.-]+)?$/);
    if (!m) return false; // unparsable token -> closed fail
    const b: [number, number, number] = [Number(m[2]), Number(m[3]), Number(m[4])];
    const c = cmpVer(v, b);
    const op = m[1] ?? "=";
    if (op === ">=" && c < 0) return false;
    if (op === "<=" && c > 0) return false;
    if (op === ">" && c <= 0) return false;
    if (op === "<" && c >= 0) return false;
    if (op === "=" && c !== 0) return false;
  }
  return true;
}

// Pinned executable identity, rechecked before EVERY spawn (not just probe):
// a swapped binary between probe and run must fail closed.
export function verifySpecIdentity(spec: NativeSpec): void {
  let real: string;
  try {
    real = fs.realpathSync(spec.executable);
  } catch {
    throw new RpcFail(RPC.PARAMS, "CLI_NOT_INSTALLED: executable missing", { code: "CLI_NOT_INSTALLED" });
  }
  const hash = sha256File(real);
  if (spec.sha256 && hash !== spec.sha256) {
    throw new RpcFail(RPC.PARAMS, "CLI executable sha256 mismatch", { code: "CLI_NOT_INSTALLED" });
  }
}

// Probe = executable identity ONLY: realpath + pinned sha256 + bounded
// no-inference version call. Never reads auth files, never sends a prompt.
export async function probeNative(
  spec: NativeSpec,
  capabilities: Capabilities,
  env: Record<string, string>,
  spawnProc: (spec: { executable: string; args: string[]; cwd: string; env: Record<string, string> }) => WireProcess = (s) => new ChildWireProcess(s),
): Promise<ProbeResult> {
  let real: string;
  try {
    real = fs.realpathSync(spec.executable);
  } catch {
    throw new RpcFail(RPC.PARAMS, "CLI_NOT_INSTALLED: executable missing", { code: "CLI_NOT_INSTALLED" });
  }
  const hash = sha256File(real);
  if (spec.sha256 && hash !== spec.sha256) {
    throw new RpcFail(RPC.PARAMS, "CLI executable sha256 mismatch", { code: "CLI_NOT_INSTALLED" });
  }
  const proc = spawnProc({ executable: real, args: [...(spec.base_args ?? []), ...spec.version_args], cwd: "/", env });
  const out: string[] = [];
  proc.on("line", (l) => out.push(l));
  proc.on("stderr_chunk", (c) => out.push(c));
  const exited = new Promise<void>((r) => proc.on("exit", () => r()));
  const timed = await Promise.race([exited.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), 10000))]);
  if (timed) {
    await proc.stop();
    throw new RpcFail(RPC.INTERNAL, "version probe timed out", { code: "TIMEOUT" });
  }
  const text = out.join("\n").slice(0, 8192);
  const m = text.match(/(\d+\.\d+\.\d+[^\s]*)/);
  if (!m) {
    throw new RpcFail(RPC.INTERNAL, "unparsable CLI version output", { code: "INVALID_OUTPUT" });
  }
  if (!versionInRange(m[1]!, spec.version_range)) {
    throw new RpcFail(RPC.PARAMS, `CLI_VERSION_UNSUPPORTED: ${m[1]} not in ${spec.version_range}`, { code: "CLI_VERSION_UNSUPPORTED" });
  }
  // models intentionally omitted: catalog is operator-managed; live `models
  // list` would depend on auth state and is not a capability proof.
  return { cli_version: m[1]!, capabilities };
}

// ---------- run plumbing ----------
export interface PluginConfig {
  info: PluginInfo;
  spec: NativeSpec;
  kind: "devin-acp" | "agy-stream";
  capabilities: Capabilities;
  methods: string[];
  permissionCapable: boolean;
}

interface ActiveRun {
  req: RunRequest;
  seq: number;
  proc: WireProcess;
  acp?: AcpClient;
  sessionId?: string;
  done: boolean;
  tools: { ranMutating: boolean; anyTool: boolean; anyDenied: boolean };
}

function needStr(v: unknown, name: string, max = 40000): string {
  if (typeof v !== "string" || !v.length || v.length > max) throw new RpcFail(RPC.PARAMS, `invalid ${name}`);
  return v;
}
function validRunRequest(p: unknown): RunRequest {
  const r = p as RunRequest;
  if (!r || typeof r !== "object") throw new RpcFail(RPC.PARAMS, "run params required");
  needStr(r.run_id, "run_id", 200);
  needStr(r.job_id, "job_id", 200);
  needStr(r.attempt_id, "attempt_id", 200);
  needStr(r.task, "task", 32768);
  needStr(r.candidate_id, "candidate_id", 200);
  needStr(r.requested_model, "requested_model", 200);
  if (typeof r.deadline_ms !== "number" || r.deadline_ms < 1) throw new RpcFail(RPC.PARAMS, "invalid deadline_ms");
  if (!r.workspace || typeof r.workspace.path !== "string" || !r.workspace.path.startsWith("/")) {
    throw new RpcFail(RPC.PARAMS, "workspace.path must be absolute");
  }
  if (!["interactive", "preconfigured_only", "deny"].includes(r.resolved_policy?.permission_mode)) {
    throw new RpcFail(RPC.PARAMS, "invalid permission_mode");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(r.requested_model)) {
    throw new RpcFail(RPC.PARAMS, "requested_model fails exact-id validation");
  }
  return r;
}

export class NativePlugin {
  private active: ActiveRun | null = null;
  constructor(
    private cfg: PluginConfig,
    private server: StdioRpcServer,
    private spawnProc: (s: { executable: string; args: string[]; cwd: string; env: Record<string, string> }) => WireProcess = (s) => new ChildWireProcess(s),
  ) {}

  register() {
    const c = this.cfg;
    this.server.method("handshake", () => ({
      protocol_version: PLUGIN_PROTOCOL_VERSION,
      plugin_id: c.info.plugin_id,
      plugin_version: c.info.plugin_version,
      methods: c.methods,
      capabilities: c.capabilities,
      event_schema_version: 1,
    }));
    this.server.method("probe", async (p) => {
      const prof = (p ?? {}) as { profile?: { env?: Record<string, string> } };
      return probeNative(this.cfg.spec, this.cfg.capabilities, prof.profile?.env ?? {}, this.spawnProc);
    });
    this.server.method("run", (p) => this.run(p));
    this.server.method("cancel", async (p) => {
      const runId = needStr((p as { run_id?: unknown })?.run_id, "run_id", 200);
      return this.cancel(runId);
    });
    if (this.cfg.permissionCapable) {
      this.server.method("respondPermission", (p) => {
        const pp = p as { run_id?: unknown; request_id?: unknown; decision?: unknown };
        const runId = needStr(pp.run_id, "run_id", 200);
        const reqId = needStr(pp.request_id, "request_id", 200);
        // decision is a verbatim offered option id (or decision-class name);
        // the ACP client enforces it was actually offered
        const decision = needStr(pp.decision, "decision", 128);
        if (!this.active || this.active.req.run_id !== runId || !this.active.acp) {
          throw new RpcFail(RPC.PARAMS, "no active run for run_id");
        }
        const ok = this.active.acp.decidePermissionOutcome(reqId, decision as PermissionDecision);
        if (!ok) throw new RpcFail(RPC.PARAMS, "no pending permission for request_id");
        return { delivered: true };
      });
    }
  }

  private emit(run: ActiveRun, kind: CanonicalEvent["kind"], payload: unknown) {
    const ev = {
      schema_version: 1,
      job_id: run.req.job_id,
      attempt_id: run.req.attempt_id,
      run_id: run.req.run_id,
      event_id: randomUUID(),
      sequence: run.seq++,
      ts: new Date().toISOString(),
      kind,
      payload,
    } as CanonicalEvent;
    this.server.notify("run.event", ev);
  }

  private async cancel(runId: string) {
    if (!this.active || this.active.req.run_id !== runId || this.active.done) {
      return { ack: "already_finished" };
    }
    // local cancellation accepted; remote confirmation arrives via the
    // in-flight prompt/result (cancel_confirmed in the run outcome)
    try {
      if (this.active.acp && this.active.sessionId) await this.active.acp.requestCancel(this.active.sessionId);
      else await this.active.proc.stop();
    } catch {
      /* still ack local attempt */
    }
    return { ack: "accepted" };
  }

  private async run(p: unknown): Promise<RunResult> {
    const req = validRunRequest(p);
    if (this.active && !this.active.done) {
      throw new RpcFail(RPC.PARAMS, "plugin already has an active run");
    }
    if (req.native_session_id) {
      // resume is NOT implemented — refuse rather than silently start fresh
      throw new RpcFail(RPC.PARAMS, "UNSUPPORTED_CAPABILITY: resume not implemented", { code: "UNSUPPORTED_CAPABILITY" });
    }
    if (this.cfg.kind === "devin-acp" && req.requested_effort) {
      throw new RpcFail(RPC.PARAMS, "UNSUPPORTED_CAPABILITY: effort unverified for devin acp", { code: "UNSUPPORTED_CAPABILITY" });
    }
    if (this.cfg.kind === "agy-stream" && req.requested_effort && !["low", "medium", "high"].includes(req.requested_effort)) {
      throw new RpcFail(RPC.PARAMS, "UNSUPPORTED_CAPABILITY: effort value not in documented set", { code: "UNSUPPORTED_CAPABILITY" });
    }

    const run: ActiveRun = {
      req, seq: 0, done: false,
      proc: undefined as unknown as WireProcess,
      tools: { ranMutating: false, anyTool: false, anyDenied: false },
    };
    this.active = run;
    try {
      const result = this.cfg.kind === "devin-acp" ? await this.runDevin(run) : await this.runAgy(run);
      run.done = true;
      return result;
    } finally {
      run.done = true;
    }
  }

  private mkError(code: NativeError["code"], message: string, phase: NativeError["phase"], rs: NativeError["retry_safety"] = "unknown"): NativeError {
    return { code, message: message.slice(0, 2000), phase, retry_safety: rs };
  }

  private async runDevin(run: ActiveRun): Promise<RunResult> {
    const req = run.req;
    verifySpecIdentity(this.cfg.spec); // launch-time identity recheck
    const proc = this.spawnProc({
      executable: this.cfg.spec.executable,
      args: [...(this.cfg.spec.base_args ?? []), "acp", "--model", req.requested_model],
      cwd: req.workspace.path,
      env: req.env,
    });
    run.proc = proc;
    const tools = run.tools;
    const toolKinds = new Map<string, string>();

    const client = new AcpClient(proc, {
      onText: (t) => this.emit(run, "text.delta", { text: t }),
      onToolStarted: (tool, callId, kind) => {
        tools.anyTool = true;
        if (kind) toolKinds.set(callId, kind);
        this.emit(run, "tool.started", { tool, call_id: callId });
      },
      onToolCompleted: (tool, callId, status) => {
        const kind = toolKinds.get(callId);
        // completed mutating OR unknown-kind tool -> conservative side effects
        if (status === "ok" || status === "error") {
          if (!kind || ["edit", "delete", "move", "execute"].includes(kind)) tools.ranMutating = true;
        }
        this.emit(run, "tool.completed", { tool, call_id: callId, status });
      },
      onPermissionRequired: (requestId, action, target, options) =>
        this.emit(run, "permission.required", { request_id: requestId, action, target, options }),
      onPermissionOutcome: (d) => {
        if (d !== "allow_once") tools.anyDenied = true;
      },
      onContextUsage: (u) =>
        this.emit(run, "usage.observed", { usage: { cumulative: true }, context: u }),
    }, req.resolved_policy.permission_mode, Math.min(req.deadline_ms, req.resolved_policy.max_wall_seconds * 1000));
    run.acp = client;

    this.emit(run, "run.started", { requested_model: req.requested_model, ...(proc.identity ? { native_pid: proc.identity.pid } : {}) });
    try {
      await client.initialize(15000);
    } catch (e) {
      await proc.stop();
      const code = e instanceof AcpProtocolError && e.code === "ACP_VERSION_MISMATCH" ? "CLI_VERSION_UNSUPPORTED" : "INVALID_OUTPUT";
      const error = this.mkError(code, String(e), "handshake");
      this.emit(run, "run.failed", { error });
      return { outcome: "failed", status: "unknown", side_effects: "none", retry_safety: "safe", error };
    }

    let sessionId: string;
    try {
      sessionId = await client.newSession(req.workspace.path, 15000);
      run.sessionId = sessionId;
    } catch (e) {
      await proc.stop();
      const error = this.mkError("INVALID_OUTPUT", String(e), "handshake");
      this.emit(run, "run.failed", { error });
      return { outcome: "failed", status: "unknown", side_effects: "none", retry_safety: "safe", error };
    }

    const deadlineMs = Math.min(req.deadline_ms, req.resolved_policy.max_wall_seconds * 1000);
    try {
      const outcome = await client.prompt(sessionId, req.task, deadlineMs);
      const cls = AcpClient.classifyRun(outcome.stopReason, tools);
      const result: RunResult = {
        outcome: cls.outcome,
        ...(cls.status ? { status: cls.status } : {}),
        native_session_id: sessionId,
        side_effects: cls.sideEffects,
        retry_safety: cls.retrySafety,
        ...(outcome.stopReason === "cancelled" ? { cancel_confirmed: outcome.cancelledConfirmed } : {}),
      };
      // response_text assembled by router from text.delta events; usage is
      // context-window only (emitted as usage.observed context payload)
      if (cls.outcome === "cancelled") {
        this.emit(run, "run.cancelled", { confirmed: outcome.cancelledConfirmed });
      } else {
        this.emit(run, "run.completed", {
          status: cls.status ?? "unknown",
          side_effects: cls.sideEffects,
          retry_safety: cls.retrySafety,
        });
      }
      await proc.stop("SIGTERM", 500);
      return result;
    } catch (e) {
      await proc.stop();
      const isTimeout = e instanceof AcpProtocolError && e.code === "ACP_TIMEOUT";
      const error = this.mkError(isTimeout ? "TIMEOUT" : "UNKNOWN_NATIVE_OUTCOME", String(e), "run");
      this.emit(run, "run.failed", { error });
      return { outcome: "failed", status: "unknown", side_effects: tools.anyTool ? "unknown" : "none", retry_safety: "unknown", error };
    }
  }

  private async runAgy(run: ActiveRun): Promise<RunResult> {
    const req = run.req;
    verifySpecIdentity(this.cfg.spec); // launch-time identity recheck
    const proc = this.spawnProc({
      executable: this.cfg.spec.executable,
      args: [...(this.cfg.spec.base_args ?? []), ...agyArgs(req.requested_model, req.requested_effort)],
      cwd: req.workspace.path,
      env: req.env,
    });
    run.proc = proc;
    const client = new AgyStreamClient(proc, {
      onText: (t) => this.emit(run, "text.delta", { text: t }),
      onToolStarted: (tool, callId) => this.emit(run, "tool.started", { tool, call_id: callId }),
      onToolCompleted: (tool, callId, status) => this.emit(run, "tool.completed", { tool, call_id: callId, status }),
      onUsage: (u: Usage) => this.emit(run, "usage.observed", { usage: u }),
    });
    this.emit(run, "run.started", { requested_model: req.requested_model, ...(proc.identity ? { native_pid: proc.identity.pid } : {}) });
    const deadlineMs = Math.min(req.deadline_ms, req.resolved_policy.max_wall_seconds * 1000);
    const out = await client.run(req.task, deadlineMs);
    if (proc.exitCode === null && proc.exitSignal === null && !proc.killedByUs) {
      await proc.stop("SIGTERM", 500);
    }
    const r = out.result;
    if (r.outcome === "completed") {
      this.emit(run, "run.completed", {
        status: r.status ?? "unknown",
        ...(r.response_text !== undefined ? { response_text: r.response_text } : {}),
        ...(r.usage ? { usage: r.usage } : {}),
        side_effects: r.side_effects,
        retry_safety: r.retry_safety,
      });
    } else if (r.outcome === "cancelled") {
      this.emit(run, "run.cancelled", { confirmed: r.cancel_confirmed === true });
    } else {
      this.emit(run, "run.failed", {
        error: r.error ?? this.mkError("UNKNOWN_NATIVE_OUTCOME", "agy run failed without detail", "run"),
      });
    }
    return r;
  }
}

// Entry helper used by plugins/*.ts. Plugin env exposes ONLY these names;
// the parent supplies values via the approved env allowlist.
export function specFromEnv(prefix: string): NativeSpec {
  const executable = process.env[`${prefix}_EXECUTABLE`] ?? "";
  const sha256 = process.env[`${prefix}_SHA256`] ?? "";
  const version_range = process.env[`${prefix}_VERSION_RANGE`] ?? ">=0.0.0";
  const version_args = (process.env[`${prefix}_VERSION_ARGS`] ?? "--version").split(" ").filter(Boolean);
  const base_args = (process.env[`${prefix}_BASE_ARGS`] ?? "").split(" ").filter(Boolean);
  if (!executable.startsWith("/")) {
    process.stderr.write(`${prefix}_EXECUTABLE must be an absolute path\n`);
    process.exit(2);
  }
  if (sha256 && !/^[0-9a-f]{64}$/.test(sha256)) {
    process.stderr.write(`${prefix}_SHA256 must be 64 hex chars\n`);
    process.exit(2);
  }
  return { executable, sha256, version_range, version_args, base_args };
}

export function servePlugin(cfg: PluginConfig, input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream) {
  const server = new StdioRpcServer(input, output);
  const plugin = new NativePlugin(cfg, server);
  plugin.register();
  server.start();
  return { server, plugin };
}
