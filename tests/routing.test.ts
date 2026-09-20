// Routing/fallback/quota/Lead checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { makeEnv, submitAndWait } from "./helpers.js";
import { writeFixtureManifest, demoPolicy, buildStack } from "../src/bootstrap.js";
import { Registry } from "../src/registry/registry.js";
import { randomUUID } from "node:crypto";

const JOB = { task: "t", role: "coding", policy: "default", workspace: { mode: "fresh" } };

test("fallback A: post-start failure with no side effects -> next candidate", async () => {
  const env = await makeEnv({ policy: { aliases: { easy: ["beh-fail-rate_limited", "fake-small"] }, max_attempts: 3 } });
  try {
    const { job } = await submitAndWait(env, { ...JOB, preferred: { effort: "low" } });
    assert.equal(job.status, "succeeded");
    const atts = job.attempts as { status: string; candidate_id: string }[];
    assert.equal(atts.length, 2);
    assert.match(atts[0]!.candidate_id, /beh-fail-rate_limited/);
    assert.equal(atts[0]!.status, "failed");
    assert.match(atts[1]!.candidate_id, /fake-small/);
    assert.equal(atts[1]!.status, "succeeded");
  } finally {
    await env.cleanup();
  }
});

test("retry C: unknown side effects -> needs_recovery, no duplicate execution", async () => {
  const env = await makeEnv();
  try {
    const { job } = await submitAndWait(env, { ...JOB, preferred: { model: "beh-side-effects-unknown" } });
    assert.equal(job.status, "needs_recovery");
    const atts = job.attempts as { status: string }[];
    assert.equal(atts.length, 1); // never duplicated
  } finally {
    await env.cleanup();
  }
});

test("exit0 blocked is not success; exhausted candidates -> Lead handoff", async () => {
  const env = await makeEnv({ policy: { max_attempts: 1 } });
  try {
    const { job, jobId } = await submitAndWait(env, { ...JOB, preferred: { model: "beh-soft-deny" } });
    assert.equal(job.status, "failed");
    const atts = job.attempts as { status: string; result?: unknown }[];
    assert.equal(atts.length, 1);
    // handoff recorded
    const decisions = env.stack.store.decisionsForJob(jobId);
    assert.ok(decisions.some((d) => d.kind === "lead_handoff"));
    const result = job.result as { lead_handoff: { tried_candidates: unknown[] } };
    assert.ok(result.lead_handoff.tried_candidates.length === 1);
  } finally {
    await env.cleanup();
  }
});

