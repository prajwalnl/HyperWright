import type { UserChoice } from "../../../src/types.js";

export interface HITLBarProps {
  onChoose: (choice: UserChoice) => void;
  /**
   * Side-effect action — fires `/api/workflow/stop-servers`. Does NOT
   * end the run or fire any UserChoice. The HITL stays open after; the
   * user can still click Create PR or Cancel.
   */
  onStopServers: () => void;
  disabled: boolean;
  /**
   * Source of truth: state.snapshot.repo.isNewBranch from setupContext.
   *   - false → we're on an existing remote branch (open PR head, or an
   *     explicit branch directive). Pushing appends commits to the
   *     existing PR — primary button label is "Commit + Push".
   *   - true  → we're on a fresh `pw/...` session branch. The branch has
   *     no PR yet, so the primary button label is "Create PR" — summary
   *     will push and call `gh pr create`.
   * The underlying UserChoice key is `create-pr` either way; only the
   * label and hint change.
   */
  isNewBranch: boolean;
  /** True when either backend or frontend is still up. Drives Stop Servers enablement. */
  serversUp: boolean;
  /**
   * First few lines of the bug report when failures terminated the heal
   * loop. Sourced from the `interrupt()` payload's `bugReportPreview`
   * field. Null when all tests passed.
   */
  bugReportPreview?: string | null;
}

interface Choice {
  key: UserChoice;
  label: string;
  hint: string;
  variant?: "primary";
}

function choicesFor(isNewBranch: boolean): Choice[] {
  const primary: Choice = isNewBranch
    ? {
        key: "create-pr",
        label: "Create PR",
        hint: "commit + push the generated tests on the new session branch and open a PR via gh (bug report embedded inline when failures exist)",
        variant: "primary",
      }
    : {
        key: "create-pr",
        label: "Commit + Push",
        hint: "commit + push generated tests on the current branch (the existing PR will pick up the new commits)",
        variant: "primary",
      };
  return [
    primary,
    {
      key: "cancel",
      label: "Cancel",
      hint: "no-op — nothing is committed, nothing is deleted. Generated tests and diagnostic artifacts stay on disk for later inspection.",
    },
  ];
}

export function HITLBar({
  onChoose,
  onStopServers,
  disabled,
  isNewBranch,
  serversUp,
  bugReportPreview,
}: HITLBarProps) {
  const choices = choicesFor(isNewBranch);
  return (
    <div className="hitl-bar">
      <div>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--accent)" }}>
          Awaiting your choice
        </div>
        <div className="hitl-label">
          Pipeline paused at <code>summary</code>. Verify the tests, then
          ship or cancel. Servers stay up for iteration — use Stop Servers
          when you're done.
        </div>
        {bugReportPreview && (
          <pre
            style={{
              marginTop: 8,
              padding: "8px 10px",
              background: "var(--bg-subtle, #faf6f0)",
              border: "1px solid var(--border, #e0d8c8)",
              borderRadius: 4,
              fontSize: 11,
              maxHeight: 160,
              overflow: "auto",
              whiteSpace: "pre-wrap",
            }}
          >
            {bugReportPreview}
          </pre>
        )}
      </div>
      <div className="hitl-actions">
        {choices.map((c) => (
          <button
            key={c.key}
            title={c.hint}
            disabled={disabled}
            className={c.variant === "primary" ? "primary" : ""}
            onClick={() => onChoose(c.key)}
          >
            {c.label}
          </button>
        ))}
        <button
          title="stop the backend + frontend servers this session started. Side-effect only — the HITL stays open, you can still pick Create PR or Cancel."
          disabled={disabled || !serversUp}
          onClick={onStopServers}
        >
          Stop Servers
        </button>
      </div>
    </div>
  );
}
