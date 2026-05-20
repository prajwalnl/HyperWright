import fs from "node:fs/promises";
import { interrupt } from "@langchain/langgraph";
import { ENV } from "../env.js";
import { sh } from "../runtime/exec.js";
import { writeJson, writeText } from "../session/files.js";
import { loggerFor } from "../session/log.js";
import { sessionPaths } from "../session/paths.js";
import { respond } from "../session/respond.js";
import { writeSession } from "../session/sessionFile.js";
import type { QAStateType, QAStateUpdate } from "../state.js";
import type { SummaryFile, TargetType, UserChoice } from "../types.js";

/**
 * Single terminal node — collapses the prior `finalize` + `summary` split.
 *
 * Internal flow:
 *   1. REPORT       — flush bug-report.md from state, write summary.json,
 *                     print the TEST RUN SUMMARY banner.
 *   2. (status===failed?) skip HITL, return failed.
 *   3. AWAIT CHOICE — HITL interrupt with two options: create-pr | cancel.
 *                     Interrupt payload carries the test summary + a 10-line
 *                     bug-report preview so the user can decide informed.
 *   4. SHIP         — create-pr: format → stage → commit → push → gh pr create
 *                                 (PR body embeds bug-report.md when present).
 *                     cancel:    pure no-op (nothing committed, nothing deleted).
 *
 * Server teardown is intentionally NOT done here. Continuous-development
 * iteration (re-running with a refined input, adding another scenario) needs
 * servers to persist between runs so the user doesn't pay docker-up cost on
 * every cycle. The user triggers teardown explicitly via the "Stop Servers"
 * button in the HITL bar or the left sidebar (which both hit
 * `/api/workflow/stop-servers`). See `src/runtime/teardown.ts`.
 */
export async function summaryNode(
  state: QAStateType,
): Promise<QAStateUpdate> {
  const logs: string[] = [];
  const l = loggerFor("summary", logs);
  const paths = sessionPaths(state.sessionDir);
  const repoPath = state.repo.repoPath || process.cwd();

  l(`[summary] ========================================`);
  l(`[summary] NODE START: summary (report → HITL → ship)`);
  l(`[summary] Entry status: ${state.status}, phase: ${state.phase}`);

  // ---- Step 1/4: REPORT --------------------------------------------------
  const reportCompletedAt = new Date().toISOString();
  const duration =
    Date.parse(reportCompletedAt) - Date.parse(state.startedAt);

  await flushBugReport(state, paths, l);

  const testSummary = state.runResults?.summary ?? {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
  };
  const failedAtEntry = state.status === "failed";

  await writeSummaryJson(state, paths, duration, failedAtEntry, l);
  printBanner(state, duration, failedAtEntry, l);

  // ---- Step 2/4: SKIP HITL ON FAILURE ------------------------------------
  if (failedAtEntry) {
    l(`[summary] Entry status=failed — skipping HITL prompt`);
    l(`[summary] (servers stay up — user must stop them manually if desired)`);
    l(`[summary] NODE COMPLETE (failed path)`);
    l(`[summary] ========================================`);
    return respond(state, {
      phase: "failed",
      status: "failed",
      completedAt: reportCompletedAt,
      phaseHistory: ["failed"],
      logs,
    });
  }

  // ---- Step 3/4: AWAIT CHOICE --------------------------------------------
  await writeSession(
    { ...state, phase: "awaiting-user-choice" } as QAStateType,
    { phase: "awaiting-user-choice", message: "Awaiting user choice" },
  );

  const bugReportPreview = previewBugReport(state.bugReport);
  const choice = await awaitChoice(testSummary, bugReportPreview, l);

  await writeSession(
    { ...state, phase: "finalizing", userChoice: choice } as QAStateType,
    {
      phase: "finalizing",
      userChoice: choice,
      message: `Executing ${choice}`,
    },
  );

  // ---- Step 4/4: SHIP ----------------------------------------------------
  let shipError: string | null = null;
  if (choice === "create-pr") {
    try {
      await doCreatePR({
        repoPath,
        testsDir: `${repoPath}/${ENV.paths.generatedTestsDir}`,
        sessionId: state.sessionId,
        targetType: state.targetType,
        repoBranch: state.repo.repoBranch,
        isNewBranch: state.repo.isNewBranch,
        target: state.target,
        testSummary,
        bugReport: state.bugReport,
        l,
      });
    } catch (err) {
      shipError = (err as Error).message;
      l(`[summary] SHIP ERROR: ${shipError}`);
    }
  } else {
    l(`[summary] cancel — no-op (all artifacts preserved)`);
  }

  const finalStatus: "complete" | "failed" = shipError ? "failed" : "complete";
  const completedAt = new Date().toISOString();

  l(`[summary] NODE COMPLETE — final status: ${finalStatus}`);
  l(`[summary] ========================================`);

  return respond(state, {
    userChoice: choice,
    phase: finalStatus,
    status: finalStatus,
    error: shipError,
    completedAt,
    phaseHistory: ["awaiting-user-choice", "finalizing", finalStatus],
    logs,
  });
}

