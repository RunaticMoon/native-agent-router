# Security & recovery (milestone 1)

## Process / spawn

- argv-only `spawn(shell:false)`; task text travels as a single argv element —
  never shell-interpolated (test asserts inert injection string).
- Child env = declared `required_env` names mapped from the operator profile;
  ambient `process.env` is never inherited (no Jev key, no provider keys, no
  API token in worker env).
- Detached process groups; identity-aware liveness via `/proc/<pid>/stat`
  starttime to avoid signalling reused PGIDs; stubborn descendants counted
  post-exit (zombies excluded). Unresolvable survivors are reported, never
  chased into foreign groups.
- Every group signal (cancel / finally / restart recovery) goes through the
  shared verified-identity helpers in `src/process/safe-spawn.ts`
  (`signalVerifiedGroup`/`stopVerifiedGroup`): `/proc` identity (pid +
  starttime + pgid + executable realpath when recorded) is re-read before
  each signal; a stored pgid is never signalled when its live leader cannot be
  re-verified, even when that numeric group currently has live members. The native child
  pid/pgid/starttime/exe is persisted per attempt only after lineage to the
  plugin process is proven (`recordChildIdentity`) — a plugin-reported
  `native_pid` alone is never trusted as signalable identity. Missing, stale
  or spoofed identity fails closed: no signal, survivors/quarantine reported.
- Plugin descendants are additionally snapshotted from `/proc` BEFORE the
  plugin is stopped (`liveChildrenOf` + `snapshotPluginChildren`) — once the
  plugin dies they reparent and lineage is unverifiable — and every
  snapshotted group is stopped through the same verified helper on cancel,
  shutdown and attempt-finally paths. This closes the orphan race where a
  native child existed but its `run.started` identity had not yet been
  recorded. Live-but-unsignalled children count as unknown outcome:
  capacity stays quarantined rather than released.
- Bounded stdout/stderr; oversized protocol frame kills the plugin; malformed
  JSONL gets an explicit parse error.

## Manifest / executable identity

- Only operator `approved_manifest_dirs` are scanned; manifest realpath must
  stay inside them. Declared executable/invoker paths must already be
  canonical realpaths (symlink declarations rejected); CLI pinned by sha256.
- Registry skips invalid manifests into `errors[]` — never partially trusted.

## Workspace

- `fresh`: new dir under `approved_workspace_base` per job.
- `locked`: registered handle, principal ownership check, `realpath` must
  resolve under the base (symlink escape -> 403), serialized via
  `locked_by` claim.
- No request-supplied path is ever used. Process/worktree separation is not a
  sandbox — demanded isolation must be rejected (no backend shipped here).

## API

- Bearer token on all routes; per-principal scopes + policy/workspace
  allowlists; job visibility owner-scoped (cross-principal -> 404).
- `Idempotency-Key` scoped to principal; same key + different canonical body ->
  409. Replay resolution runs BEFORE the active-job admission cap inside the
  same transaction — a replayed key is never rejected for capacity and the
  cap check + insert cannot race a concurrent new submission.
- Approval `actor` derives from the authenticated principal — the request
  body cannot pick an identity. Permission options carry an opaque verbatim
  `id` plus a separately normalized `kind` (`allow`/`reject`/`cancel`/
  `unknown`, raw `native_kind` preserved); decisions select by explicit kind
  first and only fall back to the id heuristic for legacy string options.
  Any non-approved outcome delivers an offered reject/cancel-class option or
  the native `cancelled` sentinel — never a fabricated allow.
- Loopback bind only unless `allow_public_bind: true`. Shutdown is bounded:
  `api.close(grace)` ends tracked SSE connections then force-closes strays,
  `runtime.shutdown(deadline)` stops in-flight hosts and verified child
  groups; routerd enforces a hard overall deadline.

## Recovery

- Single DB owner (`db_owner` + pid liveness): a second live daemon refuses.
- On start, non-terminal attempts -> `needs_recovery`; if the tracked process
  identity is still alive the outcome is unknown: the group is killed, the
  capacity reservation is **quarantined** (not released), pending approvals are
  invalidated, and the job goes `needs_recovery`. Dead processes release
  capacity. Nothing is auto-replayed or duplicated.
- Terminal states immutable; `events` append-only via DB triggers.
- Unknown outcome/side-effects never map to success or clean failure — always
  `needs_recovery`.
- Retention policy stores no raw output by default (`raw_output: false`),
  bounded stderr diagnostics only. What IS persisted is best-effort redacted:
  a token-aware streaming redactor (`src/runtime/redactor.ts`) holds
  secret-shaped token units until they terminate — so a secret split across
  arbitrary delta boundaries cannot leak a suffix — drops overlong open
  secret runs with bounded carry, and additionally redacts exact known
  in-memory secrets (principal bearer tokens, the operator Jev key when
  configured). Non-delta event payloads, results, errors, approvals and
  artifact metadata are redacted before persistence. This is NOT general
  DLP: unknown secret strings are never guaranteed caught.
