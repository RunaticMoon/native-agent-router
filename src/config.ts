// Operator config: the ONLY source that approves manifests, workspaces,
// principals, and policies. Loaded from an operator-specified path.
import { Type, Static } from "@sinclair/typebox";
import * as fs from "node:fs";
import { check } from "./contracts/index.js";

export const Principal = Type.Object(
  {
    id: Type.String(),
    token: Type.String({ minLength: 16 }), // demo generates a 0600 token file
    scopes: Type.Array(
      Type.Union([
        Type.Literal("jobs:write"),
        Type.Literal("jobs:read"),
        Type.Literal("approve"),
        Type.Literal("admin"),
      ]),
    ),
    policies: Type.Array(Type.String()), // policy profile names or "*"
    workspaces: Type.Array(Type.String()), // workspace handles or "*"
  },
  { additionalProperties: false },
);
export type Principal = Static<typeof Principal>;

export const PolicyProfile = Type.Object({
  name: Type.String(),
  allowed_plugins: Type.Array(Type.String()), // plugin_ids or "*"
  // operator-defined role names admitted by this policy (wire role is free string)
  roles: Type.Array(Type.String({ maxLength: 64 })),
  permission_mode: Type.Union([
    Type.Literal("interactive"),
    Type.Literal("preconfigured_only"),
    Type.Literal("deny"),
  ]),
  // which approved native profile + execution mode this policy selects
  // (no hardcoded "default"/"agent" — policy chooses)
  native_profile_id: Type.Optional(Type.String()),
  execution_mode: Type.Optional(Type.Union([Type.Literal("agent"), Type.Literal("text")])),
  required_tools: Type.Optional(Type.Array(Type.String({ maxLength: 64 }))),
  // explicit cost policy: null = no cap; unknown cost gated by allow_unknown_cost
  max_incremental_cost: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  allow_unknown_cost: Type.Boolean(),
  max_latency_ms_p50: Type.Optional(Type.Integer({ minimum: 1 })), // observed-latency bound
  max_concurrency: Type.Integer({ minimum: 1, maximum: 64 }),
  max_wall_seconds: Type.Integer({ minimum: 1, maximum: 86400 }),
  require_quota_known: Type.Boolean(), // reject unknown/stale quota unless false
  max_quota_staleness_seconds: Type.Integer({ minimum: 1 }),
  max_attempts: Type.Integer({ minimum: 1, maximum: 8 }), // bounded retries/fallback
  aliases: Type.Record(Type.String(), Type.Array(Type.String())), // e.g. easy->[model ids]
}, { additionalProperties: false });
export type PolicyProfile = Static<typeof PolicyProfile>;

export const JevConfig = Type.Object(
  {
    mode: Type.Union([Type.Literal("off"), Type.Literal("shadow"), Type.Literal("active")]),
    // name of the OPERATOR environment variable holding the Jev API key.
    // The key is read at bootstrap and passed only to the JevClient
    // constructor — never persisted, never in job/plugin env.
    api_key_env: Type.Optional(Type.String()),
    weights: Type.Optional(
      Type.Object(
        {
          fit: Type.Number(),
          cost: Type.Number(),
          quota: Type.Number(),
          latency: Type.Number(),
          stale_penalty: Type.Number(),
          unknown_penalty: Type.Number(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type JevConfig = Static<typeof JevConfig>;

export const RouterConfig = Type.Object({
  db_path: Type.String(),
  approved_manifest_dirs: Type.Array(Type.String()), // ONLY these dirs may supply manifests
  approved_workspace_base: Type.String(), // all job workspaces live under here
  profiles: Type.Record(
    Type.String(),
    Type.Object(
      {
        env: Type.Record(Type.String(), Type.String()), // approved env per profile
        // profiles are OPERATING DISABLED unless the operator explicitly
        // activates them — required, no silent default
        enabled: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  ),
  principals: Type.Array(Principal),
  policies: Type.Array(PolicyProfile),
  lead_handoff_enabled: Type.Boolean(),
  jev: Type.Optional(JevConfig),
  http: Type.Object(
    {
      host: Type.String(),
      port: Type.Integer({ minimum: 0, maximum: 65535 }),
      allow_public_bind: Type.Boolean(), // refuse non-loopback unless explicitly true
      max_active_jobs_per_principal: Type.Optional(Type.Integer({ minimum: 1 })), // default 16
      max_active_jobs_global: Type.Optional(Type.Integer({ minimum: 1 })), // default 64
      request_deadline_ms: Type.Optional(Type.Integer({ minimum: 100 })), // default 10000
    },
    { additionalProperties: false },
  ),
});
export type RouterConfig = Static<typeof RouterConfig>;

export function loadConfig(path: string): RouterConfig {
  const raw = JSON.parse(fs.readFileSync(path, "utf8"));
  const cfg = check(RouterConfig, raw, "router config");
  const host = cfg.http.host;
  const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  if (!loopback && !cfg.http.allow_public_bind) {
    throw new Error(`refusing public bind ${host} without allow_public_bind`);
  }
  return cfg;
}
