// Tests for the Jev decision adapter. ALL tests use injected fake fetch:
// zero real network, zero real API keys, zero real inference.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  JevClient, JevError, JEV_ENDPOINT, JEV_MODEL_PINNED,
  JevDecisionService, DecisionCoordinator, rankCandidates,
  toEvidenceCandidate,
  type Question, type FetchLike, type EvidenceCandidate,
  type CandidateLike, type ModelEvidence, type DecisionAuditRecord,
} from "../src/decisions/jev.js";

const KEY = "test-key-not-real-000000";
const enc = new TextEncoder();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function validAnswers(questions: Record<string, Question>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === "noul") out[id] = { type: "noul", noul: 0.7 };
    else if (q.type === "choice") {
      const keys = Object.keys(q.criteria);
      const probabilities: Record<string, number> = {};
      keys.forEach((k, i) => (probabilities[k] = i === 0 ? 1 - 0.01 * (keys.length - 1) : 0.01));
      out[id] = { type: "choice", choice: keys[0], probabilities, confidence: 0.9 };
    } else {
      const n = q.criteria.length;
      const legend: Record<string, string> = {};
      const probabilities: Record<string, number> = {};
      for (let i = 0; i < n; i++) {
        legend[String(i)] = q.criteria[i]!;
        probabilities[String(i)] = i === 0 ? 1 : 0;
      }
      out[id] = { type: "score", score: 0.5, legend, probabilities, confidence: 0.8 };
    }
  }
  return out;
}

function fakeFetchOk(questions: Record<string, Question>, captured?: { url?: string; init?: RequestInit; count: number }) {
  return async (url: string, init: RequestInit): Promise<Response> => {
    if (captured) {
      captured.url = url;
      captured.init = init;
      captured.count++;
    }
    return jsonResponse({ model: JEV_MODEL_PINNED, answers: validAnswers(questions), usage: { input_tokens: 10, output_tokens: 5 } });
  };
}

const Q = {
  b: { type: "noul", instructions: "yes?" },
  c: { type: "choice", instructions: "pick", criteria: { a: "opt a", b: null } },
  s: { type: "score", instructions: "rate", criteria: ["low", "mid", "high"] },
} satisfies Record<string, Question>;

