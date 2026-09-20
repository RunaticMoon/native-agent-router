// AcpClient vs synthetic fake-devin-acp.mjs stand-in executable.
// These are SYNTHETIC wire fixtures — not recorded or real account runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { ChildWireProcess } from "../src/native/wire.js";
import { AcpClient, AcpProtocolError } from "../src/native/acp.js";

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../fixtures/fake-devin-acp.mjs");

function spawnFake(scenario: string, extraEnv: Record<string, string> = {}) {
  return new ChildWireProcess({
    executable: process.execPath,
    args: [FIXTURE],
    cwd: "/tmp",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", FAKE_ACP_SCENARIO: scenario, ...extraEnv },
  });
}

interface Collected {
  text: string;
  tools: { name: string; callId: string; status?: string }[];
  permissions: { requestId: string; options: { id: string; kind?: string; native_kind?: string }[] }[];
  context: { used: number; size: number }[];
}
function collect(): { handlers: ConstructorParameters<typeof AcpClient>[1]; c: Collected } {
  const c: Collected = { text: "", tools: [], permissions: [], context: [] };
  const byId = new Map<string, { name: string; callId: string; status?: string }>();
  return {
    c,
    handlers: {
      onText: (t) => (c.text += t),
      onToolStarted: (tool, callId) => {
        const r = { name: tool, callId, status: undefined as string | undefined };
        byId.set(callId, r);
        c.tools.push(r);
      },
      onToolCompleted: (tool, callId, status) => {
        const r = byId.get(callId) ?? { name: tool, callId, status: undefined as string | undefined };
        r.status = status;
        if (!byId.has(callId)) c.tools.push(r);
      },
      onPermissionRequired: (requestId, _a, _t, options) => c.permissions.push({ requestId, options }),
      onContextUsage: (u) => c.context.push(u),
    },
  };
}

test("initialize -> session/new -> prompt end_turn with text deltas (incl. fragmented frame)", async () => {
  const { handlers, c } = collect();
  const client = new AcpClient(spawnFake("text"), handlers, "interactive", 5000);
  await client.initialize();
  assert.equal(client.agentInfo.name, "affogato");
  const sid = await client.newSession("/tmp");
  assert.equal(sid, "sess_fixture_1");
  const out = await client.prompt(sid, "hi", 5000);
  assert.equal(out.stopReason, "end_turn");
  assert.equal(c.text, "Hello world");
  await client.proc.stop();
});

test("protocol version mismatch is rejected", async () => {
  const { handlers } = collect();
  const client = new AcpClient(spawnFake("version-mismatch"), handlers, "interactive", 5000);
  await assert.rejects(() => client.initialize(), (e) => e instanceof AcpProtocolError && e.code === "ACP_VERSION_MISMATCH");
  await client.proc.stop();
});

test("malformed frame fails pending calls", async () => {
  const { handlers } = collect();
  const client = new AcpClient(spawnFake("badjson"), handlers, "interactive", 5000);
  await client.initialize();
  const sid = await client.newSession("/tmp");
  await assert.rejects(() => client.prompt(sid, "hi", 5000), AcpProtocolError);
  await client.proc.stop();
});

test("oversized unterminated frame kills the peer", async () => {
  const { handlers } = collect();
  const proc = spawnFake("oversize");
  const client = new AcpClient(proc, handlers, "interactive", 5000);
  await client.initialize();
  const sid = await client.newSession("/tmp");
  await assert.rejects(() => client.prompt(sid, "hi", 5000));
  await proc.stop();
});

