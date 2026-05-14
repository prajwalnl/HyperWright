import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface LogPanelProps {
  selectedNode: string | null;
  logsByNode: Map<string, string[]>;
  globalLogs: string[];
}

/**
 * Pixels from the bottom that still count as "the user is reading the tail".
 * Bigger = more forgiving (user can scroll a few lines up without losing
 * autoscroll); too big = scrolls under their feet.
 */
const STICK_TO_BOTTOM_THRESHOLD_PX = 40;

export function LogPanel({ selectedNode, logsByNode, globalLogs }: LogPanelProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const lines = selectedNode
    ? (logsByNode.get(selectedNode) ?? [])
    : globalLogs;

  // Autoscroll only when the user is already pinned near the bottom. The
  // moment they scroll up to read, we stop yanking them back. A "Jump to
  // latest" pill re-opts them in.
  const [stickToBottom, setStickToBottom] = useState(true);

  const isNearBottom = (el: HTMLElement): boolean => {
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    return distanceFromBottom <= STICK_TO_BOTTOM_THRESHOLD_PX;
  };

  // useLayoutEffect so we measure / scroll BEFORE the browser paints the new
  // line, avoiding a visible flash of "jumped to bottom then back up".
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    if (stickToBottom) {
      // No smooth scroll — when lines arrive multiple per second, smooth
      // animation lags behind and the panel never catches up.
      el.scrollTop = el.scrollHeight;
    }
  }, [lines.length, selectedNode, stickToBottom]);

  // When the user switches between nodes, default back to sticking. They
  // probably want the tail of the freshly-selected node, not whatever scroll
  // position the previous one left at.
  useEffect(() => {
    setStickToBottom(true);
  }, [selectedNode]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    setStickToBottom(isNearBottom(e.currentTarget));
  };

  const jumpToLatest = () => {
    const el = boxRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setStickToBottom(true);
  };

  return (
    <div className="log-panel">
      <div className="log-panel-header">
        <div className="log-panel-title">
          Logs&nbsp;·&nbsp;
          <span className="node-name">{selectedNode ?? "all nodes"}</span>
        </div>
        <span
          style={{
            fontSize: 10,
            color: "var(--fg-dim)",
            fontFamily: "var(--mono)",
          }}
        >
          {lines.length} line{lines.length === 1 ? "" : "s"}
          {!stickToBottom && lines.length > 0 ? " · paused" : ""}
        </span>
      </div>
      <div className="log-box" ref={boxRef} onScroll={handleScroll}>
        {lines.length === 0 ? (
          <div style={{ color: "var(--fg-dim)" }}>
            {selectedNode
              ? `Waiting for ${selectedNode} to run…`
              : "Start a workflow to see logs."}
          </div>
        ) : (
          lines.map((line, i) => (
            <div
              key={`${line}-${i}`}
              className={`log-line ${i === lines.length - 1 ? "fresh" : ""}`}
            >
              {line}
            </div>
          ))
        )}
      </div>
      {!stickToBottom && lines.length > 0 ? (
        <button
          type="button"
          onClick={jumpToLatest}
          className="log-jump-latest"
          style={{
            position: "absolute",
            right: 16,
            bottom: 16,
            padding: "6px 12px",
            fontSize: 11,
            background: "var(--accent)",
            color: "var(--bg)",
            border: "none",
            borderRadius: 16,
            cursor: "pointer",
            fontFamily: "inherit",
            fontWeight: 600,
            boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
          }}
          title="Resume autoscroll"
        >
          ↓ Jump to latest
        </button>
      ) : null}
    </div>
  );
}