describe("JevClient transport + official wire schema", () => {
  test("sends official request shape to fixed endpoint; records actual model", async () => {
    const captured = { count: 0 } as { url?: string; init?: RequestInit; count: number };
    const client = new JevClient({ apiKey: KEY, fetch: fakeFetchOk(Q, captured) });
    const res = await client.systemOne({ state: { k: "v" }, questions: Q });
    assert.equal(captured.url, JEV_ENDPOINT);
    assert.equal(JEV_ENDPOINT, "https://api.typesafe.ai/v1/systemone");
    assert.equal((captured.init!.method ?? "GET").toUpperCase(), "POST");
    const headers = captured.init!.headers as Record<string, string>;
    assert.equal(headers.authorization, `Bearer ${KEY}`);
    const body = JSON.parse(String(captured.init!.body));
    assert.equal(body.model, "jev-1.13.0");
    assert.deepEqual(Object.keys(body.questions), ["b", "c", "s"]);
    assert.equal(body.questions.c.type, "choice");
    assert.equal(res.model, JEV_MODEL_PINNED);
    assert.equal(res.usage.input_tokens, 10);
    // key is never exposed on the client/response
    assert.ok(!JSON.stringify(res).includes(KEY));
  });

  test("endpoint is fixed: fetch option cannot reroute URL", async () => {
    const client = new JevClient({ apiKey: KEY, fetch: fakeFetchOk(Q) });
    assert.equal((client as unknown as { endpoint?: string }).endpoint, undefined);
    await client.systemOne({ state: "x", questions: Q });
  });

  test("rejects missing/extra answer ids", async () => {
    const bad = { model: JEV_MODEL_PINNED, answers: { b: { type: "noul", noul: 0.5 }, WRONG: { type: "noul", noul: 1 } }, usage: { input_tokens: 1, output_tokens: 1 } };
    const client = new JevClient({ apiKey: KEY, fetch: async () => jsonResponse(bad) });
    await assert.rejects(() => client.systemOne({ state: "x", questions: Q }), (e: unknown) => (e as JevError).code === "JEV_BAD_RESPONSE");
    const missing = { model: JEV_MODEL_PINNED, answers: { b: { type: "noul", noul: 0.5 } }, usage: { input_tokens: 1, output_tokens: 1 } };
    const client2 = new JevClient({ apiKey: KEY, fetch: async () => jsonResponse(missing) });
    await assert.rejects(() => client2.systemOne({ state: "x", questions: Q }), (e: unknown) => (e as JevError).code === "JEV_BAD_RESPONSE");
  });

  test("noul range enforced", async () => {
    const bad = { model: JEV_MODEL_PINNED, answers: { b: { type: "noul", noul: 1.5 } }, usage: { input_tokens: 1, output_tokens: 1 } };
    const client = new JevClient({ apiKey: KEY, fetch: async () => jsonResponse(bad) });
    await assert.rejects(() => client.systemOne({ state: "x", questions: { b: Q.b } }), (e: unknown) => (e as JevError).code === "JEV_BAD_RESPONSE");
  });

  test("choice: out-of-set id, bad probability keys/range/sum rejected", async () => {
    const mk = (answers: unknown) => ({ model: JEV_MODEL_PINNED, answers, usage: { input_tokens: 1, output_tokens: 1 } });
    const cases: unknown[] = [
      { c: { type: "choice", choice: "evil-id", probabilities: { a: 0.5, b: 0.5 }, confidence: 0.5 } },
      { c: { type: "choice", choice: "a", probabilities: { a: 0.5, b: 0.5, extra: 0.1 }, confidence: 0.5 } },
      { c: { type: "choice", choice: "a", probabilities: { a: 0.9 }, confidence: 0.5 } },
      { c: { type: "choice", choice: "a", probabilities: { a: 1.4, b: -0.4 }, confidence: 0.5 } },
      { c: { type: "choice", choice: "a", probabilities: { a: 0.3, b: 0.3 }, confidence: 0.5 } },
      { c: { type: "choice", choice: "a", probabilities: { a: 0.5, b: 0.5 }, confidence: 1.2 } },
    ];
    for (const answers of cases) {
      const client = new JevClient({ apiKey: KEY, fetch: async () => jsonResponse(mk(answers)) });
      await assert.rejects(() => client.systemOne({ state: "x", questions: { c: Q.c } }), (e: unknown) => (e as JevError).code === "JEV_BAD_RESPONSE");
    }
  });

  test("score: fractional value, legend keys/values, probabilities, confidence, range", async () => {
    const good = await new JevClient({ apiKey: KEY, fetch: fakeFetchOk({ s: Q.s }) }).systemOne({ state: "x", questions: { s: Q.s } });
    const sAns = good.answers.s as { type: string; score: number };
    assert.equal(sAns.type, "score");
    assert.equal(typeof sAns.score, "number");
    const mk = (answers: unknown) => ({ model: JEV_MODEL_PINNED, answers, usage: { input_tokens: 1, output_tokens: 1 } });
    const legend = { "0": "low", "1": "mid", "2": "high" };
    const probs = { "0": 0.2, "1": 0.3, "2": 0.5 };
    const cases: unknown[] = [
      { s: { type: "score", score: 3.5, legend, probabilities: probs, confidence: 0.5 } }, // out of range (max 2)
      { s: { type: "score", score: 1, legend: { "0": "low", "1": "mid" }, probabilities: probs, confidence: 0.5 } }, // missing legend level
      { s: { type: "score", score: 1, legend: { "0": "low", "1": "WRONG", "2": "high" }, probabilities: probs, confidence: 0.5 } }, // legend must equal sent rubric
      { s: { type: "score", score: 1, legend, probabilities: { "0": 0.5, "1": 0.5, "9": 0.0 }, confidence: 0.5 } }, // extra prob level
      { s: { type: "score", score: 1, legend, probabilities: { "0": 0.5, "1": 0.5, "2": 0.5 }, confidence: 0.5 } }, // sum != 1
      { s: { type: "score", score: 1, legend, probabilities: probs, confidence: -0.1 } }, // confidence range
    ];
    for (const answers of cases) {
      const client = new JevClient({ apiKey: KEY, fetch: async () => jsonResponse(mk(answers)) });
      await assert.rejects(() => client.systemOne({ state: "x", questions: { s: Q.s } }), (e: unknown) => (e as JevError).code === "JEV_BAD_RESPONSE");
    }
  });

  test("per-call timeout: headers never arrive", async () => {
    const slow = () => new Promise<Response>(() => {});
    const client = new JevClient({ apiKey: KEY, fetch: slow, callTimeoutMs: 20, totalTimeoutMs: 500 });
    const t0 = Date.now();
    await assert.rejects(() => client.systemOne({ state: "x", questions: { b: Q.b } }), (e: unknown) => (e as JevError).code === "JEV_TIMEOUT");
    assert.ok(Date.now() - t0 < 400);
  });

  test("total timeout: response body slow-read aborts", async () => {
    const dribble = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            setTimeout(() => {
              try {
                c.enqueue(enc.encode(JSON.stringify({ model: JEV_MODEL_PINNED, answers: { b: { type: "noul", noul: 1 } }, usage: { input_tokens: 1, output_tokens: 1 } })));
                c.close();
              } catch {
                // aborted mid-read — expected
              }
            }, 300);
          },
        }),
        { status: 200 },
      );
    const client = new JevClient({ apiKey: KEY, fetch: dribble, callTimeoutMs: 500, totalTimeoutMs: 40 });
    await assert.rejects(() => client.systemOne({ state: "x", questions: { b: Q.b } }), (e: unknown) => (e as JevError).code === "JEV_TIMEOUT");
  });

  test("byte-bounded response: oversize body rejected", async () => {
    const big = async () => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(1024 * 1024)); c.close(); } }), { status: 200 });
    const client = new JevClient({ apiKey: KEY, fetch: big, maxResponseBytes: 4096 });
    await assert.rejects(() => client.systemOne({ state: "x", questions: { b: Q.b } }), (e: unknown) => (e as JevError).code === "JEV_OVERSIZE");
  });

  test("HTTP error: raw error body never surfaced or logged", async () => {
    const SECRET_BODY = "INTERNAL-SECRET-DETAIL-XYZ";
    const errFetch = async () => new Response(SECRET_BODY, { status: 500 });
    const client = new JevClient({ apiKey: KEY, fetch: errFetch });
    const err = await client.systemOne({ state: "x", questions: { b: Q.b } }).then(() => null, (e: unknown) => e as JevError);
    assert.ok(err instanceof JevError);
    assert.equal(err.code, "JEV_HTTP");
    assert.equal(err.status, 500);
    assert.ok(!String(err.message).includes(SECRET_BODY));
    assert.ok(!JSON.stringify(err).includes(SECRET_BODY));
  });

  test("no retries by default: exactly one fetch attempt on failure", async () => {
    let count = 0;
    const client = new JevClient({ apiKey: KEY, fetch: async () => { count++; return new Response("x", { status: 529 }); } });
    await assert.rejects(() => client.systemOne({ state: "x", questions: { b: Q.b } }));
    assert.equal(count, 1);
  });
});

