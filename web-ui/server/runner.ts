import { EventEmitter } from "node:events";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import { Command } from "@langchain/langgraph";
import { buildGraph, type CompiledQAGraph } from "../../src/graph.js";
import { readJson, writeJson } from "../../src/session/files.js";
import { logger } from "../../src/session/logger.js";
import { registry } from "../../src/runtime/registry.js";
import { setRuntimeSignal } from "../../src/runtime/context.js";
import type { QAStateType } from "../../src/state.js";
import type { TargetType, UserChoice } from "../../src/types.js";
import type { RunStatus, WorkflowEvent, WorkflowSnapshot } from "./types.js";
import { glob } from "node:fs/promises";

// Resolve workspace root for session discovery
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(__dirname, "../..");
const HYPERWRIGHT_WRKDIR = path.join(WORKSPACE_ROOT, "hyperwright-wrkdir");

/**
 * Compute the session directory path based on sessionId.
 * Sessions are stored in hyperwright-wrkdir/hcc-{sessionId}/cloned-repo/.ai-test-gen/
 */
function getSessionDir(sessionId: string): string {
  return path.join(HYPERWRIGHT_WRKDIR, `hcc-${sessionId}`, "cloned-repo", ".ai-test-gen");
}

type TerminalEvent =
  | { type: "finished"; status: WorkflowSnapshot["status"] }
  | { type: "stopped" }
  | { type: "error"; message: string };

class Runner extends EventEmitter {
  private graph: CompiledQAGraph | null = null;
  private threadId: string | null = null;
  private lastSnapshot: WorkflowSnapshot | null = null;
  private currentNodes: string[] = [];
  private nextNodes: string[] = [];
  private logsByNode = new Map<string, string[]>();
  /**
   * Single source of truth for the runner's lifecycle. `running` /
   * `awaitingChoice` in status() are derived from this. Mutated only by
   * setRunStatus() so transitions and broadcasts stay in lock-step.
   */
  private runStatus: RunStatus = "idle";
  private terminal: TerminalEvent | null = null;
  private abortController: AbortController | null = null;
  /**
   * Each invocation of start/resume captures `currentAC` at
   * its moment of dispatch. A stale handleStreamEnd/handleStreamError (an
   * older run completing AFTER the user reset + restarted) compares the AC
   * it captured against this one and bails if they differ — without this
   * guard the old completion overwrites the new run's running/terminal flags.
   */
  private inflight: Promise<void> | null = null;
  /**
   * Resolves once the in-flight stop() has finished cleanup. Reset and a
   * subsequent start() both await this so the window between "stop requested"
   * and "stop completed" is observable (state = stopping) instead of racing.
   */
  private stopInflight: Promise<void> | null = null;

  /**
   * Transition runStatus. Centralised so derived flags / events stay in sync
   * with the enum. Returns true if the state actually changed.
   */
  private setRunStatus(next: RunStatus): boolean {
    if (this.runStatus === next) return false;
    this.runStatus = next;
    return true;
  }

  constructor() {
    super();
    // Subscribe ONCE per Runner lifetime. Previously this lived in start(),
    // which meant every /api/workflow/start added another listener and a
    // single emit fanned out N-fold (user saw each log line 2×, 3×, 4×…
    // across successive runs).
    logger.on("log", ({ node, line }: { node: string; line: string }) => {
      const arr = this.logsByNode.get(node) ?? [];
      arr.push(line);
      this.logsByNode.set(node, arr);
      this.publish({ type: "log", node, line });
    });
    void this.loadLatestRun();
    // Defensive boot sweep: if a previous runner-Node process exited or
    // crashed while a backend/frontend was still running, the dev server is
    // still bound to its port. Kill anything recorded in the most-recent
    // session's servers.json before the next start() tries to take the port.
    void registry.sweepStaleFromDisk(HYPERWRIGHT_WRKDIR, (line) =>
      // eslint-disable-next-line no-console
      console.log(line),
    );
  }

  private getLogsPath(sessionId: string): string {
    return path.join(getSessionDir(sessionId), "web-ui-logs.json");
  }

  private async saveLogs(): Promise<void> {
    if (!this.threadId) return;
    const logsPath = this.getLogsPath(this.threadId);
    const logsObj = Object.fromEntries(this.logsByNode);
    await writeJson(logsPath, logsObj);
  }

