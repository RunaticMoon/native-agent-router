// Registry: loads ONLY operator-approved manifests from approved dirs.
// Verifies: manifest schema, plugin/CLI executable realpath inside approved
// base, CLI sha256 identity, symlink rejection. Workspace/cwd never supplies
// manifests or executables.
import * as fs from "node:fs";
import * as path from "node:path";
import { Manifest, Catalog, check } from "../contracts/index.js";
import { sha256File } from "../process/safe-spawn.js";
import { envNameDenied } from "../runtime/env-deny.js";

export interface RegisteredPlugin {
  manifest: Manifest;
  catalog: Catalog;
  manifestPath: string;
  pluginExeReal: string;
  cliExeReal: string;
}

function realUnder(p: string, base: string, what: string): string {
  const real = fs.realpathSync(p);
  const realBase = fs.realpathSync(base);
  if (real !== realBase && !real.startsWith(realBase + path.sep)) {
    throw new Error(`${what} ${real} escapes approved base ${realBase}`);
  }
  return real;
}

export class Registry {
  plugins = new Map<string, RegisteredPlugin>();
  errors: { path: string; error: string }[] = [];

  load(approvedDirs: string[]) {
    for (const dir of approvedDirs) {
      const realDir = fs.realpathSync(dir);
      for (const name of fs.readdirSync(realDir)) {
        if (!name.endsWith(".manifest.json")) continue;
        const p = path.join(realDir, name);
        try {
          this.loadOne(p, approvedDirs);
        } catch (e) {
          // an invalid/unapproved manifest is skipped, never partially trusted
          this.errors.push({ path: p, error: String(e) });
        }
      }
    }
  }

  private loadOne(manifestPath: string, approvedDirs: string[]) {
    // Manifest must live inside an approved dir (realpath — no symlink escape).
    const realManifest = fs.realpathSync(manifestPath);
    const inApproved = approvedDirs.some((d) => {
      const rd = fs.realpathSync(d);
      return realManifest.startsWith(rd + path.sep);
    });
    if (!inApproved) throw new Error(`manifest ${realManifest} not inside approved dir`);

    const m = check(Manifest, JSON.parse(fs.readFileSync(realManifest, "utf8")), "manifest");

    // Plugin command executable: must be absolute; resolved to realpath; the
    // manifest's declared path must already be canonical (reject symlinked
    // declaration so repo content cannot swap binaries).
    const cmdReal = fs.realpathSync(m.command.executable);
    if (cmdReal !== m.command.executable) {
      throw new Error(`plugin executable ${m.command.executable} is not canonical realpath`);
    }
    const cliReal = fs.realpathSync(m.cli.executable);
    if (cliReal !== m.cli.executable) {
      throw new Error(`cli executable ${m.cli.executable} is not canonical realpath`);
    }
    if (m.cli.invoker) {
      const invReal = fs.realpathSync(m.cli.invoker);
      if (invReal !== m.cli.invoker) {
        throw new Error(`cli invoker ${m.cli.invoker} is not canonical realpath`);
      }
    }
    // Identity hash pins the exact CLI binary.
    const hash = sha256File(cliReal);
    if (hash !== m.cli.sha256) {
      throw new Error(`cli sha256 mismatch for ${cliReal}: ${hash}`);
    }
    // required_env may never request credential-class names (Jev key, router
    // token, provider credentials) — rejected at load, not just filtered later
    for (const name of m.required_env) {
      if (envNameDenied(name)) {
        throw new Error(`manifest ${m.plugin_id} requests denied env name ${name}`);
      }
    }
    const catalog = check(
      Catalog,
      JSON.parse(fs.readFileSync(realUnder(m.catalog_path, path.dirname(realManifest), "catalog"), "utf8")),
      "catalog",
    );
    if (catalog.plugin_id !== m.plugin_id) {
      throw new Error(`catalog plugin_id ${catalog.plugin_id} != manifest ${m.plugin_id}`);
    }
    if (this.plugins.has(m.plugin_id)) throw new Error(`duplicate plugin_id ${m.plugin_id}`);
    this.plugins.set(m.plugin_id, {
      manifest: m,
      catalog,
      manifestPath: realManifest,
      pluginExeReal: cmdReal,
      cliExeReal: cliReal,
    });
  }

  get(pluginId: string): RegisteredPlugin | undefined {
    return this.plugins.get(pluginId);
  }
  workerPlugins(): RegisteredPlugin[] {
    return [...this.plugins.values()].filter(
      (p) => p.manifest.designation === "worker",
    );
  }
}
