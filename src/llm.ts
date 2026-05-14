import { ChatOpenAI } from "@langchain/openai";
import { ENV } from "./env.js";

/**
 * Any OpenAI-compatible endpoint works here: litellm proxy, OpenAI, OpenRouter,
 * Together, Anthropic via litellm, etc. Configure via .env — see .env.example.
 */
export function createLLM(overrides: Partial<{
  temperature: number;
  maxTokens: number;
  model: string;
}> = {}): ChatOpenAI {
  return new ChatOpenAI({
    model: overrides.model ?? ENV.litellm.model,
    apiKey: ENV.litellm.apiKey,
    temperature: overrides.temperature ?? ENV.litellm.temperature,
    maxTokens: overrides.maxTokens ?? ENV.litellm.maxTokens,
    configuration: { baseURL: ENV.litellm.baseURL },
  });
}
