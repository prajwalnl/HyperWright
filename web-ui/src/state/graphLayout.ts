import type { Edge, Node } from "@xyflow/react";

// `pathOptions` lives on the SmoothStepEdge subtype in @xyflow/react v12,
// not on the base Edge. Importing the type by name collides with the
// component of the same name, so we redeclare the shape we need.
type SmoothStepEdgeWithPathOptions = Edge & {
  pathOptions?: { offset?: number; borderRadius?: number };
};

export interface FlowNodeData {
  title: string;
  subtitle: string;
  [key: string]: unknown;
}

/** Mirror of graph.ts topology. Positions laid out top-to-bottom.
 *
 * Every node sits on the center spine. Full mode is the primary path:
 *   planTests → generateTests → healTests → finalize → summary.
 * The heal-only edge skips generateTests by exiting planTests's right
 * handle, sweeping through the right gutter, and re-entering healTests's
 * right handle.
 */
export const GRAPH_NODES: Node<FlowNodeData>[] = [
  nd("setupContext", 300, 0, "Setup Context", "parse + clone + branch"),
  nd("setupBackend", 150, 180, "Setup Backend", "orchestrator §2a"),
  nd("setupFrontend", 450, 180, "Setup Frontend", "orchestrator §2b"),
  nd("setupJoin", 300, 360, "Setup Join", "verify + signup"),
  nd("planTests", 300, 540, "Plan Tests", "_planner.md"),
  nd("generateTests", 300, 720, "Generate Tests", "_generator.md"),
  nd("healTests", 300, 900, "Heal Tests", "_healer.md · loops ≤ 3"),
  nd("finalize", 282, 1080, "Finalize", "HITL · commit-push | cleanup"),
  nd("summary", 300, 1260, "Summary", "summary.json"),
];

export const GRAPH_EDGES: Edge[] = [
  ed("setupContext", "setupBackend"),
  ed("setupContext", "setupFrontend"),
  ed("setupBackend", "setupJoin"),
  ed("setupFrontend", "setupJoin"),
  ed("setupJoin", "planTests"),
  { ...ed("planTests", "generateTests"), label: "full", style: { stroke: "#324056" } },
  // heal-only sweeps through the right gutter. `offset: 200` pushes the
  // bend ~200px right of planTests/healTests so the gutter is wide enough
  // to read; without it the edge hugs the node and looks like a glitch.
  // pathOptions lives on the SmoothStepEdge subtype in @xyflow/react v12,
  // not on the base Edge — hence the explicit cast.
  {
    ...ed("planTests", "healTests"),
    label: "heal-only",
    sourceHandle: "right",
    targetHandle: "right",
    pathOptions: { offset: 200, borderRadius: 12 },
    style: { stroke: "#324056" },
  } as SmoothStepEdgeWithPathOptions,
  ed("generateTests", "healTests"),
  ed("healTests", "finalize"),
  ed("finalize", "summary"),
];

function nd(
  id: string,
  x: number,
  y: number,
  title: string,
  subtitle: string,
): Node<FlowNodeData> {
  return {
    id,
    type: "qa",
    position: { x, y },
    data: { title, subtitle },
    draggable: false,
  };
}

function ed(source: string, target: string): Edge {
  return {
    id: `${source}->${target}`,
    source,
    target,
    type: "smoothstep",
    animated: false,
    style: { stroke: "#324056" },
  };
}
