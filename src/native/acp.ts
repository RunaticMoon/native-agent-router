// Devin ACP v1 client. Bidirectional JSON-RPC over the CLI's stdio.
// Wire path: initialize -> session/new -> session/prompt with bounded
// sequential request ids; session/update notifications; agent->client
// session/request_permission answered with the SAME native request id;
// session/cancel notification -> in-flight prompt resolves stopReason
// 'cancelled' (only then is remote cancellation confirmed).
//
// Client capabilities are fs:false / terminal:false: native tool events are
// normalized OBSERVATIONS only, never executed by us. Any other agent->client
// request (fs/*, terminal/*, authenticate, ...) is refused -32601; auth is
// owned by the official CLI/operator.
import { WireProcess, MAX_LINE_BYTES } from "./wire.js";
import { Usage } from "./types.js";
import { normalizeOptionKind } from "../contracts/index.js";

export class AcpProtocolError extends Error {
  constructor(
    message: string,
    readonly code = "ACP_PROTOCOL",
  ) {
    super(message);
  }
}

export const ACP_PROTOCOL_VERSION = 1;
const MAX_REQUEST_ID = 0x7fffffff;

export type PermissionDecision = "allow_once" | "reject_once" | "cancelled";

// Raw ACP option shape as it arrives on the wire.
interface AcpWireOption {
  optionId: string;
  name?: string;
  kind?: string;
}

// What the client surfaces to the plugin: opaque verbatim id + normalized
// kind + raw native kind preserved separately.
export interface SurfacedPermissionOption {
  id: string;
  kind: "allow" | "reject" | "cancel" | "unknown";
  native_kind?: string;
}

export interface AcpUpdateHandlers {
  onText(text: string): void;
  onToolStarted(tool: string, callId: string, kind?: string): void;
  onToolCompleted(tool: string, callId: string, status: "ok" | "error" | "denied"): void;
  onPermissionRequired(requestId: string, action: string, target: string, options: SurfacedPermissionOption[]): void;
  onPermissionOutcome?(decision: PermissionDecision): void;
  onContextUsage(u: { used: number; size: number; cost_amount?: number; currency?: string }): void;
}

interface PendingCall {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export interface PromptOutcome {
  stopReason: string;
  cancelledConfirmed: boolean;
}

const MUTATING_KINDS = new Set(["edit", "delete", "move", "execute"]);

export class AcpClient {
  private pending = new Map<string | number, PendingCall>();
  private pendingPermissions = new Map<string | number, { options: AcpWireOption[]; toolCallId?: string }>();
  private permissionDecisions = new Map<string | number, PermissionDecision>();
  private permissionSelections = new Map<string | number, string>(); // verbatim offered optionId
  private nextId = 0;
  private promptStopReason: string | null = null;
  private cancelSent = false;
  agentInfo: { name?: string; version?: string } = {};
  agentCapabilities: Record<string, unknown> = {};
  closed = false;

  constructor(
    readonly proc: WireProcess,
    private handlers: AcpUpdateHandlers,
    private permissionMode: "interactive" | "preconfigured_only" | "deny",
    private permissionTimeoutMs = 300000,
  ) {
    proc.on("line", (l) => this.onLine(l));
    proc.on("protocol_error", () => this.failAll(new AcpProtocolError("stdout bound exceeded")));
    proc.on("exit", () => {
      this.closed = true;
      this.failAll(new AcpProtocolError("agent process exited"));
    });
    proc.on("spawn_error", (e) => this.failAll(e as Error));
  }

  private failAll(err: Error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    // turn end without a decision -> cancelled outcome on the wire
    for (const id of this.pendingPermissions.keys()) {
      this.handlers.onPermissionOutcome?.("cancelled");
      this.respondPermission(id, { outcome: "cancelled" });
    }
    this.pendingPermissions.clear();
  }

  private allocId(): number {
    if (this.nextId >= MAX_REQUEST_ID) throw new AcpProtocolError("request id space exhausted");
    return this.nextId++;
  }

