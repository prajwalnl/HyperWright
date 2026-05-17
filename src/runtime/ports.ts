import { sh } from "./exec.js";

/**
 * Ensure nothing is bound to `port` before the caller tries to spawn a
 * server that needs it. Multi-pass to defeat respawn wrappers (nodemon,
 * concurrently, etc.) that re-create the listener after we kill it.
 *
 * Replaces the old `killByPort` which:
 *   - signalled a single pid (not the process group), missing siblings;
 *   - never re-checked the port, declaring "success" while it was still held.
 *
 * Per pass:
 *   1. `lsof -ti:port` → pids currently listening.
 *   2. for each pid, look up its pgid (`ps -o pgid=`).
 *   3. SIGTERM the group (or the pid as fallback when pgid lookup fails).
 *   4. settle 800 ms, re-check.
 *   5. if still bound, SIGKILL the group.
 *
 * After `maxPasses` we report `{ ok: false }` instead of silently proceeding.
 */
export async function ensurePortFree(
  port: number,
  opts: { maxPasses?: number; log?: (line: string) => void } = {},
): Promise<{ ok: boolean; passes: number }> {
  const maxPasses = opts.maxPasses ?? 3;
  const log = opts.log ?? (() => {});

  for (let pass = 1; pass <= maxPasses; pass++) {
    const pids = await listenersOnPort(port);
    if (pids.length === 0) {
      log(`  [ensurePortFree:${port}] free (pass ${pass})`);
      return { ok: true, passes: pass };
    }
    log(
      `  [ensurePortFree:${port}] pass ${pass}: pid(s) ${pids.join(",")} hold the port`,
    );

    for (const pid of pids) {
      const pgid = await getPgid(pid);
      signal(pid, pgid, "SIGTERM", log);
    }

    // Wrappers (nodemon / concurrently) typically respawn within ~500 ms.
    // 800 ms gives them time to respawn AND get re-bound, so the re-check
    // catches the new pid; without it pass-2 would race the bind() syscall.
    await sleep(800);

    const remaining = await listenersOnPort(port);
    if (remaining.length === 0) {
      log(`  [ensurePortFree:${port}] free after SIGTERM (pass ${pass})`);
      return { ok: true, passes: pass };
    }

    log(
      `  [ensurePortFree:${port}] pass ${pass} survivors: ${remaining.join(",")} — SIGKILL`,
    );
    for (const pid of remaining) {
      const pgid = await getPgid(pid);
      signal(pid, pgid, "SIGKILL", log);
    }
    await sleep(300);
  }

  const final = await listenersOnPort(port);
  if (final.length === 0) {
    return { ok: true, passes: maxPasses };
  }
  log(
    `  [ensurePortFree:${port}] FAILED after ${maxPasses} passes — still held by: ${final.join(",")}`,
  );
  return { ok: false, passes: maxPasses };
}

export async function listenersOnPort(port: number): Promise<number[]> {
  // `lsof` can wedge on certain pathological process states; 2 s ceiling so
  // we never block the workflow on a stuck system call.
  const result = await withTimeoutOrEmpty(
    sh(`lsof -ti:${port} || true`),
    2000,
  );
  return result
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n > 0);
}

async function getPgid(pid: number): Promise<number | null> {
  const r = await withTimeoutOrEmpty(
    sh(`ps -o pgid= -p ${pid} 2>/dev/null || true`),
    2000,
  );
  const n = parseInt(r.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function signal(
  pid: number,
  pgid: number | null,
  sig: NodeJS.Signals,
  log: (line: string) => void,
): void {
  // Prefer pgrp signalling so the entire subtree (sh → npm → node → workers)
  // dies together. If pgid lookup failed, fall back to the pid.
  const target = pgid ?? pid;
  const arg = pgid ? -pgid : pid;
  const label = `${sig} ${pgid ? `pgrp -${pgid}` : `pid ${pid}`}`;
  try {
    process.kill(arg, sig);
    log(`    ${label}: sent`);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      log(`    ${label}: already gone`);
    } else if (code === "EPERM") {
      log(`    ${label}: permission denied`);
    } else {
      log(`    ${label} (target=${target}): ${code ?? (e as Error).message}`);
    }
  }
}

async function withTimeoutOrEmpty(
  p: Promise<{ stdout: string }>,
  ms: number,
): Promise<string> {
  try {
    const result = await Promise.race([
      p,
      new Promise<{ stdout: string }>((_, rej) =>
        setTimeout(() => rej(new Error("timeout")), ms),
      ),
    ]);
    return result.stdout;
  } catch {
    return "";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
