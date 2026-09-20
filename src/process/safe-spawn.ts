// Safe child-process SDK: argv-only spawn (never a shell), env allowlist,
// detached process group, bounded stdout/stderr drains, TERM->KILL escalation,
// identity-aware liveness via /proc, stubborn descendant detection.
import { spawn, ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as crypto from "node:crypto";

export interface SpawnSpec {
  executable: string; // absolute realpath-verified
  args: string[]; // passed as argv array; no shell interpolation
  cwd: string; // approved workspace dir
  env: Record<string, string>; // allowlisted env ONLY; ambient env never inherited
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

export interface ProcIdentity {
  pid: number;
  pgid: number;
  exe_realpath: string;
  proc_start: string; // /proc/<pid> stat starttime field — guards against pid reuse
}

export function procIdentity(pid: number, pgid: number): ProcIdentity | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    // field 22 = starttime; comm may contain spaces/parens -> parse after last ')'
    const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (after[0] === "Z" || after[0] === "X") return null;
    const starttime = after[19] ?? "";
    const realPgrp = Number(after[2]) || pgid; // actual process group, not assumed
    let exe = "";
    try {
      exe = fs.readlinkSync(`/proc/${pid}/exe`);
    } catch {
      exe = "";
    }
    return { pid, pgid: realPgrp, exe_realpath: exe, proc_start: starttime };
  } catch {
    return null;
  }
}

export function identityAlive(id: ProcIdentity | null | undefined): boolean {
  if (!id) return false;
  const cur = procIdentity(id.pid, id.pgid);
  if (!cur) return false;
  return cur.proc_start === id.proc_start; // same starttime => same process, not a reused pid
}

// Re-verify a recorded identity against the live process table: same pid,
// same starttime (guards pid reuse), same pgid, same exe when recorded.
export function verifyIdentity(id: ProcIdentity | null | undefined): boolean {
  if (!id) return false;
  const cur = procIdentity(id.pid, id.pgid);
  if (!cur || cur.proc_start !== id.proc_start || cur.pgid !== id.pgid) return false;
  if (id.exe_realpath && cur.exe_realpath !== id.exe_realpath) return false;
  return true;
}

// Is `pid` a live descendant of `ancestorPid`? Walks /proc ppid chain —
// a plugin-reported native_pid is only trusted after lineage is proven.
export function isDescendantOf(pid: number, ancestorPid: number, maxDepth = 16): boolean {
  let cur = pid;
  for (let i = 0; i < maxDepth; i++) {
    if (cur === ancestorPid) return true;
    try {
      const stat = fs.readFileSync(`/proc/${cur}/stat`, "utf8");
      const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ppid = Number(after[1]);
      if (!Number.isFinite(ppid) || ppid <= 1 || ppid === cur) return false;
      cur = ppid;
    } catch {
      return false;
    }
  }
  return false;
}

// Record a native child's full identity ONLY if it is a verified descendant
// of the plugin process — never trust an arbitrary plugin-reported pid.
export function recordChildIdentity(childPid: number, ancestorPid: number): ProcIdentity | null {
  if (!Number.isInteger(childPid) || childPid <= 1) return null;
  if (!isDescendantOf(childPid, ancestorPid)) return null;
  return procIdentity(childPid, childPid);
}

// Signal only while the recorded live leader still verifies. Live numeric
// group membership alone cannot prove ownership across restarts/PID reuse.
// A reaped or mismatched leader leaves survivors for recovery, not signalling.
export function signalVerifiedGroup(id: ProcIdentity | null | undefined, sig: NodeJS.Signals): boolean {
  if (!verifyIdentity(id)) return false;
  try {
    process.kill(-id!.pgid, sig);
    return true;
  } catch {
    return false;
  }
}

// Graceful verified stop: TERM -> wait -> KILL, re-verifying before each
// signal. Reports survivors rather than chasing unknown groups.
export async function stopVerifiedGroup(
  id: ProcIdentity | null | undefined,
  graceMs = 800,
): Promise<{ signalled: boolean; stopped: boolean; survivors: number[] }> {
  if (!id) return { signalled: false, stopped: true, survivors: [] };
  let signalled = signalVerifiedGroup(id, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && verifyIdentity(id)) {
    await new Promise((r) => setTimeout(r, 25));
  }
  if (verifyIdentity(id)) {
    if (signalVerifiedGroup(id, "SIGKILL")) signalled = true;
    const d2 = Date.now() + 2000;
    while (Date.now() < d2 && verifyIdentity(id)) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  const survivors = liveGroupMembers(id.pgid).filter((p) => p !== id.pid);
  return { signalled, stopped: !verifyIdentity(id) && survivors.length === 0, survivors };
}

// Live direct children of `ppid` via /proc scan. Used to snapshot plugin
// descendants BEFORE the plugin is stopped — once the plugin dies they
// reparent and lineage becomes unverifiable.
export function liveChildrenOf(ppid: number): number[] {
  const out: number[] = [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${e}/stat`, "utf8");
      const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const state = after[0];
      if (Number(after[1]) === ppid && state !== "Z" && state !== "X") out.push(Number(e));
    } catch {
      /* gone */
    }
  }
  return out;
}

// Count live descendants of pgid (excluding zombies), via /proc scan.
export function liveGroupMembers(pgid: number): number[] {
  const out: number[] = [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${e}/stat`, "utf8");
      const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const state = after[0];
      const pgrp = Number(after[2]);
      if (pgrp === pgid && state !== "Z" && state !== "X") out.push(Number(e));
    } catch {
      /* gone */
    }
  }
  return out;
}

