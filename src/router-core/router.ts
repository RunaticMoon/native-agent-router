// Router core: provider-agnostic. Registry -> hard filter (capability/policy/
// quota/capacity) -> decision adapter (decision only) -> deterministic rank ->
// final validation -> atomic local capacity reservation -> fallback / Lead.
// NO CLI-name switch anywhere in this file.
import { Capabilities, CreateJobRequest, ErrorCode, QuotaObservation, RunResult } from "../contracts/index.js";
import { PolicyProfile } from "../config.js";
import { Registry, RegisteredPlugin } from "../registry/registry.js";
import { Store } from "../storage/store.js";

export interface Candidate {
  candidate_id: string; // plugin_id|model_id|profile_id|mode|effort — exact identity
  plugin: RegisteredPlugin;
  model_id: string;
  native_profile_id: string;
  execution_mode: "agent" | "text";
  effort?: string;
  billing_model: string;
  incremental_cost: number | null;
  roles: string[];
}

export interface Reject {
  candidate_id: string;
  code: ErrorCode;
  reason: string;
}

export interface RouteInput {
  job: CreateJobRequest;
  job_id: string;
  policy: PolicyProfile;
  profile_id: string;
  execution_mode: "agent" | "text";
  effort?: string;
  effortAlias?: string; // policy alias name (easy/standard/hard), not a rank of intelligence
  exclude_attempt_ids?: Set<string>;
}

// Evidence context passed alongside the (cloned) candidate list — actual
// effective capabilities and normalized quota, for decision evidence only.
export interface DecisionContext {
  effectiveCaps?: Map<string, Capabilities>;
  quota?: Map<string, QuotaObservation | null>;
}

// ---------- decision adapter contract (decision ONLY — cannot execute,
// authorize, or relax constraints). Jev adapter implements this same iface.
export interface DecisionAdapter {
  name: string;
  // May reorder candidates or attach fit scores; MUST NOT add candidates.
  // `candidates` are deep copies — mutating them has no effect on routing.
  rank(input: RouteInput, candidates: Candidate[], ctx?: DecisionContext): Promise<Candidate[]>;
}

export class RuleBasedAdapter implements DecisionAdapter {
  name = "rule-based";
  async rank(input: RouteInput, candidates: Candidate[]): Promise<Candidate[]> {
    // Deterministic: role fitness -> billing preference -> cost -> stable id.
    const aliasOrder = input.policy.aliases[input.effortAlias ?? ""] ?? [];
    const score = (c: Candidate): number => {
      let s = 0;
      if (c.roles.includes(input.job.role)) s += 100;
      const ai = aliasOrder.indexOf(c.model_id);
      if (ai >= 0) s += 50 - ai;
      if (c.billing_model === "free") s += 10;
      else if (c.billing_model === "subscription_included") s += 5;
      if (c.incremental_cost !== null) s += Math.max(0, 5 - c.incremental_cost);
      return s;
    };
    return [...candidates].sort((a, b) => score(b) - score(a) || a.candidate_id.localeCompare(b.candidate_id));
  }
}

export function candidateId(p: string, m: string, prof: string, mode: string, effort?: string) {
  return `${p}|${m}|${prof}|${mode}|${effort ?? "-"}`;
}

function capOk(e: { status: string } | undefined): boolean {
  return e?.status === "supported"; // unknown is NOT supported
}

// Quota truthfulness: stale, future, or unparsable timestamps degrade the
// observation to "unknown" — a quota is never reported exhausted unless the
// provider actually observed exhausted, and "exhausted" itself is only
// trusted while fresh.
export function normalizeQuota(q: QuotaObservation | null | undefined, maxStaleSeconds: number): QuotaObservation | null {
  if (!q) return null;
  const t = new Date(q.observed_at).getTime();
  const now = Date.now();
  const degraded = { ...q, status: "unknown" as const, remaining: null };
  if (!Number.isFinite(t)) return degraded; // bad timestamp
  if (t > now + 60000) return degraded; // future timestamp
  if (now - t > maxStaleSeconds * 1000) return degraded; // stale
  if (q.expires_at !== undefined) {
    const e = new Date(q.expires_at).getTime();
    // malformed expiry degrades exactly like a stale/future timestamp
    if (!Number.isFinite(e) || e < now) return degraded;
  }
  return q;
}

export class Router {
  constructor(
    private registry: Registry,
    private store: Store,
    private adapter: DecisionAdapter,
  ) {}

