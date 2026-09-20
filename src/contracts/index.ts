// Single source of truth: TypeBox schemas generate both TS types and wire validators.
// Wire objects are CLOSED (additionalProperties:false) — unknown fields are
// rejected. Only explicit open maps (env, payload records) remain open.
import { Type, Static, TSchema } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";

export const PROTOCOL_VERSION = 1;
export const EVENT_SCHEMA_VERSION = 1;
const CLOSED = { additionalProperties: false } as const;

// ---------- shared enums ----------
export const CapStatus = Type.Union([
  Type.Literal("supported"),
  Type.Literal("unsupported"),
  Type.Literal("unknown"),
]);
export type CapStatus = Static<typeof CapStatus>;

export const ErrorCode = Type.Union([
  Type.Literal("CLI_NOT_INSTALLED"),
  Type.Literal("CLI_VERSION_UNSUPPORTED"),
  Type.Literal("AUTH_REQUIRED"),
  Type.Literal("MODEL_UNAVAILABLE"),
  Type.Literal("UNSUPPORTED_CAPABILITY"),
  Type.Literal("QUOTA_EXHAUSTED"),
  Type.Literal("RATE_LIMITED"),
  Type.Literal("PERMISSION_DENIED"),
  Type.Literal("TIMEOUT"),
  Type.Literal("INVALID_OUTPUT"),
  Type.Literal("CANCELLED"),
  Type.Literal("UNKNOWN_NATIVE_OUTCOME"),
]);
export type ErrorCode = Static<typeof ErrorCode>;

export const ErrorPhase = Type.Union([
  Type.Literal("launch"),
  Type.Literal("handshake"),
  Type.Literal("probe"),
  Type.Literal("run"),
  Type.Literal("verify"),
  Type.Literal("cancel"),
]);
export type ErrorPhase = Static<typeof ErrorPhase>;

export const RetrySafety = Type.Union([
  Type.Literal("safe"),
  Type.Literal("unsafe"),
  Type.Literal("unknown"),
]);
export type RetrySafety = Static<typeof RetrySafety>;

export const SideEffects = Type.Union([
  Type.Literal("none"),
  Type.Literal("present"),
  Type.Literal("unknown"),
]);
export type SideEffects = Static<typeof SideEffects>;

export const NativeError = Type.Object(
  {
    code: ErrorCode,
    message: Type.String({ maxLength: 2000 }),
    phase: ErrorPhase,
    retry_safety: RetrySafety,
  },
  CLOSED,
);
export type NativeError = Static<typeof NativeError>;

export const Usage = Type.Object(
  {
    input_tokens: Type.Optional(Type.Integer({ minimum: 0 })),
    output_tokens: Type.Optional(Type.Integer({ minimum: 0 })),
    // cumulative=true means values are cumulative totals for the native session,
    // NOT deltas; consumers must never re-sum cumulative values.
    cumulative: Type.Boolean(),
  },
  CLOSED,
);
export type Usage = Static<typeof Usage>;

export const CapabilityEntry = Type.Object(
  {
    status: CapStatus,
    evidence: Type.Optional(Type.String({ maxLength: 500 })),
    checked_at: Type.Optional(Type.String()),
  },
  CLOSED,
);
export type CapabilityEntry = Static<typeof CapabilityEntry>;

export const Capabilities = Type.Object(
  {
    mode_agent: CapabilityEntry,
    mode_text: CapabilityEntry,
    model_selection: CapabilityEntry,
    effort: CapabilityEntry,
    structured_events: CapabilityEntry,
    resume: CapabilityEntry,
    permission: Type.Union([
      Type.Literal("interactive"),
      Type.Literal("preconfigured_only"),
      Type.Literal("unsupported"),
      Type.Literal("unknown"),
    ]),
    run_usage: CapabilityEntry,
    quota: CapabilityEntry,
    graceful_cancel: CapabilityEntry,
    cwd: CapabilityEntry,
    network: Type.Union([Type.Literal("none"), Type.Literal("required"), Type.Literal("unknown")]),
    filesystem: Type.Union([
      Type.Literal("workspace_only"),
      Type.Literal("broader"),
      Type.Literal("unknown"),
    ]),
  },
  CLOSED,
);
export type Capabilities = Static<typeof Capabilities>;

