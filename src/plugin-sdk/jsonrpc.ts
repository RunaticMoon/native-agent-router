// Language-independent JSON-RPC 2.0 over stdio JSONL.
// stdout carries ONLY protocol frames; stderr is bounded diagnostics.
import { SafeProcess, SpawnSpec } from "../process/safe-spawn.js";
import { randomUUID } from "node:crypto";

export const MAX_FRAME_BYTES = 1024 * 1024;

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export class RpcError extends Error {
  code: number;
  data?: unknown;
  constructor(e: JsonRpcError) {
    super(e.message);
    this.code = e.code;
    this.data = e.data;
  }
}

export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
} as const;

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

// ---------- host side: router talks TO a plugin process ----------
export class PluginClient {
  readonly proc: SafeProcess;
  private pending = new Map<string, Pending>();
  private notifyHandlers = new Map<string, (p: unknown) => void>();
  private buf = "";
  closed = false;
  protocolError: string | null = null;

  constructor(spec: SpawnSpec) {
    this.proc = new SafeProcess(spec);
    this.proc.on("line", (line) => this.onLine(line));
    this.proc.on("protocol_error", (e) => {
      this.protocolError = String(e);
      this.failAll(new Error("plugin stdout bound exceeded"));
    });
    this.proc.on("exit", () => {
      this.closed = true;
      this.failAll(new Error("plugin exited"));
      this.emitExit();
    });
    this.proc.on("spawn_error", (e) => {
      this.closed = true;
      this.failAll(e as Error);
    });
  }
  private exitHandlers: (() => void)[] = [];
  onExit(fn: () => void) {
    this.exitHandlers.push(fn);
  }
  private emitExit() {
    for (const f of this.exitHandlers) f();
  }

  onNotification(method: string, fn: (params: unknown) => void) {
    this.notifyHandlers.set(method, fn);
  }

  private failAll(err: Error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private onLine(line: string) {
    if (Buffer.byteLength(line) > MAX_FRAME_BYTES) {
      this.protocolError = "frame too large";
      this.proc.stop("SIGKILL");
      return;
    }
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      this.protocolError = `malformed JSONL frame: ${line.slice(0, 80)}`;
      this.proc.stop("SIGKILL");
      return;
    }
    // null / array / scalar frames are not valid JSON-RPC envelopes —
    // strict malformed handling, never silently ignored.
    if (msg == null || typeof msg !== "object" || Array.isArray(msg)) {
      this.protocolError = "invalid frame: expected object envelope";
      this.proc.stop("SIGKILL");
      return;
    }
    if (msg.jsonrpc !== "2.0") {
      this.protocolError = "missing jsonrpc=2.0";
      this.proc.stop("SIGKILL");
      return;
    }
    if ("id" in msg && ("result" in msg || "error" in msg)) {
      const id = String(msg.id);
      const p = this.pending.get(id);
      if (!p) return; // stale/unknown id — refuse silently
      this.pending.delete(id);
      clearTimeout(p.timer);
      if ("error" in msg && msg.error) p.reject(new RpcError(msg.error as JsonRpcError));
      else p.resolve(msg.result);
      return;
    }
    if ("method" in msg && !("id" in msg)) {
      const h = this.notifyHandlers.get(String(msg.method));
      if (h) h(msg.params);
      return;
    }
    // Requests from plugin are not part of this protocol revision.
  }

  async call<T>(method: string, params: unknown, timeoutMs = 30000): Promise<T> {
    if (this.closed) throw new Error("plugin closed");
    const id = randomUUID();
    const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) throw new Error("frame too large");
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError({ code: RPC.INTERNAL, message: `rpc timeout: ${method}` }));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.proc.writeLine(frame).catch((e) => {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  async stop() {
    this.failAll(new Error("client stopping"));
    await this.proc.stop("SIGKILL");
  }
}

// ---------- plugin side: a plugin implements handlers ----------
type Handler = (params: unknown) => Promise<unknown> | unknown;

export class PluginServer {
  private handlers = new Map<string, Handler>();
  private buf = "";
  constructor(
    private input: NodeJS.ReadableStream = process.stdin,
    private output: NodeJS.WritableStream = process.stdout,
  ) {}

  method(name: string, fn: Handler) {
    this.handlers.set(name, fn);
  }

  notify(method: string, params: unknown) {
    const frame = JSON.stringify({ jsonrpc: "2.0", method, params });
    if (Buffer.byteLength(frame) <= MAX_FRAME_BYTES) {
      this.output.write(frame + "\n");
    }
  }

  private respond(id: unknown, result?: unknown, error?: JsonRpcError) {
    const msg: Record<string, unknown> = { jsonrpc: "2.0", id };
    if (error) msg.error = error;
    else msg.result = result ?? null;
    this.output.write(JSON.stringify(msg) + "\n");
  }

  start() {
    this.input.setEncoding("utf8");
    this.input.on("data", (chunk: string) => {
      this.buf += chunk;
      let idx;
      while ((idx = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 1);
        if (line.length) void this.handleFrame(line);
      }
      if (this.buf.length > MAX_FRAME_BYTES) {
        // oversized unterminated frame — protocol violation
        this.buf = "";
        process.exit(2);
      }
    });
  }

  private async handleFrame(line: string) {
    if (Buffer.byteLength(line) > MAX_FRAME_BYTES) {
      this.respond(null, undefined, { code: RPC.INVALID_REQUEST, message: "frame too large" });
      return;
    }
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      this.respond(null, undefined, { code: RPC.PARSE_ERROR, message: "malformed JSON" });
      return;
    }
    if (msg == null || typeof msg !== "object" || Array.isArray(msg)) {
      this.respond(null, undefined, { code: RPC.INVALID_REQUEST, message: "expected object envelope" });
      return;
    }
    if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string" || !("id" in msg)) {
      this.respond(msg.id ?? null, undefined, {
        code: RPC.INVALID_REQUEST,
        message: "expected request with id",
      });
      return;
    }
    const h = this.handlers.get(msg.method);
    if (!h) {
      this.respond(msg.id, undefined, { code: RPC.METHOD_NOT_FOUND, message: msg.method });
      return;
    }
    try {
      const result = await h(msg.params);
      this.respond(msg.id, result);
    } catch (e) {
      if (e instanceof RpcError) this.respond(msg.id, undefined, { code: e.code, message: e.message, data: e.data });
      else this.respond(msg.id, undefined, { code: RPC.INTERNAL, message: String(e) });
    }
  }
}
