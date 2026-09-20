# Plugin protocol v1

Transport: JSON-RPC 2.0 over stdio, one JSON object per line (JSONL), max frame
1 MiB. stdout is protocol-only; stderr is bounded diagnostics
(`manifest.retention.diagnostics_bytes`). One plugin process per attempt — no
pooling.

## Methods (router -> plugin)

- `handshake({protocol_version, router_id})` -> `{protocol_version, plugin_id,
  plugin_version, methods[], capabilities, event_schema_version}`.
  Identity must match the approved manifest or the host kills the process.
  `methods` must include `probe`,`run`,`cancel`; optional methods
  (`respondPermission`, `models`, `quota`, `resume`) are negotiated here —
  unsupported ones are never faked.
- `probe({profile})` -> `{cli_version, capabilities, quota?, models?}`.
  No-inference probe (e.g. `--version`). Capability entries carry
  `status: supported|unsupported|unknown`, `evidence`, `checked_at`.
  Effective capabilities = manifest ∩ probe ∩ policy; unknown is not supported.
- `run(RunRequest)` -> `RunResult` (long-lived). Streams `run.event`
  notifications bound by `run_id`/`job_id`/`attempt_id`; mismatched or
  malformed frames are refused. `RunResult` carries `outcome`, `status`
  (completed|partial|blocked|unknown), `observed_model` (separate from
  `requested_model`; absent if unconfirmed), `usage` (`cumulative` flag —
  never re-summed), `side_effects`, `retry_safety`, `cancel_confirmed`.
- `cancel({run_id})` -> `{ack: accepted|already_finished}`. ACK != confirmed
  stop; confirmation arrives via the `run` result.
- `respondPermission({run_id, request_id, decision})` — only when negotiated;
  delivers the approver decision to the same native request. Deny is the
  default on timeout/restart.

## Events (plugin -> router, `run.event`)

`run.started`, `text.delta`, `tool.started`, `tool.completed`,
`permission.required`, `usage.observed`, `artifact.created`, `run.completed`,
`run.failed`, `run.cancelled` — all carry `schema_version`, job/attempt/run
ids, `event_id`, `sequence`, `ts`, optional `native_session_id`. Runtime
re-sequences on ingest (runtime owns ordering).

## Errors

JSON-RPC standard codes plus `error.data` carrying the taxonomy:
CLI_NOT_INSTALLED, CLI_VERSION_UNSUPPORTED, AUTH_REQUIRED, MODEL_UNAVAILABLE,
UNSUPPORTED_CAPABILITY, QUOTA_EXHAUSTED, RATE_LIMITED, PERMISSION_DENIED,
TIMEOUT, INVALID_OUTPUT, CANCELLED, UNKNOWN_NATIVE_OUTCOME — each with `phase`
and `retry_safety`. CLI exit 0 is not success; soft-denied/blocked results are
reported as `partial`/`blocked` with truthful `side_effects`.

## Manifest (operator-approved only)

`manifest_version`, `plugin_id/version`, `protocol_version`, `transport`,
`command{executable,args}` (argv template, absolute realpath), `cli{name,
version_range, executable, sha256, invoker?}` (pinned identity hash),
`codec: ndjson-event`, `discovery: static-manifest`, `catalog_path`,
`required_env` (names only), `network`, `filesystem`, `retention`,
`capabilities`, `designation` (worker|lead). Loader verifies schema, approved
dir membership, canonical realpaths (symlink declarations rejected) and the
CLI sha256. Workspace/cwd/PATH never supplies manifests or executables.
