import fs from "node:fs/promises";
import { writeJson } from "../session/files.js";
import { loggerFor } from "../session/log.js";
import { sessionPaths } from "../session/paths.js";
import { respond } from "../session/respond.js";
import type { QAStateType, QAStateUpdate } from "../state.js";
import type { SummaryFile } from "../types.js";

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Orchestrator Step 6 Part B — writes summary.json + prints the TEST RUN
 * SUMMARY banner.
 */
export async function summaryNode(
  state: QAStateType,
): Promise<QAStateUpdate> {
  const m = state.metrics;
  const failed = state.status === "failed";
  const completedAt = new Date().toISOString();
  const duration = Date.parse(completedAt) - Date.parse(state.startedAt);
  const paths = sessionPaths(state.sessionDir);

  const logs: string[] = [];
  const l = loggerFor("summary", logs);
  l(`[summary] ========================================`);
  l(`[summary] NODE START: summary`);
  l(`[summary] Status: ${failed ? "FAILED" : "COMPLETE"}`);
  l(`[summary] Mode: ${state.mode}`);
  l(`[summary] Target: ${state.targetType}:${state.target}`);
  l(`[summary] Session ID: ${state.sessionId}`);
  l(`[summary] Duration: ${duration}ms`);
  l(`[summary] Metrics:`);
  l(`[summary]   Tests planned: ${m.testsPlanned}`);
  l(`[summary]   Tests generated: ${m.testsGenerated}`);
  l(`[summary]   Tests passed: ${m.testsPassed}`);
  l(`[summary]   Tests failed: ${m.testsFailed}`);
  l(`[summary]   Tests fixed: ${m.testsFixed}`);
  l(`[summary]   Healing attempts: ${m.healingAttempts}`);

  l(`[summary] Checking for output files...`);
  const testPlanExists = await exists(paths.testPlan);
  const runResultsExists = await exists(paths.runResults);
  const bugReportExists = await exists(paths.bugReport);
  l(`[summary]   Test plan: ${testPlanExists ? "exists" : "not found"}`);
  l(`[summary]   Run results: ${runResultsExists ? "exists" : "not found"}`);
  l(`[summary]   Bug report: ${bugReportExists ? "exists" : "not found"}`);

  const summary: SummaryFile = {
    sessionId: state.sessionId,
    mode: state.mode,
    request: state.rawInput,
    status: failed ? "failed" : "complete",
    duration,
    files: {
      testPlan: testPlanExists ? paths.testPlan : null,
      testFiles: state.generatedFiles,
      results: runResultsExists ? paths.runResults : null,
      summary: paths.summary,
      bugReport: bugReportExists ? paths.bugReport : null,
    },
    results: {
      testsPlanned: m.testsPlanned,
      testsGenerated: m.testsGenerated,
      testsPassed: m.testsPassed,
      testsFailed: m.testsFailed,
      testsFixed: m.testsFixed,
      skipped: state.runResults?.summary.skipped ?? 0,
    },
  };

  l(`[summary] Writing summary.json to: ${paths.summary}`);
  await writeJson(paths.summary, summary);
  l(`[summary] Summary file written`);

  const lines = [
    "╔══════════════════════════════════════════════╗",
    "║              TEST RUN SUMMARY                ║",
    "╚══════════════════════════════════════════════╝",
    `Mode            : ${state.mode}`,
    `Target          : ${state.targetType}:${state.target}`,
    `Session         : ${state.sessionId}`,
    `Duration        : ${duration}ms`,
    `Status          : ${failed ? "failed" : "complete"}`,
    `Tests planned   : ${m.testsPlanned}`,
    `Tests generated : ${m.testsGenerated}`,
    `Tests passed    : ${m.testsPassed}`,
    `Tests failed    : ${m.testsFailed}`,
    `Tests fixed     : ${m.testsFixed}`,
    `Heal attempts   : ${m.healingAttempts}`,
    `Session dir     : ${state.sessionDir}`,
    `Tests dir       : ${state.testsDir}`,
  ];
  if (failed && state.error) lines.push(`Error           : ${state.error}`);

  for (const line of lines) l(line);
  l(`[summary] NODE COMPLETE`);
  l(`[summary] ========================================`);

  return respond(state, {
    phase: failed ? "failed" : "complete",
    status: failed ? "failed" : "complete",
    completedAt,
    phaseHistory: [failed ? "failed" : "complete"],
    logs,
  });
}
