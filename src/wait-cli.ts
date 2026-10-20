#!/usr/bin/env node
// Blocks until workers finish their current turn, then prints a short report and exits.
// Meant to be run as a background shell command so the calling assistant is notified on exit.
//   wait-cli.js [--any] [--timeout <sec>] <worker-id>...
// Exit codes: 0 finished, 3 timed out, 2 usage / unknown id.
import { loadMeta, type WorkerMeta } from "./sessions.js";

const args = process.argv.slice(2);
let any = false;
let timeoutSec = 3600;
const ids: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--any") any = true;
  else if (args[i] === "--timeout") timeoutSec = Number(args[++i]);
  else ids.push(args[i]);
}
if (!ids.length || !Number.isFinite(timeoutSec)) {
  console.error("usage: wait-cli [--any] [--timeout <sec>] <worker-id>...");
  process.exit(2);
}

const TERMINAL = ["idle", "failed", "cancelled", "closed"];
const read = () => new Map(ids.flatMap((i) => { const m = loadMeta(i); return m ? [[i, m] as const] : []; }));
const line = (m: WorkerMeta) => {
  const t = m.turns[m.turns.length - 1];
  const text = (t?.text ?? "").replace(/```json[\s\S]*?```/g, "").trim().replace(/\s+/g, " ");
  return `${m.id}${m.name ? ` (${m.name})` : ""}: ${m.state}${t?.error ? ` — ${t.error}` : ""}${text ? `\n  ${text.slice(0, 300)}` : ""}`;
};

const start = Date.now();
for (;;) {
  const all = read();
  const missing = ids.filter((i) => !all.has(i));
  if (missing.length === ids.length || (missing.length && !any && Date.now() - start > 5000)) {
    console.error(`unknown worker(s): ${missing.join(", ")}`);
    process.exit(2);
  }
  const metas = ids.map((i) => all.get(i)).filter((m): m is WorkerMeta => !!m);
  const done = metas.filter((m) => TERMINAL.includes(m.state));
  const finished = any ? done.length > 0 : done.length === ids.length && missing.length === 0;
  if (finished) {
    console.log(`${done.length}/${ids.length} worker(s) finished. Call agent_result for full output.`);
    for (const m of metas) console.log(line(m));
    process.exit(0);
  }
  if (Date.now() - start > timeoutSec * 1000) {
    console.log(`timed out after ${timeoutSec}s; still running:`);
    for (const m of metas.filter((m) => !TERMINAL.includes(m.state))) console.log(line(m));
    process.exit(3);
  }
  await new Promise((r) => setTimeout(r, 1000));
}
