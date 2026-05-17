import { interrupt } from "@langchain/langgraph";
import { ENV } from "../env.js";
import { killPid, run, sh } from "../runtime/exec.js";
import { loggerFor } from "../session/log.js";
import { sessionPaths } from "../session/paths.js";
import { respond } from "../session/respond.js";
import { writeSession } from "../session/sessionFile.js";
import type { QAStateType, QAStateUpdate } from "../state.js";
import type { TargetType, UserChoice } from "../types.js";

const CHOICE_ALIAS: Record<string, UserChoice> = {
  "1": "commit-push",
  "commit-push": "commit-push",
  "commit-and-push": "commit-push",
  "2": "cleanup",
  cleanup: "cleanup",
  clean: "cleanup",
};

const PROMPT =
  "Choose: [1|commit-push] commit + push generated tests · " +
  "[2|cleanup] drop tests + delete clone";
const VALID_CHOICES = "1/commit-push or 2/cleanup";

/**
 * Combined HITL pause + execution. Replaces the prior split between
 * awaitUserChoice + cleanup + awaitNextInput. Both choices are terminal —
 * after this node, the graph runs `summary` and ends.
 *
 * Flow:
 *   1. interrupt() with the prompt; resume payload is the choice.
 *   2. On `commit-push`, push to `state.repo.repoBranch` — the branch
 *      setupContext put us on. Open PR target keeps us on its head;
 *      module/scenario/merged-PR runs got a fresh `pw/...` session branch.
 *      Open a new GitHub PR via `gh pr create` only when
 *      `state.repo.isNewBranch === true` (the UI relabels the button to
 *      "Create PR" in that case).
 *   3. On `cleanup`, rm the generated specs + per-run JSON artifacts. The
 *      cloned repo is intentionally preserved — re-runs can reuse it, and
 *      post-mortems still have the generated test files to read.
 *   4. Either way, stop the servers we started. We do NOT delete the
 *      cloned repo.
 */
export async function finalizeNode(
  state: QAStateType,
): Promise<QAStateUpdate> {
  const logs: string[] = [];
  const l = loggerFor("finalize", logs);
  l(`[finalize] ========================================`);
  l(`[finalize] NODE START: finalize`);

  const summary = state.runResults?.summary ?? {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
  };
  l(
    `[finalize] Test summary: ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped`,
  );

  // ---- HITL pause ---------------------------------------------------------
  await writeSession(
    { ...state, phase: "awaiting-user-choice" } as QAStateType,
    { message: "Waiting for user choice" },
  );

  let prompt = PROMPT;
  let choice: UserChoice | undefined;
  let raw: unknown;
  while (!choice) {
    l(`[finalize] Interrupting for user choice: "${prompt}"`);
    raw = interrupt<{ prompt: string; summary: typeof summary }, string>({
      prompt,
      summary,
    });
    const normalized = String(raw ?? "").toLowerCase().trim();
    choice = CHOICE_ALIAS[normalized];
    l(`[finalize] Received: "${raw}" → ${choice ?? "INVALID"}`);
    if (!choice) {
      prompt = `Invalid choice "${String(raw)}". Reply with ${VALID_CHOICES}.`;
    }
  }

  // ---- Execute ------------------------------------------------------------
  await writeSession({ ...state, phase: "finalizing" } as QAStateType, {
    message: `Executing ${choice}`,
  });

  const repoPath = state.repo.repoPath || process.cwd();
  const testsDir = `${repoPath}/${ENV.paths.generatedTestsDir}`;
  l(`[finalize] Choice: ${choice}`);
  l(`[finalize] Repo path: ${repoPath}`);
  l(`[finalize] Tests dir: ${testsDir}`);

  try {
    if (choice === "commit-push") {
      await doCommitPush({
        repoPath,
        testsDir,
        sessionId: state.sessionId,
        targetType: state.targetType,
        repoBranch: state.repo.repoBranch,
        isNewBranch: state.repo.isNewBranch,
        target: state.target,
        testSummary: summary,
        l,
      });
    } else {
      await doCleanup(testsDir, repoPath, state.sessionDir, l);
    }

    // Both terminal paths stop the servers we started. The cloned repo is
    // intentionally kept around — re-runs reuse it, post-mortems read its
    // generated files. session.json + logs/ in sessionDir are also kept so
    // the web-ui's history view survives.
    await stopServers(state, repoPath, l);

    l(`[finalize] NODE COMPLETE`);
    l(`[finalize] ========================================`);
    return respond(state, {
      userChoice: choice,
      phase: "finalizing",
      phaseHistory: ["awaiting-user-choice", "finalizing"],
      logs,
    });
  } catch (err) {
    const msg = (err as Error).message;
    l(`[finalize] ERROR: ${msg}`);
    l(`[finalize] ========================================`);
    return respond(state, {
      userChoice: choice,
      phase: "failed",
      status: "failed",
      error: `Finalize failed: ${msg}`,
      logs,
    });
  }
}

