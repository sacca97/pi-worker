import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { PiRpc } from "./pi-rpc.js";
import { RESULT_FORMAT_HINT, buildResult } from "./results.js";
import {
  appendLog, loadAllMeta, readLogTail, saveMeta, workerDir,
  type TokenUsage, type Turn, type WorkerMeta, type WorkerState,
} from "./sessions.js";
import { createWorktree, removeWorktree, repoRoot } from "./worktrees.js";

export interface ManagerConfig {
  maxConcurrent: number;
  piCommand: string;
  pigCommand: string;
  defaultRuntime: "pi" | "pig";
  /** Applied when a spawn gives no model (provider default applies only if no model was given). Empty = use the runtime's own default. */
  defaultProvider: string;
  defaultModel: string;
  defaultThinking: string;
  defaultTimeoutMs: number;
  maxRestarts: number;
  maxRateLimitRetries: number;
  allowRecursion: boolean;
  /** Stop an idle worker's pi process after this long (session stays resumable). 0 = never. */
  idleMs: number;
  /** Extra args always passed to pi (e.g. --no-extensions). */
  piArgs: string[];
}

const num = (v: string | undefined, def: number, min = 0) => {
  const n = v === undefined || v === "" ? NaN : Number(v);
  return Number.isFinite(n) && n >= min ? n : def;
};

export function configFromEnv(): ManagerConfig {
  const e = process.env;
  return {
    maxConcurrent: Math.floor(num(e.PI_WORKERS_MAX, 4, 1)),
    piCommand: e.PI_WORKERS_PI_COMMAND ?? "pi",
    pigCommand: e.PI_WORKERS_PIG_COMMAND ?? "pig",
    defaultRuntime: e.PI_WORKERS_DEFAULT_RUNTIME === "pi" ? "pi" : "pig",
    defaultProvider: e.PI_WORKERS_DEFAULT_PROVIDER ?? "opencode-go",
    defaultModel: e.PI_WORKERS_DEFAULT_MODEL ?? "deepseek-v4.1-flash",
    defaultThinking: e.PI_WORKERS_DEFAULT_THINKING ?? "max",
    defaultTimeoutMs: num(e.PI_WORKERS_TIMEOUT_MS, 15 * 60_000, 1),
    maxRestarts: num(e.PI_WORKERS_MAX_RESTARTS, 1),
    maxRateLimitRetries: num(e.PI_WORKERS_RATE_LIMIT_RETRIES, 2),
    allowRecursion: e.PI_WORKERS_ALLOW_RECURSION === "1",
    idleMs: num(e.PI_WORKERS_IDLE_MS, 10 * 60_000),
    piArgs: e.PI_WORKERS_PI_ARGS ? e.PI_WORKERS_PI_ARGS.split(" ").filter(Boolean) : [],
  };
}

export interface SpawnOptions {
  /** Which agent binary to run: 'pig' (default, Pi in Go) or 'pi' ( same RPC protocol, separate ~/.pig config and models). */
  runtime?: "pi" | "pig";
  prompt: string;
  name?: string;
  cwd?: string;
  provider?: string;
  model?: string;
  thinking?: string;
  /** read-only analysis workers share the original tree and get no write tools. Default true when isolation is "none". */
  readOnly?: boolean;
  /** "worktree" creates a separate git worktree; "none" works in cwd. Default: worktree if !readOnly and cwd is a git repo, else none. */
  isolation?: "worktree" | "none";
  tools?: string[];
  systemPrompt?: string;
  timeoutMs?: number;
  /** Disable pi's built-in MCP servers for the worker (default true; prevents recursive delegation). */
  noMcp?: boolean;
}

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const TERMINAL: WorkerState[] = ["idle", "failed", "cancelled", "closed"];
const TEST_RE = /\b(npm (run )?test|pnpm test|yarn test|pytest|vitest|jest|cargo test|go test|mocha|ctest|make test|tox|rspec)\b/;
const RATE_RE = /\b(429|503|529)\b|rate.?limit|overloaded|too many requests/i;
const RING = 200;
const TEXT_CAP = 400_000;

