// Bootstrap: assemble Store + Registry + Router + Runtime + Api from config.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./storage/store.js";
import { Registry } from "./registry/registry.js";
import { Router, RuleBasedAdapter, DecisionAdapter } from "./router-core/router.js";
import { Runtime } from "./runtime/runtime.js";
import { ApprovalBroker } from "./approval/broker.js";
import { Api } from "./http/api.js";
import { RouterConfig } from "./config.js";
import { sha256File } from "./process/safe-spawn.js";
import { buildJevAdapter } from "./decisions/jev-adapter.js";

const DIST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT_ROOT = path.resolve(DIST_ROOT, "..");

export interface Stack {
  store: Store;
  registry: Registry;
  runtime: Runtime;
  api: Api;
  approvals: ApprovalBroker;
}

export function buildStack(config: RouterConfig, adapter?: DecisionAdapter): Stack {
  const store = new Store(config.db_path);
  const registry = new Registry();
  registry.load(config.approved_manifest_dirs);
  // Jev adapter (off by default): the key never leaves the JevClient
  // constructor. Task/model/rank audit persists job-linked decision records;
  // model evaluations persist to the evaluations table. Shadow/active modes
  // still return the same hard-filtered candidate set on any failure.
  const persist = (r: { job_id: string; kind: string; detail: unknown }) => {
    try {
      store.recordDecision(r.job_id, r.kind, "jev", r.detail);
    } catch { /* store closed during shutdown */ }
  };
  const evalSink = (e: { kind: string; subject_id: string; catalog_fingerprint?: string; rubric_version?: string; fit?: number; confidence?: number; reasons?: unknown; provenance: string }) => {
    try {
      store.recordEvaluation(e);
    } catch { /* store closed during shutdown */ }
  };
  const decisionAdapter =
    adapter ??
    buildJevAdapter(config.jev ?? { mode: "off" }, {
      persist, evalSink,
      observeLatency: (cid) => store.latestObservationLatency(cid),
    }) ??
    new RuleBasedAdapter();
  const router = new Router(registry, store, decisionAdapter);
  const approvals = new ApprovalBroker(store);
  // Known in-memory secrets — fed to the stream redactor so a bearer token or
  // the operator's Jev key echoed by a child is redacted before release. The
  // Jev key is read once from the named env var here; it is never persisted
  // or propagated to plugin env.
  const secrets = config.principals.map((p) => p.token);
  const jevKeyEnv = config.jev?.api_key_env;
  if (jevKeyEnv && process.env[jevKeyEnv]) secrets.push(process.env[jevKeyEnv]!);
  const runtime = new Runtime(store, registry, router, approvals, config, path.join(path.dirname(config.db_path), "state"), secrets);
  const api = new Api(store, runtime, approvals, config);
  return { store, registry, runtime, api, approvals };
}

// Generate an operator-approved fixture manifest + catalog for the synthetic
// example plugin. In production these would be hand-approved files; here the
// generator writes them into the approved manifest dir with pinned realpaths.
export function writeFixtureManifest(approvedDir: string): string {
  fs.mkdirSync(approvedDir, { recursive: true });
  const node = fs.realpathSync(process.execPath);
  const pluginJs = fs.realpathSync(path.join(DIST_ROOT, "plugins/example-native/plugin-main.js"));
  // fixture CLI is a data-file script (not compiled); pinned by realpath+sha256
  const cliExe = fs.realpathSync(path.join(PROJECT_ROOT, "fixtures/fake-cli.mjs"));
  const cliSha = sha256File(cliExe);

  const catalog = {
    catalog_version: "fixture-1",
    plugin_id: "example-native",
    generated_at: new Date().toISOString(),
    sources: ["fixture-synthetic", "operator-static"],
    models: [
      { model_id: "fake-small", billing_model: "free", incremental_cost: 0, context_tokens: 8192, efforts: ["low", "high"], roles: ["coding", "review", "research", "planning"] },
      { model_id: "fake-large", billing_model: "subscription_included", incremental_cost: 1, context_tokens: 32768, efforts: ["high"], roles: ["coding", "review"] },
      // synthetic behavior identities for failure-path testing (fixture only)
      { model_id: "beh-fail-rate_limited", billing_model: "free", incremental_cost: 0, context_tokens: 8192, efforts: ["low"], roles: ["coding", "review", "research", "planning"], explicit_only: true },
      { model_id: "beh-fail-quota_exhausted", billing_model: "free", incremental_cost: 0, context_tokens: 8192, efforts: ["low"], roles: ["coding", "review", "research", "planning"], explicit_only: true },
      { model_id: "beh-soft-deny", billing_model: "free", incremental_cost: 0, context_tokens: 8192, efforts: ["low"], roles: ["coding", "review", "research", "planning"], explicit_only: true },
      { model_id: "beh-side-effects-unknown", billing_model: "free", incremental_cost: 0, context_tokens: 8192, efforts: ["low"], roles: ["coding", "review", "research", "planning"], explicit_only: true },
      { model_id: "beh-permission", billing_model: "free", incremental_cost: 0, context_tokens: 8192, efforts: ["low"], roles: ["coding", "review", "research", "planning"], explicit_only: true },
      { model_id: "beh-permission-allowonly", billing_model: "free", incremental_cost: 0, context_tokens: 8192, efforts: ["low"], roles: ["coding", "review", "research", "planning"], explicit_only: true },
      { model_id: "beh-hang", billing_model: "free", incremental_cost: 0, context_tokens: 8192, efforts: ["low"], roles: ["coding", "review", "research", "planning"], explicit_only: true },
    ],
  };
  const catalogPath = path.join(approvedDir, "example-native.catalog.json");
  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));

  const caps = (s: string, e: string) => ({ status: s, evidence: e });
  const manifest = {
    manifest_version: 1,
    plugin_id: "example-native",
    plugin_version: "0.1.0",
    protocol_version: 1,
    transport: "stdio-jsonrpc",
    command: { executable: node, args: [pluginJs, "--manifest", path.join(approvedDir, "example-native.manifest.json")] },
    cli: { name: "fake-cli", version_range: ">=1.0.0 <2.0.0", executable: cliExe, sha256: cliSha, invoker: node },
    codec: "ndjson-event",
    discovery: "static-manifest",
    catalog_path: catalogPath,
    required_env: [],
    network: "none",
    filesystem: "workspace_only",
    retention: { raw_output: false, diagnostics_bytes: 8192 },
    capabilities: {
      mode_agent: caps("supported", "fixture"), mode_text: caps("supported", "fixture"),
      model_selection: caps("supported", "--model"), effort: caps("supported", "--effort"),
      structured_events: caps("supported", "ndjson"), resume: caps("unsupported", "no verified resume"),
      permission: "interactive", run_usage: caps("supported", "usage event"),
      quota: caps("supported", "synthetic observer"), graceful_cancel: caps("supported", "SIGTERM"),
      cwd: caps("supported", "workspace"), network: "none", filesystem: "workspace_only",
    },
    designation: "worker",
  };
  const manifestPath = path.join(approvedDir, "example-native.manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return manifestPath;
}

