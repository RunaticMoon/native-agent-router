// Native Runtime: owns job/attempt/native-session/workspace lifecycle,
// plugin processes, storage, events, cancellation, approvals, recovery.
// Never makes model judgements; never executes Hermes functions.
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { Store, JobState, isTerminal } from "../storage/store.js";
import { Registry } from "../registry/registry.js";
import { Router, RouteInput, classifyFailure, leadHandoffRecord, Candidate, normalizeQuota } from "../router-core/router.js";
import { PluginHost } from "../plugin-sdk/plugin-host.js";
import { ApprovalBroker } from "../approval/broker.js";
import { RouterConfig, PolicyProfile } from "../config.js";
import {
  CanonicalEvent, CreateJobRequest, RunRequest, RunResult, Capabilities,
  QuotaObservation, NativeError, check,
  PermissionOption, NormalizedPermissionOption, normalizePermissionOptions, PERMISSION_CANCELLED,
} from "../contracts/index.js";
import {
  sha256File, verifyIdentity, signalVerifiedGroup, liveGroupMembers, liveChildrenOf,
  stopVerifiedGroup, recordChildIdentity, procIdentity, ProcIdentity,
} from "../process/safe-spawn.js";
import { redactText } from "../decisions/jev.js";
import { DeltaRedactor, redactDeep, exactSecretMatcher, collectRuntimeSecrets } from "./redactor.js";
import { envNameDenied } from "./env-deny.js";

export { envNameDenied };
export { DeltaRedactor };

export interface RunOutcome {
  job_id: string;
  status: JobState;
  result?: RunResult;
  lead_handoff?: unknown;
}

export class Runtime {
  private inflight = new Map<string, { host: PluginHost; attemptId: string; runId: string }>();
  private stopping = false;
  private execPromises = new Set<Promise<unknown>>();
  private probeCache = new Map<string, { at: number; caps: Capabilities; quota: QuotaObservation | null }>();
  private static PROBE_TTL_MS = 30_000;

  constructor(
    private store: Store,
    private registry: Registry,
    private router: Router,
    private approvals: ApprovalBroker,
    private config: RouterConfig,
    private stateDir: string,
    // Known exact in-memory secrets fed to the stream redactor (e.g. the
    // router bearer token). Held only in memory — never persisted or emitted.
    // Extra known exact secrets (test injection). Unioned with the secrets
    // collected from config — principal tokens, Jev key env, profile env.
    private secrets: string[] = [],
  ) {
    this.secrets = [...secrets, ...collectRuntimeSecrets(config)];
    this.secretsRe = exactSecretMatcher(this.secrets);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(config.approved_workspace_base, { recursive: true });
  }

  private secretsRe: RegExp | null;

  // ---------- workspace ----------
  prepareWorkspace(job: CreateJobRequest, jobId: string, principal: string): { path: string; mode: "fresh" | "locked"; handle: string | null } {
    const base = fs.realpathSync(this.config.approved_workspace_base);
    if (job.workspace.mode === "fresh") {
      const dir = path.join(base, `job-${jobId}`);
      fs.mkdirSync(dir, { recursive: false, mode: 0o700 });
      return { path: fs.realpathSync(dir), mode: "fresh", handle: null };
    }
    // locked approved workspace handle — serialized use, realpath under base
    const handle = job.workspace.handle;
    const ws = this.store.getWorkspace(handle);
    if (!ws) throw new Error(`workspace handle ${handle} not approved`);
    if (ws.principal !== principal) throw new Error(`workspace ${handle} not owned by principal`);
    const real = fs.realpathSync(ws.realpath);
    if (real !== base && !real.startsWith(base + path.sep)) {
      throw new Error(`workspace ${real} escapes approved base`);
    }
    if (!this.store.lockWorkspace(handle, jobId)) {
      throw new Error(`workspace ${handle} already locked`);
    }
    return { path: real, mode: "locked", handle };
  }

  // ---------- job admission ----------
  submit(principal: string, req: CreateJobRequest): { job_id: string } {
    const policy = this.policyFor(req.policy, principal);
    // operator-declared roles only — wire role is a free string bounded by policy
    if (!policy.roles.includes(req.role)) {
      throw new Error(`role ${req.role} not admitted by policy ${policy.name}`);
    }
    const profileId = policy.native_profile_id ?? "default";
    const profile = this.config.profiles[profileId];
    if (!profile) throw new Error(`policy selects unknown profile ${profileId}`);
    if (!profile.enabled) throw new Error(`profile ${profileId} is operating-disabled`);
    // Exact pre-launch validation: requested model/effort/candidate must exist
    // in an admitted plugin's catalog — never discovered after a worker starts.
    if (req.preferred?.model || req.preferred?.effort || req.preferred?.candidate_id || req.preferred?.plugin_id) {
      this.validatePreferred(req, policy, profileId);
    }
    const job_id = `job_${randomUUID()}`;
    const ws = this.prepareWorkspace(req, job_id, principal);
    this.store.createJob({
      job_id,
      principal,
      task: req.task,
      role: req.role,
      policy: req.policy,
      workspace_mode: ws.mode,
      workspace_path: ws.path,
      workspace_handle: ws.handle,
      request_json: JSON.stringify(req),
      deadline_ms: Date.now() + (req.deadline_seconds ?? policy.max_wall_seconds) * 1000,
    });
    return { job_id };
  }

