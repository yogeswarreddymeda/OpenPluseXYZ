import type {
  ChatMessage,
  Provider,
  ProviderOptions,
  StreamChunk,
  ToolCall,
  ToolDefinition,
  Usage,
} from "./provider.js";

type OpenAiToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type OpenAiMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAiToolCall[] }
  | { role: "tool"; tool_call_id?: string; content: string };

function toOpenAiMessages(messages: ChatMessage[]): OpenAiMessage[] {
  return messages.map((m) => {
    switch (m.role) {
      case "tool":
        return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
      case "assistant": {
        const toolCalls = m.toolCalls?.map((tc: ToolCall) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        }));
        return { role: "assistant", content: m.content || null, tool_calls: toolCalls };
      }
      default:
        return { role: m.role, content: m.content };
    }
  });
}

function toOpenAiTools(tools: ToolDefinition[]) {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/**
 * Stream a chat completion from any OpenAI-compatible `/chat/completions`
 * endpoint (OpenRouter, Ollama, local servers, etc.) using SSE responses.
 */
export async function* streamOpenAiCompatible(
  options: ProviderOptions,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  const baseUrl = (options.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
  const url = `${baseUrl}/chat/completions`;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.apiKey) headers["Authorization"] = `Bearer ${options.apiKey}`;

  const body: Record<string, unknown> = {
    model: options.model,
    messages: toOpenAiMessages(messages),
    tools: tools.length > 0 ? toOpenAiTools(tools) : undefined,
    stream: true,
  };
  if (options.temperature !== undefined) body["temperature"] = options.temperature;
  if (options.maxTokens !== undefined) body["max_tokens"] = options.maxTokens;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    const aborted = signal?.aborted;
    if (aborted) {
      yield { type: "done" };
    } else {
      yield { type: "error", error: `Request failed: ${String(err)}` };
    }
    return;
  }

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    yield {
      type: "error",
      error: `HTTP ${res.status} ${res.statusText}: ${text.slice(0, 1000)}`,
    };
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let usage: Usage | undefined;
  const pendingTools = new Map<number, { id: string; name: string; args: string }>();

  const flushToolCalls = function* (): Generator<StreamChunk, void, unknown> {
    for (const [index, tc] of [...pendingTools.entries()]) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.args || "{}");
      } catch {
        args = { _raw: tc.args };
      }
      yield {
        type: "tool-call",
        toolCall: { id: tc.id || `call_${index}`, name: tc.name, arguments: args },
      };
    }
    pendingTools.clear();
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;

      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }

      if (json.error) {
        yield { type: "error", error: String(json.error?.message ?? JSON.stringify(json.error)) };
        return;
      }

      const choice = json.choices?.[0];
      if (!choice) continue;

      const delta = choice.delta ?? {};
      if (typeof delta.content === "string" && delta.content) {
        yield { type: "text", text: delta.content };
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const index = tc.index ?? 0;
          const current = pendingTools.get(index) ?? { id: "", name: "", args: "" };
          if (tc.id) current.id = tc.id;
          if (tc.function?.name) current.name += tc.function.name;
          if (tc.function?.arguments) current.args += tc.function.arguments;
          pendingTools.set(index, current);
        }
      }

      if (choice.finish_reason === "tool_calls") {
        yield* flushToolCalls();
      }

      if (json.usage) {
        usage = {
          inputTokens: json.usage.prompt_tokens,
          outputTokens: json.usage.completion_tokens,
        };
      }
    }
  }

  if (pendingTools.size > 0) yield* flushToolCalls();
  yield { type: "done", usage };
}

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

export class OpenRouterProvider implements Provider {
  readonly info: { name: string; model: string };

  constructor(private readonly options: ProviderOptions) {
    this.info = { name: "openrouter", model: options.model };
  }

  async *stream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamChunk> {
    yield* streamOpenAiCompatible(
      { ...this.options, baseUrl: this.options.baseUrl ?? DEFAULT_BASE_URL },
      messages,
      tools,
      signal,
    );
  }
}