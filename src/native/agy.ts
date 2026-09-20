// Antigravity (agy) stream-json client. One turn per process:
//   argv = [exe, --input-format stream-json --output-format stream-json,
//           --model <exact-slug>] (+ --effort only when explicitly requested)
// The prompt is a stdin `user` event; stdin is closed after that single turn.
// Top-level discriminator is `event`: init / step_update / result.
// Only step_type 'agent_response' text_delta is answer text — planning,
// thinking, checkpoint and user_input steps are never emitted as text.
// result.usage is CUMULATIVE session usage (never re-summed with step usage).
// init.model is a requested-override echo, NOT proof of the serving model.
// A structured tool error or ambiguous stderr diagnostics downgrade a
// SUCCESS result to partial — exit 0 is never asserted as task verification.
// Realtime approval is NOT supported by this stream (control_request /
// control_response are rejected by the CLI): permission = preconfigured_only.
import { WireProcess, MAX_LINE_BYTES } from "./wire.js";
import { NativeError, RunResult, Usage } from "./types.js";

export interface AgyEventHandlers {
  onText(text: string): void;
  onToolStarted(tool: string, callId: string): void;
  onToolCompleted(tool: string, callId: string, status: "ok" | "error" | "denied"): void;
  onUsage(u: Usage): void;
}

export interface AgyRunOutcome {
  result: RunResult;
  conversationId?: string;
  permissionMode?: string;
  requestedModelEcho?: string;
  stderrTail: string;
}

const RESULT_STATUSES = new Set(["SUCCESS", "ERROR", "CANCELED", "INTERRUPTED", "INVALID", "WAITING", "RUNNING"]);

export class AgyStreamClient {
  private resultEvent: Record<string, unknown> | null = null;
  private initEvent: Record<string, unknown> | null = null;
  private sawMalformed = false;
  private sawStderr = false;
  private toolError = false;
  private anyTool = false;
  private responseParts: string[] = [];
  private done = false;
  private seenToolStarts = new Set<number>();

  constructor(
    readonly proc: WireProcess,
    private handlers: AgyEventHandlers,
  ) {
    proc.on("line", (l) => this.onLine(l));
    proc.on("stderr_chunk", () => {
      this.sawStderr = true;
    });
    proc.on("protocol_error", () => {
      this.sawMalformed = true;
    });
  }

