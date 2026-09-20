// Antigravity native plugin — speaks the router plugin JSON-RPC protocol on
// stdio and drives `agy --input-format stream-json --output-format
// stream-json --model <exact-slug>` per run (one turn, stdin user event).
//
// Env (approved names only):
//   AGY_CLI_EXECUTABLE    absolute path to official agy binary (required)
//   AGY_CLI_SHA256        pinned sha256 of the realpath'd binary (required)
//   AGY_CLI_VERSION_RANGE e.g. ">=1.2.0 <1.3.0" (default ">=0.0.0")
//   AGY_CLI_VERSION_ARGS  default "--version"
//
// Realtime approval is impossible on this stream (control_request /
// control_response are rejected by the CLI): permission is
// preconfigured_only and respondPermission is not registered.
// --dangerously-skip-permissions is NEVER added. Resume (--conversation)
// is NOT implemented; native_session_id is rejected.
import { servePlugin, specFromEnv } from "../src/native/plugin.js";
import { Capabilities } from "../src/native/types.js";

const checked = new Date().toISOString();
const cap = (status: "supported" | "unsupported" | "unknown", evidence: string) => ({ status, evidence, checked_at: checked });

const capabilities: Capabilities = {
  mode_agent: cap("supported", "stream-json step_update/result; protocol path verified vs synthetic fixture"),
  mode_text: cap("supported", "step_type agent_response text_delta only"),
  model_selection: cap("supported", "agy --model <exact slug>; unknown model exits nonzero per official docs"),
  effort: cap("supported", "agy --effort low|medium|high documented; per-model applicability unverified"),
  structured_events: cap("supported", "stream-json init/step_update/result"),
  resume: cap("unsupported", "--conversation exists in help; not implemented/verified"),
  permission: "preconfigured_only", // headless policy only; no control channel
  run_usage: cap("supported", "result.usage cumulative session totals"),
  quota: cap("unknown", "no verified quota observer for this CLI"),
  graceful_cancel: cap("unknown", "no remote cancel protocol; local termination only"),
  cwd: cap("supported", "spawn cwd; init.cwd echo observed"),
  network: "required",
  filesystem: "unknown", // workspace auto-allow documented; isolation unverified
};

const spec = specFromEnv("AGY_CLI");

servePlugin({
  info: { plugin_id: "antigravity-native", plugin_version: "0.1.0" },
  spec,
  kind: "agy-stream",
  capabilities,
  methods: ["handshake", "probe", "run", "cancel"],
  permissionCapable: false,
});
