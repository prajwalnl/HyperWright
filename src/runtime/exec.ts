import { spawn, type SpawnOptions, type ChildProcess } from "node:child_process";
import { registry } from "./registry.js";
import { getRuntimeSignal } from "./context.js";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Options for run(). Extends Node's SpawnOptions with optional line-callbacks
 * that fire once per line of child stdout/stderr — intended to stream
 * long-running commands (npm install, npm run build) to the node's logger so
 * the web-ui log panel shows live progress instead of going silent for
 * minutes.
 */
export type RunOptions = SpawnOptions & {
  onStdout?: (line: string) => void;
  onStderr?: (line: string) => void;
};

/**
 * Run a command to completion. Captures stdout/stderr. Never throws; caller
 * inspects the exit code. If `onStdout` / `onStderr` are provided, they are
 * invoked once per complete line as the child writes it.
 *
 * Children are registered with the ProcessRegistry for the lifetime of the
 * call, so runner.stop() can SIGTERM any still-running ones (long-lived
 * `npm install` / `git clone` / `playwright test`).
 */
export async function run(
  cmd: string,
  args: string[],
  opts: RunOptions = {},
): Promise<ExecResult> {
  const { onStdout, onStderr, ...spawnOpts } = opts;
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      ...spawnOpts,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const trackedPid = child.pid;
    if (typeof trackedPid === "number") registry.trackRun(trackedPid);

    // Honor the workflow-scoped AbortSignal so Stop interrupts long-running
    // children (npm install, git clone, playwright test) instead of letting
    // them run to completion in the background. SIGTERM first; the registry
    // killAll() in stop() handles SIGKILL escalation for survivors.
    const signal = getRuntimeSignal();
    let onAbort: (() => void) | null = null;
    if (signal) {
      if (signal.aborted) {
        try { child.kill("SIGTERM"); } catch { /* race: already exited */ }
      } else {
        onAbort = () => {
          try { child.kill("SIGTERM"); } catch { /* already exited */ }
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }
    let stdout = "";
    let stderr = "";
    let outBuf = "";
    let errBuf = "";

    const flushLines = (
      chunk: string,
      buf: string,
      cb: ((l: string) => void) | undefined,
    ): string => {
      const combined = buf + chunk;
      const parts = combined.split("\n");
      const tail = parts.pop() ?? "";
      if (cb) {
        for (const line of parts) {
          if (line.length > 0) cb(line);
        }
      }
      return tail;
    };

    child.stdout?.on("data", (c) => {
      const chunk = String(c);
      stdout += chunk;
      outBuf = flushLines(chunk, outBuf, onStdout);
    });
    child.stderr?.on("data", (c) => {
      const chunk = String(c);
      stderr += chunk;
      errBuf = flushLines(chunk, errBuf, onStderr);
    });
    child.on("close", (code) => {
      if (typeof trackedPid === "number") registry.untrackRun(trackedPid);
      if (onAbort && signal) signal.removeEventListener("abort", onAbort);
      if (outBuf && onStdout) onStdout(outBuf);
      if (errBuf && onStderr) onStderr(errBuf);
      resolve({ code, stdout, stderr });
    });
    child.on("error", (e) => {
      if (typeof trackedPid === "number") registry.untrackRun(trackedPid);
      if (onAbort && signal) signal.removeEventListener("abort", onAbort);
      resolve({ code: 1, stdout, stderr: stderr + String(e) });
    });
  });
}

/**
 * Run a shell pipeline (e.g. `lsof -ti:9000 | xargs kill`). Safer than
 * spawn+shell for known constant commands.
 */
export async function sh(script: string, opts: RunOptions = {}): Promise<ExecResult> {
  return run("sh", ["-c", script], opts);
}

/**
 * Start a long-lived process in the background. Returns the child so the
 * caller can read pid / wire .on('error').
 *
 * The `detached: true` + caller's `.unref()` keeps the child alive after the
 * runner Node process exits. To make Stop able to clean it up, pass
 * `serverName` so it lands in the ProcessRegistry; runner.stop() then signals
 * the whole pgrp (`-shellPid`) and the entire subtree dies together —
 * crucial when the actual port listener is several levels deep
 * (sh → npm → node → workers).
 */
export function spawnBackground(
  cmd: string,
  args: string[],
  opts: SpawnOptions & { serverName?: string; port?: number | null } = {},
): ChildProcess {
  const { serverName, port, ...spawnOpts } = opts;
  const child = spawn(cmd, args, {
    stdio: "ignore",
    detached: true,
    ...spawnOpts,
  });
  if (serverName && typeof child.pid === "number") {
    registry.trackServer(serverName, {
      shellPid: child.pid,
      pgid: child.pid, // detached:true → child is its own pgrp leader
      port: port ?? null,
    });
    // If the caller-spawned process exits on its own (crash, normal exit),
    // make sure the registry forgets it so stop() doesn't try to signal a
    // dead pid (mostly harmless, but ESRCH spam is noise).
    child.once("exit", () => registry.untrackServer(serverName));
  }
  return child;
}

/**
 * Send a signal to a single pid. Best-effort; swallows ESRCH (already gone)
 * and other errors. For port cleanup and Stop-driven cleanup prefer:
 *   - `src/runtime/ports.ts` → `ensurePortFree(port)` (multi-pass + pgrp + verify)
 *   - `src/runtime/registry.ts` → `registry.killAll()` (owns full lifecycle)
 * This one-shot helper is only for callers that already know the pid and
 * just need to ask it to exit (e.g. finalize's "kill backend on cleanup").
 */
export async function killPid(pid: number, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  try {
    process.kill(pid, signal);
  } catch {
    // already gone
  }
}
