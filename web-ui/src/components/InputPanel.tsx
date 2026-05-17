import { useState } from "react";
import type { TargetType } from "../../../src/types.js";

export interface InputPanelProps {
  /** True when Start cannot be invoked: running / paused / stopping. */
  startDisabled: boolean;
  canStop?: boolean;
  canReset?: boolean;
  /** While true, Stop is disabled and labelled "stopping…". */
  isStopping?: boolean;
  onStart: (
    input: string,
    targetType: TargetType | undefined,
    maxHealingAttempts: number,
  ) => void;
  onStop?: () => void;
  onReset?: () => void;
}

const DEFAULT_HEAL_ATTEMPTS = 3;
const MIN_HEAL_ATTEMPTS = 1;
const MAX_HEAL_ATTEMPTS = 10;

const HINTS: Record<TargetType | "auto", string> = {
  auto: "generate tests for module: payments   ·   heal failing tests for #123",
  pr: "123",
  branch: "feature/my-branch",
  module: "payments",
  scenario: "customer can complete a refund",
};

export function InputPanel({
  startDisabled,
  canStop,
  canReset,
  isStopping,
  onStart,
  onStop,
  onReset,
}: InputPanelProps) {
  const [raw, setRaw] = useState("");
  const [kind, setKind] = useState<"auto" | TargetType>("auto");
  const [healAttempts, setHealAttempts] = useState<number>(
    DEFAULT_HEAL_ATTEMPTS,
  );

  const handleStart = () => {
    if (!raw.trim()) return;
    const message =
      kind === "auto"
        ? raw
        : kind === "pr"
          ? `generate tests for #${raw.replace(/^#/, "")}`
          : kind === "branch"
            ? `generate tests for branch: ${raw}`
            : kind === "module"
              ? `generate tests for module: ${raw}`
              : `generate tests for scenario: ${raw}`;
    const clamped = Math.max(
      MIN_HEAL_ATTEMPTS,
      Math.min(MAX_HEAL_ATTEMPTS, Math.trunc(healAttempts) || DEFAULT_HEAL_ATTEMPTS),
    );
    onStart(message, kind === "auto" ? undefined : kind, clamped);
  };

  return (
    <div className="section">
      <div className="section-title">New run</div>

      <div className="field">
        <label htmlFor="kind">Input type</label>
        <select
          id="kind"
          value={kind}
          disabled={startDisabled}
          onChange={(e) => setKind(e.target.value as typeof kind)}
        >
          <option value="auto">auto-detect from message</option>
          <option value="pr">PR number</option>
          <option value="branch">branch name</option>
          <option value="module">module name</option>
          <option value="scenario">scenario description</option>
        </select>
      </div>

      <div className="field">
        <label htmlFor="raw">Input</label>
        <textarea
          id="raw"
          rows={3}
          value={raw}
          disabled={startDisabled}
          placeholder={HINTS[kind]}
          onChange={(e) => setRaw(e.target.value)}
          style={{ resize: "vertical" }}
        />
      </div>

      <div className="field">
        <label htmlFor="heal-attempts">
          Max healing attempts ({MIN_HEAL_ATTEMPTS}–{MAX_HEAL_ATTEMPTS})
        </label>
        <input
          id="heal-attempts"
          type="number"
          min={MIN_HEAL_ATTEMPTS}
          max={MAX_HEAL_ATTEMPTS}
          step={1}
          value={healAttempts}
          disabled={startDisabled}
          onChange={(e) => {
            const n = Number(e.target.value);
            setHealAttempts(Number.isFinite(n) ? n : DEFAULT_HEAL_ATTEMPTS);
          }}
          title="How many times the healer may re-run + apply fixes before giving up"
        />
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <button
          className="primary"
          disabled={startDisabled || !raw.trim()}
          onClick={handleStart}
          style={{ flex: 1 }}
        >
          {startDisabled ? "Running…" : "Start workflow"}
        </button>
        {canStop && onStop && (
          <button
            className="danger"
            disabled={!!isStopping}
            onClick={onStop}
            title="Stop the running workflow"
          >
            {isStopping ? "Stopping…" : "Stop"}
          </button>
        )}
        {canReset && onReset && (
          <button
            className="secondary"
            onClick={onReset}
            title="Clear session and reset UI"
          >
            Reset
          </button>
        )}
      </div>
    </div>
  );
}
