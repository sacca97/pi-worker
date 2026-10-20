# Pi Workers

An MCP server that supervises headless [Pi](https://pi.dev) agents (`pi --mode rpc`) so Claude Code or Codex can run many in parallel without blocking.

## Install
```bash
npm install && npm run build      # produces dist/src/mcp.js
```
**Claude Code:** `claude --plugin-dir /path/to/pi-workers` (manifest in `.claude-plugin/`, server in `.mcp.json`, skill in `skills/`).
**Codex:** add to `~/.codex/config.toml`:
```toml
[mcp_servers.pi-workers]
command = "node"
args = ["/path/to/pi-workers/dist/src/mcp.js"]
```

## Tools
`agent_spawn`, `agent_spawn_batch`, `agent_status`, `agent_wait`, `agent_result`, `agent_prompt`, `agent_cancel`, `agent_list`. Spawns return immediately with ids.

## Completion notifications
MCP can't push, so spawn results include a `notifyCommand` (`node dist/src/wait-cli.js <ids>`). Run it as a background shell command; it polls the persisted worker state and exits when the workers finish, which wakes the assistant. Flags: `--any`, `--timeout <sec>`.

## Behaviour
- Pool of `PI_WORKERS_MAX` (default 4) concurrent turns; extra workers queue.
- Read-only workers (default) share the tree with tools `read,grep,find,ls`; `readOnly:false` workers get a private git worktree (`agent_result` with `includeDiff`).
- Workers run on PiG (Pi in Go) by default; `runtime: "pi"` or `PI_WORKERS_DEFAULT_RUNTIME=pi` switches to Pi. Same protocol, separate `~/.pig` / `~/.pi` models. Binaries: `PI_WORKERS_PIG_COMMAND`, `PI_WORKERS_PI_COMMAND`.
- Worktree workers start from `HEAD`: uncommitted changes in the original tree are not visible to them.
- Per-worker provider/model/thinking; sessions persist and can be resumed with `agent_prompt`, even after a restart.
- Timeouts, rate-limit retry with backoff, one crash-recovery restart, process-group cleanup on cancel/shutdown.
- No recursion: workers run with `--no-mcp` and `PI_WORKERS_DEPTH`.
- Each worker records its owning server pid; a second server on the same state dir ignores workers whose owner is alive and only adopts (as failed/closed) those of dead servers.
- State + logs live in `~/.local/state/pi-workers` (override `PI_WORKERS_HOME`), outside any repo.

Default model: `opencode-go/deepseek-v4.1-flash` at `max` thinking (override per worker, or via `PI_WORKERS_DEFAULT_PROVIDER` / `_MODEL` / `_THINKING`; set them empty to use the runtime's own default).

Env: `PI_WORKERS_MAX`, `PI_WORKERS_TIMEOUT_MS`, `PI_WORKERS_PI_COMMAND`, `PI_WORKERS_PI_ARGS`, `PI_WORKERS_MAX_RESTARTS`, `PI_WORKERS_RATE_LIMIT_RETRIES`, `PI_WORKERS_ALLOW_RECURSION=1`.

## Tests
`npm test` (fake-Pi unit tests); `node tests/smoke.mjs` runs two real workers with the prompt "test"; `node tests/smoke-pig.mjs` runs one on Pi and one on PiG.
