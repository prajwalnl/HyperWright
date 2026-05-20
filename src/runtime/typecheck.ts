import path from "node:path";
import { sh } from "./exec.js";

/**
 * orchestrator.md §4 "Verify" requires `npx tsc --noEmit` on generated specs.
 * Run at the repo root so the project's tsconfig resolves imports
 * (@playwright/test, ../support/helper), then filter output for diagnostics
 * that name one of `files` — pre-existing errors elsewhere in the repo are
 * not our problem and shouldn't fail the caller. Match on the repo-relative
 * path (tsc emits `path/to/file.ts(line,col): …`) so we don't confuse our
 * spec with an unrelated file that happens to share a basename.
 *
 * If tsc itself exits non-zero with no attributable diagnostics, surface it
 * as a tooling failure rather than silently passing.
 */
export async function typecheckFiles(
  files: string[],
  repoPath: string,
  log: (line: string) => void,
  label = "typecheck",
): Promise<string[]> {
  if (files.length === 0) return [];
  log(`[${label}] Running tsc --noEmit in ${repoPath}...`);
  const result = await sh("npx tsc --noEmit 2>&1", { cwd: repoPath });
  log(`[${label}] tsc exited with code: ${result.code}`);
  const relPaths = files.map((f) => path.relative(repoPath, f));
  const combined = result.stdout + "\n" + result.stderr;
  const diagnostics = combined
    .split("\n")
    .filter(
      (line) =>
        /error TS\d+/i.test(line) &&
        relPaths.some((rel) => line.includes(rel)),
    );
  if (
    diagnostics.length === 0 &&
    result.code !== 0 &&
    result.code !== null
  ) {
    const tail = combined
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(-5)
      .join(" | ");
    return [
      `tsc failed (exit ${result.code}) without diagnostics naming target files: ${tail || "(no output)"}`,
    ];
  }
  return diagnostics;
}