export function demoPolicy(name = "default") {
  return {
    name,
    allowed_plugins: ["*"],
    roles: ["coding", "review", "research", "planning"],
    permission_mode: "interactive" as const,
    max_incremental_cost: null,
    allow_unknown_cost: true,
    max_concurrency: 2,
    max_wall_seconds: 30,
    require_quota_known: false,
    max_quota_staleness_seconds: 120,
    max_attempts: 2,
    // effort aliases = explicit policy preference orderings over catalog ids.
    // "free" means billing_model free with incremental_cost 0 — a true-free
    // policy should ALSO set max_incremental_cost:0 + allow_unknown_cost:false
    // so subscription_included models are excluded (see free-only in
    // routerd --init-example). Subscription-included stays allowed here.
    aliases: {
      free: ["fake-small"], easy: ["fake-small"],
      standard: ["fake-large"], hard: ["fake-large"], max: ["fake-large"],
    },
  };
}

// Fixture manifests for the two synthetic native plugins. These pin the
// fake-devin-acp.mjs / fake-agy.mjs stand-ins (never real CLIs) and mark every
// capability as fixture-verified only. Real-provider profiles stay
// operating-disabled until independently verified by an operator.
export function writeNativeFixtureManifests(approvedDir: string): string[] {
  fs.mkdirSync(approvedDir, { recursive: true });
  const node = fs.realpathSync(process.execPath);
  const written: string[] = [];

  const specs: {
    plugin_id: string;
    entry: string;
    cliName: string;
    fixture: string;
    envPrefix: string;
    codec: string;
    versionRange: string;
    caps: Record<string, unknown>;
    permission: string;
    tools: string[];
    models: Record<string, unknown>[];
  }[] = [
    {
      plugin_id: "devin-native",
      entry: "plugins/devin-native.js",
      cliName: "devin",
      fixture: "fixtures/fake-devin-acp.mjs",
      envPrefix: "DEVIN_CLI",
      codec: "acp-v1",
      versionRange: ">=3000.0.0 <3001.0.0",
      // fixture-verified interactive permission bridge (fake ACP only)
      permission: "interactive",
      tools: ["run_command", "fs_read", "fs_write"],
      caps: {
        mode_agent: "supported:ACP session/prompt; synthetic fixture verified",
        mode_text: "supported:agent_message_chunk text deltas only",
        model_selection: "supported:--model exact catalog id",
        effort: "unknown:no verified effort interface; requests rejected",
        structured_events: "supported:session/update notifications",
        resume: "unsupported:loadSession not implemented/verified",
        run_usage: "supported:usage_update context only (not per-run tokens)",
        quota: "unknown:no verified quota observer",
        graceful_cancel: "unknown:session/cancel exists; remote confirm unverified",
        cwd: "supported:session/new cwd + spawn cwd",
      },
      models: [
        { model_id: "devin-fake-1", billing_model: "subscription_included", incremental_cost: null, context_tokens: 200000, efforts: [], roles: ["coding", "review", "research", "planning"] },
      ],
    },
    {
      plugin_id: "antigravity-native",
      entry: "plugins/antigravity-native.js",
      cliName: "agy",
      fixture: "fixtures/fake-agy.mjs",
      envPrefix: "AGY_CLI",
      codec: "ndjson-event",
      versionRange: ">=1.2.0 <1.3.0",
      permission: "preconfigured_only",
      tools: ["ask_permission", "run_command", "write_to_file"],
      caps: {
        mode_agent: "supported:stream-json step_update/result; synthetic fixture verified",
        mode_text: "supported:agent_response text_delta only",
        model_selection: "supported:--model exact slug",
        effort: "supported:--effort documented; per-model applicability unverified",
        structured_events: "supported:init/step_update/result",
        resume: "unsupported:--conversation not implemented/verified",
        run_usage: "supported:result.usage cumulative totals",
        quota: "unknown:no verified quota observer",
        graceful_cancel: "unknown:no remote cancel; local termination only",
        cwd: "supported:spawn cwd; init.cwd echo",
      },
      models: [
        { model_id: "agy-fake-1", billing_model: "free", incremental_cost: 0, context_tokens: 1000000, efforts: ["low", "medium", "high"], roles: ["coding", "review", "research", "planning"] },
      ],
    },
  ];

  for (const s of specs) {
    // The executed "CLI" is the node binary (fixture script is a data arg);
    // the manifest pins node by realpath+sha256, matching the profile env spec.
    const cliExe = node;
    const cliSha = sha256File(cliExe);
    const pluginJs = fs.realpathSync(path.join(DIST_ROOT, s.entry));
    const manifestPath = path.join(approvedDir, `${s.plugin_id}.manifest.json`);
    const catalogPath = path.join(approvedDir, `${s.plugin_id}.catalog.json`);
    const caps: Record<string, unknown> = { permission: s.permission, network: "required", filesystem: "unknown" };
    for (const [k, v] of Object.entries(s.caps)) {
      const [status, evidence] = (v as string).split(":");
      caps[k] = { status, evidence, checked_at: new Date().toISOString() };
    }
    const manifest = {
      manifest_version: 1,
      plugin_id: s.plugin_id,
      plugin_version: "0.1.0",
      protocol_version: 1,
      transport: "stdio-jsonrpc",
      command: { executable: node, args: [pluginJs, "--manifest", manifestPath] },
      cli: { name: s.cliName, version_range: s.versionRange, executable: cliExe, sha256: cliSha },
      codec: s.codec,
      discovery: "static-manifest",
      catalog_path: catalogPath,
      required_env: [
        `${s.envPrefix}_EXECUTABLE`, `${s.envPrefix}_SHA256`,
        `${s.envPrefix}_BASE_ARGS`, `${s.envPrefix}_VERSION_ARGS`, `${s.envPrefix}_VERSION_RANGE`,
        s.envPrefix === "DEVIN_CLI" ? "FAKE_ACP_SCENARIO" : "FAKE_AGY_SCENARIO",
      ],
      tools: s.tools,
      network: "required",
      filesystem: "unknown",
      retention: { raw_output: false, diagnostics_bytes: 8192 },
      capabilities: caps,
      designation: "worker",
    };
    const catalog = {
      catalog_version: "fixture-1",
      plugin_id: s.plugin_id,
      generated_at: new Date().toISOString(),
      sources: ["fixture-synthetic", "operator-static"],
      models: s.models,
    };
    fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    written.push(manifestPath);
  }
  return written;
}

