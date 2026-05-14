import { END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { QAState } from "./state.js";

import { setupContextNode } from "./nodes/setupContext.js";
import { setupBackendNode } from "./nodes/setupBackend.js";
import { setupFrontendNode } from "./nodes/setupFrontend.js";
import { setupJoinNode } from "./nodes/setupJoin.js";
import { planTestsNode } from "./nodes/planTests.js";
import { generateTestsNode } from "./nodes/generateTests.js";
import { healTestsNode } from "./nodes/healTests.js";
import { finalizeNode } from "./nodes/finalize.js";
import { summaryNode } from "./nodes/summary.js";

import {
  afterGenerate,
  afterPlan,
  afterSetupContext,
  afterSetupJoin,
  healRouter,
} from "./routing.js";

/**
 * Wires the QA pipeline graph.
 *
 * Topology:
 *
 *   START → setupContext ─┬─► setupBackend ─┐
 *                         └─► setupFrontend ─┴─► setupJoin (signup) ─► planTests
 *                                                                          │
 *                                    (mode === "full")                     │
 *                                ┌──────────────┴──────────────┐           │
 *                                ▼                             │           │
 *                         generateTests ──► healTests ◄────────┘ (heal-only)
 *                                              │
 *                                              ▼ (loop ≤ maxHealingAttempts)
 *                                          healTests
 *                                              │
 *                                              ▼
 *                                          finalize  [interrupt()]
 *                                              │  (commit-push | cleanup)
 *                                              ▼
 *                                           summary
 *                                              │
 *                                              ▼
 *                                             END
 *
 * Any node that sets status = "failed" short-circuits to summary → END.
 */
export function buildGraph() {
  const workflow = new StateGraph(QAState)
    .addNode("setupContext", setupContextNode)
    .addNode("setupBackend", setupBackendNode)
    .addNode("setupFrontend", setupFrontendNode)
    .addNode("setupJoin", setupJoinNode)
    .addNode("planTests", planTestsNode)
    .addNode("generateTests", generateTestsNode)
    .addNode("healTests", healTestsNode)
    .addNode("finalize", finalizeNode)
    .addNode("summary", summaryNode);

  workflow.addEdge(START, "setupContext");

  workflow.addConditionalEdges("setupContext", afterSetupContext, {
    setupBackend: "setupBackend",
    setupFrontend: "setupFrontend",
    summary: "summary",
  });

  workflow.addEdge("setupBackend", "setupJoin");
  workflow.addEdge("setupFrontend", "setupJoin");

  workflow.addConditionalEdges("setupJoin", afterSetupJoin, {
    planTests: "planTests",
    summary: "summary",
  });

  workflow.addConditionalEdges("planTests", afterPlan, {
    generateTests: "generateTests",
    healTests: "healTests",
    summary: "summary",
  });

  workflow.addConditionalEdges("generateTests", afterGenerate, {
    healTests: "healTests",
    summary: "summary",
  });

  workflow.addConditionalEdges("healTests", healRouter, {
    healTests: "healTests",
    finalize: "finalize",
    summary: "summary",
  });

  workflow.addEdge("finalize", "summary");

  workflow.addEdge("summary", END);

  return workflow.compile({ checkpointer: new MemorySaver() });
}

export type CompiledQAGraph = ReturnType<typeof buildGraph>;
