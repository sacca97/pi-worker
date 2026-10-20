import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { WorkerManager, configFromEnv } from "../src/worker-manager.js";

const FAKE = resolve(process.cwd(), "tests/fake-pi.mjs");
let repo: string;
let mgr: WorkerManager;

before(() => {
  process.env.PI_WORKERS_HOME = mkdtempSync(join(tmpdir(), "pw-state-"));
  repo = mkdtempSync(join(tmpdir(), "pw-repo-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: repo });
  g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  execFileSync("sh", ["-c", "echo hi > a.txt"], { cwd: repo });
  g("add", "."); g("commit", "-qm", "init");
  mgr = new WorkerManager({ ...configFromEnv(), defaultModel: "", defaultThinking: "", piCommand: FAKE, pigCommand: FAKE, maxConcurrent: 2, defaultTimeoutMs: 5000, maxRestarts: 1 }, 0);
});
after(() => mgr.killAllSync());

test("spawn returns immediately; wait + result + follow-up keep the session", async () => {
  const t0 = Date.now();
  const m = await mgr.spawn({ prompt: "hello", cwd: repo });
  assert.ok(Date.now() - t0 < 500);
  const w = await mgr.wait([m.id], "all", 10_000);
  assert.equal(w.timedOut, false);
  let r: any = await mgr.result(m.id);
  assert.equal(r.state, "idle");
  assert.equal(r.result.summary, "ok");
  assert.equal(r.result.findings.length, 1);
  assert.equal(r.usage.total, 3);
  await mgr.prompt(m.id, "again");
  await mgr.wait([m.id], "all", 10_000);
  r = await mgr.result(m.id);
  assert.equal(r.turn, 1);
  assert.match(r.text, /again/);
});

test("concurrency limit queues extra workers", async () => {
  const ms = await Promise.all([1, 2, 3].map((i) => mgr.spawn({ prompt: `hang ${i}`, cwd: repo })));
  await new Promise((r) => setTimeout(r, 400));
  const states = ms.map((m) => mgr.status(m.id).state).sort();
  assert.deepEqual(states, ["queued", "running", "running"]);
  for (const m of ms) await mgr.cancel(m.id, { terminate: true });
  assert.ok(ms.every((m) => ["cancelled", "failed"].includes(mgr.status(m.id).state)));
});

test("cancel aborts a running worker", async () => {
  const m = await mgr.spawn({ prompt: "hang", cwd: repo });
  await new Promise((r) => setTimeout(r, 300));
  const s = await mgr.cancel(m.id);
  assert.equal(s.state, "cancelled");
});

test("timeout fails the turn", async () => {
  const m = await mgr.spawn({ prompt: "hang", cwd: repo, timeoutMs: 400 });
  await mgr.wait([m.id], "all", 5000);
  const s = mgr.status(m.id);
  assert.equal(s.state, "failed");
  assert.match(s.error ?? "", /timed out/);
});

test("failed model turn is reported", async () => {
  const m = await mgr.spawn({ prompt: "fail", cwd: repo });
  await mgr.wait([m.id], "all", 5000);
  const r: any = await mgr.result(m.id);
  assert.equal(r.state, "failed");
  assert.match(r.result.errors.join(), /boom/);
});

test("crash recovery restarts the process once", async () => {
  const wd = mkdtempSync(join(tmpdir(), "pw-crash-"));
  const m = await mgr.spawn({ prompt: "crash", cwd: wd });
  await mgr.wait([m.id], "all", 10_000);
  const s = mgr.status(m.id);
  assert.equal(s.state, "idle");
  assert.equal(s.restarts, 1);
});

test("conflicting edits are isolated in separate worktrees", async () => {
  const [a, b] = await Promise.all([
    mgr.spawn({ prompt: "edit:a.txt", cwd: repo, readOnly: false }),
    mgr.spawn({ prompt: "edit:a.txt", cwd: repo, readOnly: false }),
  ]);
  await mgr.wait([a.id, b.id], "all", 10_000);
  const ra: any = await mgr.result(a.id, { includeDiff: true });
  const rb: any = await mgr.result(b.id, { includeDiff: true });
  assert.deepEqual(ra.result.filesModified, ["a.txt"]);
  assert.notEqual(ra.diff.diff, rb.diff.diff);
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "hi\n"); // original tree untouched
  const wt = (mgr as any).workers.get(a.id).meta.worktree.path;
  await mgr.cancel(a.id, { cleanup: true });
  assert.equal(existsSync(wt), false);
});

test("recursive delegation is refused inside a worker", async () => {
  const nested = new WorkerManager({ ...configFromEnv(), defaultModel: "", defaultThinking: "", piCommand: FAKE, pigCommand: FAKE }, 1);
  await assert.rejects(nested.spawn({ prompt: "x", cwd: repo }), /recursive/);
});

test("parent shutdown kills worker processes", async () => {
  const m = await mgr.spawn({ prompt: "hang", cwd: repo });
  await new Promise((r) => setTimeout(r, 300));
  const pid = (mgr as any).workers.get(m.id).rpc.pid;
  await mgr.shutdown();
  await new Promise((r) => setTimeout(r, 300));
  assert.throws(() => process.kill(pid, 0));
});

test("runtime 'pig' uses the pig command", async () => {
  const m2 = new WorkerManager({ ...configFromEnv(), defaultModel: "", defaultThinking: "", piCommand: "/nonexistent-pi", pigCommand: FAKE }, 0);
  const w = await m2.spawn({ prompt: "hello", cwd: repo }); // pig is the default
  await m2.wait([w.id], "all", 10_000);
  assert.equal(m2.status(w.id).state, "idle");
  assert.equal(m2.status(w.id).runtime, "pig");
  m2.killAllSync();
});

test("cancelled follow-up does not inherit the previous turn's text", async () => {
  const m = await mgr.spawn({ prompt: "first", cwd: repo });
  await mgr.wait([m.id], "all", 10_000);
  await mgr.prompt(m.id, "hang");
  await new Promise((r) => setTimeout(r, 300));
  await mgr.cancel(m.id);
  const r: any = await mgr.result(m.id);
  assert.ok(!r.text.includes("first"));
});

test("prompt right after a failure starts a fresh process", async () => {
  const m = await mgr.spawn({ prompt: "fail", cwd: repo });
  await mgr.wait([m.id], "all", 5000);
  await mgr.prompt(m.id, "recover");
  await mgr.wait([m.id], "all", 10_000);
  assert.equal(mgr.status(m.id).state, "idle");
});

test("worktree mirrors a subdirectory cwd and batch creation doesn't collide", async () => {
  execFileSync("sh", ["-c", "mkdir -p sub && echo x > sub/f.txt && git add . && git commit -qm sub"], { cwd: repo });
  const ms = await Promise.all([1, 2, 3, 4].map(() => mgr.spawn({ prompt: "hi", cwd: join(repo, "sub"), readOnly: false })));
  assert.ok(ms.every((m) => m.cwd.endsWith("/tree/sub")));
  await mgr.wait(ms.map((m) => m.id), "all", 15_000);
});

test("a second server ignores workers owned by a live server and adopts dead ones", async () => {
  const home = mkdtempSync(join(tmpdir(), "pw-own-"));
  const saved = process.env.PI_WORKERS_HOME;
  process.env.PI_WORKERS_HOME = home;
  try {
    const { saveMeta, loadAllMeta } = await import("../src/sessions.js");
    const base: any = { name: "x", state: "running", cwd: repo, originCwd: repo, readOnly: true, timeoutMs: 1, createdAt: 1, updatedAt: 1, turns: [], toolCalls: 0, filesTouched: [], testRuns: [], restarts: 0 };
    saveMeta({ ...base, id: "live", ownerPid: process.ppid });
    saveMeta({ ...base, id: "dead", ownerPid: 2 ** 22 + 12345 });
    const m = new WorkerManager({ ...configFromEnv(), defaultModel: "", defaultThinking: "", piCommand: FAKE, pigCommand: FAKE }, 0);
    assert.deepEqual(m.list().map((w) => w.id), ["dead"]);
    assert.equal(m.status("dead").state, "failed");
    assert.equal(loadAllMeta().find((w) => w.id === "live")!.state, "running"); // untouched on disk
  } finally {
    process.env.PI_WORKERS_HOME = saved;
  }
});

test("default model and thinking come from config", async () => {
  const m2 = new WorkerManager({ ...configFromEnv(), piCommand: FAKE, pigCommand: FAKE }, 0);
  const a = await m2.spawn({ prompt: "x", cwd: repo });
  const b = await m2.spawn({ prompt: "x", cwd: repo, model: "other", thinking: "low" });
  const meta = (id: string) => (m2 as any).workers.get(id).meta;
  assert.deepEqual([meta(a.id).provider, meta(a.id).model, meta(a.id).thinking], ["opencode-go", "deepseek-v4.1-flash", "max"]);
  assert.deepEqual([meta(b.id).provider, meta(b.id).model, meta(b.id).thinking], [undefined, "other", "low"]);
  m2.killAllSync();
});

test("wait-cli exits when workers finish and reports timeouts", async () => {
  const { spawn } = await import("node:child_process");
  const run = (args: string[]) => new Promise<{ code: number | null; out: string }>((res) => {
    const c = spawn("node", [resolve("dist/src/wait-cli.js"), ...args], { env: process.env });
    let out = ""; c.stdout.on("data", (d) => (out += d));
    c.on("exit", (code) => res({ code, out }));
  });
  const fast = await mgr.spawn({ prompt: "quick", cwd: repo, name: "fast" });
  const r1 = await run([fast.id]);
  assert.equal(r1.code, 0);
  assert.match(r1.out, /\(fast\): idle/);
  const slow = await mgr.spawn({ prompt: "hang", cwd: repo, timeoutMs: 60_000 });
  const r2 = await run(["--timeout", "2", slow.id]);
  assert.equal(r2.code, 3);
  const r3 = await run(["--any", "--timeout", "5", slow.id, fast.id]);
  assert.equal(r3.code, 0);
  assert.equal((await run(["nope"])).code, 2);
  await mgr.cancel(slow.id, { terminate: true });
});

test("readOnly:false in a non-git dir falls back to no isolation", async () => {
  const wd = mkdtempSync(join(tmpdir(), "pw-nogit-"));
  const m = await mgr.spawn({ prompt: "hi", cwd: wd, readOnly: false });
  assert.equal(m.worktree, undefined);
  await mgr.wait([m.id], "all", 10_000);
});

test("structured result survives code fences inside findings", async () => {
  const { parseStructured } = await import("../src/results.js");
  const text = 'done\n```json\n{"summary":"s","findings":[{"detail":"see ```ts\\nx\\n``` here"}]}\n```';
  assert.equal(parseStructured(text).summary, "s");
  assert.equal(parseStructured(text).findings?.length, 1);
});

test("idle workers have their process reaped and can be resumed", async () => {
  const m2 = new WorkerManager({ ...configFromEnv(), piCommand: FAKE, pigCommand: FAKE, idleMs: 300 }, 0);
  const w = await m2.spawn({ prompt: "hello", cwd: repo });
  await m2.wait([w.id], "all", 10_000);
  const pid = (m2 as any).workers.get(w.id).rpc.pid;
  await new Promise((r) => setTimeout(r, 1200));
  assert.throws(() => process.kill(pid, 0));
  await m2.prompt(w.id, "again");
  await m2.wait([w.id], "all", 10_000);
  assert.equal(m2.status(w.id).state, "idle");
  m2.killAllSync();
});
