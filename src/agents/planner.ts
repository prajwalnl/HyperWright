import path from "node:path";
import { extractJsonObject } from "./extract.js";
import { buildSystemPrompt, loadSkillContext } from "./prompts.js";
import { runSubAgent } from "./react.js";
import { DASHBOARD_BASE_URL, pickModuleForTarget, setupStepsFor } from "../config.js";
import { readJson } from "../session/files.js";
import { sessionPaths } from "../session/paths.js";
import { plannerToolsFor } from "../tools/planner.js";
import type {
  Creds,
  HealingFix,
  Mode,
  PullRequestInfo,
  TargetType,
  TestPlan,
} from "../types.js";

export interface PlannerInput {
  sessionId: string;
  mode: Mode;
  target: string;
  targetType: TargetType;
  sessionDir: string;
  pr: PullRequestInfo | null;
  /** Session-wide creds from setupJoin, threaded into planner_setup_page. */
  creds: Creds | null;
  /**
   * Cloned repo root. Surfaced to the agent so it can locate existing tests
   * and POMs (paths below are relative to this).
   */
  repoPath: string;
  /** Repo-relative dir holding existing spec files to learn selectors from. */
  existingTestsDir: string;
  /** Repo-relative dir holding Page Object classes to reuse. */
  pageObjectsDir: string;
  /** Forwarded to runSubAgent to stream AI thinking + tool use to the node's logger. */
  log?: (line: string) => void;
  /** Forwarded to runSubAgent so the node can enforce a per-call timeout. */
  signal?: AbortSignal;
}

/**
 * Real playwright-planner sub-agent. Workflow:
 *   1. `planner_setup_page` (auth + navigate) per SKILL.md
 *   2. `browser_*` exploration
 *   3. `planner_save_plan` (preferred) or fenced ```json``` in the final msg
 *
 * No silent fallback — if the agent produces neither a tool-written file nor
 * a valid JSON block, throw. The graph maps the throw to status=failed.
 */
export async function runPlanner(input: PlannerInput): Promise<TestPlan> {
  // Throws if the module can't be inferred — better than silently exploring
  // /dashboard/payments because resolveModule defaulted there.
  const mod = pickModuleForTarget(input.targetType, input.target, input.pr);
  const bundle = await loadSkillContext("_planner.md");

  const existingTestsAbs = path.join(input.repoPath, input.existingTestsDir);
  const pageObjectsAbs = path.join(input.repoPath, input.pageObjectsDir);
  const contextLines = [
    `sessionId: ${input.sessionId}`,
    `mode: ${input.mode}`,
    `target: ${input.targetType}:${input.target}`,
    `module.path: ${mod.path}`,
    `module.prerequisites: ${mod.prerequisites.join(", ") || "(none)"}`,
    `module.apiHelpers: ${mod.apiHelpers.join(", ") || "(none)"}`,
    `dashboardBaseUrl: ${DASHBOARD_BASE_URL}`,
    `sessionDir: ${input.sessionDir}`,
    `repoPath: ${input.repoPath}`,
    `existingTestsDir: ${existingTestsAbs}`,
    `pageObjectsDir: ${pageObjectsAbs}`,
  ];
  if (input.pr) {
    contextLines.push(
      "",
      `PR #${input.pr.number}: ${input.pr.title}`,
      "",
      "PR description:",
      input.pr.body || "(empty)",
      "",
      "PR diff:",
      truncateDiff(input.pr.diff || "(empty)"),
    );
  }
  const system = buildSystemPrompt(
    "playwright-planner",
    bundle,
    contextLines.join("\n"),
  );

  const task = [
    "Workflow:",
    `1. Survey existing tests first. Use list_dir on existingTestsDir and pageObjectsDir, then read_file on the specs/POMs targeting the same module ("${mod.path}"). Harvest selectors, beforeEach setup, and API-helper calls — you must reuse them in the plan so the generated suite stays consistent with the rest of the repo. Record what you read in references.existingTests[] and lift reusable locators into selectors.global.`,
    `2. The browser is ALREADY authenticated and on ${mod.path}. Start with browser_snapshot to see what's on the page; then explore with browser_click / browser_wait_for / browser_generate_locator. Do NOT call planner_setup_page — only invoke it if the page has been invalidated (signed out, session expired) and you need to recover.`,
    "3. Prefer selectors that already exist in the repo over inventing new ones.",
    "4. Call planner_save_plan({ plan: <full JSON> }) with a test plan matching _planner.md §3.6. Required top-level keys:",
    "   sessionId, source, mode, timestamp, url, preconditions, scenarios, selectors.global, featureFlags, references.",
    input.mode === "heal-only"
      ? "   Because mode is heal-only, also include a `fixes` array."
      : "",
    "5. After planner_save_plan succeeds, reply with a one-line confirmation.",
    "",
    "If planner_save_plan is somehow unavailable, emit the JSON in a fenced ```json``` block.",
  ]
    .filter(Boolean)
    .join("\n");

  const raw = await runSubAgent({
    systemPrompt: system,
    task,
    extraTools: plannerToolsFor({
      sessionDir: input.sessionDir,
      creds: input.creds,
    }),
    log: input.log,
    signal: input.signal,
  });

  const paths = sessionPaths(input.sessionDir);
  let plan = (await readJson<TestPlan>(paths.testPlan)) ?? null;

  if (!plan) {
    plan = extractJsonObject<TestPlan>(raw); // throws if not a valid JSON object
  }

  plan.sessionId = input.sessionId;
  plan.mode = input.mode;
  plan.timestamp ??= new Date().toISOString();
  plan.url ??= mod.path;
  plan.source ??=
    input.targetType === "pr"
      ? `PR #${input.target}`
      : `${input.targetType}:${input.target}`;
  plan.preconditions ??= {
    description: `Authenticated ${input.target} session`,
    apiHelpers: mod.apiHelpers,
    setupSteps: setupStepsFor(mod),
  };
  plan.selectors ??= { global: {} };
  plan.featureFlags ??= [];
  plan.references ??= { existingTests: [], apiHelpers: mod.apiHelpers };

  if (input.mode === "heal-only" && !plan.fixes) {
    plan.fixes = [] as HealingFix[];
  }
  validateTestPlan(plan);
  return plan;
}