  private validatePreferred(req: CreateJobRequest, policy: PolicyProfile, profileId: string) {
    const execMode = policy.execution_mode ?? "agent";
    const matches: { model_id: string; plugin_id: string; effort?: string; candidate_id: string }[] = [];
    for (const rp of this.registry.workerPlugins()) {
      if (policy.allowed_plugins[0] !== "*" && !policy.allowed_plugins.includes(rp.manifest.plugin_id)) continue;
      if (req.preferred?.plugin_id && req.preferred.plugin_id !== rp.manifest.plugin_id) continue;
      for (const m of rp.catalog.models) {
        if (req.preferred?.model && req.preferred.model !== m.model_id) continue;
        const efforts = req.preferred?.effort ? [req.preferred.effort] : m.efforts.length ? [m.efforts[0]] : [undefined];
        for (const e of efforts) {
          const cid = `${rp.manifest.plugin_id}|${m.model_id}|${profileId}|${execMode}|${e ?? "-"}`;
          if (req.preferred?.candidate_id && req.preferred.candidate_id !== cid) continue;
          if (req.preferred?.effort && !m.efforts.includes(req.preferred.effort)) continue;
          matches.push({ model_id: m.model_id, plugin_id: rp.manifest.plugin_id, effort: e, candidate_id: cid });
        }
      }
    }
    if (req.preferred?.model && !matches.length) throw new Error(`preferred.model ${req.preferred.model} not in admitted catalogs`);
    if (req.preferred?.effort && !matches.length) throw new Error(`preferred.effort ${req.preferred.effort} not offered by admitted catalogs`);
    if (req.preferred?.candidate_id && !matches.length) throw new Error(`preferred.candidate_id not an admitted candidate`);
    if (req.preferred?.plugin_id && !matches.length) throw new Error(`preferred.plugin_id not admitted or has no matching catalog`);
  }

  policyFor(name: string, principalScopes?: string): PolicyProfile {
    const p = this.config.policies.find((x) => x.name === name);
    if (!p) throw new Error(`unknown policy ${name}`);
    if (principalScopes) {
      const pr = this.config.principals.find((x) => x.id === principalScopes);
      if (pr && pr.policies[0] !== "*" && !pr.policies.includes(name)) {
        throw new Error(`principal may not use policy ${name}`);
      }
    }
    return p;
  }

  // Stop in-flight executions and await their settlement, bounded by
  // `deadlineMs` — a wedged plugin must not hang daemon shutdown forever.
  async shutdown(deadlineMs = 6000): Promise<void> {
    this.stopping = true;
    const stops = [...this.inflight.values()].map(({ host }) => {
      // Snapshot the plugin's live children BEFORE it is stopped — once it
      // dies they reparent and lineage becomes unverifiable.
      const kids = snapshotPluginChildren(host);
      return (async () => {
        await host.stop().catch(() => {});
        for (const k of kids) await stopVerifiedGroup(k, 300).catch(() => {});
      })();
    });
    await Promise.race([
      Promise.allSettled([...stops, ...this.execPromises]),
      new Promise((r) => setTimeout(r, deadlineMs).unref()),
    ]);
  }

  // ---------- execution ----------
  execute(jobId: string): Promise<RunOutcome> {
    const p = this.executeInner(jobId);
    this.execPromises.add(p);
    const done = () => this.execPromises.delete(p);
    void p.then(done, done);
    return p;
  }

  private async executeInner(jobId: string): Promise<RunOutcome> {
    if (this.stopping) return { job_id: jobId, status: "needs_recovery" };
    const job = this.store.getJob(jobId);
    if (!job) throw new Error("job not found");
    // Terminal states AND needs_recovery are never re-executed automatically.
    if (isTerminal(job.status) || job.status === "needs_recovery") {
      return { job_id: jobId, status: job.status };
    }
    const policy = this.config.policies.find((p) => p.name === job.policy)!;
    const req: CreateJobRequest = job.request_json
      ? { ...(JSON.parse(job.request_json) as CreateJobRequest), workspace: job.workspace_mode === "fresh" ? { mode: "fresh" } : { mode: "locked", handle: job.workspace_handle! } }
      : {
          task: job.task,
          role: job.role,
          policy: job.policy,
          workspace: job.workspace_mode === "fresh" ? { mode: "fresh" } : { mode: "locked", handle: job.workspace_handle! },
        };
    const profileId = policy.native_profile_id ?? "default";
    const routeInput: RouteInput = {
      job: req, job_id: jobId, policy,
      profile_id: profileId,
      execution_mode: policy.execution_mode ?? "agent",
      effort: req.preferred?.effort,
    };

    // Probe plugins for effective capabilities + quota observations.
    const { capsMap, quotaMap } = await this.probeAll(policy, profileId);
    const { ordered, rejects } = await this.router.plan(routeInput, capsMap, quotaMap);
    this.store.recordDecision(jobId, "route", this.routerName(), redactDeep({ candidates: ordered.map((c) => c.candidate_id), rejects }, this.secretsRe) as Record<string, unknown>);

    if (ordered.length === 0) {
      return this.exhausted(routeInput, jobId, rejects.map((r) => ({ candidate_id: r.candidate_id, error: r })), null, job.workspace_path);
    }

    const tried: { candidate_id: string; error?: unknown }[] = [];
    let lastResult: RunResult | null = null;
    const failureSigs = new Map<string, number>();

    for (let i = 0; i < ordered.length && tried.length < policy.max_attempts; i++) {
      if (this.stopping) break;
      const cand = ordered[i]!;
      const job2 = this.store.getJob(jobId)!;
      if (isTerminal(job2.status) || job2.status === "needs_recovery") break;
      if (this.store.cancelRequested(jobId)) {
        // cancel was requested before this attempt launched — do not launch
        lastResult = fail("CANCELLED", "cancel requested before launch", "launch");
        break;
      }
      if (Date.now() > job2.deadline_ms) {
        lastResult = fail("TIMEOUT", "job deadline exceeded", "run");
        break;
      }
      const outcome = await this.runAttempt(cand, routeInput, job2, policy, quotaMap);
      lastResult = outcome.result;
      tried.push({ candidate_id: cand.candidate_id, error: outcome.result.error ?? null });
      this.store.recordCandidateObservation({
        candidate_id: cand.candidate_id, plugin_id: cand.plugin.manifest.plugin_id,
        model_id: cand.model_id, kind: outcome.result.outcome === "completed" ? "run" : "error",
        error: outcome.result.error ?? undefined,
      });

      if (outcome.result.outcome === "completed" && outcome.result.status === "completed" && outcome.result.side_effects !== "unknown") {
        this.finalizeJobResult(jobId, outcome.result);
        this.finishJob(jobId, "succeeded");
        return { job_id: jobId, status: "succeeded", result: outcome.result };
      }
      if (outcome.result.outcome === "completed" && (outcome.result.status === "partial" || outcome.result.status === "blocked")) {
        // soft-completions are not success; classify like failure path C/D
        const action = outcome.result.side_effects === "none"
          ? classifyFailure({ ...outcome.result, outcome: "failed" }, tried.length, policy.max_attempts, i + 1 < ordered.length)
          : { kind: "needs_recovery" as const, reason: `soft status ${outcome.result.status}` };
        if (action.kind === "next_candidate") continue;
        return this.recoverOrHandoff(action, routeInput, jobId, tried, outcome.result, job.workspace_path);
      }
      if (outcome.result.outcome === "cancelled") {
        // Cancel ACK is not cancellation: only a natively-confirmed cancel is
        // 'cancelled'. Local stop with remote outcome unknown => needs_recovery.
        if (outcome.result.cancel_confirmed === true) {
          this.finalizeJobResult(jobId, outcome.result);
          this.finishJob(jobId, "cancelled");
          return { job_id: jobId, status: "cancelled", result: outcome.result };
        }
        return this.recoverOrHandoff({ kind: "needs_recovery", reason: "local stop confirmed; remote cancel outcome unknown" }, routeInput, jobId, tried, outcome.result, job.workspace_path);
      }
      const action = classifyFailure(outcome.result, tried.length, policy.max_attempts, i + 1 < ordered.length);
      if (action.kind === "next_candidate") {
        // no retry loops on repeated identical failures
        const sig = `${outcome.result.error?.code ?? "?"}|${outcome.result.status ?? ""}`;
        const seen = (failureSigs.get(sig) ?? 0) + 1;
        failureSigs.set(sig, seen);
        if (seen >= 2) return this.recoverOrHandoff({ kind: "needs_recovery", reason: `repeated identical failure ${sig}` }, routeInput, jobId, tried, outcome.result, job.workspace_path);
        continue;
      }
      if (action.kind === "retry_bounded") { i = -1; continue; } // retry from first candidate
      return this.recoverOrHandoff(action, routeInput, jobId, tried, outcome.result, job.workspace_path);
    }
    return this.exhausted(routeInput, jobId, tried, lastResult, job.workspace_path);
  }

