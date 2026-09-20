// routerd: the router daemon CLI.
//   routerd --help
//   routerd --init-example DIR   write a private (0600) synthetic example
//                                config + approved fixture manifests; refuses
//                                to overwrite a non-empty dir. No credentials.
//   routerd --config FILE        start the authenticated Job API on loopback
//                                (public bind refused unless config allows),
//                                recover prior state, graceful SIGTERM/SIGINT.
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig, RouterConfig } from "../config.js";
import { buildStack, writeFixtureManifest, writeNativeFixtureManifests, nativeFixtureProfileEnv, demoPolicy } from "../bootstrap.js";

const USAGE = `usage:
  routerd --help
  routerd --init-example DIR   write private synthetic example config (refuses overwrite)
  routerd --config FILE        start daemon (loopback only unless allow_public_bind)
`;

function initExample(dir: string): number {
  const abs = path.resolve(dir);
  if (fs.existsSync(abs) && fs.readdirSync(abs).length > 0) {
    console.error(`refusing to overwrite non-empty dir ${abs}`);
    return 2;
  }
  fs.mkdirSync(abs, { recursive: true, mode: 0o700 });
  const manifestDir = path.join(abs, "approved-manifests");
  writeFixtureManifest(manifestDir);
  writeNativeFixtureManifests(manifestDir);
  const token = randomUUID() + randomUUID();
  const config: RouterConfig = {
    db_path: path.join(abs, "router.db"),
    approved_manifest_dirs: [manifestDir],
    approved_workspace_base: path.join(abs, "workspaces"),
    profiles: {
      // fixture env points synthetic plugins at repo fixture CLIs — no real
      // provider credentials exist anywhere in this generated config.
      default: { env: nativeFixtureProfileEnv(), enabled: true },
      // real provider profile example: OPERATING DISABLED until an operator
      // verifies binary identity, permissions, quota, and cancellation.
      "devin-real": { env: {}, enabled: false },
    },
    principals: [
      { id: "op", token, scopes: ["jobs:write", "jobs:read", "approve"], policies: ["*"], workspaces: ["*"] },
    ],
    policies: [demoPolicy(), { ...demoPolicy("free-only"), max_incremental_cost: 0, allow_unknown_cost: false }],
    lead_handoff_enabled: true,
    jev: { mode: "off" },
    http: { host: "127.0.0.1", port: 0, allow_public_bind: false },
  };
  const cfgPath = path.join(abs, "config.json");
  fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  console.log(`wrote ${cfgPath}`);
  console.log(`token stored in config.json (0600). start: routerd --config ${cfgPath}`);
  return 0;
}

async function serve(cfgPath: string): Promise<number> {
  const config = loadConfig(cfgPath);
  const stack = buildStack(config);
  stack.runtime.recoverOnStart(); // quarantine prior-owner attempts; never replay
  const port = await stack.api.listen();
  console.log(`LISTEN ${config.http.host}:${port}`);
  let stopping = false;
  const stop = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    console.error(`routerd: ${sig} received, shutting down`);
    // hard overall deadline: bounded teardown must actually exit
    const hard = setTimeout(() => {
      console.error("routerd: shutdown deadline exceeded, exiting");
      process.exit(1);
    }, 7000);
    hard.unref();
    try {
      // stop admission + close tracked SSE first (bounded), then settle the
      // runtime's in-flight jobs and verified process groups (bounded).
      await stack.api.close(2000);
      await stack.runtime.shutdown(4000);
      stack.store.close();
      clearTimeout(hard);
      process.exit(0);
    } catch (e) {
      console.error(`routerd: shutdown error ${String(e).slice(0, 200)}`);
      process.exit(1);
    }
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
  return new Promise<number>(() => {}); // run until signal
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h") || args.length === 0) {
  process.stdout.write(USAGE);
  process.exit(args.length === 0 ? 2 : 0);
}
if (args[0] === "--init-example" && args[1]) {
  process.exit(initExample(args[1]));
}
if (args[0] === "--config" && args[1]) {
  process.exit(await serve(args[1]));
}
console.error(USAGE);
process.exit(2);
