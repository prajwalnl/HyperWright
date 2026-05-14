import { spawn, type SpawnOptions, type ChildProcess } from "node:child_process";

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
      if (outBuf && onStdout) onStdout(outBuf);
      if (errBuf && onStderr) onStderr(errBuf);
      resolve({ code, stdout, stderr });
    });
    child.on("error", (e) =>
      resolve({ code: 1, stdout, stderr: stderr + String(e) }),
    );
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
 * Start a long-lived process in the background. Returns the PID so the caller
 * can kill it later. Streams stdout/stderr to the parent unless `detached`.
 */
export function spawnBackground(
  cmd: string,
  args: string[],
  opts: SpawnOptions = {},
): ChildProcess {
  return spawn(cmd, args, {
    stdio: "ignore",
    detached: true,
    ...opts,
  });
}

/**
 * Kill whatever process is bound to `port`. Discovery uses one `lsof` shell;
 * everything else uses `process.kill()` directly so the loop has no shell
 * spawn overhead and can't be wedged by a slow shell. The whole function has
 * a 7-second outer deadline — if processes are genuinely unkillable we give
 * up loudly instead of holding the graph hostage.
 *
 * Safe no-op if nothing is listening. Every step is reported via `log` so
 * the web-ui log panel shows which part is slow.
 */
export async function killByPort(
  port: number,
  log: (line: string) => void = () => {},
): Promise<void> {
  const overall = (async () => {
    log(`  killByPort(${port}) v2 — using process.kill, 7s outer cap`);
    log(`  lsof -ti:${port}`);
    let pids: number[] = [];
    try {
      const r = await withTimeout(
        sh(`lsof -ti:${port} || true`),
        2000,
        `lsof -ti:${port}`,
      );
      pids = r.stdout
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((s) => Number(s))
        .filter((n) => Number.isFinite(n) && n > 0);
    } catch (e) {
      log(`  lsof failed: ${(e as Error).message} — giving up kill`);
      return;
    }
    if (pids.length === 0) {
      log(`  no process on :${port}`);
      return;
    }
    log(`  found pid${pids.length > 1 ? "s" : ""} ${pids.join(", ")} — SIGTERM`);

    for (const pid of pids) {
      try {
        process.kill(pid, "SIGTERM");
        log(`  SIGTERM ${pid}: sent`);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ESRCH") {
          log(`  SIGTERM ${pid}: already gone`);
        } else if (code === "EPERM") {
          log(`  SIGTERM ${pid}: permission denied (process not owned by us)`);
        } else {
          log(`  SIGTERM ${pid}: ${code ?? (e as Error).message}`);
        }
      }
    }

    // Poll every 100ms for up to 1s for graceful exit. process.kill(pid, 0)
    // is a single syscall — no shell, no allocation.
    const deadline = Date.now() + 1000;
    let alive = pids;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      alive = pids.filter(isAlive);
      if (alive.length === 0) {
        log(`  all pids exited gracefully`);
        return;
      }
    }

    log(`  ${alive.length} pid${alive.length > 1 ? "s" : ""} still alive — SIGKILL`);
    for (const pid of alive) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone or permission denied — best-effort
      }
    }

    // Brief settle window so the OS can release the port before the caller
    // tries to bind it again. 200ms is plenty for the kernel to reap a
    // SIGKILLed process and tear down its sockets.
    await new Promise((r) => setTimeout(r, 200));
    const stillAlive = pids.filter(isAlive);
    if (stillAlive.length > 0) {
      log(
        `  WARNING: pid${stillAlive.length > 1 ? "s" : ""} ${stillAlive.join(", ")} survived SIGKILL — may need manual cleanup (\`kill -9 ${stillAlive.join(" ")}\`)`,
      );
    } else {
      log(`  SIGKILL successful`);
    }
  })();

  try {
    await withTimeout(overall, 7000, `killByPort(${port})`);
  } catch (e) {
    log(`  killByPort timed out: ${(e as Error).message} — moving on`);
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label} timed out after ${ms}ms`)),
        ms,
      ),
    ),
  ]);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists but we can't signal it; still "alive" from our
    // perspective so we don't loop forever waiting.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function killPid(pid: number, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  try {
    process.kill(pid, signal);
  } catch {
    // already gone
  }
}
