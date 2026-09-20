// Wire process abstraction + bounded NDJSON line decoder.
// Byte caps are enforced on the raw Buffer stream BEFORE a newline arrives —
// no readline-style unbounded accumulation. ChildWireProcess mirrors main
// src/process/safe-spawn.ts semantics (argv-only spawn, detached group,
// TERM->KILL, /proc identity liveness, survivors reported not chased).
import { spawn, ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import {
  procIdentity, verifyIdentity, identityAlive, liveGroupMembers,
  signalVerifiedGroup, ProcIdentity,
} from "../process/safe-spawn.js";

export { procIdentity, verifyIdentity, identityAlive, liveGroupMembers, signalVerifiedGroup };
export type { ProcIdentity };

export const MAX_LINE_BYTES = 1024 * 1024; // 1 MiB single frame cap
export const MAX_TOTAL_STDOUT = 16 * 1024 * 1024;

export class ProtocolBoundError extends Error {}

// Incremental decoder: push raw Buffers, get complete lines back.
// Throws ProtocolBoundError if a single unterminated line or the total
// stream exceeds bounds — the caller must then kill the peer.
export class LineDecoder {
  private buf: Buffer = Buffer.alloc(0);
  private total = 0;
  constructor(
    private maxLine = MAX_LINE_BYTES,
    private maxTotal = MAX_TOTAL_STDOUT,
  ) {}
  push(chunk: Buffer): string[] {
    this.total += chunk.length;
    if (this.total > this.maxTotal) throw new ProtocolBoundError("stdout byte cap exceeded");
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: string[] = [];
    for (;;) {
      const idx = this.buf.indexOf(0x0a);
      if (idx < 0) {
        if (this.buf.length > this.maxLine) throw new ProtocolBoundError("unterminated frame exceeds cap");
        return out;
      }
      if (idx > this.maxLine) throw new ProtocolBoundError("frame exceeds cap");
      out.push(this.buf.subarray(0, idx).toString("utf8"));
      this.buf = this.buf.subarray(idx + 1);
    }
  }
  flush(): string | null {
    const rest = this.buf.length ? this.buf.toString("utf8") : null;
    this.buf = Buffer.alloc(0);
    return rest;
  }
}

export interface SpawnSpec {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>; // allowlisted ONLY — never ambient
  maxStderrBytes?: number;
}

// Events: 'line'(string), 'stderr_chunk'(string), 'protocol_error'(Error),
// 'spawn_error'(Error), 'exit'(code, signal)
export abstract class WireProcess extends EventEmitter {
  identity: ProcIdentity | null = null;
  killedByUs = false;
  exitCode: number | null = null;
  exitSignal: NodeJS.Signals | null = null;
  stderrTail = "";
  abstract writeLine(line: string, deadlineMs?: number): Promise<void>;
  abstract closeStdin(): void;
  abstract stop(escalateTo?: NodeJS.Signals, graceMs?: number): Promise<void>;
  abstract survivors(): number[];
}

export class ChildWireProcess extends WireProcess {
  readonly child: ChildProcess;
  private decoder = new LineDecoder();
  private drained: Promise<void>;

  constructor(readonly spec: SpawnSpec) {
    super();
    this.child = spawn(spec.executable, spec.args, {
      shell: false,
      cwd: spec.cwd,
      env: spec.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (this.child.pid) this.identity = procIdentity(this.child.pid, this.child.pid);
    const maxErr = spec.maxStderrBytes ?? 65536;
    let errBytes = 0;
    this.drained = new Promise((resolve) => {
      this.child.stdout!.on("data", (chunk: Buffer) => {
        let lines: string[];
        try {
          lines = this.decoder.push(chunk);
        } catch (e) {
          this.emit("protocol_error", e);
          void this.stop("SIGKILL");
          return;
        }
        for (const l of lines) if (l.length) this.emit("line", l);
      });
      this.child.stderr!.on("data", (chunk: Buffer) => {
        errBytes += chunk.length;
        this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-4096);
        // keep draining regardless of cap so the child cannot deadlock
        if (errBytes > maxErr) this.emit("stderr_overflow");
        this.emit("stderr_chunk", chunk.toString("utf8"));
      });
      this.child.on("exit", (code, signal) => {
        this.exitCode = code;
        this.exitSignal = signal;
        const rest = this.decoder.flush();
        if (rest && rest.length) this.emit("line", rest);
        this.emit("exit", code, signal);
        resolve();
      });
    });
    this.child.on("error", (err) => this.emit("spawn_error", err));
  }

  writeLine(line: string, deadlineMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const stdin = this.child.stdin;
      if (!stdin || stdin.destroyed) return reject(new Error("stdin closed"));
      const timer = setTimeout(() => reject(new Error("stdin write deadline")), deadlineMs);
      stdin.write(line + "\n", (err) => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      });
    });
  }

  closeStdin(): void {
    try {
      this.child.stdin?.end();
    } catch {
      /* ignore */
    }
  }

  signalGroup(sig: NodeJS.Signals): boolean {
    return signalVerifiedGroup(this.identity, sig);
  }

  async stop(escalateTo: NodeJS.Signals = "SIGKILL", graceMs = 800): Promise<void> {
    if (this.exitCode !== null || this.exitSignal !== null) return;
    this.killedByUs = true;
    this.signalGroup("SIGTERM");
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
      if (this.exitCode !== null || this.exitSignal !== null) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    if (this.exitCode === null && this.exitSignal === null) {
      this.signalGroup(escalateTo);
      const d2 = Date.now() + 2000;
      while (Date.now() < d2) {
        if (this.exitCode !== null || this.exitSignal !== null) break;
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    await Promise.race([this.drained, new Promise((r) => setTimeout(r, 1500))]);
  }

  // Stubborn descendants are reported for recovery handling — we never chase
  // or signal unknown/reused groups.
  survivors(): number[] {
    if (!this.identity) return [];
    return liveGroupMembers(this.identity.pgid).filter((p) => p !== this.identity!.pid);
  }
}

export function sha256File(path: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex");
}
