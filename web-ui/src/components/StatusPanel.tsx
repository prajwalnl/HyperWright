import type { WorkflowSnapshot } from "../types.js";

export interface StatusPanelProps {
  snapshot: WorkflowSnapshot | null;
  running: boolean;
  finished: boolean;
  error: string | null;
}

export function StatusPanel({
  snapshot,
  running,
  finished,
  error,
}: StatusPanelProps) {
  const s = snapshot;
  const isFailed = s?.status === "failed" || !!error;

  const runLabel = isFailed
    ? "failed"
    : finished
      ? "complete"
      : running
        ? "running"
        : "idle";

  return (
    <>
      <div className="section">
        <div className="section-title">Run</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <span className={`status-badge status-${runLabel}`}>
            <span className="status-dot" />
            {runLabel}
          </span>
          {s?.mode && (
            <span className="status-badge status-idle">
              <span className="status-dot" />
              {s.mode}
            </span>
          )}
          {s?.targetType && s?.target && (
            <span
              className="status-badge status-idle"
              title={`${s.targetType}:${s.target}`}
            >
              {s.targetType}:{s.target}
            </span>
          )}
        </div>
        {s?.sessionId && (
          <div
            style={{
              fontSize: 10,
              color: "var(--fg-dim)",
              fontFamily: "var(--mono)",
              marginTop: 4,
            }}
          >
            {s.sessionId.slice(0, 8)}…{s.sessionId.slice(-8)}
          </div>
        )}
      </div>

      <div className="section">
        <div className="section-title">Services</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <span
            className={`status-badge ${
              s?.servers.backendUp ? "status-up" : "status-down"
            }`}
          >
            <span className="status-dot" />
            backend
          </span>
          <span
            className={`status-badge ${
              s?.servers.frontendUp ? "status-up" : "status-down"
            }`}
          >
            <span className="status-dot" />
            frontend
          </span>
        </div>
      </div>

      <div className="section">
        <div className="section-title">Metrics</div>
        <div className="metric-grid">
          <Metric label="Planned" value={s?.metrics.testsPlanned ?? 0} />
          <Metric label="Generated" value={s?.metrics.testsGenerated ?? 0} />
          <Metric label="Passed" value={s?.metrics.testsPassed ?? 0} />
          <Metric label="Failed" value={s?.metrics.testsFailed ?? 0} />
          <Metric label="Fixed" value={s?.metrics.testsFixed ?? 0} />
          <Metric label="Heal-attempts" value={s?.metrics.healingAttempts ?? 0} />
        </div>
      </div>

      {s?.generatedFiles && s.generatedFiles.length > 0 && (
        <div className="section">
          <div className="section-title">Generated files</div>
          <div
            style={{
              fontFamily: "var(--mono)",
              fontSize: 11,
              color: "var(--fg-muted)",
              lineHeight: 1.7,
              wordBreak: "break-all",
            }}
          >
            {s.generatedFiles.map((f) => (
              <div key={f}>{f}</div>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div className="section">
          <div className="section-title">Error</div>
          <div
            style={{
              fontFamily: "var(--mono)",
              fontSize: 11,
              color: "var(--error)",
              background: "rgba(255, 103, 115, 0.08)",
              border: "1px solid rgba(255, 103, 115, 0.25)",
              padding: 10,
              borderRadius: 6,
              whiteSpace: "pre-wrap",
            }}
          >
            {error}
          </div>
        </div>
      )}
    </>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="metric-card">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
    </div>
  );
}