  private routerName() {
    return "router-core";
  }

  private async recoverOrHandoff(action: { kind: string; reason?: string }, routeInput: RouteInput, jobId: string, tried: { candidate_id: string; error?: unknown }[], last: RunResult, wsPath: string): Promise<RunOutcome> {
    if (action.kind === "needs_recovery") {
      this.finalizeJobResult(jobId, last, { recovery_required: true, reason: action.reason });
      this.finishJob(jobId, "needs_recovery");
      return { job_id: jobId, status: "needs_recovery", result: last };
    }
    return this.exhausted(routeInput, jobId, tried, last, wsPath);
  }

  private exhausted(routeInput: RouteInput, jobId: string, tried: { candidate_id: string; error?: unknown }[], last: RunResult | null, wsPath: string): RunOutcome {
    // Lead handoff is an operator-enabled feature; when disabled the job
    // simply fails with the tried-candidate errors — no handoff record.
    if (!this.config.lead_handoff_enabled) {
      this.finalizeJobResult(jobId, last ?? undefined, { lead_handoff: null, remaining_work: "exhausted candidates; lead handoff disabled" });
      this.finishJob(jobId, "failed");
      return { job_id: jobId, status: "failed" };
    }
    // The handoff embeds the task text — redact once so the decision log and
    // the exported result carry the same clean copy.
    const handoff = redactDeep(leadHandoffRecord(routeInput, tried, last, wsPath), this.secretsRe) as Record<string, unknown>;
    this.store.recordDecision(jobId, "lead_handoff", "router-core", handoff);
    this.finalizeJobResult(jobId, last ?? undefined, { lead_handoff: handoff });
    this.finishJob(jobId, "failed"); // failed with structured Lead handoff; no silent Codex spawn
    return { job_id: jobId, status: "failed", lead_handoff: handoff };
  }

  // Final normalized job result: run result + attempts + artifacts +
  // approval/delivery state + honest verification status. Redacted before
  // persistence — never raw stderr or unredacted text.
  private finalizeJobResult(jobId: string, result?: RunResult, extra: Record<string, unknown> = {}) {
    const job = this.store.getJob(jobId);
    const req = job?.request_json ? (JSON.parse(job.request_json) as CreateJobRequest) : null;
    const attemptRows = this.store.attemptsForJob(jobId);
    const lastAtt = attemptRows[attemptRows.length - 1];
    const attempts = attemptRows.map((a) => ({
      attempt_id: a.attempt_id,
      candidate_id: a.candidate_id,
      status: a.status,
      side_effects: a.side_effects,
      retry_safety: a.retry_safety,
      native_session_id: a.native_session_id,
      error: a.error_json ? JSON.parse(a.error_json) : null,
    }));
    const artifacts = this.store.artifactsForJob(jobId).map((a) => ({ kind: a.kind, ref: a.ref, meta: JSON.parse(a.meta_json) }));
    const approvalSummary = this.store.approvalsForJob(jobId).map((a) => ({
      approval_id: a.approval_id, action: a.action, status: a.status, delivery_state: a.delivery_state,
    }));
    this.store.setJobResult(jobId, redactDeep({
      ...(result ? { result } : {}),
      // requested vs observed: a model is "observed" only when the provider
      // reported it — never the echoed request.
      requested_model: req?.preferred?.model ?? lastAtt?.model_id ?? null,
      observed_model: result?.observed_model ?? "unknown",
      native_session_id: result?.native_session_id ?? lastAtt?.native_session_id ?? null,
      usage: result?.usage ?? null,
      side_effects: result?.side_effects ?? "unknown",
      retry_safety: result?.retry_safety ?? "unknown",
      // Verification was NOT run — distinct from "passed". The job outcome
      // reflects plugin-reported state only; no independent verifier ran.
      verification: { status: "not_run", evidence: "no verifier ran; outcome reflects plugin-reported state only" },
      attempts,
      attempted_candidate_errors: attempts.filter((a) => a.error).map((a) => ({ candidate_id: a.candidate_id, error: a.error })),
      artifacts, // [] when none — absent fields are never silently omitted
      approvals: approvalSummary,
      workspace: job
        ? { mode: job.workspace_mode, handle: job.workspace_handle, state: "retained" }
        : { mode: "unknown", handle: null, state: "unknown" },
      // Handoff fields are explicit even when absent: null/unknown is honest,
      // a missing key is not.
      lead_handoff: null,
      remaining_work: null,
      recovery_status: extra.recovery_required ? "required" : "none",
      ...extra,
    }, this.secretsRe));
  }

