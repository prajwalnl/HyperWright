import { useEffect, useState } from "react";
import { GraphCanvas } from "./components/GraphCanvas.js";
import { HITLBar } from "./components/HITLBar.js";
import { InputPanel } from "./components/InputPanel.js";
import { LogPanel } from "./components/LogPanel.js";
import { StatusPanel } from "./components/StatusPanel.js";
import { useWorkflow } from "./hooks/useWorkflow.js";
import type { TargetType } from "../../src/types.js";

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
}

export function App() {
  const { state, start, resume, stop, reset } = useWorkflow();
  const [selectedNode, setSelectedNode] = useState<string | null>(null);

  const [localStart, setLocalStart] = useState<number | null>(null);
  const [frozenMs, setFrozenMs] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!state.running) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [state.running]);

  useEffect(() => {
    if (state.running) {
      setFrozenMs(null);
      return;
    }
    const ended = state.finished || state.stopped || !!state.error;
    if (!ended) return;
    const snapStart = state.snapshot?.startedAt
      ? Date.parse(state.snapshot.startedAt)
      : null;
    const snapEnd = state.snapshot?.completedAt
      ? Date.parse(state.snapshot.completedAt)
      : null;
    const s = snapStart ?? localStart;
    const e = snapEnd ?? Date.now();
    if (s != null) setFrozenMs(e - s);
  }, [
    state.running,
    state.finished,
    state.stopped,
    state.error,
    state.snapshot?.startedAt,
    state.snapshot?.completedAt,
    localStart,
  ]);

  const failed = state.snapshot?.status === "failed" || !!state.error;
  const hasSession = !!state.snapshot || state.finished || !!state.error || state.stopped;

  const snapStart = state.snapshot?.startedAt
    ? Date.parse(state.snapshot.startedAt)
    : null;
  const startMs = snapStart ?? localStart;
  const elapsedMs =
    frozenMs != null
      ? frozenMs
      : startMs != null && state.running
        ? now - startMs
        : null;

  const handleStart = (
    input: string,
    targetType: TargetType | undefined,
    maxHealingAttempts: number,
  ) => {
    setSelectedNode(null);
    setLocalStart(Date.now());
    setFrozenMs(null);
    setNow(Date.now());
    void start({ rawInput: input, targetType, maxHealingAttempts });
  };

  const handleStop = () => {
    void stop();
  };

  const handleReset = () => {
    setSelectedNode(null);
    setLocalStart(null);
    setFrozenMs(null);
    void reset();
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="logo">
          <span className="logo-dot" />
          <h1>HyperWright</h1>
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          {elapsedMs != null && (
            <span
              className={`run-timer ${state.running ? "running" : "frozen"}`}
              title={
                state.running
                  ? "Elapsed — workflow is running"
                  : "Elapsed — workflow has ended"
              }
            >
              <svg
                className="run-timer-icon"
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <circle cx="12" cy="13" r="8" />
                <path d="M12 9v4l2.5 2.5" />
                <path d="M9 2h6" />
              </svg>
              <span className="run-timer-value">{formatElapsed(elapsedMs)}</span>
            </span>
          )}
          {(() => {
            const label = state.awaitingChoice
              ? "paused"
              : state.running
                ? "live"
                : state.stopped
                  ? "stopped"
                  : state.finished
                    ? failed
                      ? "failed"
                      : "finished"
                    : "ready";
            const cls = state.awaitingChoice
              ? "status-running"
              : state.running
                ? "status-running"
                : state.stopped
                  ? "status-failed"
                  : state.finished
                    ? failed
                      ? "status-failed"
                      : "status-complete"
                    : "status-idle";
            return (
              <span className={`status-badge ${cls}`}>
                <span className="status-dot" />
                {label}
              </span>
            );
          })()}
        </div>
      </header>

      <aside className="panel panel-left">
        <InputPanel
          disabled={state.running}
          canStop={state.running && !state.awaitingChoice}
          canReset={hasSession}
          onStart={handleStart}
          onStop={handleStop}
          onReset={handleReset}
        />
        <StatusPanel
          snapshot={state.snapshot}
          running={state.running}
          finished={state.finished}
          error={state.error}
        />
      </aside>

      <main className="panel panel-center">
        <GraphCanvas
          currentNodes={state.currentNodes}
          nextNodes={state.nextNodes}
          visitedNodes={state.visitedNodes}
          failed={failed}
          selectedNode={selectedNode}
          onSelect={(id) => setSelectedNode((prev) => (prev === id ? null : id))}
          onPaneClick={() => setSelectedNode(null)}
        />
        {state.error && <div className="toast error">{state.error}</div>}
      </main>

      <aside className="panel panel-right">
        <LogPanel
          selectedNode={selectedNode}
          logsByNode={state.logsByNode}
          globalLogs={state.snapshot?.logs ?? []}
        />
        {state.awaitingChoice && (
          <HITLBar
            onChoose={resume}
            disabled={!state.awaitingChoice}
            isNewBranch={state.snapshot?.repo?.isNewBranch ?? false}
          />
        )}
      </aside>
    </div>
  );
}
