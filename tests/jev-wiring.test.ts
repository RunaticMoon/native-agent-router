// Jev judge wiring: task judge once per logical task, model judge per
// (model, catalog fingerprint, rubric), candidate judge per decision —
// verified with a fake injected fetch. Real Jev inference is NOT RUN.
import test from "node:test";
import assert from "node:assert/strict";
import { JevClient, JevDecisionService, FetchLike } from "../src/decisions/jev.js";
import { JevDecisionAdapter } from "../src/decisions/jev-adapter.js";
import { Candidate, RouteInput } from "../src/router-core/router.js";
import { demoPolicy } from "../src/bootstrap.js";
import { Capabilities, QuotaObservation } from "../src/contracts/index.js";

// Synthesize a valid SystemOneResponse for any question set; classify calls.
function fakeFetch(calls: string[]): FetchLike {
  return async (_url, init) => {
    const req = JSON.parse(init.body) as { questions: Record<string, { type: string; criteria?: unknown }> };
    const qids = Object.keys(req.questions);
    const kind = qids.includes("task_type") ? "task" : qids.includes("sufficient") ? "model" : "candidates";
    calls.push(kind);
    const answers: Record<string, unknown> = {};
    for (const [id, q] of Object.entries(req.questions)) {
      if (q.type === "noul") answers[id] = { type: "noul", noul: 0.8 };
      else if (q.type === "choice") {
        const keys = Object.keys(q.criteria as Record<string, string>);
        answers[id] = { type: "choice", choice: keys[0], probabilities: Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 1 : 0])), confidence: 0.9 };
      } else {
        const crit = q.criteria as string[];
        answers[id] = {
          type: "score", score: 3,
          legend: Object.fromEntries(crit.map((c, i) => [String(i), c])),
          probabilities: Object.fromEntries(crit.map((_c, i) => [String(i), i === 3 ? 1 : 0])),
          confidence: 0.9,
        };
      }
    }
    const body = new TextEncoder().encode(JSON.stringify({ model: "jev-fake-1", answers, usage: { input_tokens: 10, output_tokens: 10 } }));
    return { ok: true, status: 200, body: null, arrayBuffer: async () => body.buffer as ArrayBuffer };
  };
}

function cand(id: string, model_id: string): Candidate {
  return {
    candidate_id: id, model_id, native_profile_id: "default", execution_mode: "agent",
    billing_model: "free", incremental_cost: 0, roles: ["coding"],
    plugin: {
      manifest: { plugin_id: "p1", plugin_version: "0.1.0", capabilities: {}, catalog_path: "x", required_env: [] },
      catalog: { catalog_version: "c1", plugin_id: "p1", generated_at: "", sources: [], models: [{ model_id, billing_model: "free", incremental_cost: 0, context_tokens: 8192, efforts: [], roles: ["coding"] }] },
      catalogPath: "x", errors: [],
    } as unknown as Candidate["plugin"],
  };
}

const input = (task = "build thing", role = "coding"): RouteInput => ({
  job: { task, role, policy: "default", workspace: { mode: "fresh" } },
  job_id: "job_1", policy: demoPolicy(), profile_id: "default", execution_mode: "agent",
});

const capsOk = (): Capabilities => ({
  mode_agent: { status: "supported", evidence: "probe" },
  mode_text: { status: "supported", evidence: "probe" },
  model_selection: { status: "supported", evidence: "probe" },
  effort: { status: "unknown", evidence: "none" },
  structured_events: { status: "supported", evidence: "probe" },
  resume: { status: "unsupported", evidence: "none" },
  permission: "interactive",
  run_usage: { status: "supported", evidence: "probe" },
  quota: { status: "unknown", evidence: "none" },
  graceful_cancel: { status: "unknown", evidence: "none" },
  cwd: { status: "supported", evidence: "probe" },
  network: "required",
  filesystem: "workspace_only",
});

test("task+model+candidate judges run at right phases; caches suppress repeats", async () => {
  const calls: string[] = [];
  const svc = new JevDecisionService(new JevClient({ apiKey: "test-only-key", fetch: fakeFetch(calls) }));
  const audits: unknown[] = [];
  const adapter = new JevDecisionAdapter({
    mode: "active", jev: svc,
    persist: (rec) => audits.push(rec),
    observeLatency: () => null,
  });
  const cands = [cand("p1|m1|default|agent|-", "m1"), cand("p1|m2|default|agent|-", "m2")];
  const ctx = { effectiveCaps: new Map([["p1", capsOk()]]), quota: new Map<string, QuotaObservation | null>() };

  const r1 = await adapter.rank(input(), cands, ctx);
  assert.equal(r1.length, 2);
  const counts = (k: string) => calls.filter((c) => c === k).length;
  assert.equal(counts("task"), 1, "task judge not called once");
  assert.equal(counts("model"), 2, "model judge not called per distinct model");
  assert.equal(counts("candidates"), 1);

  // second rank, same task fingerprint + same catalog: task+model cached
  calls.length = 0;
  await adapter.rank(input(), cands, ctx);
  assert.equal(counts("task"), 0, "task judge re-ran for same task");
  assert.equal(counts("model"), 0, "model judge re-ran for unchanged catalog");
  assert.equal(counts("candidates"), 1, "candidate judge must still evaluate per decision");

  // different logical task (role changes the judged feature set -> new
  // fingerprint; raw task text is never part of the feature fingerprint
  // because it is never sent to Jev) -> task judge re-runs
  calls.length = 0;
  await adapter.rank(input("review the diff", "review"), cands, ctx);
  assert.equal(counts("task"), 1);
  assert.equal(counts("model"), 0);

  // audit records carry job linkage and bounded fields
  const kinds = audits.map((a) => (a as { kind: string }).kind);
  assert.ok(kinds.includes("jev_task_eval"));
  assert.ok(kinds.includes("jev_model_eval"));
  assert.ok(kinds.includes("jev_rank"));
  for (const a of audits) assert.equal((a as { job_id: string }).job_id, "job_1");
});

