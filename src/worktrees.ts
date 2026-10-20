import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { workerDir } from "./sessions.js";

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

export async function repoRoot(cwd: string): Promise<string | null> {
  try { return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim(); } catch { return null; }
}

export interface Worktree { path: string; branch: string; repo: string; baseRef: string; /** cwd relative to the repo root, mirrored inside the worktree */ subdir: string }

// `git worktree add` takes repo-level locks; serialize per repo so batch spawns don't collide.
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (locks.get(key) ?? Promise.resolve()).then(fn, fn);
  locks.set(key, run.catch(() => {}));
  return run;
}

/** Create a detached-from-main-tree worktree under the state dir (outside the repo). */
export async function createWorktree(id: string, cwd: string): Promise<Worktree> {
  const repo = await repoRoot(cwd);
  if (!repo) throw new Error(`worktree isolation requires a git repository: ${cwd}`);
  const baseRef = (await git(repo, ["rev-parse", "HEAD"])).trim();
  const path = join(workerDir(id), "tree");
  const branch = `pi-workers/${id}`;
  await withLock(repo, () => git(repo, ["worktree", "add", "-b", branch, path, baseRef]));
  let subdir = "";
  try { subdir = relative(realpathSync(repo), realpathSync(cwd)); } catch {}
  if (subdir.startsWith("..") || !existsSync(join(path, subdir))) subdir = "";
  return { path, branch, repo, baseRef, subdir };
}

/** Returns true when the worktree is gone (and the branch deleted if requested). */
export async function removeWorktree(wt: Worktree, deleteBranch = false): Promise<boolean> {
  try {
    if (existsSync(wt.path)) await withLock(wt.repo, () => git(wt.repo, ["worktree", "remove", "--force", wt.path]));
  } catch { return false; }
  if (deleteBranch) { try { await withLock(wt.repo, () => git(wt.repo, ["branch", "-D", wt.branch])); } catch {} }
  return true;
}

/** Files changed and unified diff relative to the base commit, including untracked files. */
export async function worktreeDiff(wt: { path: string; baseRef: string }, maxBytes = 200_000) {
  await git(wt.path, ["add", "-N", "."]).catch(() => {});
  const files = (await git(wt.path, ["diff", "--name-only", wt.baseRef])).split("\n").filter(Boolean);
  let diff = await git(wt.path, ["diff", wt.baseRef]);
  const truncated = diff.length > maxBytes;
  if (truncated) diff = diff.slice(0, maxBytes) + "\n… diff truncated …";
  return { files, diff, truncated };
}