  private async loadLatestRun(): Promise<void> {
    const sessions: Array<{ sessionId: string; mtime: Date }> = [];

    try {
      for await (const entry of glob("hcc-*/cloned-repo/.ai-test-gen/web-ui-logs.json", { cwd: HYPERWRIGHT_WRKDIR, withFileTypes: true })) {
        if (entry.isFile()) {
          const parts = entry.parentPath.split("/");
          const hccDir = parts.find((p) => p.startsWith("hcc-"));
          const sessionId = hccDir?.replace("hcc-", "") || "";
          const stats = await fs.stat(path.join(entry.parentPath, entry.name)).catch(() => null);
          if (stats && sessionId) {
            sessions.push({ sessionId, mtime: stats.mtime });
          }
        }
      }
    } catch {
      return;
    }

    if (sessions.length === 0) return;

    sessions.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    const latest = sessions[0];

    await this.loadRun(latest.sessionId);
  }

  private async loadRun(sessionId: string): Promise<void> {
    const logsPath = this.getLogsPath(sessionId);
    const logsData = await readJson<Record<string, string[]>>(logsPath);
    if (!logsData) return;

    const sessionPath = path.join(getSessionDir(sessionId), "session.json");
    const sessionData = await readJson<{ status: string; phase: string }>(sessionPath);

    this.threadId = sessionId;
    this.logsByNode = new Map(Object.entries(logsData));
    this.currentNodes = [];

    // Do not resurrect running/paused from disk. Those describe a live
    // in-process workflow; after a server restart no such workflow exists
    // (no graph, no abortController), and flipping runStatus to running
    // would make /start throw 409 and /stop no-op forever. Best we can
    // infer from disk is the terminal outcome.
    if (sessionData) {
      if (sessionData.status === "failed") {
        this.setRunStatus("failed");
      } else if (sessionData.status === "complete") {
        this.setRunStatus("complete");
      } else {
        // in_progress on disk + no live runner → treat as stopped.
        this.setRunStatus("stopped");
      }
    }
  }

  async listSessions(): Promise<Array<{ threadId: string; startedAt: string; status: string }>> {
    const sessions: Array<{ threadId: string; startedAt: string; status: string; mtime: Date }> = [];

    try {
      for await (const entry of glob("hcc-*/cloned-repo/.ai-test-gen/session.json", { cwd: HYPERWRIGHT_WRKDIR, withFileTypes: true })) {
        if (entry.isFile()) {
          const parts = entry.parentPath.split("/");
          const hccDir = parts.find((p) => p.startsWith("hcc-"));
          const sessionId = hccDir?.replace("hcc-", "") || "";
          const filePath = path.join(entry.parentPath, entry.name);
          const sessionData = await readJson<{ startedAt: string; status: string }>(filePath);
          const stats = await fs.stat(filePath).catch(() => null);
          if (sessionData && sessionId && stats) {
            sessions.push({
              threadId: sessionId,
              startedAt: sessionData.startedAt,
              status: sessionData.status,
              mtime: stats.mtime,
            });
          }
        }
      }
    } catch {
      return [];
    }

    sessions.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    return sessions.map(({ threadId, startedAt, status }) => ({ threadId, startedAt, status }));
  }

  async loadSession(sessionId: string): Promise<boolean> {
    const logsPath = this.getLogsPath(sessionId);
    const logsData = await readJson<Record<string, string[]>>(logsPath);
    if (!logsData) return false;

    this.threadId = sessionId;
    this.logsByNode = new Map(Object.entries(logsData));
    this.currentNodes = [];

    const sessionPath = path.join(getSessionDir(sessionId), "session.json");
    const sessionData = await readJson<{
      status: string;
      phase: string;
      rawInput: string;
      target: string;
      targetType: string;
      mode: string;
      startedAt: string;
      completedAt: string;
      servers: unknown;
      metrics: unknown;
      phaseHistory: string[];
      error: string | null;
      branch?: string | null;
    }>(sessionPath);

    if (sessionData) {
      // Same rule as loadRun(): never resurrect live flags from disk.
      // sessionData.status tells us the most we can claim is the terminal
      // outcome — anything "in_progress" really means "the previous run
      // didn't finish cleanly", which from this runner's perspective is
      // indistinguishable from `stopped`.
      if (sessionData.status === "failed") {
        this.setRunStatus("failed");
      } else if (sessionData.status === "complete") {
        this.setRunStatus("complete");
      } else {
        this.setRunStatus("stopped");
      }
      this.lastSnapshot = {
        sessionId,
        rawInput: sessionData.rawInput || "",
        target: sessionData.target || "",
        targetType: sessionData.targetType as TargetType,
        mode: sessionData.mode as "full" | "heal-only",
        status: sessionData.status as "in_progress" | "failed" | "complete",
        phase: sessionData.phase as QAStateType["phase"],
        phaseHistory: (sessionData.phaseHistory || []) as QAStateType["phaseHistory"],
        servers: sessionData.servers as QAStateType["servers"],
        // session.json only persists `branch` today — isNewBranch isn't
        // round-tripped because the awaitingChoice state itself isn't
        // restored across server restarts (per CLAUDE.md), so the HITL bar
        // never reads this on a reload. Default false is safe.
        repo: {
          repoPath: "",
          repoCloned: !!sessionData.branch,
          repoBranch: sessionData.branch ?? null,
          isNewBranch: false,
        },
        metrics: sessionData.metrics as QAStateType["metrics"],
        runResults: null,
        testPlan: null,
        generatedFiles: [],
        error: sessionData.error,
        userChoice: null,
        startedAt: sessionData.startedAt,
        completedAt: sessionData.completedAt || "",
        logs: [],
      };
    }

    return true;
  }

