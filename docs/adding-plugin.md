# Adding a plugin (contract for real CLIs)

A new official CLI integrates **without any Router Core change**:

1. Write `<plugin>.manifest.json` + `<plugin>.catalog.json` into an operator
   `approved_manifest_dirs` dir. The manifest pins CLI realpath + sha256,
   declares `required_env` names, capability claims, `retention`, `network`,
   `filesystem`, `designation`.
2. Write the adapter: a stdio JSON-RPC process implementing `handshake`,
   `probe`, `run`, `cancel` (use `PluginServer` from `src/plugin-sdk` or any
   language — the wire is language-independent). Declare optional methods
   (`respondPermission`, `resume`, `quota`, `models`) only when truly
   implemented — they are negotiated at handshake and never faked.
3. Add contract tests: handshake identity, capability claims vs probe, wire
   validation (malformed/oversize frames), cancel semantics, no ambient env.
   `tests/routing.test.ts` shows a differently-named plugin registering purely
   by manifest presence (`example-b`) — zero core edits.

The adapter maps the CLI's native events to canonical `run.event` kinds; the
runtime re-sequences them. Requested vs observed model are separate fields —
leave `observed_model` absent unless the CLI confirms it.

Lead-only CLIs (e.g. Codex) set `designation: "lead"` and are excluded from
the worker pool by the registry — they never become ordinary candidates.

Jev is integrated as a decision-only adapter (`src/decisions/jev.ts` +
`src/decisions/jev-adapter.ts`), off by default (`jev.mode`). The API key is
read once from the named operator env var into the `JevClient` constructor —
never persisted, never in job/plugin env. Candidate judging sends only
whitelisted evidence fields; any Jev failure falls back to the identical
rule-based ordering and records `adapter_used:"jev-fallback-rules"` in the
audit. The Task, Model and Candidate Judges are wired. Task judgments are
cached within a job and its supplied feature fingerprint; model judgments
are cached by model/catalog fingerprint. Default task evidence is deliberately
limited to role/hint (or an adapter-supplied, bounded approved summary), not
the raw task/repository. Rich task-specific complexity analysis and durable
cross-restart evaluation-cache reuse remain limitations. Stored rubric
estimates are not measured benchmarks or success probabilities.
