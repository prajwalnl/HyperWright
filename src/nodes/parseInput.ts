import { randomUUID } from "node:crypto";
import path from "node:path";
import { fetchPullRequest } from "../runtime/gh.js";
import { ensureDir, writeJson } from "../session/files.js";
import { loggerFor } from "../session/log.js";
import { sessionPaths } from "../session/paths.js";
import { respond } from "../session/respond.js";
import type { QAStateType, QAStateUpdate } from "../state.js";
import type { InputContext, Mode, TargetType } from "../types.js";

const HEAL_KEYWORDS = [
  "fix failing",
  "fix test",
  "heal test",
  "heal failing",
  "heal only",
  "repair test",
];
const PR_RE = /#(\d+)/;

function detectMode(raw: string): Mode {
  const lower = raw.toLowerCase();
  return HEAL_KEYWORDS.some((k) => lower.includes(k)) ? "heal-only" : "full";
}

function detectTarget(raw: string): { target: string; targetType: TargetType } {
  const pr = raw.match(PR_RE);
  if (pr) return { target: pr[1], targetType: "pr" };
  const mod = raw.match(/\bmodule[:\s]+([a-z-]+)/i);
  if (mod) return { target: mod[1], targetType: "module" };
  return { target: raw.slice(0, 80), targetType: "scenario" };
}

/**
 * Orchestrator Step 1: Parse Input & Detect Mode.
 *
 * - Detects mode + target (PR / module / scenario).
 * - For PR targets, fetches title + body + diff via `gh` (non-fatal if gh
 *   isn't installed or the PR doesn't exist).
 * - Writes `input-context.json` and the initial `session.json`.
 */
export async function parseInputNode(
  state: QAStateType,
): Promise<QAStateUpdate> {
  const logs: string[] = [];
  const l = loggerFor("parseInput", logs);
  l(`[parse] ========================================`);
  l(`[parse] NODE START: parseInput`);

  const raw = state.rawInput.trim();
  if (!raw) {
    l(`[parse] ERROR: rawInput is empty`);
    return respond(state, {
      phase: "failed",
      status: "failed",
      error: "rawInput is empty",
      phaseHistory: ["failed"],
      logs: [...logs, "[parse] empty input"],
    });
  }

  l(`[parse] Raw input: "${raw.slice(0, 100)}${raw.length > 100 ? "..." : ""}"`);

  l(`[parse] Detecting mode...`);
  const mode = detectMode(raw);
  l(`[parse] Detected mode: ${mode}`);

  l(`[parse] Detecting target...`);
  const { target, targetType } = detectTarget(raw);
  l(`[parse] Detected target: ${targetType}="${target}"`);

  const sessionId = state.sessionId || randomUUID();
  const startedAt = state.startedAt || new Date().toISOString();
  l(`[parse] Session ID: ${sessionId}`);
  l(`[parse] Started at: ${startedAt}`);

  if (targetType === "pr") {
    l(`[parse] Fetching PR info for #${target}...`);
  }
  const pr = targetType === "pr" ? await fetchPullRequest(target) : null;
  if (pr) {
    l(`[parse] PR fetched: ${pr.title}`);
  } else if (targetType === "pr") {
    l(`[parse] PR fetch returned null (may not exist or gh not available)`);
  }

  const ctx: InputContext = {
    rawInput: raw,
    mode,
    target,
    targetType,
    timestamp: startedAt,
    sessionId,
    pr,
  };

  const repoPath = state.repo.repoPath || process.cwd();
  const aiGenFlowDir = path.join(repoPath, ".ai-test-gen");
  const inputContextPath = path.join(aiGenFlowDir, "input-context.json");

  l(`[parse] Creating .ai-test-gen directory at: ${aiGenFlowDir}`);
  await ensureDir(aiGenFlowDir);

  l(`[parse] Writing input-context.json...`);
  await writeJson(inputContextPath, ctx);
  l(`[parse] Written: ${inputContextPath}`);

  l(`[parse] NODE COMPLETE`);
  l(`[parse] ========================================`);

  return respond(state, {
    sessionId,
    mode,
    target,
    targetType,
    pr,
    phase: "parse",
    startedAt,
    phaseHistory: ["parse"],
    logs,
  });
}