// ---------- decision service / coordinator ----------

/** Echo-fetch: answers whatever questions the service sent (schema-valid). */
function echoFetch(captured: { count: number; bodies: unknown[] }, override?: (parsed: { questions: Record<string, Question> }) => Record<string, unknown>) {
  return async (_url: string, init: RequestInit): Promise<Response> => {
    captured.count++;
    const parsed = JSON.parse(String(init.body));
    captured.bodies.push(parsed);
    const answers = override ? override(parsed) : validAnswers(parsed.questions);
    return jsonResponse({ model: JEV_MODEL_PINNED, answers, usage: { input_tokens: 9, output_tokens: 4 } });
  };
}

const svc = (fetchImpl: FetchLike, opts = {}) =>
  new JevDecisionService(new JevClient({ apiKey: KEY, fetch: fetchImpl, callTimeoutMs: 200, totalTimeoutMs: 400 }), opts);

function cand(id: string, over: Partial<EvidenceCandidate> = {}): EvidenceCandidate {
  return {
    id, model_id: "m-" + id, roles: ["coding"], billing_model: "free",
    incremental_cost: 0, execution_mode: "agent", quota_status: "known",
    quota_fresh: true, latency_ms_p50: 100, eval_fit: { coding: 0.8 },
    capability_flags: ["structured_events"], observations_fresh: true, unknowns: [],
    ...over,
  };
}

