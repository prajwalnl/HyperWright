import { run } from "./exec.js";
import type {
  Failure,
  FailureCategory,
  RunResults,
} from "../types.js";

interface PwJson {
  suites: PwSuite[];
  stats: { expected: number; unexpected: number; skipped: number; flaky: number };
}
interface PwSuite {
  title: string;
  file: string;
  suites?: PwSuite[];
  specs?: PwSpec[];
}
interface PwSpec {
  title: string;
  file: string;
  line: number;
  tests: Array<{
    results: Array<{
      status: "passed" | "failed" | "timedOut" | "skipped" | "interrupted";
      error?: { message?: string; stack?: string };
      attempt?: number;
    }>;
  }>;
}

function collectSpecs(suite: PwSuite, out: PwSpec[] = []): PwSpec[] {
  if (suite.specs) out.push(...suite.specs);
  for (const s of suite.suites ?? []) collectSpecs(s, out);
  return out;
}

function categorize(msg: string): FailureCategory {
  const m = msg.toLowerCase();
  if (m.includes("net::") || m.includes("econnrefused")) return "network";
  if (m.includes("strict mode") || m.includes("locator.") || m.includes("not found")) return "selector";
  if (m.includes("timeout")) return "timing";
  if (m.includes("expect(")) return "data";
  return "selector";
}

export interface RunPlaywrightTestOptions {
  /**
   * Directory to shell out from. REQUIRED when calling from the web-ui
   * Runner — without it, `npx playwright test` runs from wherever the server
   * was started (typically `examples/playwright/web-ui/`), which has no
   * `playwright.config`, no fixtures, and no commands import. The test file
   * then silently fails to load and Playwright returns 0 specs, which the
   * healer was mistakenly treating as "all tests passed".
   */
  cwd?: string;
  /** Optional sink for live playwright stderr — flows to the web-ui log panel. */
  log?: (line: string) => void;
}

/**
 * Run the healer test file(s) via `npx playwright test --reporter=json`, parse
 * stdout, and return a RunResults block. The process exit code is ignored —
 * the JSON reporter is authoritative.
 *
 * `testPaths` may be a single path (file or dir) or an explicit list of files.
 * Passing the list keeps the run scope aligned with what the healer can edit,
 * so stale specs from prior sessions in the same dir don't get counted.
 */
export async function runPlaywrightTest(
  testPaths: string | string[],
  attempt: number,
  opts: RunPlaywrightTestOptions = {},
): Promise<RunResults> {
  const paths = Array.isArray(testPaths) ? testPaths : [testPaths];
  const testFileLabel = paths.length === 1 ? paths[0] : paths.join(", ");

  if (paths.length === 0) {
    return {
      status: "failed",
      testFile: "",
      timestamp: new Date().toISOString(),
      attempt,
      summary: { total: 0, passed: 0, failed: 1, skipped: 0 },
      failures: [
        {
          test: "(test discovery)",
          error: "runPlaywrightTest called with no test paths",
          location: "",
          stack: "",
          category: "selector",
        },
      ],
    };
  }

  // Stream stderr (errors, config problems, missing imports) so the user can
  // see why a run fails. Stdout IS the JSON report — don't stream it, it'd
  // bury the log panel in one giant blob.
  const result = await run(
    "npx",
    ["playwright", "test", ...paths, "--reporter=json"],
    {
      cwd: opts.cwd,
      onStderr: opts.log ? (line) => opts.log!(`  playwright: ${line}`) : undefined,
    },
  );

  const jsonStart = result.stdout.indexOf("{");
  let parsed: PwJson | null = null;
  if (jsonStart >= 0) {
    try {
      parsed = JSON.parse(result.stdout.slice(jsonStart)) as PwJson;
    } catch {
      parsed = null;
    }
  }

  const now = new Date().toISOString();
  if (!parsed) {
    return {
      status: "failed",
      testFile: testFileLabel,
      timestamp: now,
      attempt,
      summary: { total: 0, passed: 0, failed: 1, skipped: 0 },
      failures: [
        {
          test: "(playwright reporter)",
          error: result.stderr || "Failed to parse Playwright JSON output",
          location: testFileLabel,
          stack: result.stderr.slice(0, 2000),
          category: "network",
        },
      ],
    };
  }

  const specs = parsed.suites.flatMap((s) => collectSpecs(s));
  const failures: Failure[] = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const spec of specs) {
    const last = spec.tests[spec.tests.length - 1]?.results.at(-1);
    if (!last) continue;
    if (last.status === "passed") passed++;
    else if (last.status === "skipped") skipped++;
    else {
      failed++;
      const msg = last.error?.message ?? "(no message)";
      failures.push({
        test: spec.title,
        error: msg,
        location: `${spec.file}:${spec.line}`,
        stack: (last.error?.stack ?? "").slice(0, 2000),
        category: categorize(msg),
      });
    }
  }

  // Playwright discovered zero specs — the file didn't load (config missing,
  // import failed, syntax error, or glob didn't match). Surface this as a
  // real failure rather than letting the healer short-circuit on failed=0.
  if (passed + failed + skipped === 0) {
    const hint =
      result.stderr.trim() ||
      "no specs discovered — playwright.config may be missing, imports may have failed, or the file path doesn't match testDir";
    return {
      status: "failed",
      testFile: testFileLabel,
      timestamp: now,
      attempt,
      summary: { total: 0, passed: 0, failed: 1, skipped: 0 },
      failures: [
        {
          test: "(test discovery)",
          error: `Playwright reported 0 tests for ${testFileLabel}. ${hint}`,
          location: testFileLabel,
          stack: result.stderr.slice(0, 2000),
          category: "selector",
        },
      ],
    };
  }

  const status: RunResults["status"] =
    failed === 0 ? "passed" : passed === 0 ? "failed" : "partial";

  return {
    status,
    testFile: testFileLabel,
    timestamp: now,
    attempt,
    summary: { total: passed + failed + skipped, passed, failed, skipped },
    failures,
  };
}