// Profile env that points the synthetic native plugins at the fixture CLIs.
// Operator supplies these per profile; FAKE_*_SCENARIO selects the fixture
// script behavior for tests (fixture-only, never present for real profiles).
export function nativeFixtureProfileEnv(scenarios: { acp?: string; agy?: string } = {}): Record<string, string> {
  const env: Record<string, string> = {};
  // The pinned "CLI executable" is the node binary itself; the fixture script
  // is a BASE_ARGS data file. sha256 pins the node binary identity.
  const node = fs.realpathSync(process.execPath);
  const nodeSha = sha256File(node);
  const pairs: [string, string, string][] = [
    ["DEVIN_CLI", "fixtures/fake-devin-acp.mjs", ">=3000.0.0 <3001.0.0"],
    ["AGY_CLI", "fixtures/fake-agy.mjs", ">=1.2.0 <1.3.0"],
  ];
  for (const [prefix, fixture, range] of pairs) {
    const script = fs.realpathSync(path.join(PROJECT_ROOT, fixture));
    env[`${prefix}_EXECUTABLE`] = node;
    env[`${prefix}_SHA256`] = nodeSha;
    env[`${prefix}_BASE_ARGS`] = script;
    env[`${prefix}_VERSION_ARGS`] = `${script} --version`;
    env[`${prefix}_VERSION_RANGE`] = range;
  }
  if (scenarios.acp) env.FAKE_ACP_SCENARIO = scenarios.acp;
  if (scenarios.agy) env.FAKE_AGY_SCENARIO = scenarios.agy;
  return env;
}