interface Runtime {
  meta: WorkerMeta;
  rpc?: PiRpc;
  noMcp: boolean;
  activity: string[];            // bounded ring of recent human-readable events
  curText: string;               // bounded text of the current/latest assistant message
  prevText?: string;             // latest earlier non-empty assistant message (fallback)
  timer?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
  settle?: (r: { ok: boolean; error?: string }) => void;
  cancelRequested: boolean;
  stderrTail: string;
  assistantError?: string;
  pendingTest?: { id: string; command: string };
}

export class WorkerManager {
  private workers = new Map<string, Runtime>();
  private queue: string[] = [];      // worker ids waiting for a slot (their pending turn is in `pendingPrompt`)
  private pendingPrompt = new Map<string, string>();
  private active = 0;
  private listeners = new Set<() => void>();

  constructor(readonly cfg: ManagerConfig = configFromEnv(), private depth = Number(process.env.PI_WORKERS_DEPTH ?? 0)) {
    this.restoreFromDisk();
  }

  /** Rehydrate session metadata; anything that was live when the parent died is marked accordingly. */
  private restoreFromDisk() {
    for (const m of loadAllMeta()) {
      // Another live server owns this worker: leave it alone entirely.
      if (m.ownerPid && m.ownerPid !== process.pid && pidAlive(m.ownerPid)) continue;
      m.ownerPid = process.pid;
      if (m.state === "queued" || m.state === "starting" || m.state === "running") {
        m.state = "failed";
        m.lastError = "interrupted: parent process restarted";
        const t = m.turns[m.turns.length - 1];
        if (t?.status === "running") { t.status = "failed"; t.error = m.lastError; t.endedAt = Date.now(); }
      } else if (m.state === "idle") m.state = "closed";
      m.testRuns ??= [];
      saveMeta(m);
      this.workers.set(m.id, { meta: m, noMcp: true, activity: [], curText: "", cancelRequested: false, stderrTail: "" });
    }
  }

  private notify() { for (const l of [...this.listeners]) l(); }

  private get(id: string): Runtime {
    const r = this.workers.get(id);
    if (!r) throw new Error(`unknown worker: ${id}`);
    return r;
  }

  private setState(r: Runtime, s: WorkerState) {
    r.meta.state = s;
    saveMeta(r.meta);
    this.notify();
  }

  private note(r: Runtime, line: string) {
    r.meta.lastActivity = line;
    r.activity.push(line);
    if (r.activity.length > RING) r.activity.shift();
    appendLog(r.meta.id, { ev: line });
  }

  // ---------------------------------------------------------------- spawn / prompt

  async spawn(o: SpawnOptions): Promise<WorkerMeta> {
    if (this.depth > 0 && !this.cfg.allowRecursion)
      throw new Error("recursive delegation is disabled (this server runs inside a Pi worker)");
    const id = randomBytes(4).toString("hex");
    const originCwd = o.cwd ?? process.cwd();
    const readOnly = o.readOnly ?? o.isolation !== "worktree";
    let isolation = o.isolation ?? (readOnly ? "none" : "worktree");
    if (!o.isolation && isolation === "worktree" && !(await repoRoot(originCwd))) isolation = "none"; // not a git repo: documented fallback
    let worktree: WorkerMeta["worktree"];
    if (isolation === "worktree") worktree = await createWorktree(id, originCwd);
    const meta: WorkerMeta = {
      id, name: o.name, runtime: o.runtime ?? this.cfg.defaultRuntime, state: "queued", cwd: worktree ? join(worktree.path, worktree.subdir) : originCwd, originCwd, worktree, readOnly,
      provider: o.provider ?? (o.model ? undefined : this.cfg.defaultProvider || undefined),
      model: o.model ?? (this.cfg.defaultModel || undefined),
      thinking: o.thinking ?? (this.cfg.defaultThinking || undefined),
      tools: o.tools ?? (readOnly ? READ_ONLY_TOOLS : undefined),
      systemPrompt: o.systemPrompt, timeoutMs: o.timeoutMs ?? this.cfg.defaultTimeoutMs,
      createdAt: Date.now(), updatedAt: Date.now(), ownerPid: process.pid, turns: [], toolCalls: 0, filesTouched: [], testRuns: [], restarts: 0,
    };
    saveMeta(meta);
    const r: Runtime = { meta, noMcp: o.noMcp ?? true, activity: [], curText: "", cancelRequested: false, stderrTail: "" };
    this.workers.set(id, r);
    this.enqueue(r, o.prompt);
    return meta; // returns immediately; execution is asynchronous
  }

