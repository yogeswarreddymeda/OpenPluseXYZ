import type {
  ChatMessage,
  Provider,
  ProviderOptions,
  StreamChunk,
  ToolDefinition,
  Usage,
} from "./provider.js";
import { streamOpenAiCompatible } from "./openrouter.js";

const DEFAULT_BASE_URL = "http://localhost:11434/v1";

/**
 * Ollama exposes an OpenAI-compatible API at /v1, so we reuse the OpenAI
 * streaming implementation pointed at the local server. Ollama requires no
 * API key, so "ollama" is used as a placeholder bearer token.
 */
export class OllamaProvider implements Provider {
  readonly info: { name: string; model: string };

  constructor(options: ProviderOptions) {
    this.info = { name: "ollama", model: options.model };
    this.options = {
      ...options,
      apiKey: options.apiKey ?? "ollama",
      baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
    };
  }

  private readonly options: ProviderOptions;

  async *stream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamChunk> {
    yield* streamOpenAiCompatible(this.options, messages, tools, signal);
  }
}

export { streamOpenAiCompatible };
export type { Usage };