  private send(msg: unknown): Promise<void> {
    const frame = JSON.stringify(msg);
    if (Buffer.byteLength(frame) > MAX_LINE_BYTES) return Promise.reject(new AcpProtocolError("outbound frame too large"));
    return this.proc.writeLine(frame);
  }

  private respond(id: string | number, result?: unknown, error?: { code: number; message: string }) {
    const msg: Record<string, unknown> = { jsonrpc: "2.0", id };
    if (error) msg.error = error;
    else msg.result = result ?? null;
    this.send(msg).catch(() => {});
  }

  private call<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    if (this.closed) return Promise.reject(new AcpProtocolError("client closed"));
    const id = this.allocId();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AcpProtocolError(`acp call timeout: ${method}`, "ACP_TIMEOUT"));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params }).catch((e) => {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  private onLine(line: string) {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      this.failAll(new AcpProtocolError(`malformed JSONL frame: ${line.slice(0, 80)}`));
      return;
    }
    // Strict envelope handling: null/array/scalar frames are malformed
    // protocol data — the run fails, they are never silently ignored.
    if (msg == null || typeof msg !== "object" || Array.isArray(msg)) {
      this.failAll(new AcpProtocolError("malformed frame: expected object envelope"));
      return;
    }
    const hasId = "id" in msg && msg.id != null;
    if (typeof msg.method === "string" && hasId) {
      this.onAgentRequest(msg.id as string | number, msg.method, msg.params);
      return;
    }
    if (hasId && ("result" in msg || "error" in msg)) {
      const p = this.pending.get(msg.id as string | number);
      if (!p) return; // stale/unknown id — refuse silently
      this.pending.delete(msg.id as string | number);
      clearTimeout(p.timer);
      if (msg.error) {
        const e = msg.error as { code?: number; message?: string };
        p.reject(new AcpProtocolError(`agent error ${e.code}: ${e.message ?? "unknown"}`));
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    if (typeof msg.method === "string" && !hasId) {
      if (msg.method === "session/update") this.onSessionUpdate(msg.params);
      // other notifications are not part of the negotiated subset
      return;
    }
  }

  private onAgentRequest(id: string | number, method: string, params: unknown) {
    if (method === "session/request_permission") {
      this.onPermissionRequest(id, params);
      return;
    }
    // authenticate, fs/*, terminal/* and anything else: refused. Client fs and
    // terminal capabilities were negotiated false; auth stays with the CLI.
    this.respond(id, undefined, { code: -32601, message: `unsupported client method: ${method}` });
  }

  private onPermissionRequest(id: string | number, params: unknown) {
    const p = (params ?? {}) as {
      sessionId?: string;
      toolCall?: { toolCallId?: string; title?: string; kind?: string };
      options?: AcpWireOption[];
    };
    const options = Array.isArray(p.options) ? p.options : [];
    this.pendingPermissions.set(id, { options, toolCallId: p.toolCall?.toolCallId });
    // surface {id, normalized kind, raw native_kind} — the id stays opaque and
    // verbatim; semantics ride separately so upstream code never re-infers
    // allow/deny from an opaque string.
    const surfaced: SurfacedPermissionOption[] = options.map((o) => ({
      id: String(o.optionId ?? o.name ?? ""),
      kind: normalizeOptionKind(o.kind),
      ...(o.kind !== undefined ? { native_kind: String(o.kind) } : {}),
    }));
    const action = p.toolCall?.title || p.toolCall?.kind || "tool_call";
    const target = p.toolCall?.toolCallId ?? "";
    // Decision wait runs asynchronously; the agent blocks on our response.
    void this.decidePermission(id).catch(() => {
      this.respondPermission(id, { outcome: "cancelled" });
    });
    this.handlers.onPermissionRequired(String(id), action, target, surfaced);
  }

  // Wait for a decision pushed via decidePermissionOutcome(), bounded by
  // deadline. Non-interactive modes decide reject immediately — never
  // auto-allow, never fabricate an option that wasn't offered.
  private async decidePermission(id: string | number): Promise<void> {
    if (this.permissionMode !== "interactive") {
      this.permissionDecisions.set(id, "reject_once");
    }
    const deadline = Date.now() + this.permissionTimeoutMs;
    while (Date.now() < deadline) {
      const d = this.permissionDecisions.get(id);
      const sel = this.permissionSelections.get(id);
      const rec = this.pendingPermissions.get(id);
      if (!rec) return; // already answered/cancelled
      if (sel !== undefined) {
        // verbatim offered optionId selected by the broker — must be one of
        // the offered options, never fabricated
        this.pendingPermissions.delete(id);
        const opt = rec.options.find((o) => String(o.optionId ?? o.name ?? "") === sel);
        this.handlers.onPermissionOutcome?.(/cancel/i.test(sel) ? "cancelled" : /reject|deny/i.test(sel) ? "reject_once" : "allow_once");
        if (!opt) return this.respondPermission(id, { outcome: "cancelled" });
        return this.respondPermission(id, { outcome: "selected", optionId: opt.optionId });
      }
      if (d) {
        this.pendingPermissions.delete(id);
        this.handlers.onPermissionOutcome?.(d);
        if (d === "cancelled") return this.respondPermission(id, { outcome: "cancelled" });
        const kind = d === "allow_once" ? ["allow_once"] : ["reject_once", "reject_always"];
        const opt = rec.options.find((o) => kind.includes(String(o.kind ?? "")));
        if (!opt) return this.respondPermission(id, { outcome: "cancelled" }); // never fabricate
        return this.respondPermission(id, { outcome: "selected", optionId: opt.optionId });
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    this.pendingPermissions.delete(id);
    this.handlers.onPermissionOutcome?.("cancelled");
    this.respondPermission(id, { outcome: "cancelled" }); // timeout denies by default
  }

  private respondPermission(id: string | number, outcome: unknown) {
    this.respond(id, { outcome });
  }

  // Plugin entry point: router's respondPermission RPC lands here. The
  // decision is a verbatim OFFERED option id (e.g. "allow-once") or a
  // decision-class name ("allow_once"|"reject_once"|"cancelled").
  decidePermissionOutcome(nativeRequestId: string, decision: string): boolean {
    const key = [...this.pendingPermissions.keys()].find((k) => String(k) === nativeRequestId);
    if (key === undefined) return false;
    const rec = this.pendingPermissions.get(key);
    const offered = rec?.options.find((o) => String(o.optionId ?? o.name ?? "") === decision);
    if (offered) {
      if (this.permissionMode !== "interactive" && /allow/i.test(String(offered.kind ?? offered.optionId))) {
        return false; // never auto-allow outside interactive mode
      }
      this.permissionSelections.set(key, decision);
      return true;
    }
    if (decision === "allow_once" || decision === "reject_once" || decision === "cancelled") {
      if (this.permissionMode !== "interactive" && decision === "allow_once") return false; // never auto-allow
      this.permissionDecisions.set(key, decision);
      return true;
    }
    return false;
  }

  private onSessionUpdate(params: unknown) {
    const p = (params ?? {}) as { sessionId?: string; update?: Record<string, unknown> };
    const u = p.update;
    if (!u || typeof u !== "object") return;
    switch (u.sessionUpdate) {
      case "agent_message_chunk": {
        const c = u.content as { type?: string; text?: string } | undefined;
        if (c?.type === "text" && typeof c.text === "string" && c.text.length) this.handlers.onText(c.text);
        break;
      }
      case "tool_call": {
        const callId = String(u.toolCallId ?? "");
        const tool = String(u.name ?? u.title ?? "tool");
        if (callId) this.handlers.onToolStarted(tool, callId, typeof u.kind === "string" ? u.kind : undefined);
        break;
      }
      case "tool_call_update": {
        const callId = String(u.toolCallId ?? "");
        if (!callId) break;
        const st = String(u.status ?? "");
        if (st === "completed") this.handlers.onToolCompleted(String(u.name ?? "tool"), callId, "ok");
        else if (st === "failed") this.handlers.onToolCompleted(String(u.name ?? "tool"), callId, "error");
        break;
      }
      case "usage_update": {
        const used = Number(u.used ?? NaN);
        const size = Number(u.size ?? NaN);
        if (Number.isFinite(used) && Number.isFinite(size)) {
          const cost = u.cost as { amount?: number; currency?: string } | undefined;
          this.handlers.onContextUsage({
            used, size,
            ...(cost && typeof cost.amount === "number" ? { cost_amount: cost.amount, currency: cost.currency } : {}),
          });
        }
        break;
      }
      // plan / agent_thought_chunk / user_message_chunk / config_option_update /
      // available_commands_update / current_mode_update etc: never leak to text
      default:
        break;
    }
  }

  async initialize(timeoutMs = 15000): Promise<void> {
    const res = (await this.call(
      "initialize",
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "native-agent-router", title: "Native Agent Router", version: "0.1.0" },
      },
      timeoutMs,
    )) as {
      protocolVersion?: number;
      agentCapabilities?: Record<string, unknown>;
      agentInfo?: { name?: string; version?: string };
      authMethods?: unknown[];
    };
    if (res?.protocolVersion !== ACP_PROTOCOL_VERSION) {
      throw new AcpProtocolError(`protocol version mismatch: got ${String(res?.protocolVersion)}`, "ACP_VERSION_MISMATCH");
    }
    this.agentCapabilities = res.agentCapabilities ?? {};
    this.agentInfo = res.agentInfo ?? {};
  }

  async newSession(cwd: string, timeoutMs = 15000): Promise<string> {
    const res = (await this.call("session/new", { cwd, mcpServers: [] }, timeoutMs)) as { sessionId?: string };
    if (typeof res?.sessionId !== "string" || !res.sessionId.length) {
      throw new AcpProtocolError("session/new returned no sessionId");
    }
    return res.sessionId;
  }

  // Resolves when the agent answers the prompt request with a stopReason.
  async prompt(sessionId: string, text: string, deadlineMs: number): Promise<PromptOutcome> {
    const res = (await this.call(
      "session/prompt",
      { sessionId, prompt: [{ type: "text", text }] },
      deadlineMs,
    )) as { stopReason?: string };
    const sr = String(res?.stopReason ?? "");
    this.promptStopReason = sr;
    return { stopReason: sr, cancelledConfirmed: sr === "cancelled" && this.cancelSent };
  }

  // ACP cancellation is a notification; remote confirmation only arrives when
  // the in-flight prompt resolves with stopReason 'cancelled'.
  async requestCancel(sessionId: string): Promise<void> {
    this.cancelSent = true;
    await this.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
  }

  hasPendingPermission(): boolean {
    return this.pendingPermissions.size > 0;
  }

  static classifyRun(stopReason: string, toolObservations: { ranMutating: boolean; anyTool: boolean; anyDenied: boolean }): {
    outcome: "completed" | "failed" | "cancelled";
    status?: "completed" | "partial" | "blocked" | "unknown";
    sideEffects: "none" | "present" | "unknown";
    retrySafety: "safe" | "unsafe" | "unknown";
  } {
    const sideEffects: "none" | "present" | "unknown" = toolObservations.ranMutating
      ? "present"
      : toolObservations.anyTool
        ? "unknown"
        : "none";
    if (stopReason === "cancelled") {
      return { outcome: "cancelled", sideEffects, retrySafety: toolObservations.ranMutating ? "unsafe" : "unknown" };
    }
    if (stopReason === "end_turn") {
      return {
        outcome: "completed",
        status: toolObservations.anyDenied ? "partial" : "completed",
        sideEffects,
        retrySafety: toolObservations.ranMutating ? "unsafe" : "unknown",
      };
    }
    if (stopReason === "refusal") {
      return { outcome: "completed", status: "blocked", sideEffects, retrySafety: "unknown" };
    }
    if (stopReason === "max_tokens" || stopReason === "max_turn_requests") {
      return { outcome: "completed", status: "partial", sideEffects, retrySafety: "unknown" };
    }
    return { outcome: "completed", status: "unknown", sideEffects, retrySafety: "unknown" };
  }
}

export { MUTATING_KINDS };
export type { Usage };
