import { ENV } from "../env.js";
import { runGenerator } from "../agents/generator.js";
import { typecheckFiles } from "../runtime/typecheck.js";
import { createNodeLogger, loggerFor } from "../session/log.js";
import { respond } from "../session/respond.js";
import { writeSession } from "../session/sessionFile.js";
import type { QAStateType, QAStateUpdate } from "../state.js";

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
      phaseHistory: ["failed"],
      status: "failed",
      error: "generateTests called without a test plan",
      logs,
    });
  }

  if (state.testPlan.scenarios.length === 0) {
    l(`[generate] ERROR: Test plan has zero scenarios`);
    l(`[generate] ========================================`);
    return respond(state, {
      phase: "failed",
      phaseHistory: ["failed"],
      status: "failed",
      error: "generateTests called with an empty test plan (no scenarios)",
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

    const diagnostics = await typecheckFiles(out.files, repoPath, l, "generate");
    if (diagnostics.length > 0) {
      l(`[generate] ERROR: TypeScript validation failed with ${diagnostics.length} diagnostic(s):`);
      for (const d of diagnostics.slice(0, 20)) l(`[generate]   ${d}`);
      l(`[generate] ========================================`);
      return respond(state, {
        generatedFiles: out.files,
        metrics: { testsGenerated: out.testsGenerated },
        phase: "failed",
        phaseHistory: ["generating", "failed"],
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
      phaseHistory: ["generating", "failed"],
      status: "failed",
      error: `Generation failed: ${(err as Error).message}`,
      logs,
    });
  }
}
