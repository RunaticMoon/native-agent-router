// example-native plugin: out-of-process JSON-RPC plugin for the synthetic
// fake-cli fixture. One plugin process per attempt; spawns the child CLI with
// allowlisted env + approved workspace cwd. stdout = protocol only.
import { PluginServer, RpcError, RPC } from "../../src/plugin-sdk/jsonrpc.js";
import { SafeProcess } from "../../src/process/safe-spawn.js";
import {
  RunRequest, RunResult, CanonicalEvent, NativeError, Capabilities,
  check, HandshakeResult, ProbeResult,
} from "../../src/contracts/index.js";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";

const argv = process.argv.slice(2);
const manifestPath = argv[argv.indexOf("--manifest") + 1];
if (!manifestPath) {
  process.stderr.write("missing --manifest\n");
  process.exit(2);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const CLI = manifest.cli.executable as string;
const INVOKER = manifest.cli.invoker as string | undefined;
const cliSpawn = (args: string[]) =>
  INVOKER ? { executable: INVOKER, args: [CLI, ...args] } : { executable: CLI, args };

const caps: Capabilities = {
  mode_agent: { status: "supported", evidence: "fixture agent mode" },
  mode_text: { status: "supported", evidence: "fixture text mode" },
  model_selection: { status: "supported", evidence: "--model flag" },
  effort: { status: "supported", evidence: "--effort flag" },
  structured_events: { status: "supported", evidence: "ndjson events" },
  resume: { status: "unsupported", evidence: "fixture: no verified resume" },
  permission: "interactive",
  run_usage: { status: "supported", evidence: "usage event cumulative" },
  quota: { status: "supported", evidence: "fixture synthetic quota observer" },
  graceful_cancel: { status: "supported", evidence: "SIGTERM group" },
  cwd: { status: "supported", evidence: "workspace cwd" },
  network: "none",
  filesystem: "workspace_only",
};

const server = new PluginServer();
const runs = new Map<string, SafeProcess>();
const pendingPerm = new Map<string, (d: string) => void>();
let seq = 0;

server.method("handshake", (p) => {
  const params = p as { protocol_version: number };
  if (params.protocol_version !== 1) {
    throw new RpcError({ code: RPC.INVALID_PARAMS, message: "protocol mismatch" });
  }
  const result: HandshakeResult = {
    protocol_version: 1,
    plugin_id: manifest.plugin_id,
    plugin_version: manifest.plugin_version,
    methods: ["probe", "run", "cancel", "respondPermission"],
    capabilities: caps,
    event_schema_version: 1,
  };
  return result;
});

server.method("probe", async () => {
  // no-inference probe: `--version` only
  const proc = new SafeProcess({
    ...cliSpawn(["--version"]), cwd: "/tmp", env: {},
  });
  let version = "unknown";
  proc.on("line", (l: string) => {
    try {
      const m = JSON.parse(l);
      if (m.event === "version") version = m.version;
    } catch {}
  });
  await new Promise((r) => proc.on("exit", r));
  const result: ProbeResult = {
    cli_version: version,
    capabilities: caps,
    // synthetic fixture quota observation — labelled estimated
    quota: {
      pool_id: "fixture-pool",
      status: "known",
      remaining: 1000,
      limit: 1000,
      unit: "requests",
      source: "fixture-synthetic",
      observed_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60000).toISOString(),
      estimated: true,
    },
    models: ["fake-small"],
  };
  return result;
});

function notifyEvent(req: RunRequest, kind: CanonicalEvent["kind"], payload: Record<string, unknown>, nativeSessionId?: string) {
  server.notify("run.event", {
    schema_version: 1, kind, job_id: req.job_id, attempt_id: req.attempt_id,
    run_id: req.run_id, event_id: `ev_${randomUUID()}`, sequence: seq++,
    ts: new Date().toISOString(), native_session_id: nativeSessionId, payload,
  });
}

