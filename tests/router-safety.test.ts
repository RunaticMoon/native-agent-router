// Decision-adapter containment + quota truthfulness + closed version parser.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Router, RouteInput, Candidate, DecisionAdapter, normalizeQuota } from "../src/router-core/router.js";
import { Registry } from "../src/registry/registry.js";
import { Store } from "../src/storage/store.js";
import { versionInRange } from "../src/native/plugin.js";
import { writeFixtureManifest, demoPolicy } from "../src/bootstrap.js";
import { Capabilities } from "../src/contracts/index.js";

function mkRouter(adapter: DecisionAdapter) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rs-"));
  const mdir = path.join(tmp, "m");
  writeFixtureManifest(mdir);
  const registry = new Registry();
  registry.load([mdir]);
  const store = new Store(path.join(tmp, "r.db"));
  return { tmp, registry, store, router: new Router(registry, store, adapter) };
}

const input = (policy = demoPolicy()): RouteInput => ({
  job: { task: "x", role: "coding", policy: "default", workspace: { mode: "fresh" } },
  job_id: "j1",
  policy,
  profile_id: "default",
  execution_mode: "agent",
});

test("adapter receives copies: in-place and nested mutation cannot corrupt originals", async () => {
  let seen: Candidate[] = [];
  const evil: DecisionAdapter = {
    name: "evil",
    async rank(_i, cands) {
      seen = cands;
      for (const c of cands) {
        c.model_id = "injected-model";
        c.plugin.manifest.plugin_id = "evil-plugin";
        c.plugin.catalog.models = [];
        c.roles = ["admin"];
        c.billing_model = "free";
        c.incremental_cost = 0;
      }
      return cands;
    },
  };
  const { tmp, registry, store, router } = mkRouter(evil);
  try {
    const before = JSON.stringify(registry.get("example-native")!.manifest);
    const out = await router.plan(input(), new Map(), new Map());
    // registry-owned originals untouched
    assert.equal(JSON.stringify(registry.get("example-native")!.manifest), before);
    // ordered candidates carry original identities, not mutated ones
    for (const c of out.ordered) {
      assert.notEqual(c.model_id, "injected-model");
      assert.equal(c.plugin.manifest.plugin_id, "example-native");
      assert.notDeepEqual(c.roles, ["admin"]);
    }
    assert.ok(out.ordered.length > 0);
    assert.ok(seen.length > 0);
  } finally {
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("adapter returning fabricated/cloned objects still maps to originals only", async () => {
  const cloner: DecisionAdapter = {
    name: "cloner",
    async rank(_i, cands) {
      return [
        { candidate_id: "fake|nope|default|agent|-", plugin: cands[0]!.plugin, model_id: "nope", native_profile_id: "default", execution_mode: "agent", billing_model: "free", incremental_cost: 0, roles: [] },
        ...cands.map((c) => ({ ...c, model_id: "mutated" })),
      ];
    },
  };
  const { tmp, store, router } = mkRouter(cloner);
  try {
    const out = await router.plan(input(), new Map(), new Map());
    assert.ok(out.rejects.some((r) => r.candidate_id === "fake|nope|default|agent|-"));
    for (const c of out.ordered) assert.ok(["fake-small", "fake-large"].includes(c.model_id));
  } finally {
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("normalizeQuota: stale/future/malformed degrade remaining to null — never 'observed exhausted'", () => {
  const stale = { status: "exhausted" as const, remaining: 0, pool_id: "p", observed_at: new Date(Date.now() - 3600_000).toISOString(), limit: null, unit: "unknown" as const, source: "probe", estimated: false };
  const n1 = normalizeQuota(stale, 120);
  assert.equal(n1!.status, "unknown");
  assert.equal(n1!.remaining, null, "stale remaining must not survive as 0");
  const future = { ...stale, observed_at: new Date(Date.now() + 3600_000).toISOString() };
  assert.equal(normalizeQuota(future, 120)!.remaining, null);
  const badTs = { ...stale, observed_at: "not-a-date" };
  const n3 = normalizeQuota(badTs, 120);
  assert.equal(n3!.status, "unknown");
  assert.equal(n3!.remaining, null);
  const badExpiry = { ...stale, observed_at: new Date().toISOString(), expires_at: "garbage" };
  assert.equal(normalizeQuota(badExpiry, 120)!.status, "unknown");
  // fresh observed exhausted stays truthfully exhausted
  const fresh = { ...stale, observed_at: new Date().toISOString() };
  const n5 = normalizeQuota(fresh, 120);
  assert.equal(n5!.status, "exhausted");
  assert.equal(n5!.remaining, 0);
});

test("plan: stale exhausted quota is not a QUOTA_EXHAUSTED reject", async () => {
  const { tmp, store, router } = mkRouter({ name: "pass", rank: async (_i: unknown, c: Candidate[]) => c });
  try {
    const stale = new Date(Date.now() - 3600_000).toISOString();
    const quota = new Map<string, import("../src/contracts/index.js").QuotaObservation | null>();
    for (const m of ["fake-small", "fake-large"]) {
      quota.set(`example-native|${m}`, { status: "exhausted", remaining: 0, pool_id: "p", observed_at: stale, limit: null, unit: "unknown", source: "probe", estimated: false });
    }
    const out = await router.plan(input(), new Map(), quota);
    assert.ok(out.ordered.length > 0, "stale exhaustion wrongly blocked candidates");
    assert.ok(!out.rejects.some((r) => r.code === "QUOTA_EXHAUSTED"));
  } finally {
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("versionInRange is a CLOSED parser: garbage anywhere fails", () => {
  assert.equal(versionInRange("3000.10.31", "not-a-version-range"), false);
  assert.equal(versionInRange("3000.10.31", ""), false);
  assert.equal(versionInRange("3000.10.31", "   "), false);
  assert.equal(versionInRange("1.2.6", ">=1.2.0 <1.3.0"), true);
  assert.equal(versionInRange("1.2.6", "1.2.6"), true);
  assert.equal(versionInRange("1.2.7", "1.2.6"), false);
  assert.equal(versionInRange("1.2.6", ">=1.2.0 <1.3.0 junk"), false);
  assert.equal(versionInRange("1.2.6", "garbage >=1.2.0"), false);
  assert.equal(versionInRange("1.2.6", ">=1.2"), false);
  assert.equal(versionInRange("1.2.6", "=> 1.2.0"), false);
  assert.equal(versionInRange("1.2.6", "~1.2.0"), false);
  assert.equal(versionInRange("garbage", ">=1.0.0"), false);
  assert.equal(versionInRange("1.2.6", ">=1.2.0,"), false);
  assert.equal(versionInRange("1.2.6", ">=1.2.0, <1.3.0"), true);
});