describe("JevDecisionService", () => {
  test("judgeTask: minimal structured state; summary bounded + redacted", async () => {
    const cap = { count: 0, bodies: [] as unknown[] };
    const s = svc(echoFetch(cap));
    const secret = "Bearer " + "x".repeat(40);
    const j = await s.judgeTask({
      role: "coding", declared_scope: "module", touches_secrets: false,
      summary: `fix the bug ${secret} ` + "y".repeat(1000),
    });
    assert.equal(cap.count, 1);
    const body = cap.bodies[0] as { state: { task: Record<string, unknown> }; questions: Record<string, Question> };
    const task = body.state.task;
    // minimization: only whitelisted feature keys, no full task/repo fields
    assert.deepEqual(Object.keys(task).sort(), ["declared_scope", "role", "summary", "touches_secrets"]);
    const summary = task.summary as string;
    assert.ok(!summary.includes("x".repeat(40)), "secret not sent");
    assert.ok(summary.includes("[REDACTED]"));
    assert.ok(summary.length <= 530, "bounded");
    // typed judgment + confidence is per-question certainty, never success prob
    assert.equal(typeof j.complexity, "number");
    assert.ok(j.complexity >= 0 && j.complexity <= 1);
    assert.ok(typeof j.confidence.task_type === "number");
    assert.equal(j.model, JEV_MODEL_PINNED);
  });

  test("judgeModel: rubric scores + version + provenance; insufficient evidence flagged", async () => {
    const cap = { count: 0, bodies: [] as unknown[] };
    const s = svc(echoFetch(cap));
    const ev: ModelEvidence = {
      model_id: "devin-x", catalog_fingerprint: "fp-1",
      sourced_evidence: [{ claim: "supports stream-json io", source: "agy --help" }],
      eval_evidence: [{ name: "fixture-run", kind: "fixture", score: 0.7 }],
    };
    const e1 = await s.judgeModel(ev);
    assert.equal(e1.provenance, "jev-model-judge"); // estimate, not measured benchmark
    assert.equal(e1.rubric_version, "rubric-v1");
    assert.deepEqual(Object.keys(e1.scores), ["coding", "review", "research", "planning"]);
    assert.equal(e1.insufficient_evidence, false);
    assert.equal(e1.eval_id, (await s.judgeModel(ev)).eval_id); // deterministic id
    JSON.stringify(e1); // persistable
    // insufficient evidence path
    const s2 = svc(echoFetch({ count: 0, bodies: [] }, (p) => ({
      ...validAnswers(p.questions),
      sufficient: { type: "noul", noul: 0.1 },
    })));
    const e2 = await s2.judgeModel({ ...ev, catalog_fingerprint: "fp-2" });
    assert.equal(e2.insufficient_evidence, true);
  });

  test("judgeModel: bounded cache keyed by catalog fingerprint + rubric", async () => {
    const cap = { count: 0, bodies: [] as unknown[] };
    const s = svc(echoFetch(cap), { evalCacheSize: 2 });
    const ev = (fp: string): ModelEvidence => ({ model_id: "m", catalog_fingerprint: fp, sourced_evidence: [{ claim: "c", source: "s" }] });
    await s.judgeModel(ev("a"));
    await s.judgeModel(ev("a")); // cache hit
    assert.equal(cap.count, 1);
    await s.judgeModel(ev("b")); // new fingerprint -> new call
    assert.equal(cap.count, 2);
    assert.equal(s.evalCacheLength(), 2);
    await s.judgeModel(ev("c")); // evicts oldest ("a")
    assert.equal(cap.count, 3);
    assert.equal(s.evalCacheLength(), 2); // bounded
    await s.judgeModel(ev("a")); // evicted -> refetch
    assert.equal(cap.count, 4);
  });

  test("judgeCandidates: allowlisted ids only; EvidenceCandidate never leaks plugin/env", async () => {
    const cap = { count: 0, bodies: [] as unknown[] };
    const s = svc(echoFetch(cap));
    // Native Candidate analogue carrying plugin manifest/env — must not serialize
    const native = {
      candidate_id: "plugA|mx|prof|agent|-",
      model_id: "mx", roles: ["coding"], billing_model: "free",
      incremental_cost: 0, execution_mode: "agent",
      plugin: { manifest: { plugin_id: "plugA", env: { SECRET_TOKEN: "leakme" }, argv: ["/bin/x"] }, realpath: "/opt/x" },
    } as CandidateLike & { plugin: unknown };
    const ec = toEvidenceCandidate(native, { quota_status: "known", quota_fresh: true, latency_ms_p50: 42, observations_fresh: true });
    assert.ok(!("plugin" in ec));
    const out = await s.judgeCandidates({ task: { role: "coding" }, candidates: [ec] });
    assert.deepEqual(Object.keys(out.scores), [ec.id]);
    const fit = out.scores[ec.id]!;
    assert.ok(fit.fit >= 0 && fit.fit <= 1 && fit.confidence >= 0 && fit.confidence <= 1);
    const wire = JSON.stringify(cap.bodies[0]);
    assert.ok(!wire.includes("SECRET_TOKEN") && !wire.includes("leakme") && !wire.includes("/bin/x") && !wire.includes("argv") && !wire.includes("manifest"));
    // scores keyed by candidate id only — caller maps ids back
    const dup = { ...ec };
    await assert.rejects(() => s.judgeCandidates({ task: {}, candidates: [ec, dup] }), (e: unknown) => (e as JevError).code === "JEV_CONFIG");
  });
});