// Cap inlined PR diffs so a 50k-line refactor doesn't blow the local-LLM
// context window. ~2000 lines is enough for the agent to identify the
// affected module and a handful of changed components.
const MAX_DIFF_LINES = 2000;

function truncateDiff(diff: string): string {
  const lines = diff.split("\n");
  if (lines.length <= MAX_DIFF_LINES) return diff;
  const head = lines.slice(0, MAX_DIFF_LINES).join("\n");
  return `${head}\n(... ${lines.length - MAX_DIFF_LINES} more lines truncated)`;
}

const VALID_STEP_ACTIONS = new Set([
  "navigate",
  "click",
  "type",
  "select",
  "verify",
  "api",
  "wait",
]);

/**
 * Post-backfill shape check. Catches the cases where the agent produced
 * structurally-shaped JSON that passed extractJsonObject but is unusable
 * downstream — empty scenarios, missing step actions, missing IDs/titles,
 * etc. Throws on the first problem so the failure mode is "planning failed
 * with a specific reason" instead of "generator crashed two minutes in."
 */
function validateTestPlan(plan: TestPlan): void {
  if (!Array.isArray(plan.scenarios) || plan.scenarios.length === 0) {
    throw new Error("planner produced an empty `scenarios` array");
  }

  const seenIds = new Set<string>();
  plan.scenarios.forEach((sc, i) => {
    const where = `scenarios[${i}]`;
    if (!sc || typeof sc !== "object") {
      throw new Error(`${where} is not an object`);
    }
    if (typeof sc.id !== "string" || !sc.id.trim()) {
      throw new Error(`${where}.id must be a non-empty string`);
    }
    if (seenIds.has(sc.id)) {
      throw new Error(`${where}.id "${sc.id}" is duplicated`);
    }
    seenIds.add(sc.id);
    if (typeof sc.title !== "string" || !sc.title.trim()) {
      throw new Error(`${where}.title must be a non-empty string`);
    }
    if (!Array.isArray(sc.steps) || sc.steps.length === 0) {
      throw new Error(`${where}.steps must be a non-empty array`);
    }
    sc.steps.forEach((st, j) => {
      const stepWhere = `${where}.steps[${j}]`;
      if (!st || typeof st !== "object") {
        throw new Error(`${stepWhere} is not an object`);
      }
      if (typeof st.action !== "string" || !VALID_STEP_ACTIONS.has(st.action)) {
        throw new Error(
          `${stepWhere}.action must be one of ${[...VALID_STEP_ACTIONS].join("|")}; got "${st.action}"`,
        );
      }
    });
  });

  if (!plan.preconditions || !Array.isArray(plan.preconditions.apiHelpers)) {
    throw new Error("plan.preconditions.apiHelpers must be an array");
  }
  if (!plan.selectors || typeof plan.selectors.global !== "object") {
    throw new Error("plan.selectors.global must be an object");
  }
  if (!plan.references || !Array.isArray(plan.references.existingTests)) {
    throw new Error("plan.references.existingTests must be an array");
  }
}