export class SafeProcess extends EventEmitter {
  readonly child: ChildProcess;
  readonly spec: SpawnSpec;
  identity: ProcIdentity | null = null;
  stdoutBytes = 0;
  stderrBytes = 0;
  stderrTail = ""; // bounded diagnostics tail
  killedByUs = false;
  exitCode: number | null = null;
  exitSignal: NodeJS.Signals | null = null;
  private outBuf: Buffer = Buffer.alloc(0);
  private stdoutDrained: Promise<void>;
  private boundHit = false;

  constructor(spec: SpawnSpec) {
    super();
    this.spec = spec;
    this.child = spawn(spec.executable, spec.args, {
      shell: false,
      cwd: spec.cwd,
      env: spec.env, // exactly the allowlisted env — no ambient inheritance
      detached: true, // own process group on Linux
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (this.child.pid) {
      this.identity = procIdentity(this.child.pid, this.child.pid);
      if (this.identity) this.identity.pgid = this.child.pid; // detached => pgid == pid
    }
    const maxErr = spec.maxStderrBytes ?? 65536;
    const maxOut = spec.maxStdoutBytes ?? 8 * 1024 * 1024;

    // Bounded line decoder: byte caps are enforced on the raw Buffer stream
    // BEFORE a newline arrives — no unbounded readline accumulation.
    this.stdoutDrained = new Promise((resolve) => {
      this.child.stdout!.on("data", (chunk: Buffer) => {
        if (this.boundHit) return; // peer already condemned; keep draining silently
        this.stdoutBytes += chunk.length;
        this.outBuf = this.outBuf.length ? Buffer.concat([this.outBuf, chunk]) : chunk;
        const bound = (why: string) => {
          this.boundHit = true;
          this.outBuf = Buffer.alloc(0);
          this.emit("protocol_error", new Error(why));
          void this.stop("SIGKILL");
        };
        for (;;) {
          const idx = this.outBuf.indexOf(0x0a);
          if (idx < 0) {
            if (this.outBuf.length > maxOut || this.stdoutBytes > maxOut) {
              bound("stdout bound exceeded before newline");
            }
            break;
          }
          if (idx > maxOut) {
            bound("stdout frame exceeds bound");
            return;
          }
          const line = this.outBuf.subarray(0, idx).toString("utf8");
          this.outBuf = this.outBuf.subarray(idx + 1);
          if (line.length) this.emit("line", line);
        }
      });
      this.child.stdout!.on("end", () => resolve());
      this.child.stdout!.on("error", () => resolve());
    });
    this.child.stderr!.on("data", (chunk: Buffer) => {
      this.stderrBytes += chunk.length;
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-4096);
      if (this.stderrBytes > maxErr) {
        // keep draining so child can't deadlock, but stop recording
        this.emit("stderr_overflow");
      }
    });
    this.child.on("error", (err) => this.emit("spawn_error", err));
    this.child.on("exit", (code, signal) => {
      this.exitCode = code;
      this.exitSignal = signal;
      if (this.outBuf.length) {
        const rest = this.outBuf.toString("utf8");
        this.outBuf = Buffer.alloc(0);
        if (rest.length) this.emit("line", rest);
      }
      this.emit("exit", code, signal);
    });
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

  // Signal the whole process group (negative pid) through the shared
  // verified-identity helper: recorded live leader re-verified
  // immediately before the signal — a reused/reaped leader fails closed.
  signalGroup(sig: NodeJS.Signals): boolean {
    return signalVerifiedGroup(this.identity, sig);
  }

  // Graceful stop -> escalate to SIGKILL; returns when leader exits or timeout.
  async stop(escalateTo: NodeJS.Signals = "SIGKILL", graceMs = 800): Promise<void> {
    try {
      if (this.exitCode !== null || this.exitSignal !== null) return;
      this.killedByUs = true;
      this.signalGroup("SIGTERM");
      const deadline = Date.now() + graceMs;
      while (Date.now() < deadline) {
        if (this.exitCode !== null || this.exitSignal !== null) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      this.signalGroup(escalateTo);
      const d2 = Date.now() + 2000;
      while (Date.now() < d2) {
        if (this.exitCode !== null || this.exitSignal !== null) return;
        await new Promise((r) => setTimeout(r, 25));
      }
    } finally {
      // let bounded drains finish so pipes close and the child can't deadlock
      await Promise.race([this.stdoutDrained, new Promise((r) => setTimeout(r, 1500))]);
    }
  }

  // After leader exit: detect stubborn live descendants. We do NOT chase
  // unknown/reused groups — just report survivors for recovery handling.
  survivors(): number[] {
    if (!this.identity) return [];
    return liveGroupMembers(this.identity.pgid).filter((p) => p !== this.identity!.pid);
  }
}

export function sha256File(path: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex");
}
