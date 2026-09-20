// Shared wire types come from the single TypeBox contract source in
// ../contracts/index.js — this module only RE-EXPORTS them so the native
// adapters import through one path. Do NOT define RunRequest/Capabilities/
// event shapes here; that would create a competing contract.
// Only native-protocol-local types (NativeSpec, PluginInfo) live below.
import type { Capabilities } from "../contracts/index.js";
export type {
  CapStatus, ErrorCode, ErrorPhase, RetrySafety, SideEffects,
  NativeError, Usage, CapabilityEntry, Capabilities,
  Profile, QuotaObservation, ProbeResult, PermissionMode,
  RunRequest, RunResult, CanonicalEvent,
  PermissionOption, PermissionOptionKind, PermissionOptionWire, NormalizedPermissionOption,
} from "../contracts/index.js";
export { PERMISSION_CANCELLED, normalizeOptionKind, normalizePermissionOptions } from "../contracts/index.js";

// Alias of the contract union — not a separate definition.
export type PermissionCap = Capabilities["permission"];

// Explicit native spec supplied by the trusted operator profile env (never
// derived from cwd/PATH/task input). Executable must be an absolute realpath;
// sha256 is verified before the CLI is ever executed for a run.
export interface NativeSpec {
  executable: string; // absolute path to approved CLI executable
  sha256: string; // pinned binary identity (hex, 64 chars)
  version_range: string; // e.g. ">=3000.0.0 <3001.0.0"
  version_args: string[]; // e.g. ["--version"]; bounded no-inference call
  base_args?: string[]; // leading argv before subcommand (fixture: node <script>)
}

export interface PluginInfo {
  plugin_id: string;
  plugin_version: string;
}
