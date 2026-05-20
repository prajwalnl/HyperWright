import { readJson, writeJson } from "./files.js";
import { sessionPaths } from "./paths.js";
import type { QAStateType } from "../state.js";
import type { SessionFile } from "../types.js";

/**
 * Build a SessionFile snapshot from the current graph state. This matches the
 * session.json schema in orchestrator.md Step 1.
 */
export function buildSessionFile(state: QAStateType): SessionFile {
  return {
    sessionId: state.sessionId,
    mode: state.mode,
    status: state.status,
    phase: state.phase,
    startedAt: state.startedAt,
    completedAt: state.completedAt || undefined,
    servers: state.servers,
    metrics: state.metrics,
    error: state.error,
    userChoice: state.userChoice,
    creds: state.creds,
    branch: state.repo.repoBranch,
  };
}

/**
 * Surgical merge-write: read existing session.json (if any), shallow-merge the
 * patch, and write back. Mirrors the "Follow File Editing Guidelines: use
 * surgical edits" rule in SKILL.md.
 */
export async function writeSession(
  state: QAStateType,
  patch: Partial<SessionFile> = {},
): Promise<void> {
  const paths = sessionPaths(state.sessionDir);
  const existing = (await readJson<SessionFile>(paths.session)) ?? null;
  const snapshot = buildSessionFile(state);
  const merged: SessionFile = { ...(existing ?? {}), ...snapshot, ...patch };
  await writeJson(paths.session, merged);
}
