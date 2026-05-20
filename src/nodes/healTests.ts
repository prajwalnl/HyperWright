import path from "node:path";
import fs from "node:fs/promises";
import { ENV } from "../env.js";
import { renderBugReport, runHealer } from "../agents/healer.js";
import { buildTestFileName } from "../config.js";
import { writeJson, writeText } from "../session/files.js";
import { createNodeLogger, loggerFor } from "../session/log.js";
import { sessionPaths } from "../session/paths.js";
import { respond } from "../session/respond.js";
import { writeSession } from "../session/sessionFile.js";
import type { QAStateType, QAStateUpdate } from "../state.js";

/**
 * Healer node — one attempt of the heal loop. The graph self-loops via
 * `healRouter` (capped at `state.maxHealingAttempts`, default 3).
 *
 * Per-attempt flow (matches _healer.md and the user-facing contract):
 *
 *   1. Run all tests.
 *   2. If no failures → exit (phase=healing-complete).
 *   3. Otherwise: explore the web app for failed scenarios, collect info,
 *      fix tests, re-run. (Delegated to `runHealer`, which owns the
 *      sub-agent + post-fix re-run within a single attempt.)
 *   4. If this is the last attempt and tests are still failing → write a
 *      bug report and let the graph continue to the terminal `summary` node.
 *   5. Persist run-results + metrics + session and return.
 */
