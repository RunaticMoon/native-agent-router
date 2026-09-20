import { test } from "node:test";
import assert from "node:assert/strict";
import { LineDecoder, ProtocolBoundError } from "../src/native/wire.js";
import { versionInRange } from "../src/native/plugin.js";

test("decoder handles fragmented frames across chunk boundaries", () => {
  const d = new LineDecoder();
  const frame = JSON.stringify({ a: 1, b: "x".repeat(100) });
  const out: string[] = [];
  const buf = Buffer.from(frame + "\n" + frame + "\n");
  out.push(...d.push(buf.subarray(0, 10)));
  out.push(...d.push(buf.subarray(10, 60)));
  out.push(...d.push(buf.subarray(60)));
  assert.equal(out.length, 2);
  assert.deepEqual(JSON.parse(out[0]!), { a: 1, b: "x".repeat(100) });
});

test("decoder enforces byte cap BEFORE newline arrives", () => {
  const d = new LineDecoder(1024, 16 * 1024 * 1024);
  // 2KB with no newline -> must throw even though no '\n' was seen
  assert.throws(() => d.push(Buffer.alloc(2048, 0x79)), ProtocolBoundError);
});

test("decoder enforces per-frame cap on terminated frame", () => {
  const d = new LineDecoder(64, 16 * 1024 * 1024);
  assert.throws(() => d.push(Buffer.concat([Buffer.alloc(100, 0x79), Buffer.from("\n")])), ProtocolBoundError);
});

test("decoder enforces total stream cap", () => {
  const d = new LineDecoder(4096, 2048);
  d.push(Buffer.from("a".repeat(1500) + "\n"));
  assert.throws(() => d.push(Buffer.from("b".repeat(1000))), ProtocolBoundError);
});

test("flush returns unterminated trailing data", () => {
  const d = new LineDecoder();
  assert.deepEqual(d.push(Buffer.from("abc")), []);
  assert.equal(d.flush(), "abc");
  assert.equal(d.flush(), null);
});

test("versionInRange", () => {
  assert.equal(versionInRange("3000.10.31", ">=3000.0.0 <3001.0.0"), true);
  assert.equal(versionInRange("3001.0.0", ">=3000.0.0 <3001.0.0"), false);
  assert.equal(versionInRange("1.2.6", ">=1.2.0 <1.3.0"), true);
  assert.equal(versionInRange("1.2.6", "1.2.6"), true);
  assert.equal(versionInRange("garbage", ">=1.0.0"), false);
});
