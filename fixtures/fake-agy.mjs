#!/usr/bin/env node
// SYNTHETIC FIXTURE — not a real provider. Speaks agy stream-json
// (event: init/step_update/result). Scenario via FAKE_AGY_SCENARIO.
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const scenario = process.env.FAKE_AGY_SCENARIO || "text";
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cid = "conv_fixture_1";
const model = flag("--model", undefined);

if (args.includes("--version")) {
  process.stdout.write("agy 1.2.6\n");
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

emit({
  event: "init",
  conversation_id: cid,
  init: {
    cwd: process.cwd(),
    tools: ["ask_permission", "run_command", "write_to_file"],
    permission_mode: "request-review",
    ...(model ? { model } : {}),
  },
});

const usage = { input_tokens: 30384, output_tokens: 4, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 30388 };
const step = (i, state, type, extra = {}) => emit({ event: "step_update", step_update: { conversation_id: cid, step_index: i, state, step_type: type, ...extra } });
const result = (status, extra = {}) => emit({ event: "result", result: { conversation_id: cid, status, response: "", duration_seconds: 1.0, num_turns: 1, usage, ...extra } });

async function turn() {
  switch (scenario) {
    case "nullframe":
      process.stdout.write("null\n");
      step(0, "DONE", "user_input");
      step(1, "DONE", "agent_response", { text_delta: "ok" });
      return result("SUCCESS", { response: "ok" });
    case "text":
      step(0, "DONE", "user_input");
      step(1, "ACTIVE", "agent_response", { text_delta: "fake " });
      step(1, "DONE", "agent_response", { text_delta: "answer" });
      return result("SUCCESS", { response: "fake answer" });
    case "fragmented": {
      step(0, "DONE", "user_input");
      const f = JSON.stringify({ event: "step_update", step_update: { conversation_id: cid, step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "frag" } }) + "\n";
      process.stdout.write(f.slice(0, 30));
      await sleep(10);
      process.stdout.write(f.slice(30));
      return result("SUCCESS", { response: "frag" });
    }
    case "tool-error":
      step(0, "DONE", "user_input");
      step(1, "ACTIVE", "tool", { tool_name: "run_command" });
      step(1, "DONE", "tool", { tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "rm -rf /" }, error: { type: "denied", message: "soft denied" } } });
      step(2, "DONE", "agent_response", { text_delta: "could not run" });
      return result("SUCCESS", { response: "could not run" });
    case "thinking":
      step(0, "DONE", "user_input");
      step(1, "DONE", "planning", { text_delta: "SECRET-PLAN" });
      step(2, "DONE", "thinking", { text_delta: "SECRET-THINK" });
      step(3, "DONE", "agent_response", { text_delta: "visible" });
      return result("SUCCESS", { response: "visible" });
    case "stderr-deny":
      step(0, "DONE", "user_input");
      step(1, "DONE", "agent_response", { text_delta: "partial work" });
      process.stderr.write("notice: tool run_command requires permission; add permissions.allow rule\n");
      return result("SUCCESS", { response: "partial work" });
    case "no-result":
      step(0, "DONE", "user_input");
      step(1, "DONE", "agent_response", { text_delta: "hi" });
      return; // exit without terminal result
    case "error-status":
      return result("ERROR", { response: "", error: "upstream exploded" });
    case "waiting-status":
      return result("WAITING", { response: "" });
    case "running-status":
      return result("RUNNING", { response: "" });
    case "badjson":
      process.stdout.write("not json{\n");
      return result("SUCCESS", { response: "after bad line" });
    case "oversize":
      process.stdout.write(JSON.stringify({ pad: "y".repeat(2 * 1024 * 1024) }) + "\n");
      return result("SUCCESS", { response: "after oversize" });
    case "slow":
      for (let i = 0; i < 200; i++) {
        step(i, "ACTIVE", "agent_response", { text_delta: "tick " });
        await sleep(50);
      }
      return result("SUCCESS", { response: "done" });
    case "hang":
      await new Promise((r) => setTimeout(r, 120000));
      return;
    default:
      return result("SUCCESS", { response: "default" });
  }
}

let buf = "";
let done = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim() || done) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      result("ERROR", { error: "invalid input" });
      done = true;
      process.exit(1);
    }
    if (msg.event !== "user") {
      process.stderr.write(`warning: ignoring unsupported stream input message event "${msg.event}"\n`);
      continue;
    }
    done = true;
    if (model === "bad-model") {
      result("ERROR", { error: `invalid model selection: model ${model} is not recognized` });
      process.exit(1);
    }
    await turn();
    process.stdin.once("data", () => {});
    process.exit(0);
  }
});
process.stdin.on("end", async () => {
  if (!done) process.exit(1);
});