// ============================================================================
// HITL prompt
// ============================================================================

const CHOICE_ALIAS: Record<string, UserChoice> = {
  "1": "create-pr",
  "create": "create-pr",
  "create-pr": "create-pr",
  "commit-push": "create-pr",
  "commit-and-push": "create-pr",
  "2": "cancel",
  "cancel": "cancel",
  "no": "cancel",
  "cleanup": "cancel",
  "clean": "cancel",
};

const PROMPT =
  "Choose: [1|create-pr] commit + push generated tests (opens PR if new branch) · " +
  "[2|cancel] no-op (all artifacts preserved)";
const VALID_CHOICES = "1/create-pr or 2/cancel";

interface InterruptPayload {
  prompt: string;
  summary: TestSummary;
  bugReportPreview: string | null;
}

async function awaitChoice(
  summary: TestSummary,
  bugReportPreview: string | null,
  l: (line: string) => void,
): Promise<UserChoice> {
  let prompt = PROMPT;
  let choice: UserChoice | undefined;
  while (!choice) {
    l(`[summary] Interrupting for user choice: "${prompt}"`);
    const raw = interrupt<InterruptPayload, string>({
      prompt,
      summary,
      bugReportPreview,
    });
    const normalized = String(raw ?? "").toLowerCase().trim();
    choice = CHOICE_ALIAS[normalized];
    l(`[summary] Received: "${raw}" → ${choice ?? "INVALID"}`);
    if (!choice) {
      prompt = `Invalid choice "${String(raw)}". Reply with ${VALID_CHOICES}.`;
    }
  }
  return choice;
}

function previewBugReport(bugReport: string | null): string | null {
  if (!bugReport) return null;
  const lines = bugReport.split("\n").slice(0, 10);
  return lines.join("\n");
}

// ============================================================================
// Report (summary.json + bug-report.md flush + banner)
// ============================================================================

async function flushBugReport(
  state: QAStateType,
  paths: ReturnType<typeof sessionPaths>,
  l: (line: string) => void,
): Promise<void> {
  if (!state.bugReport) return;
  l(`[summary] Flushing bug-report.md → ${paths.bugReport}`);
  try {
    await writeText(paths.bugReport, state.bugReport);
  } catch (err) {
    l(`[summary] bug-report.md flush warning: ${(err as Error).message}`);
  }
}

async function writeSummaryJson(
  state: QAStateType,
  paths: ReturnType<typeof sessionPaths>,
  duration: number,
  failed: boolean,
  l: (line: string) => void,
): Promise<void> {
  const m = state.metrics;
  const testPlanExists = await exists(paths.testPlan);
  const runResultsExists = await exists(paths.runResults);
  const bugReportExists = state.bugReport != null || (await exists(paths.bugReport));

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
  l(`[summary] Writing summary.json → ${paths.summary}`);
  await writeJson(paths.summary, summary);
}

