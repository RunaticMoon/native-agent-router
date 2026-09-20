# Native CLI compatibility (milestone 1 — fixture only)

This milestone ships a **synthetic** CLI (`fixtures/fake-cli.mjs`). Real CLI
model-task verification is explicitly NOT RUN and not claimed. Earlier
startup-only probes are distinguished from inference in delivery-status.md.

| CLI | invocation | wire | permissions | resume | quota | verified |
|-----|-----------|------|-------------|--------|-------|----------|
| fake-cli (fixture) | `node fake-cli.mjs --prompt <t> --model <m> --mode <agent|text> [--effort]` | NDJSON `event` discriminator: init/text_delta/step_update/permission_request/usage/result | `permission_request` + stdin `permission_response` (interactive) | declared `unsupported` | synthetic observer (`estimated:true`) | local fixture 2026-09-19 |
| fake-devin-acp (fixture) | `node fake-devin-acp.mjs` via `devin-native` plugin | ACP v1 JSON-RPC: initialize/session-new/prompt/cancel + request_permission | `session/request_permission` → `respondPermission` RPC, verbatim offered optionId (fixture-verified) | declared `unsupported`; `native_session_id` rejected | none (unknown) | fixture e2e through Registry/Runtime/HTTP 2026-09-19 |
| fake-agy (fixture) | `node fake-agy.mjs --model <m> [--effort]` via `antigravity-native` plugin | stream-json NDJSON: init/step_update/result | `preconfigured_only` — no control channel | declared `unsupported`; `native_session_id` rejected | none (unknown) | fixture e2e through Registry/Runtime/HTTP 2026-09-19 |
| Devin real (`devin acp --model`) | — | ACP JSON-RPC | NOT VERIFIED — capability `unknown` outside fixture mode | — | — | NOT RUN; profile must stay operating-disabled |
| agy real (stream-json) | — | NDJSON stream-json | `preconfigured_only` | help exists, unverified | no verified observer | NOT RUN; profile must stay operating-disabled |
| Codex | — | — | — | — | — | NOT RUN; Lead designation only |

Fixture `beh-*` model ids map failure modes for tests: `beh-hang`,
`beh-fail-<errorcode>`, `beh-soft-deny` (exit0 + blocked),
`beh-side-effects-unknown`, `beh-permission`, `beh-spawn-child`,
`beh-ignore-sigterm`, `beh-flood-stderr`, `beh-exit-nonzero`, `beh-partial`.
They are `explicit_only` catalog entries — never in the default pool.

Real-plugin blockers to resolve next milestone (documented, not faked):
per-CLI argv/wire mapping verification, permission negotiation support,
verified resume semantics, and a real quota observation source. Until each is
verified, the capability reports `unsupported`/`unknown` and the router treats
it as not usable.