interface TestSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

interface CommitPushOpts {
  repoPath: string;
  testsDir: string;
  sessionId: string;
  targetType: TargetType;
  repoBranch: string | null;
  isNewBranch: boolean;
  target: string;
  testSummary: TestSummary;
  l: (line: string) => void;
}

/**
 * Mirrors `qa-skills/raise-pr.md`: format → stage → conventional commit →
 * push → open PR. The repo's commitlint only accepts fix/feat/chore/refactor
 * subject prefixes — using anything else (including `test:` with a scope)
 * trips the commit-msg hook and the push silently fails. We commit with
 * `chore:` and let the PR body carry the AI-generated context.
 *
 * Push target = the branch setupContext put us on (state.repo.repoBranch).
 * For an open PR that's the PR's head — the push appends commits to the
 * existing PR, no new PR needed. For module/scenario/merged-PR runs that's
 * a fresh `pw/...` branch (state.repo.isNewBranch === true) — we open a new
 * PR via `gh pr create`.
 *
 * Defense in depth: even if upstream invariants break, we refuse to push
 * to main/master/develop/trunk and bail with a fresh `playwright-tests/...`
 * branch instead.
 *
 * Format and PR-creation are best-effort: if `prettier` isn't available or
 * `gh` isn't authenticated we log a warning and continue, so the user
 * still gets a pushed branch they can open a PR from manually.
 */
