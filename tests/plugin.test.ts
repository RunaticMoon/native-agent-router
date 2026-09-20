// End-to-end plugin protocol tests: spawn the compiled plugin process and
// drive handshake/probe/run/cancel/respondPermission over stdio JSON-RPC,
// with the synthetic fixture CLIs as the native spec executables.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { ChildWireProcess } from "../src/native/wire.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEVIN_FIXTURE = path.join(ROOT, "fixtures/fake-devin-acp.mjs");
const AGY_FIXTURE = path.join(ROOT, "fixtures/fake-agy.mjs");
const NODE_SHA = crypto.createHash("sha256").update(fs.readFileSync(process.execPath)).digest("hex");

class RpcClient {
  proc: ChildWireProcess;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 0;
  events: Record<string, unknown>[] = [];
  constructor(pluginPath: string, env: Record<string, string>) {
    this.proc = new ChildWireProcess({ executable: process.execPath, args: [pluginPath], cwd: "/tmp", env });
    this.proc.on("line", (l) => {
      const m = JSON.parse(l);
      if (m.method === "run.event") {
        this.events.push(m.params);
        return;
      }
      if ("id" in m) {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.error) p.reject(Object.assign(new Error(m.error.message), { rpcCode: m.error.code, data: m.error.data }));
        else p.resolve(m.result);
      }
    });
  }
  call<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.proc.writeLine(JSON.stringify({ jsonrpc: "2.0", id, method, params })).catch(reject);
    });
  }
  async stop() {
    await this.proc.stop();
  }
}

function devinPlugin() {
  return new RpcClient(path.join(ROOT, "dist/plugins/devin-native.js"), {
    DEVIN_CLI_EXECUTABLE: process.execPath,
    DEVIN_CLI_BASE_ARGS: DEVIN_FIXTURE,
    DEVIN_CLI_SHA256: NODE_SHA,
    DEVIN_CLI_VERSION_RANGE: ">=3000.0.0 <3001.0.0",
    DEVIN_CLI_VERSION_ARGS: `${DEVIN_FIXTURE} --version`,
  });
}
function agyPlugin() {
  return new RpcClient(path.join(ROOT, "dist/plugins/antigravity-native.js"), {
    AGY_CLI_EXECUTABLE: process.execPath,
    AGY_CLI_BASE_ARGS: AGY_FIXTURE,
    AGY_CLI_SHA256: NODE_SHA,
    AGY_CLI_VERSION_RANGE: ">=1.0.0 <2.0.0",
    AGY_CLI_VERSION_ARGS: `${AGY_FIXTURE} --version`,
  });
}

const runReq = (over: Record<string, unknown> = {}) => ({
  run_id: "run-1", job_id: "job-1", attempt_id: "att-1",
  task: "synthetic task", role: "coding",
  resolved_policy: { permission_mode: "interactive", max_wall_seconds: 60 },
  candidate_id: "cand-1",
  workspace: { path: "/tmp", mode: "fresh" },
  native_profile_id: "prof-1",
  execution_mode: "agent",
  requested_model: "swe-2-max",
  deadline_ms: 20000,
  env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  ...over,
});
const runWith = (scenarioEnv: Record<string, string>, over: Record<string, unknown> = {}) =>
  runReq({ ...over, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...scenarioEnv } });

test("devin plugin: handshake/probe/run happy path with events", async () => {
  const c = devinPlugin();
  const hs = (await c.call("handshake", { protocol_version: 1, router_id: "r1" })) as Record<string, unknown>;
  assert.equal(hs.plugin_id, "devin-native");
  assert.deepEqual(hs.methods, ["handshake", "probe", "run", "cancel", "respondPermission"]);
  assert.equal((hs.capabilities as Record<string, unknown>).permission, "unknown");

  const probe = (await c.call("probe", { profile: { native_profile_id: "p", env: {} } })) as Record<string, unknown>;
  assert.equal(probe.cli_version, "3000.10.31");
  assert.equal(probe.models, undefined); // conservative: no live catalog claim

  const runP = c.call("run", runWith({ FAKE_ACP_SCENARIO: "text" })) as Promise<Record<string, unknown>>;
  const res = await runP;
  assert.equal(res.outcome, "completed");
  assert.equal(res.status, "completed");
  assert.equal(res.side_effects, "none");
  const kinds = c.events.map((e) => e.kind);
  assert.ok(kinds.includes("run.started"));
  assert.ok(kinds.includes("text.delta"));
  assert.ok(kinds.includes("run.completed"));
  const text = c.events.filter((e) => e.kind === "text.delta").map((e) => (e.payload as { text: string }).text).join("");
  assert.equal(text, "Hello world");
  await c.stop();
});

