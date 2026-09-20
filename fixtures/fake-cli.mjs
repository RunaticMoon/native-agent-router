#!/usr/bin/env node
// SYNTHETIC FIXTURE CLI — not a real provider. Speaks NDJSON on stdout,
// `event` discriminator, similar shape to a native stream-json CLI.
// Used only by the example plugin + tests. Never contacts any account.
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const has = (n) => args.includes(n);
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (has("--version")) {
  emit({ event: "version", version: "1.2.0" });
  process.exit(0);
}

const prompt = flag("--prompt", "");
const model = flag("--model", "fake-small");
const mode = flag("--mode", "agent");
const delayMs = Number(flag("--delay-ms", "30"));
const sessionId = randomUUID();
// behavior models: beh-<name> drives fixture failure/edge modes via catalog identity
const beh = model.startsWith("beh-") ? model.slice(4) : "";
const behIs = (n) => beh === n || has(`--${n}`);

if (behIs("ignore-sigterm")) process.on("SIGTERM", () => {});
if (behIs("spawn-child")) {
  // stubborn descendant in same process group; survives leader exit
  const c = spawn("sleep", [flag("--spawn-child", "30")], { stdio: "ignore" });
  c.unref();
}
if (behIs("flood-stderr")) {
  const mb = Number(flag("--flood-stderr", "2"));
  const chunk = "x".repeat(65536);
  for (let i = 0; i < mb * 16; i++) process.stderr.write(chunk);
}

emit({ event: "init", conversation_id: sessionId, model });

if (behIs("hang")) {
  setInterval(() => {}, 1 << 30);
} else {
  const run = async () => {
    if (behIs("permission") || behIs("permission-allowonly")) {
      const reqId = randomUUID();
      emit({
        event: "permission_request",
        request_id: reqId,
        action: flag("--require-permission", "run_command"),
        target: prompt.slice(0, 80),
        // allowonly offers NO reject/cancel option — a non-approved decision
        // can only become the native cancelled outcome, never an allow.
        options: behIs("permission-allowonly")
          ? [{ id: "allow-once", kind: "allow", native_kind: "allow_once" }]
          : ["allow", "deny"],
      });
      const decision = await new Promise((resolve) => {
        let buf = "";
        const timer = setTimeout(() => resolve("deny"), 20000);
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (c) => {
          buf += c;
          const idx = buf.indexOf("\n");
          if (idx >= 0) {
            try {
              const m = JSON.parse(buf.slice(0, idx));
              if (m.type === "permission_response" && m.request_id === reqId) {
                clearTimeout(timer);
                resolve(m.decision);
              }
            } catch {}
          }
        });
      });
      if (decision !== "allow") {
        emit({ event: "result", status: "blocked", response: "permission denied", usage: { input_tokens: 5, output_tokens: 0, cumulative: true }, observed_model: model, side_effects: "none" });
        process.exit(0);
      }
      emit({ event: "step_update", step_type: "tool_call", state: "started", tool_info: { name: "shell", call_id: "c1" } });
      await sleep(10);
      emit({ event: "step_update", step_type: "tool_call", state: "completed", tool_info: { name: "shell", call_id: "c1" }, status: "ok" });
    }

    if (mode === "agent") {
      emit({ event: "step_update", step_type: "tool_call", state: "started", tool_info: { name: "write_file", call_id: "t1" } });
      await sleep(delayMs);
      emit({ event: "step_update", step_type: "tool_call", state: "completed", tool_info: { name: "write_file", call_id: "t1" }, status: "ok" });
    }
    for (const part of ["Working on: ", prompt.slice(0, 120), " — done."]) {
      emit({ event: "text_delta", text: part });
      await sleep(2);
    }
    emit({ event: "usage", usage: { input_tokens: 100, output_tokens: 25, cumulative: true } });

    if (beh.startsWith("fail") || has("--fail")) {
      const code = beh.startsWith("fail-") ? beh.slice(5).toUpperCase() : beh === "fail" ? "RATE_LIMITED" : flag("--fail", "RATE_LIMITED");
      emit({ event: "result", status: "error", response: "", error_code: code, usage: { input_tokens: 100, output_tokens: 25, cumulative: true }, observed_model: model, side_effects: flag("--side-effects", "none") });
      process.exit(1);
    }
    if (behIs("exit-nonzero")) process.exit(3);
    const status = behIs("soft-deny") ? "blocked" : behIs("partial") ? "partial" : "success";
    emit({
      event: "result",
      status,
      response: `completed: ${prompt.slice(0, 200)}`,
      usage: { input_tokens: 100, output_tokens: 25, cumulative: true },
      observed_model: model,
      side_effects: behIs("side-effects-unknown") ? "unknown" : (behIs("side-effects-none") || behIs("soft-deny") || behIs("partial")) ? "none" : flag("--side-effects", mode === "agent" ? "present" : "none"),
    });
    process.exit(0);
  };
  void run();
}
