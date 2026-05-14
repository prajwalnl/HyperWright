import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchPullRequest } from "../runtime/gh.js";
import { ensureDir, writeJson } from "../session/files.js";
import { loggerFor } from "../session/log.js";
import { respond } from "../session/respond.js";
import { run, type RunOptions, type ExecResult } from "../runtime/exec.js";
import { detectMode, detectTarget, extractBranch } from "./inputParsing.js";
import type { QAStateType, QAStateUpdate } from "../state.js";
import type { InputContext, TargetType } from "../types.js";

const DEFAULT_REPO_URL = "https://github.com/juspay/hyperswitch-control-center.git";
const DEFAULT_REPO_SLUG = "juspay/hyperswitch-control-center";

// Resolve workspace root relative to this file (src/nodes/setupContext.ts -> ../../)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(__dirname, "../..");
const BASE_CLONE_DIR = path.join(WORKSPACE_ROOT, "hyperwright-wrkdir");

function getCloneDir(sessionId: string): string {
  return path.join(BASE_CLONE_DIR, `hcc-${sessionId}`);
}

function getRepoPath(sessionId: string): string {
  return path.join(getCloneDir(sessionId), "cloned-repo");
}

/**
 * Wrap `run()` in a hard timeout. If the child outlives `timeoutMs`, kill it
 * with SIGKILL and resolve with an error-shaped ExecResult so the caller can
 * report a real failure instead of waiting forever.
 */
async function runWithTimeout(
  cmd: string,
  args: string[],
  opts: RunOptions,
  timeoutMs: number,
): Promise<ExecResult> {
  let timer: NodeJS.Timeout | null = null;
  let timedOut = false;
  const work = run(cmd, args, opts);
  const guard = new Promise<ExecResult>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve({
        code: 124,
        stdout: "",
        stderr: `${cmd} timed out after ${Math.round(timeoutMs / 1000)}s`,
      });
    }, timeoutMs);
  });
  const result = await Promise.race([work, guard]);
  if (timer) clearTimeout(timer);
  if (timedOut) {
    // Best-effort: try to kill any lingering child by name. We don't track
    // the spawned PID in run(), so this is a coarse cleanup.
    void run("pkill", ["-9", "-f", `${cmd} clone`], {}).catch(() => undefined);
  }
  return result;
}

/**
 * Build the new-branch name for non-PR sessions.
 *   pw/<targetType>-<slugged-target>-<shortSessionId>
 * Slug is lowercased, alphanumerics + dashes only, capped to keep the full
 * branch name well under typical 250-char git ref limits.
 */
function buildSessionBranchName(
  targetType: TargetType,
  target: string,
  sessionId: string,
): string {
  const slug =
    target
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "session";
  const short = sessionId.replace(/-/g, "").slice(0, 8);
  return `pw/${targetType}-${slug}-${short}`;
}

/**
 * Unified Setup Context Node.
 *
 * Combines parseInput + cloneRepo functionality:
 * 1. Parses user input to detect mode and target
 * 2. Fetches PR metadata if target is a PR
 * 3. Clones the repository
 * 4. Checks out appropriate branch:
 *    - Explicit `branch: <name>` (with or without a PR): fetch then checkout.
 *      Works on the shallow clone and overrides the PR's default head.
 *    - PR target, no explicit branch: `gh pr checkout <number>`.
 *      - success → record the PR's real head branch (not a synthetic label)
 *      - failure (branch deleted / gh unavailable) → stay on main
 *    - Module / Scenario: stay on main
 * 5. Writes input-context.json for downstream nodes
 */
