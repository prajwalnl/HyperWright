import { extractJsonObject } from "./extract.js";
import { buildSystemPrompt, loadSkillContext } from "./prompts.js";
import { runSubAgent } from "./react.js";
import { DASHBOARD_BASE_URL, resolveModule, setupStepsFor } from "../config.js";
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
  /** Forwarded to runSubAgent to stream AI thinking + tool use to the node's logger. */
  log?: (line: string) => void;
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
  const mod = resolveModule(input.target);
  const bundle = await loadSkillContext("_planner.md");

  const contextLines = [
    `sessionId: ${input.sessionId}`,
    `mode: ${input.mode}`,
    `target: ${input.targetType}:${input.target}`,
    `module.path: ${mod.path}`,
    `module.prerequisites: ${mod.prerequisites.join(", ") || "(none)"}`,
    `module.apiHelpers: ${mod.apiHelpers.join(", ") || "(none)"}`,
    `dashboardBaseUrl: ${DASHBOARD_BASE_URL}`,
    `sessionDir: ${input.sessionDir}`,
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
      input.pr.diff || "(empty)",
    );
  }
  const system = buildSystemPrompt(
    "playwright-planner",
    bundle,
    contextLines.join("\n"),
  );

  const task = [
    "Workflow:",
    `1. Call planner_setup_page({ targetPath: "${mod.path}" }) ONCE. This handles signup + login + skip-2FA + navigate deterministically. Do NOT use browser_navigate/browser_type/browser_click on the login or 2FA pages — those steps are owned by the tool. If planner_setup_page reports an error, retry it ONCE; if it still fails, stop and report rather than authenticating manually.`,
    "2. Once authenticated and on the target page, use the browser_* tools to explore (snapshot, click, wait_for, …) the MODULE itself, and discover selectors via browser_generate_locator.",
    "3. Call planner_save_plan({ plan: <full JSON> }) with a test plan matching _planner.md §3.6. Required top-level keys:",
    "   sessionId, source, mode, timestamp, url, preconditions, scenarios, selectors.global, featureFlags, references.",
    input.mode === "heal-only"
      ? "   Because mode is heal-only, also include a `fixes` array."
      : "",
    "4. After planner_save_plan succeeds, reply with a one-line confirmation.",
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
  if (!Array.isArray(plan.scenarios) || plan.scenarios.length === 0) {
    throw new Error("planner produced an empty `scenarios` array");
  }
  return plan;
}