  private finishJob(jobId: string, to: JobState) {
    const ok = this.store.transitionJob(jobId, to);
    if (!ok) {
      // terminal already or illegal — record nothing
    }
    const job = this.store.getJob(jobId)!;
    if (job.workspace_handle && isTerminal(job.status)) {
      this.store.unlockWorkspace(job.workspace_handle, jobId);
    }
  }

  private async probeAll(policy: PolicyProfile, profileId: string): Promise<{ capsMap: Map<string, Capabilities>; quotaMap: Map<string, QuotaObservation | null> }> {
    const capsMap = new Map<string, Capabilities>();
    const quotaMap = new Map<string, QuotaObservation | null>();
    const profile = this.config.profiles[profileId];
    const profileEnv = profile?.enabled ? profile.env : {};
    for (const rp of this.registry.workerPlugins()) {
      if (policy.allowed_plugins[0] !== "*" && !policy.allowed_plugins.includes(rp.manifest.plugin_id)) continue;
      const cacheKey = `${rp.manifest.plugin_id}|${profileId}`;
      const cached = this.probeCache.get(cacheKey);
      let caps: Capabilities;
      let quota: QuotaObservation | null;
      if (cached && Date.now() - cached.at < Runtime.PROBE_TTL_MS) {
        caps = cached.caps;
        quota = cached.quota;
      } else {
        let host: PluginHost | null = null;
        try {
          host = await PluginHost.launch(rp, {
            cwd: this.stateDir,
            env: this.pluginEnv(profileId, rp.manifest.required_env),
            router_id: this.store.ownerId,
          });
          const probe = await host.probe({ profile: { native_profile_id: profileId, env: this.pluginEnv(profileId, rp.manifest.required_env) } });
          caps = intersectCaps(rp.manifest.capabilities, probe.capabilities);
          quota = probe.quota ?? null;
          this.probeCache.set(cacheKey, { at: Date.now(), caps, quota });
        } catch {
          caps = allUnknownCaps(rp.manifest.capabilities);
          quota = null;
        } finally {
          if (host) await host.stop();
        }
      }
      capsMap.set(rp.manifest.plugin_id, caps);
      for (const model of rp.catalog.models) {
        // Merge persisted observations: the freshest observation wins so a
        // stale probe never masks a newer recorded state.
        const stored = this.store.latestQuota(rp.manifest.plugin_id, model.model_id);
        const fresher = stored && (!quota || new Date(stored.observed_at).getTime() > new Date(quota.observed_at).getTime());
        quotaMap.set(`${rp.manifest.plugin_id}|${model.model_id}`, fresher ? stored! : quota);
        if (quota) {
          try {
            this.store.recordQuota({ plugin_id: rp.manifest.plugin_id, model_id: model.model_id, pool_id: quota.pool_id, status: quota.status, remaining: quota.remaining, limit: quota.limit, unit: quota.unit, source: quota.source, observed_at: quota.observed_at, expires_at: quota.expires_at, estimated: quota.estimated });
          } catch { /* store closed during shutdown */ }
          this.store.recordCandidateObservation({
            candidate_id: `${rp.manifest.plugin_id}|${model.model_id}|${profileId}|${policy.execution_mode ?? "agent"}|-`,
            plugin_id: rp.manifest.plugin_id, model_id: model.model_id, kind: "quota",
            detail: { status: quota.status, pool_id: quota.pool_id, source: quota.source },
          });
        }
      }
      void profileEnv;
    }
    return { capsMap, quotaMap };
  }

  // Plugin env: declared required names ∩ operator profile env ∩ env-name
  // denylist. Ambient env is never inherited; denied names are dropped even
  // if a manifest asks for them (manifest load also rejects them).
  private pluginEnv(profileId: string, required: string[]): Record<string, string> {
    const profile = this.config.profiles[profileId];
    if (!profile?.enabled) return {};
    const env: Record<string, string> = {};
    for (const name of required) {
      if (envNameDenied(name)) continue;
      if (profile.env[name] !== undefined) env[name] = profile.env[name];
    }
    return env;
  }

