// Executable subprocess smoke for the real routerd CLI: --help, --init-example
// (private 0600 config, synthetic-only manifests, refuse overwrite), --config
// start on loopback, authenticated job flow, SSE, idempotency, 401, SIGTERM.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROUTERD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/http/routerd.js");
const NODE = process.execPath;

function run(args: string[], opts: { timeoutMs?: number } = {}) {
  const c = spawn(NODE, [ROUTERD, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  c.stdout!.on("data", (d) => (out += d));
  c.stderr!.on("data", (d) => (err += d));
  return { c, out: () => out, err: () => err, done: new Promise<{ code: number | null }>((r) => c.on("exit", (code) => r({ code }))) , timeoutMs: opts.timeoutMs ?? 15000 };
}

test("routerd --help exits 0 with usage", async () => {
  const r = run(["--help"]);
  const { code } = await r.done;
  assert.equal(code, 0);
  assert.match(r.out(), /--init-example|--config/);
});

test("routerd --init-example writes private synthetic config; refuses overwrite", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routerd-init-"));
  fs.rmSync(dir, { recursive: true });
  try {
    const r = run(["--init-example", dir]);
    const { code } = await r.done;
    assert.equal(code, 0, r.err());
    const cfgPath = path.join(dir, "config.json");
    const st = fs.statSync(cfgPath);
    assert.equal(st.mode & 0o777, 0o600, "config not private");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    assert.ok(fs.existsSync(path.join(dir, "approved-manifests")));
    // manifests are synthetic fixture pins only
    const mfiles = fs.readdirSync(path.join(dir, "approved-manifests")).filter((f) => f.endsWith(".manifest.json"));
    assert.ok(mfiles.length >= 1);
    // second init must refuse to overwrite
    const r2 = run(["--init-example", dir]);
    const { code: code2 } = await r2.done;
    assert.notEqual(code2, 0);
    // no real provider credentials anywhere in generated files
    for (const f of fs.readdirSync(dir, { recursive: true }) as string[]) {
      const p = path.join(dir, f);
      if (fs.statSync(p).isFile()) {
        const txt = fs.readFileSync(p, "utf8");
        assert.equal(/api[_-]?key|secret|bearer [a-z0-9]/i.test(txt), false, `${f} looks like it embeds credentials`);
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("routerd subprocess: init -> listen -> job -> SSE -> 401 -> SIGTERM clean exit", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routerd-e2e-"));
  fs.rmSync(dir, { recursive: true });
  let srv: ReturnType<typeof run> | null = null;
  try {
    const init = run(["--init-example", dir]);
    assert.equal((await init.done).code, 0, init.err());
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    const token = cfg.principals[0].token;

    srv = run(["--config", path.join(dir, "config.json")]);
    // wait for LISTEN line
    const port = await new Promise<number>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no LISTEN line; out=${srv!.out()} err=${srv!.err()}`)), 15000);
      srv!.c.stdout!.on("data", (d) => {
        const m = String(d).match(/LISTEN 127\.0\.0\.1:(\d+)/);
        if (m) { clearTimeout(t); resolve(Number(m[1])); }
      });
    });

    const base = `http://127.0.0.1:${port}`;
    // unauthenticated -> 401
    const unauth = await fetch(`${base}/v1/jobs`);
    assert.equal(unauth.status, 401);
    // submit a fake job
    const sub = await fetch(`${base}/v1/jobs`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": randomUUID() },
      body: JSON.stringify({ task: "cli smoke", role: "coding", policy: "default", workspace: { mode: "fresh" } }),
    });
    assert.equal(sub.status, 201);
    const { job_id } = (await sub.json()) as { job_id: string };
    // idempotent replay with same key+body
    const idemKey = randomUUID();
    const body = JSON.stringify({ task: "same", role: "coding", policy: "default", workspace: { mode: "fresh" } });
    const r1 = await fetch(`${base}/v1/jobs`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": idemKey }, body });
    const r2 = await fetch(`${base}/v1/jobs`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": idemKey }, body });
    assert.equal(r1.status, 201);
    assert.equal(r2.status, 200);
    assert.equal(((await r1.json()) as { job_id: string }).job_id, ((await r2.json()) as { job_id: string }).job_id);
    // poll until terminal
    const deadline = Date.now() + 30000;
    let status = "";
    for (;;) {
      const j = await fetch(`${base}/v1/jobs/${job_id}`, { headers: { authorization: `Bearer ${token}` } });
      status = ((await j.json()) as { status: string }).status;
      if (["succeeded", "failed", "cancelled", "needs_recovery"].includes(status)) break;
      if (Date.now() > deadline) throw new Error(`job did not settle: ${status}`);
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(status, "succeeded");
    // SSE replay after terminal still serves events
    const sse = await fetch(`${base}/v1/jobs/${job_id}/events`, { headers: { authorization: `Bearer ${token}` } });
    const text = await sse.text();
    assert.ok(text.includes("job.finished") || text.includes("run.completed"));
    // SIGTERM -> clean exit
    srv.c.kill("SIGTERM");
    const { code } = await srv.done;
    assert.equal(code, 0, `unclean exit; err=${srv.err()}`);
  } finally {
    if (srv) srv.c.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("routerd SIGTERM with ACTIVE hanging job + open SSE tears down bounded (<8s)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routerd-sigterm-"));
  fs.rmSync(dir, { recursive: true });
  let srv: ReturnType<typeof run> | null = null;
  const t0 = Date.now();
  try {
    const init = run(["--init-example", dir]);
    assert.equal((await init.done).code, 0, init.err());
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    const token = cfg.principals[0].token;
    srv = run(["--config", path.join(dir, "config.json")]);
    const port = await new Promise<number>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no LISTEN; out=${srv!.out()} err=${srv!.err()}`)), 15000);
      srv!.c.stdout!.on("data", (d) => {
        const m = String(d).match(/LISTEN 127\.0\.0\.1:(\d+)/);
        if (m) { clearTimeout(t); resolve(Number(m[1])); }
      });
    });
    const base = `http://127.0.0.1:${port}`;
    // snapshot fixture pids BEFORE the daemon's job starts so the final check
    // only attributes NEW children to this daemon — unrelated pre-existing
    // fixture processes must not count as our leak.
    const fakeCliPids = (): Set<number> => {
      try {
        return new Set(
          execFileSync("ps", ["-eo", "pid,args"], { encoding: "utf8" })
            .split("\n").filter((l) => l.includes("fake-cli.mjs")).map((l) => Number(l.trim().split(/\s+/)[0])),
        );
      } catch {
        return new Set();
      }
    };
    const beforePids = fakeCliPids();
    // submit a hanging fixture job (beh-hang never finishes on its own)
    const sub = await fetch(`${base}/v1/jobs`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ task: "hang", role: "coding", policy: "default", workspace: { mode: "fresh" }, preferred: { model: "beh-hang" } }),
    });
    const subBody = await sub.text();
    assert.equal(sub.status, 201, subBody);
    const { job_id } = JSON.parse(subBody) as { job_id: string };
    // wait until the attempt is actually running, then open a live SSE stream
    let running = false;
    for (let i = 0; i < 100 && !running; i++) {
      const j = await fetch(`${base}/v1/jobs/${job_id}`, { headers: { authorization: `Bearer ${token}` } });
      const st = ((await j.json()) as { status: string }).status;
      if (st === "running") running = true;
      else await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(running, true, "hang job never reached running");
    const sseCtrl = new AbortController();
    const ssePromise = fetch(`${base}/v1/jobs/${job_id}/events`, {
      headers: { authorization: `Bearer ${token}` }, signal: sseCtrl.signal,
    }).then((r) => r.text()).catch(() => "aborted");
    // give the SSE pump a beat to register its connection, then SIGTERM
    await new Promise((r) => setTimeout(r, 400));
    srv.c.kill("SIGTERM");
    const exit = await Promise.race([
      srv.done.then((d) => d.code),
      new Promise<"TIMEOUT">((r) => setTimeout(() => r("TIMEOUT"), 8000)),
    ]);
    assert.notEqual(exit, "TIMEOUT", `daemon did not exit within 8s; err=${srv.err()}`);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 20000, `teardown too slow: ${elapsed}ms`);
    // the SSE response must have been closed by shutdown (not left hanging)
    const sseText = await Promise.race([ssePromise, new Promise<string>((r) => setTimeout(() => r("SSE-HUNG"), 5000))]);
    assert.notEqual(sseText, "SSE-HUNG", "open SSE stream was never closed by shutdown");
    sseCtrl.abort();
    // no NEW fixture child survivors owned by this daemon's run
    const leaked = [...fakeCliPids()].filter((p) => !beforePids.has(p));
    assert.deepEqual(leaked, [], `fixture child survived daemon teardown: ${leaked.join(",")}`);
  } finally {
    if (srv) srv.c.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