test("devin plugin: probe rejects sha256 mismatch", async () => {
  const c = new RpcClient(path.join(ROOT, "dist/plugins/devin-native.js"), {
    DEVIN_CLI_EXECUTABLE: process.execPath,
    DEVIN_CLI_BASE_ARGS: DEVIN_FIXTURE,
    DEVIN_CLI_SHA256: "0".repeat(64),
    DEVIN_CLI_VERSION_ARGS: `${DEVIN_FIXTURE} --version`,
  });
  await c.call("handshake", { protocol_version: 1, router_id: "r1" });
  await assert.rejects(() => c.call("probe", { profile: { native_profile_id: "p", env: {} } }), /sha256 mismatch/);
  await c.stop();
});

test("devin plugin: interactive permission round-trip via respondPermission", async () => {
  const c = devinPlugin();
  await c.call("handshake", { protocol_version: 1, router_id: "r1" });
  const runP = c.call("run", runWith({ FAKE_ACP_SCENARIO: "permission" }, { run_id: "run-perm" })) as Promise<Record<string, unknown>>;
  for (let i = 0; i < 300 && !c.events.some((e) => e.kind === "permission.required"); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const perm = c.events.find((e) => e.kind === "permission.required")!;
  const reqId = (perm.payload as { request_id: string }).request_id;
  const ack = (await c.call("respondPermission", { run_id: "run-perm", request_id: reqId, decision: "reject_once" })) as Record<string, unknown>;
  assert.equal(ack.delivered, true);
  const res = await runP;
  assert.equal(res.outcome, "completed");
  assert.equal(res.status, "partial"); // a denial was observed
  await c.stop();
});

test("devin plugin: respondPermission rejects unknown request_id", async () => {
  const c = devinPlugin();
  await c.call("handshake", { protocol_version: 1, router_id: "r1" });
  const runP = c.call("run", runWith({ FAKE_ACP_SCENARIO: "permission" }, { run_id: "run-perm2" })) as Promise<Record<string, unknown>>;
  for (let i = 0; i < 300 && !c.events.some((e) => e.kind === "permission.required"); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  await assert.rejects(
    () => c.call("respondPermission", { run_id: "run-perm2", request_id: "bogus", decision: "allow_once" }),
    /no pending permission/,
  );
  // resolve the real one so the run can finish
  const perm = c.events.find((e) => e.kind === "permission.required")!;
  await c.call("respondPermission", { run_id: "run-perm2", request_id: (perm.payload as { request_id: string }).request_id, decision: "allow_once" });
  await runP;
  await c.stop();
});

test("devin plugin: cancel -> cancelled outcome with remote confirmation", async () => {
  const c = devinPlugin();
  await c.call("handshake", { protocol_version: 1, router_id: "r1" });
  const runP = c.call("run", runWith({ FAKE_ACP_SCENARIO: "slow" }, { run_id: "run-cancel" })) as Promise<Record<string, unknown>>;
  await new Promise((r) => setTimeout(r, 300));
  const ack = (await c.call("cancel", { run_id: "run-cancel" })) as Record<string, unknown>;
  assert.equal(ack.ack, "accepted");
  const res = await runP;
  assert.equal(res.outcome, "cancelled");
  assert.equal(res.cancel_confirmed, true);
  await c.stop();
});

test("devin plugin: resume request is refused, not silently started fresh", async () => {
  const c = devinPlugin();
  await c.call("handshake", { protocol_version: 1, router_id: "r1" });
  await assert.rejects(() => c.call("run", runReq({ native_session_id: "sess-old" })), /UNSUPPORTED_CAPABILITY/);
  await c.stop();
});

test("devin plugin: effort request is refused (unverified interface)", async () => {
  const c = devinPlugin();
  await c.call("handshake", { protocol_version: 1, router_id: "r1" });
  await assert.rejects(() => c.call("run", runReq({ requested_effort: "high" })), /UNSUPPORTED_CAPABILITY/);
  await c.stop();
});

test("devin plugin: init version mismatch -> CLI_VERSION_UNSUPPORTED failure", async () => {
  const c = devinPlugin();
  await c.call("handshake", { protocol_version: 1, router_id: "r1" });
  const res = (await c.call("run", runWith({ FAKE_ACP_SCENARIO: "version-mismatch" }))) as Record<string, unknown>;
  assert.equal(res.outcome, "failed");
  assert.equal((res.error as { code: string }).code, "CLI_VERSION_UNSUPPORTED");
  await c.stop();
});

test("agy plugin: handshake/probe/run; preconfigured_only; cumulative usage", async () => {
  const c = agyPlugin();
  const hs = (await c.call("handshake", { protocol_version: 1, router_id: "r1" })) as Record<string, unknown>;
  assert.equal(hs.plugin_id, "antigravity-native");
  assert.deepEqual(hs.methods, ["handshake", "probe", "run", "cancel"]); // no respondPermission
  assert.equal((hs.capabilities as Record<string, unknown>).permission, "preconfigured_only");
  const probe = (await c.call("probe", { profile: { native_profile_id: "p", env: {} } })) as Record<string, unknown>;
  assert.equal(probe.cli_version, "1.2.6");
  const res = (await c.call("run", runWith({ FAKE_AGY_SCENARIO: "text" }, { requested_model: "gemini-3.5-flash-medium" }))) as Record<string, unknown>;
  assert.equal(res.outcome, "completed");
  assert.equal(res.status, "completed");
  assert.equal((res.usage as { cumulative: boolean }).cumulative, true);
  assert.equal(res.observed_model, undefined); // init echo is not proof
  await assert.rejects(() => c.call("respondPermission", { run_id: "run-1", request_id: "x", decision: "allow_once" }), /respondPermission/);
  await c.stop();
});

test("agy plugin: cancel -> local stop only, remote unknown", async () => {
  const c = agyPlugin();
  await c.call("handshake", { protocol_version: 1, router_id: "r1" });
  const runP = c.call("run", runWith({ FAKE_AGY_SCENARIO: "slow" }, { run_id: "run-ac", requested_model: "m1" })) as Promise<Record<string, unknown>>;
  await new Promise((r) => setTimeout(r, 300));
  const ack = (await c.call("cancel", { run_id: "run-ac" })) as Record<string, unknown>;
  assert.equal(ack.ack, "accepted");
  const res = await runP;
  assert.equal(res.outcome, "cancelled");
  assert.equal(res.cancel_confirmed, false); // local kill is not remote cancel
  await c.stop();
});

test("agy plugin: invalid effort refused", async () => {
  const c = agyPlugin();
  await c.call("handshake", { protocol_version: 1, router_id: "r1" });
  await assert.rejects(() => c.call("run", runReq({ requested_effort: "extreme" })), /UNSUPPORTED_CAPABILITY/);
  await c.stop();
});

test("agy plugin: tool error yields partial despite SUCCESS", async () => {
  const c = agyPlugin();
  await c.call("handshake", { protocol_version: 1, router_id: "r1" });
  const res = (await c.call("run", runWith({ FAKE_AGY_SCENARIO: "tool-error" }, { requested_model: "m1" }))) as Record<string, unknown>;
  assert.equal(res.outcome, "completed");
  assert.equal(res.status, "partial");
  await c.stop();
});

test("process cleanup: no fixture survivors after stop", async () => {
  const c = devinPlugin();
  await c.call("handshake", { protocol_version: 1, router_id: "r1" });
  await c.call("run", runWith({ FAKE_ACP_SCENARIO: "text" }));
  await c.proc.stop();
  assert.equal(c.proc.survivors().length, 0);
});
