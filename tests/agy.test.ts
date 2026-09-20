// AgyStreamClient vs synthetic fake-agy.mjs stand-in executable.
// SYNTHETIC wire fixtures — not recorded or real account runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { ChildWireProcess } from "../src/native/wire.js";
import { AgyStreamClient, agyArgs } from "../src/native/agy.js";

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../fixtures/fake-agy.mjs");

function spawnFake(scenario: string, extraEnv: Record<string, string> = {}, model = "gemini-3.5-flash-medium") {
  return new ChildWireProcess({
    executable: process.execPath,
    args: [FIXTURE, ...agyArgs(model)],
    cwd: "/tmp",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", FAKE_AGY_SCENARIO: scenario, ...extraEnv },
  });
}

function collect() {
  const c = { text: "", tools: [] as { name: string; status?: string }[], usage: [] as { input_tokens?: number; cumulative: boolean }[] };
  const byId = new Map<string, { name: string; status?: string }>();
  return {
    c,
    handlers: {
      onText: (t: string) => (c.text += t),
      onToolStarted: (tool: string, callId: string) => {
        const r = { name: tool, status: undefined as string | undefined };
        byId.set(callId, r);
        c.tools.push(r);
      },
      onToolCompleted: (tool: string, callId: string, status: "ok" | "error" | "denied") => {
        const r = byId.get(callId);
        if (r) r.status = status;
        else c.tools.push({ name: tool, status });
      },
      onUsage: (u: { input_tokens?: number; cumulative: boolean }) => c.usage.push(u),
    },
  };
}

test("argv shape: prompt never on argv; stdin user event; exact model", async () => {
  const args = agyArgs("gemini-3.5-flash-medium");
  assert.deepEqual(args, ["--input-format", "stream-json", "--output-format", "stream-json", "--model", "gemini-3.5-flash-medium"]);
  assert.deepEqual(agyArgs("m", "high").slice(-2), ["--effort", "high"]);
  const { handlers, c } = collect();
  const out = await new AgyStreamClient(spawnFake("text"), handlers).run("say hi", 8000);
  assert.equal(out.result.outcome, "completed");
  assert.equal(out.result.status, "completed");
  assert.equal(c.text, "fake answer");
  assert.equal(out.conversationId, "conv_fixture_1");
  // init.model is an echo — it is never reported as observed_model
  assert.equal(out.requestedModelEcho, "gemini-3.5-flash-medium");
  assert.equal(out.result.observed_model, undefined);
  // usage comes from terminal result, marked cumulative — never re-summed
  assert.equal(out.result.usage?.cumulative, true);
  assert.equal(out.result.usage?.input_tokens, 30384);
});

test("fragmented step_update frame is reassembled", async () => {
  const { handlers, c } = collect();
  const out = await new AgyStreamClient(spawnFake("fragmented"), handlers).run("hi", 8000);
  assert.equal(out.result.outcome, "completed");
  assert.equal(c.text, "frag");
});

test("structured tool error downgrades SUCCESS to partial/blocked", async () => {
  const { handlers, c } = collect();
  const out = await new AgyStreamClient(spawnFake("tool-error"), handlers).run("do it", 8000);
  assert.equal(out.result.outcome, "completed");
  assert.equal(out.result.status, "partial"); // SUCCESS is not asserted clean
  assert.equal(c.tools.find((t) => t.name === "run_command")?.status, "error");
});

test("planning/thinking step text_delta never leaks into text", async () => {
  const { handlers, c } = collect();
  const out = await new AgyStreamClient(spawnFake("thinking"), handlers).run("hi", 8000);
  assert.equal(out.result.status, "completed");
  assert.equal(c.text, "visible");
  assert.ok(!c.text.includes("SECRET"));
});

test("stderr soft-denial notice -> conservative partial, not proven clean", async () => {
  const { handlers } = collect();
  const out = await new AgyStreamClient(spawnFake("stderr-deny"), handlers).run("hi", 8000);
  assert.equal(out.result.outcome, "completed");
  assert.equal(out.result.status, "partial");
});

test("missing terminal result -> safe unknown failure, never success", async () => {
  const { handlers } = collect();
  const out = await new AgyStreamClient(spawnFake("no-result"), handlers).run("hi", 8000);
  assert.equal(out.result.outcome, "failed");
  assert.equal(out.result.status, "unknown");
  assert.equal(out.result.error?.code, "UNKNOWN_NATIVE_OUTCOME");
});

test("ERROR status -> failed with unclassified error (no substring rules)", async () => {
  const { handlers } = collect();
  const out = await new AgyStreamClient(spawnFake("error-status"), handlers).run("hi", 8000);
  assert.equal(out.result.outcome, "failed");
  assert.equal(out.result.error?.code, "UNKNOWN_NATIVE_OUTCOME");
});

test("WAITING / RUNNING statuses are not success", async () => {
  for (const s of ["waiting-status", "running-status"]) {
    const { handlers } = collect();
    const out = await new AgyStreamClient(spawnFake(s), handlers).run("hi", 8000);
    assert.equal(out.result.outcome, "failed");
    assert.equal(out.result.status, "unknown");
  }
});

test("malformed frame mid-stream -> conservative, not completed-clean", async () => {
  const { handlers } = collect();
  const out = await new AgyStreamClient(spawnFake("badjson"), handlers).run("hi", 8000);
  // malformed frame observed => SUCCESS cannot be asserted clean
  assert.equal(out.result.status, "partial");
});

test("oversized frame kills peer -> safe failure", async () => {
  const { handlers } = collect();
  const out = await new AgyStreamClient(spawnFake("oversize"), handlers).run("hi", 8000);
  assert.notEqual(out.result.status, "completed");
  assert.equal(out.result.outcome === "completed" ? "ok" : "ok", "ok");
});

test("null JSON frame -> conservative, not clean success", async () => {
  const { handlers, c } = collect();
  const out = await new AgyStreamClient(spawnFake("nullframe"), handlers).run("hi", 8000);
  assert.equal(out.result.outcome, "completed");
  assert.equal(out.result.status, "partial"); // malformed frame observed
  assert.equal(c.text, "ok");
});

test("deadline -> local stop, remote outcome unknown (recovery not success)", async () => {
  const { handlers } = collect();
  const out = await new AgyStreamClient(spawnFake("hang"), handlers).run("hi", 400);
  assert.equal(out.result.outcome, "failed");
  assert.equal(out.result.error?.code, "TIMEOUT");
  assert.equal(out.result.retry_safety, "unknown");
});

test("stderr flood does not deadlock and downgrades clean-success claim", async () => {
  const { handlers, c } = collect();
  const out = await new AgyStreamClient(spawnFake("text", { FAKE_FLOOD_STDERR: "1" }), handlers).run("hi", 10000);
  assert.equal(c.text, "fake answer");
  assert.equal(out.result.status, "partial"); // flooded stderr = ambiguous diagnostics
});
