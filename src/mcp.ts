#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { stateDir } from "./sessions.js";
import { WorkerManager, type SpawnOptions } from "./worker-manager.js";

const manager = new WorkerManager();
const server = new McpServer({ name: "pi-workers", version: "0.1.0" });

// Shell command that blocks until the given workers finish. Run it with run_in_background to be notified on completion.
const waitCli = join(dirname(fileURLToPath(import.meta.url)), "wait-cli.js");
const notifyCommand = (ids: string[]) =>
  `${process.env.PI_WORKERS_HOME ? `PI_WORKERS_HOME=${JSON.stringify(stateDir())} ` : ""}node ${JSON.stringify(waitCli)} ${ids.join(" ")}`;

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: `Error: ${(e as Error).message ?? e}` }] });
const wrap = <A>(fn: (a: A) => Promise<unknown> | unknown) => async (a: A) => { try { return ok(await fn(a)); } catch (e) { return fail(e); } };

const spawnShape = {
  prompt: z.string().describe("Task for the worker. Be self-contained: the worker has no access to your conversation."),
  name: z.string().optional().describe("Short label, e.g. 'security-review'"),
  cwd: z.string().optional().describe("Working directory (default: server cwd). Workers are confined to it by instruction."),
  runtime: z.enum(["pi", "pig"]).optional().describe("Agent binary: 'pig' (default, Pi in Go) or 'pi'. Each has its own configured providers/models; check `pig --list-models`."),
  provider: z.string().optional().describe("Pi provider, e.g. 'openai-codex', 'anthropic', or a local provider"),
  model: z.string().optional().describe("Pi model id or pattern; supports 'provider/id' and ':thinking' suffix"),
  thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  readOnly: z.boolean().optional().describe("Default true: analysis only, shares the original tree, tools limited to read/grep/find/ls. Set false for code-modifying workers (gets a private git worktree)."),
  isolation: z.enum(["worktree", "none"]).optional().describe("Override isolation. Default: 'none' for read-only, 'worktree' otherwise."),
  tools: z.array(z.string()).optional().describe("Explicit Pi tool allowlist (overrides the readOnly default)"),
  systemPrompt: z.string().optional().describe("Extra system prompt appended for this worker"),
  timeoutMs: z.number().int().positive().optional().describe("Per-turn timeout in ms (default 15 min)"),
};
const SpawnSchema = z.object(spawnShape);

server.registerTool("agent_spawn", {
  description: "Launch a background Pi agent. Returns immediately with a worker id and a `notifyCommand`: run it with Bash run_in_background to be notified when the worker finishes (then call agent_result). Or poll with agent_status or block with agent_wait. Do other work meanwhile.",
  inputSchema: spawnShape,
}, wrap(async (a: z.infer<typeof SpawnSchema>) => {
  const m = await manager.spawn(a as SpawnOptions);
  return { id: m.id, name: m.name, runtime: m.runtime, state: m.state, cwd: m.cwd, isolation: m.worktree ? "worktree" : "none", readOnly: m.readOnly, notifyCommand: notifyCommand([m.id]) };
}));

server.registerTool("agent_spawn_batch", {
  description: "Launch several Pi agents concurrently. Returns all ids immediately plus a `notifyCommand` (run it with Bash run_in_background to be notified when all finish); workers beyond the concurrency limit (default 4) queue.",
  inputSchema: { agents: z.array(SpawnSchema).min(1).max(32), defaults: SpawnSchema.partial().optional().describe("Fields applied to every agent unless overridden") },
}, wrap(async (a: { agents: z.infer<typeof SpawnSchema>[]; defaults?: Partial<z.infer<typeof SpawnSchema>> }) => {
  const out = await Promise.allSettled(a.agents.map((x) => manager.spawn({ ...a.defaults, ...x } as SpawnOptions)));
  const workers = out.map((r, i) => r.status === "fulfilled"
    ? { id: r.value.id, name: r.value.name, state: r.value.state, isolation: r.value.worktree ? "worktree" : "none" }
    : { name: a.agents[i].name, error: String((r.reason as Error).message) });
  const ids = out.flatMap((r) => (r.status === "fulfilled" ? [r.value.id] : []));
  return { workers, notifyCommand: ids.length ? notifyCommand(ids) : undefined };
}));

server.registerTool("agent_status", {
  description: "Progress of one or all workers: state, tool activity, recent events, token usage. Cheap; does not return full output.",
  inputSchema: { id: z.string().optional().describe("Worker id; omit for all workers") },
}, wrap(async (a: { id?: string }) => a.id ? manager.status(a.id) : manager.list().map((w) => manager.status(w.id))));

server.registerTool("agent_wait", {
  description: "Block until workers finish their current turn (mode 'all') or at least one does ('any'), or timeout. Returns statuses only; call agent_result for output. Keep timeouts moderate and call again to keep waiting.",
  inputSchema: {
    ids: z.array(z.string()).min(1),
    mode: z.enum(["all", "any"]).optional(),
    timeoutMs: z.number().int().positive().max(600_000).optional().describe("Default 60000"),
  },
}, wrap((a: { ids: string[]; mode?: "all" | "any"; timeoutMs?: number }) => manager.wait(a.ids, a.mode, a.timeoutMs)));

server.registerTool("agent_result", {
  description: "Final output of a worker's latest turn: structured summary/findings, modified files, test results, errors; optionally diff (worktree workers) and event log.",
  inputSchema: { id: z.string(), includeDiff: z.boolean().optional(), includeLog: z.boolean().optional() },
}, wrap((a: { id: string; includeDiff?: boolean; includeLog?: boolean }) => manager.result(a.id, a)));

server.registerTool("agent_prompt", {
  description: "Send a follow-up prompt to an existing worker; it keeps its conversation context (a stopped worker is resumed from its saved session). If the worker is running, use mode 'steer' or 'followUp'.",
  inputSchema: { id: z.string(), message: z.string(), mode: z.enum(["auto", "steer", "followUp"]).optional() },
}, wrap((a: { id: string; message: string; mode?: "auto" | "steer" | "followUp" }) => manager.prompt(a.id, a.message, a.mode)));

server.registerTool("agent_cancel", {
  description: "Abort a worker's current turn. With terminate=true also stop its Pi process; with cleanup=true also remove its git worktree (discarding unmerged changes).",
  inputSchema: { id: z.string(), terminate: z.boolean().optional(), cleanup: z.boolean().optional() },
}, wrap((a: { id: string; terminate?: boolean; cleanup?: boolean }) => manager.cancel(a.id, a)));

server.registerTool("agent_list", {
  description: "List all worker sessions (including ones persisted from earlier runs).",
  inputSchema: {},
}, wrap(async () => manager.list()));

await server.connect(new StdioServerTransport());

let closing = false;
const stop = async () => {
  if (closing) return;
  closing = true;
  const hard = setTimeout(() => { manager.killAllSync(); process.exit(1); }, 4000);
  await manager.shutdown().catch(() => {});
  clearTimeout(hard);
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.stdin.on("end", stop);   // parent closed our stdio
process.on("exit", () => manager.killAllSync());