  status(): {
    runStatus: RunStatus;
    running: boolean;
    awaitingChoice: boolean;
    snapshot: WorkflowSnapshot | null;
    currentNodes: string[];
    nextNodes: string[];
    terminal: TerminalEvent | null;
    threadId: string | null;
  } {
    return {
      runStatus: this.runStatus,
      running: this.runStatus === "running",
      awaitingChoice: this.runStatus === "paused",
      snapshot: this.lastSnapshot,
      currentNodes: this.currentNodes,
      nextNodes: this.nextNodes,
      terminal: this.terminal,
      threadId: this.threadId,
    };
  }

  getNodeLogs(node: string): string[] {
    return this.logsByNode.get(node) ?? [];
  }

  async start(
    rawInput: string,
    targetType?: TargetType,
    maxHealingAttempts?: number,
  ): Promise<void> {
    // Wait out an in-flight stop so a quick stop→start sequence doesn't race.
    if (this.stopInflight) {
      await this.stopInflight.catch(() => undefined);
    }
    if (
      this.runStatus === "running" ||
      this.runStatus === "paused" ||
      this.runStatus === "stopping"
    ) {
      throw new Error(`A workflow is already ${this.runStatus}`);
    }

    this.setRunStatus("running");
    this.lastSnapshot = null;
    this.currentNodes = [];
    this.nextNodes = [];
    this.terminal = null;
    this.logsByNode.clear();
    const ac = new AbortController();
    this.abortController = ac;
    // Publish the signal so node-internal HTTP / LLM / child-process helpers
    // (`run`, `isReachable`, `runSubAgent`) can react to Stop without each
    // node having to thread the signal through its own arguments.
    setRuntimeSignal(ac.signal);

    const thread = randomUUID();
    this.threadId = thread;
    this.graph = buildGraph();
    const graph = this.graph;

    // sessionDir is computed by setupContext (inside cloned-repo/.ai-test-gen).
    // Logger is initialized lazily when consume() sees the first state update
    // that carries sessionDir.

    const init: Partial<QAStateType> = {
      rawInput,
      sessionId: thread,
      // sessionDir/testsDir will be set by setupContext
    };
    if (targetType) (init as Record<string, unknown>).targetType = targetType;
    if (typeof maxHealingAttempts === "number") {
      init.maxHealingAttempts = maxHealingAttempts;
    }

    const config = {
      configurable: { thread_id: thread },
      signal: ac.signal,
    };
    this.publish({ type: "started", thread });

    const work = (async () => {
      try {
        const stream = await graph.stream(init, {
          ...config,
          streamMode: "updates",
        });
        await this.consume(stream);
        await this.handleStreamEnd(config, ac);
      } catch (err) {
        this.handleStreamError(err, ac);
      } finally {
        if (this.abortController === ac) {
          this.abortController = null;
          setRuntimeSignal(null);
        }
      }
    })();
    this.inflight = work;
    try {
      await work;
    } finally {
      if (this.inflight === work) this.inflight = null;
    }
  }

