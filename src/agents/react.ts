import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { ENV } from "../env.js";
import { createLLM } from "../llm.js";
import { browserTools, closeBrowser } from "../tools/browser.js";
import { fsTools } from "../tools/fs.js";

export interface AgentRunOptions {
  systemPrompt: string;
  task: string;
  extraTools?: StructuredToolInterface[];
  recursionLimit?: number;
  /**
   * Optional log sink. When set, each superstep of the ReAct loop emits a
   * line describing what the agent is doing — AI text, outgoing tool calls,
   * and returning tool results. Wire this to the node's `createNodeLogger(..)`
   * so the lines hit `logs/<node>.log` and stream to the web-ui via the
   * existing logger EventEmitter. Previously the sub-agent used
   * `agent.invoke()` and only the final message surfaced; this is what lets
   * the planner/generator/healer show live "thinking + tool use" the way
   * Claude Code / opencode do.
   */
  log?: (line: string) => void;
  /**
   * Suppress browser tools for this run. The generator agent uses this — it
   * works from the planner's already-verified plan and emits a spec file, so
   * it has no business navigating Chromium.
   */
  noBrowser?: boolean;
}

/**
 * Run a ReAct-style sub-agent. Bundles the shared fs tools + (optionally) the
 * Playwright browser tools and returns the final message content string.
 */
export async function runSubAgent(opts: AgentRunOptions): Promise<string> {
  const useBrowser = ENV.enableBrowserTools && !opts.noBrowser;
  const tools: StructuredToolInterface[] = [
    ...fsTools,
    ...(useBrowser ? browserTools : []),
    ...(opts.extraTools ?? []),
  ];
  const log = opts.log;

  const agent = createReactAgent({ llm: createLLM(), tools });
  try {
    const allMessages: BaseMessage[] = [];
    const stream = await agent.stream(
      {
        messages: [
          new SystemMessage(opts.systemPrompt),
          new HumanMessage(opts.task),
        ],
      },
      {
        recursionLimit: opts.recursionLimit ?? 1000,
        streamMode: "updates",
      },
    );

    for await (const chunk of stream) {
      for (const update of Object.values(chunk as Record<string, unknown>)) {
        const msgs =
          (update as { messages?: BaseMessage[] } | undefined)?.messages ?? [];
        for (const msg of msgs) {
          allMessages.push(msg);
          if (log) emitMessage(msg, log);
        }
      }
    }

    const last = allMessages[allMessages.length - 1];
    const content = last?.content;
    return typeof content === "string" ? content : JSON.stringify(content);
  } finally {
    if (useBrowser) {
      await closeBrowser();
    }
  }
}

function emitMessage(msg: BaseMessage, log: (line: string) => void): void {
  if (msg instanceof AIMessage) {
    const text = typeof msg.content === "string" ? msg.content.trim() : "";
    if (text) {
      for (const line of text.split("\n")) log(`[ai] ${line}`);
    }
    for (const call of msg.tool_calls ?? []) {
      log(`[call →] ${call.name} ${compactJson(call.args)}`);
    }
  } else if (msg instanceof ToolMessage) {
    const name = msg.name ?? "(unknown)";
    const result =
      typeof msg.content === "string"
        ? msg.content
        : JSON.stringify(msg.content);
    const oneLine = result.replace(/\s+/g, " ").trim();
    log(`[call ←] ${name}: ${truncate(oneLine, 240)}`);
  }
}

function compactJson(val: unknown): string {
  try {
    return truncate(JSON.stringify(val) ?? "", 160);
  } catch {
    return String(val);
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}
