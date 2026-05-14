import path from "node:path";
import { Command } from "@langchain/langgraph";
import { buildGraph } from "../src/graph.js";

async function main() {
  const graph = buildGraph();
  const config = { configurable: { thread_id: "phase-trace" } };
  const sessionDir = path.join(".out", "phase-trace");
  const testsDir = path.join(".out", "phase-trace-tests");

  const first = await graph.invoke(
    { rawInput: "generate tests for module: payments", sessionDir, testsDir },
    config,
  );
  const resumed = await graph.invoke(new Command({ resume: "cleanup" }), config);
  const all = [...first.phaseHistory, ...resumed.phaseHistory.slice(first.phaseHistory.length)];
  console.log("FULL mode phase history:\n  " + all.join(" → "));

  const graph2 = buildGraph();
  const cfg2 = { configurable: { thread_id: "phase-trace-heal" } };
  const sd2 = path.join(".out", "phase-trace-heal");
  const td2 = path.join(".out", "phase-trace-heal-tests");
  const h1 = await graph2.invoke(
    { rawInput: "heal failing tests for module: payments", sessionDir: sd2, testsDir: td2 },
    cfg2,
  );
  const h2 = await graph2.invoke(new Command({ resume: "cleanup" }), cfg2);
  const hAll = [...h1.phaseHistory, ...h2.phaseHistory.slice(h1.phaseHistory.length)];
  console.log("\nHEAL mode phase history:\n  " + hAll.join(" → "));
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
