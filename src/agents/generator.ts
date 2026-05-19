import path from "node:path";
import { extractFencedCode } from "./extract.js";
import { buildSystemPrompt, loadSkillContext } from "./prompts.js";
import { runSubAgent } from "./react.js";
import {
  annotateGeneratedSpec,
  buildExistingTestIndex,
  type ExistingTest,
} from "./relatedTests.js";
import { buildTestFileName } from "../config.js";
import { ENV } from "../env.js";
import { ensureDir, writeText } from "../session/files.js";
import type { TargetType, TestPlan } from "../types.js";

export interface GeneratorInput {
  testPlan: TestPlan;
  target: string;
  targetType: TargetType;
  outputDir: string;
  /** Absolute path to the cloned repo's existing tests dir. Used to flag
   *  generated tests whose titles overlap with already-checked-in tests. */
  existingTestsDir: string;
  sessionDir: string;
  /** Forwarded to runSubAgent to stream AI thinking + tool use to the node's logger. */
  log?: (line: string) => void;
}

export interface GeneratorOutput {
  files: string[];
  testsGenerated: number;
  /** Number of `// REVIEW:` annotations injected post-generation. */
  reviewAnnotations: number;
}

/**
 * playwright-generator sub-agent.
 *
 * Browser navigation is intentionally disabled here — the planner already
 * verified selectors against the live DOM, so the generator's only job is to
 * transform the plan into an executable spec file. After the LLM emits the
 * file we run a deterministic post-process pass that prepends `// REVIEW:`
 * comments above any test() whose title overlaps with an existing test in
 * `playwright-tests/e2e/`, so a human can decide to update vs duplicate.
 */
export async function runGenerator(
  input: GeneratorInput,
): Promise<GeneratorOutput> {
  await ensureDir(input.outputDir);
  const fileName = buildTestFileName(input.targetType, input.target);
  const filePath = path.join(input.outputDir, fileName);

  // Build the existing-tests index up front. Pass a hint into the prompt so
  // the LLM can pick distinguishing titles, then run the deterministic pass
  // after writing the file (the LLM is not in charge of accuracy here).
  const existingIndex = await buildExistingTestIndex(input.existingTestsDir);
  const existingHint =
    existingIndex.length === 0
      ? "(none found)"
      : existingIndex
        .slice(0, 50)
        .map((e) => `- "${e.title}" — ${e.file}`)
        .join("\n");

  const bundle = await loadSkillContext("_generator.md");
  const context = [
    `filePath to emit: ${filePath}`,
    `target: ${input.targetType}:${input.target}`,
    `pageObjectsDir: ${ENV.paths.pageObjectsDir}`,
    `existingTestsDir: ${ENV.paths.existingTestsDir}`,
    `passwordEnvVar: PLAYWRIGHT_PASSWORD`,
    "",
    "Already-checked-in tests (sample):",
    existingHint,
    "",
    "Test plan (JSON):",
    "```json",
    JSON.stringify(input.testPlan, null, 2),
    "```",
  ].join("\n");

  const system = buildSystemPrompt("playwright-generator", bundle, context);
  const task = [
    "Workflow:",
    "1. Use the test plan above as the source of truth — selectors are already",
    "   verified by the planner. Do NOT browse the app.",
    "2. Emit ONE executable Playwright spec file following _generator.md §4.4:",
    "   - imports from @playwright/test + ../support/helper",
    "   - test.describe block",
    "   - beforeEach: generateUniqueEmail → signupUser → loginUI → goto target",
    "   - optional page.route for feature-flag interception",
    "   - one test(...) per scenario in the plan",
    "3. Pick test() titles that are distinct from the already-checked-in tests",
    "   listed above where possible.",
    "4. Emit the file inside a SINGLE fenced ```typescript block — no preamble,",
    "   no trailing commentary.",
  ].join("\n");

  const raw = await runSubAgent({
    systemPrompt: system,
    task,
    // No browser tools, no planner_setup_page — generator emits a spec, it
    // does not navigate.
    extraTools: [],
    noBrowser: true,
    log: input.log,
  });

  // Reject prose-only responses up front: extractFencedCode falls back to the
  // raw text when no fence is present, which would let stray commentary slip
  // through the shape checks below.
  if (!/```/.test(raw)) {
    throw new Error(
      "generator output had no fenced code block (expected a single ```typescript block)",
    );
  }
  const code = extractFencedCode(raw);

  const hasRuntimeImport =
    /import\s+(?!type\b)[^;]*from\s+['"]@playwright\/test['"]/.test(code);
  const hasDescribe = /test\.describe\s*\(/.test(code);
  const hasTestCall = /(^|[^.\w])test\s*\(/m.test(code);
  if (!hasRuntimeImport || !hasDescribe || !hasTestCall) {
    throw new Error(
      "generator output did not look like a Playwright spec (need runtime @playwright/test import, test.describe(...), and at least one test(...) call)",
    );
  }

  await writeText(filePath, code.trimEnd() + "\n");

  const reviewAnnotations = await annotateRelated(
    filePath,
    existingIndex,
    input.existingTestsDir,
    input.log,
  );

  return {
    files: [filePath],
    testsGenerated: input.testPlan.scenarios.length,
    reviewAnnotations,
  };
}

async function annotateRelated(
  specPath: string,
  index: ExistingTest[],
  existingTestsDir: string,
  log?: (line: string) => void,
): Promise<number> {
  const count = await annotateGeneratedSpec(specPath, index, existingTestsDir);
  if (log) {
    if (count > 0) {
      log(
        `[generate] Added ${count} // REVIEW comment${count === 1 ? "" : "s"} for tests overlapping with existing specs`,
      );
    } else if (index.length > 0) {
      log(`[generate] No overlapping tests found in ${existingTestsDir}`);
    }
  }
  return count;
}
