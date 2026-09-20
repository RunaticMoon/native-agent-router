// OPT-IN real-provider invocation suite — run explicitly via:
//   npm run test:real
// This is NOT part of `npm test` (default CI performs no provider spend and
// no real inference). Prerequisites are checked FIRST; when absent the suite
// reports BLOCKED/NOT_RUN per case and exits non-zero — a missing prerequisite
// is never counted as a pass.
//
// Evidence note: docs/research-environment.md records startup-only real CLI
// evidence (binary presence/--version output). That does NOT prove inference,
// account permission, quota, resume, or model identity — all remain
// unverified, and real profiles stay operating-disabled.
//
// Prereqs (all required; each maps to an operator-approved env var):
//   ROUTER_REAL_CLI=/abs/path/to/cli     pinned real CLI executable
//   ROUTER_REAL_CLI_SHA256=<hex>         expected sha256 of that binary
//   ROUTER_REAL_PROFILE=<profile>        config profile name, operator-enabled
//   ROUTER_REAL_CONFIG=<config.json>     operator config with a real policy
//   ROUTER_REAL_APPROVE=1                explicit spend/invocation consent
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";

const missing = [];
const cli = process.env.ROUTER_REAL_CLI;
const sha = process.env.ROUTER_REAL_CLI_SHA256;
const profile = process.env.ROUTER_REAL_PROFILE;
const cfgPath = process.env.ROUTER_REAL_CONFIG;
const consent = process.env.ROUTER_REAL_APPROVE === "1";

if (!cli) missing.push("ROUTER_REAL_CLI (real CLI path)");
if (!sha) missing.push("ROUTER_REAL_CLI_SHA256 (pinned binary identity)");
if (!profile) missing.push("ROUTER_REAL_PROFILE (operator-enabled profile)");
if (!cfgPath) missing.push("ROUTER_REAL_CONFIG (operator config)");
if (!consent) missing.push("ROUTER_REAL_APPROVE=1 (explicit invocation consent)");

let identity = null;
if (cli && sha) {
  try {
    const real = fs.realpathSync(cli);
    const actual = createHash("sha256").update(fs.readFileSync(real)).digest("hex");
    identity = actual === sha ? "verified" : `MISMATCH expected=${sha} actual=${actual}`;
  } catch (e) {
    identity = `unreadable: ${String(e).slice(0, 120)}`;
  }
}

if (missing.length || identity !== "verified") {
  console.log("BLOCKED: real-CLI prerequisites absent or unverified — NOT_RUN");
  for (const m of missing) console.log(`  missing: ${m}`);
  if (identity && identity !== "verified") console.log(`  identity: ${identity}`);
  console.log("  account permissions/quota/resume/model identity: unverified");
  process.exit(3); // explicit BLOCKED — never a silent skip-pass
}

// Identity verified. Startup-only check: --version parses (no inference).
let versionOut = "";
try {
  versionOut = execFileSync(fs.realpathSync(cli), ["--version"], {
    timeout: 10_000, encoding: "utf8", env: { PATH: process.env.PATH ?? "" },
  }).slice(0, 512);
} catch (e) {
  console.log(`NOT_RUN: --version probe failed: ${String(e).slice(0, 160)}`);
  process.exit(3);
}
const m = versionOut.match(/(\d+\.\d+\.\d+[^\s]*)/);
if (!m) {
  console.log("NOT_RUN: unparsable --version output");
  process.exit(3);
}
console.log(`real CLI ${fs.realpathSync(cli)} version ${m[1]} identity verified (startup-only evidence — inference NOT RUN)`);
console.log("PASS: startup identity probe only. Inference/quota/resume tests remain NOT_RUN pending operator acceptance.");
process.exit(0);
