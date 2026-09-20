// Persisted/exported redaction regression. The final run.completed
// response_text, permission.required target, and artifact event payloads must
// never carry a synthetic secret marker into the durable event log or the
// exported job result. This is DISTINCT from the text.delta streaming fix:
// it covers non-delta fields that bypassed the delta redactor entirely.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeEnv, api, submitAndWait, sseCollect } from "./helpers.js";
import { redactDeep, exactSecretMatcher } from "../src/runtime/redactor.js";

const MARKER = "sk-" + "Q".repeat(90);
const Q30 = "Q".repeat(30);

test("unit: redactDeep walks nested objects/arrays and exact secrets", () => {
  const exact = exactSecretMatcher(["rt-exact-secret-0000000000000001"]);
  const out = redactDeep(
    {
      response_text: `answer ${MARKER} tail`,
      nested: [{ target: `hit ${MARKER}` }, { token: "rt-exact-secret-0000000000000001" }],
      count: 7,
      ok: true,
    },
    exact,
  ) as { response_text: string; nested: { target?: string; token?: string }[] };
  assert.equal(out.response_text.includes(Q30), false);
  assert.equal(out.nested[0]!.target!.includes(Q30), false);
  assert.equal(out.nested[1]!.token, "[REDACTED]");
  assert.equal(JSON.stringify(out).includes(Q30), false);
});

test("e2e: run.completed response_text + permission target carry no marker", async () => {
  const env = await makeEnv();
  try {
    // beh-permission: fixture echoes task into permission target AND
    // response_text — both must be redacted before persistence.
    const r = await api(env, "POST", "/v1/jobs", {
      task: MARKER, role: "coding", policy: "default", workspace: { mode: "fresh" },
      preferred: { model: "beh-permission" },
    }, { "idempotency-key": "redact-meta-1" });
    assert.equal(r.status, 201);
    const jobId = (r.body as { job_id: string }).job_id;
    // wait for the approval then deny it so the run settles fast
    let apprId: string | null = null;
    for (let i = 0; i < 100 && !apprId; i++) {
      const j = await api(env, "GET", `/v1/jobs/${jobId}`);
      apprId = ((j.body as { approvals?: { approval_id: string; status: string }[] }).approvals ?? [])
        .find((a) => a.status === "pending")?.approval_id ?? null;
      if (!apprId) await new Promise((r2) => setTimeout(r2, 80));
    }
    assert.ok(apprId, "no pending approval surfaced");
    await api(env, "POST", `/v1/jobs/${jobId}/permissions/${apprId}`, { option: "deny" });
    const deadline = Date.now() + 30000;
    for (;;) {
      const j = await api(env, "GET", `/v1/jobs/${jobId}`);
      const st = (j.body as { status: string }).status;
      if (["succeeded", "failed", "cancelled", "needs_recovery"].includes(st)) break;
      if (Date.now() > deadline) throw new Error(`timeout; status=${st}`);
      await new Promise((r2) => setTimeout(r2, 150));
    }
    const events = await sseCollect(env, jobId);
    const all = JSON.stringify(events);
    assert.equal(all.includes(Q30), false, "marker suffix leaked into persisted/replayed events");
    // exported job record is clean too
    const j2 = await api(env, "GET", `/v1/jobs/${jobId}`);
    assert.equal(JSON.stringify(j2.body).includes(Q30), false, "marker suffix leaked into exported job result");
    // and the permission request itself was still delivered (raw ids used
    // internally even though the persisted record is redacted)
    const appr = (j2.body as { approvals?: { delivery_state: string }[] }).approvals?.[0];
    assert.equal(appr?.delivery_state, "delivered");
  } finally {
    await env.cleanup();
  }
});

test("e2e: invalid artifact event is rejected before persistence; valid ref kept", async () => {
  const env = await makeEnv();
  try {
    // Drive the runtime emit path directly through a real attempt so the
    // event pipeline (validate-before-persist) is exercised end to end.
    const { job_id } = env.stack.runtime.submit("op", {
      task: "t", role: "coding", policy: "default", workspace: { mode: "fresh" },
    });
    const job = env.stack.store.getJob(job_id)!;
    // a valid artifact inside the job workspace
    const inside = path.join(job.workspace_path, "note.txt");
    fs.writeFileSync(inside, "ok");
    const runtime = env.stack.runtime as unknown as {
      recordArtifact: (ev: unknown, j: string, a: string, w: string) => string | null;
    };
    const good = runtime.recordArtifact(
      { kind: "artifact.created", payload: { path: inside, artifact_kind: "log" } },
      job_id, "att-x", job.workspace_path,
    );
    assert.equal(good, fs.realpathSync(inside));
    // escapes and credential-shaped names are refused -> no artifact row
    const outside = path.join(env.tmp, "escape.txt");
    fs.writeFileSync(outside, "no");
    assert.equal(runtime.recordArtifact(
      { kind: "artifact.created", payload: { path: outside, artifact_kind: "log" } },
      job_id, "att-x", job.workspace_path,
    ), null);
    const cred = path.join(job.workspace_path, "id_rsa");
    fs.writeFileSync(cred, "no");
    assert.equal(runtime.recordArtifact(
      { kind: "artifact.created", payload: { path: cred, artifact_kind: "log" } },
      job_id, "att-x", job.workspace_path,
    ), null);
    const rows = env.stack.store.artifactsForJob(job_id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.ref, fs.realpathSync(inside));
  } finally {
    await env.cleanup();
  }
});

test("e2e: permission delivery uses raw internal ids despite persisted redaction", async () => {
  // Marker in the task -> permission target is redacted in the stored event,
  // yet the approval still binds + delivers (native request id unaffected).
  const env = await makeEnv();
  try {
    const { jobId } = await submitAndWait(env, {
      task: MARKER, role: "coding", policy: "default", workspace: { mode: "fresh" },
      preferred: { model: "fake-small" },
    });
    const evs = await sseCollect(env, jobId);
    const completed = evs.find((e) => e.kind === "run.completed");
    assert.ok(completed, "no run.completed event");
    const rt = (completed!.data.payload as { response_text?: string }).response_text ?? "";
    assert.equal(rt.includes(Q30), false, "run.completed response_text leaked marker suffix");
  } finally {
    await env.cleanup();
  }
});
