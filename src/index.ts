import { Command } from "@langchain/langgraph";
import { buildGraph } from "./graph.js";
import { maskedEnvSummary } from "./env.js";
import type { UserChoice } from "./types.js";

/**
 * Demo runner.
 *   npx tsx src/index.ts full [create-pr|cancel]
 *   npx tsx src/index.ts heal [create-pr|cancel]
 *
 * Both choices are terminal — the `summary` node executes the choice
 * (commit + push + PR for create-pr; no-op for cancel) and the graph ends.
 *
 * Artifacts land in hyperwright-wrkdir/hcc-{sessionId}/.ai-test-gen/
 * Generated tests go to hyperwright-wrkdir/hcc-{sessionId}/cloned-repo/playwright-tests/ai-generated/
 */
const VALID_CHOICES: UserChoice[] = ["create-pr", "cancel"];

async function main() {
  const demo = (process.argv[2] ?? "full").toLowerCase();
  const arg = process.argv[3] as UserChoice | undefined;
  const userChoice: UserChoice =
    arg && VALID_CHOICES.includes(arg) ? arg : "cancel";
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
  const needsResume = snap.tasks.some((t) => t.interrupts.length > 0);

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
  console.log(`Artifacts in: hyperwright-wrkdir/hcc-${threadId}/.ai-test-gen/`);
}

function printLogs(logs: string[]) {
  for (const line of logs) console.log(line);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
