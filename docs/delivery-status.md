# MVP delivery status

This is a credential-free synthetic-fixture MVP, not production approval.

## Local verification

Verified 2026-09-19 on Linux aarch64 and Node 24.20.0:
- Clean dependency installation and TypeScript build passed.
- 161 default tests passed, with no failures, cancellations or skipped tests.
- Seven additional adversarial checks passed.
- Daemon initialization, authenticated job/SSE, active-job shutdown, and demo passed.
- Source archive was extracted, hash-verified, rebuilt and exercised separately.

These are local results. See GitHub Actions for the exact public commit's CI
result; local results do not imply remote CI success.

The public tree preserves the verified implementation and tests. Private
orchestration instructions, account details, chat identifiers, research dumps,
local execution logs and machine-specific configuration are not published.

## Limitations / outstanding acceptance

- Real authenticated provider jobs, quota, permissions, resume and profile
  isolation remain unverified. Native operating profiles stay disabled.
- Earlier no-inference binary probes observed Devin ACP initialize and the
  Antigravity initial stream frame. They do not establish model execution.
- `npm run test:real` is only a prerequisite and binary identity/version probe,
  not a real model-task integration test. Missing inputs yield exit 3 BLOCKED.
- Real Jev inference has not run. Task/Model/Candidate integration uses fake
  fetch in tests; default task evidence is role/hint only. Rich task evidence
  and restoring evaluation caches after restart remain follow-up work.
- No independent external security-review PASS is claimed.
- Process/workspace separation is not an OS sandbox. Unsupported isolation
  requirements reject. Secret masking is best-effort, not general DLP.
- Publishing this repository does not deploy or enable any service.

See README.md for commands and adding-plugin.md for the manifest/adapter/test
extension boundary. CI runs synthetic fixtures only, without provider secrets
or paid inference. Do not submit tokens or raw sensitive logs in public issues.
