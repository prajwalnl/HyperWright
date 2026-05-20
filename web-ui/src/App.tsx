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
  const { state, start, resume, stop, stopServers, reset } = useWorkflow();
  const [selectedNode, setSelectedNode] = useState<string | null>(null);

  const [localStart, setLocalStart] = useState<number | null>(null);
  const [frozenMs, setFrozenMs] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // All UI state derives from runStatus. Keeping the derivations in one
  // block (instead of scattering `state.running` / `state.finished` checks
  // across the component) makes the button-enablement table the only place
  // that needs to change when the lifecycle grows new states.
  const isRunning = state.runStatus === "running";
  const isPaused = state.runStatus === "paused";
  const isStopping = state.runStatus === "stopping";
  const isStopped = state.runStatus === "stopped";
  const isComplete = state.runStatus === "complete";
  const isFailedStatus = state.runStatus === "failed";
  const isTerminal = isStopped || isComplete || isFailedStatus;
  // Active = the run is occupying the system in any non-terminal, non-idle
  // sense (graph running, paused at HITL, or unwinding stop). Used to drive
  // the elapsed-time ticker and to disable Reset.
  const isActive = isRunning || isPaused || isStopping;

  useEffect(() => {
    if (!isActive) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isActive]);

  useEffect(() => {
    if (isActive) {
      setFrozenMs(null);
      return;
    }
    if (!isTerminal && !state.error) return;
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
    isActive,
    isTerminal,
    state.error,
    state.snapshot?.startedAt,
    state.snapshot?.completedAt,
    localStart,
  ]);

  const failed = state.snapshot?.status === "failed" || isFailedStatus || !!state.error;
  const hasSession = !!state.snapshot || isTerminal;
  // Source of truth for "is there anything to tear down right now". Drives
  // the Stop Servers button enablement in both the sidebar and HITL bar.
  // Reads the snapshot (live or restored) rather than runStatus — servers
  // can outlive a completed run because teardown is user-triggered.
  const serversUp =
    !!state.snapshot?.servers.backendUp ||
    !!state.snapshot?.servers.frontendUp;

  const snapStart = state.snapshot?.startedAt
    ? Date.parse(state.snapshot.startedAt)
    : null;
  const startMs = snapStart ?? localStart;
  const elapsedMs =
    frozenMs != null
      ? frozenMs
      : startMs != null && isActive
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
              className={`run-timer ${isActive ? "running" : "frozen"}`}
              title={
                isActive
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
            const label: Record<typeof state.runStatus, string> = {
              idle: "ready",
              running: "live",
              paused: "paused",
              stopping: "stopping…",
              stopped: "stopped",
              complete: failed ? "failed" : "finished",
              failed: "failed",
            };
            const cls: Record<typeof state.runStatus, string> = {
              idle: "status-idle",
              running: "status-running",
              paused: "status-running",
              stopping: "status-running",
              stopped: "status-failed",
              complete: failed ? "status-failed" : "status-complete",
              failed: "status-failed",
            };
            return (
              <span className={`status-badge ${cls[state.runStatus]}`}>
                <span className="status-dot" />
                {label[state.runStatus]}
              </span>
            );
          })()}
        </div>
      </header>

      <aside className="panel panel-left">
        <InputPanel
          // Button-enablement table per the lifecycle spec:
          //   idle    : Start ✓  Stop ✗  Reset ✗
          //   running : Start ✗  Stop ✓  Reset ✗  (must Stop first)
          //   paused  : Start ✗  Stop ✓  Reset ✗  (Stop allowed at HITL)
          //   stopping: Start ✗  Stop ✗  Reset ✗  (spinner; wait for stopped)
          //   stopped : Start ✓  Stop ✗  Reset ✓
          //   failed  : Start ✓  Stop ✗  Reset ✓
          //   complete: Start ✓  Stop ✗  Reset ✓
          startDisabled={isActive}
          canStop={isRunning || isPaused}
          canReset={hasSession && isTerminal}
          isStopping={isStopping}
          onStart={handleStart}
          onStop={handleStop}
          onReset={handleReset}
        />
        <StatusPanel
          snapshot={state.snapshot}
          running={isRunning}
          finished={isComplete || isFailedStatus}
          error={state.error}
        />
        {/*
         * Always-available "Stop Servers" — independent of runStatus so
         * the user can tear down servers between runs, after a failure,
         * or while a HITL is open. Disabled when nothing is up.
         */}
        <div className="section">
          <div className="section-title">Servers</div>
          <button
            className="secondary"
            disabled={!serversUp}
            onClick={() => void stopServers()}
            title="stop the backend + frontend this session started. Servers are kept alive across runs so iteration is fast — click this when you're done."
            style={{ width: "100%" }}
          >
            {serversUp ? "Stop Servers" : "Servers down"}
          </button>
        </div>
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
        {isPaused && (
          <HITLBar
            onChoose={resume}
            onStopServers={() => void stopServers()}
            disabled={!isPaused}
            isNewBranch={state.snapshot?.repo?.isNewBranch ?? false}
            serversUp={serversUp}
            bugReportPreview={state.interruptPayload?.bugReportPreview ?? null}
          />
        )}
      </aside>
    </div>
  );
}
