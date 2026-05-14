import path from "node:path";
import { ENV } from "../env.js";
import { runGenerator } from "../agents/generator.js";
import { sh } from "../runtime/exec.js";
import { createNodeLogger, loggerFor } from "../session/log.js";
import { respond } from "../session/respond.js";
import { writeSession } from "../session/sessionFile.js";
import type { QAStateType, QAStateUpdate } from "../state.js";

/**
 * orchestrator.md §4 "Verify" requires `npx tsc --noEmit` on the generated
 * spec. We run it at the repo root so the project's tsconfig resolves imports
 * (@playwright/test, ../support/helper), then filter output for diagnostics
 * that name the generated file — pre-existing errors elsewhere in the repo
 * are not our problem and shouldn't fail the graph.
 */
async function typecheckGeneratedFiles(
  files: string[],
  repoPath: string,
  log: (line: string) => void,
): Promise<string[]> {
  if (files.length === 0) return [];
  log(`[generate] Running tsc --noEmit in ${repoPath}...`);
  const result = await sh("npx tsc --noEmit 2>&1", { cwd: repoPath });
  log(`[generate] tsc exited with code: ${result.code}`);
  const basenames = new Set(files.map((f) => path.basename(f)));
  const diagnostics = (result.stdout + "\n" + result.stderr)
    .split("\n")
    .filter(
      (line) =>
        /error TS\d+/i.test(line) &&
        [...basenames].some((b) => line.includes(b)),
    );
  return diagnostics;
}

export async function generateTestsNode(
  state: QAStateType,
): Promise<QAStateUpdate> {
  const logs: string[] = [];
  const l = loggerFor("generateTests", logs);
  l(`[generate] ========================================`);
  l(`[generate] NODE START: generateTests`);

  if (!state.testPlan) {
    l(`[generate] ERROR: No test plan available`);
    l(`[generate] missing test plan`);
    l(`[generate] ========================================`);
    return respond(state, {
      phase: "failed",
      status: "failed",
      error: "generateTests called without a test plan",
      logs,
    });
  }

  const repoPath = state.repo.repoPath || process.cwd();
  const testsDir = `${repoPath}/${ENV.paths.generatedTestsDir}`;
  const existingTestsDir = `${repoPath}/${ENV.paths.existingTestsDir}`;
  l(`[generate] Target directory: ${testsDir}`);
  l(`[generate] Existing tests directory: ${existingTestsDir}`);
  l(`[generate] Test plan has ${state.testPlan.scenarios.length} scenarios`);
  l(`[generate] Updating session phase to 'generating'...`);

  await writeSession({ ...state, phase: "generating" } as QAStateType);
  l(`[generate] Session phase updated`);

  try {
    l(`[generate] Calling generator agent...`);
    const out = await runGenerator({
      testPlan: state.testPlan,
      target: state.target,
      targetType: state.targetType,
      outputDir: testsDir,
      existingTestsDir,
      sessionDir: state.sessionDir,
      log: createNodeLogger("generateTests"),
    });

    l(`[generate] Generator returned ${out.files.length} file(s)`);
    l(`[generate] Generated ${out.testsGenerated} tests`);
    if (out.reviewAnnotations > 0) {
      l(
        `[generate] Inserted ${out.reviewAnnotations} // REVIEW comment(s) for overlapping existing tests`,
      );
    }
    for (const f of out.files) {
      l(`[generate]   → ${f}`);
    }

    const diagnostics = await typecheckGeneratedFiles(out.files, repoPath, l);
    if (diagnostics.length > 0) {
      l(`[generate] ERROR: TypeScript validation failed with ${diagnostics.length} diagnostic(s):`);
      for (const d of diagnostics.slice(0, 20)) l(`[generate]   ${d}`);
      l(`[generate] ========================================`);
      return respond(state, {
        generatedFiles: out.files,
        metrics: { testsGenerated: out.testsGenerated },
        phase: "failed",
        status: "failed",
        error: `TypeScript validation failed: ${diagnostics[0]}`,
        logs,
      });
    }
    l(`[generate] TypeScript validation passed`);

    l(`[generate] NODE COMPLETE`);
    l(`[generate] ========================================`);

    return respond(state, {
      generatedFiles: out.files,
      metrics: { testsGenerated: out.testsGenerated },
      phase: "generating-complete",
      phaseHistory: ["generating", "generating-complete"],
      logs,
    });
  } catch (err) {
    l(`[generate] ERROR: Generation failed - ${(err as Error).message}`);
    l(`[generate] failure: ${(err as Error).message}`);
    l(`[generate] ========================================`);
    return respond(state, {
      phase: "failed",
      status: "failed",
      error: `Generation failed: ${(err as Error).message}`,
      logs,
    });
  }
}