describe("deterministic ranking", () => {
  test("rankCandidates: weights + fresh/unknown flags; deterministic order", async () => {
    const cands = [cand("b", { incremental_cost: null, quota_status: "unknown", unknowns: ["quota", "cost"] }), cand("a")];
    const r1 = rankCandidates(cands, { a: { fit: 0.9 }, b: { fit: 0.2 } }, { role: "coding" });
    assert.deepEqual(r1.map((r) => r.candidate_id), ["a", "b"]);
    assert.ok(r1[1]!.flags.includes("quota-unknown") && r1[1]!.flags.includes("cost-unknown"));
    // deterministic: same input twice -> identical
    const r2 = rankCandidates(cands, { a: { fit: 0.9 }, b: { fit: 0.2 } }, { role: "coding" });
    assert.deepEqual(r1, r2);
    // no jev fit -> eval_fit fallback then 0.5 + flag
    const r3 = rankCandidates([cand("z", { eval_fit: {} })], null, { role: "review" });
    assert.equal(r3[0]!.fit, 0.5);
    assert.ok(r3[0]!.flags.includes("fit-unknown"));
    // stale observations penalized
    const r4 = rankCandidates([cand("s", { observations_fresh: false })], null, {});
    assert.ok(r4[0]!.flags.includes("observations-stale"));
  });
});

