import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { FlowNodeData } from "../state/graphLayout.js";

export interface QANodeData extends FlowNodeData {
  status: "idle" | "running" | "done" | "failed" | "selected";
}

type QANodeType = Node<QANodeData, "qa">;

export function QANode({ data, selected }: NodeProps<QANodeType>) {
  const status = data.status ?? "idle";
  const cls = [
    "flow-node",
    status,
    selected ? "selected" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cls}>
      <Handle type="target" position={Position.Top} style={handleStyle} />
      <div className="node-title">{data.title}</div>
      <div className="node-sub">{data.subtitle}</div>
      <Handle type="source" position={Position.Bottom} style={handleStyle} />
      {/* Side handles let edges that need to bypass center-aligned nodes
          (the heal-only edge skipping generateTests) run through a clean
          right gutter via sourceHandle/targetHandle="right". */}
      <Handle
        id="right"
        type="source"
        position={Position.Right}
        style={sideHandleStyle}
      />
      <Handle
        id="right"
        type="target"
        position={Position.Right}
        style={sideHandleStyle}
      />
    </div>
  );
}

// Side handles are visually hidden — they only exist so right-routed edges
// have a real connection point. Setting size to 1 + transparent keeps them
// out of the way without requiring CSS overrides.
const sideHandleStyle = {
  width: 1,
  height: 1,
  background: "transparent",
  border: "none",
  opacity: 0,
};

const handleStyle = {
  width: 8,
  height: 8,
  background: "#2d2550",
  border: "2px solid #07050f",
};
