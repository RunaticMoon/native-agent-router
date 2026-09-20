// Jev decision adapter: adapts DecisionCoordinator to the router-core
// DecisionAdapter contract. Jev is decision-ONLY: it reorders candidate IDs,
// never executes, authorizes, or relaxes constraints. All Jev failures fall
// back to the same hard-filtered rule ranking.
//
// Judge phases: Task Judge once per logical task (fingerprint-cached),
// Model Judge once per (model, catalog fingerprint, rubric) — cached and
// persisted — Candidate Judge per decision. Retry/quota fallback inside one
// execute() never re-calls Jev because rank() runs once per plan.
import { createHash } from "node:crypto";
import { DecisionAdapter, Candidate, RouteInput, DecisionContext } from "../router-core/router.js";
import {
  DecisionCoordinator, JevDecisionService, JevClient, EvidenceCandidate,
  toEvidenceCandidate, DecisionMode, RankWeights, DEFAULT_RANK_WEIGHTS,
  TaskFeatures, TaskJudgment, ModelEvaluation, ModelEvidence,
  JevError, boundText,
} from "./jev.js";
import { Capabilities, QuotaObservation } from "../contracts/index.js";
import { normalizeQuota } from "../router-core/router.js";

export interface JevAuditRecord {
  job_id: string;
  kind: "jev_task_eval" | "jev_model_eval" | "jev_rank";
  detail: Record<string, unknown>;
}

export interface JevAdapterOptions {
  mode: DecisionMode;
  jev?: JevDecisionService | null;
  weights?: Partial<RankWeights>;
  audit?: (record: unknown) => void;
  /** Job-linked audit sink: task/model/rank records with job_id linkage. */
  persist?: (record: JevAuditRecord) => void;
  /** Evaluation persistence (candidate/model evaluation tables). */
  evalSink?: (e: { kind: string; subject_id: string; catalog_fingerprint?: string; rubric_version?: string; fit?: number; confidence?: number; reasons?: unknown; provenance: string }) => void;
  /** Observed latency lookup (candidate_observations); null = unknown. */
  observeLatency?: (candidateId: string) => number | null;
  /** Optional operator-approved short task summary (bounded+redacted). */
  taskSummary?: string;
}