  async resume(choice: UserChoice): Promise<void> {
    if (!this.graph || !this.threadId) {
      throw new Error("No workflow active");
    }
    if (this.runStatus !== "paused") {
      throw new Error(
        `Workflow is not awaiting a user choice (status: ${this.runStatus})`,
      );
    }
    this.terminal = null;
    this.setRunStatus("running");
    const ac = new AbortController();
    this.abortController = ac;
    setRuntimeSignal(ac.signal);
    const graph = this.graph;
    const config = {
      configurable: { thread_id: this.threadId },
      signal: ac.signal,
    };
    const work = (async () => {
      try {
        const stream = await graph.stream(
          new Command({ resume: choice }),
          { ...config, streamMode: "updates" },
        );
        await this.consume(stream);
        await this.handleStreamEnd(config, ac);
      } catch (err) {
        this.handleStreamError(err, ac);
      } finally {
        if (this.abortController === ac) {
          this.abortController = null;
          setRuntimeSignal(null);
        }
      }
    })();
    this.inflight = work;
    try {
      await work;
    } finally {
      if (this.inflight === work) this.inflight = null;
    }
  }

  /**
   * Inspect graph state after a stream ends. Two terminal-ish outcomes:
   *   1. Paused at finalize (HITL) → emit `awaiting_choice`
   *   2. Genuinely finished        → emit `finished`
   */
  private async handleStreamEnd(
    config: { configurable: { thread_id: string } },
    ownAc: AbortController,
  ): Promise<void> {
    // Stale completion (clear() was called and a new run is now in flight) —
    // bail without mutating any of the new run's state.
    if (this.abortController !== ownAc) return;
    if (!this.graph) return;
    // If stop() has already begun its transition to "stopping", do not
    // overwrite that with "paused"/"complete" — stop() owns the terminal
    // transition from here on.
    if (this.runStatus === "stopping" || this.runStatus === "stopped") return;
    const state = await this.graph.getState(config);
    const next = state.next as string[];
    const hasInterrupts = state.tasks.some((t) => t.interrupts.length > 0);

    if (next.includes("finalize") || hasInterrupts) {
      this.setRunStatus("paused");
      this.nextNodes = next;
      this.publish({ type: "awaiting_choice" });
      return;
    }
    this.finalise();
  }

  private handleStreamError(err: unknown, ownAc: AbortController): void {
    // Stale completion (clear() was called and a new run is now in flight) —
    // do not overwrite the new run's state with this old error.
    if (this.abortController !== ownAc) return;
    const errorMsg = (err as Error).message;
    // Aborts are always caused by stop(): let stop()'s own transition own the
    // terminal state. Real errors transition runStatus → failed here.
    if (errorMsg.match(/abort/i)) {
      // stop() is in flight (or already transitioned us). Nothing to do.
      this.nextNodes = [];
      return;
    }
    this.terminal = { type: "error", message: errorMsg };
    this.setRunStatus("failed");
    this.publish({ type: "error", message: errorMsg });
    this.nextNodes = [];
  }

  /**
   * Stop the workflow. Async because cleanup (graph abort + future child-
   * process kills in Phase 2) isn't instantaneous; callers can `await` to
   * know when "stopped" has actually been reached.
   *
   * Idempotent: noop in terminal/idle states. Concurrent stop() calls share
   * the same `stopInflight` promise.
   */
  stop(): Promise<void> {
    if (this.stopInflight) return this.stopInflight;
    if (
      this.runStatus === "idle" ||
      this.runStatus === "stopped" ||
      this.runStatus === "failed" ||
      this.runStatus === "complete"
    ) {
      return Promise.resolve();
    }
    const wasPaused = this.runStatus === "paused";
    this.setRunStatus("stopping");
    this.publish({ type: "stopping" });

    this.stopInflight = (async () => {
      try {
        if (this.abortController) {
          this.abortController.abort();
        }
        // If we were paused at HITL, the graph stream had already ended.
        // No inflight to await — fall through to the terminal transition.
        // Otherwise wait for the in-flight graph promise to settle so the
        // abort actually unwinds before we declare us stopped.
        if (!wasPaused && this.inflight) {
          await Promise.race([
            this.inflight.catch(() => undefined),
            new Promise<void>((r) => setTimeout(r, 5000)),
          ]);
        }
        // Kill every child process we own: long-lived servers (frontend/
        // backend) via their pgrp, and any in-flight run() children
        // (npm install / git clone / playwright test) by pid. Without this
        // step, Stop only stops "reading the graph"; the actual subprocesses
        // keep running and the next Start hits port-busy / lockfile-busy.
        //
        // Log lines go to console (server terminal) rather than the per-node
        // logger because the "system" bucket isn't a selectable node in the
        // graph; the user-facing signal for Stop is the runStatus transition
        // (live → stopping → stopped) reflected in the badge.
        await registry.killAll({
          // eslint-disable-next-line no-console
          log: (line) => console.log(line),
          gracefulMs: 2000,
        });
      } finally {
        this.currentNodes = [];
        this.nextNodes = [];
        this.terminal = { type: "stopped" };
        this.setRunStatus("stopped");
        this.publish({ type: "stopped" });
        this.stopInflight = null;
      }
    })();
    return this.stopInflight;
  }

