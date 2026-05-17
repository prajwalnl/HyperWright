import { stat } from "node:fs/promises";
import { glob } from "node:fs/promises";
import path from "node:path";
import { readJson, writeJson } from "../session/files.js";

/**
 * A long-lived process we spawned via `spawnBackground` (typically a dev
 * server). The pgid is what we signal — pid is recorded so isAlive() works
 * after the kernel reaps the group leader.
 */
export interface ServerEntry {
  name: string;
  shellPid: number;
  pgid: number;
  port: number | null;
  startedAt: string;
}

interface ServersFile {
  servers: ServerEntry[];
}

/**
 * Central registry of every child process the runner owns.
 *
 * Two distinct buckets:
 *
 *   inflightRuns — short-lived `run()` children that should be SIGTERM'd if
 *     Stop arrives while they're executing (npm install, git clone,
 *     playwright test, …). These are NOT process-group leaders (run()
 *     doesn't detach), so we signal the pid directly.
 *
 *   servers     — long-lived `spawnBackground` children (frontend dev
 *     server, backend rust server, …). These ARE pgrp leaders because
 *     spawnBackground sets `detached:true`. We signal `-pgid` so the entire
 *     subtree (npm → node → workers / sh → cargo → server) goes together.
 *
 * Server entries also persist to `<sessionDir>/servers.json` so that a
 * runner-process restart can find and kill orphans from the previous
 * incarnation (sweepStaleFromDisk).
 */
class ProcessRegistry {
  private inflightRuns = new Set<number>();
  private servers = new Map<string, ServerEntry>();
  private sessionDir: string | null = null;
  private serversFile: string | null = null;

  /**
   * Called by the runner once setupContext has computed sessionDir. Triggers
   * a fresh persist so any servers already registered (none yet today, but
   * future-safe) appear on disk.
   */
  setSessionDir(dir: string): void {
    if (this.sessionDir === dir) return;
    this.sessionDir = dir;
    this.serversFile = path.join(dir, "servers.json");
    void this.persist();
  }

  trackRun(pid: number): void {
    if (Number.isFinite(pid) && pid > 0) this.inflightRuns.add(pid);
  }

  untrackRun(pid: number): void {
    this.inflightRuns.delete(pid);
  }

  trackServer(
    name: string,
    opts: { shellPid: number; pgid?: number; port?: number | null },
  ): void {
    if (!Number.isFinite(opts.shellPid) || opts.shellPid <= 0) return;
    // spawnBackground uses detached:true, which makes the child its own pgrp
    // leader → pgid == shellPid initially. Caller can override if they know
    // better (e.g. shell wraps an exec that changes pgrp).
    const pgid = opts.pgid ?? opts.shellPid;
    this.servers.set(name, {
      name,
      shellPid: opts.shellPid,
      pgid,
      port: opts.port ?? null,
      startedAt: new Date().toISOString(),
    });
    void this.persist();
  }

  untrackServer(name: string): void {
    if (this.servers.delete(name)) void this.persist();
  }

  getServers(): ServerEntry[] {
    return Array.from(this.servers.values());
  }

  getInflightRuns(): number[] {
    return Array.from(this.inflightRuns);
  }

