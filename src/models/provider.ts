import { GeminiProvider } from "./gemini.js";
import { OllamaProvider } from "./ollama.js";
import { OpenRouterProvider } from "./openrouter.js";

/** Role of a chat participant. `tool` messages carry the result of a tool call. */
export type Role = "system" | "user" | "assistant" | "tool";

/** A tool invocation requested by the model. */
export interface ToolCall {
  id: string;
  name: string;
  /** Parsed JSON arguments for the tool. */
  arguments: Record<string, unknown>;
}

/** A single message in the conversation history. */
export interface ChatMessage {
  role: Role;
  content: string;
  /** Name of the tool that produced the result (for `tool` messages). */
  name?: string;
  /** Id of the tool call this message answers (for `tool` messages). */
  toolCallId?: string;
  /** Tool calls requested by the model (for `assistant` messages). */
  toolCalls?: ToolCall[];
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
}

/** An event emitted while streaming a provider response. */
export type StreamChunk =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCall: ToolCall }
  | { type: "done"; usage?: Usage }
  | { type: "error"; error: string };

export interface ProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

/** JSON-schema style description of a callable tool, understood by all providers. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** A model provider capable of streaming chat completions with tool usage. */
export interface Provider {
  readonly info: { name: string; model: string };
  stream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamChunk>;
}

export function createProvider(kind: string, opts: ProviderOptions): Provider {
  switch (kind) {
    case "openrouter":
      return new OpenRouterProvider(opts);
    case "gemini":
      return new GeminiProvider(opts);
    case "ollama":
      return new OllamaProvider(opts);
    default:
      throw new Error(`Unknown provider: "${kind}" (expected openrouter, gemini, or ollama)`);
  }
}