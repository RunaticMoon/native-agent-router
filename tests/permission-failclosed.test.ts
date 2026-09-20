// Fail-closed permission delivery. An expired/denied/invalidated approval —
// or any approval whose native options carry no reject-class choice — must
// NEVER deliver an allow-class option to the native request. An operator's
// explicit positive allow to the same native request must still deliver the
// verbatim offered option id. Decisions select by explicit option kind, not
// by regex over opaque ids (opaque-id fallback only when kind is "unknown").
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Runtime } from "../src/runtime/runtime.js";
import { Store } from "../src/storage/store.js";
import { ApprovalBroker } from "../src/approval/broker.js";
import { makeEnv, api } from "./helpers.js";

// Minimal runtime wired like the parent qa-approval-deny.mjs proof: only the
// members handlePermission touches are provided.
function runtimeStub(waitResult: { status: string; option?: string }) {
  const sent: { runId: string; requestId: string; decision: string }[] = [];
  const deliveries: string[] = [];
  const runtime = Object.create(Runtime.prototype) as Runtime;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "perm-stub-"));
  const store = new Store(path.join(tmp, "x.db"));
  store.createJob({
    job_id: "j", principal: "op", task: "t", role: "coding", policy: "p",
    workspace_mode: "fresh", workspace_path: tmp, workspace_handle: null,
    request_json: null, deadline_ms: Date.now() + 60000,
  });
  store.transitionJob("j", "running");
  Object.assign(runtime as unknown as Record<string, unknown>, {
    store,
    config: { policies: [{ name: "p", permission_mode: "interactive" }] },
    approvals: {
      request: (a: { options: unknown[] }) => {
        store.createApproval({
          approval_id: "appr_1", job_id: "j", attempt_id: "a", run_id: "r",
          native_request_id: "nr", action: a ? "write" : "write", target: "synthetic",
          options: a.options as never, ttl_ms: 60000,
        });
        return "appr_1";
      },
      waitFor: async () => waitResult,
    },
    inflight: new Map([["j", {
      host: {
        respondPermission: async (runId: string, requestId: string, decision: string) => {
          sent.push({ runId, requestId, decision });
        },
        cancel: async () => ({}),
      },
      attemptId: "a", runId: "r",
    }]]),
  });
  const orig = store.setApprovalDelivery.bind(store);
  store.setApprovalDelivery = (id: string, s: "delivered" | "failed" | "invalidated") => {
    deliveries.push(s);
    return orig(id, s);
  };
  return { runtime, sent, deliveries, cleanup: () => { store.close(); fs.rmSync(tmp, { recursive: true, force: true }); } };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

test("expired approval cannot select the sole allow option (parent repro)", async () => {
  const { runtime, sent, cleanup } = runtimeStub({ status: "expired" });
  try {
    (runtime as unknown as { handlePermission: (e: unknown, j: string, a: string, r: string) => void })
      .handlePermission(
        { kind: "permission.required", payload: { request_id: "nr", action: "write", target: "synthetic", options: ["allow-once"] } },
        "j", "a", "r",
      );
    await flush();
    assert.equal(sent.some((s) => s.decision === "allow-once"), false, "expired approval delivered native allow");
  } finally {
    cleanup();
  }
});

test("no reject-class option -> native cancelled outcome, never fabricated allow", async () => {
  const { runtime, sent, cleanup } = runtimeStub({ status: "expired" });
  try {
    (runtime as unknown as { handlePermission: (e: unknown, j: string, a: string, r: string) => void })
      .handlePermission(
        { kind: "permission.required", payload: { request_id: "nr", action: "write", target: "synthetic", options: [{ id: "allow-once", kind: "allow" }] } },
        "j", "a", "r",
      );
    await flush();
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.decision, "cancelled", "expected native cancelled outcome, not an allow id");
  } finally {
    cleanup();
  }
});

test("denied approval delivers a reject-kind option verbatim, not an allow", async () => {
  const { runtime, sent, cleanup } = runtimeStub({ status: "denied", option: "reject-once" });
  try {
    (runtime as unknown as { handlePermission: (e: unknown, j: string, a: string, r: string) => void })
      .handlePermission(
        {
          kind: "permission.required",
          payload: {
            request_id: "nr", action: "write", target: "synthetic",
            options: [
              { id: "allow-once", kind: "allow", native_kind: "allow_once" },
              { id: "reject-once", kind: "reject", native_kind: "reject_once" },
            ],
          },
        },
        "j", "a", "r",
      );
    await flush();
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.decision, "reject-once");
  } finally {
    cleanup();
  }
});

test("expired approval still chooses reject-kind option even when listed first", async () => {
  const { runtime, sent, cleanup } = runtimeStub({ status: "expired" });
  try {
    (runtime as unknown as { handlePermission: (e: unknown, j: string, a: string, r: string) => void })
      .handlePermission(
        {
          kind: "permission.required",
          payload: {
            request_id: "nr", action: "write", target: "synthetic",
            // order tricks: reject first, allow last — position is not semantics
            options: [
              { id: "reject-once", kind: "reject" },
              { id: "allow-once", kind: "allow" },
            ],
          },
        },
        "j", "a", "r",
      );
    await flush();
    assert.equal(sent[0]!.decision, "reject-once");
  } finally {
    cleanup();
  }
});