  async prompt(id: string, message: string, mode: "auto" | "steer" | "followUp" = "auto"): Promise<{ disposition: string }> {
    const r = this.get(id);
    const s = r.meta.state;
    if (s === "running" && r.rpc && !r.rpc.exited && !r.rpc.closing) {
      if (mode === "auto") throw new Error("worker is busy; use mode 'steer' (interrupt after current tool calls) or 'followUp' (after it finishes)");
      const data = await r.rpc.call({ type: "prompt", message, streamingBehavior: mode });
      this.note(r, `${mode} queued: ${message.slice(0, 80)}`);
      return { disposition: data?.disposition ?? "queued" };
    }
    if (s === "running") throw new Error("worker is recovering from a process failure; wait for it to settle");
    if (s === "queued" || s === "starting") throw new Error(`worker is ${s}; wait for it to start`);
    this.enqueue(r, message);
    return { disposition: "queued" };
  }

  private enqueue(r: Runtime, prompt: string) {
    r.cancelRequested = false;
    r.curText = "";
    r.prevText = undefined;
    clearTimeout(r.idleTimer);
    r.meta.state = "queued";
    r.meta.turns.push({ index: r.meta.turns.length, prompt, startedAt: Date.now(), status: "running" });
    saveMeta(r.meta);
    this.pendingPrompt.set(r.meta.id, prompt);
    this.queue.push(r.meta.id);
    this.notify();
    this.pump();
  }

  private pump() {
    while (this.active < this.cfg.maxConcurrent && this.queue.length) {
      const id = this.queue.shift()!;
      const r = this.workers.get(id);
      const prompt = this.pendingPrompt.get(id);
      if (!r || prompt === undefined || r.meta.state !== "queued") continue;
      this.pendingPrompt.delete(id);
      this.active++;
      this.runJob(r, prompt)
        .catch((e) => this.finishTurn(r, "failed", String(e?.message ?? e)))
        .finally(() => { this.active--; this.pump(); });
    }
  }

  // ---------------------------------------------------------------- execution

  private piArgs(r: Runtime, resume: boolean): string[] {
    const m = r.meta;
    const a = [...this.cfg.piArgs, "--session-dir", join(workerDir(m.id), "pi-sessions")];
    if (resume && m.piSessionFile) a.push("--session", m.piSessionFile);
    if (m.provider) a.push("--provider", m.provider);
    if (m.model) a.push("--model", m.model);
    if (m.thinking) a.push("--thinking", m.thinking);
    if (m.tools) a.push("--tools", m.tools.join(","));
    if (m.name) a.push("--name", m.name);
    if (r.noMcp && !this.cfg.allowRecursion) a.push("--no-mcp");
    a.push("--append-system-prompt", [m.systemPrompt, RESULT_FORMAT_HINT,
      m.worktree ? `You are working in an isolated git worktree at ${m.cwd}; stay inside it.` : `Stay inside ${m.cwd}.`,
      m.readOnly ? "This is a read-only analysis task: do not modify files." : ""].filter(Boolean).join("\n\n"));
    return a;
  }

  private async ensureProcess(r: Runtime): Promise<PiRpc> {
    if (r.rpc && !r.rpc.exited && !r.rpc.closing) return r.rpc;
    const resume = !!r.meta.piSessionFile;
    const rpc = new PiRpc({
      command: r.meta.runtime === "pig" ? this.cfg.pigCommand : this.cfg.piCommand, cwd: r.meta.cwd, args: this.piArgs(r, resume),
      env: { PI_WORKERS_DEPTH: String(this.depth + 1) },
    });
    r.rpc = rpc;
    r.stderrTail = "";
    rpc.on("stderr", (s: string) => { r.stderrTail = (r.stderrTail + s).slice(-4000); });
    rpc.on("event", (ev: any) => { if (r.rpc === rpc) this.onEvent(r, ev); });
    rpc.on("exit", ({ code, signal }) => {
      appendLog(r.meta.id, { ev: `pi exited code=${code} signal=${signal}` });
      if (r.rpc === rpc && r.settle) r.settle({ ok: false, error: `pi process died (code=${code}, signal=${signal}): ${r.stderrTail.trim().slice(-500)}` });
    });
    const st = await rpc.call({ type: "get_state" }, 30_000);
    r.meta.piSessionFile = st.sessionFile ?? r.meta.piSessionFile;
    await rpc.call({ type: "set_auto_retry", enabled: true }).catch(() => {});
    saveMeta(r.meta);
    return rpc;
  }