  // Enumerate + hard-filter candidates. Returns eligible ordered list + rejects.
  async plan(input: RouteInput, effectiveCaps: Map<string, Capabilities>, quota: Map<string, QuotaObservation | null>): Promise<{ ordered: Candidate[]; rejects: Reject[] }> {
    const rejects: Reject[] = [];
    const candidates: Candidate[] = [];
    const policy = input.policy;

    for (const rp of this.registry.workerPlugins()) {
      // Lead-designated plugins are never ordinary workers (e.g. Codex).
      if (policy.allowed_plugins[0] !== "*" && !policy.allowed_plugins.includes(rp.manifest.plugin_id)) {
        continue;
      }
      if (input.job.preferred?.plugin_id && input.job.preferred.plugin_id !== rp.manifest.plugin_id) continue;
      const caps = effectiveCaps.get(rp.manifest.plugin_id) ?? rp.manifest.capabilities;
      const aliasListed = new Set(Object.values(policy.aliases).flat());
      for (const model of rp.catalog.models) {
        if (input.job.preferred?.model && input.job.preferred.model !== model.model_id) continue;
        // explicit_only models only enter the pool when explicitly selected
        if (model.explicit_only && input.job.preferred?.model !== model.model_id && !aliasListed.has(model.model_id)) continue;
        const efforts = input.effort ? [input.effort] : model.efforts.length ? [model.efforts[0]] : [undefined];
        for (const effort of efforts) {
          const cid = candidateId(rp.manifest.plugin_id, model.model_id, input.profile_id, input.execution_mode, effort);
          // exact candidate pinning: only the requested candidate identity runs
          if (input.job.preferred?.candidate_id && input.job.preferred.candidate_id !== cid) continue;
          const reject = (code: ErrorCode, reason: string) => rejects.push({ candidate_id: cid, code, reason });

          // --- hard capability filter (effective caps; unknown => unsupported)
          if (input.execution_mode === "agent" && !capOk(caps.mode_agent)) { reject("UNSUPPORTED_CAPABILITY", "agent mode"); continue; }
          if (input.execution_mode === "text" && !capOk(caps.mode_text)) { reject("UNSUPPORTED_CAPABILITY", "text mode"); continue; }
          if (!capOk(caps.structured_events)) { reject("UNSUPPORTED_CAPABILITY", "structured events"); continue; }
          if (effort && !capOk(caps.effort)) { reject("UNSUPPORTED_CAPABILITY", "effort"); continue; }
          if (policy.permission_mode === "interactive" && caps.permission !== "interactive") { reject("UNSUPPORTED_CAPABILITY", "live permission"); continue; }
          if (policy.permission_mode !== "interactive" && caps.permission === "unsupported") { /* still runnable */ }
          if (rp.manifest.network === "required" && caps.network === "unknown") { reject("UNSUPPORTED_CAPABILITY", "network unknown"); continue; }
          if (input.job.role && !model.roles.includes(input.job.role)) { reject("UNSUPPORTED_CAPABILITY", `role ${input.job.role}`); continue; }
          // policy-declared roles: role must be enabled by operator policy
          if (policy.roles && !policy.roles.includes(input.job.role)) { reject("UNSUPPORTED_CAPABILITY", `role ${input.job.role} not in policy`); continue; }
          // enforceable tool requirements: every required tool must be a
          // manifest-declared tool label (absent list = no verified surface)
          const tools = rp.manifest.tools ?? [];
          if (policy.required_tools?.some((t) => !tools.includes(t))) { reject("UNSUPPORTED_CAPABILITY", "required tool not offered"); continue; }
          // explicit cost policy: unknown cost rejected unless allowed;
          // known cost must be under the policy cap
          if (model.incremental_cost === null && policy.allow_unknown_cost === false) { reject("UNSUPPORTED_CAPABILITY", "incremental cost unknown"); continue; }
          if (policy.max_incremental_cost !== null && policy.max_incremental_cost !== undefined && (model.incremental_cost ?? Infinity) > policy.max_incremental_cost) { reject("UNSUPPORTED_CAPABILITY", "incremental cost over policy max"); continue; }
          // optional observed-latency bound (candidate_observations)
          if (policy.max_latency_ms_p50 !== undefined && policy.max_latency_ms_p50 !== null) {
            const lat = this.store.latestObservationLatency(cid);
            if (lat !== null && lat > policy.max_latency_ms_p50) { reject("RATE_LIMITED", "observed latency over policy bound"); continue; }
          }

          // --- quota filter. Stale/future/bad timestamps normalize to
          // "unknown" — NEVER asserted as exhausted. A fresh observed
          // "exhausted" is always rejected, even when unknown is allowed.
          const qRaw = quota.get(cid) ?? quota.get(`${rp.manifest.plugin_id}|${model.model_id}`);
          const q = normalizeQuota(qRaw, policy.max_quota_staleness_seconds);
          if (q && (q.status === "exhausted" || q.remaining === 0)) { reject("QUOTA_EXHAUSTED", "quota exhausted (observed)"); continue; }
          if (policy.require_quota_known && (!q || q.status !== "known")) {
            reject("UNSUPPORTED_CAPABILITY", `quota ${q ? q.status : "unknown"} — policy requires known`);
            continue;
          }

          candidates.push({
            candidate_id: cid, plugin: rp, model_id: model.model_id,
            native_profile_id: input.profile_id, execution_mode: input.execution_mode,
            effort, billing_model: model.billing_model, incremental_cost: model.incremental_cost,
            roles: model.roles,
          });
        }
      }
    }

    // The adapter receives DEEP COPIES — registry-owned candidate objects
    // (with nested manifest/catalog refs) are never exposed for in-place
    // mutation. Only candidate_ids in the returned list matter.
    const adapterView = candidates.map((c) => structuredClone(c));
    const ranked = await this.adapter.rank(input, adapterView, { effectiveCaps, quota });
    // Final validation + remap: the adapter only chooses IDs. Every returned
    // candidate_id is mapped back to the ORIGINAL hard-filtered candidate
    // object — adapter-mutated properties (model/profile/mode) never survive.
    const byId = new Map(candidates.map((c) => [c.candidate_id, c]));
    const ordered: Candidate[] = [];
    const seen = new Set<string>();
    for (const c of ranked) {
      const orig = byId.get(c.candidate_id);
      if (!orig) {
        rejects.push({ candidate_id: c.candidate_id, code: "UNSUPPORTED_CAPABILITY", reason: "adapter-fabricated candidate" });
        continue;
      }
      if (seen.has(c.candidate_id)) continue; // duplicates collapse to first occurrence
      seen.add(c.candidate_id);
      ordered.push(orig);
    }
    // hard-filtered candidates the adapter dropped keep a deterministic tail
    for (const c of candidates) if (!seen.has(c.candidate_id)) ordered.push(c);
    return { ordered, rejects };
  }
}

