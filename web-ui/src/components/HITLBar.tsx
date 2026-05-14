import type { UserChoice } from "../../../src/types.js";

export interface HITLBarProps {
  onChoose: (choice: UserChoice) => void;
  disabled: boolean;
  /**
   * Source of truth: state.snapshot.repo.isNewBranch from setupContext.
   *   - false → we're on an existing remote branch (open PR head, or an
   *     explicit branch directive). Pushing appends commits to the
   *     existing PR — primary action is "Commit + Push".
   *   - true  → we're on a fresh `pw/...` session branch (module/scenario
   *     runs, or a merged-PR fallthrough). The branch has no PR yet, so
   *     the primary action is "Create PR" — finalize will push and call
   *     `gh pr create`.
   * The underlying UserChoice key is `commit-push` either way; only the
   * label and hint change.
   */
  isNewBranch: boolean;
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
        key: "commit-push",
        label: "Create PR",
        hint: "commit + push the generated tests on the new session branch and open a PR via gh",
        variant: "primary",
      }
    : {
        key: "commit-push",
        label: "Commit + Push",
        hint: "commit + push generated tests on the current branch (the existing PR will pick up the new commits)",
        variant: "primary",
      };
  return [
    primary,
    {
      key: "cleanup",
      label: "Cleanup",
      hint: "rm generated tests + per-run JSON artifacts (the cloned repo is preserved)",
    },
  ];
}

export function HITLBar({ onChoose, disabled, isNewBranch }: HITLBarProps) {
  const choices = choicesFor(isNewBranch);
  return (
    <div className="hitl-bar">
      <div>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--accent)" }}>
          Awaiting your choice
        </div>
        <div className="hitl-label">
          Pipeline paused at <code>finalize</code>. Pick a terminal action.
        </div>
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
      </div>
    </div>
  );
}