// ---------- plugin manifest ----------
export const Manifest = Type.Object(
  {
    manifest_version: Type.Literal(1),
    plugin_id: Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,63}$" }),
    plugin_version: Type.String(),
    protocol_version: Type.Literal(1),
    transport: Type.Literal("stdio-jsonrpc"),
    command: Type.Object(
      {
        executable: Type.String(), // absolute path, realpath+sha256 verified
        args: Type.Array(Type.String()),
      },
      CLOSED,
    ),
    cli: Type.Object(
      {
        name: Type.String(),
        version_range: Type.String(), // e.g. ">=1.0.0 <2.0.0" closed range syntax
        executable: Type.String(), // absolute path; realpath+sha256 verified
        sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
        // optional interpreter for script CLIs (e.g. node); absolute realpath-verified
        invoker: Type.Optional(Type.String()),
      },
      CLOSED,
    ),
    // generic codec/driver string: the plugin entrypoint selects the adapter
    // (e.g. "ndjson-event", "acp-v1", "fake-jsonl"). Core never switches on it.
    codec: Type.String({ minLength: 1, maxLength: 64 }),
    discovery: Type.Literal("static-manifest"),
    catalog_path: Type.String(), // absolute path to static catalog JSON
    required_env: Type.Array(Type.String({ pattern: "^[A-Z_][A-Z0-9_]{0,63}$" })),
    network: Type.Union([Type.Literal("none"), Type.Literal("required")]),
    filesystem: Type.Union([
      Type.Literal("workspace_only"),
      Type.Literal("broader"),
      Type.Literal("unknown"),
    ]),
    retention: Type.Object(
      {
        raw_output: Type.Literal(false),
        diagnostics_bytes: Type.Integer({ minimum: 0, maximum: 65536 }),
      },
      CLOSED,
    ),
    capabilities: Capabilities,
    // tool labels the plugin may invoke; policy.required_tools is checked
    // against this list (absent = no verified tool surface)
    tools: Type.Optional(Type.Array(Type.String({ maxLength: 64 }))),
    // REQUIRED: an absent designation must never implicitly become a worker.
    // "lead" plugins (e.g. Codex) are excluded from the worker pool entirely.
    designation: Type.Union([Type.Literal("worker"), Type.Literal("lead")]),
  },
  CLOSED,
);
export type Manifest = Static<typeof Manifest>;

// ---------- catalog ----------
export const CatalogModel = Type.Object(
  {
    model_id: Type.String(),
    billing_model: Type.Union([
      Type.Literal("free"),
      Type.Literal("subscription_included"),
      Type.Literal("metered"),
      Type.Literal("unknown"),
    ]),
    incremental_cost: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
    context_tokens: Type.Union([Type.Integer(), Type.Null()]),
    efforts: Type.Array(Type.String()),
    roles: Type.Array(Type.String()),
    // explicit_only models are eligible only when named by preferred.model or a
    // policy alias — never join the default candidate pool
    explicit_only: Type.Optional(Type.Boolean()),
  },
  CLOSED,
);
export type CatalogModel = Static<typeof CatalogModel>;

export const Catalog = Type.Object(
  {
    catalog_version: Type.String(),
    plugin_id: Type.String(),
    generated_at: Type.String(),
    sources: Type.Array(Type.String()),
    models: Type.Array(CatalogModel),
  },
  CLOSED,
);
export type Catalog = Static<typeof Catalog>;

// ---------- RPC: handshake / probe / run / cancel ----------
export const HandshakeParams = Type.Object(
  {
    protocol_version: Type.Literal(1),
    router_id: Type.String(),
  },
  CLOSED,
);
export type HandshakeParams = Static<typeof HandshakeParams>;

export const HandshakeResult = Type.Object(
  {
    protocol_version: Type.Literal(1),
    plugin_id: Type.String(),
    plugin_version: Type.String(),
    methods: Type.Array(Type.String()),
    capabilities: Capabilities,
    event_schema_version: Type.Literal(1),
  },
  CLOSED,
);
export type HandshakeResult = Static<typeof HandshakeResult>;

