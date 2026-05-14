import { useCallback, useEffect, useRef, useState } from "react";
import type {
  StartRequest,
  WorkflowEvent,
  WorkflowSnapshot,
} from "../types.js";
import type { UserChoice } from "../../../src/types.js";

const STORAGE_KEY = "qa-workflow-state-v1";

interface PersistedState {
  snapshot: WorkflowSnapshot | null;
  currentNodes: string[];
  nextNodes: string[];
  visitedNodes: string[];
  logsByNode: Array<[string, string[]]>;
  awaitingChoice: boolean;
  finished: boolean;
  stopped: boolean;
  error: string | null;
  running: boolean;
}

function serializeState(state: WorkflowState): PersistedState {
  return {
    snapshot: state.snapshot,
    currentNodes: Array.from(state.currentNodes),
    nextNodes: Array.from(state.nextNodes),
    visitedNodes: Array.from(state.visitedNodes),
    logsByNode: Array.from(state.logsByNode.entries()),
    awaitingChoice: state.awaitingChoice,
    finished: state.finished,
    stopped: state.stopped,
    error: state.error,
    running: state.running,
  };
}

function deserializeState(persisted: PersistedState): WorkflowState {
  return {
    snapshot: persisted.snapshot,
    currentNodes: new Set(persisted.currentNodes),
    nextNodes: new Set(persisted.nextNodes),
    visitedNodes: new Set(persisted.visitedNodes),
    logsByNode: new Map(persisted.logsByNode),
    // running/awaitingChoice are live runtime flags — never restore them from
    // localStorage, or a page reload will lock the UI into a stale state
    // that nothing can clear. The SSE replay re-emits them if the server
    // is still actually paused.
    awaitingChoice: false,
    finished: persisted.finished,
    stopped: persisted.stopped ?? false,
    error: persisted.error,
    running: false,
  };
}

function loadPersistedState(): WorkflowState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedState;
    return deserializeState(parsed);
  } catch {
    return null;
  }
}

function savePersistedState(state: WorkflowState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeState(state)));
  } catch {
  }
}

export interface WorkflowState {
  snapshot: WorkflowSnapshot | null;
  currentNodes: Set<string>;
  nextNodes: Set<string>;
  visitedNodes: Set<string>;
  logsByNode: Map<string, string[]>;
  awaitingChoice: boolean;
  finished: boolean;
  stopped: boolean;
  error: string | null;
  running: boolean;
}

// Map each phase to ONLY the nodes that are guaranteed to have run once that
// phase first appears in phaseHistory. `setup` is emitted by both setupContext
// (end of parse+clone) and setupJoin (after the parallel backend/frontend
// branches fan in), so when phaseHistory first contains "setup" we can only
// say setupContext has finished — setupBackend/setupFrontend/setupJoin are
// tracked via per-chunk currentNodes as they actually complete.
const PHASE_TO_NODES: Record<string, string[]> = {
  clone: ["setupContext"],
  parse: ["setupContext"],
  setup: ["setupContext"],
  planning: ["planTests"],
  "planning-complete": ["planTests"],
  generating: ["generateTests"],
  "generating-complete": ["generateTests"],
  healing: ["healTests"],
  "healing-complete": ["healTests"],
  "awaiting-user-choice": ["finalize"],
  finalizing: ["finalize"],
  complete: ["summary"],
  failed: ["summary"],
};

const INITIAL_STATE: WorkflowState = {
  snapshot: null,
  currentNodes: new Set(),
  nextNodes: new Set(),
  visitedNodes: new Set(),
  logsByNode: new Map(),
  awaitingChoice: false,
  finished: false,
  stopped: false,
  error: null,
  running: false,
};

export function useWorkflow(): {
  state: WorkflowState;
  start: (req: StartRequest) => Promise<void>;
  resume: (choice: UserChoice) => Promise<void>;
  stop: () => Promise<void>;
  reset: () => Promise<void>;
} {
  const [state, setState] = useState<WorkflowState>(() => loadPersistedState() ?? INITIAL_STATE);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    savePersistedState(state);
  }, [state]);

  useEffect(() => {
    const es = new EventSource("/api/workflow/stream");
    esRef.current = es;

    const handler = (event: MessageEvent) => {
      try {
        const evt = JSON.parse(event.data) as WorkflowEvent;
        setState((prev) => reduce(prev, evt));
      } catch {
        /* ignore malformed */
      }
    };

    for (const t of [
      "started",
      "state",
      "log",
      "awaiting_choice",
      "finished",
      "stopped",
      "error",
    ]) {
      es.addEventListener(t, handler);
    }

    return () => es.close();
  }, []);

  const start = useCallback(async (req: StartRequest) => {
    setState(() => ({
      ...INITIAL_STATE,
      running: true,
    }));
    const res = await fetch("/api/workflow/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setState((prev) => ({
        ...prev,
        running: false,
        error: body.error ?? `HTTP ${res.status}`,
      }));
    }
  }, []);

  const resume = useCallback(async (choice: UserChoice) => {
    await fetch("/api/workflow/resume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choice }),
    });
  }, []);

  const stop = useCallback(async () => {
    await fetch("/api/workflow/stop", { method: "POST" });
  }, []);

  const reset = useCallback(async () => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {}
    await fetch("/api/workflow/clear", { method: "POST" });
    setState(INITIAL_STATE);
  }, []);

  return { state, start, resume, stop, reset };
}

function reduce(prev: WorkflowState, evt: WorkflowEvent): WorkflowState {
  switch (evt.type) {
    case "started":
      return {
        ...prev,
        running: true,
        finished: false,
        error: null,
        awaitingChoice: false,
      };
    case "state": {
      const current = new Set(evt.currentNodes);
      const next = new Set(evt.nextNodes);
      const visited = new Set(prev.visitedNodes);
      for (const n of evt.currentNodes) visited.add(n);
      for (const ph of evt.snapshot.phaseHistory) {
        for (const n of PHASE_TO_NODES[ph] ?? []) visited.add(n);
      }
      return {
        ...prev,
        snapshot: evt.snapshot,
        currentNodes: current,
        nextNodes: next,
        visitedNodes: visited,
      };
    }
    case "log": {
      const logs = new Map(prev.logsByNode);
      const arr = logs.get(evt.node) ?? [];
      logs.set(evt.node, [...arr, evt.line]);
      return { ...prev, logsByNode: logs };
    }
    case "awaiting_choice":
      return { ...prev, awaitingChoice: true };
    case "finished":
      return {
        ...prev,
        running: false,
        finished: true,
        currentNodes: new Set(),
        nextNodes: new Set(),
        awaitingChoice: false,
      };
    case "stopped":
      return {
        ...prev,
        running: false,
        stopped: true,
        currentNodes: new Set(),
        nextNodes: new Set(),
        awaitingChoice: false,
      };
    case "error":
      return { ...prev, error: evt.message, running: false };
    default:
      return prev;
  }
}