export async function healTestsNode(
  state: QAStateType,
): Promise<QAStateUpdate> {
  const logs: string[] = [];
  const l = loggerFor("healTests", logs);
  const attempt = state.metrics.healingAttempts + 1;
  const maxAttempts = state.maxHealingAttempts;
  const paths = sessionPaths(state.sessionDir);
  const repoPath = state.repo.repoPath || process.cwd();
  const testsDir = `${repoPath}/${ENV.paths.generatedTestsDir}`;

  l(`[heal] ========================================`);
  l(`[heal] NODE START: healTests`);
  l(`[heal] Attempt: ${attempt}/${maxAttempts}`);

  const totalTests = Math.max(
    state.metrics.testsGenerated,
    state.testPlan?.scenarios.length ?? 0,
  );
  l(`[heal] Planned tests: ${totalTests}`);

  // Run AND edit the same set of files: this session's generated specs
  // (or, in heal-only mode where generation never ran, whatever specs are
  // discoverable in the dir). Keeping run-scope == edit-scope means stale
  // specs from prior sessions in `ai-generated/` aren't counted in metrics.
  const specFiles =
    state.generatedFiles.length > 0
      ? state.generatedFiles
      : await listSpecFiles(testsDir, state.targetType, state.target);
  l(`[heal] Tests dir: ${testsDir}`);
  l(`[heal] Spec files in scope: ${specFiles.length}`);
  for (const f of specFiles) l(`[heal]   - ${f}`);

  // Mark phase=healing in session.json before starting any work so the
  // web-ui canvas updates immediately.
  l(`[heal] Setting phase=healing in session.json`);
  await writeSession({ ...state, phase: "healing" } as QAStateType, {
    phase: "healing",
  });

  // Tracks whether the healer's sub-agent was actually engaged this
  // iteration. The candidate `attempt` counter only gets committed to
  // metrics if healing was needed — otherwise a green initial run would
  // wrongly bump healingAttempts to 1 ("tests passed first try" should
  // still report attempts=0).
  let initialFailed = 0;

  try {
    // ------------------------------------------------------------------
    // Steps 1 + 2 + 3 — runHealer runs the suite, exits early if green,
    // otherwise drives the sub-agent through explore→fix→re-run inside
    // this attempt. The graph self-loop drives subsequent attempts.
    // ------------------------------------------------------------------
    l(`[heal] Step 1: running all tests...`);
    const { results, fixesApplied } = await runHealer({
      attempt,
      maxAttempts,
      previousResults: state.runResults,
      totalTests,
      specFiles,
      sessionDir: state.sessionDir,
      creds: state.creds,
      priorFixes: state.runResults?.healing?.testsFixed ?? [],
      repoPath,
      log: createNodeLogger("healTests"),
      onInitialRun: async (initial) => {
        initialFailed = initial.summary.failed;
        // Persist pre-fix metrics so the UI shows progress mid-attempt.
        // testsPassed/Failed/HealingAttempts are last-write-wins in the
        // reducer, so this partial snapshot does not double-count later.
        l(
          `[heal] Initial run: passed=${initial.summary.passed} failed=${initial.summary.failed}`,
        );
        const healingNeeded = initialFailed > 0;
        await writeSession(
          {
            ...state,
            phase: "healing",
            metrics: {
              ...state.metrics,
              testsPassed: initial.summary.passed,
              testsFailed: initial.summary.failed,
              // Only commit the bump when failures exist — a clean initial
              // run means the healer didn't engage this iteration.
              ...(healingNeeded ? { healingAttempts: attempt } : {}),
            },
          } as QAStateType,
          { message: `attempt ${attempt}: pre-fix run` },
        );
        if (!healingNeeded) {
          l(`[heal] Step 2: no failures — skipping fix phase (no attempt counted)`);
        } else {
          l(
            `[heal] Step 3: ${initialFailed} failure(s) — exploring + fixing (attempt ${attempt})...`,
          );
        }
      },
    });

    l(`[heal] Healer returned:`);
    l(`[heal]   passed: ${results.summary.passed}`);
    l(`[heal]   failed: ${results.summary.failed}`);
    l(`[heal]   fixes applied (this attempt): ${fixesApplied}`);

    // ------------------------------------------------------------------
    // Step 4 — decide whether this is the terminal attempt.
    //   - allPass:    everything is green → done.
    //   - exhausted:  ran maxAttempts without going green → done, bug report.
    //   - stalled:    failures remain but no fixes were applied this round,
    //                 so re-running would just reproduce the same failures.
    // ------------------------------------------------------------------
    const allPass = results.summary.failed === 0;
    const exhausted = attempt >= maxAttempts;
    const stalled = !allPass && fixesApplied === 0;
    const terminal = allPass || exhausted || stalled;
    const nextPhase = terminal ? "healing-complete" : "healing";
    const totalFixes = state.metrics.testsFixed + fixesApplied;

    l(`[heal] all pass: ${allPass}`);
    l(`[heal] attempts exhausted: ${exhausted}`);
    l(`[heal] stalled (no fixes this attempt): ${stalled}`);
    l(`[heal] terminal: ${terminal} → next phase: ${nextPhase}`);
    l(`[heal] cumulative fixes: ${totalFixes}`);

    // Persist run-results.json on every attempt so partial progress is
    // observable from disk even if the next attempt crashes.
    l(`[heal] Writing run results → ${paths.runResults}`);
    await writeJson(paths.runResults, results);

    // ------------------------------------------------------------------
    // Step 5 — bug report only when the loop is terminating with failures
    // ("3 attempts finished and tests still failing — create a bug report
    // and continue"). Stalled counts as terminal too.
    // ------------------------------------------------------------------
    let bugReport: string | null = null;
    if (terminal && !allPass) {
      bugReport = renderBugReport(results, totalFixes);
      l(`[heal] Writing bug report → ${paths.bugReport}`);
      await writeText(paths.bugReport, bugReport);
    }

    l(`[heal] NODE COMPLETE`);
    l(`[heal] ========================================`);

    // Healer never owns testsPlanned / testsGenerated — those belong to
    // planTests and generateTests. We only emit the four fields we own,
    // and pass the full preserved metrics via sessionPatch so the
    // session.json snapshot doesn't lose planned/generated through
    // `respond`'s shallow `{ ...state, ...patch }` merge.
    //
    // healingAttempts only advances if the healer actually engaged this
    // iteration (i.e. the initial run had failures). A green-on-first-run
    // outcome leaves the counter at its prior value (typically 0).
    const healingHappened = initialFailed > 0;
    const newHealingAttempts = healingHappened
      ? attempt
      : state.metrics.healingAttempts;
    const ownedMetrics = {
      testsPassed: results.summary.passed,
      testsFailed: results.summary.failed,
      testsFixed: totalFixes,
      healingAttempts: newHealingAttempts,
    };
    return respond(
      state,
      {
        runResults: results,
        lastAttemptFixes: fixesApplied,
        ...(bugReport ? { bugReport } : {}),
        metrics: ownedMetrics,
        phase: nextPhase,
        phaseHistory: terminal ? ["healing", "healing-complete"] : ["healing"],
        logs,
      },
      { metrics: { ...state.metrics, ...ownedMetrics } },
    );
  } catch (err) {
    const msg = (err as Error).message;
    l(`[heal] ERROR: ${msg}`);
    l(`[heal] NODE FAILED (attempt ${attempt})`);
    l(`[heal] ========================================`);
    return respond(state, {
      phase: "failed",
      status: "failed",
      error: `Healing failed: ${msg}`,
      logs,
    });
  }
}

async function listSpecFiles(
  testsDir: string,
  targetType: QAStateType["targetType"],
  target: string,
): Promise<string[]> {
  try {
    const entries = await fs.readdir(testsDir, { withFileTypes: true });
    const out: string[] = [];
    for (const e of entries) {
      if (e.isFile() && /\.spec\.[tj]sx?$/.test(e.name)) {
        out.push(path.join(testsDir, e.name));
      }
    }
    if (out.length > 0) return out;
  } catch {
    /* fall through */
  }
  return [path.join(testsDir, buildTestFileName(targetType, target))];
}
