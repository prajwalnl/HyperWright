import fs from "node:fs/promises";
import path from "node:path";
import { extractJsonObject } from "./extract.js";
import { buildSystemPrompt, loadSkillContext } from "./prompts.js";
import { runSubAgent } from "./react.js";
import { runPlaywrightTest } from "../runtime/playwright.js";
import { typecheckFiles } from "../runtime/typecheck.js";
import { sharedAuthToolsFor } from "../tools/planner.js";
import type {
  Creds,
  FailureCategory,
  RunHealingBlock,
  RunResults,
} from "../types.js";

export interface HealerInput {
  attempt: number;
  maxAttempts: number;
  previousResults: RunResults | null;
  totalTests: number;
  /**
   * Files the healer is allowed to edit AND the exact set passed to
   * `npx playwright test`. Keeping the run scope == edit scope means stale
   * specs from prior sessions in the same `ai-generated/` dir don't get
   * counted in metrics. Can be empty in heal-only mode with no discoverable
   * specs — in that case the run surfaces a "0 tests discovered" failure.
   */
  specFiles: string[];
  priorFixes: RunHealingBlock["testsFixed"];
  sessionDir: string;
  /** Session-wide creds from setupJoin, threaded into planner_setup_page. */
  creds: Creds | null;
  /** Required — cwd for `npx playwright test`. Without it, playwright can't load the config. */
  repoPath: string;
  /** Forwarded to runSubAgent / playwright to stream progress to the node's logger. */
  log?: (line: string) => void;
  /**
   * Called once with the *initial* test run results (before any fixes), so
   * the node can persist intermediate metrics to session.json. Optional.
   */
  onInitialRun?: (results: RunResults) => Promise<void>;
}

export interface HealerOutput {
  results: RunResults;
  fixesApplied: number;
}

interface FixResponse {
  edits?: Array<{
    file?: string;
    find: string;
    replace: string;
    test: string;
    rootCause: FailureCategory;
    fix: string;
  }>;
  notes?: string;
}

/**
 * Real playwright-healer sub-agent. Per _healer.md §5, with two refinements:
 *
 *  - Runs against `specFiles` (this session's specs) so a multi-spec session
 *    gets healed as a unit, but stale specs from previous sessions sitting in
 *    the same dir aren't counted in metrics.
 *  - After applying edits, re-runs the suite within the same attempt and
 *    returns the post-fix RunResults, so the metrics surfaced upstream
 *    reflect what the fixes actually achieved.
 */
