// Verified-identity process-group signalling. Every child-group signal at
// cancel/finally/recover must re-verify retained identity (pid start + exe +
// pgid) immediately before the signal. A stored naked PGID, a spoofed
// native_pid, or a reaped/reused leader must NEVER be signalled — fail closed
// with quarantine/report instead. No test signals an unrelated process: the
// only real kills are of child processes this test spawned itself.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { makeEnv } from "./helpers.js";
import {
  procIdentity, verifyIdentity, signalVerifiedGroup, stopVerifiedGroup,
  recordChildIdentity, liveGroupMembers,
} from "../src/process/safe-spawn.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function spawnSleep(): { pid: number; kill: () => void } {
  const c = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  return { pid: c.pid!, kill: () => { try { process.kill(-c.pid!, "SIGKILL"); } catch { /* gone */ } } };
}

test("recordChildIdentity verifies lineage to the plugin process", () => {
  const mine = spawnSleep();
  try {
    // direct child of THIS test process -> descendant, identity recorded
    const id = recordChildIdentity(mine.pid, process.pid);
    assert.ok(id, "own child rejected");
    assert.equal(id!.pid, mine.pid);
    assert.equal(id!.pgid, mine.pid); // detached => own group
    assert.ok(id!.proc_start.length > 0);
    // pid 1 is never our descendant -> refused (spoofed native_pid)
    assert.equal(recordChildIdentity(1, process.pid), null);
    // our own parent is an ancestor, not a descendant -> refused
    if (process.ppid) assert.equal(recordChildIdentity(process.ppid, process.pid), null);
  } finally {
    mine.kill();
  }
});

test("signalVerifiedGroup refuses stale/missing identity without signalling", async () => {
  const mine = spawnSleep();
  const id = recordChildIdentity(mine.pid, process.pid)!;
  mine.kill();
  await sleep(150);
  const calls: number[] = [];
  const saved = process.kill;
  process.kill = ((p: number, s: string) => { calls.push(p); return true; }) as typeof process.kill;
  try {
    // leader reaped; group empty -> cannot prove group identity -> no signal
    assert.equal(signalVerifiedGroup(id, "SIGKILL"), false);
    assert.equal(calls.length, 0, "dead group was signalled");
    assert.equal(verifyIdentity(id), false);
  } finally {
    process.kill = saved;
  }
});

test("positive control: owned live group is signalled and dies", async () => {
  const mine = spawnSleep();
  try {
    const id = recordChildIdentity(mine.pid, process.pid)!;
    assert.equal(signalVerifiedGroup(id, "SIGKILL"), true);
    await sleep(150);
    assert.equal(verifyIdentity(id), false);
    assert.equal(liveGroupMembers(id.pgid).length, 0);
  } finally {
    mine.kill();
  }
});

test("stopVerifiedGroup escalates TERM->KILL on a stubborn owned group", async () => {
  // sh traps TERM and keeps running; KILL must settle it
  const c = spawn("sh", ["-c", "trap '' TERM; sleep 60"], { detached: true, stdio: "ignore" });
  const pid = c.pid!;
  try {
    const id = recordChildIdentity(pid, process.pid)!;
    const res = await stopVerifiedGroup(id, 300);
    assert.equal(res.signalled, true);
    assert.equal(res.stopped, true);
  } finally {
    try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
  }
});

// Parent reproduction: recovery must not signal a stored native pgid that has
// no retained, lineage-verified process identity.
test("recovery must not signal native PGID without retained process identity", async () => {
  const env = await makeEnv();
  const savedKill = process.kill;
  const calls: { pid: number; sig: string }[] = [];
  try {
    const { job_id } = env.stack.runtime.submit("op", { task: "no execution", role: "coding", policy: "default", workspace: { mode: "fresh" } });
    env.stack.store.createAttempt({ attempt_id: "a-test", job_id, candidate_id: "synthetic", plugin_id: "example-native", model_id: "fake-small" });
    env.stack.store.setAttemptState("a-test", "running");
    env.stack.store.setAttemptChildPgid("a-test", 99999991);
    process.kill = ((pid: number, sig: string) => { calls.push({ pid, sig }); return true; }) as typeof process.kill;
    env.stack.runtime.recoverOnStart();
    assert.equal(calls.some((c) => c.pid === -99999991), false, "unverified stored native pgid was signalled");
  } finally {
    process.kill = savedKill;
    await env.cleanup();
  }
});

test("recovery with unverifiable identity keeps capacity quarantined", async () => {
  const env = await makeEnv();
  const savedKill = process.kill;
  const calls: number[] = [];
  try {
    const { job_id } = env.stack.runtime.submit("op", { task: "x", role: "coding", policy: "default", workspace: { mode: "fresh" } });
    env.stack.store.createAttempt({ attempt_id: "a-q", job_id, candidate_id: "synthetic", plugin_id: "example-native", model_id: "fake-small" });
    env.stack.store.setAttemptState("a-q", "running");
    const res = env.stack.store.reserveCapacityMulti([{ key: "plugin:x", max: 1 }], "a-q", job_id);
    assert.ok(res);
    env.stack.store.setAttemptChildPgid("a-q", 99999992); // naked pgid: no identity
    process.kill = ((pid: number) => { calls.push(pid); return true; }) as typeof process.kill;
    env.stack.runtime.recoverOnStart();
    assert.equal(calls.includes(-99999992), false);
    // capacity was NOT released free-and-clear while descendants are unknown
    const rows = env.stack.store.reservationsForAttempt("a-q");
    assert.ok(rows.every((r) => r.state !== "released" ), "reservation released despite unknown survivors");
  } finally {
    process.kill = savedKill;
    await env.cleanup();
  }
});
