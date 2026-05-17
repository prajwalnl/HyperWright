import { runPlanner } from "../agents/planner.js";
import { ENV } from "../env.js";
import { writeJson } from "../session/files.js";
import { loggerFor } from "../session/log.js";
import { sessionPaths } from "../session/paths.js";
import { respond } from "../session/respond.js";
import { writeSession } from "../session/sessionFile.js";
import type { QAStateType, QAStateUpdate } from "../state.js";

const PLANNER_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Orchestrator Step 3. Delegates to the playwright-planner agent, then writes
 * test-plan.json. Emits `planning` on entry and `planning-complete` on exit.
 */
export async function planTestsNode(
  state: QAStateType,
): Promise<QAStateUpdate> {
  const logs: string[] = [];
  const l = loggerFor("planTests", logs);

  const missing = !state.target
    ? "target"
    : !state.repo.repoPath
      ? "repo.repoPath (did setupContext run?)"
      : !state.sessionDir
        ? "sessionDir"
        : null;
  if (missing) {
    l(`failure: planTests invoked without ${missing}`);
    return respond(state, {
      phase: "failed",
      status: "failed",
      error: `planTests called without ${missing}`,
      logs,
    });
  }

  l(`target=${state.targetType}:${state.target} mode=${state.mode}`);
  await writeSession({ ...state, phase: "planning" } as QAStateType);

  // Cap the sub-agent so a hung browser/LLM doesn't pin the workflow. The
  // signal is combined with the workflow-wide Stop signal inside runSubAgent,
  // so either source aborts the in-flight call instead of running to completion.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PLANNER_TIMEOUT_MS);

  try {
    const plan = await runPlanner({
      sessionId: state.sessionId,
      mode: state.mode,
      target: state.target,
      targetType: state.targetType,
      sessionDir: state.sessionDir,
      pr: state.pr,
      creds: state.creds,
      repoPath: state.repo.repoPath,
      existingTestsDir: ENV.paths.existingTestsDir,
      pageObjectsDir: ENV.paths.pageObjectsDir,
      log: l,
      signal: ac.signal,
    });

    l(
      `plan: ${plan.scenarios.length} scenarios, source=${plan.source}, url=${plan.url}`,
    );
    if (plan.preconditions.apiHelpers.length > 0) {
      l(`apiHelpers: ${plan.preconditions.apiHelpers.join(", ")}`);
    }

    const paths = sessionPaths(state.sessionDir);
    await writeJson(paths.testPlan, plan);
    l(`wrote ${paths.testPlan}`);

    return respond(state, {
      testPlan: plan,
      metrics: { testsPlanned: plan.scenarios.length },
      phase: "planning-complete",
      phaseHistory: ["planning", "planning-complete"],
      logs,
    });
  } catch (err) {
    const e = err as Error;
    const msg = ac.signal.aborted
      ? `Planning timed out after ${PLANNER_TIMEOUT_MS / 60000}m`
      : e.message;
    l(`failure: ${msg}`);
    if (e.stack && !ac.signal.aborted) l(e.stack);
    return respond(state, {
      phase: "failed",
      status: "failed",
      error: `Planning failed: ${msg}`,
      logs,
    });
  } finally {
    clearTimeout(timer);
  }
}
