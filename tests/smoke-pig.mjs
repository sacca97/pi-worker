import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const t = new StdioClientTransport({ command: "node", args: ["dist/src/mcp.js"], env: { ...process.env, PI_WORKERS_HOME: "/tmp/pi-workers-smoke" } });
const c = new Client({ name: "s", version: "0" }); await c.connect(t);
const call = async (n, a) => JSON.parse((await c.callTool({ name: n, arguments: a })).content[0].text);
const b = await call("agent_spawn_batch", { agents: [{ name: "pi", runtime: "pi", prompt: "test" }, { name: "pig", runtime: "pig", prompt: "test" }], defaults: { cwd: process.cwd() } });
const w = await call("agent_wait", { ids: b.workers.map((x) => x.id), timeoutMs: 120000 });
console.log(w.workers.map((x) => [x.name, x.runtime, x.state, x.model, x.error]));
await c.close();