export const Profile = Type.Object(
  {
    native_profile_id: Type.String(),
    env: Type.Record(Type.String(), Type.String()), // operator-approved env only
  },
  CLOSED,
);
export type Profile = Static<typeof Profile>;

export const ProbeParams = Type.Object({ profile: Profile }, CLOSED);
export type ProbeParams = Static<typeof ProbeParams>;

export const QuotaObservation = Type.Object(
  {
    pool_id: Type.String(),
    status: Type.Union([
      Type.Literal("known"),
      Type.Literal("unknown"),
      Type.Literal("exhausted"),
    ]),
    remaining: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    limit: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    unit: Type.Union([
      Type.Literal("requests"),
      Type.Literal("tokens"),
      Type.Literal("unknown"),
    ]),
    source: Type.String(),
    observed_at: Type.String(),
    reset_at: Type.Optional(Type.String()),
    expires_at: Type.Optional(Type.String()),
    estimated: Type.Boolean(),
  },
  CLOSED,
);
export type QuotaObservation = Static<typeof QuotaObservation>;

export const ProbeResult = Type.Object(
  {
    cli_version: Type.String(),
    capabilities: Capabilities,
    quota: Type.Optional(QuotaObservation),
    models: Type.Optional(Type.Array(Type.String())),
  },
  CLOSED,
);
export type ProbeResult = Static<typeof ProbeResult>;

export const PermissionMode = Type.Union([
  Type.Literal("interactive"),
  Type.Literal("preconfigured_only"),
  Type.Literal("deny"),
]);
export type PermissionMode = Static<typeof PermissionMode>;

export const RunRequest = Type.Object(
  {
    run_id: Type.String(),
    job_id: Type.String(),
    attempt_id: Type.String(),
    task: Type.String({ maxLength: 32768 }),
    role: Type.String(),
    resolved_policy: Type.Object(
      {
        permission_mode: PermissionMode,
        max_wall_seconds: Type.Integer({ minimum: 1, maximum: 86400 }),
      },
      CLOSED,
    ),
    candidate_id: Type.String(),
    workspace: Type.Object(
      {
        path: Type.String(), // realpath-verified approved dir
        mode: Type.Union([Type.Literal("fresh"), Type.Literal("locked")]),
      },
      CLOSED,
    ),
    native_profile_id: Type.String(),
    execution_mode: Type.Union([Type.Literal("agent"), Type.Literal("text")]),
    requested_model: Type.String(),
    requested_effort: Type.Optional(Type.String()),
    deadline_ms: Type.Integer({ minimum: 1 }),
    env: Type.Record(Type.String(), Type.String()), // approved profile env subset
    native_session_id: Type.Optional(Type.String()), // resume handle; only if negotiated
  },
  CLOSED,
);
export type RunRequest = Static<typeof RunRequest>;

export const RunResult = Type.Object(
  {
    outcome: Type.Union([
      Type.Literal("completed"),
      Type.Literal("failed"),
      Type.Literal("cancelled"),
    ]),
    status: Type.Optional(
      Type.Union([
        Type.Literal("completed"),
        Type.Literal("partial"),
        Type.Literal("blocked"),
        Type.Literal("unknown"),
      ]),
    ),
    native_session_id: Type.Optional(Type.String()),
    observed_model: Type.Optional(Type.String()),
    response_text: Type.Optional(Type.String({ maxLength: 1048576 })),
    usage: Type.Optional(Usage),
    side_effects: SideEffects,
    retry_safety: RetrySafety,
    error: Type.Optional(NativeError),
    cancel_confirmed: Type.Optional(Type.Boolean()),
    // local process-group stop observed by the router/plugin vs remote/native
    // cancellation confirmation — the two are tracked separately.
    local_stop_confirmed: Type.Optional(Type.Boolean()),
  },
  CLOSED,
);
export type RunResult = Static<typeof RunResult>;

export const CancelParams = Type.Object({ run_id: Type.String() }, CLOSED);
export type CancelParams = Static<typeof CancelParams>;
export const CancelResult = Type.Object(
  {
    ack: Type.Union([Type.Literal("accepted"), Type.Literal("already_finished")]),
  },
  CLOSED,
);
export type CancelResult = Static<typeof CancelResult>;

