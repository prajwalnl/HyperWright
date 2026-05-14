import type { Mode, TargetType } from "../types.js";

const HEAL_KEYWORDS = [
  "fix failing",
  "fix test",
  "heal test",
  "heal failing",
  "heal only",
  "repair test",
];
const PR_RE = /#(\d+)/;
const BRANCH_RE = /\bbranch[:\s]+(\S+)/i;

export function detectMode(raw: string): Mode {
  const lower = raw.toLowerCase();
  return HEAL_KEYWORDS.some((k) => lower.includes(k)) ? "heal-only" : "full";
}

export function extractBranch(raw: string): string | null {
  const match = raw.match(BRANCH_RE);
  return match ? match[1] : null;
}

export function detectTarget(
  raw: string,
  branch: string | null,
): { target: string; targetType: TargetType } {
  const pr = raw.match(PR_RE);
  if (pr) return { target: pr[1], targetType: "pr" };
  const mod = raw.match(/\bmodule[:\s]+([\w-]+)/i);
  if (mod) return { target: mod[1], targetType: "module" };
  if (branch) return { target: branch, targetType: "branch" };
  return { target: raw.slice(0, 80), targetType: "scenario" };
}
