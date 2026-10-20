import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type WorkerState = "queued" | "starting" | "running" | "idle" | "failed" | "cancelled" | "closed";

export interface TokenUsage { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; cost: number }

export interface Turn {
  index: number;
  prompt: string;
  startedAt: number;
  endedAt?: number;
  status: "running" | "done" | "failed" | "cancelled" | "timeout";
  text?: string;
  error?: string;
}

export interface WorkerMeta {
  id: string;
  name?: string;
  runtime?: "pi" | "pig";
  state: WorkerState;
  cwd: string;            // directory the worker runs in (worktree or original)
  originCwd: string;      // directory the caller asked for
  worktree?: { path: string; branch: string; repo: string; baseRef: string; subdir: string };
  readOnly: boolean;
  provider?: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  systemPrompt?: string;
  timeoutMs: number;
  createdAt: number;
  updatedAt: number;
  piSessionFile?: string;
  turns: Turn[];
  toolCalls: number;
  filesTouched: string[];
  testRuns: { command: string; ok: boolean }[];
  usage?: TokenUsage;
  lastActivity?: string;
  lastError?: string;
  restarts: number;
  /** pid of the MCP server that owns this worker; other servers must not touch it while it is alive. */
  ownerPid?: number;
}

const madeDirs = new Set<string>();

/** State dir lives outside any Git repo. */
export function stateDir(): string {
  const base = process.env.PI_WORKERS_HOME ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "pi-workers");
  if (!madeDirs.has(base)) { mkdirSync(join(base, "workers"), { recursive: true }); madeDirs.add(base); }
  return base;
}

export function workerDir(id: string): string {
  const d = join(stateDir(), "workers", id);
  if (!madeDirs.has(d)) { mkdirSync(d, { recursive: true }); madeDirs.add(d); }
  return d;
}

export function saveMeta(meta: WorkerMeta) {
  meta.updatedAt = Date.now();
  const p = join(workerDir(meta.id), "meta.json");
  writeFileSync(p + ".tmp", JSON.stringify(meta, null, 2));
  renameSync(p + ".tmp", p);
}

export function loadMeta(id: string): WorkerMeta | undefined {
  try { return JSON.parse(readFileSync(join(stateDir(), "workers", id, "meta.json"), "utf8")); } catch { return undefined; }
}

export function loadAllMeta(): WorkerMeta[] {
  const root = join(stateDir(), "workers");
  const out: WorkerMeta[] = [];
  for (const id of readdirSync(root)) {
    const p = join(root, id, "meta.json");
    if (!existsSync(p)) continue;
    try { out.push(JSON.parse(readFileSync(p, "utf8"))); } catch {}
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

const LOG_CAP = 5 * 1024 * 1024;

/** Append a compact record to the worker's JSONL log, capped in size (rotates once). */
export function appendLog(id: string, rec: unknown) {
  const p = join(workerDir(id), "log.jsonl");
  try {
    if (existsSync(p) && statSync(p).size > LOG_CAP) renameSync(p, p + ".1");
    appendFileSync(p, JSON.stringify({ t: Date.now(), ...(rec as object) }) + "\n");
  } catch {}
}

export function readLogTail(id: string, maxRecords = 50): any[] {
  const p = join(workerDir(id), "log.jsonl");
  const read = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : []);
  let lines = read(p);
  if (lines.length < maxRecords) lines = [...read(p + ".1"), ...lines]; // just rotated
  return lines.slice(-maxRecords).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
}
