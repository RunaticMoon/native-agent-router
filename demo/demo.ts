// Self-contained demo: temp operator env -> build stack -> HTTP API on
// loopback -> submit synthetic job -> SSE stream -> terminal result.
// Requires NO Jev key, NO provider account. Synthetic fixture only.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { buildStack, writeFixtureManifest, demoPolicy } from "../src/bootstrap.js";
import { RouterConfig } from "../src/config.js";

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "router-demo-"));
  const token = randomUUID() + randomUUID();
  const tokenPath = path.join(tmp, "token");
  fs.writeFileSync(tokenPath, token, { mode: 0o600 });

  const manifestDir = path.join(tmp, "approved-manifests");
  writeFixtureManifest(manifestDir);

  const config: RouterConfig = {
    db_path: path.join(tmp, "router.db"),
    approved_manifest_dirs: [manifestDir],
    approved_workspace_base: path.join(tmp, "workspaces"),
    profiles: { default: { env: {}, enabled: true } },
    principals: [
      { id: "operator", token, scopes: ["jobs:write", "jobs:read", "approve"], policies: ["*"], workspaces: ["*"] },
    ],
    policies: [demoPolicy()],
    lead_handoff_enabled: true,
    http: { host: "127.0.0.1", port: 0, allow_public_bind: false },
  };

  const stack = buildStack(config);
  stack.runtime.recoverOnStart();
  const port = await stack.api.listen();
  console.log(`[demo] routerd listening on 127.0.0.1:${port} (loopback only)`);

  try {
    // --- submit job (authenticated) ---
    const submit = await fetch(`http://127.0.0.1:${port}/v1/jobs`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": "demo-1" },
      body: JSON.stringify({
        task: "Write a hello-world file and report what you did",
        role: "coding",
        policy: "default",
        workspace: { mode: "fresh" },
      }),
    });
    const { job_id } = (await submit.json()) as { job_id: string };
    console.log(`[demo] submitted job ${job_id} (HTTP ${submit.status})`);

    // --- unauthenticated request must fail ---
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/jobs/${job_id}`);
    console.log(`[demo] unauthenticated GET -> HTTP ${noAuth.status} (expect 401)`);

    // --- SSE stream ---
    const sse = await fetch(`http://127.0.0.1:${port}/v1/jobs/${job_id}/events`, {
      headers: { authorization: `Bearer ${token}` },
    });
    console.log(`[demo] SSE stream opened`);
    const reader = sse.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop()!;
      for (const part of parts) {
        const data = part.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("");
        if (!data) continue;
        const ev = JSON.parse(data);
        const summary = ev.kind === "text.delta" ? ` ${JSON.stringify(ev.payload.text).slice(0, 60)}` : "";
        console.log(`[demo] event seq=${ev.sequence} ${ev.kind}${summary}`);
      }
    }

    // --- final job state ---
    const job = (await (await fetch(`http://127.0.0.1:${port}/v1/jobs/${job_id}`, {
      headers: { authorization: `Bearer ${token}` },
    })).json()) as { status: string; result: { result?: { response_text?: string }; requested_model?: string | null; observed_model?: string } | null; attempts: { status: string; candidate_id: string }[] };
    console.log(`[demo] job status: ${job.status}`);
    console.log(`[demo] attempts: ${JSON.stringify(job.attempts.map((a) => ({ c: a.candidate_id, s: a.status })))}`);
    console.log(`[demo] result.response_text: ${job.result?.result?.response_text?.slice(0, 200)}`);
    console.log(`[demo] requested_model=${job.result?.requested_model ?? "null"} observed_model=${job.result?.observed_model ?? "unknown"}`);
    if (job.status !== "succeeded") {
      console.error("[demo] FAIL: expected succeeded");
      process.exitCode = 1;
    } else {
      console.log("[demo] PASS: vertical slice complete");
    }
  } finally {
    await stack.api.close();
    await stack.runtime.shutdown();
    stack.store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

void main();
