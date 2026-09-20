# Architecture (milestone 1)

Chain: `Hermes -> POST /v1/jobs -> Router Core -> Native Runtime -> PluginHost
(stdio JSON-RPC) -> plugin process -> CLI argv -> normalized events -> SQLite +
SSE`.

Boundaries that are real in code:

- **Router Core** (`src/router-core`): provider-agnostic. Enumerates registry
  candidates, applies hard filters (capability/policy/quota/capacity/role),
  calls a `DecisionAdapter` for ranking only, revalidates adapter output (an
  adapter cannot inject candidates), reserves local capacity atomically,
  classifies failures A-D, emits Lead handoff records. No CLI-name switch.
- **Runtime** (`src/runtime`): owns job/attempt/session/workspace lifecycle and
  process supervision; persists attempt before launch; normalizes plugin events
  into the append-only store (runtime owns ordering/ids); cancellation splits
  local-stop vs remote-confirmation; restart recovery marks non-terminal
  attempts `needs_recovery` and quarantines capacity for live unknown-outcome
  processes. Makes no model judgements.
- **Plugin** (`plugins/example-native`): knows one CLI's argv/wire mapping;
  out-of-process; speaks protocol on stdout only. Cannot invoke other plugins
  or do provider fallback.
- **Storage** (`src/storage`): node:sqlite, WAL, single-owner `db_owner` row +
  pid liveness; `events` is append-only via triggers; idempotency keys are
  (principal, key) with canonical body hash.
- **Job API** (`src/http`): bearer auth on every route; principal scopes
  (`jobs:write`, `jobs:read`, `approve`) + per-principal policy/workspace
  allowlists; job visibility scoped to owning principal; loopback bind unless
  `allow_public_bind`.

State machine (jobs and attempts): `queued -> running ->
awaiting_approval|verifying -> succeeded|failed|cancelled`, `needs_recovery`
reachable from any non-terminal state and never returns to running except via
explicit operator requeue (`needs_recovery -> queued`). Terminal states are
immutable (enforced in `Store.transitionJob`/`finishAttempt`).

Fallback classes: A pre-launch definite reject -> next candidate; B post-start
failure with positively-verified `side_effects:"none"` -> bounded retry/next;
C side effects present -> recovery, not auto-retry; D unknown -> needs_recovery.
Exhaustion emits a structured `lead_handoff` decision record — never a hidden
Lead/Codex spawn; `designation:"lead"` plugins are excluded from the worker
pool in `Registry.workerPlugins()`.