export async function setupContextNode(
  state: QAStateType,
): Promise<QAStateUpdate> {
  const logs: string[] = [];
  const l = loggerFor("setupContext", logs);

  l(`[setup] ========================================`);
  l(`[setup] NODE START: setupContext`);

  // --- Parse Input ---
  const raw = state.rawInput.trim();
  if (!raw) {
    l(`[setup] ERROR: rawInput is empty`);
    l(`[setup] empty input`);
    return respond(state, {
      phase: "failed",
      status: "failed",
      error: "rawInput is empty",
      phaseHistory: ["failed"],
      logs,
    });
  }

  l(`[setup] Raw input: "${raw.slice(0, 100)}${raw.length > 100 ? "..." : ""}"`);

  const mode = detectMode(raw);
  l(`[setup] Detected mode: ${mode}`);

  const explicitBranch = extractBranch(raw);
  if (explicitBranch) {
    l(`[setup] Explicit branch specified: ${explicitBranch}`);
  }

  const { target, targetType } = detectTarget(raw, explicitBranch);
  l(`[setup] Detected target: ${targetType}="${target}"`);

  const sessionId = state.sessionId || randomUUID();
  const startedAt = state.startedAt || new Date().toISOString();
  l(`[setup] Session ID: ${sessionId}`);
  l(`[setup] Started at: ${startedAt}`);

  // --- Fetch PR Info ---
  // For PR targets we require `gh pr view` to succeed. If it does not, the
  // PR number is invalid / in a different repo / gh is unauthed — either
  // way we cannot proceed with PR context, so fail fast before cloning.
  let pr = null;
  if (targetType === "pr") {
    l(`[setup] Fetching PR info for #${target} from ${DEFAULT_REPO_SLUG}...`);
    pr = await fetchPullRequest(target, { repo: DEFAULT_REPO_SLUG });
    if (pr) {
      l(`[setup] PR fetched: ${pr.title}`);
    } else {
      const errMsg = `Invalid or non-existent PR #${target}. Verify the PR number and that \`gh\` is installed and authenticated for the correct repo.`;
      l(`[setup] ERROR: ${errMsg}`);
      l(`[setup] Aborting: ${errMsg}`);
      l(`[setup] ========================================`);
      return respond(state, {
        phase: "failed",
        status: "failed",
        error: errMsg,
        sessionId,
        mode,
        target,
        targetType,
        pr: null,
        phaseHistory: ["failed"],
        logs,
      });
    }
  }

  // --- Clone Repository ---
  const cloneDir = getCloneDir(sessionId);
  const repoPath = getRepoPath(sessionId);

  l(`[setup] Clone directory: ${cloneDir}`);
  l(`[setup] Repository path: ${repoPath}`);

  l(`[setup] Ensuring clone directory exists...`);
  await ensureDir(cloneDir);
  l(`[setup] Clone directory ready`);

  l(`[setup] Running git clone (this typically takes 30–90s for a fresh clone)...`);
  const cloneResult = await runWithTimeout(
    "git",
    [
      // Force HTTP/1.1 — github + HTTP/2 + slow networks frequently produces
      // "RPC failed; curl 92 HTTP/2 stream … CANCEL" after 5–10 minutes of
      // partial transfer. HTTP/1.1 sidesteps it entirely.
      "-c",
      "http.version=HTTP/1.1",
      // Bigger upload buffer in case the pack is large.
      "-c",
      "http.postBuffer=524288000",
      // If transfer falls below 1 KB/s for 60s in a row, abort instead of
      // grinding silently for ten minutes.
      "-c",
      "http.lowSpeedLimit=1000",
      "-c",
      "http.lowSpeedTime=60",
      "clone",
      "--depth",
      "1",
      "--progress",
      "--no-tags",
      // Note: --single-branch is intentionally omitted so that gh pr checkout
      // can set up tracking for arbitrary PR branches. Shallow clone (--depth 1)
      // keeps it fast without sacrificing ability to checkout PRs.
      DEFAULT_REPO_URL,
      repoPath,
    ],
    {
      cwd: cloneDir,
      // Disable any interactive credential prompt — a public clone should
      // never need creds, and silently waiting for a prompt is the worst
      // failure mode. Better to fail loudly.
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "/usr/bin/false",
      },
      // Compact git progress: only log major milestones to reduce noise.
      // Git writes progress to stderr with lines like "Receiving objects: 42% (1234/2923)"
      onStderr: (line: string) => {
        // Only log completion milestones or important phases
        const milestoneMatch = line.match(/(remote: Counting objects|Receiving objects:\s*(100%|5)0%|Resolving deltas:\s*(100%|5)0%|Checking out files)/);
        if (milestoneMatch) {
          l(`[setup]   git: ${line.trim()}`);
        }
      },
    },
    600_000, // 10-minute hard cap; the lowSpeedLimit guard above usually
    //          trips first when the network is the problem.
  );
  l(`[setup] Git clone exited with code: ${cloneResult.code}`);
  if (cloneResult.code !== 0 && cloneResult.stderr) {
    // Surface the last few lines of stderr so the failure is debuggable
    // without forcing the user to dig through the per-node log file.
    const tail = cloneResult.stderr
      .replace(/\r/g, "\n")
      .split("\n")
      .filter((s) => s.trim().length > 0)
      .slice(-5);
    for (const line of tail) l(`[setup]   git stderr: ${line}`);
  }

  if (cloneResult.code !== 0) {
    l(`[setup] Clone FAILED: ${cloneResult.stderr}`);
    return respond(state, {
      phase: "failed",
      status: "failed",
      error: `Clone failed: ${cloneResult.stderr}`,
      sessionId,
      mode,
      target,
      targetType,
      pr,
      repo: { repoPath, repoCloned: false, repoBranch: null },
      phaseHistory: ["setup", "failed"],
      logs,
    });
  }

  l(`[setup] Repository cloned to ${repoPath}`);

  // After a shallow clone, reconfigure the remote to fetch all branches so
  // that gh pr checkout can set up tracking for arbitrary PR branches.
  l(`[setup] Configuring remote to fetch all branches...`);
  await run("git", ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"], { cwd: repoPath });
  l(`[setup] Remote configured`);

  // --- Branch Selection & Checkout ---
  //
  // Decision tree (matches the user-facing rule "default to main; if PR is
  // open check out its branch; otherwise create a new session branch"):
  //
  //   1. explicitBranch directive  → fetch + checkout, fail-fast.
  //                                  (user told us exactly which branch to
  //                                  use; silently inventing a different one
  //                                  would hide the typo.)
  //   2. targetType == "pr"        → try `gh pr checkout <num>`.
  //        - success   → stay on PR's head branch (open PR; isNewBranch=false)
  //        - failure   → fall through to (3) (merged + deleted, or gh unauth)
  //   3. fallthrough               → `git checkout -b pw/<...>` off main.
  //                                  (module / scenario / branch targetTypes,
  //                                  and PR-checkout fallthrough.)
  //
  // isNewBranch is set so finalize knows whether to push to an existing
  // remote branch (open PR — push appends commits to the PR) or open a new
  // PR via `gh pr create` (fresh `pw/...` branch).
  let checkedOutBranch: string | null = null;
  let isNewBranch = false;

  if (explicitBranch) {
    l(`[setup] Fetching explicit branch from origin: ${explicitBranch}`);
    const fetchResult = await run(
      "git",
      ["fetch", "--depth", "1", "origin", explicitBranch],
      { cwd: repoPath },
    );

    if (fetchResult.code !== 0) {
      l(`[setup] Branch fetch FAILED: ${fetchResult.stderr}`);
      return respond(state, {
        phase: "failed",
        status: "failed",
        error: `Fetch failed for branch '${explicitBranch}': ${fetchResult.stderr}`,
        sessionId,
        mode,
        target,
        targetType,
        pr,
        repo: { repoPath, repoCloned: true, repoBranch: null, isNewBranch: false },
        phaseHistory: ["setup", "failed"],
        logs,
      });
    }

    l(`[setup] Checking out explicit branch: ${explicitBranch}`);
    const checkoutResult = await run(
      "git",
      ["checkout", "-B", explicitBranch, `origin/${explicitBranch}`],
      { cwd: repoPath },
    );

    if (checkoutResult.code !== 0) {
      l(`[setup] Branch checkout FAILED: ${checkoutResult.stderr}`);
      return respond(state, {
        phase: "failed",
        status: "failed",
        error: `Checkout failed for branch '${explicitBranch}': ${checkoutResult.stderr}`,
        sessionId,
        mode,
        target,
        targetType,
        pr,
        repo: { repoPath, repoCloned: true, repoBranch: null, isNewBranch: false },
        phaseHistory: ["setup", "failed"],
        logs,
      });
    }

    checkedOutBranch = explicitBranch;
    isNewBranch = false;
    l(`[setup] Checked out explicit branch: ${explicitBranch}`);
  } else {
    // PR-open path is the only case where we keep an existing remote branch
    // without a user-supplied directive. Everything else (modules, scenarios,
    // branch targetType, and PR-checkout fallthrough) gets a fresh session
    // branch — finalize will then push that branch and open a new PR.
    let prCheckoutSucceeded = false;
    if (targetType === "pr") {
      l(`[setup] Attempting PR checkout for #${target}...`);
      const prCheckoutResult = await run(
        "gh",
        ["pr", "checkout", target],
        { cwd: repoPath },
      );

      if (prCheckoutResult.code === 0) {
        const headRef = await run(
          "git",
          ["rev-parse", "--abbrev-ref", "HEAD"],
          { cwd: repoPath },
        );
        checkedOutBranch =
          headRef.code === 0 && headRef.stdout.trim()
            ? headRef.stdout.trim()
            : `pr-${target}`;
        isNewBranch = false;
        prCheckoutSucceeded = true;
        l(`[setup] PR #${target} is open — checked out on branch: ${checkedOutBranch}`);
      } else {
        const errMsg = prCheckoutResult.stderr?.trim() || "(no error output)";
        l(
          `[setup] gh pr checkout failed for #${target}: ${errMsg}`,
        );
        l(`[setup] Falling back to a new session branch...`);
      }
    }

    if (!prCheckoutSucceeded) {
      const newBranch = buildSessionBranchName(targetType, target, sessionId);
      l(`[setup] Creating new session branch off main: ${newBranch}`);
      const branchResult = await run(
        "git",
        ["checkout", "-b", newBranch],
        { cwd: repoPath },
      );

      if (branchResult.code !== 0) {
        l(`[setup] Branch creation FAILED: ${branchResult.stderr}`);
        return respond(state, {
          phase: "failed",
          status: "failed",
          error: `Branch creation failed for '${newBranch}': ${branchResult.stderr}`,
          sessionId,
          mode,
          target,
          targetType,
          pr,
          repo: { repoPath, repoCloned: true, repoBranch: null, isNewBranch: false },
          phaseHistory: ["setup", "failed"],
          logs,
        });
      }

      checkedOutBranch = newBranch;
      isNewBranch = true;
      l(`[setup] Session branch created and checked out: ${newBranch}`);
    }
  }

  // --- Write Context File ---
  const ctx: InputContext = {
    rawInput: raw,
    mode,
    target,
    targetType,
    timestamp: startedAt,
    sessionId,
    pr,
  };

  const aiGenFlowDir = path.join(repoPath, ".ai-test-gen");
  const inputContextPath = path.join(aiGenFlowDir, "input-context.json");

  l(`[setup] Creating .ai-test-gen directory at: ${aiGenFlowDir}`);
  await ensureDir(aiGenFlowDir);

  l(`[setup] Writing input-context.json...`);
  await writeJson(inputContextPath, ctx);
  l(`[setup] Written: ${inputContextPath}`);

  l(`[setup] Complete: ${targetType}="${target}" on branch "${checkedOutBranch}"`);
  l(`[setup] NODE COMPLETE`);
  l(`[setup] ========================================`);

  return respond(state, {
    sessionId,
    mode,
    target,
    targetType,
    pr,
    phase: "setup",
    startedAt,
    sessionDir: aiGenFlowDir,
    testsDir: path.join(repoPath, "playwright-tests", "ai-generated"),
    repo: {
      repoPath,
      repoCloned: true,
      repoBranch: checkedOutBranch,
      isNewBranch,
    },
    phaseHistory: ["setup"],
    logs,
  });
}