// ---------- fallback classification ----------
// A: pre-execution definite reject -> next candidate.
// B: post-start failure, positively verified no side effects -> bounded retry.
// C: side effects present -> recovery/replan, no auto new worker.
// D: outcome/effects unknown -> needs_recovery, no duplicate.
export type FailAction =
  | { kind: "next_candidate"; reason: string }
  | { kind: "retry_bounded"; reason: string }
  | { kind: "needs_recovery"; reason: string }
  | { kind: "lead_handoff"; reason: string };

export function classifyFailure(result: RunResult, attemptsUsed: number, maxAttempts: number, moreCandidates: boolean): FailAction {
  if (result.outcome === "cancelled") return { kind: "needs_recovery", reason: "cancelled" };
  const se = result.side_effects;
  const rs = result.retry_safety;
  if (se === "present") return { kind: "needs_recovery", reason: "side effects present — recovery, not auto-retry" };
  if (se === "unknown") return { kind: "needs_recovery", reason: "side effects unknown" };
  // se === none
  if (rs === "safe" && attemptsUsed < maxAttempts && moreCandidates) {
    return { kind: "next_candidate", reason: result.error?.message ?? "safe retry" };
  }
  if (rs === "safe" && attemptsUsed < maxAttempts) {
    return { kind: "retry_bounded", reason: result.error?.message ?? "safe bounded retry" };
  }
  return { kind: "lead_handoff", reason: `attempts=${attemptsUsed} exhausted or unsafe` };
}

export function leadHandoffRecord(input: RouteInput, tried: { candidate_id: string; error?: unknown }[], lastResult: RunResult | null, workspacePath: string) {
  return {
    kind: "lead_handoff" as const,
    task: input.job.task,
    role: input.job.role,
    policy: input.policy.name,
    tried_candidates: tried,
    last_error: lastResult?.error ?? null,
    side_effects: lastResult?.side_effects ?? "unknown",
    workspace_path: workspacePath,
    remaining_work: "unstarted-or-incomplete — human/Lead review required",
    approval_recovery_prerequisites: "inspect workspace; decide replan or Lead delegation",
  };
}
