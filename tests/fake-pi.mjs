#!/usr/bin/env node
// Minimal fake of `pi --mode rpc`. Behaviour is chosen by the prompt text:
//  "crash" -> exit mid-run (first time only), "hang" -> never settle, "edit:<file>" -> write file in cwd, else echo.
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
let buf = "";
const crashMarker = join(process.cwd(), ".crashed");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
const res = (c, data) => out({ id: c.id, type: "response", command: c.type, success: true, data });
function handle(c) {
  if (c.type === "get_state") return res(c, { sessionFile: "/tmp/fake-session.jsonl", sessionId: "x" });
  if (c.type === "get_session_stats") return res(c, { tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 }, cost: 0.01 });
  if (c.type === "abort") { hung = false; return res(c); }
  if (c.type !== "prompt") return res(c);
  res(c, { disposition: "started" });
  const m = c.message;
  out({ type: "agent_start" });
  if (m.includes("hang")) { hung = true; return; }
  if (m.includes("crash") && !existsSync(crashMarker)) { writeFileSync(crashMarker, "1"); process.exit(3); }
  const e = m.match(/edit:(\S+)/);
  if (e) {
    out({ type: "tool_execution_start", toolCallId: "t1", toolName: "write", args: { path: e[1] } });
    writeFileSync(join(process.cwd(), e[1]), `by ${process.cwd()}\n`);
    out({ type: "tool_execution_end", toolCallId: "t1", toolName: "write", isError: false });
  }
  const text = m.includes("fail") ? "" : `echo: ${m}\n\`\`\`json\n{"summary":"ok","findings":[{"title":"f"}]}\n\`\`\``;
  const msg = { role: "assistant", content: [{ type: "text", text }], stopReason: m.includes("fail") ? "error" : "stop", errorMessage: "boom" };
  out({ type: "message_end", message: msg });
  out({ type: "agent_end", messages: [msg], willRetry: false });
  out({ type: "agent_settled" });
}
let hung = false;
