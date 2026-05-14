import path from "node:path";

export interface SessionPaths {
  dir: string;
  inputContext: string;
  session: string;
  testPlan: string;
  runResults: string;
  bugReport: string;
  summary: string;
}

export function sessionPaths(sessionDir: string): SessionPaths {
  return {
    dir: sessionDir,
    inputContext: path.join(sessionDir, "input-context.json"),
    session: path.join(sessionDir, "session.json"),
    testPlan: path.join(sessionDir, "test-plan.json"),
    runResults: path.join(sessionDir, "run-results.json"),
    bugReport: path.join(sessionDir, "bug-report.md"),
    summary: path.join(sessionDir, "summary.json"),
  };
}