async function doCommitPush(opts: CommitPushOpts): Promise<void> {
  const {
    repoPath,
    testsDir,
    sessionId,
    targetType,
    repoBranch,
    isNewBranch: setupCreatedBranch,
    target,
    testSummary,
    l,
  } = opts;

  // Resolve push target. setupContext is the source of truth — we just push
  // to whatever branch it left us on. The protected-branch guard is purely
  // defensive: in normal operation setupContext should never leave us on
  // main, but if it did (bug, or someone added a new code path) we'd rather
  // create an emergency branch than land tests on main.
  let pushBranch = repoBranch ?? "";
  let isNewBranch = setupCreatedBranch;
  if (!pushBranch || PROTECTED_BRANCHES.has(pushBranch)) {
    const emergency = `playwright-tests/${sessionId.slice(0, 8)}`;
    l(
      `[finalize] WARNING: setupContext left us on "${pushBranch || "(unset)"}" — creating emergency branch ${emergency}`,
    );
    await execStep(`git checkout -b "${emergency}"`, repoPath, l);
    pushBranch = emergency;
    isNewBranch = true;
  }

  l(
    `[finalize] Push target: ${pushBranch} (${isNewBranch ? "fresh session branch — will open PR" : "existing branch — will append to its PR"})`,
  );

  // [1/5] Format only the generated test files. Running the repo-wide
  // formatter (`npm run re:format`) could touch unrelated files we
  // don't intend to commit — keeping the scope tight avoids that.
  l(`[finalize] [1/5] Formatting generated tests...`);
  await execStepBestEffort(
    `npx --no-install prettier --write "${testsDir}" 2>&1 || true`,
    repoPath,
    l,
  );

  // [2/5] Stage only our testsDir. Anything formatter touched outside
  // testsDir is intentionally left unstaged.
  l(`[finalize] [2/5] Staging generated tests...`);
  await execStep(`git add "${testsDir}"`, repoPath, l);

  // [3/5] Commit with a conventional message the repo's commitlint
  // accepts. Body carries the run metadata so the subject stays short.
  const subject = buildCommitSubject(targetType, target);
  const body = buildCommitBody(testSummary, sessionId);
  l(`[finalize] [3/5] Committing: ${subject}`);
  await execStep(
    `git commit -m ${shellQuote(subject)} -m ${shellQuote(body)}`,
    repoPath,
    l,
  );

  // [4/5] Push.
  l(`[finalize] [4/5] Pushing branch ${pushBranch}...`);
  await execStep(`git push -u origin "${pushBranch}"`, repoPath, l);

  // [5/5] Open a PR via gh — only when we're on a fresh branch we created.
  // Pushing to an existing PR head appends commits to that PR; opening a
  // new one would be a no-op or worse, a duplicate.
  if (isNewBranch) {
    l(`[finalize] [5/5] Creating PR via gh...`);
    const prTitle = subject;
    const prBody = buildPrBody({ targetType, target, sessionId, testSummary });

    // gh pr create refuses to run with a dirty working tree: in non-TTY
    // mode it logs `Warning: N uncommitted change(s)` and exits 1 without
    // creating the PR. Session artifacts now live in the sibling
    // `.ai-test-gen/` (outside the repo), so the working tree should be
    // clean here in steady state — this stash/pop is defense-in-depth for
    // any other untracked file the build process may leave behind.
    //
    // Detection: `git stash push` exits 0 even when there's nothing to
    // stash, printing "No local changes to save" to stdout. We omit
    // --quiet so we can read that message and skip the pop accordingly.
    const stashTag = `hyperwright-${sessionId.slice(0, 8)}`;
    const stashResult = await sh(
      `git stash push --include-untracked --message ${shellQuote(stashTag)}`,
      { cwd: repoPath },
    );
    const didStash =
      stashResult.code === 0 &&
      !stashResult.stdout.includes("No local changes to save");
    if (didStash) {
      l(`[finalize]   stashed untracked AI artifacts (will pop after gh)`);
    }

    // --head pinned explicitly: gh's auto-detection ("infer head from
    // current branch's upstream") is fragile in our flow — even though
    // step [4/5] just pushed with `git push -u`, gh sometimes still bails
    // with "you must first push the current branch to a remote, or use
    // the --head flag". Passing --head removes the detection step entirely.
    await execStepBestEffort(
      `gh pr create --head ${shellQuote(pushBranch)} --base main --title ${shellQuote(prTitle)} --body ${shellQuote(prBody)}`,
      repoPath,
      l,
    );

    if (didStash) {
      await execStepBestEffort(`git stash pop --quiet`, repoPath, l);
    }
  } else {
    l(`[finalize] [5/5] Skipping PR (commits appended to existing branch ${pushBranch})`);
  }
}

/**
 * "Cleanup" choice: remove the run's generated artifacts but keep the
 * cloned repo intact. Specifically:
 *   - generated *.spec.ts files in the cloned repo
 *   - per-run JSON artifacts in sessionDir (test-plan, run-results, summary,
 *     bug report, input-context). session.json and logs/ are kept so the
 *     web-ui's history view still works.
 *
 * Best-effort throughout: every rm uses -f and missing-target failures are
 * logged but don't abort the node — there's nothing useful left for finalize
 * to do if a `rm` of an already-missing file fails.
 */
