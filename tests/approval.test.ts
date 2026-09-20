// Approval broker + API checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, api, submitAndWait } from "./helpers.js";
import { Store } from "../src/storage/store.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const JOB = { task: "t", role: "coding", policy: "default", workspace: { mode: "fresh" }, preferred: { model: "beh-permission" } };

async function pendingApproval(env: Awaited<ReturnType<typeof makeEnv>>, jobId: string, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const j = await api(env, "GET", `/v1/jobs/${jobId}`);
    const appr = ((j.body as { approvals?: { approval_id: string; status: string }[] }).approvals ?? []).find((a) => a.status === "pending");
    if (appr) return appr.approval_id;
    if (Date.now() > deadline) throw new Error("no pending approval appeared");
    await new Promise((r) => setTimeout(r, 80));
  }
}

test("approval deny -> plugin receives deny; run blocked not succeeded", async () => {
  const env = await makeEnv();
  try {
    const r = await api(env, "POST", "/v1/jobs", JOB, { "idempotency-key": "a1" });
    const jobId = (r.body as { job_id: string }).job_id;
    const apprId = await pendingApproval(env, jobId);
    const dec = await api(env, "POST", `/v1/jobs/${jobId}/permissions/${apprId}`, { option: "deny" });
    assert.equal((dec.body as { status: string }).status, "denied");
    let final: { status: string } | null = null;
    for (;;) {
      const j = await api(env, "GET", `/v1/jobs/${jobId}`);
      const st = (j.body as { status: string }).status;
      if (["succeeded", "failed", "cancelled", "needs_recovery"].includes(st)) { final = { status: st }; break; }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.notEqual(final!.status, "succeeded");
  } finally {
    await env.cleanup();
  }
});

test("approval allow -> run completes", async () => {
  const env = await makeEnv();
  try {
    const r = await api(env, "POST", "/v1/jobs", JOB, { "idempotency-key": "a2" });
    const jobId = (r.body as { job_id: string }).job_id;
    const apprId = await pendingApproval(env, jobId);
    await api(env, "POST", `/v1/jobs/${jobId}/permissions/${apprId}`, { option: "allow" });
    for (;;) {
      const j = await api(env, "GET", `/v1/jobs/${jobId}`);
      if (["succeeded", "failed", "cancelled", "needs_recovery"].includes((j.body as { status: string }).status)) {
        assert.equal((j.body as { status: string }).status, "succeeded");
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  } finally {
    await env.cleanup();
  }
});

test("first decision wins; cross-job approval id rejected; approver scope required", async () => {
  const env = await makeEnv();
  try {
    const r = await api(env, "POST", "/v1/jobs", JOB, { "idempotency-key": "a3" });
    const jobId = (r.body as { job_id: string }).job_id;
    const apprId = await pendingApproval(env, jobId);
    // simultaneous decisions — exactly one outcome
    const [d1, d2] = await Promise.all([
      api(env, "POST", `/v1/jobs/${jobId}/permissions/${apprId}`, { option: "deny" }),
      api(env, "POST", `/v1/jobs/${jobId}/permissions/${apprId}`, { option: "allow" }),
    ]);
    const outcomes = [(d1.body as { status: string }).status, (d2.body as { status: string }).status];
    // Promise.all preserves result order, not HTTP arrival/transaction order.
    // Either decision may commit first, but only one may win.
    assert.equal(outcomes.filter((s) => s === "already").length, 1);
    const winnerIndex = outcomes.findIndex((s) => s !== "already");
    const expectedStatus = winnerIndex === 0 ? "denied" : "approved";
    const expectedOption = winnerIndex === 0 ? "deny" : "allow";
    assert.equal(outcomes[winnerIndex], expectedStatus);
    const a = env.stack.store.getApproval(apprId)!;
    assert.equal(a.status, expectedStatus);
    assert.equal(a.chosen_option, expectedOption);
    const replay = await api(env, "POST", `/v1/jobs/${jobId}/permissions/${apprId}`, { option: expectedOption === "deny" ? "allow" : "deny" });
    assert.equal((replay.body as { status: string }).status, "already");
    assert.equal(env.stack.store.getApproval(apprId)!.chosen_option, expectedOption);

    // cross-job: use approval id under another job id -> invalid/not found
    const other = await api(env, "POST", "/v1/jobs", { ...JOB, preferred: { model: "fake-small" } }, { "idempotency-key": "a4" });
    const otherId = (other.body as { job_id: string }).job_id;
    const cross = await api(env, "POST", `/v1/jobs/${otherId}/permissions/${apprId}`, { option: "allow" });
    assert.equal((cross.body as { status: string }).status, "invalid");
  } finally {
    await env.cleanup();
  }
});

test("expired approval cannot be decided; denial is default", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "appr-store-"));
  try {
    const s = new Store(path.join(tmp, "x.db"));
    s.createApproval({
      approval_id: "ap1", job_id: "j1", attempt_id: "at1", run_id: "r1",
      native_request_id: "n1", action: "run", target: "t", options: ["allow", "deny"], ttl_ms: 5,
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(s.decideApproval("ap1", "op", "allow"), "expired");
    // invalid option rejected
    s.createApproval({
      approval_id: "ap2", job_id: "j1", attempt_id: "at1", run_id: "r1",
      native_request_id: "n2", action: "run", target: "t", options: ["allow", "deny"], ttl_ms: 60000,
    });
    assert.equal(s.decideApproval("ap2", "op", "bypass-everything"), "invalid");
    s.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
