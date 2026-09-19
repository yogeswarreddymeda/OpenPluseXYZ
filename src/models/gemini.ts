import type {
  ChatMessage,
  Provider,
  ProviderOptions,
  StreamChunk,
  ToolCall,
  ToolDefinition,
  Usage,
} from "./provider.js";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_MODEL = "gemini-2.5-flash";

type GeminiFunctionCall = {
  name?: string;
  args?: Record<string, unknown>;
};

type GeminiPart =
  | { text?: string }
  | { functionCall?: GeminiFunctionCall }
  | {
      functionResponse?: {
        name: string;
        response: Record<string, unknown>;
      };
    };

type GeminiContent = {
  role: "user" | "model";
  parts: GeminiPart[];
};

type GeminiCandidate = {
  content?: { role?: string; parts?: GeminiPart[] };
  finishReason?: string;
};

export function toGeminiContents(messages: ChatMessage[]): GeminiContent[] {
  const contents: GeminiContent[] = [];
  for (const m of messages) {
    switch (m.role) {
      case "system":
        break;
      case "tool":
        contents.push({
          role: "user",
          parts: [
            {
              functionResponse: {
                name: m.name ?? "unknown_tool",
                response: { result: m.content },
              },
            },
          ],
        });
        break;
      case "assistant": {
        const parts: GeminiPart[] = [];
        if (m.content) parts.push({ text: m.content });
        for (const tc of m.toolCalls ?? []) {
          parts.push({ functionCall: { name: tc.name, args: tc.arguments } });
        }
        contents.push({ role: "model", parts });
        break;
      }
      default:
        contents.push({ role: "user", parts: [{ text: m.content }] });
    }
  }
  return contents;
}

function toGeminiTools(tools: ToolDefinition[]) {
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    },
  ];
}

function isFunctionCall(p: GeminiPart): p is { functionCall: GeminiFunctionCall } {
  return !!(p as { functionCall?: GeminiFunctionCall }).functionCall?.name;
}

function extractToolCalls(parts: GeminiPart[]): ToolCall[] {
  const calls: ToolCall[] = [];
  let seq = 0;
  for (const p of parts) {
    if (isFunctionCall(p)) {
      const name = p.functionCall.name ?? "unknown_tool";
      calls.push({
        id: `call_${name}_${seq}`,
        name,
        arguments: p.functionCall.args ?? {},
      });
      seq++;
    }
  }
  return calls;
}

export function extractText(parts: GeminiPart[]): string {
  return parts
    .filter((p): p is { text: string } => typeof (p as { text?: string }).text === "string")
    .map((p) => (p as { text: string }).text)
    .join("");
}

/**
 * Stream a completion from the native Gemini REST API over SSE. Distinguishes
 * text from function-call parts and reports token usage from usageMetadata.
 */
export async function* streamGemini(
  options: ProviderOptions,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const model = options.model || DEFAULT_MODEL;
  const url = `${baseUrl}/models/${model}:streamGenerateContent?alt=sse&key=${options.apiKey ?? ""}`;

  const systemInstruction = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n");

  const generationConfig: Record<string, unknown> = {};
  if (options.temperature !== undefined) generationConfig["temperature"] = options.temperature;
  if (options.maxTokens !== undefined) generationConfig["maxOutputTokens"] = options.maxTokens;

  const body: Record<string, unknown> = {
    contents: toGeminiContents(messages),
  };
  if (systemInstruction) body["systemInstruction"] = { parts: [{ text: systemInstruction }] };
  if (tools.length > 0) body["tools"] = toGeminiTools(tools);
  if (Object.keys(generationConfig).length > 0) body["generationConfig"] = generationConfig;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    yield signal?.aborted
      ? { type: "done" }
      : { type: "error", error: `Request failed: ${String(err)}` };
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

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const raw of lines) {
      const matched = raw.trim().match(/^data:\s*(.*)$/);
      if (!matched) continue;
      const data = matched[1].trim();
      if (!data) continue;

      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }

      if (json.error) {
        yield {
          type: "error",
          error: String(json.error?.message ?? JSON.stringify(json.error)),
        };
        return;
      }

      const candidate: GeminiCandidate | undefined = json.candidates?.[0];
      if (candidate?.content?.parts) {
        const parts = candidate.content.parts;
        const calls = extractToolCalls(parts);
        if (calls.length > 0) {
          for (const call of calls) yield { type: "tool-call", toolCall: call };
        }
        const text = extractText(parts);
        if (text) yield { type: "text", text };
      }

      if (json.usageMetadata) {
        usage = {
          inputTokens: json.usageMetadata.promptTokenCount,
          outputTokens: json.usageMetadata.candidatesTokenCount,
        };
      }
    }
  }

  yield { type: "done", usage };
}

export class GeminiProvider implements Provider {
  readonly info: { name: string; model: string };

  constructor(options: ProviderOptions) {
    this.info = { name: "gemini", model: options.model || DEFAULT_MODEL };
    this.options = options;
  }

  private readonly options: ProviderOptions;

  async *stream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamChunk> {
    yield* streamGemini(this.options, messages, tools, signal);
  }
}