  private onEvent(r: Runtime, ev: any) {
    const m = r.meta;
    switch (ev.type) {
      case "tool_execution_start": {
        m.toolCalls++;
        const a = ev.args ?? {};
        const target = a.path ?? a.file_path ?? a.command ?? a.pattern ?? "";
        this.note(r, `tool ${ev.toolName} ${String(target).slice(0, 100)}`);
        if ((ev.toolName === "edit" || ev.toolName === "write") && (a.path ?? a.file_path)) {
          const f = String(a.path ?? a.file_path);
          if (!m.filesTouched.includes(f)) m.filesTouched.push(f);
        }
        break;
      }
      case "message_start":
        if (ev.message?.role === "assistant") { if (r.curText) r.prevText = r.curText; r.curText = ""; }
        break;
      case "message_update": {
        const u = ev.assistantMessageEvent;
        if (u?.type === "text_delta" && r.curText.length < TEXT_CAP) r.curText += u.delta;
        break;
      }
      case "message_end":
        if (ev.message?.role === "assistant") {
          const text = textOf(ev.message);
          r.curText = text.slice(0, TEXT_CAP);
          r.assistantError = ev.message.stopReason === "error" ? String(ev.message.errorMessage ?? "model error") : undefined;
        }
        break;
      case "auto_retry_start":
        this.note(r, `retry ${ev.attempt}/${ev.maxAttempts}: ${String(ev.errorMessage).slice(0, 80)}`);
        break;
      case "agent_settled":
        if (r.settle) r.settle(r.assistantError ? { ok: false, error: r.assistantError } : { ok: true });
        break;
    }
    // Track test commands from the bash tool.
    if (ev.type === "tool_execution_start" && ev.toolName === "bash" && TEST_RE.test(String(ev.args?.command ?? ""))) {
      r.pendingTest = { id: ev.toolCallId, command: String(ev.args.command).slice(0, 200) };
    }
    const pt = r.pendingTest;
    if (ev.type === "tool_execution_end" && pt && pt.id === ev.toolCallId) {
      m.testRuns.push({ command: pt.command, ok: !ev.isError });
      r.pendingTest = undefined;
    }
  }

