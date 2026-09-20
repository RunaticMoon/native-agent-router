// Idempotent replay at the admission cap. Replaying an existing key must be
// served from the idempotency record BEFORE the active-job cap is evaluated:
// a replay is not a new admission. Conflicting key/body stays 409; a
// genuinely new key under the cap stays 429. Uses one real synthetic hung
// job (beh-hang fixture) to hold the cap; teardown stops it cleanly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, api } from "./helpers.js";

const REQ = {
  task: "synthetic hang", role: "coding", policy: "default",
  workspace: { mode: "fresh" }, preferred: { model: "beh-hang" },
};

test("idempotency replay remains valid at active admission cap; conflict 409; new key 429", async () => {
  const env = await makeEnv();
  env.config.http.max_active_jobs_per_principal = 1;
  try {
    const h = { "idempotency-key": "bounded-qa" };
    const first = await api(env, "POST", "/v1/jobs", REQ, h);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const jobId = (first.body as { job_id: string }).job_id;

    // the hung job actually holds the cap: one real in-flight attempt exists
    for (let i = 0; i < 200 && env.stack.store.attemptsForJob(jobId).length === 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(env.stack.store.attemptsForJob(jobId).length, 1, "hang job never started an attempt");

    // same key + same body -> replay of the original record, NOT an admission
    const second = await api(env, "POST", "/v1/jobs", REQ, h);
    assert.equal(second.status, 200, "replay incorrectly rejected by active-job cap");
    assert.equal((second.body as { job_id: string }).job_id, jobId);
    assert.equal((second.body as { replayed?: boolean }).replayed, true);

    // no extra attempt was spawned by the replay
    assert.equal(env.stack.store.attemptsForJob(jobId).length, 1);

    // same key + different body -> conflict
    const conflict = await api(env, "POST", "/v1/jobs", { ...REQ, task: "different" }, h);
    assert.equal(conflict.status, 409);

    // genuinely new key -> admission cap applies -> 429
    const fresh = await api(env, "POST", "/v1/jobs", REQ, { "idempotency-key": "fresh-key" });
    assert.equal(fresh.status, 429);

    // and a keyless request is likewise capped
    const keyless = await api(env, "POST", "/v1/jobs", REQ);
    assert.equal(keyless.status, 429);
  } finally {
    await env.cleanup(); // shutdown stops the hung fixture attempt
  }
});