  private async runAttempt(cand: Candidate, routeInput: RouteInput, job: { job_id: string; task: string; role: string; workspace_path: string; workspace_mode: string; deadline_ms: number }, policy: PolicyProfile, quotaMap: Map<string, QuotaObservation | null>): Promise<{ result: RunResult }> {
    const attempt_id = `att_${randomUUID()}`;
    const run_id = `run_${randomUUID()}`;
    const profile = this.config.profiles[cand.native_profile_id];
    if (!profile?.enabled) {
      return { result: { outcome: "failed", side_effects: "none", retry_safety: "safe", error: errObj("PERMISSION_DENIED", `profile ${cand.native_profile_id} operating-disabled`, "launch", "safe") } };
    }
    // Final pre-launch revalidation: fresh normalized quota check defeats the
    // plan->launch staleness race.
    const q = normalizeQuota(quotaMap.get(cand.candidate_id) ?? quotaMap.get(`${cand.plugin.manifest.plugin_id}|${cand.model_id}`), policy.max_quota_staleness_seconds);
    if (q && (q.status === "exhausted" || q.remaining === 0)) {
      return { result: { outcome: "failed", side_effects: "none", retry_safety: "safe", error: errObj("QUOTA_EXHAUSTED", "quota exhausted at launch revalidation", "launch", "safe") } };
    }
    if (policy.require_quota_known && (!q || q.status !== "known")) {
      return { result: { outcome: "failed", side_effects: "none", retry_safety: "safe", error: errObj("UNSUPPORTED_CAPABILITY", "quota unknown at launch revalidation", "launch", "safe") } };
    }
    // Executable identity rechecked at launch (TOCTOU: file may have changed
    // since manifest load).
    try {
      if (sha256File(cand.plugin.cliExeReal) !== cand.plugin.manifest.cli.sha256) {
        return { result: { outcome: "failed", side_effects: "none", retry_safety: "safe", error: errObj("CLI_NOT_INSTALLED", "cli sha256 changed since approval", "launch", "safe") } };
      }
      const inv = cand.plugin.manifest.cli.invoker;
      if (inv && fs.realpathSync(inv) !== inv) {
        return { result: { outcome: "failed", side_effects: "none", retry_safety: "safe", error: errObj("CLI_NOT_INSTALLED", "cli invoker realpath changed since approval", "launch", "safe") } };
      }
      const pexe = cand.plugin.pluginExeReal;
      if (fs.realpathSync(pexe) !== pexe) {
        return { result: { outcome: "failed", side_effects: "none", retry_safety: "safe", error: errObj("CLI_NOT_INSTALLED", "plugin executable realpath changed", "launch", "safe") } };
      }
    } catch (e) {
      return { result: { outcome: "failed", side_effects: "none", retry_safety: "safe", error: errObj("CLI_NOT_INSTALLED", `cli identity recheck failed: ${String(e).slice(0, 200)}`, "launch", "safe") } };
    }
    // Atomic multi-pool reservation: plugin slot + profile slot + workspace
    // slot + observed quota-pool slot (local estimate — not a provider hold).
    const pools: { key: string; max: number }[] = [
      { key: `plugin:${cand.plugin.manifest.plugin_id}`, max: policy.max_concurrency },
      { key: `profile:${cand.native_profile_id}`, max: policy.max_concurrency },
      { key: `workspace:${job.workspace_path}`, max: 1 },
    ];
    if (q?.pool_id) pools.push({ key: `quota:${q.pool_id}`, max: policy.max_concurrency });
    this.store.createAttempt({ attempt_id, job_id: job.job_id, candidate_id: cand.candidate_id, plugin_id: cand.plugin.manifest.plugin_id, model_id: cand.model_id });
    const reservations = this.store.reserveCapacityMulti(pools, attempt_id, job.job_id);
    if (!reservations) {
      this.store.finishAttempt(attempt_id, "failed", { error: errObj("RATE_LIMITED", "local capacity exhausted", "launch", "safe"), retry_safety: "safe", side_effects: "none" });
      return { result: { outcome: "failed", side_effects: "none", retry_safety: "safe", error: errObj("RATE_LIMITED", "local capacity exhausted", "launch", "safe") } };
    }

    this.store.setAttemptState(attempt_id, "queued");
    let host: PluginHost | null = null;
    const textRedactor = new DeltaRedactor(this.secrets);
    const appendEv = (kind: CanonicalEvent["kind"], payload: Record<string, unknown>) => {
      try {
        // Non-delta payloads are recursively redacted before persistence
        // (response text, errors, nested tool fields) — deltas are handled
        // by the streaming redactor so split secrets can't leak via either.
        if (kind !== "text.delta") {
          payload = redactDeep(payload, this.secretsRe) as Record<string, unknown>;
        }
        const seq = this.store.nextSequence(job.job_id);
        this.store.appendEvent({
          schema_version: 1, kind, job_id: job.job_id, attempt_id, run_id,
          event_id: `ev_${randomUUID()}`, sequence: seq, ts: new Date().toISOString(),
          payload,
        } as CanonicalEvent);
      } catch {
        /* store closed during crash-recovery; event dropped */
      }
    };
    const emit = (kind: CanonicalEvent["kind"], payload: Record<string, unknown>) => {
      if (kind === "text.delta" && typeof payload.text === "string") {
        payload = { ...payload, text: textRedactor.feed(payload.text as string) };
        if (!(payload.text as string).length) return; // all held in carry window
      }
      appendEv(kind, payload);
    };
    const flushRedactor = () => {
      // redacted tail goes straight to append — re-feeding would park it in
      // the carry window again and silently drop the last chunk
      const tail = textRedactor.flush();
      if (tail) appendEv("text.delta", { text: tail });
    };
    try {
      const runEnv = this.pluginEnv(cand.native_profile_id, cand.plugin.manifest.required_env);
      host = await PluginHost.launch(cand.plugin, {
        cwd: this.stateDir,
        env: runEnv,
        router_id: this.store.ownerId,
      });
      const ident = host.proc.identity;
      if (ident) this.store.markAttemptRunning(attempt_id, { pid: ident.pid, pgid: ident.pgid, exe: ident.exe_realpath, start: ident.proc_start });
      const pluginPid = host.proc.identity?.pid;
      this.store.transitionJob(job.job_id, "running");

      const timeoutMs = Math.min(policy.max_wall_seconds * 1000, Math.max(1000, job.deadline_ms - Date.now()));
      const runReq: RunRequest = {
        run_id, job_id: job.job_id, attempt_id,
        task: job.task, role: job.role,
        resolved_policy: { permission_mode: policy.permission_mode, max_wall_seconds: policy.max_wall_seconds },
        candidate_id: cand.candidate_id,
        workspace: { path: job.workspace_path, mode: job.workspace_mode as "fresh" | "locked" },
        native_profile_id: cand.native_profile_id,
        execution_mode: cand.execution_mode,
        requested_model: cand.model_id,
        requested_effort: cand.effort,
        deadline_ms: timeoutMs,
        env: runEnv,
      };
      check(RunRequest, runReq, "run request");
      this.inflight.set(job.job_id, { host, attemptId: attempt_id, runId: run_id });

      const result = await host.run(runReq, (ev) => {
        // normalize: runtime owns ordering + ids; plugin sequence ignored
        const { payload } = ev as { payload: Record<string, unknown> };
        emit(ev.kind, { ...payload, native_session_id: ev.native_session_id });
        if (ev.kind === "run.started" && typeof payload.native_pid === "number") {
          // Record full child identity ONLY when /proc lineage proves the
          // reported native_pid descends from THIS plugin process. A naked
          // pgid is never persisted as signalable identity.
          const parent = pluginPid;
          const ident = parent ? recordChildIdentity(payload.native_pid, parent) : null;
          if (ident) {
            this.store.setAttemptChildIdentity(attempt_id, ident);
          } else {
            this.store.recordDecision(job.job_id, "native_pid_unverified", "runtime", {
              attempt_id, reported_pid: payload.native_pid,
            });
          }
        }
        if (ev.kind === "permission.required") this.handlePermission(ev, job.job_id, attempt_id, run_id);
        if (ev.kind === "artifact.created") this.recordArtifact(ev, job.job_id, attempt_id, job.workspace_path);
      }, timeoutMs);

      flushRedactor();
      const term = result.outcome === "completed" ? "succeeded" : result.outcome === "cancelled" ? "cancelled" : "failed";
      if (result.outcome === "completed") emit("run.completed", { status: result.status ?? "unknown", response_text: result.response_text, observed_model: result.observed_model, usage: result.usage, side_effects: result.side_effects, retry_safety: result.retry_safety });
      if (result.outcome === "failed") emit("run.failed", { error: redactError(result.error ?? errObj("UNKNOWN_NATIVE_OUTCOME", "no error", "run", "unknown")) });
      if (result.outcome === "cancelled") emit("run.cancelled", { confirmed: result.cancel_confirmed ?? false });
      // cancelled outcome with unconfirmed remote state is not 'cancelled'
      const term2 = result.outcome === "cancelled" && result.cancel_confirmed !== true ? "needs_recovery" : term;
      const persisted = redactDeep({ error: result.error, result }, this.secretsRe) as { error?: typeof result.error; result?: typeof result };
      this.store.finishAttempt(attempt_id, term2 as JobState, { side_effects: result.side_effects, retry_safety: result.retry_safety, error: persisted.error, result: persisted.result, native_session_id: result.native_session_id });
      return { result };
    } catch (e) {
      const ne = errObj("UNKNOWN_NATIVE_OUTCOME", redactDeep(String(e).slice(0, 500), this.secretsRe) as string, "run", "unknown");
      emit("run.failed", { error: ne });
      this.store.finishAttempt(attempt_id, "needs_recovery", { side_effects: "unknown", retry_safety: "unknown", error: redactDeep(ne, this.secretsRe) as typeof ne });
      return { result: { outcome: "failed", side_effects: "unknown", retry_safety: "unknown", error: ne } };
    } finally {
      this.inflight.delete(job.job_id);
      let kids: ProcIdentity[] = [];
      if (host) {
        // Snapshot live plugin children BEFORE the plugin is stopped — if it
        // dies first they reparent and lineage is unverifiable. This covers
        // children spawned before/without a recorded run.started identity.
        kids = snapshotPluginChildren(host);
        try {
          const surv = host.proc.survivors();
          if (surv.length) emit("run.failed", { error: errObj("UNKNOWN_NATIVE_OUTCOME", `stubborn descendants: ${surv.join(",")}`, "run", "unknown") });
        } catch { /* store closed */ }
        await host.stop();
        // Stop the tracked native child group through verified identity only —
        // never a stored naked pgid.
        try {
          const a = this.store.getAttempt(attempt_id);
          const childIdent = a ? this.store.attemptChildIdentity(a) : null;
          if (childIdent) await stopVerifiedGroup(childIdent, 300);
        } catch { /* store closed */ }
        for (const k of kids) {
          try {
            await stopVerifiedGroup(k, 300);
          } catch { /* best-effort */ }
        }
      }
      // Release reservations ONLY when process outcome is confirmed dead: a
      // needs_recovery attempt (or unknown descendants) keeps capacity
      // quarantined rather than released.
      try {
        const a = this.store.getAttempt(attempt_id);
        const pluginIdent = a?.proc_start
          ? { pid: a.pid!, pgid: a.pgid!, exe_realpath: a.exe_realpath ?? "", proc_start: a.proc_start }
          : null;
        const childIdent = a ? this.store.attemptChildIdentity(a) : null;
        // plugin identity null means it never launched (host already stopped)
        const pluginDead = !pluginIdent || groupConfirmedDead(pluginIdent);
        // a recorded pgid with no verified identity is UNKNOWN, not dead
        const childDead = !a?.child_pgid
          ? true
          : childIdent ? groupConfirmedDead(childIdent) : false;
        // snapshotted plugin children must all be confirmed dead too —
        // a live one means unknown local effects.
        const kidsDead = kids.every((k) => groupConfirmedDead(k));
        const finished = a && (isTerminal(a.status) || a.status === "needs_recovery");
        const outcomeUnknown = !finished || !pluginDead || !childDead || !kidsDead;
        for (const res of this.store.reservationsForAttempt(attempt_id)) {
          if (res.state === "held") this.store.releaseCapacity(res.reservation_id, outcomeUnknown);
        }
      } catch {
        /* store may be closed mid-recovery; reservation handled by next owner */
      }
    }
  }