  private async runJob(r: Runtime, prompt: string): Promise<void> {
    const m = r.meta;
    let attempt = 0;
    let crashRestarts = 0;
    let text = prompt;
    for (;;) {
      this.setState(r, "starting");
      let rpc: PiRpc;
      try { rpc = await this.ensureProcess(r); }
      catch (e: any) {
        if (r.cancelRequested) return this.finishTurn(r, "cancelled");
        return this.finishTurn(r, "failed", `could not start pi: ${e.message} ${r.stderrTail.trim().slice(-300)}`);
      }
      if (r.cancelRequested) return this.finishTurn(r, "cancelled");
      r.curText = "";
      r.prevText = undefined;
      r.assistantError = undefined;
      const outcome = new Promise<{ ok: boolean; error?: string }>((res) => { r.settle = res; });
      const timeout = new Promise<{ ok: boolean; error?: string; timeout: true }>((res) => {
        r.timer = setTimeout(() => res({ ok: false, error: `timed out after ${m.timeoutMs}ms`, timeout: true }), m.timeoutMs);
      });
      try {
        this.setState(r, "running");
        const resp = await rpc.call({ type: "prompt", message: text });
        if (resp?.disposition === "handled") r.settle?.({ ok: true });
      } catch (e: any) { r.settle?.({ ok: false, error: e.message }); }
      const res: any = await Promise.race([outcome, timeout]);
      clearTimeout(r.timer);
      r.settle = undefined;
      if (r.cancelRequested) return this.finishTurn(r, "cancelled");
      if (res.timeout) {
        await rpc.call({ type: "abort" }, 5000).catch(() => {});
        await this.captureStats(r);
        return this.finishTurn(r, "timeout", res.error);
      }
      if (res.ok) {
        await this.captureStats(r);
        return this.finishTurn(r, "done");
      }
      // Failure: crash recovery or rate-limit retry.
      const died = rpc.exited;
      if (died && crashRestarts < this.cfg.maxRestarts) {
        crashRestarts++; m.restarts++;
        this.note(r, `crash recovery #${crashRestarts}: resuming session`);
        text = `Your previous process crashed. Resume the task from where you left off:\n\n${prompt}`;
        continue;
      }
      if (!died && RATE_RE.test(res.error ?? "") && attempt < this.cfg.maxRateLimitRetries) {
        attempt++;
        const delay = 2000 * 2 ** attempt;
        this.note(r, `rate limited; retry ${attempt} in ${delay}ms`);
        await sleep(delay);
        text = "The previous attempt hit a transient provider error. Continue the task from where you left off; do not repeat completed work.";
        continue;
      }
      await this.captureStats(r);
      return this.finishTurn(r, "failed", res.error);
    }
  }

  private async captureStats(r: Runtime) {
    if (!r.rpc || r.rpc.exited) return;
    try {
      const s = await r.rpc.call({ type: "get_session_stats" }, 10_000);
      const t = s.tokens ?? {};
      r.meta.usage = { input: t.input ?? 0, output: t.output ?? 0, cacheRead: t.cacheRead ?? 0, cacheWrite: t.cacheWrite ?? 0, total: t.total ?? 0, cost: s.cost ?? 0 } as TokenUsage;
    } catch {}
  }

  private finishTurn(r: Runtime, status: Turn["status"], error?: string) {
    const m = r.meta;
    clearTimeout(r.timer);
    r.settle = undefined;
    const t = m.turns[m.turns.length - 1];
    if (t && t.status === "running") {
      t.status = status;
      t.endedAt = Date.now();
      t.text = r.curText || r.prevText || undefined;
      if (error) t.error = error;
    }
    if (error) m.lastError = error;
    const alive = r.rpc && !r.rpc.exited;
    const next: WorkerState = status === "done" ? "idle" : status === "cancelled" ? "cancelled" : "failed";
    // Idle workers keep their pi process so the conversation stays warm; failed/cancelled ones are torn down (session file allows resume).
    if (next !== "idle" && alive) r.rpc!.close(1500).catch(() => {});
    if (next === "idle" && this.cfg.idleMs > 0) {
      r.idleTimer = setTimeout(() => { if (r.meta.state === "idle") this.close(m.id).catch(() => {}); }, this.cfg.idleMs);
      r.idleTimer.unref();
    }
    this.note(r, `turn ${t?.index} ${status}${error ? `: ${error.slice(0, 120)}` : ""}`);
    this.setState(r, next);
  }

  // ---------------------------------------------------------------- queries / control

  status(id: string) {
    const r = this.get(id);
    const m = r.meta;
    const t = m.turns[m.turns.length - 1];
    return {
      id: m.id, name: m.name, runtime: m.runtime, state: m.state, model: m.model, provider: m.provider, cwd: m.cwd,
      isolation: m.worktree ? "worktree" : "none", readOnly: m.readOnly,
      turns: m.turns.length, currentTurn: t ? { index: t.index, status: t.status, runningForMs: (t.endedAt ?? Date.now()) - t.startedAt } : null,
      toolCalls: m.toolCalls, filesTouched: m.filesTouched.length, lastActivity: m.lastActivity,
      recentActivity: r.activity.slice(-8), partialTextChars: r.meta.state === "running" ? r.curText.length : undefined,
      usage: m.usage, restarts: m.restarts, error: m.lastError,
    };
  }