  private onLine(line: string) {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      this.sawMalformed = true;
      return;
    }
    if (!msg || typeof msg !== "object" || typeof msg.event !== "string") {
      this.sawMalformed = true;
      return;
    }
    switch (msg.event) {
      case "init": {
        if (this.initEvent) {
          this.sawMalformed = true; // init is emitted exactly once
          return;
        }
        this.initEvent = msg;
        break;
      }
      case "step_update":
        this.onStep(msg.step_update as Record<string, unknown> | undefined);
        break;
      case "result":
        if (this.resultEvent) {
          this.sawMalformed = true;
          return;
        }
        this.resultEvent = (msg.result ?? null) as Record<string, unknown> | null;
        this.done = true;
        break;
      default:
        break; // forward-compatible: unrecognized events skipped
    }
  }

  private onStep(s: Record<string, unknown> | undefined) {
    if (!s || typeof s !== "object") return;
    const stepType = String(s.step_type ?? "");
    const state = String(s.state ?? "");
    if (stepType === "agent_response") {
      if (typeof s.text_delta === "string" && s.text_delta.length) {
        this.responseParts.push(s.text_delta);
        this.handlers.onText(s.text_delta);
      }
      return;
    }
    if (stepType === "tool") {
      this.anyTool = true;
      const idx = Number(s.step_index ?? -1);
      const name = String(s.tool_name ?? (s.tool_info as Record<string, unknown> | undefined)?.name ?? "tool");
      const info = s.tool_info as Record<string, unknown> | undefined;
      const callId = `${idx >= 0 ? idx : "x"}:${name}`;
      if (state === "ACTIVE" && !this.seenToolStarts.has(idx)) {
        this.seenToolStarts.add(idx);
        this.handlers.onToolStarted(name, callId);
      }
      if (state === "DONE") {
        const hasErr = !!(info && typeof info.error === "object" && info.error !== null);
        if (hasErr) this.toolError = true;
        this.handlers.onToolCompleted(name, callId, hasErr ? "error" : "ok");
      }
      return;
    }
    // user_input / checkpoint / planning / thinking / subagent steps:
    // observations only, NEVER text.
  }

  async run(task: string, deadlineMs: number): Promise<AgyRunOutcome> {
    const frame = JSON.stringify({ event: "user", message: { content: task } });
    if (Buffer.byteLength(frame) > MAX_LINE_BYTES) throw new Error("prompt frame too large");
    await this.proc.writeLine(frame);
    this.proc.closeStdin(); // exactly one turn per process

    const deadline = Date.now() + deadlineMs;
    let exited = false;
    this.proc.on("exit", () => {
      exited = true;
    });
    while (!this.done && !exited && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15));
    }

    const init = (this.initEvent?.init ?? {}) as Record<string, unknown>;
    const conversationId = String(this.initEvent?.conversation_id ?? "") || undefined;
    const requestedModelEcho = typeof init.model === "string" ? init.model : undefined;
    const permissionMode = typeof init.permission_mode === "string" ? init.permission_mode : undefined;
    const stderrTail = this.proc.stderrTail;

    const finish = (result: RunResult): AgyRunOutcome => ({
      result,
      ...(conversationId ? { conversationId } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      ...(requestedModelEcho ? { requestedModelEcho } : {}),
      stderrTail,
    });

    if (!this.done && !exited) {
      // deadline: local stop only; remote outcome unknown — recovery, not success
      await this.proc.stop();
      return finish({
        outcome: "failed",
        status: "unknown",
        ...(conversationId ? { native_session_id: conversationId } : {}),
        side_effects: this.anyTool ? "unknown" : "none",
        retry_safety: "unknown",
        error: { code: "TIMEOUT", message: "agy run deadline exceeded; remote outcome unknown", phase: "run", retry_safety: "unknown" },
      });
    }

    const res = this.resultEvent;
    if (!res) {
      // local stop is not remote cancellation — outcome stays unconfirmed
      if (this.proc.killedByUs) {
        return finish({
          outcome: "cancelled",
          status: "unknown",
          ...(conversationId ? { native_session_id: conversationId } : {}),
          side_effects: this.anyTool ? "unknown" : "none",
          retry_safety: "unknown",
          cancel_confirmed: false,
        });
      }
      // no terminal result event: never assert success
      return finish({
        outcome: "failed",
        status: "unknown",
        ...(conversationId ? { native_session_id: conversationId } : {}),
        side_effects: this.anyTool ? "unknown" : "none",
        retry_safety: "unknown",
        error: {
          code: this.sawMalformed ? "INVALID_OUTPUT" : "UNKNOWN_NATIVE_OUTCOME",
          message: this.sawMalformed ? "malformed stream frames observed" : "stream ended without result event",
          phase: "run",
          retry_safety: "unknown",
        },
      });
    }

    const status = String(res.status ?? "");
    const usageRaw = res.usage as Record<string, unknown> | undefined;
    const usage: Usage | undefined = usageRaw
      ? {
          ...(typeof usageRaw.input_tokens === "number" ? { input_tokens: usageRaw.input_tokens } : {}),
          ...(typeof usageRaw.output_tokens === "number" ? { output_tokens: usageRaw.output_tokens } : {}),
          cumulative: true, // result.usage is cumulative for the session
        }
      : undefined;
    if (usage) this.handlers.onUsage(usage);

    const responseText = this.responseParts.length
      ? this.responseParts.join("")
      : typeof res.response === "string"
        ? res.response
        : undefined;
    const sideEffects: "none" | "unknown" = this.anyTool ? "unknown" : "none"; // tool side effects unverifiable
    const base = {
      ...(conversationId ? { native_session_id: conversationId } : {}),
      side_effects: sideEffects,
      ...(usage ? { usage } : {}),
      ...(responseText !== undefined ? { response_text: responseText } : {}),
    };
    // ambiguous diagnostics / malformed frames mean SUCCESS is not proven clean
    const degraded = this.toolError || this.sawStderr || this.sawMalformed;

    if (status === "SUCCESS") {
      return finish({
        ...base,
        outcome: "completed",
        status: degraded ? (responseText ? "partial" : "blocked") : "completed",
        retry_safety: this.anyTool ? "unknown" : "unknown",
      });
    }
    if (status === "CANCELED" || status === "INTERRUPTED") {
      return finish({
        ...base,
        outcome: "cancelled",
        retry_safety: this.anyTool ? "unsafe" : "unknown",
        cancel_confirmed: true, // terminal event observed
      });
    }
    if (status === "ERROR") {
      return finish({
        ...base,
        outcome: "failed",
        status: "unknown",
        retry_safety: "unknown",
        // no substring classification of error text into auth/quota/etc.
        error: { code: "UNKNOWN_NATIVE_OUTCOME", message: String(res.error ?? "agy ERROR status").slice(0, 2000), phase: "run", retry_safety: "unknown" },
      });
    }
    // WAITING / RUNNING / INVALID / unrecognized -> safe non-success outcome
    return finish({
      ...base,
      outcome: "failed",
      status: "unknown",
      retry_safety: "unknown",
      error: {
        code: RESULT_STATUSES.has(status) ? "UNKNOWN_NATIVE_OUTCOME" : "INVALID_OUTPUT",
        message: `terminal status ${status || "<missing>"} is not a completed outcome`,
        phase: "run",
        retry_safety: "unknown",
      },
    });
  }
}

// argv is constructed exactly — prompt is NEVER a shell string / argv member.
export function agyArgs(executableModel: string, effort?: string): string[] {
  const args = ["--input-format", "stream-json", "--output-format", "stream-json", "--model", executableModel];
  if (effort) args.push("--effort", effort);
  return args;
}
