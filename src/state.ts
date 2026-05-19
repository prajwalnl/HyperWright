import { Annotation } from "@langchain/langgraph";
import { GENERATED_TESTS_DIR, SESSION_DIR } from "./config.js";
import type {
  Creds,
  Mode,
  Phase,
  PullRequestInfo,
  Status,
  TargetType,
  TestPlan,
  RunResults,
  Servers,
  Metrics,
  UserChoice,
  RepoInfo,
} from "./types.js";

const lastWriteWins = <T>(prev: T, next: T): T => (next ?? prev) as T;
const appendArray = <T>(prev: T[], next: T[]): T[] => prev.concat(next);

const mergeServers = (prev: Servers, next: Partial<Servers>): Servers => ({
  ...prev,
  ...next,
});
const mergeMetrics = (prev: Metrics, next: Partial<Metrics>): Metrics => ({
  testsPlanned: next.testsPlanned ?? prev.testsPlanned,
  testsGenerated: next.testsGenerated ?? prev.testsGenerated,
  testsPassed: next.testsPassed ?? prev.testsPassed,
  testsFailed: next.testsFailed ?? prev.testsFailed,
  testsFixed: next.testsFixed ?? prev.testsFixed,
  healingAttempts: next.healingAttempts ?? prev.healingAttempts,
});

export const QAState = Annotation.Root({
  sessionId: Annotation<string>({ reducer: lastWriteWins, default: () => "" }),
  rawInput: Annotation<string>({ reducer: lastWriteWins, default: () => "" }),
  mode: Annotation<Mode>({ reducer: lastWriteWins, default: () => "full" }),
  target: Annotation<string>({ reducer: lastWriteWins, default: () => "" }),
  targetType: Annotation<TargetType>({
    reducer: lastWriteWins,
    default: () => "module",
  }),

  phase: Annotation<Phase>({ reducer: lastWriteWins, default: () => "setup" }),
  status: Annotation<Status>({
    reducer: lastWriteWins,
    default: () => "in_progress",
  }),
  error: Annotation<string | null>({
    reducer: lastWriteWins,
    default: () => null,
  }),

  servers: Annotation<Servers, Partial<Servers>>({
    reducer: mergeServers,
    default: () => ({
      backendUp: false,
      frontendUp: false,
      backendWasStarted: false,
      frontendWasStarted: false,
      backendPid: null,
      frontendPid: null,
    }),
  }),

  repo: Annotation<RepoInfo, Partial<RepoInfo>>({
    reducer: (prev, next) => ({ ...prev, ...next }),
    default: () => ({
      repoPath: "",
      repoCloned: false,
      repoBranch: null,
      isNewBranch: false,
    }),
  }),

  pr: Annotation<PullRequestInfo | null>({
    reducer: lastWriteWins,
    default: () => null,
  }),

  testPlan: Annotation<TestPlan | null>({
    reducer: lastWriteWins,
    default: () => null,
  }),
  generatedFiles: Annotation<string[]>({
    reducer: lastWriteWins,
    default: () => [],
  }),
  runResults: Annotation<RunResults | null>({
    reducer: lastWriteWins,
    default: () => null,
  }),
  bugReport: Annotation<string | null>({
    reducer: lastWriteWins,
    default: () => null,
  }),

  metrics: Annotation<Metrics, Partial<Metrics>>({
    reducer: mergeMetrics,
    default: () => ({
      testsPlanned: 0,
      testsGenerated: 0,
      testsPassed: 0,
      testsFailed: 0,
      testsFixed: 0,
      healingAttempts: 0,
    }),
  }),

  maxHealingAttempts: Annotation<number>({
    reducer: lastWriteWins,
    default: () => 3,
  }),

  /**
   * Fixes applied in the most recent healTests invocation. Used by
   * healRouter to honor _healer.md §5.7 exit condition #3 — if an attempt
   * produced zero edits while failures remain, further attempts won't help,
   * so we bail to finalize instead of spinning through maxHealingAttempts.
   */
  lastAttemptFixes: Annotation<number>({
    reducer: lastWriteWins,
    default: () => 0,
  }),

  userChoice: Annotation<UserChoice | null>({
    reducer: lastWriteWins,
    default: () => null,
  }),

  /**
   * Auth creds created once during setupJoin and reused for the lifetime of
   * the session. Planner + healer call planner_setup_page with these so they
   * skip per-run signup. Generated test specs still create their own per-test
   * users — these are exploration creds only.
   */
  creds: Annotation<Creds | null>({
    reducer: lastWriteWins,
    default: () => null,
  }),

  startedAt: Annotation<string>({
    reducer: lastWriteWins,
    default: () => new Date().toISOString(),
  }),
  completedAt: Annotation<string>({ reducer: lastWriteWins, default: () => "" }),

  sessionDir: Annotation<string>({
    reducer: lastWriteWins,
    default: () => SESSION_DIR,
  }),
  testsDir: Annotation<string>({
    reducer: lastWriteWins,
    default: () => GENERATED_TESTS_DIR,
  }),

  logs: Annotation<string[]>({ reducer: appendArray, default: () => [] }),

  phaseHistory: Annotation<Phase[]>({
    reducer: appendArray,
    default: () => [],
  }),
});

export type QAStateType = typeof QAState.State;
export type QAStateUpdate = typeof QAState.Update;
