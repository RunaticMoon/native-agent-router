// Plugin host: launches a plugin process per attempt (no pooling), performs
// handshake, probe, run, cancel; validates all wire messages against schemas.
import { PluginClient } from "./jsonrpc.js";
import {
  HandshakeResult, ProbeResult, ProbeParams, RunRequest, RunResult,
  CanonicalEvent, CancelResult, Capabilities, check,
} from "../contracts/index.js";
import { RegisteredPlugin } from "../registry/registry.js";

export class PluginProtocolError extends Error {}

export class PluginHost {
  private constructor(private client: PluginClient, readonly handshake: HandshakeResult) {}

  static async launch(rp: RegisteredPlugin, opts: { cwd: string; env: Record<string, string>; router_id: string; timeoutMs?: number }): Promise<PluginHost> {
    const client = new PluginClient({
      executable: rp.pluginExeReal,
      args: rp.manifest.command.args,
      cwd: opts.cwd,
      env: opts.env, // allowlisted plugin env — never ambient
      maxStderrBytes: rp.manifest.retention.diagnostics_bytes || 8192,
    });
    const raw = await client.call<unknown>("handshake", { protocol_version: 1, router_id: opts.router_id }, opts.timeoutMs ?? 15000);
    const hs = check(HandshakeResult, raw, "handshake result");
    if (hs.plugin_id !== rp.manifest.plugin_id || hs.plugin_version !== rp.manifest.plugin_version) {
      await client.stop();
      throw new PluginProtocolError(`handshake identity mismatch: ${hs.plugin_id}@${hs.plugin_version}`);
    }
    for (const m of ["probe", "run", "cancel"]) {
      if (!hs.methods.includes(m)) {
        await client.stop();
        throw new PluginProtocolError(`plugin missing required method ${m}`);
      }
    }
    return new PluginHost(client, hs);
  }

  capabilities(): Capabilities {
    return this.handshake.capabilities;
  }

  async probe(params: ProbeParams): Promise<ProbeResult> {
    return check(ProbeResult, await this.client.call("probe", params, 20000), "probe result");
  }

  // run resolves with the final RunResult; events stream via onEvent.
  async run(req: RunRequest, onEvent: (ev: CanonicalEvent) => void, timeoutMs: number): Promise<RunResult> {
    check(RunRequest, req, "run request");
    this.client.onNotification("run.event", (p) => {
      try {
        const ev = check(CanonicalEvent, p, "run.event");
        if (ev.run_id !== req.run_id || ev.job_id !== req.job_id || ev.attempt_id !== req.attempt_id) {
          return; // mismatched binding — refuse
        }
        onEvent(ev);
      } catch {
        /* malformed event dropped; runtime observes absence */
      }
    });
    const raw = await this.client.call("run", req, timeoutMs);
    const res = check(RunResult, raw, "run result");
    return res;
  }

  async cancel(runId: string): Promise<CancelResult> {
    return check(CancelResult, await this.client.call("cancel", { run_id: runId }, 10000), "cancel result");
  }

  async respondPermission(runId: string, requestId: string, decision: string): Promise<void> {
    if (!this.handshake.methods.includes("respondPermission")) {
      throw new PluginProtocolError("respondPermission not negotiated");
    }
    await this.client.call("respondPermission", { run_id: runId, request_id: requestId, decision }, 10000);
  }

  get proc() {
    return this.client.proc;
  }

  async stop() {
    await this.client.stop();
  }
}