  // Validate BEFORE persistence: an invalid/escaped/credential-shaped ref is
  // dropped entirely — no artifact row, no event-side record.
  private recordArtifact(ev: CanonicalEvent, jobId: string, attemptId: string, wsPath: string): string | null {
    if (ev.kind !== "artifact.created") return null;
    const p = ev.payload as { path: string; artifact_kind: string };
    const real = validateArtifactRef(wsPath, p.path);
    if (!real) return null;
    try {
      const st = fs.statSync(real);
      this.store.recordArtifact({ job_id: jobId, attempt_id: attemptId, kind: p.artifact_kind, ref: real, meta: { size: st.size, mtime: st.mtime.toISOString() } });
      return real;
    } catch {
      /* unreadable artifact reference dropped */
      return null;
    }
  }

  // Permission decisions are fail-CLOSED: only an approved decision whose
  // chosen option is an offered allow-class option is delivered as allow.
  // Expired/denied/invalidated outcomes deliver the operator's verbatim
  // deny-class selection, else an offered reject/cancel-kind option, else the
  // native CANCELLED outcome — never a fabricated or positional allow.
  private handlePermission(ev: CanonicalEvent, jobId: string, attemptId: string, runId: string) {
    if (ev.kind !== "permission.required") return;
    const job = this.store.getJob(jobId)!;
    const policy = this.config.policies.find((p) => p.name === job.policy)!;
    if (policy.permission_mode !== "interactive") return; // preconfigured-only: no live approvals
    const p = ev.payload as { request_id: string; action: string; target: string; options: (string | PermissionOption)[] };
    const options = normalizePermissionOptions(p.options);
    const offered = (id?: string): NormalizedPermissionOption | undefined => options.find((o) => o.id === id);
    const isAllowKind = (o?: NormalizedPermissionOption): boolean =>
      !!o && (o.kind === "allow" || (o.kind === "unknown" && /^allow/i.test(o.id)));
    this.store.transitionJob(jobId, "awaiting_approval");
    // approval metadata is display data: action/target are redacted before
    // persistence; request_id + option ids stay RAW for delivery binding.
    const approvalId = this.approvals.request({
      job_id: jobId, attempt_id: attemptId, run_id: runId, native_request_id: p.request_id,
      action: redactDeep(p.action, this.secretsRe) as string,
      target: redactDeep(p.target, this.secretsRe) as string,
      options,
    });
    const inflight = this.inflight.get(jobId);
    const mark = (s: "delivered" | "failed" | "invalidated") => {
      try {
        this.store.setApprovalDelivery(approvalId, s);
      } catch { /* store closed */ }
    };
    this.approvals.waitFor(runId, p.request_id, 60000).then((d) => {
      try {
        this.store.transitionJob(jobId, "running");
      } catch { /* store closed */ }
      let chosen: string;
      if (d.status === "approved" && isAllowKind(offered(d.option))) {
        chosen = d.option!; // verbatim offered allow-class option id
      } else if (d.status === "denied" && d.option && offered(d.option) && !isAllowKind(offered(d.option))) {
        chosen = d.option; // operator's verbatim deny-class selection
      } else {
        const deny = options.find((o) => o.kind === "reject" || o.kind === "cancel")
          ?? options.find((o) => o.kind === "unknown" && /reject|deny|cancel/i.test(o.id));
        // no reject-class option offered -> native cancelled outcome; the
        // plugin SDK maps it to the protocol's cancellation, or fails the
        // delivery — never an invented allow.
        chosen = deny?.id ?? PERMISSION_CANCELLED;
      }
      if (!inflight) {
        mark("failed");
        return;
      }
      inflight.host
        .respondPermission(runId, p.request_id, chosen)
        .then(() => mark("delivered"))
        .catch(() => mark("failed"));
    }).catch(() => {});
  }

