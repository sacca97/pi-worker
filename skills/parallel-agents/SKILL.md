---
name: parallel-agents
description: Delegate independent subtasks (reviews, analyses, parallel code changes) to background Pi workers via the pi-workers MCP tools, then consolidate their results.
---

# Parallel Pi agents

Use the `pi-workers` MCP tools (`agent_*`) when work splits into independent pieces.

1. **Spawn** with `agent_spawn_batch` (or `agent_spawn`). It returns ids immediately. Write self-contained prompts: workers can't see this conversation. Give each a `name`.
   - Analysis/review: default `readOnly: true` (shared tree, no write tools).
   - Code changes: `readOnly: false` → private git worktree; never let two workers edit the same tree.
   - Workers use PiG by default; `runtime: "pi"` uses Pi instead (separate models/credentials).
   - Pick `provider`/`model`/`thinking` per worker (cheap models for simple scans).
2. **Get notified.** Spawn results include a `notifyCommand`. Run it with Bash `run_in_background: true`; you're notified when the workers finish (add `--any` for the first one, `--timeout <sec>` to cap). Then call `agent_result`.
   **Keep working** on your own part while they run. Check `agent_status` for progress (tool activity, tokens).
3. **Collect** with `agent_wait` (`mode: "all"` or `"any"`, moderate `timeoutMs`; call again if `timedOut`), then `agent_result` per worker. Use `includeDiff` for worktree workers.
4. **Iterate** with `agent_prompt` — the worker keeps its context. Use `mode: "steer"` to redirect a running worker.
5. **Clean up** with `agent_cancel` (`terminate`, `cleanup` to drop a worktree). Workers cannot spawn workers.
6. **Consolidate**: de-duplicate findings, note disagreements, and report errors from failed workers.