function stable(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(stable).join(",")}]`;
  if (x && typeof x === "object") {
    return `{${Object.keys(x as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${stable((x as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(x);
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);

// Fingerprint of the catalog-relevant identity: a catalog/model change
// triggers exactly one new Model Judge evaluation per model.
function catalogFingerprint(c: Candidate): string {
  const m = c.plugin.catalog.models.find((x) => x.model_id === c.model_id);
  return sha(stable({
    plugin_id: c.plugin.manifest.plugin_id,
    plugin_version: c.plugin.manifest.plugin_version,
    catalog_version: c.plugin.catalog.catalog_version,
    model: m
      ? { id: m.model_id, billing: m.billing_model, cost: m.incremental_cost, ctx: m.context_tokens, efforts: m.efforts, roles: m.roles }
      : { id: c.model_id },
  }));
}

function taskFingerprint(t: TaskFeatures): string {
  return sha(stable({ role: t.role, hint: t.task_type_hint, summary: t.summary, scope: t.declared_scope, tools: t.tools_required }));
}

// sourced_evidence for Model Judge: ONLY operator-catalog claims with
// provenance — never invented benchmarks or prices.
function sourcedEvidence(c: Candidate): ModelEvidence["sourced_evidence"] {
  const m = c.plugin.catalog.models.find((x) => x.model_id === c.model_id);
  if (!m) return [];
  const out: { claim: string; source: string; observed_at?: string }[] = [
    { claim: `billing_model=${m.billing_model}`, source: "operator-catalog" },
    { claim: `roles=${m.roles.join("|")}`, source: "operator-catalog" },
  ];
  if (m.incremental_cost !== null) out.push({ claim: `incremental_cost=${m.incremental_cost}`, source: "operator-catalog" });
  if (m.context_tokens !== null) out.push({ claim: `context_tokens=${m.context_tokens}`, source: "operator-catalog" });
  if (m.efforts.length) out.push({ claim: `efforts=${m.efforts.join("|")}`, source: "operator-catalog" });
  return out.slice(0, 8);
}

function quotaFresh(q: QuotaObservation | null | undefined, staleSecs: number): boolean {
  if (!q) return false;
  const t = new Date(q.observed_at).getTime();
  const now = Date.now();
  if (!Number.isFinite(t) || t > now + 60000 || now - t > staleSecs * 1000) return false;
  if (q.expires_at) {
    const e = new Date(q.expires_at).getTime();
    if (Number.isFinite(e) && e < now) return false;
  }
  return true;
}

// Capability evidence from ACTUAL effective caps (post-probe), not the
// manifest's declared claims. No ctx caps -> empty flags + honest unknown.
function capabilityFlags(caps: Capabilities | undefined): { flags: string[]; unknown: boolean } {
  if (!caps) return { flags: [], unknown: true };
  const flags: string[] = [];
  for (const [k, v] of Object.entries(caps)) {
    if (v && typeof v === "object" && (v as { status?: string }).status === "supported") flags.push(k);
  }
  if (caps.permission === "interactive") flags.push("permission_interactive");
  if (caps.permission === "preconfigured_only") flags.push("permission_preconfigured");
  return { flags: flags.slice(0, 16), unknown: false };
}

export class JevDecisionAdapter implements DecisionAdapter {
  readonly name = "jev";
  private coordinator: DecisionCoordinator;
  private jev: JevDecisionService | null;
  private opts: JevAdapterOptions;
  private taskCache = new Map<string, TaskJudgment | null>(); // logical task fp
  private modelDone = new Set<string>(); // eval_ids already persisted
  private modelEvals = new Map<string, ModelEvaluation | null>(); // model|fp -> eval

  constructor(opts: JevAdapterOptions) {
    this.opts = opts;
    this.jev = opts.jev ?? null;
    this.coordinator = new DecisionCoordinator({
      mode: opts.mode,
      jev: this.jev,
      weights: { ...DEFAULT_RANK_WEIGHTS, ...(opts.weights ?? {}) },
      audit: opts.audit,
    });
  }

  private persist(kind: JevAuditRecord["kind"], jobId: string, detail: Record<string, unknown>) {
    try {
      this.opts.persist?.({ job_id: jobId, kind, detail });
    } catch { /* audit sink must never break decisions */ }
  }

  async rank(input: RouteInput, candidates: Candidate[], ctx: DecisionContext = {}): Promise<Candidate[]> {
    const jobId = input.job_id;
    // ---------- Task Judge: once per logical task ----------
    let task: TaskFeatures = {
      role: input.job.role,
      task_type_hint: roleHint(input.job.role),
    };
    if (this.opts.taskSummary) task.summary = this.opts.taskSummary;
    if (this.jev) {
      const tfp = `${jobId}:${taskFingerprint(task)}`;
      if (!this.taskCache.has(tfp)) {
        if (this.taskCache.size > 256) this.taskCache.clear();
        try {
          const j = await this.jev.judgeTask(task);
          this.taskCache.set(tfp, j);
          this.persist("jev_task_eval", jobId, {
            task_fingerprint: tfp, task_type: j.task_type,
            complexity: j.complexity, risk: j.risk, uncertainty: j.uncertainty,
            needs_review: j.needs_review, confidence: j.confidence, model: j.model,
          });
        } catch (e) {
          this.taskCache.set(tfp, null);
          this.persist("jev_task_eval", jobId, {
            task_fingerprint: tfp, error_code: e instanceof JevError ? e.code : "JEV_UNKNOWN",
          });
        }
      }
      const judgment = this.taskCache.get(tfp);
      // A confident judged type refines the hint — it can never relax any
      // constraint (the candidate set was hard-filtered before this point).
      if (judgment && judgment.task_type !== "other") {
        task = { ...task, task_type_hint: judgment.task_type };
      }
    }

    // ---------- Model Judge: per (model, catalog fingerprint, rubric) ----------
    const evalFits = new Map<string, Record<string, number>>();
    if (this.jev) {
      const stale = input.policy.max_quota_staleness_seconds;
      void stale;
      for (const c of candidates) {
        const fp = catalogFingerprint(c);
        const key = `${c.model_id}|${fp}`;
        if (!this.modelEvals.has(key)) {
          if (this.modelEvals.size > 256) this.modelEvals.clear();
          try {
            const ev: ModelEvidence = {
              model_id: c.model_id,
              catalog_fingerprint: fp,
              sourced_evidence: sourcedEvidence(c),
            };
            const e = await this.jev.judgeModel(ev);
            this.modelEvals.set(key, e);
            if (!this.modelDone.has(e.eval_id)) {
              this.modelDone.add(e.eval_id);
              this.persist("jev_model_eval", jobId, {
                eval_id: e.eval_id, model_id: e.model_id, catalog_fingerprint: fp,
                rubric_version: e.rubric_version, insufficient_evidence: e.insufficient_evidence,
                scores: e.scores, model: e.model, provenance: e.provenance,
              });
              this.opts.evalSink?.({
                kind: "model", subject_id: c.model_id, catalog_fingerprint: fp,
                rubric_version: e.rubric_version,
                reasons: { scores: e.scores, insufficient_evidence: e.insufficient_evidence },
                provenance: "jev-model-judge",
              });
            }
          } catch (err) {
            this.modelEvals.set(key, null);
            this.persist("jev_model_eval", jobId, {
              model_id: c.model_id, catalog_fingerprint: fp,
              error_code: err instanceof JevError ? err.code : "JEV_UNKNOWN",
            });
          }
        }
        const e2 = this.modelEvals.get(key);
        if (e2) evalFits.set(c.candidate_id, e2.scores);
      }
    }

    // ---------- evidence from ACTUAL effective ctx, never manifest claims ----------
    const staleSecs = input.policy.max_quota_staleness_seconds;
    const evidence: EvidenceCandidate[] = candidates.map((c) => {
      const pid = c.plugin.manifest.plugin_id;
      const { flags, unknown } = capabilityFlags(ctx.effectiveCaps?.get(pid));
      const qRaw = ctx.quota?.get(`${pid}|${c.model_id}`) ?? ctx.quota?.get(c.candidate_id) ?? null;
      const norm = normalizeQuota(qRaw, staleSecs);
      const unknowns: string[] = [];
      if (unknown) unknowns.push("capabilities");
      const quotaStatus = !norm ? "unknown" : norm.status === "exhausted" ? "exhausted" : norm.status === "known" ? "known" : "unknown";
      const latency = this.opts.observeLatency?.(c.candidate_id) ?? null;
      const evalFit = evalFits.get(c.candidate_id);
      return toEvidenceCandidate(c, {
        capability_flags: flags,
        quota_status: quotaStatus,
        quota_fresh: quotaFresh(qRaw, staleSecs),
        latency_ms_p50: latency,
        eval_fit: evalFit,
        observations_fresh: latency !== null,
        unknowns,
      });
    });

    const res = await this.coordinator.decide(
      {
        role: input.job.role,
        effortAliasOrder: input.policy.aliases[input.effortAlias ?? "standard"] ?? [],
        task,
      },
      evidence,
    );
    // ---------- rank audit with job linkage ----------
    this.persist("jev_rank", jobId, {
      adapter_used: res.audit.adapter_used,
      fit_source: res.audit.fit_source,
      jev_model_requested: res.audit.jev_model_requested,
      jev_model_actual: res.audit.jev_model_actual,
      candidate_ids: res.audit.candidate_ids,
      chosen: res.audit.chosen,
      error_code: res.audit.error_code,
      shadow_disagreement: res.audit.shadow_disagreement,
      duration_ms: res.audit.duration_ms,
      reason: boundText(res.audit.reason, 256),
    });

    // Map chosen IDs back to the ORIGINAL hard-filtered candidate objects —
    // adapter-returned objects are never trusted (router.plan revalidates too).
    const byId = new Map(candidates.map((c) => [c.candidate_id, c]));
    return res.ordered_ids.map((id) => byId.get(id)!).filter(Boolean);
  }
}

function roleHint(role: string): NonNullable<TaskFeatures["task_type_hint"]> {
  return ["coding", "review", "research", "planning"].includes(role)
    ? (role as "coding")
    : "other";
}

// Build a Jev adapter from operator config. The API key is read ONCE from the
// named operator environment variable and passed only to the JevClient
// constructor — never persisted, logged, or propagated to job/plugin env.
// With no key the coordinator records "jev not configured" and falls back to
// the identical rule ranking — it never claims Jev ran.
export function buildJevAdapter(
  cfg: { mode: DecisionMode; api_key_env?: string; weights?: Partial<RankWeights> },
  opts: {
    audit?: (r: unknown) => void;
    persist?: (r: JevAuditRecord) => void;
    evalSink?: JevAdapterOptions["evalSink"];
    observeLatency?: (candidateId: string) => number | null;
    taskSummary?: string;
  } = {},
): DecisionAdapter | null {
  if (cfg.mode === "off") return null;
  let service: JevDecisionService | null = null;
  if (cfg.api_key_env) {
    const key = process.env[cfg.api_key_env];
    if (key) service = new JevDecisionService(new JevClient({ apiKey: key }));
  }
  return new JevDecisionAdapter({
    mode: cfg.mode,
    jev: service,
    weights: cfg.weights,
    audit: opts.audit,
    persist: opts.persist,
    evalSink: opts.evalSink,
    observeLatency: opts.observeLatency,
    taskSummary: opts.taskSummary,
  });
}
