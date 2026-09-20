// Generic worker client: Job-API-only helper — no model/provider names.
import test from "node:test";
import assert from "node:assert/strict";
import { makeEnv } from "./helpers.js";
import { worker, WorkerError } from "../src/client/worker.js";

test("worker: submit -> events -> result handoff succeeds", async () => {
  const env = await makeEnv();
  try {
    const h = await worker(
      { url: `http://127.0.0.1:${env.port}`, token: env.token },
      { task: "client task", role: "coding", policy: "default", workspace: { mode: "fresh" } },
    );
    assert.ok(h.job_id.startsWith("job_"));
    const res = await h.result(30000);
    assert.equal(res.status, "succeeded");
    const evs = await h.events();
    assert.ok(evs.some((e) => e.kind === "job.finished" || e.kind === "run.completed"));
  } finally {
    await env.cleanup();
  }
});

test("worker: denied flows surface typed errors", async () => {
  const env = await makeEnv();
  try {
    // bad token -> 401
    await assert.rejects(
      worker({ url: `http://127.0.0.1:${env.port}`, token: "wrong-token-00000000" },
        { task: "x", role: "coding", policy: "default", workspace: { mode: "fresh" } }),
      (e) => e instanceof WorkerError && e.status === 401,
    );
    // unknown policy -> 403/400 (not admitted)
    await assert.rejects(
      worker({ url: `http://127.0.0.1:${env.port}`, token: env.token },
        { task: "x", role: "coding", policy: "no-such-policy", workspace: { mode: "fresh" } }),
      (e) => e instanceof WorkerError && (e.status === 403 || e.status === 400),
    );
    // result() timeout is finite
    const h = await worker(
      { url: `http://127.0.0.1:${env.port}`, token: env.token },
      { task: "y", role: "coding", policy: "default", workspace: { mode: "fresh" } },
    );
    await assert.rejects(h.result(150), (e) => e instanceof WorkerError && e.status === 0);
    // cleanup: cancel so shutdown isn't blocked by in-flight
    await h.cancel().catch(() => {});
  } finally {
    await env.cleanup();
  }
});
