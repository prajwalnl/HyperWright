import type { QAStateType } from "./state.js";

/**
 * After setupContext (merged parseInput + cloneRepo):
 * fail fast, else fan out to both setup nodes in parallel.
 * LangGraph runs fan-out by returning an array of node names.
 */
export function afterSetupContext(state: QAStateType): string | string[] {
  if (state.status === "failed") return "summary";
  return ["setupBackend", "setupFrontend"];
}

/**
 * After setup join: fail fast, else plan tests.
 */
export function afterSetupJoin(state: QAStateType): string {
  if (state.status === "failed") return "summary";
  return "planTests";
}

/**
 * Mode-based branching: full mode generates before healing, heal-only jumps
 * straight to healing.
 */
export function afterPlan(state: QAStateType): string {
  if (state.status === "failed") return "summary";
  return state.mode === "full" ? "generateTests" : "healTests";
}

export function afterGenerate(state: QAStateType): string {
  if (state.status === "failed") return "summary";
  return "healTests";
}

/**
 * Healing loop control per _healer.md §5.7. Re-enter healTests only if ALL of:
 *   - attempts not exhausted
 *   - failures still present
 *   - last attempt actually applied fixes (else we'd just spin)
 * Otherwise move to the terminal `summary` node, which itself handles the
 * teardown + HITL + ship sequence.
 */
export function healRouter(state: QAStateType): string {
  if (state.status === "failed") return "summary";

  const attempts = state.metrics.healingAttempts;
  const failed = state.runResults?.summary.failed ?? 0;

  if (failed === 0) return "summary";
  if (attempts >= state.maxHealingAttempts) return "summary";
  if (state.lastAttemptFixes === 0) return "summary";

  return "healTests";
}
