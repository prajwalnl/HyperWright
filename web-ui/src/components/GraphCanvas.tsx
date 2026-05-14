import { useMemo } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { GRAPH_EDGES, GRAPH_NODES, type FlowNodeData } from "../state/graphLayout.js";
import { QANode, type QANodeData } from "./QANode.js";

export interface GraphCanvasProps {
  currentNodes: Set<string>;
  nextNodes: Set<string>;
  visitedNodes: Set<string>;
  failed: boolean;
  selectedNode: string | null;
  onSelect: (id: string) => void;
  onPaneClick?: () => void;
}

const nodeTypes = { qa: QANode };

export function GraphCanvas({
  currentNodes: _currentNodes,
  nextNodes,
  visitedNodes,
  failed,
  selectedNode,
  onSelect,
  onPaneClick,
}: GraphCanvasProps) {
  const nodes = useMemo<Node<FlowNodeData>[]>(
    () =>
      GRAPH_NODES.map((n) => {
        const isRunning = nextNodes.has(n.id);
        const isVisited = visitedNodes.has(n.id);
        const isTerminalFail = failed && n.id === "summary";
        const status: QANodeData["status"] = isRunning
          ? "running"
          : isTerminalFail
            ? "failed"
            : isVisited
              ? "done"
              : "idle";
        return {
          ...n,
          selected: selectedNode === n.id,
          data: { ...n.data, status } as unknown as FlowNodeData,
        };
      }),
    [nextNodes, visitedNodes, failed, selectedNode],
  );

  const edges = useMemo<Edge[]>(
    () =>
      GRAPH_EDGES.map((e) => {
        const active =
          visitedNodes.has(e.source) &&
          (visitedNodes.has(e.target) || nextNodes.has(e.target));
        return {
          ...e,
          animated: nextNodes.has(e.target) && visitedNodes.has(e.source),
          style: {
            stroke: active ? "#a896ff" : "#2d2550",
            strokeWidth: active ? 2 : 1.5,
            transition: "stroke 240ms ease",
          },
          labelStyle: {
            fill: "#9690b8",
            fontSize: 10,
            fontFamily: "JetBrains Mono, monospace",
          },
          labelBgStyle: { fill: "#110d1e", fillOpacity: 0.92 },
          labelBgPadding: [4, 4] as [number, number],
          labelBgBorderRadius: 6,
        };
      }),
    [nextNodes, visitedNodes],
  );

  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={(_, n) => onSelect(n.id)}
        onPaneClick={onPaneClick}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
        panOnDrag
        zoomOnScroll
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={24}
          size={1}
          color="#231c3d"
        />
        <Controls showInteractive={false} position="top-right" />
        <MiniMap
          position="bottom-right"
          pannable
          style={{
            background: "rgba(17, 13, 30, 0.85)",
            border: "1px solid #1e1934",
            borderRadius: 12,
          }}
          nodeColor={(n) => {
            const s = ((n.data as FlowNodeData)?.status as string) ?? "idle";
            if (s === "running") return "#a896ff";
            if (s === "done") return "#4ed8a3";
            if (s === "failed") return "#ff6b85";
            return "#2d2550";
          }}
          maskColor="rgba(7, 5, 15, 0.75)"
        />
      </ReactFlow>
      <Legend />
    </div>
  );
}

function Legend() {
  return (
    <div className="legend">
      <div className="legend-item" style={{ color: "#a896ff" }}>
        <span className="legend-swatch" style={{ background: "#a896ff" }} /> running
      </div>
      <div className="legend-item" style={{ color: "#4ed8a3" }}>
        <span className="legend-swatch" style={{ background: "#4ed8a3" }} /> done
      </div>
      <div className="legend-item" style={{ color: "#ff6b85" }}>
        <span className="legend-swatch" style={{ background: "#ff6b85" }} /> failed
      </div>
      <div className="legend-item" style={{ color: "#605a80" }}>
        <span className="legend-swatch" style={{ background: "#605a80", boxShadow: "none" }} /> idle
      </div>
    </div>
  );
}