test("lead-designated plugin is excluded from worker pool", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lead-test-"));
  try {
    const mdir = path.join(tmp, "m");
    const mp = writeFixtureManifest(mdir);
    // turn the fixture manifest into a lead-designated plugin
    const m = JSON.parse(fs.readFileSync(mp, "utf8"));
    m.designation = "lead";
    fs.writeFileSync(mp, JSON.stringify(m));
    const reg = new Registry();
    reg.load([mdir]);
    assert.equal(reg.workerPlugins().length, 0); // excluded even though installed

    const config = {
      db_path: path.join(tmp, "r.db"), approved_manifest_dirs: [mdir],
      approved_workspace_base: path.join(tmp, "w"), profiles: { default: { env: {}, enabled: true } },
      principals: [{ id: "op", token: randomUUID() + randomUUID(), scopes: ["jobs:write", "jobs:read"] as never[], policies: ["*"], workspaces: ["*"] }],
      policies: [demoPolicy()], lead_handoff_enabled: true,
      http: { host: "127.0.0.1", port: 0, allow_public_bind: false },
    };
    const stack = buildStack(config);
    const { job_id } = stack.runtime.submit("op", { task: "x", role: "coding", policy: "default", workspace: { mode: "fresh" } });
    const out = await stack.runtime.execute(job_id);
    assert.equal(out.status, "failed");
    assert.ok(out.lead_handoff); // structured handoff, never a secret Codex spawn
    await stack.runtime.shutdown();
    stack.store.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("unknown quota rejected when policy requires known quota", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quota-test-"));
  try {
    const mdir = path.join(tmp, "m");
    writeFixtureManifest(mdir);
    const config = {
      db_path: path.join(tmp, "r.db"), approved_manifest_dirs: [mdir],
      approved_workspace_base: path.join(tmp, "w"), profiles: { default: { env: {}, enabled: true } },
      principals: [{ id: "op", token: randomUUID() + randomUUID(), scopes: ["jobs:write", "jobs:read"] as never[], policies: ["*"], workspaces: ["*"] }],
      policies: [{ ...demoPolicy(), require_quota_known: true }], lead_handoff_enabled: true,
      http: { host: "127.0.0.1", port: 0, allow_public_bind: false },
    };
    const stack = buildStack(config);
    // seed operator-recorded UNKNOWN observations fresher than any probe,
    // covering every model that could join the candidate pool
    for (const model_id of ["fake-small", "fake-large"]) {
      stack.store.recordQuota({
        plugin_id: "example-native", model_id,
        pool_id: "fixture-pool", status: "unknown", remaining: null, limit: null,
        unit: "unknown", source: "fixture-synthetic",
        observed_at: new Date(Date.now() + 30000).toISOString(), estimated: true,
      });
    }
    const { job_id } = stack.runtime.submit("op", { task: "x", role: "coding", policy: "default", workspace: { mode: "fresh" } });
    const out = await stack.runtime.execute(job_id);
    assert.equal(out.status, "failed"); // no candidates eligible -> handoff
    const dec = stack.store.decisionsForJob(job_id);
    const route = dec.find((d) => d.kind === "route")!;
    assert.match(route.detail_json, /quota unknown/);
    await stack.runtime.shutdown();
    stack.store.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("differently-named plugin registers via manifest alone, no core change", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reg-test-"));
  try {
    const mdir = path.join(tmp, "m");
    const mp = writeFixtureManifest(mdir);
    const m = JSON.parse(fs.readFileSync(mp, "utf8"));
    fs.copyFileSync(mp, path.join(mdir, "copy.manifest.json"));
    const copy = JSON.parse(fs.readFileSync(mp, "utf8"));
    copy.plugin_id = "example-b";
    copy.command.args = [m.command.args[0], "--manifest", path.join(mdir, "copy.manifest.json")];
    fs.writeFileSync(path.join(mdir, "copy.manifest.json"), JSON.stringify(copy));
    const cat = JSON.parse(fs.readFileSync(m.catalog_path, "utf8"));
    cat.plugin_id = "example-b";
    fs.writeFileSync(path.join(mdir, "copy.catalog.json"), JSON.stringify(cat));
    copy.catalog_path = path.join(mdir, "copy.catalog.json");
    fs.writeFileSync(path.join(mdir, "copy.manifest.json"), JSON.stringify(copy));
    const reg = new Registry();
    reg.load([mdir]);
    assert.ok(reg.get("example-b"));
    assert.ok(reg.get("example-native"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("different plugin id actually EXECUTES a job — registration is not just loadable", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reg-exec-"));
  try {
    const mdir = path.join(tmp, "m");
    const mp = writeFixtureManifest(mdir);
    const copy = JSON.parse(fs.readFileSync(mp, "utf8"));
    copy.plugin_id = "example-b";
    copy.catalog_path = path.join(mdir, "example-b.catalog.json");
    copy.command.args = [copy.command.args[0], "--manifest", path.join(mdir, "example-b.manifest.json")];
    const cat = JSON.parse(fs.readFileSync(JSON.parse(fs.readFileSync(mp, "utf8")).catalog_path, "utf8"));
    cat.plugin_id = "example-b";
    fs.writeFileSync(copy.catalog_path, JSON.stringify(cat));
    fs.writeFileSync(path.join(mdir, "example-b.manifest.json"), JSON.stringify(copy));
    fs.rmSync(mp); // only example-b registered

    const { buildStack, demoPolicy } = await import("../src/bootstrap.js");
    const config = {
      db_path: path.join(tmp, "r.db"),
      approved_manifest_dirs: [mdir],
      approved_workspace_base: path.join(tmp, "ws"),
      profiles: { default: { env: {}, enabled: true } },
      principals: [{ id: "op", token: "t".repeat(32), scopes: ["jobs:write", "jobs:read"], policies: ["*"], workspaces: ["*"] }],
      policies: [{ ...demoPolicy(), permission_mode: "preconfigured_only" as const }],
      lead_handoff_enabled: true,
      http: { host: "127.0.0.1", port: 0, allow_public_bind: false },
    };
    const stack = buildStack(config as never);
    try {
      const { job_id } = stack.runtime.submit("op", { task: "go", role: "coding", policy: "default", workspace: { mode: "fresh" }, preferred: { plugin_id: "example-b" } });
      const out = await stack.runtime.execute(job_id);
      assert.equal(out.status, "succeeded");
      const att = stack.store.attemptsForJob(job_id)[0]!;
      assert.ok(att.candidate_id.startsWith("example-b|"));
    } finally {
      await stack.runtime.shutdown();
      stack.store.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
