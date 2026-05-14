import { Command } from "@langchain/langgraph";
import { buildGraph } from "./graph.js";
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
 * Artifacts land in hyperwright-wrkdir/hcc-{sessionId}/cloned-repo/.ai-test-gen/
 * Generated tests go to hyperwright-wrkdir/hcc-{sessionId}/cloned-repo/playwright-tests/ai-generated/
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

  const graph = buildGraph();
  const threadId = `demo-${demo}-${Date.now()}`;
  const config = { configurable: { thread_id: threadId } };

  console.log(`\n=== Running demo: ${demo} ===`);
  console.log(`env: ${maskedEnvSummary()}\n`);

  const first = await graph.invoke({ rawInput, sessionId: threadId }, config);

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
  console.log(`\nSession ID: ${threadId}`);
  console.log(`Artifacts in: hyperwright-wrkdir/hcc-${threadId}/cloned-repo/.ai-test-gen/`);
}

function printLogs(logs: string[]) {
  for (const line of logs) console.log(line);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