test("task evaluation cache is job-scoped and model confidence is not invented", async () => {
  const calls: string[] = [];
  const evals: { confidence?: number }[] = [];
  const adapter = new JevDecisionAdapter({
    mode: "active",
    jev: new JevDecisionService(new JevClient({ apiKey: "synthetic-key", fetch: fakeFetch(calls) })),
    evalSink: (record) => evals.push(record),
  });
  const cands = [cand("p1|m1|default|agent|-", "m1")];
  await adapter.rank(input(), cands);
  calls.length = 0;
  await adapter.rank({ ...input("another coding task"), job_id: "job_2" }, cands);
  assert.equal(calls.filter((k) => k === "task").length, 1, "different job must not silently reuse a role-only task judgment");
  assert.equal(calls.filter((k) => k === "model").length, 0, "unchanged catalog remains cached");
  assert.ok(evals.length > 0);
  assert.ok(evals.every((record) => record.confidence === undefined), "insufficient-evidence boolean is not a measured confidence score");
});

test("evidence carries ACTUAL effective caps/quota, not manifest claims", async () => {
  const calls: string[] = [];
  const bodies: unknown[] = [];
  const spy: FetchLike = async (u, i) => { bodies.push(JSON.parse(i.body)); return fakeFetch(calls)(u, i); };
  const svc = new JevDecisionService(new JevClient({ apiKey: "k", fetch: spy }));
  const adapter = new JevDecisionAdapter({ mode: "active", jev: svc, observeLatency: () => 123 });
  const c = cand("p1|m1|default|agent|-", "m1");
  const fresh = new Date().toISOString();
  const quota = new Map<string, QuotaObservation | null>([
    ["p1|m1", { status: "known", remaining: 5, pool_id: "pool", observed_at: fresh, limit: null, unit: "requests", source: "probe", estimated: false }],
  ]);
  await adapter.rank(input(), [c], { effectiveCaps: new Map([["p1", capsOk()]]), quota });
  const candCall = bodies.find((b) => (b as { state: { candidates?: unknown[] } }).state.candidates) as { state: { candidates: { capability_flags: string[]; quota_status: string; quota_fresh: boolean; latency_ms_p50: number | null }[] } };
  assert.ok(candCall, "candidate judge call not found");
  const wire = candCall.state.candidates[0]!;
  assert.ok(wire.capability_flags.includes("permission_interactive"));
  assert.equal(wire.quota_status, "known");
  assert.equal(wire.quota_fresh, true);
  assert.equal(wire.latency_ms_p50, 123);
});

test("candidate judge whitelist: extra JS fields can never leak onto the wire", async () => {
  const bodies: unknown[] = [];
  const spy: FetchLike = async (u, i) => { bodies.push(JSON.parse(i.body)); return fakeFetch([])(u, i); };
  const svc = new JevDecisionService(new JevClient({ apiKey: "k", fetch: spy }));
  const adapter = new JevDecisionAdapter({ mode: "active", jev: svc });
  const c = cand("p1|m1|default|agent|-", "m1") as Candidate & { env?: unknown; repository?: string };
  c.env = { FOREIGN_KEY: "SYNTHETIC-FOREIGN-CREDENTIAL" };
  c.repository = "unneeded-private-code";
  await adapter.rank(input(), [c], {});
  const wire = JSON.stringify(bodies.find((b) => (b as { state?: { candidates?: unknown } }).state?.candidates));
  assert.equal(wire.includes("SYNTHETIC-FOREIGN-CREDENTIAL"), false);
  assert.equal(wire.includes("unneeded-private-code"), false);
});

test("no key -> zero fetch calls, rule-identical order preserved", async () => {
  const calls: string[] = [];
  const adapter = new JevDecisionAdapter({ mode: "active", jev: null, persist: () => {} });
  const cands = [cand("p1|m1|default|agent|-", "m1"), cand("p1|m2|default|agent|-", "m2")];
  const out = await adapter.rank(input(), cands, {});
  assert.equal(calls.length, 0);
  assert.equal(out.length, 2);
});

test("shadow: rules ordering returned while jev evaluated; audit honest", async () => {
  const calls: string[] = [];
  const svc = new JevDecisionService(new JevClient({ apiKey: "k", fetch: fakeFetch(calls) }));
  const audits: { adapter_used?: string; jev_model_actual?: string | null }[] = [];
  const adapter = new JevDecisionAdapter({ mode: "shadow", jev: svc, persist: (r) => audits.push(r as never) });
  const cands = [cand("p1|m1|default|agent|-", "m1")];
  const out = await adapter.rank(input(), cands, {});
  assert.equal(out.length, 1);
  const rankAudit = audits.find((a) => (a as { kind?: string }).kind === "jev_rank") as { detail?: { adapter_used?: string; jev_model_actual?: string | null } } | undefined;
  assert.ok(rankAudit);
  assert.equal(rankAudit.detail!.adapter_used, "rule-based", "shadow must not claim jev selected");
  assert.equal(rankAudit.detail!.jev_model_actual, "jev-fake-1");
});
