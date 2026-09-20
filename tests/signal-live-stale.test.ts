// No real signal is sent. A live numeric PGID does NOT prove that a stored
// identity still owns it: it may now belong to a different process generation.
import test from "node:test";
import assert from "node:assert/strict";
import { procIdentity, signalVerifiedGroup, liveGroupMembers } from "../src/process/safe-spawn.js";

test("live group membership cannot override a stale stored leader identity", () => {
  const actual = procIdentity(process.pid, process.pid)!;
  assert.ok(actual);
  assert.ok(liveGroupMembers(actual.pgid).length > 0);
  const saved = process.kill;
  const signals: number[] = [];
  process.kill = ((pid: number) => { signals.push(pid); return true; }) as typeof process.kill;
  try {
    assert.equal(signalVerifiedGroup({ ...actual, proc_start: "not-this-process-generation" }, "SIGKILL"), false);
    assert.equal(signals.length, 0, "stale identity targeted a live unrelated process group");
    assert.equal(signalVerifiedGroup({ ...actual, exe_realpath: "/not/the/recorded/executable" }, "SIGTERM"), false);
    assert.equal(signals.length, 0);
    assert.equal(signalVerifiedGroup(actual, "SIGTERM"), true, "verified live positive control refused");
    assert.deepEqual(signals, [-actual.pgid]);
  } finally {
    process.kill = saved;
  }
});
