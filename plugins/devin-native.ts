// Devin native plugin — speaks the router plugin JSON-RPC protocol on
// stdio and drives `devin acp` (ACP v1) per run.
//
// Env (approved names only, supplied by parent via allowlist):
//   DEVIN_CLI_EXECUTABLE   absolute path to official devin binary (required)
//   DEVIN_CLI_SHA256       pinned sha256 of the realpath'd binary (required)
//   DEVIN_CLI_VERSION_RANGE e.g. ">=3000.0.0 <3001.0.0" (default ">=0.0.0")
//   DEVIN_CLI_VERSION_ARGS  default "version"
//
// The plugin never reads auth files, never runs `devin auth`, never sends
// an ACP `authenticate` request, and never enables refusal fallback.
// Resume (session/load|resume) is NOT implemented: requests carrying
// native_session_id are rejected with UNSUPPORTED_CAPABILITY.
import { servePlugin, specFromEnv } from "../src/native/plugin.js";
import { Capabilities } from "../src/native/types.js";

const checked = new Date().toISOString();
const cap = (status: "supported" | "unsupported" | "unknown", evidence: string) => ({ status, evidence, checked_at: checked });

const capabilities: Capabilities = {
  mode_agent: cap("supported", "ACP session/prompt; protocol path verified vs synthetic ACP fixture"),
  mode_text: cap("supported", "ACP agent_message_chunk text deltas only"),
  model_selection: cap("supported", "devin acp --model <exact catalog id>; fuzzy names never constructed"),
  effort: cap("unknown", "no verified effort interface for devin acp; requests with effort are rejected"),
  structured_events: cap("supported", "ACP session/update notifications"),
  resume: cap("unsupported", "agent advertises loadSession; resume path intentionally not implemented/verified"),
  // The interactive permission bridge is verified ONLY against the synthetic
  // ACP fixture (FAKE_ACP_SCENARIO marks fixture mode). Against a real
  // `devin acp` binary request_permission is unverified — stays "unknown".
  permission: process.env.FAKE_ACP_SCENARIO ? "interactive" : "unknown",
  run_usage: cap("supported", "ACP usage_update context used/size; NOT per-run tokens, NOT quota"),
  quota: cap("unknown", "no verified quota observer for this CLI"),
  graceful_cancel: cap("unknown", "session/cancel exists in ACP v1; remote confirmation unverified vs real CLI"),
  cwd: cap("supported", "session/new cwd + spawn cwd"),
  network: "required",
  filesystem: "unknown", // no verified profile/tool isolation
};

const spec = specFromEnv("DEVIN_CLI");

servePlugin({
  info: { plugin_id: "devin-native", plugin_version: "0.1.0" },
  spec,
  kind: "devin-acp",
  capabilities,
  methods: ["handshake", "probe", "run", "cancel", "respondPermission"],
  permissionCapable: true,
});