  /**
   * Kill every tracked run() child + server. Two-phase: SIGTERM, wait
   * `gracefulMs` for natural exit, then SIGKILL anything still alive.
   *
   * Safe to call from stop(): we take a snapshot of the current pids before
   * any awaits so subsequent run() registrations (e.g. lsof helpers) aren't
   * accidentally killed.
   */
  async killAll(
    opts: { log?: (line: string) => void; gracefulMs?: number } = {},
  ): Promise<void> {
    const log = opts.log ?? (() => {});
    const gracefulMs = opts.gracefulMs ?? 2000;

    const runs = [...this.inflightRuns];
    const servers = [...this.servers.values()];

    if (runs.length === 0 && servers.length === 0) {
      log(`[registry] nothing tracked — no kill needed`);
      return;
    }

    log(
      `[registry] killing ${runs.length} run child(ren) + ${servers.length} server(s)`,
    );

    // Phase 1: SIGTERM. Servers go via pgrp (caught entire subtree); run
    // children go via pid (they share the runner's pgrp, so -pid would be
    // suicide).
    for (const pid of runs) {
      sendSignal(pid, "SIGTERM", "pid", log);
    }
    for (const srv of servers) {
      sendSignal(srv.pgid, "SIGTERM", "pgrp", log, srv.name);
    }

    // Wait for graceful exit.
    const deadline = Date.now() + gracefulMs;
    while (Date.now() < deadline) {
      await sleep(150);
      const stillAlive =
        runs.filter(isAlive).length +
        servers.filter((s) => isAlive(s.shellPid)).length;
      if (stillAlive === 0) {
        log(`[registry] all tracked processes exited gracefully`);
        this.inflightRuns.clear();
        this.servers.clear();
        void this.persist();
        return;
      }
    }

    // Phase 2: SIGKILL stragglers.
    for (const pid of runs) {
      if (isAlive(pid)) sendSignal(pid, "SIGKILL", "pid", log);
    }
    for (const srv of servers) {
      if (isAlive(srv.shellPid)) {
        sendSignal(srv.pgid, "SIGKILL", "pgrp", log, srv.name);
      }
    }

    // Brief settle so the OS can release ports before the next start() binds.
    await sleep(200);

    this.inflightRuns.clear();
    this.servers.clear();
    void this.persist();
  }

  /**
   * Defensive sweep for orphans from a previous runner-process incarnation.
   * Reads the most-recent hcc-{id}/.ai-test-gen/servers.json and
   * SIGTERM/SIGKILLs any pgids still alive. Called once on runner boot so
   * the user doesn't have to manually kill -9 after a server restart.
   */
  async sweepStaleFromDisk(
    workdir: string,
    log: (line: string) => void = () => {},
  ): Promise<void> {
    let latest: { mtime: number; data: ServersFile } | null = null;
    try {
      for await (const entry of glob(
        "hcc-*/.ai-test-gen/servers.json",
        { cwd: workdir, withFileTypes: true },
      )) {
        if (!entry.isFile()) continue;
        const full = path.join(entry.parentPath, entry.name);
        const stats = await stat(full).catch(() => null);
        if (!stats) continue;
        if (latest && stats.mtimeMs <= latest.mtime) continue;
        const data = await readJson<ServersFile>(full);
        if (data) latest = { mtime: stats.mtimeMs, data };
      }
    } catch {
      return;
    }

    if (!latest || latest.data.servers.length === 0) return;

    const alive = latest.data.servers.filter((s) => isAlive(s.shellPid));
    if (alive.length === 0) return;

    log(
      `[registry] sweeping ${alive.length} orphan(s) from previous session`,
    );
    for (const srv of alive) {
      sendSignal(srv.pgid, "SIGTERM", "pgrp", log, `stale:${srv.name}`);
    }
    await sleep(500);
    for (const srv of alive) {
      if (isAlive(srv.shellPid)) {
        sendSignal(srv.pgid, "SIGKILL", "pgrp", log, `stale:${srv.name}`);
      }
    }
  }

  private async persist(): Promise<void> {
    if (!this.serversFile) return;
    try {
      await writeJson(this.serversFile, {
        servers: Array.from(this.servers.values()),
      });
    } catch {
      /* best-effort; not having servers.json on disk only loses recovery */
    }
  }
}

function sendSignal(
  target: number,
  signal: NodeJS.Signals,
  mode: "pid" | "pgrp",
  log: (line: string) => void,
  name?: string,
): void {
  const arg = mode === "pgrp" ? -target : target;
  const label = `${signal} ${mode === "pgrp" ? `pgrp -${target}` : `pid ${target}`}${name ? ` (${name})` : ""}`;
  try {
    process.kill(arg, signal);
    log(`  ${label}: sent`);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      log(`  ${label}: already gone`);
    } else if (code === "EPERM") {
      log(`  ${label}: permission denied`);
    } else {
      log(`  ${label}: ${code ?? (e as Error).message}`);
    }
  }
}

function isAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const registry = new ProcessRegistry();
