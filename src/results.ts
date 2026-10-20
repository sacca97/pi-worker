import type { Turn, WorkerMeta } from "./sessions.js";
import { worktreeDiff } from "./worktrees.js";

export interface StructuredResult {
  summary: string;
  findings: unknown[];
  filesModified: string[];
  testResults: { command: string; ok: boolean }[];
  errors: string[];
}

/** Workers are asked to finish with a fenced ```json block; fall back to prose. */
export function parseStructured(text: string | undefined): { summary?: string; findings?: unknown[] } {
  if (!text) return {};
  const start = text.lastIndexOf("```json");
  if (start < 0) return {};
  const body = text.slice(start + 7);
  const end = body.lastIndexOf("```"); // last fence, so code fences inside strings don't truncate the JSON
  if (end < 0) return {};
  try {
    const o = JSON.parse(body.slice(0, end));
    return { summary: typeof o.summary === "string" ? o.summary : undefined, findings: Array.isArray(o.findings) ? o.findings : undefined };
  } catch { return {}; }
}

export const RESULT_FORMAT_HINT =
  "When you finish, end your final message with a fenced ```json block of the form " +
  '{"summary": "<2-5 sentence summary>", "findings": [{"title": "...", "severity": "low|medium|high", "location": "file:line", "detail": "..."}]}. ' +
  "Omit findings if not applicable.";

export function lastTurn(meta: WorkerMeta): Turn | undefined {
  return meta.turns[meta.turns.length - 1];
}

export async function buildResult(meta: WorkerMeta, opts: { includeDiff?: boolean } = {}) {
  const turn = lastTurn(meta);
  const parsed = parseStructured(turn?.text);
  let filesModified = meta.filesTouched;
  let diff: { diff: string; truncated: boolean } | undefined;
  const finished = ["idle", "failed", "cancelled", "closed"].includes(meta.state);
  if (meta.worktree && finished) { // `git add -N` touches the index: never while the worker may be running git
    try {
      const d = await worktreeDiff(meta.worktree);
      filesModified = d.files;
      if (opts.includeDiff) diff = { diff: d.diff, truncated: d.truncated };
    } catch {}
  }
  const errors: string[] = [];
  if (turn?.error) errors.push(turn.error);
  if (meta.lastError && meta.lastError !== turn?.error) errors.push(meta.lastError);
  const result: StructuredResult = {
    summary: parsed.summary ?? (turn?.text ? turn.text.slice(0, 1500) : ""),
    findings: parsed.findings ?? [],
    filesModified,
    testResults: meta.testRuns,
    errors,
  };
  return { result, text: turn?.text ?? "", diff };
}