  // Cancellation is a REQUEST, not a result: persist cancel_requested, send
  // the native cancel, then let the in-flight run's observed outcome settle
  // the job (confirmed => cancelled; unknown => needs_recovery).
  async cancel(jobId: string): Promise<{ status: string }> {
    const job = this.store.getJob(jobId);
    if (!job) return { status: "not_found" };
    if (isTerminal(job.status) || job.status === "needs_recovery") return { status: "already_terminal" };
    this.store.markCancelRequested(jobId);
    const inflight = this.inflight.get(jobId);
    if (!inflight) {
      this.store.transitionJob(jobId, "cancelled");
      return { status: "cancelled" };
    }
    const ack = await inflight.host.cancel(inflight.runId).catch(() => null);
    if (ack?.ack !== "accepted") {
      return { status: "cancel_requested" };
    }
    // Wait bounded time for the run's observed outcome to settle the job.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const j = this.store.getJob(jobId);
      if (!j || isTerminal(j.status) || j.status === "needs_recovery") {
        return { status: j?.status === "cancelled" ? "cancel_confirmed" : (j?.status ?? "unknown") };
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    // Native completion did not arrive: escalate local process-group stop and
    // report remote-unknown. The run loop records needs_recovery. Snapshot
    // plugin children BEFORE it dies — after death lineage is unverifiable.
    const kids = snapshotPluginChildren(inflight.host);
    await inflight.host.proc.stop("SIGKILL", 500);
    const att = this.store.getAttempt(inflight.attemptId);
    const childIdent = att ? this.store.attemptChildIdentity(att) : null;
    const childStop = childIdent ? await stopVerifiedGroup(childIdent, 300) : null;
    for (const k of kids) {
      await stopVerifiedGroup(k, 300).catch(() => {});
    }
    this.store.invalidatePendingApprovals(inflight.attemptId);
    const survivors = inflight.host.proc.survivors();
    return {
      status: "cancel_local_confirmed_remote_unknown",
      ...(survivors.length ? { survivors } : {}),
      ...(childStop && !childStop.stopped ? { child_survivors: childStop.survivors } : {}),
      ...(att?.child_pgid && !childIdent ? { child_identity: "unverifiable" } : {}),
    };
  }

  // ---------- restart recovery ----------
  recoverOnStart() {
    // Non-terminal attempts from a previous owner: never duplicate. Every
    // signal goes through verified-identity checks — a stored pgid is never
    // signalled when the leader can't be re-verified or the group is empty.
    for (const a of this.store.nonTerminalAttempts()) {
      const pluginIdent = a.pid && a.proc_start
        ? { pid: a.pid, pgid: a.pgid!, exe_realpath: a.exe_realpath ?? "", proc_start: a.proc_start }
        : null;
      const childIdent = this.store.attemptChildIdentity(a);
      const pluginAlive = pluginIdent ? verifyIdentity(pluginIdent) : false;
      if (pluginAlive) signalVerifiedGroup(pluginIdent, "SIGKILL");
      const childAlive = childIdent ? verifyIdentity(childIdent) : false;
      if (childAlive) signalVerifiedGroup(childIdent, "SIGKILL");
      // Unknown = anything we cannot confirm dead: a live/empty-ambiguous
      // group, a recorded pgid without retained identity, or a non-terminal
      // attempt with no plugin identity at all.
      const pluginDead = pluginIdent ? groupConfirmedDead(pluginIdent) : false;
      const childDead = !a.child_pgid ? true : childIdent ? groupConfirmedDead(childIdent) : false;
      const unknown = pluginAlive || childAlive || !pluginDead || !childDead;
      this.store.finishAttempt(a.attempt_id, "needs_recovery", {
        side_effects: "unknown", retry_safety: "unknown",
        error: errObj("UNKNOWN_NATIVE_OUTCOME", unknown ? "process state unverifiable at restart; outcome unknown" : "process gone at restart", "run", "unknown"),
      });
      for (const r of this.store.reservationsForAttempt(a.attempt_id)) {
        if (r.state === "held") this.store.releaseCapacity(r.reservation_id, unknown);
      }
      this.store.invalidatePendingApprovals(a.attempt_id);
      const j = this.store.getJob(a.job_id);
      if (j && !isTerminal(j.status) && j.status !== "needs_recovery") {
        this.store.transitionJob(a.job_id, "needs_recovery");
        this.store.setJobResult(a.job_id, { recovery_required: true, reason: "router restart" });
      }
    }
  }
}

// Artifact references must be real regular files under the approved job
// workspace — metadata only, credentials-type files are never served.
export function validateArtifactRef(wsPath: string, ref: string): string | null {
  try {
    const base = fs.realpathSync(wsPath);
    const real = fs.realpathSync(ref);
    if (real !== base && !real.startsWith(base + path.sep)) return null;
    const st = fs.statSync(real);
    if (!st.isFile() || st.size > 8 * 1024 * 1024) return null;
    if (/(credential|secret|token|\.env$|\.pem$|\.key$|id_rsa)/i.test(real)) return null;
    return real;
  } catch {
    return null;
  }
}

function errObj(code: NativeError["code"], message: string, phase: NativeError["phase"], rs: NativeError["retry_safety"]): NativeError {
  return { code, message, phase, retry_safety: rs };
}
function redactError(e: NativeError): NativeError {
  return { ...e, message: redactText(e.message) };
}

// Snapshot a plugin host's live direct children as verified group identities.
// MUST run while the plugin is still alive — after it dies the children
// reparent and lineage can no longer be proven.
function snapshotPluginChildren(host: PluginHost): ProcIdentity[] {
  const pid = host.proc.identity?.pid;
  if (!pid) return [];
  const out: ProcIdentity[] = [];
  for (const c of liveChildrenOf(pid)) {
    const id = procIdentity(c, c);
    if (id) out.push(id);
  }
  return out;
}

// A process group is confirmed dead only when the leader fails verification
// AND no live members remain in the group — anything else is unknown.
function groupConfirmedDead(id: ProcIdentity): boolean {
  return !verifyIdentity(id) && liveGroupMembers(id.pgid).length === 0;
}
function fail(code: NativeError["code"], message: string, phase: NativeError["phase"]): RunResult {
  return { outcome: "failed", side_effects: "none", retry_safety: "safe", error: errObj(code, message, phase, "safe") };
}
function intersectCaps(decl: Capabilities, probed: Capabilities): Capabilities {
  const inter = (a: { status: string }, b: { status: string }) => ({
    status: a.status === "supported" && b.status === "supported" ? ("supported" as const) : a.status === "unsupported" || b.status === "unsupported" ? ("unsupported" as const) : ("unknown" as const),
  });
  return {
    mode_agent: inter(decl.mode_agent, probed.mode_agent),
    mode_text: inter(decl.mode_text, probed.mode_text),
    model_selection: inter(decl.model_selection, probed.model_selection),
    effort: inter(decl.effort, probed.effort),
    structured_events: inter(decl.structured_events, probed.structured_events),
    resume: inter(decl.resume, probed.resume),
    permission: decl.permission === "interactive" && probed.permission === "interactive" ? "interactive" : decl.permission === "unsupported" || probed.permission === "unsupported" ? "unsupported" : decl.permission === "preconfigured_only" || probed.permission === "preconfigured_only" ? "preconfigured_only" : "unknown",
    run_usage: inter(decl.run_usage, probed.run_usage),
    quota: inter(decl.quota, probed.quota),
    graceful_cancel: inter(decl.graceful_cancel, probed.graceful_cancel),
    cwd: inter(decl.cwd, probed.cwd),
    network: decl.network === "none" || probed.network === "none" ? "none" : decl.network === "required" || probed.network === "required" ? "required" : "unknown",
    filesystem: decl.filesystem === "workspace_only" && probed.filesystem === "workspace_only" ? "workspace_only" : decl.filesystem === "broader" || probed.filesystem === "broader" ? "broader" : "unknown",
  };
}
function allUnknownCaps(decl: Capabilities): Capabilities {
  const u = { status: "unknown" as const };
  return { ...decl, mode_agent: u, mode_text: u, structured_events: u, model_selection: u, effort: u, resume: u, run_usage: u, quota: u, graceful_cancel: u, cwd: u };
}
