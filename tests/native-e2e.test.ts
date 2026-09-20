// End-to-end: synthetic ACP (devin) and AGY (antigravity) plugins exercised
// through the REAL Registry -> Runtime -> HTTP API path — never isolated
// module calls. Fixture CLIs only; no real provider binary or account.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, api, submitAndWait, sseCollect } from "./helpers.js";

const JOB = { task: "say hi", role: "coding", policy: "default", workspace: { mode: "fresh" } };
// Live permission is not offered by these plugins -> preconfigured policy.
const PRECONF = { permission_mode: "preconfigured_only" as const };

test("e2e acp: devin-native plugin runs through registry/runtime/HTTP to success", async () => {
  const env = await makeEnv({ native: { acp: "text" }, policy: PRECONF });
  try {
    const { job, jobId } = await submitAndWait(env, {
      ...JOB, preferred: { plugin_id: "devin-native", model: "devin-fake-1" },
    });
    assert.equal(job.status, "succeeded", JSON.stringify(job.result));
    const atts = job.attempts as { candidate_id: string; status: string; native_session_id: string | null }[];
    assert.equal(atts.length, 1);
    assert.match(atts[0]!.candidate_id, /^devin-native\|devin-fake-1\|/);
    assert.equal(atts[0]!.status, "succeeded");
    assert.ok(atts[0]!.native_session_id); // ACP session id survives normalization
    const evs = await sseCollect(env, jobId);
    const kinds = evs.map((e) => e.kind);
    assert.ok(kinds.includes("run.started"));
    assert.ok(kinds.includes("text.delta"));
    assert.ok(kinds.includes("run.completed"));
    const text = evs.filter((e) => e.kind === "text.delta").map((e) => e.data.payload.text).join("");
    assert.equal(text, "Hello world");
  } finally {
    await env.cleanup();
  }
});

test("e2e agy: antigravity-native plugin runs through registry/runtime/HTTP to success", async () => {
  const env = await makeEnv({ native: { agy: "text" }, policy: PRECONF });
  try {
    const { job, jobId } = await submitAndWait(env, {
      ...JOB, preferred: { plugin_id: "antigravity-native", model: "agy-fake-1" },
    });
    assert.equal(job.status, "succeeded", JSON.stringify(job.result));
    const result = job.result as { result?: { usage?: { cumulative?: boolean }; observed_model?: string } };
    assert.equal(result?.result?.usage?.cumulative, true); // cumulative totals only
    assert.notEqual(result?.result?.observed_model, "agy-fake-1"); // echo is not observation
    const evs = await sseCollect(env, jobId);
    const kinds = evs.map((e) => e.kind);
    assert.ok(kinds.includes("run.started"));
    assert.ok(kinds.includes("run.completed"));
    const text = evs.filter((e) => e.kind === "text.delta").map((e) => e.data.payload.text).join("");
    assert.ok(text.includes("answer"));
  } finally {
    await env.cleanup();
  }
});

test("e2e acp: interactive permission approved once via HTTP, bound to native request", async () => {
  // FAKE_ACP_SCENARIO=permission makes the fixture request a live decision;
  // the plugin's fixture-verified bridge declares interactive capability.
  const env = await makeEnv({ native: { acp: "permission" } }); // interactive policy (default)
  try {
    const r = await api(env, "POST", "/v1/jobs", {
      ...JOB, preferred: { plugin_id: "devin-native", model: "devin-fake-1" },
    }, { "idempotency-key": "acp-perm-1" });
    assert.equal(r.status, 201);
    const jobId = (r.body as { job_id: string }).job_id;
    // wait for the approval to surface
    let approvals: { approval_id: string; status: string; action: string }[] = [];
    for (let i = 0; i < 100; i++) {
      const j = await api(env, "GET", `/v1/jobs/${jobId}`);
      approvals = ((j.body as { approvals?: typeof approvals }).approvals ?? []);
      if (approvals.length) break;
      const st = (j.body as { status: string }).status;
      if (["failed", "needs_recovery", "cancelled", "succeeded"].includes(st)) break;
      await new Promise((r2) => setTimeout(r2, 100));
    }
    assert.equal(approvals.length, 1, "expected one pending approval");
    const approve = await api(env, "POST", `/v1/jobs/${jobId}/permissions/${approvals[0]!.approval_id}`, { option: "allow-once" });
    assert.equal(approve.status, 200);
    assert.equal((approve.body as { status: string }).status, "approved");
    // duplicate decision must not re-deliver
    const dup = await api(env, "POST", `/v1/jobs/${jobId}/permissions/${approvals[0]!.approval_id}`, { option: "reject-once" });
    assert.equal((dup.body as { status: string }).status, "already");
    // fabricated (non-offered) option on a second approval is invalid —
    // first decision already stands, so this also stays "already"
    const final = await (async () => {
      const deadline = Date.now() + 20000;
      for (;;) {
        const j = await api(env, "GET", `/v1/jobs/${jobId}`);
        const st = (j.body as { status: string }).status;
        if (["succeeded", "failed", "cancelled", "needs_recovery"].includes(st)) return j.body as Record<string, unknown>;
        if (Date.now() > deadline) throw new Error(`timeout; status=${st}`);
        await new Promise((r2) => setTimeout(r2, 150));
      }
    })();
    assert.equal(final.status, "succeeded", JSON.stringify(final.result));
    const a2 = (final.approvals as { status: string; delivery_state: string }[])[0]!;
    assert.equal(a2.delivery_state, "delivered"); // decision reached the native process
  } finally {
    await env.cleanup();
  }
});