async function doCleanup(
  testsDir: string,
  repoPath: string,
  sessionDir: string,
  l: (line: string) => void,
): Promise<void> {
  l(`[finalize] Cleaning generated artifacts (cloned repo is preserved)`);

  // 1) Generated spec files.
  await execStepBestEffort(`rm -f "${testsDir}"/*.spec.ts`, repoPath, l);

  // 2) Per-run JSON artifacts in sessionDir. session.json + logs/ stay.
  const paths = sessionPaths(sessionDir);
  const perRunArtifacts = [
    paths.testPlan,
    paths.runResults,
    paths.summary,
    paths.bugReport,
    paths.inputContext,
  ];
  for (const f of perRunArtifacts) {
    await execStepBestEffort(`rm -f "${f}"`, sessionDir, l);
  }
}

// Branches we must never push generated tests directly to. setupContext is
// designed to never leave us here, but this is defense in depth for a code
// path that someday violates that invariant.
const PROTECTED_BRANCHES = new Set(["main", "master", "develop", "trunk"]);

function buildCommitSubject(targetType: TargetType, target: string): string {
  // raise-pr.md commitlint accepts: fix / feat / chore / refactor.
  // `chore:` is the safest fit for AI-generated test additions; using
  // `test:` (or any scope) is rejected by the repo's commit-msg hook.
  const slug = target ? `${targetType} ${target}` : targetType;
  return `chore: add Playwright tests for ${slug}`.slice(0, 72);
}

function buildCommitBody(summary: TestSummary, sessionId: string): string {
  const lines = [
    "Auto-generated by HyperWright.",
    "",
    `Tests: ${summary.passed}/${summary.total} passing` +
      (summary.failed > 0 ? ` (${summary.failed} failing)` : ""),
    `Session: ${sessionId.slice(0, 8)}`,
  ];
  return lines.join("\n");
}

function buildPrBody(opts: {
  targetType: TargetType;
  target: string;
  sessionId: string;
  testSummary: TestSummary;
}): string {
  const { targetType, target, sessionId, testSummary } = opts;
  const slug = target ? `${targetType} ${target}` : targetType;
  const failingNote =
    testSummary.failed > 0
      ? ` (${testSummary.failed} still failing — see bug-report.md from the session)`
      : "";
  return [
    "## Type of Change",
    "- [x] New feature",
    "",
    "## Description",
    `AI-generated Playwright end-to-end tests for ${slug}, produced by`,
    `HyperWright (session \`${sessionId.slice(0, 8)}\`).`,
    "",
    `**Results:** ${testSummary.passed}/${testSummary.total} passing${failingNote}.`,
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
  ].join("\n");
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function stopServers(
  state: QAStateType,
  repoPath: string,
  l: (line: string) => void,
): Promise<void> {
  if (state.servers.frontendWasStarted && state.servers.frontendPid != null) {
    l(`[finalize] Stopping frontend (PID: ${state.servers.frontendPid})...`);
    await killPid(state.servers.frontendPid, "SIGTERM");
    l(`[finalize] Frontend stopped`);
  }
  if (state.servers.backendWasStarted) {
    const backendCwd = `${repoPath}/${ENV.backend.stopCwd}`;
    l(`[finalize] Stopping backend at ${backendCwd}...`);
    await run("sh", ["-c", "docker compose down -v"], { cwd: backendCwd });
    l(`[finalize] Backend stopped`);
  }
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
 * Like execStep, but a non-zero exit logs a warning and returns instead of
 * throwing. Use for steps where failure is recoverable: missing prettier,
 * unauthenticated `gh`, etc. — we still want the run to land its commit.
 *
 * Logs up to the first 5 non-empty stderr lines so future debugging isn't
 * blind. Truncating to 1 line previously hid real causes (auth errors,
 * "PR already exists", etc.) behind a single misleading warning.
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