  /**
   * Reset. Stops first if not already terminal, then wipes in-memory state
   * and emits a `reset` event so the client can clear its UI.
   */
  async clear(): Promise<void> {
    await this.stop();
    logger.cleanup();
    this.threadId = null;
    this.graph = null;
    this.lastSnapshot = null;
    this.currentNodes = [];
    this.nextNodes = [];
    this.terminal = null;
    this.logsByNode.clear();
    this.abortController = null;
    this.inflight = null;
    this.setRunStatus("idle");
    this.publish({ type: "reset" });
  }

  private async consume(stream: AsyncIterable<unknown>): Promise<void> {
    if (!this.graph || !this.threadId) return;
    const config = { configurable: { thread_id: this.threadId } };

    for await (const chunk of stream) {
      const entries = Object.entries(chunk as Record<string, unknown>);
      if (entries.length === 0) continue;

      const completedNodes = entries.map(([n]) => n);

      // Persist the in-memory log map. We deliberately DO NOT re-emit
      // update.logs into the live stream — every line a node logs via
      // `loggerFor` already went through logger.log() during execution
      // (file write + 'log' event + SSE). Re-emitting the patch's logs[]
      // produced double output for every line. Nodes that need to append a
      // line beyond what was emitted live should call the local `l(...)`
      // helper before returning, not splice into `logs` in the patch.
      await this.saveLogs();

      const snap = await this.graph.getState(config);
      const state = snap.values as QAStateType;
      this.lastSnapshot = toSnapshot(state);

      // Deferred logger initialization: setupContext computes sessionDir inside
      // the cloned repo; once it's available, initialize the logger so subsequent
      // logs are persisted to disk in the correct location.
      if (state.sessionDir) {
        logger.initialize(state.sessionDir);
        // Point the ProcessRegistry at the session so any tracked servers
        // (frontend/backend) get persisted to servers.json — the recovery
        // path on the next runner boot reads this.
        registry.setSessionDir(state.sessionDir);
      }

      const nextNodes = snap.next as string[];

      this.currentNodes = completedNodes;
      this.nextNodes = nextNodes;
      this.publish({
        type: "state",
        snapshot: this.lastSnapshot,
        currentNodes: completedNodes,
        nextNodes: nextNodes,
      });
    }
    this.currentNodes = [];
  }

  // appendLog removed: re-emitting patch logs caused a "node ran twice"
  // illusion in the UI for every node that used loggerFor — the dedup
  // against arr[arr.length - 1] only matched the very last line. Single
  // write path is now loggerFor → logger.log → SSE; consume() persists the
  // map via saveLogs() and does NOT re-emit anything.

  private finalise(): void {
    this.currentNodes = [];
    this.nextNodes = [];
    const status = this.lastSnapshot?.status ?? "complete";
    this.terminal = { type: "finished", status };
    this.setRunStatus(status === "failed" ? "failed" : "complete");
    this.publish({ type: "finished", status });
  }

  private publish(event: WorkflowEvent): void {
    super.emit("event", event);
  }

  subscribe(cb: (e: WorkflowEvent) => void): () => void {
    this.on("event", cb);
    return () => this.off("event", cb);
  }
}

function toSnapshot(state: QAStateType): WorkflowSnapshot {
  return {
    sessionId: state.sessionId,
    rawInput: state.rawInput,
    target: state.target,
    targetType: state.targetType,
    mode: state.mode,
    status: state.status,
    phase: state.phase,
    phaseHistory: state.phaseHistory,
    servers: state.servers,
    repo: state.repo,
    metrics: state.metrics,
    runResults: state.runResults,
    testPlan: state.testPlan,
    generatedFiles: state.generatedFiles,
    error: state.error,
    userChoice: state.userChoice,
    startedAt: state.startedAt,
    completedAt: state.completedAt,
    logs: state.logs,
  };
}

export const runner = new Runner();
