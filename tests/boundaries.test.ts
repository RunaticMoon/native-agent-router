// Boundary rows: env-name denylisting, atomic capacity pools, approval
// concurrency, secret redaction, artifact reference validation.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../src/storage/store.js";
import { Registry } from "../src/registry/registry.js";
import { ApprovalBroker } from "../src/approval/broker.js";
import { validateArtifactRef } from "../src/runtime/runtime.js";
import { redactText } from "../src/decisions/jev.js";
import { writeFixtureManifest } from "../src/bootstrap.js";

test("env: manifest requesting credential-class names never loads", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "envdeny-"));
  try {
    const mdir = path.join(tmp, "m");
    const mp = writeFixtureManifest(mdir);
    for (const denied of ["JEV_API_KEY", "ROUTER_TOKEN", "OPENAI_API_KEY"]) {
      const m = JSON.parse(fs.readFileSync(mp, "utf8"));
      m.plugin_id = `evil-${denied.toLowerCase().replace(/_/g, "-")}`;
      m.required_env = [denied];
      fs.writeFileSync(path.join(mdir, `${m.plugin_id}.manifest.json`), JSON.stringify(m));
    }
    const reg = new Registry();
    reg.load([mdir]);
    assert.equal(reg.plugins.size, 1); // only the honest fixture loaded
    assert.equal(reg.errors.length, 3);
    assert.match(reg.errors[0]!.error, /denied env/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("capacity: multi-pool reservation is atomic and bounded", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cap-"));
  try {
    const store = new Store(path.join(tmp, "x.db"));
    const pools = [
      { key: "plugin:p1", max: 1 },
      { key: "profile:default", max: 2 },
      { key: "workspace:/w", max: 1 },
    ];
    const r1 = store.reserveCapacityMulti(pools, "a1", "j1");
    assert.ok(r1, "first reservation holds");
    // second attempt: plugin+workspace pools full -> NO partial reservation
    const r2 = store.reserveCapacityMulti(pools, "a2", "j2");
    assert.equal(r2, null);
    const held = store.reservationsForAttempt("a2");
    assert.equal(held.length, 0, "failed reservation left no partial holds");
    // release -> slot frees
    store.releaseCapacity(r1![0]!);
    store.releaseCapacity(r1![1]!);
    store.releaseCapacity(r1![2]!);
    const r3 = store.reserveCapacityMulti(pools, "a3", "j3");
    assert.ok(r3);
    store.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("approval: concurrent decisions resolve exactly once (first wins)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "appr-"));
  try {
    const store = new Store(path.join(tmp, "x.db"));
    const broker = new ApprovalBroker(store);
    const emitted: unknown[] = [];
    broker.on("decided:run1:nr1", (d) => emitted.push(d));
    const id = broker.request({
      job_id: "j1", attempt_id: "a1", run_id: "run1", native_request_id: "nr1",
      action: "fs_write", target: "/x", options: ["allow-once", "reject-once"],
    });
    const [r1, r2] = await Promise.all([
      Promise.resolve(broker.decide(id, "op1", "allow-once", "j1")),
      Promise.resolve(broker.decide(id, "op2", "reject-once", "j1")),
    ]);
    const statuses = [r1.status, r2.status].sort();
    assert.deepEqual(statuses, ["already", "approved"]);
    assert.equal(emitted.length, 1);
    // non-offered option is invalid even on a fresh approval
    const id2 = broker.request({
      job_id: "j1", attempt_id: "a1", run_id: "run2", native_request_id: "nr2",
      action: "fs_write", target: "/x", options: ["allow-once"],
    });
    assert.equal(broker.decide(id2, "op", "invented-option", "j1").status, "invalid");
    store.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("redaction: secret shapes never reach events/results/errors", () => {
  assert.equal(redactText("key is sk-abc123def456ghi"), "key is [REDACTED]");
  assert.equal(redactText("token Bearer abc.def.ghi"), "token [REDACTED]");
  assert.equal(redactText("aws AKIA1234567890ABCDEF here"), "aws [REDACTED] here");
  assert.match(redactText("pem -----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY----- end"), /\[REDACTED\] end/);
  assert.equal(redactText("plain text"), "plain text");
});

test("artifacts: only real non-credential files under the job workspace", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "art-"));
  try {
    const ws = path.join(tmp, "ws");
    fs.mkdirSync(ws);
    const good = path.join(ws, "out.txt");
    fs.writeFileSync(good, "ok");
    assert.equal(validateArtifactRef(ws, good), fs.realpathSync(good));
    // escape outside workspace
    const outside = path.join(tmp, "secret.txt");
    fs.writeFileSync(outside, "no");
    assert.equal(validateArtifactRef(ws, outside), null);
    // credentials-type file inside workspace still refused
    const cred = path.join(ws, "id_rsa");
    fs.writeFileSync(cred, "no");
    assert.equal(validateArtifactRef(ws, cred), null);
    const dotenv = path.join(ws, ".env");
    fs.writeFileSync(dotenv, "x=1");
    assert.equal(validateArtifactRef(ws, dotenv), null);
    // nonexistent ref
    assert.equal(validateArtifactRef(ws, path.join(ws, "nope")), null);
    // directory is not an artifact file
    assert.equal(validateArtifactRef(ws, ws), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