  list() {
    return [...this.workers.values()].map((r) => {
      const m = r.meta;
      return { id: m.id, name: m.name, runtime: m.runtime, state: m.state, model: m.model, turns: m.turns.length, toolCalls: m.toolCalls,
        cwd: m.cwd, createdAt: new Date(m.createdAt).toISOString(), updatedAt: new Date(m.updatedAt).toISOString() };
    });
  }

  async result(id: string, o: { includeLog?: boolean; includeDiff?: boolean } = {}) {
    const r = this.get(id);
    const { result, text, diff } = await buildResult(r.meta, { includeDiff: o.includeDiff });
    const done = TERMINAL.includes(r.meta.state);
    return {
      id, state: r.meta.state, finished: done, turn: r.meta.turns.length - 1,
      ...(done ? { result, text } : { partialText: r.curText.slice(-4000) }),
      ...(diff ? { diff } : {}),
      ...(o.includeLog ? { log: readLogTail(id, 100) } : {}),
      usage: r.meta.usage,
    };
  }

  /** Wait until any/all workers are out of queued/starting/running, or timeout. Never throws on timeout. */
  async wait(ids: string[], mode: "all" | "any" = "all", timeoutMs = 60_000) {
    ids.forEach((i) => this.get(i));
    const check = () => {
      const done = ids.filter((i) => TERMINAL.includes(this.get(i).meta.state));
      return mode === "any" ? done.length > 0 : done.length === ids.length;
    };
    if (!check()) {
      await new Promise<void>((resolve) => {
        const finish = () => { clearTimeout(timer); this.listeners.delete(fn); resolve(); };
        const fn = () => { if (check()) finish(); };
        const timer = setTimeout(finish, timeoutMs);
        this.listeners.add(fn);
      });
    }
    return { timedOut: !check(), workers: ids.map((i) => this.status(i)) };
  }

  async cancel(id: string, o: { terminate?: boolean; cleanup?: boolean } = {}) {
    const r = this.get(id);
    const s = r.meta.state;
    if (s === "queued") {
      this.queue = this.queue.filter((x) => x !== id);
      this.pendingPrompt.delete(id);
      this.finishTurn(r, "cancelled");
    } else if (s === "starting" || s === "running") {
      r.cancelRequested = true;
      if (r.rpc && !r.rpc.exited) {
        const aborted = await r.rpc.call({ type: "abort" }, 5000).then(() => true, () => false);
        if (!aborted) r.rpc.kill();
      }
      r.settle?.({ ok: false, error: "cancelled" });
      // runJob observes cancelRequested and calls finishTurn
      await this.wait([id], "all", 8000);
      if (!TERMINAL.includes(r.meta.state)) { r.rpc?.kill(); this.finishTurn(r, "cancelled"); }
    }
    if (o.terminate || o.cleanup) await this.close(id, !!o.cleanup);
    return this.status(id);
  }

  /** Stop the pi process (session stays resumable); optionally remove the worktree. */
  async close(id: string, cleanup = false) {
    const r = this.get(id);
    if (r.rpc && !r.rpc.exited) await r.rpc.close(1500);
    if (!["failed", "cancelled"].includes(r.meta.state)) r.meta.state = "closed";
    if (cleanup && r.meta.worktree) {
      if (await removeWorktree(r.meta.worktree, true)) r.meta.worktree = undefined;
      else r.meta.lastError = `failed to remove worktree ${r.meta.worktree.path}`;
    }
    saveMeta(r.meta);
    this.notify();
  }

  /** Parent shutdown: kill every pi process tree. Worktrees and logs are kept. */
  async shutdown() {
    this.queue = [];
    await Promise.all([...this.workers.values()].map(async (r) => {
      r.cancelRequested = true;
      r.settle?.({ ok: false, error: "parent shutdown" });
      if (r.rpc && !r.rpc.exited) { r.rpc.kill("SIGTERM"); await r.rpc.close(500).catch(() => {}); }
    }));
  }

  killAllSync() {
    for (const r of this.workers.values()) r.rpc?.kill("SIGKILL");
  }
}

function textOf(msg: any): string {
  if (typeof msg.content === "string") return msg.content;
  return (msg.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
}
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e.code === "EPERM"; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
