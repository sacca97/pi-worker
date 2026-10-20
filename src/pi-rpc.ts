import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

export interface PiRpcOptions {
  command?: string;
  cwd: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
}

export interface RpcResponse {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: any;
  error?: string;
}

/**
 * Thin JSONL client over `pi --mode rpc`. Splits on LF only (never on
 * U+2028/2029) and correlates responses by id. Emits "event" for every
 * non-response record, "exit" when the child dies, and "stderr" for diagnostics.
 */
export class PiRpc extends EventEmitter {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<string, { resolve: (r: RpcResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private buf = "";
  private seq = 0;
  exited = false;
  closing = false;
  exitCode: number | null = null;
  exitSignal: NodeJS.Signals | null = null;

  constructor(opts: PiRpcOptions) {
    super();
    this.child = spawn(opts.command ?? "pi", ["--mode", "rpc", ...(opts.args ?? [])], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true, // own process group so we can kill the whole tree
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (s: string) => this.emit("stderr", s));
    this.child.stdin.on("error", () => {});
    this.child.on("error", (err) => this.onExit(null, null, err));
    this.child.on("exit", (code, sig) => {
      // stdout may still hold unread final events: wait for it to end (bounded; a grandchild can keep the pipe open).
      let done = false;
      const fin = () => { if (!done) { done = true; clearTimeout(t); this.onExit(code, sig); } };
      const t = setTimeout(fin, 500);
      if (this.child.stdout.readableEnded || this.child.stdout.destroyed) fin();
      else this.child.stdout.once("end", fin).once("close", fin);
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  private onExit(code: number | null, sig: NodeJS.Signals | null, err?: Error) {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    this.exitSignal = sig;
    const e = err ?? new Error(`pi exited (code=${code}, signal=${sig})`);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
    this.emit("exit", { code, signal: sig, error: err });
  }

  private onData(chunk: string) {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      let line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let rec: any;
      try {
        rec = JSON.parse(line);
      } catch {
        this.emit("stderr", `unparseable stdout: ${line.slice(0, 200)}`);
        continue;
      }
      if (rec.type === "response" && rec.id && this.pending.has(rec.id)) {
        const p = this.pending.get(rec.id)!;
        this.pending.delete(rec.id);
        clearTimeout(p.timer);
        p.resolve(rec);
      } else if (rec.type !== "response") {
        this.emit("event", rec);
      }
    }
  }

  send(cmd: Record<string, unknown>, timeoutMs = 60_000): Promise<RpcResponse> {
    if (this.exited) return Promise.reject(new Error("pi process has exited"));
    const id = `r${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`rpc timeout for ${String(cmd.type)}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ ...cmd, id }) + "\n");
    });
  }

  /** Send a command and throw if Pi reports failure. */
  async call(cmd: Record<string, unknown>, timeoutMs?: number): Promise<any> {
    const r = await this.send(cmd, timeoutMs);
    if (!r.success) throw new Error(r.error ?? `${String(cmd.type)} failed`);
    return r.data;
  }

  /** Orderly shutdown (close stdin), escalating to SIGTERM then SIGKILL on the process group. */
  async close(graceMs = 3000): Promise<void> {
    if (this.exited) return;
    this.closing = true;
    const done = new Promise<void>((res) => this.once("exit", () => res()));
    try { this.child.stdin.end(); } catch {}
    const t1 = setTimeout(() => this.killGroup("SIGTERM"), graceMs);
    const t2 = setTimeout(() => this.killGroup("SIGKILL"), graceMs * 2);
    await done;
    clearTimeout(t1);
    clearTimeout(t2);
  }

  /** Immediate kill of the process tree. */
  kill(sig: NodeJS.Signals = "SIGKILL") {
    this.killGroup(sig);
  }

  private killGroup(sig: NodeJS.Signals) {
    if (this.exited || !this.child.pid) return;
    try { process.kill(-this.child.pid, sig); } catch { try { this.child.kill(sig); } catch {} }
  }
}
