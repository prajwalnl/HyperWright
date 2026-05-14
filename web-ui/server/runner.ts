import { EventEmitter } from "node:events";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import { Command } from "@langchain/langgraph";
import { buildGraph, type CompiledQAGraph } from "../../src/graph.js";
import { readJson, writeJson } from "../../src/session/files.js";
import { logger } from "../../src/session/logger.js";
import type { QAStateType } from "../../src/state.js";
import type { TargetType, UserChoice } from "../../src/types.js";
import type { WorkflowEvent, WorkflowSnapshot } from "./types.js";
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
  private running = false;
  private awaitingChoice = false;
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

    // Do not resurrect running/awaitingChoice from disk. Those flags describe
    // a live in-process workflow; after a server restart no such workflow
    // exists (no graph, no abortController), and flipping them to true would
    // make /start throw 409 and /stop no-op forever.
    if (sessionData) {
      this.running = false;
      this.awaitingChoice = false;
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
      this.running = sessionData.status === "in_progress";
      this.awaitingChoice = sessionData.phase === "awaiting-user-choice";
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
    running: boolean;
    awaitingChoice: boolean;
    snapshot: WorkflowSnapshot | null;
    currentNodes: string[];
    nextNodes: string[];
    terminal: TerminalEvent | null;
    threadId: string | null;
  } {
    return {
      running: this.running,
      awaitingChoice: this.awaitingChoice,
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
    if (this.running) throw new Error("A workflow is already running");

    this.running = true;
    this.awaitingChoice = false;
    this.lastSnapshot = null;
    this.currentNodes = [];
    this.nextNodes = [];
    this.terminal = null;
    this.logsByNode.clear();
    const ac = new AbortController();
    this.abortController = ac;

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
        if (this.abortController === ac) this.abortController = null;
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
    if (!this.awaitingChoice) {
      throw new Error("Workflow is not awaiting a user choice");
    }
    this.awaitingChoice = false;
    this.terminal = null;
    this.running = true;
    const ac = new AbortController();
    this.abortController = ac;
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
        if (this.abortController === ac) this.abortController = null;
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
    const state = await this.graph.getState(config);
    const next = state.next as string[];
    const hasInterrupts = state.tasks.some((t) => t.interrupts.length > 0);

    if (next.includes("finalize") || hasInterrupts) {
      this.awaitingChoice = true;
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
    if (errorMsg.match(/abort/i)) {
      this.terminal = { type: "stopped" };
      this.publish({ type: "stopped" });
    } else {
      this.terminal = { type: "error", message: errorMsg };
      this.publish({ type: "error", message: errorMsg });
    }
    this.running = false;
    this.nextNodes = [];
  }

  stop(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  async clear(): Promise<void> {
    this.stop();
    // Wait for any in-flight start/resume to settle (it'll observe the abort
    // and exit). Without this await, a subsequent start() races with the old
    // run's teardown — the old run's handleStreamError fires AFTER the new
    // run is up and corrupts state. Cap at 5s so a wedged run can't hang the
    // server forever.
    if (this.inflight) {
      await Promise.race([
        this.inflight.catch(() => undefined),
        new Promise<void>((r) => setTimeout(r, 5000)),
      ]);
    }
    logger.cleanup();
    this.threadId = null;
    this.graph = null;
    this.lastSnapshot = null;
    this.currentNodes = [];
    this.nextNodes = [];
    this.terminal = null;
    this.logsByNode.clear();
    this.running = false;
    this.awaitingChoice = false;
    this.abortController = null;
    this.inflight = null;
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
    this.running = false;
    this.currentNodes = [];
    this.nextNodes = [];
    const status = this.lastSnapshot?.status ?? "complete";
    this.terminal = { type: "finished", status };
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
