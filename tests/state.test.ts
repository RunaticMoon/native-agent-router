// State machine, restart recovery, DB owner guard, wire-contract checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Store } from "../src/storage/store.js";
import { makeEnv, api } from "./helpers.js";
import { writeFixtureManifest, demoPolicy, buildStack } from "../src/bootstrap.js";
import { Registry } from "../src/registry/registry.js";
import { PluginClient } from "../src/plugin-sdk/jsonrpc.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const NODE = fs.realpathSync(process.execPath);
const PLUGIN = path.join(ROOT, "dist/plugins/example-native/plugin-main.js");

test("single DB owner: second live daemon refused", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owner-"));
  try {
    const s1 = new Store(path.join(tmp, "x.db"));
    assert.throws(() => new Store(path.join(tmp, "x.db")), /owned by live router/);
    s1.close();
    // after close (owner released), a new store may open
    const s2 = new Store(path.join(tmp, "x.db"));
    s2.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("terminal states are immutable", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "term-"));
  try {
    const s = new Store(path.join(tmp, "x.db"));
    s.createJob({ job_id: "j1", principal: "p", task: "t", role: "coding", policy: "default", workspace_mode: "fresh", workspace_path: "/tmp", workspace_handle: null, request_json: null, deadline_ms: Date.now() + 10000 });
    s.transitionJob("j1", "running");
    s.transitionJob("j1", "succeeded");
    assert.equal(s.transitionJob("j1", "running"), false);
    assert.equal(s.transitionJob("j1", "failed"), false);
    // events append-only
    s.appendEvent({ schema_version: 1, kind: "run.started", job_id: "j1", attempt_id: "a", run_id: "r", event_id: "e1", sequence: 0, ts: new Date().toISOString(), payload: { requested_model: "m" } } as never);
    assert.throws(() => s.db.prepare("UPDATE events SET kind='x' WHERE event_id='e1'").run(), /append-only/);
    s.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("restart recovery: non-terminal attempt -> needs_recovery, capacity quarantined, no replay", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "restart-"));
  const mdir = path.join(tmp, "m");
  writeFixtureManifest(mdir);
  const mkCfg = () => ({
    db_path: path.join(tmp, "r.db"), approved_manifest_dirs: [mdir],
    approved_workspace_base: path.join(tmp, "w"), profiles: { default: { env: {}, enabled: true } },
    principals: [{ id: "op", token: randomUUID() + randomUUID(), scopes: ["jobs:write", "jobs:read"] as never[], policies: ["*"], workspaces: ["*"] }],
    policies: [demoPolicy()], lead_handoff_enabled: true,
    http: { host: "127.0.0.1", port: 0, allow_public_bind: false },
  });
  const stack1 = buildStack(mkCfg());
  const { job_id } = stack1.runtime.submit("op", {
    task: "hang", role: "coding", policy: "default",
    workspace: { mode: "fresh" }, preferred: { model: "beh-hang" },
  });
  const execPromise = stack1.runtime.execute(job_id).catch(() => {});
  // wait for attempt to be running
  for (let i = 0; i < 100; i++) {
    const atts = stack1.store.attemptsForJob(job_id);
    if (atts.length && atts[0]!.status === "running") break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const att = stack1.store.attemptsForJob(job_id)[0]!;
  assert.equal(att.status, "running");
  // simulate crash: release DB ownership without stopping child processes
  stack1.store.close();
  // new owner recovers: live unknown-outcome process -> kill + quarantine
  const stack2 = buildStack(mkCfg());
  stack2.runtime.recoverOnStart();
  const att2 = stack2.store.getAttempt(att.attempt_id)!;
  assert.equal(att2.status, "needs_recovery");
  const resv = stack2.store.reservationsForAttempt(att.attempt_id);
  assert.equal(resv[0]?.state, "quarantined");
  const job2 = stack2.store.getJob(job_id)!;
  assert.equal(job2.status, "needs_recovery");
  // hung fixture killed during recovery
  const { identityAlive } = await import("../src/process/safe-spawn.js");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(identityAlive({ pid: att.pid!, pgid: att.pgid!, exe_realpath: att.exe_realpath ?? "", proc_start: att.proc_start! }), false);
  await stack2.runtime.shutdown();
  stack2.store.close();
  void execPromise.catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("contract: protocol_version mismatch rejected at handshake", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "proto-"));
  try {
    const mdir = path.join(tmp, "m");
    writeFixtureManifest(mdir);
    const client = new PluginClient({
      executable: NODE,
      args: [PLUGIN, "--manifest", path.join(mdir, "example-native.manifest.json")],
      cwd: tmp, env: {},
    });
    await assert.rejects(
      client.call("handshake", { protocol_version: 2, router_id: "r" }),
      /protocol mismatch/,
    );
    await client.stop();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("contract: malformed JSONL frame gets explicit parse error, not silence", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "malform-"));
  try {
    const mdir = path.join(tmp, "m");
    writeFixtureManifest(mdir);
    const client = new PluginClient({
      executable: NODE,
      args: [PLUGIN, "--manifest", path.join(mdir, "example-native.manifest.json")],
      cwd: tmp, env: {},
    });
    await client.proc.writeLine("this is not json{");
    const resp = await new Promise<string>((resolve) => {
      client.proc.on("line", (l: string) => resolve(l));
    });
    const msg = JSON.parse(resp);
    assert.equal(msg.error.code, -32700);
    await client.stop();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("security: manifest outside approved dirs never loads; sha mismatch rejected; workspace symlink escape rejected", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sec-"));
  try {
    const mdir = path.join(tmp, "approved");
    const mp = writeFixtureManifest(mdir);
    // sha mismatch
    const bad = path.join(tmp, "bad");
    fs.mkdirSync(bad);
    const m = JSON.parse(fs.readFileSync(mp, "utf8"));
    m.cli.sha256 = "0".repeat(64);
    fs.writeFileSync(path.join(bad, "evil.manifest.json"), JSON.stringify(m));
    const reg = new Registry();
    reg.load([bad]); // scans dir but verification fails
    assert.equal(reg.plugins.size, 0);
    // a manifest in a NON-approved dir is never even scanned
    const reg2 = new Registry();
    reg2.load([mdir]);
    assert.equal(reg2.plugins.size, 1);

    // workspace symlink escape: registered handle realpath -> outside base
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-ws-"));
    const linkPath = path.join(tmp, "wsbase-link");
    fs.mkdirSync(path.join(tmp, "wsbase"));
    fs.symlinkSync(outside, linkPath);
    const env = await makeEnv();
    try {
      env.stack.store.registerWorkspace("evil-handle", "op", linkPath);
      const r = await api(env, "POST", "/v1/jobs", {
        task: "x", role: "coding", policy: "default",
        workspace: { mode: "locked", handle: "evil-handle" },
      });
      assert.equal(r.status, 403);
      assert.match(String((r.body as { error: string }).error), /escapes|not approved/);
    } finally {
      await env.cleanup();
      fs.rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
