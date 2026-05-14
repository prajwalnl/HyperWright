export type Mode = "full" | "heal-only";

export type TargetType = "pr" | "branch" | "module" | "scenario";

export type Phase =
  | "setup"
  | "planning"
  | "planning-complete"
  | "generating"
  | "generating-complete"
  | "healing"
  | "healing-complete"
  | "awaiting-user-choice"
  | "finalizing"
  | "complete"
  | "failed";

export type Status = "in_progress" | "failed" | "complete";

/**
 * Two terminal actions exposed at the HITL pause:
 *   1) commit-push — commit + push generated tests on the branch
 *                    setupContext put us on. When `repo.isNewBranch === true`
 *                    (fresh `pw/...` branch for module/scenario/merged-PR
 *                    runs), also opens a GitHub PR via `gh pr create` — the
 *                    UI relabels the button to "Create PR".
 *   2) cleanup     — drop generated specs + per-run JSON artifacts. The
 *                    cloned repo is preserved.
 */
export type UserChoice = "commit-push" | "cleanup";

export interface Creds {
  email: string;
  password: string;
}

export type ScenarioCategory =
  | "happy-path"
  | "validation"
  | "error-handling"
  | "edge-case"
  | "component-visibility"
  | "empty-state"
  | "navigation"
  | "data-display"
  | "interaction";

export type FailureCategory =
  | "selector"
  | "timing"
  | "data"
  | "network"
  | "feature-flag";

export interface Servers {
  backendUp: boolean;
  frontendUp: boolean;
  backendWasStarted: boolean;
  frontendWasStarted: boolean;
  frontendPid: number | null;
}

export interface RepoInfo {
  repoPath: string;
  repoCloned: boolean;
  repoBranch: string | null;
  /**
   * True when setupContext created a fresh `pw/...` session branch off main
   * (because the target was a module/scenario, or `gh pr checkout` failed
   * for a merged-and-deleted PR head). False when we kept an existing
   * branch (open-PR head, explicit `branch:` directive). finalize uses this
   * to decide whether to open a PR via `gh pr create` — pushing to an
   * already-existing PR branch updates that PR; pushing to a fresh branch
   * needs a new PR opened explicitly.
   */
  isNewBranch: boolean;
}

export interface Metrics {
  testsPlanned: number;
  testsGenerated: number;
  testsPassed: number;
  testsFailed: number;
  testsFixed: number;
  healingAttempts: number;
}

export interface ScenarioStep {
  action:
    | "navigate"
    | "click"
    | "type"
    | "select"
    | "verify"
    | "api"
    | "wait";
  target?: string;
  value?: string;
  expected?: string;
}

export interface Scenario {
  id: string;
  title: string;
  category: ScenarioCategory;
  preconditions: string[];
  steps: ScenarioStep[];
  selectors: Record<string, string>;
  apiSetup?: { helper: string; params: unknown[] };
}

export interface PlanPreconditions {
  description: string;
  apiHelpers: string[];
  setupSteps: string[];
}

export interface PlanReferences {
  existingTests: string[];
  apiHelpers: string[];
}

export interface HealingFix {
  test: string;
  error: string;
  fix: string;
  rootCause: FailureCategory;
  attempt: number;
}

export interface TestPlan {
  sessionId: string;
  source: string;
  mode: Mode;
  timestamp: string;
  url: string;
  preconditions: PlanPreconditions;
  scenarios: Scenario[];
  selectors: { global: Record<string, string> };
  featureFlags: string[];
  references: PlanReferences;
  /** Populated only when mode === "heal-only". */
  fixes?: HealingFix[];
}

export interface Failure {
  test: string;
  error: string;
  location: string;
  stack: string;
  category: FailureCategory;
}

export interface RunHealingBlock {
  attempts: number;
  testsFixed: Array<{
    test: string;
    fix: string;
    attempt: number;
    rootCause: FailureCategory;
    debugMethod: string;
  }>;
  testsStillFailing: number;
  allTestsPassed: boolean;
}

export interface RunResults {
  status: "passed" | "failed" | "partial";
  testFile: string;
  timestamp: string;
  attempt: number;
  summary: { total: number; passed: number; failed: number; skipped: number };
  failures: Failure[];
  healing?: RunHealingBlock;
}

export interface PullRequestInfo {
  number: string;
  title: string;
  body: string;
  diff: string;
}

export interface InputContext {
  rawInput: string;
  mode: Mode;
  target: string;
  targetType: TargetType;
  timestamp: string;
  sessionId: string;
  pr?: PullRequestInfo | null;
}

export interface SessionFile {
  sessionId: string;
  mode: Mode;
  status: Status;
  phase: Phase;
  startedAt: string;
  completedAt?: string;
  servers: Servers;
  metrics: Metrics;
  error?: string | null;
  message?: string;
  userChoice?: UserChoice | null;
  creds?: Creds | null;
  branch?: string | null;
}

export interface SummaryFile {
  sessionId: string;
  mode: Mode;
  request: string;
  status: Status;
  duration: number;
  files: {
    testPlan: string | null;
    testFiles: string[];
    results: string | null;
    summary: string;
    bugReport: string | null;
  };
  results: {
    testsPlanned: number;
    testsGenerated: number;
    testsPassed: number;
    testsFailed: number;
    testsFixed: number;
    skipped: number;
  };
}
