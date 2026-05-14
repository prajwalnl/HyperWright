import path from "node:path";
import { Command } from "@langchain/langgraph";
import { buildGraph } from "./graph.js";
import { GENERATED_TESTS_DIR, SESSION_DIR } from "./config.js";
import { maskedEnvSummary } from "./env.js";
import type { UserChoice } from "./types.js";

/**
 * Demo runner.
 *   npx tsx src/index.ts full [commit-push|cleanup]
 *   npx tsx src/index.ts heal [commit-push|cleanup]
 *
 * Both choices are terminal — after `finalize` the graph runs `summary`
 * and ends.
 *
 * Artifacts land in .opencode/sessions/playwright-run and
 * playwright-tests/ai-generated relative to the cwd where you invoke this,
 * unless you pass OUT_PREFIX=./.out/… in the env.
 */
const VALID_CHOICES: UserChoice[] = ["commit-push", "cleanup"];

async function main() {
  const demo = (process.argv[2] ?? "full").toLowerCase();
  const arg = process.argv[3] as UserChoice | undefined;
  const userChoice: UserChoice =
    arg && VALID_CHOICES.includes(arg) ? arg : "cleanup";
  const rawInput =
    demo === "heal"
      ? "heal failing tests for module: payments"
      : "generate tests for module: payments";

  const prefix = process.env.OUT_PREFIX ?? "";
  const sessionDir = path.join(prefix, SESSION_DIR);
  const testsDir = path.join(prefix, GENERATED_TESTS_DIR);

  const graph = buildGraph();
  const config = { configurable: { thread_id: `demo-${demo}-${Date.now()}` } };

  console.log(`\n=== Running demo: ${demo} ===`);
  console.log(`env: ${maskedEnvSummary()}\n`);

  const first = await graph.invoke({ rawInput, sessionDir, testsDir }, config);

  const snap = await graph.getState(config);
  const needsResume =
    snap.next.includes("finalize") ||
    snap.tasks.some((t) => t.interrupts.length > 0);

  if (needsResume) {
    console.log(`\n[main] paused — resuming with '${userChoice}'\n`);
    const resumed = await graph.invoke(
      new Command({ resume: userChoice }),
      config,
    );
    printLogs(resumed.logs);
  } else {
    printLogs(first.logs);
  }
  console.log(`\nArtifacts in: ${sessionDir}`);
  console.log(`Generated tests in: ${testsDir}`);
}

function printLogs(logs: string[]) {
  for (const line of logs) console.log(line);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
