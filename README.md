# Native Agent Router — synthetic fixture MVP

Final parent-verified status, test evidence and remaining limitations:
[docs/delivery-status.md](docs/delivery-status.md).

TypeScript MVP of the Hermes -> Job API -> Router -> Native Runtime ->
out-of-process CLI Plugin -> OFFICIAL CLI chain. **Everything that runs here
is synthetic**: the bundled "CLIs" (`fixtures/fake-cli.mjs`,
`fixtures/fake-devin-acp.mjs`, `fixtures/fake-agy.mjs`) are labelled fakes
speaking NDJSON/ACP-v1 wires that never touch any provider, account, network
or credential. No Jev key or provider account is required or used.

## Commands

```bash
npm ci --ignore-scripts # install pinned project dependencies; Node 24 required
npm run build   # strict TS -> dist/
npm test        # build + node --test (fixtures only, no provider contact)
npm run demo    # self-contained HTTP fixture smoke: temp env, generated token,
                # submit job, stream SSE, assert succeeded — all on 127.0.0.1
npm run routerd -- --help                 # daemon CLI usage
npm run routerd -- --init-example DIR     # private 0600 synthetic config (refuses overwrite)
npm run routerd -- --config DIR/config.json  # authenticated API on loopback, SIGTERM clean
npm run test:real  # OPT-IN binary identity/version probe only; NOT an inference test
                   # BLOCKED without operator inputs; never part of npm test
```

Generic job client (no model/provider names — Job API only):

```ts
import { worker } from "./src/client/worker.js";
const res = await worker({ baseUrl, token, task, role, policy, workspace },
                         { timeoutMs: 60000 }); // submit -> events -> result
```

## Layout

- `src/contracts` — TypeBox schemas: single source for TS types + wire
  validation (closed objects; only explicit maps stay open).
- `src/process` — safe argv spawn (shell:false), env allowlist, detached
  process groups, bounded drains enforced before newline, TERM→KILL, `/proc`
  identity + stubborn descendants.
- `src/plugin-sdk` — JSON-RPC 2.0 over stdio JSONL (bounded frames,
  null/array/scalar frames rejected), host + server sides; `plugin-host` does
  handshake/probe/run/cancel/respondPermission with validation.
- `src/registry` — approved manifest loading: approved dirs only, realpath +
  sha256 identity, symlink rejection, credential-class env refusal.
- `src/router-core` — capability/policy/quota/capacity hard filter, decision
  adapter iface (`DecisionAdapter`; `RuleBasedAdapter` and the Jev adapter
  implement it — adapters reorder IDs only, never mutate candidates),
  deterministic rank, fallback classification, Lead handoff.
- `src/runtime` — job/attempt/native-session lifecycle, event normalization,
  split-delta redaction, cancellation (local vs remote-confirmed), approvals
  with single delivery, multi-pool atomic capacity, restart recovery,
  workspace locking.
- `src/storage` — node:sqlite store, single-owner guard, append-only events,
  idempotency keys, quota observations, capacity reservations, decision
  records, approval delivery state.
- `src/http` — bearer-authenticated Job API + SSE (bounded pages, complete
  terminal drain, strict Last-Event-ID), body caps/deadlines, canonical
  idempotency hashing, per-principal+global admission caps.
- `src/native` — shared wire decoder/process (`wire.ts`), ACP v1 client
  (`acp.ts`), agy stream-json client (`agy.ts`), plugin runtime (`plugin.ts`),
  thin contract re-exports (`types.ts`).
- `src/decisions` — Jev client/coordinator (`jev.ts`: bounded, redacted,
  fail-closed, decision-only) and the `DecisionAdapter` glue (`jev-adapter.ts`).
- `plugins/example-native` — example plugin driving `fixtures/fake-cli.mjs`.
- `plugins/devin-native.ts` / `plugins/antigravity-native.ts` — native plugin
  entrypoints driving ACP / stream-json CLIs (fixture-verified only).
- `fixtures/` — synthetic CLIs; `beh-*` model ids drive failure modes and
  `FAKE_*_SCENARIO` selects fixture scripts.
- `tests/` — node:test suite over compiled `dist/`; helpers build a temp
  operator env per test and clean up in `finally`.

## Explicit limitations

- **Synthetic only.** No real provider CLI, no Jev call, no OAuth, no
  inference. Real CLI profiles must stay operating-disabled until an operator
  verifies the real binary (sha256/version/permission behavior) — the shipped
  `docs/devin-native.json` / `docs/antigravity-native.json` manifests are
  templates with placeholder hashes, not active registrations.
- Jev is a decision-only adapter, off by default. With no key it never calls
  out and falls back to the identical rule ranking; audit records note that
  honestly. `jev.mode: "shadow"`/`"active"` + `jev.api_key_env` enable it.
- All three judge phases are wired, but default task evidence contains only
  role/hint; an adapter-supplied approved summary is optional. Rich per-task
  analysis is limited, and evaluation caches are in-memory across jobs, not
  restored across daemon restarts. No real Jev response has been verified.
- `test:real` currently tests prerequisites and binary identity/version only.
  Actual authenticated model-task acceptance is NOT implemented in that
  command and remains a separate operator gate, even if the probe exits 0.
- No resume (declared `unsupported`, negotiated honestly), no remote task
  cancellation guarantees (local stop vs remote-confirmed tracked
  separately), quota values are fixture-synthetic (`estimated: true`) or
  operator-recorded observations.
- Process separation is NOT an OS sandbox; isolation/read-only/network/shell
  demands cannot be expressed on the wire and are rejected as unknown fields.
  Workspaces are approved dirs only.
- `routerd --init-example DIR` writes a private (0600) synthetic-only config
  + approved fixture manifests — no real credentials exist in it. `--config`
  binds loopback only unless `allow_public_bind` is set. Token handling is
  demo-grade (0600 file inside the config).
- Unknown outcome/side-effects always route to `needs_recovery`, never
  success. A cancelled ACK alone never yields `cancelled`.

See `docs/` for architecture, protocol, security and test evidence.
