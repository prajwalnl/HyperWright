import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_PLAYBOOK } from "./playbook.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SKILLS_DIR = path.resolve(__dirname, "../../qa-skills");

async function read(name: string): Promise<string> {
  try {
    return await fs.readFile(path.join(SKILLS_DIR, name), "utf8");
  } catch {
    return "";
  }
}

export interface PromptBundle {
  skill: string;
  instructions: string;
}

export async function loadSkillContext(
  instructionFile: string,
): Promise<PromptBundle> {
  const [skill, instructions] = await Promise.all([
    read("SKILL.md"),
    read(instructionFile),
  ]);
  return { skill, instructions };
}

/**
 * System-prompt layout (top → bottom, in decreasing priority):
 *   1. Agent identity line
 *   2. The PLAYBOOK — distilled cheat-sheet the model must never forget
 *   3. SKILL.md (full)              ← reference
 *   4. <role>.md (full)             ← reference
 *   5. Run context                  ← session-specific: IDs, target, PR diff, …
 */
export function buildSystemPrompt(
  role: "playwright-planner" | "playwright-generator" | "playwright-healer",
  bundle: PromptBundle,
  extra: string,
): string {
  return [
    `You are the ${role} sub-agent from qa-skills.`,
    "",
    "The PLAYBOOK below is the cheat-sheet you must never forget. Treat it",
    "as load-bearing. The SKILL.md and role-specific spec that follow are the",
    "authoritative reference — read them as needed, but the PLAYBOOK wins",
    "when it comes to the auth flow, module URLs, selector strategy, and",
    "tool discipline.",
    "",
    "============ PLAYBOOK ============",
    AGENT_PLAYBOOK,
    "",
    "============ SKILL.md ============",
    bundle.skill,
    "",
    `============ ${role}.md ============`,
    bundle.instructions,
    "",
    "============ RUN CONTEXT ============",
    extra,
  ].join("\n");
}