export const RespondPermissionParams = Type.Object(
  {
    run_id: Type.String(),
    request_id: Type.String(), // exact native request id
    decision: Type.String({ minLength: 1, maxLength: 128 }), // one offered option id or "cancelled"
  },
  CLOSED,
);
export type RespondPermissionParams = Static<typeof RespondPermissionParams>;

// ---------- permission options ----------
// Explicit option kind carried SEPARATELY from the opaque native option id.
// Delivery never infers allow/deny semantics from an opaque id when the
// protocol supplied a kind; kind "unknown" is the legacy string-option path
// and only then does selection fall back to the id regex.
export const PermissionOptionKind = Type.Union([
  Type.Literal("allow"),
  Type.Literal("reject"),
  Type.Literal("cancel"),
  Type.Literal("unknown"),
]);
export type PermissionOptionKind = Static<typeof PermissionOptionKind>;

export const PermissionOption = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }), // opaque native option id, verbatim
    kind: Type.Optional(PermissionOptionKind), // normalized semantics
    native_kind: Type.Optional(Type.String({ maxLength: 64 })), // raw protocol kind (e.g. ACP allow_once)
  },
  CLOSED,
);
export type PermissionOption = Static<typeof PermissionOption>;

// Wire shape accepts legacy opaque strings AND typed option objects so
// older producers remain source-compatible.
export const PermissionOptionWire = Type.Union([Type.String(), PermissionOption]);
export type PermissionOptionWire = Static<typeof PermissionOptionWire>;

// The decision-class sentinel delivered when a request must be refused but
// the agent offered no reject-class option. It is a native cancellation
// outcome, never an option id.
export const PERMISSION_CANCELLED = "cancelled";

export interface NormalizedPermissionOption {
  id: string;
  kind: PermissionOptionKind;
  native_kind?: string;
}

// Map a raw protocol kind label (ACP allow_once/allow_always/reject_*) to a
// normalized kind. Unknown/absent labels stay "unknown" — never guessed.
export function normalizeOptionKind(nativeKind: string | undefined): PermissionOptionKind {
  switch (nativeKind) {
    case "allow":
    case "allow_once":
    case "allow_always":
      return "allow";
    case "reject":
    case "reject_once":
    case "reject_always":
      return "reject";
    case "cancel":
    case "cancelled":
      return "cancel";
    default:
      return "unknown";
  }
}

export function normalizePermissionOptions(options: readonly (string | PermissionOption)[] | undefined): NormalizedPermissionOption[] {
  return (options ?? []).map((o) => {
    if (typeof o === "string") return { id: o, kind: "unknown" as const };
    return {
      id: o.id,
      kind: o.kind ?? normalizeOptionKind(o.native_kind),
      ...(o.native_kind !== undefined ? { native_kind: o.native_kind } : {}),
    };
  });
}

// ---------- canonical events (plugin -> router notifications + DB) ----------
const evBase = {
  schema_version: Type.Literal(1),
  job_id: Type.String(),
  attempt_id: Type.String(),
  run_id: Type.String(),
  event_id: Type.String(),
  sequence: Type.Integer({ minimum: 0 }),
  ts: Type.String(),
  native_session_id: Type.Optional(Type.String()),
};