server.method("run", (p) => {
  const req = check(RunRequest, p, "run params");
  return new Promise<RunResult>((resolve) => {
    const args = [
      "--prompt", req.task,
      "--model", req.requested_model,
      "--mode", req.execution_mode,
    ];
    if (req.requested_effort) args.push("--effort", req.requested_effort);
    // env passthrough: only request-approved names; never ambient
    const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
    for (const k of Object.keys(req.env)) env[k] = req.env[k]!;

    const cli = new SafeProcess({
      ...cliSpawn(args), cwd: req.workspace.path, env,
      maxStderrBytes: manifest.retention.diagnostics_bytes,
    });
    runs.set(req.run_id, cli);
    let session: string | undefined;
    let sawResult = false;
    let text = "";
    let usage: RunResult["usage"];
    let sideEffects: RunResult["side_effects"] = "unknown";
    let status: RunResult["status"] = "unknown";
    let observedModel: string | undefined;
    let finished = false;
    let cancelRequested = false;

    const finish = (r: RunResult) => {
      if (finished) return;
      finished = true;
      runs.delete(req.run_id);
      resolve(r);
    };

    notifyEvent(req, "run.started", { requested_model: req.requested_model, native_pid: cli.child.pid });

    cli.on("line", (line: string) => {
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(line);
      } catch {
        return; // non-protocol garbage on stdout — ignore
      }
      const ev = m.event as string;
      if (ev === "init") {
        session = m.conversation_id as string;
      } else if (ev === "text_delta") {
        text += m.text as string;
        notifyEvent(req, "text.delta", { text: m.text }, session);
      } else if (ev === "step_update") {
        const ti = m.tool_info as { name: string; call_id: string } | undefined;
        if (ti && m.state === "started") notifyEvent(req, "tool.started", { tool: ti.name, call_id: ti.call_id }, session);
        if (ti && m.state === "completed") notifyEvent(req, "tool.completed", { tool: ti.name, call_id: ti.call_id, status: (m.status as string) === "ok" ? "ok" : "error" }, session);
      } else if (ev === "permission_request") {
        notifyEvent(req, "permission.required", {
          request_id: m.request_id, action: m.action, target: m.target, options: m.options,
        }, session);
        pendingPerm.set(m.request_id as string, (decision) => {
          void cli.writeLine(JSON.stringify({ type: "permission_response", request_id: m.request_id, decision }));
        });
      } else if (ev === "usage") {
        usage = m.usage as RunResult["usage"];
        notifyEvent(req, "usage.observed", { usage: m.usage }, session);
      } else if (ev === "result") {
        sawResult = true;
        status = (m.status as string) === "success" ? "completed" : (m.status as RunResult["status"]);
        observedModel = (m.observed_model as string) ?? undefined;
        sideEffects = (m.side_effects as RunResult["side_effects"]) ?? "unknown";
        usage = (m.usage as RunResult["usage"]) ?? usage;
        if (status === "completed" || status === "partial" || status === "blocked") {
          finish({
            outcome: "completed", status, native_session_id: session,
            observed_model: observedModel, response_text: (m.response as string) ?? text,
            usage, side_effects: sideEffects, retry_safety: sideEffects === "none" ? "safe" : "unknown",
          });
        } else {
          const code = ((m.error_code as string) ?? "UNKNOWN_NATIVE_OUTCOME") as NativeError["code"];
          finish({
            outcome: "failed", native_session_id: session, side_effects: sideEffects,
            retry_safety: sideEffects === "none" ? "safe" : "unknown",
            error: { code, message: `cli result error ${code}`, phase: "run", retry_safety: sideEffects === "none" ? "safe" : "unknown" },
          });
        }
      }
    });

    cli.on("exit", async () => {
      await new Promise((r) => setTimeout(r, 20));
      if (finished) return;
      if (cancelRequested) {
        finish({ outcome: "cancelled", side_effects: sideEffects, retry_safety: "unknown", cancel_confirmed: true, native_session_id: session });
      } else if (!sawResult) {
        finish({
          outcome: "failed", native_session_id: session, side_effects: "unknown", retry_safety: "unknown",
          error: { code: "UNKNOWN_NATIVE_OUTCOME", message: `cli exited ${cli.exitCode} without result; stderr: ${cli.stderrTail.slice(-200)}`, phase: "run", retry_safety: "unknown" },
        });
      }
    });

    // deadline enforcement at plugin level too
    const timer = setTimeout(() => {
      void cli.stop("SIGKILL").then(() => {
        finish({
          outcome: "failed", native_session_id: session, side_effects: "unknown", retry_safety: "unknown",
          error: { code: "TIMEOUT", message: "deadline_ms exceeded", phase: "run", retry_safety: "unknown" },
        });
      });
    }, req.deadline_ms);
    cli.on("exit", () => clearTimeout(timer));
    runs.set(`${req.run_id}:cancel`, cli);
    (cli as unknown as { __cancel: () => void }).__cancel = () => {
      cancelRequested = true;
    };
  });
});

server.method("cancel", async (p) => {
  const { run_id } = p as { run_id: string };
  const cli = runs.get(run_id);
  if (!cli) return { ack: "already_finished" };
  (cli as unknown as { __cancel?: () => void }).__cancel?.();
  void cli.stop("SIGKILL", 1000); // local stop; remote confirm via run result
  return { ack: "accepted" };
});

server.method("respondPermission", (p) => {
  const { request_id, decision } = p as { run_id: string; request_id: string; decision: string };
  const fn = pendingPerm.get(request_id);
  if (!fn) throw new RpcError({ code: RPC.INVALID_PARAMS, message: "unknown request_id" });
  pendingPerm.delete(request_id);
  fn(decision);
  return { delivered: true };
});

server.start();
process.stderr.write("example-native plugin ready\n");