test("interactive permission: same-id selected allow_once", async () => {
  const { handlers, c } = collect();
  const client = new AcpClient(spawnFake("permission"), handlers, "interactive", 5000);
  await client.initialize();
  const sid = await client.newSession("/tmp");
  const p = client.prompt(sid, "do it", 8000);
  // wait for the permission request to surface
  for (let i = 0; i < 200 && !c.permissions.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(c.permissions.length, 1);
  assert.deepEqual(c.permissions[0]!.options.map((o) => o.id), ["allow-once", "reject-once"]);
  // native ACP kinds retained separately from the opaque optionId
  assert.deepEqual(c.permissions[0]!.options.map((o) => o.native_kind), ["allow_once", "reject_once"]);
  assert.deepEqual(c.permissions[0]!.options.map((o) => o.kind), ["allow", "reject"]);
  assert.equal(client.decidePermissionOutcome(c.permissions[0]!.requestId, "allow_once"), true);
  const out = await p;
  assert.equal(out.stopReason, "end_turn");
  assert.equal(c.tools.find((t) => t.callId === "call_9")?.status, "ok");
  await client.proc.stop();
});

test("deny-mode permission auto-rejects, never auto-allows", async () => {
  const { handlers, c } = collect();
  const client = new AcpClient(spawnFake("permission"), handlers, "deny", 5000);
  await client.initialize();
  const sid = await client.newSession("/tmp");
  const out = await client.prompt(sid, "do it", 8000);
  assert.equal(out.stopReason, "end_turn");
  // fixture maps reject/cancelled to failed tool status
  assert.equal(c.tools.find((t) => t.callId === "call_9")?.status, "error");
  await client.proc.stop();
});

test("unsupported agent->client methods are refused and turn continues", async () => {
  const { handlers, c } = collect();
  const client = new AcpClient(spawnFake("fs-request"), handlers, "interactive", 5000);
  await client.initialize();
  const sid = await client.newSession("/tmp");
  const out = await client.prompt(sid, "hi", 8000);
  assert.equal(out.stopReason, "end_turn");
  assert.equal(c.text, "answered");
  await client.proc.stop();
});

test("session/cancel waits for real stopReason cancelled", async () => {
  const { handlers } = collect();
  const client = new AcpClient(spawnFake("slow"), handlers, "interactive", 5000);
  await client.initialize();
  const sid = await client.newSession("/tmp");
  const p = client.prompt(sid, "work", 20000);
  await new Promise((r) => setTimeout(r, 150));
  await client.requestCancel(sid);
  const out = await p;
  assert.equal(out.stopReason, "cancelled");
  assert.equal(out.cancelledConfirmed, true);
  await client.proc.stop();
});

test("ignored session/cancel -> remote cancel unknown", async () => {
  const { handlers } = collect();
  const client = new AcpClient(spawnFake("cancel-ignore"), handlers, "interactive", 5000);
  await client.initialize();
  const sid = await client.newSession("/tmp");
  const p = client.prompt(sid, "work", 20000);
  await client.requestCancel(sid);
  const out = await p;
  assert.equal(out.stopReason, "end_turn");
  assert.equal(out.cancelledConfirmed, false); // remote cancel NOT confirmed
  await client.proc.stop();
});

test("agent_thought_chunk and plan never leak into text", async () => {
  const { handlers, c } = collect();
  const client = new AcpClient(spawnFake("thought"), handlers, "interactive", 5000);
  await client.initialize();
  const sid = await client.newSession("/tmp");
  await client.prompt(sid, "hi", 5000);
  assert.equal(c.text, "visible");
  assert.ok(!c.text.includes("SECRET"));
  await client.proc.stop();
});

test("usage_update is context window only, cumulative", async () => {
  const { handlers, c } = collect();
  const client = new AcpClient(spawnFake("usage"), handlers, "interactive", 5000);
  await client.initialize();
  const sid = await client.newSession("/tmp");
  await client.prompt(sid, "hi", 5000);
  assert.deepEqual(c.context, [{ used: 53000, size: 200000, cost_amount: 0.045, currency: "USD" }]);
  await client.proc.stop();
});

test("stderr flood does not deadlock the run", async () => {
  const { handlers, c } = collect();
  const client = new AcpClient(spawnFake("text", { FAKE_FLOOD_STDERR: "1" }), handlers, "interactive", 5000);
  await client.initialize();
  const sid = await client.newSession("/tmp");
  const out = await client.prompt(sid, "hi", 10000);
  assert.equal(out.stopReason, "end_turn");
  assert.equal(c.text, "Hello world");
  await client.proc.stop();
});

test("null JSON frame is a malformed-envelope protocol failure, not ignored", async () => {
  const { handlers } = collect();
  const client = new AcpClient(spawnFake("nullframe"), handlers, "interactive", 5000);
  await client.initialize();
  const sid = await client.newSession("/tmp");
  // strict malformed handling: a bare `null` envelope is not valid JSON-RPC
  await assert.rejects(() => client.prompt(sid, "hi", 5000), AcpProtocolError);
  await client.proc.stop();
});

test("SIGTERM-resistant leader escalates to SIGKILL; stubborn descendant detected", { timeout: 15000 }, async () => {
  const { handlers } = collect();
  const proc = spawnFake("hang", { FAKE_IGNORE_SIGTERM: "1", FAKE_SPAWN_CHILD: "1" });
  const client = new AcpClient(proc, handlers, "interactive", 5000);
  await client.initialize();
  const sid = await client.newSession("/tmp");
  const p = client.prompt(sid, "work", 30000);
  p.catch(() => {});
  // descendant is a live group member while leader runs
  assert.ok(proc.survivors().length >= 1);
  const t0 = Date.now();
  await proc.stop("SIGKILL", 300);
  assert.ok(Date.now() - t0 >= 300, "TERM grace must elapse before KILL");
  assert.equal(proc.killedByUs, true);
  assert.ok(proc.exitSignal !== null || proc.exitCode !== null);
  await p.catch(() => {});
});

test("classifyRun maps stopReasons conservatively", () => {
  const none = { ranMutating: false, anyTool: false, anyDenied: false };
  assert.deepEqual(AcpClient.classifyRun("end_turn", none), { outcome: "completed", status: "completed", sideEffects: "none", retrySafety: "unknown" });
  assert.equal(AcpClient.classifyRun("refusal", none).status, "blocked");
  assert.equal(AcpClient.classifyRun("max_tokens", none).status, "partial");
  assert.equal(AcpClient.classifyRun("cancelled", none).outcome, "cancelled");
  assert.equal(AcpClient.classifyRun("something-new", none).status, "unknown");
  const denied = { ranMutating: false, anyTool: true, anyDenied: true };
  assert.equal(AcpClient.classifyRun("end_turn", denied).status, "partial");
});