export const CanonicalEvent = Type.Union([
  Type.Object({ ...evBase, kind: Type.Literal("run.started"), payload: Type.Object({ requested_model: Type.String(), native_pid: Type.Optional(Type.Integer()) }, CLOSED) }, CLOSED),
  Type.Object({ ...evBase, kind: Type.Literal("text.delta"), payload: Type.Object({ text: Type.String({ maxLength: 262144 }) }, CLOSED) }, CLOSED),
  Type.Object({ ...evBase, kind: Type.Literal("tool.started"), payload: Type.Object({ tool: Type.String(), call_id: Type.String() }, CLOSED) }, CLOSED),
  Type.Object({ ...evBase, kind: Type.Literal("tool.completed"), payload: Type.Object({ tool: Type.String(), call_id: Type.String(), status: Type.Union([Type.Literal("ok"), Type.Literal("error"), Type.Literal("denied")]) }, CLOSED) }, CLOSED),
  Type.Object({ ...evBase, kind: Type.Literal("permission.required"), payload: Type.Object({ request_id: Type.String(), action: Type.String(), target: Type.String(), options: Type.Array(PermissionOptionWire) }, CLOSED) }, CLOSED),
  Type.Object(
    {
      ...evBase,
      kind: Type.Literal("usage.observed"),
      payload: Type.Object(
        {
          usage: Usage,
          // non-token context window observation (ACP usage_update); NOT
          // consumption and NOT remaining quota.
          context: Type.Optional(
            Type.Object(
              {
                used: Type.Integer({ minimum: 0 }),
                size: Type.Integer({ minimum: 0 }),
                cost_amount: Type.Optional(Type.Number({ minimum: 0 })),
                currency: Type.Optional(Type.String({ maxLength: 8 })),
              },
              CLOSED,
            ),
          ),
        },
        CLOSED,
      ),
    },
    CLOSED,
  ),
  Type.Object({ ...evBase, kind: Type.Literal("artifact.created"), payload: Type.Object({ path: Type.String(), artifact_kind: Type.String() }, CLOSED) }, CLOSED),
  Type.Object({ ...evBase, kind: Type.Literal("run.completed"), payload: Type.Object({ status: Type.Union([Type.Literal("completed"), Type.Literal("partial"), Type.Literal("blocked"), Type.Literal("unknown")]), response_text: Type.Optional(Type.String()), observed_model: Type.Optional(Type.String()), usage: Type.Optional(Usage), side_effects: SideEffects, retry_safety: RetrySafety }, CLOSED) }, CLOSED),
  Type.Object({ ...evBase, kind: Type.Literal("run.failed"), payload: Type.Object({ error: NativeError }, CLOSED) }, CLOSED),
  Type.Object({ ...evBase, kind: Type.Literal("run.cancelled"), payload: Type.Object({ confirmed: Type.Boolean() }, CLOSED) }, CLOSED),
]);
export type CanonicalEvent = Static<typeof CanonicalEvent>;
export type EventKind = CanonicalEvent["kind"];

// ---------- job API ----------
export const WorkspaceSpec = Type.Union([
  Type.Object({ mode: Type.Literal("fresh") }, CLOSED),
  Type.Object({ mode: Type.Literal("locked"), handle: Type.String() }, CLOSED),
]);
export type WorkspaceSpec = Static<typeof WorkspaceSpec>;

export const CreateJobRequest = Type.Object(
  {
    task: Type.String({ minLength: 1, maxLength: 32768 }),
    // role names are operator-policy-defined (policy.roles), not a wire enum
    role: Type.String({ minLength: 1, maxLength: 64 }),
    policy: Type.String(), // policy profile name
    workspace: WorkspaceSpec,
    preferred: Type.Optional(
      Type.Object(
        {
          plugin_id: Type.Optional(Type.String()),
          model: Type.Optional(Type.String()),
          effort: Type.Optional(Type.String()),
          candidate_id: Type.Optional(Type.String()),
        },
        CLOSED,
      ),
    ),
    deadline_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 86400 })),
    // NOTE: isolation/read-only/network/shell demands have no wire fields.
    // This router cannot provide OS sandbox isolation, so any such requirement
    // is rejected as an unknown field — never silently downgraded.
  },
  CLOSED,
);
export type CreateJobRequest = Static<typeof CreateJobRequest>;

// ---------- compiled validators ----------
const compilerCache = new Map<TSchema, ReturnType<typeof TypeCompiler.Compile>>();
export function validator<T extends TSchema>(schema: T) {
  let c = compilerCache.get(schema);
  if (!c) {
    c = TypeCompiler.Compile(schema);
    compilerCache.set(schema, c);
  }
  return c as { Check: (v: unknown) => v is Static<T>; Errors: (v: unknown) => Iterable<unknown> };
}
export function check<T extends TSchema>(schema: T, value: unknown, what: string): Static<T> {
  const v = validator(schema);
  if (!v.Check(value)) {
    const first = [...v.Errors(value)][0] as { path?: string; message?: string } | undefined;
    throw new Error(
      `schema validation failed for ${what}: ${first?.path ?? "?"} ${first?.message ?? "invalid"}`,
    );
  }
  return value;
}
