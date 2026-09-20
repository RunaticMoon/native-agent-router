// Stream redaction: secret-shaped tokens must never leak a suffix across
// arbitrary delta boundaries. Token units are redacted BEFORE release with a
// bounded carry; overlong secret runs are dropped wholesale. This is bounded
// best-effort redaction of known shapes + configured exact values — not DLP.
import test from "node:test";
import assert from "node:assert/strict";
import { DeltaRedactor } from "../src/runtime/redactor.js";
import { makeEnv, submitAndWait, sseCollect } from "./helpers.js";

const MARKER = "sk-" + "Q".repeat(90);

function drain(r: DeltaRedactor, chunks: string[]): string {
  let out = "";
  for (const c of chunks) out += r.feed(c);
  out += r.flush();
  return out;
}

test("redactor: complete token units redacted at every split offset", () => {
  for (let i = 1; i < MARKER.length; i++) {
    const r = new DeltaRedactor();
    const out = drain(r, [MARKER.slice(0, i), MARKER.slice(i)]);
    assert.equal(out.includes("Q".repeat(30)), false, `split at ${i} leaked suffix`);
    assert.equal(out.includes("sk-"), false, `split at ${i} leaked prefix`);
  }
});

test("redactor: secret embedded in surrounding text", () => {
  const r = new DeltaRedactor();
  const out = drain(r, [`prefix ${MARKER} suffix`]);
  assert.match(out, /^prefix \[REDACTED\] suffix$/);
});

test("redactor: overlong token run is dropped, carry bounded", () => {
  const r = new DeltaRedactor();
  const big = "sk-" + "Z".repeat(100_000);
  let out = "";
  for (let i = 0; i < big.length; i += 1000) out += r.feed(big.slice(i, i + 1000));
  out += r.feed(" done");
  out += r.flush();
  assert.equal(out.includes("Z".repeat(30)), false);
  assert.ok(out.length < 1000, `output not bounded: ${out.length}`);
  assert.ok(out.includes("[REDACTED]"));
});

test("redactor: token chars keep dropping after overlong run", () => {
  const r = new DeltaRedactor();
  const big = "sk-" + "K".repeat(20_000);
  // feed in two halves; after drop-mode engages, remaining token chars must
  // not re-emerge as a fresh "unknown" tail
  const out = drain(r, [big.slice(0, 15_000), big.slice(15_000), "|tail"]);
  assert.equal(out.includes("K".repeat(30)), false);
  assert.ok(out.includes("|tail"));
});

test("redactor: exact known in-memory secret redacted across boundary", () => {
  const secret = "rt-" + "a1b2c3".repeat(8);
  for (let i = 1; i < secret.length; i += 7) {
    const r = new DeltaRedactor([secret]);
    const out = drain(r, [`tok=${secret.slice(0, i)}`, secret.slice(i) + "!"]);
    assert.equal(out.includes(secret.slice(4, 40)), false, `split ${i} leaked`);
    assert.ok(out.includes("[REDACTED]"));
  }
});

test("redactor: non-secret text passes through unchanged", () => {
  const r = new DeltaRedactor();
  const s = "ordinary text with-model names and numbers 12345";
  assert.equal(drain(r, [s]), s);
});

test("redactor: multi-char token boundary split inside prefix", () => {
  const r = new DeltaRedactor();
  const out = drain(r, ["s", "k", "-", "Q".repeat(90), " rest"]);
  assert.equal(out.includes("Q".repeat(30)), false);
  assert.ok(out.includes("[REDACTED]"));
});

// Parent reproduction: marker as job task -> persisted+replayed SSE events
// must never contain a 30-char suffix of the token.
test("e2e: streamed secret-shape marker cannot leak suffix into SSE events", async () => {
  const env = await makeEnv();
  try {
    const { jobId } = await submitAndWait(env, { task: MARKER, role: "coding", policy: "default", workspace: { mode: "fresh" } });
    const events = await sseCollect(env, jobId);
    const all = JSON.stringify(events);
    assert.equal(all.includes("Q".repeat(30)), false, "long token suffix exposed in persisted/replayed events");
    assert.equal(all.includes(MARKER), false, "full marker exposed");
  } finally {
    await env.cleanup();
  }
});