export async function runHealer(input: HealerInput): Promise<HealerOutput> {
  const initial = await runPlaywrightTest(input.specFiles, input.attempt, {
    cwd: input.repoPath,
    log: input.log,
  });

  // Persist metrics from the pre-fix run so the UI shows live progress
  // mid-attempt instead of waiting until the whole node finishes.
  if (input.onInitialRun) {
    try {
      await input.onInitialRun(initial);
    } catch {
      /* persistence is best-effort */
    }
  }

  if (initial.summary.failed === 0) {
    return withHealing(initial, 0, input);
  }

  const fileBundle = await readFileBundle(input.specFiles);
  if (fileBundle.size === 0) {
    // Nothing we can edit — caller decides what to do. Return as-is.
    return withHealing(initial, 0, input);
  }

  const bundle = await loadSkillContext("_healer.md");

  const filesBlock = Array.from(fileBundle.entries())
    .map(
      ([file, content]) =>
        [`### ${file}`, "```typescript", content, "```", ""].join("\n"),
    )
    .join("\n");

  // Cross-attempt context: on attempt >=2 surface what the previous attempt
  // saw and which tests already had fixes applied. Lets the sub-agent spot
  // patterns ("test X keeps failing despite a selector fix — escalate to
  // root-cause") and avoid re-trying identical edits that didn't stick.
  const historySections: string[] = [];
  if (input.previousResults) {
    const prev = input.previousResults;
    historySections.push(
      "Previous attempt summary:",
      `  passed=${prev.summary.passed} failed=${prev.summary.failed}`,
      "Previous failures (JSON):",
      "```json",
      JSON.stringify(prev.failures, null, 2),
      "```",
      "",
    );
  }
  if (input.priorFixes.length > 0) {
    historySections.push(
      `Fixes already applied across earlier attempts (${input.priorFixes.length}):`,
      "```json",
      JSON.stringify(input.priorFixes, null, 2),
      "```",
      "If a test in this list is still failing, the prior fix was insufficient — diagnose deeper rather than repeating the same edit.",
      "",
    );
  }

  const context = [
    `attempt: ${input.attempt}/${input.maxAttempts}`,
    `editable spec files (${fileBundle.size}):`,
    Array.from(fileBundle.keys())
      .map((f) => `  - ${f}`)
      .join("\n"),
    "",
    ...historySections,
    "Failing tests (JSON):",
    "```json",
    JSON.stringify(initial.failures, null, 2),
    "```",
    "",
    "Current spec files:",
    filesBlock,
  ].join("\n");

  const system = buildSystemPrompt("playwright-healer", bundle, context);
  const task = [
    "Workflow:",
    "1. Call planner_setup_page({ targetPath: \"<the URL the failing test hits>\" }) ONCE.",
    "   This handles signup + login + skip-2FA + navigate deterministically. Do NOT",
    "   use browser_navigate/browser_type/browser_click on login or 2FA pages —",
    "   those steps are owned by the tool. If planner_setup_page reports an error,",
    "   retry it ONCE; if it still fails, stop and report rather than authenticating",
    "   manually.",
    "2. Once authenticated, reproduce each failure: browser_navigate to the",
    "   failing step's URL (NOT the login page), browser_snapshot to see the",
    "   current DOM, browser_console_messages and browser_network_requests for",
    "   clues, browser_generate_locator to upgrade selectors when needed.",
    "3. Return SURGICAL find/replace edits as a single fenced ```json block",
    "   matching this schema:",
    "```json",
    "{",
    '  "edits": [',
    '    { "file": "<path from the editable list above; required if more than one file>", "find": "<exact substring>", "replace": "<new text>", "test": "scenario title", "rootCause": "selector|timing|data|network|feature-flag", "fix": "one-line description" }',
    "  ],",
    '  "notes": "optional"',
    "}",
    "```",
    "Do NOT output the whole file. Keep `find` short and unique within its file.",
  ].join("\n");

  const raw = await runSubAgent({
    systemPrompt: system,
    task,
    extraTools: sharedAuthToolsFor({
      sessionDir: input.sessionDir,
      creds: input.creds,
    }),
    log: input.log,
  });

  let parsed: FixResponse;
  try {
    parsed = extractJsonObject<FixResponse>(raw);
  } catch {
    parsed = { edits: [] };
  }

  // Apply longest `find` first. `String.prototype.replace` only changes the
  // first match, so when two edits target overlapping substrings the shorter
  // one can be subsumed by the longer one's replacement. Sorting by descending
  // length keeps the more-specific match deterministic. (No stable tie-break
  // is needed — same-length finds don't collide in practice.)
  const sortedEdits = (parsed.edits ?? [])
    .slice()
    .sort((a, b) => (b.find?.length ?? 0) - (a.find?.length ?? 0));

  const appliedEdits: RunHealingBlock["testsFixed"] = [];
  const mutated = new Map<string, string>(fileBundle);
  for (const edit of sortedEdits) {
    if (!edit.find) {
      input.log?.(`[heal] dropped edit with empty find (test="${edit.test ?? "?"}")`);
      continue;
    }
    const target = resolveEditFile(edit.file, fileBundle);
    if (!target) {
      input.log?.(
        `[heal] dropped edit — could not resolve file hint "${edit.file ?? "(none)"}" against ${fileBundle.size} editable spec(s)`,
      );
      continue;
    }
    const cur = mutated.get(target) ?? "";
    if (!cur.includes(edit.find)) {
      input.log?.(
        `[heal] dropped edit on ${path.basename(target)} — find substring not present (likely consumed by a prior edit): ${truncate(edit.find, 80)}`,
      );
      continue;
    }
    mutated.set(target, cur.replace(edit.find, edit.replace));
    appliedEdits.push({
      test: edit.test,
      fix: edit.fix,
      attempt: input.attempt,
      rootCause: edit.rootCause,
      debugMethod: "browser_snapshot",
    });
  }

  // Track which files actually changed so we can revert just those on
  // typecheck failure (and only flush those to disk in the happy path).
  const changedFiles: string[] = [];
  for (const [file, content] of mutated.entries()) {
    if (content !== fileBundle.get(file)) {
      changedFiles.push(file);
      await fs.writeFile(file, content, "utf8");
    }
  }

  if (appliedEdits.length === 0) {
    // No edits applied — re-running would just reproduce the same failures.
    return withHealing(initial, 0, input);
  }

  // Defence against a model that produced syntactically/type-broken edits:
  // typecheck the changed specs before the post-fix re-run. If tsc rejects
  // them, revert each file to its pre-edit content and treat the attempt as
  // a no-op so the node's stall guard fires instead of looping on bad code.
  const diagnostics = await typecheckFiles(
    changedFiles,
    input.repoPath,
    input.log ?? (() => {}),
    "heal",
  );
  if (diagnostics.length > 0) {
    input.log?.(
      `[heal] post-edit typecheck failed (${diagnostics.length} diagnostic(s)) — reverting ${changedFiles.length} file(s) and reporting 0 fixes`,
    );
    for (const d of diagnostics.slice(0, 5)) input.log?.(`[heal]   ${d}`);
    for (const file of changedFiles) {
      const original = fileBundle.get(file);
      if (original != null) await fs.writeFile(file, original, "utf8");
    }
    return withHealing(initial, 0, input);
  }

  // Re-run the full suite to measure the impact of the fixes within this
  // attempt. The post-fix results are what flow into state.metrics.
  const postFix = await runPlaywrightTest(input.specFiles, input.attempt, {
    cwd: input.repoPath,
    log: input.log,
  });

  return withHealing(postFix, appliedEdits.length, input, appliedEdits);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

async function readFileBundle(
  specFiles: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const file of specFiles) {
    try {
      const content = await fs.readFile(file, "utf8");
      out.set(file, content);
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

/**
 * Map an LLM-supplied `file` field back to one of the editable paths. Accepts
 * exact match, basename match, or — when only one file is editable — anything.
 */
function resolveEditFile(
  hint: string | undefined,
  bundle: Map<string, string>,
): string | null {
  const keys = Array.from(bundle.keys());
  if (keys.length === 0) return null;
  if (keys.length === 1) return keys[0];
  if (!hint) return null;
  if (bundle.has(hint)) return hint;
  const byBasename = keys.find((k) => path.basename(k) === path.basename(hint));
  if (byBasename) return byBasename;
  const bySuffix = keys.find((k) => k.endsWith(hint));
  return bySuffix ?? null;
}

function withHealing(
  results: RunResults,
  fixesApplied: number,
  input: HealerInput,
  newFixes: RunHealingBlock["testsFixed"] = [],
): HealerOutput {
  // Always attach the healing block so the persisted run-results.json never
  // disagrees with state.metrics. The previous behaviour gated inclusion on
  // `allPass || exhausted`, which dropped the block on stalls (failures
  // remain but no edits applied this attempt) — that's still terminal in the
  // node's eyes, so the artifact must reflect the heal history regardless.
  const healing: RunHealingBlock = {
    attempts: input.attempt,
    testsFixed: [...input.priorFixes, ...newFixes],
    testsStillFailing: results.summary.failed,
    allTestsPassed: results.summary.failed === 0,
  };
  return {
    results: { ...results, healing },
    fixesApplied,
  };
}

export function renderBugReport(
  results: RunResults,
  fixesAppliedTotal: number,
): string {
  const { summary, failures, healing } = results;
  const lines = [
    "# Bug Report - Playwright Test Failures",
    "",
    `Generated: ${results.timestamp}`,
    `Attempts: ${healing?.attempts ?? results.attempt}`,
    "",
    "## Summary",
    "",
    "| Metric        | Count |",
    "| ------------- | ----- |",
    `| Total Tests   | ${summary.total}   |`,
    `| Passed        | ${summary.passed}   |`,
    `| Failed        | ${summary.failed}   |`,
    `| Fixes Applied | ${fixesAppliedTotal}   |`,
    "",
    "## Remaining Failures",
    "",
  ];
  if (failures.length === 0) {
    lines.push("_None — all tests passing._", "");
  } else {
    failures.forEach((f, i) => {
      lines.push(
        `### Failure ${i + 1}: ${f.test}`,
        "",
        `- **Location:** ${f.location}`,
        `- **Error:** ${f.error}`,
        `- **Root Cause:** ${f.category}`,
        `- **Severity:** ${f.category === "network" ? "high" : "medium"}`,
        "",
      );
    });
  }

  lines.push("## Fixes Applied", "");
  if (!healing || healing.testsFixed.length === 0) {
    lines.push("_No fixes were applied._", "");
  } else {
    lines.push(
      "| Test | Fix | Attempt | Root Cause |",
      "| ---- | --- | ------- | ---------- |",
    );
    for (const fx of healing.testsFixed) {
      lines.push(`| ${fx.test} | ${fx.fix} | ${fx.attempt} | ${fx.rootCause} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
