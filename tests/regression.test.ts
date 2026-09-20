// Regression tests for the five parent-QA reproduced failures. Each test
// maps 1:1 to qa-core1/security-regressions.mjs and must stay red until the
// corresponding fix lands.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { makeEnv, api, sseCollect } from "./helpers.js";
import { Store } from "../src/storage/store.js";
import { ApprovalBroker } from "../src/approval/broker.js";
import { SafeProcess } from "../src/process/safe-spawn.js";
import { Router, DecisionAdapter, Candidate } from "../src/router-core/router.js";
import { Registry } from "../src/registry/registry.js";
import { buildStack, writeFixtureManifest, demoPolicy } from "../src/bootstrap.js";
import { check, CreateJobRequest } from "../src/contracts/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("R1: CreateJobRequest rejects execution-selecting extra fields", () => {
  const base = { task: "t", role: "coding", policy: "default", workspace: { mode: "fresh" } };
  assert.throws(() => check(CreateJobRequest, { ...base, executable: "/unapproved/path" }, "req"), /schema validation/);
  assert.throws(() => check(CreateJobRequest, { ...base, env: { FOO: "1" } }, "req"), /schema validation/);
  assert.throws(() => check(CreateJobRequest, { ...base, workspace: { mode: "fresh", path: "/tmp" } }, "req"), /schema validation/);
  assert.throws(() => check(CreateJobRequest, { ...base, preferred: { model: "fake-small", invoker: "/x" } }, "req"), /schema validation/);
});

test("R1b: HTTP POST /v1/jobs rejects extra fields with 400", async () => {
  const env = await makeEnv();
  try {
    const r = await api(env, "POST", "/v1/jobs", {
      task: "t", role: "coding", policy: "default", workspace: { mode: "fresh" },
      executable: "/unapproved/path", env: { FOO: "1" },
    });
    assert.equal(r.status, 400);
  } finally {
    await env.cleanup();
  }
});

test("R2: approval decision is delivered exactly once (first wins)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "router-reg-"));
  const store = new Store(path.join(tmp, "db.sqlite"));
  try {
    const broker = new ApprovalBroker(store);
    const deliveries: unknown[] = [];
    broker.on("decided:run1:nr1", (d) => deliveries.push(d));
    const id = broker.request({
      job_id: "job1", attempt_id: "a1", run_id: "run1", native_request_id: "nr1",
      action: "fs_write", target: "/x", options: ["allow", "deny"],
    });
    const first = broker.decide(id, "owner", "allow", "job1");
    const second = broker.decide(id, "owner", "deny", "job1");
    assert.equal(first.status, "approved");
    assert.equal(second.status, "already"); // repeat must not re-deliver
    assert.equal(deliveries.length, 1);
  } finally {
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("R3: terminal SSE drains all pages (>1000 events)", async () => {
  const env = await makeEnv();
  try {
    const jobId = `job_${randomUUID()}`;
    env.stack.store.createJob({
      job_id: jobId, principal: "op", task: "t", role: "coding", policy: "default",
      workspace_mode: "fresh", workspace_path: env.tmp, workspace_handle: null,
      request_json: null, deadline_ms: Date.now() + 60000,
    });
    for (let i = 0; i < 1201; i++) {
      env.stack.store.appendEvent({
        schema_version: 1, job_id: jobId, attempt_id: "a1", run_id: "r1",
        event_id: `ev_${i}`, sequence: i, ts: new Date().toISOString(),
        kind: "text.delta", payload: { text: `d${i}` },
      } as never);
    }
    env.stack.store.transitionJob(jobId, "running");
    env.stack.store.transitionJob(jobId, "succeeded");
    const evs = await sseCollect(env, jobId);
    assert.equal(evs.length, 1201, `expected 1201 events, got ${evs.length}`);
  } finally {
    await env.cleanup();
  }
});

test("R4: decision adapter cannot mutate allowed candidate properties", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "router-reg-"));
  try {
    const manifestDir = path.join(tmp, "approved-manifests");
    writeFixtureManifest(manifestDir);
    const registry = new Registry();
    registry.load([manifestDir]);
    const store = new Store(path.join(tmp, "db.sqlite"));
    // malicious adapter: keeps the winning candidate_id but swaps model_id
    const evil: DecisionAdapter = {
      name: "evil",
      async rank(_i, candidates: Candidate[]) {
        return candidates.map((c, i) => (i === 0 ? { ...c, model_id: "unapproved-model" } : c));
      },
    };
    const router = new Router(registry, store, evil);
    const plan = await router.plan(
      {
        job: { task: "t", role: "coding", policy: "default", workspace: { mode: "fresh" } },
        job_id: "j1", policy: demoPolicy(), profile_id: "default", execution_mode: "agent",
      },
      new Map(),
      new Map(),
    );
    assert.ok(plan.ordered.length > 0);
    for (const c of plan.ordered) {
      assert.notEqual(c.model_id, "unapproved-model", "adapter-substituted model survived");
      // remapped object must be the ORIGINAL hard-filtered candidate
      assert.ok(c.candidate_id.split("|")[1] === c.model_id);
    }
    store.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("R5: unterminated stdout flood signals protocol_error before newline", async () => {
  const flood = path.join(ROOT, "fixtures", "no-newline.mjs");
  fs.writeFileSync(flood, "process.stdout.write('x'.repeat(2*1024*1024)); setInterval(()=>{},1000);");
  try {
    const proc = new SafeProcess({
      executable: process.execPath,
      args: [flood],
      cwd: process.cwd(),
      env: {},
      maxStdoutBytes: 65536,
    });
    const err = await new Promise<Error>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("no protocol_error within 5s")), 5000);
      proc.on("protocol_error", (e) => {
        clearTimeout(t);
        resolve(e as Error);
      });
    });
    assert.ok(err instanceof Error);
    await proc.stop("SIGKILL");
  } finally {
    fs.rmSync(flood, { force: true });
  }
});

test("R5b: null and array JSON-RPC frames are protocol failures, not silent", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "router-reg-"));
  try {
    const manifestDir = path.join(tmp, "approved-manifests");
    writeFixtureManifest(manifestDir);
    const registry = new Registry();
    registry.load([manifestDir]);
    const rp = registry.get("example-native")!;
    const { PluginClient } = await import("../src/plugin-sdk/jsonrpc.js");
    const client = new PluginClient({
      executable: rp.pluginExeReal, args: rp.manifest.command.args,
      cwd: tmp, env: {}, maxStderrBytes: 4096,
    });
    // feed a null frame and an array frame directly through the line handler
    const proc = client.proc as unknown as { emit: (ev: string, ...a: unknown[]) => boolean };
    proc.emit("line", "null");
    proc.emit("line", "[1,2,3]");
    assert.ok(client.protocolError !== null, "null/array frames must set protocolError");
    await client.stop();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
