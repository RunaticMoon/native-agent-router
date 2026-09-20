#!/usr/bin/env node
// SYNTHETIC FIXTURE — not a real provider. Speaks ACP v1 JSON-RPC on
// stdin/stdout like `devin acp`. Scenario selected via FAKE_ACP_SCENARIO.
// Never contacts any account or network.
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const scenario = process.env.FAKE_ACP_SCENARIO || "text";
const send = (o, cb) => process.stdout.write(JSON.stringify(o) + "\n", cb);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (args.includes("--version") || args.includes("version")) {
  process.stdout.write("devin 3000.10.31\n");
  process.exit(0);
}

if (process.env.FAKE_FLOOD_STDERR) {
  const chunk = "x".repeat(65536);
  for (let i = 0; i < 48; i++) process.stderr.write(chunk);
}
if (process.env.FAKE_IGNORE_SIGTERM) process.on("SIGTERM", () => {});
if (process.env.FAKE_SPAWN_CHILD) {
  const c = spawn("sleep", ["30"], { stdio: "ignore" });
  c.unref();
}

const sessionId = "sess_fixture_1";
let promptId = null;
let cancelled = false;
const pendingReqs = new Map();
let nextAgentReqId = 1000;

const update = (u) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
const chunk = (text) =>
  update({ sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text } });

async function runPrompt(id) {
  promptId = id;
  switch (scenario) {
    case "nullframe":
      process.stdout.write("null\n");
      chunk("ok");
      return send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    case "text":
      chunk("Hello ");
      // exercise fragmented delivery: split one frame across writes
      {
        const f = JSON.stringify({
          jsonrpc: "2.0", method: "session/update",
          params: { sessionId, update: { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "world" } } },
        }) + "\n";
        process.stdout.write(f.slice(0, 40));
        await sleep(10);
        process.stdout.write(f.slice(40));
      }
      return send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    case "tools":
      update({ sessionUpdate: "tool_call", toolCallId: "call_1", name: "run_command", title: "Run command", kind: "execute", status: "pending" });
      update({ sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "in_progress" });
      update({ sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "completed" });
      chunk("done");
      return send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    case "permission": {
      update({ sessionUpdate: "tool_call", toolCallId: "call_9", name: "run_command", title: "Run command", kind: "execute", status: "pending" });
      const rid = nextAgentReqId++;
      send({
        jsonrpc: "2.0", id: rid, method: "session/request_permission",
        params: {
          sessionId,
          toolCall: { toolCallId: "call_9", title: "Run command", kind: "execute" },
          options: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          ],
        },
      });
      const outcome = (await new Promise((r) => pendingReqs.set(rid, r)))?.outcome;
      if (outcome?.outcome === "selected" && outcome.optionId === "allow-once") {
        update({ sessionUpdate: "tool_call_update", toolCallId: "call_9", status: "completed" });
      } else {
        update({ sessionUpdate: "tool_call_update", toolCallId: "call_9", status: "failed" });
      }
      chunk("after-permission");
      return send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    }
    case "usage":
      update({ sessionUpdate: "usage_update", used: 53000, size: 200000, cost: { amount: 0.045, currency: "USD" } });
      chunk("ok");
      return send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    case "thought":
      update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "SECRET-THOUGHT" } });
      update({ sessionUpdate: "plan", entries: [{ content: "p", priority: "high", status: "pending" }] });
      chunk("visible");
      return send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    case "fs-request": {
      const rid = nextAgentReqId++;
      send({ jsonrpc: "2.0", id: rid, method: "fs/read_text_file", params: { sessionId, path: "/etc/passwd" } });
      await new Promise((r) => pendingReqs.set(rid, r));
      chunk("answered");
      return send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    }
    case "slow":
      for (let i = 0; i < 100; i++) {
        if (cancelled) return send({ jsonrpc: "2.0", id, result: { stopReason: "cancelled" } });
        chunk("tick ");
        await sleep(50);
      }
      return send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    case "cancel-ignore":
      await sleep(400);
      return send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } }); // remote cancel ignored
    case "hang":
      return; // never resolves; cancel/timeout exercises this
    case "oversize":
      process.stdout.write(JSON.stringify({ pad: "y".repeat(2 * 1024 * 1024) }) + "\n");
      return send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    case "badjson":
      process.stdout.write("not json{\n");
      return send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    case "exit-before-prompt":
      process.exit(0);
      return;
    default:
      chunk("default");
      return send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if ("id" in msg && ("result" in msg || "error" in msg)) {
      const r = pendingReqs.get(msg.id);
      if (r) {
        pendingReqs.delete(msg.id);
        r(msg.error ? { outcome: "cancelled" } : msg.result);
      }
      continue;
    }
    if (msg.method === "initialize") {
      if (scenario === "version-mismatch") {
        send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 99, agentCapabilities: {}, agentInfo: { name: "affogato" } } });
      } else {
        send({
          jsonrpc: "2.0", id: msg.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true } },
            agentInfo: { name: "affogato", title: "Devin Agent", version: "0.0.0-dev" },
            authMethods: [],
          },
        });
      }
    } else if (msg.method === "session/new") {
      send({ jsonrpc: "2.0", id: msg.id, result: { sessionId } });
    } else if (msg.method === "session/prompt") {
      void runPrompt(msg.id);
    } else if (msg.method === "session/cancel") {
      cancelled = true;
      if (scenario === "slow" && promptId != null) {
        send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "cancelled" } });
        promptId = null;
      }
    } else if ("id" in msg) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "fixture: unknown method" } });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