describe("DecisionCoordinator off/shadow/active", () => {
  const cands = () => [cand("A"), cand("B", { roles: [], billing_model: "metered", incremental_cost: 3 })];

  test("off: rule ranking only, no jev call", async () => {
    const cap = { count: 0, bodies: [] as unknown[] };
    const co = new DecisionCoordinator({ mode: "off", jev: svc(echoFetch(cap)) });
    const r = await co.decide({ role: "coding" }, cands());
    assert.equal(cap.count, 0);
    assert.deepEqual(r.ordered_ids, ["A", "B"]); // A: role match + free
    assert.equal(r.audit.adapter_used, "rule-based");
  });

  test("shadow: jev disagreement recorded but RULE order returned; one worker selection", async () => {
    const cap = { count: 0, bodies: [] as unknown[] };
    // jev ranks B top (rules rank A top)
    const s = svc(echoFetch(cap, (p) => {
      const ans = validAnswers(p.questions);
      (ans.cand_0 as { probabilities: Record<string, number> }).probabilities = { "0": 1, "1": 0, "2": 0, "3": 0, "4": 0 };
      (ans.cand_0 as { score: number }).score = 0;
      (ans.cand_1 as { probabilities: Record<string, number> }).probabilities = { "0": 0, "1": 0, "2": 0, "3": 0, "4": 1 };
      (ans.cand_1 as { score: number }).score = 4;
      return ans;
    }));
    const co = new DecisionCoordinator({ mode: "shadow", jev: s });
    const r = await co.decide({ role: "coding" }, cands());
    assert.equal(cap.count, 1);
    assert.deepEqual(r.ordered_ids, ["A", "B"]); // RULE order kept — single selection, no execution here
    assert.equal(r.audit.mode, "shadow");
    assert.equal(r.audit.shadow_disagreement, true);
    assert.equal(r.audit.chosen, "A");
  });

  test("active: jev fit ranking used when healthy", async () => {
    const s = svc(echoFetch({ count: 0, bodies: [] }, (p) => {
      const ans = validAnswers(p.questions);
      (ans.cand_0 as { score: number }).score = 0;
      (ans.cand_0 as { probabilities: Record<string, number> }).probabilities = { "0": 1, "1": 0, "2": 0, "3": 0, "4": 0 };
      (ans.cand_1 as { score: number }).score = 4;
      (ans.cand_1 as { probabilities: Record<string, number> }).probabilities = { "0": 0, "1": 0, "2": 0, "3": 0, "4": 1 };
      return ans;
    }));
    const co = new DecisionCoordinator({ mode: "active", jev: s });
    const r = await co.decide({ role: "coding" }, cands());
    assert.deepEqual(r.ordered_ids, ["B", "A"]);
    assert.equal(r.audit.adapter_used, "jev");
    assert.equal(r.audit.jev_model_actual, JEV_MODEL_PINNED);
  });

  test("active: timeout/bad output -> rule fallback, SAME hard-filtered set", async () => {
    // timeout
    const hang = () => new Promise<Response>(() => {});
    const co = new DecisionCoordinator({ mode: "active", jev: svc(hang) });
    const r1 = await co.decide({ role: "coding" }, cands());
    assert.deepEqual(r1.ordered_ids, ["A", "B"]);
    assert.equal(r1.audit.adapter_used, "jev-fallback-rules");
    assert.equal(r1.audit.error_code, "JEV_TIMEOUT");
    // bad output (extra answer id — out-of-set/fabricated id cannot bypass)
    const badOut = async () => jsonResponse({ model: JEV_MODEL_PINNED, answers: { cand_0: { type: "score", score: 4, legend: { "0": "a", "1": "b", "2": "c", "3": "d", "4": "e" }, probabilities: { "0": 0, "1": 0, "2": 0, "3": 0, "4": 1 }, confidence: 0.9 }, EVIL: { type: "noul", noul: 1 } }, usage: { input_tokens: 1, output_tokens: 1 } });
    const co2 = new DecisionCoordinator({ mode: "active", jev: svc(badOut) });
    const r2 = await co2.decide({ role: "coding" }, cands());
    assert.deepEqual(r2.ordered_ids, ["A", "B"]);
    assert.equal(r2.audit.adapter_used, "jev-fallback-rules");
    assert.equal(r2.audit.error_code, "JEV_BAD_RESPONSE");
  });

  test("api key never appears in audit records; audit has safe fields only", async () => {
    const records: DecisionAuditRecord[] = [];
    const co = new DecisionCoordinator({ mode: "active", jev: svc(async () => new Response("boom", { status: 500 })), audit: (r) => void records.push(r) });
    await co.decide({ role: "coding" }, cands());
    const all = JSON.stringify(co.auditRecords()) + JSON.stringify(records);
    assert.ok(!all.includes(KEY));
    assert.ok(!all.includes("Bearer"));
    assert.equal(records.length, 1);
    assert.ok(records[0]!.duration_ms >= 0);
  });
});
