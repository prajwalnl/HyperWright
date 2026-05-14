import { randomUUID } from "node:crypto";
import { ensureDir } from "../session/files.js";
import { run } from "../runtime/exec.js";
import { loggerFor } from "../session/log.js";
import { respond } from "../session/respond.js";
import type { QAStateType, QAStateUpdate } from "../state.js";

const DEFAULT_REPO_URL = "https://github.com/juspay/hyperswitch-control-center.git";
const BRANCH_RE = /\bbranch[:\s]+(\S+)/i;
const BASE_CLONE_DIR = "/Users/prajwal.nl/hcc-tmp";

function extractBranch(raw: string): string | null {
  const match = raw.match(BRANCH_RE);
  return match ? match[1] : null;
}

function getCloneDir(sessionId: string): string {
  return `${BASE_CLONE_DIR}/hcc-${sessionId}`;
}

function getRepoPath(sessionId: string): string {
  return `${getCloneDir(sessionId)}/hyperswitch-control-center`;
}

export async function cloneRepoNode(
  state: QAStateType,
): Promise<QAStateUpdate> {
  const raw = state.rawInput.trim();
  const branch = extractBranch(raw);
  const sessionId = state.sessionId || randomUUID();
  const cloneDir = getCloneDir(sessionId);
  const repoPath = getRepoPath(sessionId);
  const logs: string[] = [];
  const l = loggerFor("cloneRepo", logs);

  l(`[clone] ========================================`);
  l(`[clone] NODE START: cloneRepo`);
  l(`[clone] Session ID: ${sessionId}`);
  l(`[clone] Repository URL: ${DEFAULT_REPO_URL}`);
  l(`[clone] Target directory: ${repoPath}`);
  l(`[clone] Clone directory: ${cloneDir}`);
  l(`[clone] Branch specified: ${branch ?? "none (will use default)"}`);
  l(`[clone] ----------------------------------------`);

  l(`[clone] Ensuring clone directory exists...`);
  await ensureDir(cloneDir);
  l(`[clone] Clone directory ready`);

  l(`[clone] Running git clone...`);
  const cloneResult = await run(
    "git",
    ["clone", "--depth", "1", DEFAULT_REPO_URL, repoPath],
    { cwd: cloneDir },
  );
  l(`[clone] Git clone exited with code: ${cloneResult.code}`);

  if (cloneResult.code !== 0) {
    return respond(state, {
      phase: "failed",
      status: "failed",
      error: `Clone failed: ${cloneResult.stderr}`,
      repo: { repoPath, repoCloned: false, repoBranch: null },
      phaseHistory: ["clone", "failed"],
      logs: [...logs, `[clone] FAILED: ${cloneResult.stderr}`],
    });
  }

  l(`[clone] Repository cloned to ${repoPath}`);

  if (branch) {
    l(`[clone] Checking out branch: ${branch}`);
    const checkoutResult = await run("git", ["checkout", branch], {
      cwd: repoPath,
    });

    if (checkoutResult.code !== 0) {
      return respond(state, {
        phase: "failed",
        status: "failed",
        error: `Checkout failed for branch '${branch}': ${checkoutResult.stderr}`,
        repo: { repoPath, repoCloned: true, repoBranch: null },
        phaseHistory: ["clone", "failed"],
        logs: [
          ...logs,
          `[clone] Branch checkout FAILED: ${checkoutResult.stderr}`,
        ],
      });
    }

    l(`[clone] Checked out branch: ${branch}`);
  }

  return respond(state, {
    phase: "clone",
    repo: {
      repoPath,
      repoCloned: true,
      repoBranch: branch,
    },
    phaseHistory: ["clone"],
    logs: [
      ...logs,
      branch
        ? `[clone] Complete: repo ready at ${repoPath} (branch: ${branch})`
        : `[clone] Complete: repo ready at ${repoPath} (main branch)`,
    ],
  });
}
