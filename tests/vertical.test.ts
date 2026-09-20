// Vertical slice + API auth + idempotency + SSE replay.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeEnv, api, submitAndWait, sseCollect } from "./helpers.js";

const JOB = { task: "build a thing", role: "coding", policy: "default", workspace: { mode: "fresh" } };

test("vertical: fake job -> API -> plugin -> fake CLI -> succeeded with events", async () => {
  const env = await makeEnv();
  try {
    const { job, jobId } = await submitAndWait(env, JOB);
    assert.equal(job.status, "succeeded");
    const attempts = job.attempts as { status: string; candidate_id: string }[];
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]!.status, "succeeded");
    const events = await sseCollect(env, jobId);
    const kinds = events.map((e) => e.kind);
    assert.ok(kinds.includes("run.started"));
    assert.ok(kinds.includes("text.delta"));
    assert.ok(kinds.includes("usage.observed"));
    assert.equal(kinds[kinds.length - 1], "run.completed");
  } finally {
    await env.cleanup();
  }
});

test("auth: all routes require bearer; wrong scope denied; cross-principal hidden", async () => {
  const env = await makeEnv({
    principals: [
      { id: "op", token: "o".repeat(40), scopes: ["jobs:write", "jobs:read", "approve"], policies: ["*"], workspaces: ["*"] },
      { id: "ro", token: "r".repeat(40), scopes: ["jobs:read"], policies: ["*"], workspaces: ["*"] },
    ],
  });
  env.token = "o".repeat(40);
  try {
    const noTok = await fetch(`http://127.0.0.1:${env.port}/v1/jobs`, { method: "POST", body: "{}" });
    assert.equal(noTok.status, 401);

    const { jobId } = await submitAndWait(env, JOB);
    const denied = await fetch(`http://127.0.0.1:${env.port}/v1/jobs`, {
      method: "POST", headers: { authorization: `Bearer ${"r".repeat(40)}`, "content-type": "application/json" }, body: JSON.stringify(JOB),
    });
    assert.equal(denied.status, 403);
    // cross-principal: reader 'ro' cannot see op's job
    const hidden = await fetch(`http://127.0.0.1:${env.port}/v1/jobs/${jobId}`, {
      headers: { authorization: `Bearer ${"r".repeat(40)}` },
    });
    assert.equal(hidden.status, 404);
  } finally {
    await env.cleanup();
  }
});

test("idempotency: same key+body replays job; same key different body conflicts", async () => {
  const env = await makeEnv();
  try {
    const key = randomUUID();
    const r1 = await api(env, "POST", "/v1/jobs", JOB, { "idempotency-key": key });
    assert.equal(r1.status, 201);
    const r2 = await api(env, "POST", "/v1/jobs", JOB, { "idempotency-key": key });
    assert.equal(r2.status, 200);
    assert.equal((r2.body as { job_id: string }).job_id, (r1.body as { job_id: string }).job_id);
    assert.equal((r2.body as { replayed: boolean }).replayed, true);
    const r3 = await api(env, "POST", "/v1/jobs", { ...JOB, task: "different" }, { "idempotency-key": key });
    assert.equal(r3.status, 409);
  } finally {
    await env.cleanup();
  }
});

test("SSE Last-Event-ID replay returns only later events", async () => {
  const env = await makeEnv();
  try {
    const { jobId } = await submitAndWait(env, JOB);
    const all = await sseCollect(env, jobId);
    assert.ok(all.length >= 3);
    const mid = all[1]!;
    const replay = await sseCollect(env, jobId, mid.id!);
    assert.deepEqual(replay.map((e) => e.id), all.slice(2).map((e) => e.id));
  } finally {
    await env.cleanup();
  }
});

test("cancel: running job cancelled and stays cancelled", async () => {
  const env = await makeEnv();
  try {
    const r = await api(env, "POST", "/v1/jobs", {
      ...JOB, preferred: { model: "beh-hang" },
    }, { "idempotency-key": randomUUID() });
    const jobId = (r.body as { job_id: string }).job_id;
    // wait until an attempt is running
    for (let i = 0; i < 100; i++) {
      const j = await api(env, "GET", `/v1/jobs/${jobId}`);
      if ((j.body as { status: string }).status === "running") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const c = await api(env, "POST", `/v1/jobs/${jobId}/cancel`);
    assert.match((c.body as { status: string }).status, /cancel/);
    let final = "";
    for (let i = 0; i < 100; i++) {
      const j = await api(env, "GET", `/v1/jobs/${jobId}`);
      const st = (j.body as { status: string }).status;
      if (["succeeded", "failed", "cancelled", "needs_recovery"].includes(st)) { final = st; break; }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(final, "cancelled");
    // terminal: stays cancelled, never returns to running
    const j2 = await api(env, "GET", `/v1/jobs/${jobId}`);
    assert.equal((j2.body as { status: string }).status, "cancelled");
  } finally {
    await env.cleanup();
  }
});

test("argv injection: task text is data, not a command", async () => {
  const env = await makeEnv();
  try {
    const evil = '"; touch /tmp/SHOULD_NOT_EXIST_$$ #';
    const { job } = await submitAndWait(env, { ...JOB, task: evil });
    assert.equal(job.status, "succeeded");
    const { existsSync } = await import("node:fs");
    assert.equal(existsSync("/tmp/SHOULD_NOT_EXIST_$$"), false);
  } finally {
    await env.cleanup();
  }
});