function printBanner(
  state: QAStateType,
  duration: number,
  failed: boolean,
  l: (line: string) => void,
): void {
  const m = state.metrics;
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
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Ship — create PR (format → stage → commit → push → gh pr create)
// ============================================================================

interface TestSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

interface CreatePROpts {
  repoPath: string;
  testsDir: string;
  sessionId: string;
  targetType: TargetType;
  repoBranch: string | null;
  isNewBranch: boolean;
  target: string;
  testSummary: TestSummary;
  bugReport: string | null;
  l: (line: string) => void;
}

// Branches we must never push generated tests directly to. setupContext is
// designed to never leave us here, but this is defense in depth.
const PROTECTED_BRANCHES = new Set(["main", "master", "develop", "trunk"]);

/**
 * Mirrors `qa-skills/raise-pr.md`: format → stage → conventional commit →
 * push → open PR. The repo's commitlint only accepts fix/feat/chore/refactor
 * subject prefixes — we commit with `chore:` and let the PR body carry the
 * AI-generated context.
 *
 * When `bugReport` is non-null, the PR body embeds it inline via a
 * collapsible <details> block. The "see bug-report.md from the session"
 * dangling reference is gone.
 *
 * Push target = the branch setupContext put us on (`repoBranch`). For an
 * open-PR target that's the PR's head; for module/scenario/merged-PR runs
 * it's a fresh `pw/...` branch — those need a new PR opened.
 *
 * Format and PR-creation are best-effort: if `prettier` isn't available or
 * `gh` isn't authenticated we log a warning and continue, so the user
 * still gets a pushed branch they can open a PR from manually.
 */
async function doCreatePR(opts: CreatePROpts): Promise<void> {
  const {
    repoPath,
    testsDir,
    sessionId,
    targetType,
    repoBranch,
    isNewBranch: setupCreatedBranch,
    target,
    testSummary,
    bugReport,
    l,
  } = opts;

  // Resolve push target. setupContext is the source of truth; this guard is
  // defensive in case it ever leaves us on a protected branch.
  let pushBranch = repoBranch ?? "";
  let isNewBranch = setupCreatedBranch;
  if (!pushBranch || PROTECTED_BRANCHES.has(pushBranch)) {
    const emergency = `playwright-tests/${sessionId.slice(0, 8)}`;
    l(
      `[summary] WARNING: setupContext left us on "${pushBranch || "(unset)"}" — creating emergency branch ${emergency}`,
    );
    // -B (capital) is idempotent: reuses or resets the branch instead of
    // failing if it already exists from a prior run.
    await execStep(`git checkout -B "${emergency}"`, repoPath, l);
    pushBranch = emergency;
    isNewBranch = true;
  }

  l(
    `[summary] Push target: ${pushBranch} (${isNewBranch ? "fresh session branch — will open PR" : "existing branch — will append to its PR"})`,
  );

  // [1/5] Format only the generated tests.
  l(`[summary] [1/5] Formatting generated tests...`);
  await execStepBestEffort(
    `npx --no-install prettier --write "${testsDir}" 2>&1 || true`,
    repoPath,
    l,
  );

  // [2/5] Stage only our testsDir.
  l(`[summary] [2/5] Staging generated tests...`);
  await execStep(`git add "${testsDir}"`, repoPath, l);

  // [3/5] Commit. If nothing is staged (e.g. the formatter touched only
  // unrelated files), skip cleanly instead of throwing on an empty commit.
  const diffCheck = await sh(`git diff --cached --quiet`, { cwd: repoPath });
  if (diffCheck.code === 0) {
    l(`[summary] [3/5] No staged changes — skipping commit/push/PR`);
    return;
  }
  const subject = buildCommitSubject(targetType, target);
  const body = buildCommitBody(testSummary, sessionId, bugReport);
  l(`[summary] [3/5] Committing: ${subject}`);
  await execStep(
    `git commit -m ${shellQuote(subject)} -m ${shellQuote(body)}`,
    repoPath,
    l,
  );

  // [4/5] Push.
  l(`[summary] [4/5] Pushing branch ${pushBranch}...`);
  await execStep(`git push -u origin "${pushBranch}"`, repoPath, l);

  // [5/5] Open a PR when we're on a fresh branch we created.
  if (isNewBranch) {
    l(`[summary] [5/5] Creating PR via gh...`);
    const prTitle = subject;
    const prBody = buildPrBody({
      targetType,
      target,
      sessionId,
      testSummary,
      bugReport,
    });

    // gh pr create refuses to run with a dirty working tree. Stash anything
    // the formatter touched outside testsDir, run gh, then pop.
    const stashTag = `hyperwright-${sessionId.slice(0, 8)}`;
    const stashResult = await sh(
      `git stash push --include-untracked --message ${shellQuote(stashTag)}`,
      { cwd: repoPath },
    );
    const didStash =
      stashResult.code === 0 &&
      !stashResult.stdout.includes("No local changes to save");
    if (didStash) {
      l(`[summary]   stashed untracked AI artifacts (will pop after gh)`);
    }

    await execStepBestEffort(
      `gh pr create --head ${shellQuote(pushBranch)} --base main --title ${shellQuote(prTitle)} --body ${shellQuote(prBody)}`,
      repoPath,
      l,
    );

    if (didStash) {
      await execStepBestEffort(`git stash pop --quiet`, repoPath, l);
    }
  } else {
    l(
      `[summary] [5/5] Skipping PR (commits appended to existing branch ${pushBranch})`,
    );
  }
}

function buildCommitSubject(targetType: TargetType, target: string): string {
  // commitlint accepts: fix / feat / chore / refactor. `chore:` is the
  // safest fit for AI-generated test additions.
  const slug = target ? `${targetType} ${target}` : targetType;
  return `chore: add Playwright tests for ${slug}`.slice(0, 72);
}

function buildCommitBody(
  summary: TestSummary,
  sessionId: string,
  bugReport: string | null,
): string {
  const lines = [
    "Auto-generated by HyperWright.",
    "",
    `Tests: ${summary.passed}/${summary.total} passing` +
      (summary.failed > 0 ? ` (${summary.failed} failing)` : ""),
    `Session: ${sessionId.slice(0, 8)}`,
  ];
  if (bugReport && summary.failed > 0) {
    lines.push(
      "",
      "Known issues — see PR body for the full bug report.",
    );
  }
  return lines.join("\n");
}

function buildPrBody(opts: {
  targetType: TargetType;
  target: string;
  sessionId: string;
  testSummary: TestSummary;
  bugReport: string | null;
}): string {
  const { targetType, target, sessionId, testSummary, bugReport } = opts;
  const slug = target ? `${targetType} ${target}` : targetType;
  const lines: string[] = [
    "## Type of Change",
    "- [x] New feature",
    "",
    "## Description",
    `AI-generated Playwright end-to-end tests for ${slug}, produced by`,
    `HyperWright (session \`${sessionId.slice(0, 8)}\`).`,
    "",
    `**Results:** ${testSummary.passed}/${testSummary.total} passing` +
      (testSummary.failed > 0 ? ` (${testSummary.failed} still failing)` : "") +
      ".",
    "",
    "## Motivation and Context",
    `Improving end-to-end test coverage for ${slug}.`,
    "",
    "## How did you test it?",
    "Tests were executed by the HyperWright pipeline before commit; results",
    "are summarised above.",
    "",
    "## Where to test it?",
    "- [x] INTEG",
    "",
    "## Checklist",
    "- [x] I reviewed submitted code",
  ];
  if (bugReport) {
    lines.push(
      "",
      `<details><summary>Bug report (${testSummary.failed} test${testSummary.failed === 1 ? "" : "s"} still failing)</summary>`,
      "",
      bugReport,
      "",
      "</details>",
    );
  }
  return lines.join("\n");
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function execStep(
  script: string,
  cwd: string,
  l: (line: string) => void,
): Promise<void> {
  l(`  $ ${script}`);
  const r = await sh(script, { cwd });
  if (r.code !== 0) {
    l(`    ✗ exit=${r.code} ${r.stderr.split("\n")[0] ?? ""}`);
    throw new Error(`${script} exited ${r.code}: ${r.stderr.slice(0, 500)}`);
  }
}

/**
 * Like execStep, but non-zero exit logs a warning and returns instead of
 * throwing. Use for steps where failure is recoverable (missing prettier,
 * unauthenticated gh).
 */
async function execStepBestEffort(
  script: string,
  cwd: string,
  l: (line: string) => void,
): Promise<void> {
  l(`  $ ${script}`);
  const r = await sh(script, { cwd });
  if (r.code !== 0) {
    const errLines = r.stderr
      .split("\n")
      .filter((line) => line.trim())
      .slice(0, 5);
    if (errLines.length === 0) {
      l(`    ⚠ exit=${r.code} (no stderr output) (continuing)`);
    } else {
      l(`    ⚠ exit=${r.code} (continuing) — stderr:`);
      for (const line of errLines) l(`        ${line}`);
    }
  }
}
