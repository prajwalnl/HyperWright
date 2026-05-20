import type {
  Metrics,
  Phase,
  RepoInfo,
  RunResults,
  Servers,
  Status,
  TargetType,
  TestPlan,
  UserChoice,
} from "../../src/types.js";

/**
 * Runner lifecycle (distinct from the workflow's overall `Status`).
 *
 *   idle      — no workflow loaded; only Start is meaningful
 *   running   — graph stream is actively producing
 *   paused    — graph hit a HITL interrupt; awaiting user choice
 *   stopping  — Stop received; abort + cleanup in flight
 *   stopped   — Stop completed; terminal until Reset
 *   failed    — graph errored; terminal until Reset
 *   complete  — graph finished successfully; terminal until Reset
 *
 * Start is rejected unless runStatus ∈ {idle, stopped, failed, complete}.
 * Reset is allowed from any state; if non-terminal it stops first.
 */
export type RunStatus =
  | "idle"
  | "running"
  | "paused"
  | "stopping"
  | "stopped"
  | "failed"
  | "complete";

/** One snapshot of the graph state, serialised for the client. */
export interface WorkflowSnapshot {
  sessionId: string;
  rawInput: string;
  target: string;
  targetType: TargetType;
  mode: "full" | "heal-only";
  status: Status;
  phase: Phase;
  phaseHistory: Phase[];
  servers: Servers;
  // setupContext's branch decision. The HITL bar uses `repo.isNewBranch`
  // to decide between "Commit + Push" (false → existing PR branch, push
  // appends commits) and "Create PR" (true → fresh `pw/...` branch needs
  // a new PR opened).
  repo: RepoInfo;
  metrics: Metrics;
  runResults: RunResults | null;
  testPlan: TestPlan | null;
  generatedFiles: string[];
  error: string | null;
  userChoice: UserChoice | null;
  startedAt: string;
  completedAt: string;
  logs: string[];
}

/**
 * Payload of the HITL `interrupt()` raised inside the summary node. Mirrors
 * the shape passed to `interrupt(...)` in src/nodes/summary.ts. Surfaced to
 * the client on the `awaiting_choice` event so the HITL bar can render the
 * prompt + a bug-report preview without round-tripping to the server.
 */
export interface InterruptPayload {
  prompt: string;
  summary: { total: number; passed: number; failed: number; skipped: number };
  bugReportPreview: string | null;
}

/** Any one event the server broadcasts over SSE. */
export type WorkflowEvent =
  | { type: "started"; thread: string }
  | { type: "state"; snapshot: WorkflowSnapshot; currentNodes: string[]; nextNodes: string[] }
  | { type: "log"; node: string; line: string }
  | { type: "awaiting_choice"; payload: InterruptPayload | null }
  /**
   * Emitted as soon as stop() begins, before kills/cleanup finish. UI shows a
   * "stopping…" spinner; Start stays disabled until `stopped` arrives.
   */
  | { type: "stopping" }
  | { type: "finished"; status: Status }
  | { type: "stopped" }
  | { type: "reset" }
  | { type: "error"; message: string };

export interface StartRequest {
  rawInput: string;
  targetType?: TargetType;
  /**
   * Optional per-run override for the heal loop cap. Defaults to 3 in
   * QAState. Server clamps to [1, 10] before threading into graph init.
   */
  maxHealingAttempts?: number;
}