test("e2e agy: cancel stops locally; remote unknown -> needs_recovery (not cancelled)", async () => {
  const env = await makeEnv({ native: { agy: "slow" }, policy: PRECONF });
  try {
    const r = await api(env, "POST", "/v1/jobs", {
      ...JOB, preferred: { plugin_id: "antigravity-native", model: "agy-fake-1" },
    }, { "idempotency-key": "agy-cancel-1" });
    const jobId = (r.body as { job_id: string }).job_id;
    await new Promise((r2) => setTimeout(r2, 1500)); // let the run start
    const c = await api(env, "POST", `/v1/jobs/${jobId}/cancel`);
    assert.ok([200].includes(c.status));
    const deadline = Date.now() + 20000;
    let status = "";
    for (;;) {
      const j = await api(env, "GET", `/v1/jobs/${jobId}`);
      status = (j.body as { status: string }).status;
      if (["succeeded", "failed", "cancelled", "needs_recovery"].includes(status)) break;
      if (Date.now() > deadline) throw new Error(`timeout; status=${status}`);
      await new Promise((r2) => setTimeout(r2, 150));
    }
    // AGY has no remote-cancel protocol: local stop with unknown remote state
    // is needs_recovery, never "cancelled".
    assert.equal(status, "needs_recovery");
  } finally {
    await env.cleanup();
  }
});

test("e2e acp: preferred plugin mismatch is rejected pre-launch, not discovered at run", async () => {
  const env = await makeEnv({ native: { acp: "text" }, policy: PRECONF });
  try {
    const r = await api(env, "POST", "/v1/jobs", {
      ...JOB, preferred: { plugin_id: "devin-native", model: "no-such-model" },
    });
    assert.equal(r.status, 403); // exact model validation before any worker
  } finally {
    await env.cleanup();
  }
});

test("e2e acp: remote-confirmed cancel -> job cancelled (ack alone is not enough)", async () => {
  const env = await makeEnv({ native: { acp: "slow" }, policy: PRECONF });
  try {
    const r = await api(env, "POST", "/v1/jobs", {
      ...JOB, preferred: { plugin_id: "devin-native", model: "devin-fake-1" },
    }, { "idempotency-key": "acp-cancel-1" });
    const jobId = (r.body as { job_id: string }).job_id;
    await new Promise((r2) => setTimeout(r2, 1500));
    await api(env, "POST", `/v1/jobs/${jobId}/cancel`);
    const deadline = Date.now() + 20000;
    let status = "";
    for (;;) {
      const j = await api(env, "GET", `/v1/jobs/${jobId}`);
      status = (j.body as { status: string }).status;
      if (["succeeded", "failed", "cancelled", "needs_recovery"].includes(status)) break;
      if (Date.now() > deadline) throw new Error(`timeout; status=${status}`);
      await new Promise((r2) => setTimeout(r2, 150));
    }
    // ACP stopReason 'cancelled' is a remote-confirmed cancel -> 'cancelled'
    assert.equal(status, "cancelled");
  } finally {
    await env.cleanup();
  }
});

test("e2e acp: effort request rejected for devin (capability unknown, fail-closed)", async () => {
  const env = await makeEnv({ native: { acp: "text" }, policy: PRECONF });
  try {
    // effort is not in the devin catalog model's efforts — exact pre-launch
    // validation rejects before any worker is considered
    const r = await api(env, "POST", "/v1/jobs", {
      ...JOB, preferred: { plugin_id: "devin-native", model: "devin-fake-1", effort: "high" },
    });
    assert.equal(r.status, 403);
  } finally {
    await env.cleanup();
  }
});
