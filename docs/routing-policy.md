# Routing & policy (milestone 1)

## Candidate identity

`candidate_id = plugin_id|model_id|native_profile_id|execution_mode|effort` —
exact candidate + model validated end to end; requested vs observed model are
separate fields on results.

## Hard filters (order, per candidate)

1. plugin pool membership + `designation: lead` exclusion + `preferred` pins +
   catalog `explicit_only` (eligible only via `preferred.model` or alias).
2. capability: effective = manifest ∩ probe ∩ policy; `unknown` is not
   supported. Mode, structured events, effort, `interactive` permission
   requirement, network/filesystem claims.
3. role fitness: catalog `roles` must include the job role.
4. quota (when `require_quota_known`): rejects unknown/exhausted/zero, stale
   (> `max_quota_staleness_seconds`), expired observations. Quota observations
   are fixture-synthetic in this milestone (`estimated: true`).
5. capacity: atomic `capacity_reservations` per plugin pool vs
   `max_concurrency`; live unknown-outcome processes quarantine rather than
   release.

## Ranking (deterministic)

`RuleBasedAdapter`: role fit (+100) -> operator alias order (+50-i) -> billing
preference (free +10 / subscription +5) -> incremental cost -> stable
`candidate_id` tiebreak. Aliases (`free`/`easy`/`standard`/`hard`/`max`) are
policy-defined preference orderings over catalog model ids — not an
intelligence ranking. A true-free policy additionally sets
`max_incremental_cost: 0` + `allow_unknown_cost: false`, which excludes
`subscription_included` catalog entries; a separate profile may include
them. The adapter output is re-validated against the eligible set —
fabricated ids are dropped and recorded.

## Policy profile knobs (all enforced)

`allowed_plugins`, `permission_mode` (interactive|preconfigured_only|deny),
`max_concurrency`, `max_wall_seconds`, `require_quota_known`,
`max_quota_staleness_seconds`, `max_attempts` (bounded fallback), `aliases`,
`max_incremental_cost`, `allow_unknown_cost`, `required_tools`,
`roles`. Router-level `lead_handoff_enabled` gates whether exhausted jobs
emit a structured Lead handoff record or simply fail with tried-candidate
errors.

## Fallback & Lead

A reject before launch -> next candidate. B verified-no-side-effects ->
bounded retry within `max_attempts`. C effects present -> needs_recovery.
D unknown -> needs_recovery. Exhaustion -> structured `lead_handoff` decision
record with tried candidates, errors, workspace state, uncertain effects,
remaining work, recovery prerequisites. Lead-designated plugins never execute
as workers and are never silently spawned on exhaustion.
