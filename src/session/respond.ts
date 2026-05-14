import { writeSession } from "./sessionFile.js";
import type { QAStateType, QAStateUpdate } from "../state.js";
import type { SessionFile } from "../types.js";

/**
 * Every node writes the same three lines at the end:
 *
 *   const patch = { ... };
 *   await writeSession({ ...state, ...patch } as QAStateType);
 *   return patch;
 *
 * `respond` collapses that to one call while still returning the QAStateUpdate
 * the graph expects.
 */
export async function respond(
  state: QAStateType,
  patch: QAStateUpdate,
  sessionPatch: Partial<SessionFile> = {},
): Promise<QAStateUpdate> {
  await writeSession({ ...state, ...patch } as QAStateType, sessionPatch);
  return patch;
}