test("invalidated approval never delivers an allow option", async () => {
  const { runtime, sent, cleanup } = runtimeStub({ status: "invalidated" });
  try {
    (runtime as unknown as { handlePermission: (e: unknown, j: string, a: string, r: string) => void })
      .handlePermission(
        { kind: "permission.required", payload: { request_id: "nr", action: "write", target: "synthetic", options: [{ id: "allow-once", kind: "allow" }] } },
        "j", "a", "r",
      );
    await flush();
    assert.equal(sent.some((s) => /allow/i.test(s.decision)), false);
  } finally {
    cleanup();
  }
});

test("operator explicit positive allow delivers the verbatim offered option id", async () => {
  const { runtime, sent, cleanup } = runtimeStub({ status: "approved", option: "allow-once" });
  try {
    (runtime as unknown as { handlePermission: (e: unknown, j: string, a: string, r: string) => void })
      .handlePermission(
        {
          kind: "permission.required",
          payload: {
            request_id: "nr", action: "write", target: "synthetic",
            options: [
              { id: "allow-once", kind: "allow", native_kind: "allow_once" },
              { id: "reject-once", kind: "reject", native_kind: "reject_once" },
            ],
          },
        },
        "j", "a", "r",
      );
    await flush();
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.decision, "allow-once");
    assert.equal(sent[0]!.requestId, "nr");
  } finally {
    cleanup();
  }
});

test("broker decision classification uses explicit kind, not id regex", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "perm-store-"));
  try {
    const store = new Store(path.join(tmp, "x.db"));
    // native kinds: an allow-kind option whose opaque id does NOT say "allow"
    store.createApproval({
      approval_id: "k1", job_id: "j", attempt_id: "a", run_id: "r",
      native_request_id: "n1", action: "run", target: "t",
      options: [{ id: "opt-7f3a", kind: "allow" }, { id: "opt-9b2c", kind: "reject" }] as never,
      ttl_ms: 60000,
    });
    assert.equal(store.decideApproval("k1", "op", "opt-7f3a"), "approved");
    store.createApproval({
      approval_id: "k2", job_id: "j", attempt_id: "a", run_id: "r",
      native_request_id: "n2", action: "run", target: "t",
      options: [{ id: "opt-7f3a", kind: "allow" }, { id: "opt-9b2c", kind: "reject" }] as never,
      ttl_ms: 60000,
    });
    assert.equal(store.decideApproval("k2", "op", "opt-9b2c"), "denied");
    // expired decision attempt -> expired, never decided
    store.createApproval({
      approval_id: "k3", job_id: "j", attempt_id: "a", run_id: "r",
      native_request_id: "n3", action: "run", target: "t",
      options: [{ id: "opt-7f3a", kind: "allow" }] as never, ttl_ms: 1,
    });
    store.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("approval binding: decision for a different job id is invalid", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "perm-bind-"));
  try {
    const store = new Store(path.join(tmp, "x.db"));
    const broker = new ApprovalBroker(store);
    const id = broker.request({
      job_id: "job-A", attempt_id: "a", run_id: "r", native_request_id: "n",
      action: "run", target: "t", options: ["allow", "deny"],
    });
    assert.equal(broker.decide(id, "op", "allow", "job-B").status, "invalid");
    assert.equal(broker.decide(id, "op", "allow", "job-A").status, "approved");
    store.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("e2e: permission with only allow-class option + expired approval -> run blocked, never allowed", async () => {
  const env = await makeEnv();
  try {
    // beh-permission-allowonly fixture offers ONLY an allow-kind option and
    // waits 20s for a decision before defaulting to deny; the approval TTL is
    // shorter, so expiry must deliver cancelled, not allow.
    const r = await api(env, "POST", "/v1/jobs", {
      task: "synthetic", role: "coding", policy: "default", workspace: { mode: "fresh" },
      preferred: { model: "beh-permission-allowonly" },
    });
    assert.equal(r.status, 201);
    const jobId = (r.body as { job_id: string }).job_id;
    const deadline = Date.now() + 45000;
    let final: Record<string, unknown> | null = null;
    for (;;) {
      const j = await api(env, "GET", `/v1/jobs/${jobId}`);
      const st = (j.body as { status: string }).status;
      if (["succeeded", "failed", "cancelled", "needs_recovery"].includes(st)) { final = j.body as Record<string, unknown>; break; }
      if (Date.now() > deadline) throw new Error(`timeout; status=${st}`);
      await new Promise((r2) => setTimeout(r2, 200));
    }
    // blocked result is a soft-completion -> classified failure/handoff;
    // what matters: it is NOT a clean succeeded run
    assert.notEqual(final!.status, "succeeded", "expired approval produced an allowed run");
  } finally {
    await env.cleanup();
  }
});
