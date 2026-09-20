// Test helpers: temp operator env + stack + authed HTTP client.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { buildStack, writeFixtureManifest, writeNativeFixtureManifests, nativeFixtureProfileEnv, demoPolicy, Stack } from "../src/bootstrap.js";
import { RouterConfig, PolicyProfile } from "../src/config.js";

export interface TestEnv {
  tmp: string;
  token: string;
  config: RouterConfig;
  stack: Stack;
  port: number;
  cleanup: () => Promise<void>;
}

export async function makeEnv(opts: { policy?: Partial<PolicyProfile>; principals?: RouterConfig["principals"]; native?: { acp?: string; agy?: string } } = {}): Promise<TestEnv> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "router-test-"));
  const token = randomUUID() + randomUUID();
  const manifestDir = path.join(tmp, "approved-manifests");
  writeFixtureManifest(manifestDir);
  const profileEnv = opts.native ? nativeFixtureProfileEnv(opts.native) : {};
  if (opts.native) writeNativeFixtureManifests(manifestDir);
  const config: RouterConfig = {
    db_path: path.join(tmp, "router.db"),
    approved_manifest_dirs: [manifestDir],
    approved_workspace_base: path.join(tmp, "workspaces"),
    profiles: { default: { env: profileEnv, enabled: true } },
    principals: opts.principals ?? [
      { id: "op", token, scopes: ["jobs:write", "jobs:read", "approve"], policies: ["*"], workspaces: ["*"] },
    ],
    policies: [demoPolicy()],
    lead_handoff_enabled: true,
    http: { host: "127.0.0.1", port: 0, allow_public_bind: false },
  };
  if (opts.policy) Object.assign(config.policies[0]!, opts.policy);
  const stack = buildStack(config);
  stack.runtime.recoverOnStart();
  const port = await stack.api.listen();
  return {
    tmp, token, config, stack, port,
    cleanup: async () => {
      await stack.api.close();
      await stack.runtime.shutdown(); // settle in-flight executions before close
      stack.store.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

export async function api(env: TestEnv, method: string, path_: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`http://127.0.0.1:${env.port}${path_}`, {
    method,
    headers: { authorization: `Bearer ${env.token}`, "content-type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null), res };
}

export async function submitAndWait(env: TestEnv, req: Record<string, unknown>, timeoutMs = 30000) {
  const r = await api(env, "POST", "/v1/jobs", req, { "idempotency-key": randomUUID() });
  const jobId = (r.body as { job_id: string }).job_id;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const j = await api(env, "GET", `/v1/jobs/${jobId}`);
    const status = (j.body as { status: string }).status;
    if (["succeeded", "failed", "cancelled", "needs_recovery"].includes(status)) {
      return { job: j.body as Record<string, unknown>, jobId };
    }
    if (Date.now() > deadline) throw new Error(`timeout waiting for job; status=${status}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

export async function sseCollect(env: TestEnv, jobId: string, lastEventId?: string) {
  const headers: Record<string, string> = { authorization: `Bearer ${env.token}` };
  if (lastEventId !== undefined) headers["last-event-id"] = lastEventId;
  const res = await fetch(`http://127.0.0.1:${env.port}/v1/jobs/${jobId}/events`, { headers });
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((p) => p.includes("data: "))
    .map((p) => {
      const id = p.match(/^id: (.+)$/m)?.[1];
      const kind = p.match(/^event: (.+)$/m)?.[1];
      const data = JSON.parse(p.match(/^data: (.+)$/m)![1]!);
      return { id, kind, data };
    });
}
