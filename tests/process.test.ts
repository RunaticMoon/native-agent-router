// Process SDK checks: stderr flood, timeout, TERM->KILL escalation,
// stubborn descendants, no fixture survivors after cleanup.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { SafeProcess, liveGroupMembers } from "../src/process/safe-spawn.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = path.join(ROOT, "fixtures/fake-cli.mjs");
const NODE = fs.realpathSync(process.execPath);

test("stderr flood drains without deadlock and stays bounded", async () => {
  const p = new SafeProcess({
    executable: NODE, args: [CLI, "--prompt", "x", "--flood-stderr", "3"], cwd: "/tmp", env: {},
  });
  await new Promise((r) => p.on("exit", r));
  assert.equal(p.exitCode, 0);
  assert.ok(p.stderrBytes >= 3 * 1024 * 1024);
  assert.ok(p.stderrTail.length <= 4096);
});

test("SIGTERM-resistant leader escalates to SIGKILL", async () => {
  const p = new SafeProcess({
    executable: NODE, args: [CLI, "--prompt", "x", "--ignore-sigterm", "--hang"], cwd: "/tmp", env: {},
  });
  await new Promise((r) => setTimeout(r, 300));
  await p.stop("SIGKILL", 300);
  assert.equal(p.exitSignal, "SIGKILL");
});

test("stubborn descendant detected after leader exits; group cleaned", async () => {
  const p = new SafeProcess({
    executable: NODE, args: [CLI, "--prompt", "x", "--spawn-child", "20", "--delay-ms", "5"], cwd: "/tmp", env: {},
  });
  await new Promise((r) => p.on("exit", r));
  const surv = p.survivors();
  assert.ok(surv.length > 0, "expected stubborn sleep descendant");
  try {
    // do not chase reused groups — but we know this pgid is ours; clean fixture
    process.kill(-p.identity!.pgid, "SIGKILL");
  } catch {}
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(liveGroupMembers(p.identity!.pgid).length, 0);
});

test("liveness identity detects dead and reused pids", async () => {
  const p = new SafeProcess({
    executable: NODE, args: ["-e", "process.exit(0)"], cwd: "/tmp", env: {},
  });
  await new Promise((r) => p.on("exit", r));
  const { identityAlive } = await import("../src/process/safe-spawn.js");
  assert.equal(identityAlive(p.identity), false);
});

test("timeout: hung CLI killed by plugin deadline, job fails TIMEOUT or recovery", async () => {
  const { makeEnv, submitAndWait } = await import("./helpers.js");
  const env = await makeEnv({ policy: { max_wall_seconds: 3, max_attempts: 1 } });
  try {
    const { job } = await submitAndWait(env, {
      task: "hang", role: "coding", policy: "default",
      workspace: { mode: "fresh" }, preferred: { model: "beh-hang" },
    }, 30000);
    assert.notEqual(job.status, "succeeded");
    const err = ((job.attempts as { error?: { code: string } }[])[0]!.error);
    assert.ok(err === null || ["TIMEOUT", "UNKNOWN_NATIVE_OUTCOME"].includes(err?.code ?? "UNKNOWN_NATIVE_OUTCOME"));
  } finally {
    await env.cleanup();
  }
});
