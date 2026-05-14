import { runPlanner } from "../agents/planner.js";
import { writeJson } from "../session/files.js";
import { createNodeLogger, loggerFor } from "../session/log.js";
import { sessionPaths } from "../session/paths.js";
import { respond } from "../session/respond.js";
import { writeSession } from "../session/sessionFile.js";
import type { QAStateType, QAStateUpdate } from "../state.js";

/**
 * Orchestrator Step 3. Delegates to the playwright-planner agent, then writes
 * test-plan.json. Emits `planning` on entry and `planning-complete` on exit.
 */
export async function planTestsNode(
  state: QAStateType,
): Promise<QAStateUpdate> {
  const logs: string[] = [];
  const l = loggerFor("planTests", logs);

  l(`[plan] ========================================`);
  l(`[plan] NODE START: planTests`);
  l(`[plan] Target: ${state.targetType}=${state.target}`);
  l(`[plan] Mode: ${state.mode}`);
  l(`[plan] Updating session phase to 'planning'...`);

  await writeSession({ ...state, phase: "planning" } as QAStateType);
  l(`[plan] Session phase updated`);

  try {
    l(`[plan] Calling planner agent...`);
    const plan = await runPlanner({
      sessionId: state.sessionId,
      mode: state.mode,
      target: state.target,
      targetType: state.targetType,
      sessionDir: state.sessionDir,
      pr: state.pr,
      creds: state.creds,
      log: createNodeLogger("planTests"),
    });

    l(`[plan] Planner returned ${plan.scenarios.length} scenarios`);
    l(`[plan] Source: ${plan.source}`);
    l(`[plan] URL: ${plan.url}`);
    l(`[plan] Preconditions: ${plan.preconditions.apiHelpers.join(",") || "(none)"}`);

    const paths = sessionPaths(state.sessionDir);
    l(`[plan] Writing test plan to: ${paths.testPlan}`);
    await writeJson(paths.testPlan, plan);
    l(`[plan] Test plan written successfully`);

    l(`[plan] NODE COMPLETE`);
    l(`[plan] ========================================`);

    l(`[plan] Summary: ${plan.scenarios.length} scenarios for ${plan.source}`);
    return respond(state, {
      testPlan: plan,
      metrics: { testsPlanned: plan.scenarios.length },
      phase: "planning-complete",
      phaseHistory: ["planning", "planning-complete"],
      logs,
    });
  } catch (err) {
    l(`[plan] ERROR: Planning failed - ${(err as Error).message}`);
    l(`[plan] ========================================`);
    l(`[plan] failure: ${(err as Error).message}`);
    return respond(state, {
      phase: "failed",
      status: "failed",
      error: `Planning failed: ${(err as Error).message}`,
      logs,
    });
  }
}
