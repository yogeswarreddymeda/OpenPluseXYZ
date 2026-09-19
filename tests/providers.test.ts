import { afterEach, describe, expect, it, vi } from "vitest";
import {
  streamOpenAiCompatible,
  streamGemini,
  type ChatMessage,
  type ProviderOptions,
  type StreamChunk,
  type ToolDefinition,
} from "../src/models/index.js";

const NO_TOOLS: ToolDefinition[] = [];
const MESSAGES: ChatMessage[] = [{ role: "user", content: "hi" }];

const OPENROUTER_OPTS: ProviderOptions = {
  model: "test-model",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: "test-key",
};

const GEMINI_OPTS: ProviderOptions = {
  model: "gemini-2.5-flash",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  apiKey: "gemini-key",
};

function sseResponse(opts: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  chunks?: string[];
  errorText?: string;
  chunksDelayMs?: number;
}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of opts.chunks ?? []) {
        controller.enqueue(encoder.encode(chunk));
        if (opts.chunksDelayMs) await new Promise((r) => setTimeout(r, opts.chunksDelayMs));
      }
      controller.close();
    },
  });
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    statusText: opts.statusText ?? "OK",
    headers: new Headers(),
    body: opts.ok === false ? null : stream,
    text: async () => opts.errorText ?? "",
  } as unknown as Response;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockFetch(response: Response | ((init: RequestInit) => Promise<Response>)) {
  let latestInit: RequestInit | undefined;
  let latestUrl: string = "";
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    latestUrl = String(url);
    latestInit = init;
    if (typeof response === "function") return response(init ?? {});
    return response;
  });
  vi.stubGlobal("fetch", fn);
  return { fn, latestInit: () => latestInit, latestUrl: () => latestUrl };
}

async function collect(
  gen: AsyncGenerator<StreamChunk>,
): Promise<{ chunks: StreamChunk[]; text: string; error?: string }> {
  const chunks: StreamChunk[] = [];
  let text = "";
  for await (const c of gen) {
    chunks.push(c);
    if (c.type === "text") text += c.text;
  }
  const errorChunk = chunks.find((c) => c.type === "error");
  return { chunks, text, error: errorChunk && errorChunk.type === "error" ? errorChunk.error : undefined };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("streamOpenAiCompatible (OpenRouter/OpenAI-compatible) with mocked fetch", () => {
  it("streams text deltas", async () => {
    const { latestInit } = mockFetch(
      sseResponse({
        chunks: [
          'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
          'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}\n\n',
          "data: [DONE]\n\n",
        ],
      }),
    );
    const { chunks, text } = await collect(
      streamOpenAiCompatible(OPENROUTER_OPTS, MESSAGES, NO_TOOLS),
    );
    expect(text).toBe("Hello world");
    expect(chunks[chunks.length - 1]).toMatchObject({ type: "done" });
    expect(chunks.some((c) => c.type === "error")).toBe(false);
    const init = latestInit();
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-key");
  });

  it("assembles split tool-call deltas into one tool-call chunk", async () => {
    mockFetch(
      sseResponse({
        chunks: [
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"path\\":\\"a"}}]},"finish_reason":null}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"pp.ts\\"}"}}]},"finish_reason":null}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
          "data: [DONE]\n\n",
        ],
      }),
    );
    const { chunks } = await collect(streamOpenAiCompatible(OPENROUTER_OPTS, MESSAGES, NO_TOOLS));
    const calls = chunks.filter((c) => c.type === "tool-call");
    expect(calls).toHaveLength(1);
    if (calls[0].type === "tool-call") {
      expect(calls[0].toolCall).toMatchObject({ id: "call_1", name: "read_file" });
      expect(calls[0].toolCall.arguments).toEqual({ path: "app.ts" });
    }
  });

  it("flushes pending tool calls at the end of the stream", async () => {
    mockFetch(
      sseResponse({
        chunks: [
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","function":{"name":"grep","arguments":"{}"}}]},"finish_reason":null}]}\n\n',
          "data: [DONE]\n\n",
        ],
      }),
    );
    const { chunks } = await collect(streamOpenAiCompatible(OPENROUTER_OPTS, MESSAGES, NO_TOOLS));
    const calls = chunks.filter((c) => c.type === "tool-call");
    expect(calls).toHaveLength(1);
  });

  it("skips malformed SSE/JSON without crashing and completes", async () => {
    mockFetch(
      sseResponse({
        chunks: [
          "data: {\"choices\" ",
          "data: not-json-at-all\n\n",
          "event: ping\ndata: {}\n\n",
          'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
          'data: {"choices":[]}\n\n',
          "data: [DONE]\n\n",
        ],
      }),
    );
    const { chunks, text, error } = await collect(
      streamOpenAiCompatible(OPENROUTER_OPTS, MESSAGES, NO_TOOLS),
    );
    expect(error).toBeUndefined();
    expect(text).toBe("ok");
    expect(chunks[chunks.length - 1]).toMatchObject({ type: "done" });
  });

  it("reports HTTP errors with status and body", async () => {
    mockFetch(
      sseResponse({ ok: false, status: 401, statusText: "Unauthorized", errorText: "bad key" }),
    );
    const { error } = await collect(streamOpenAiCompatible(OPENROUTER_OPTS, MESSAGES, NO_TOOLS));
    expect(error).toContain("HTTP 401");
    expect(error).toContain("bad key");
  });

  it("reports provider error bodies", async () => {
    mockFetch(sseResponse({ chunks: ['data: {"error":{"message":"rate limited"}}\n\n'] }));
    const { error } = await collect(streamOpenAiCompatible(OPENROUTER_OPTS, MESSAGES, NO_TOOLS));
    expect(error).toBe("rate limited");
  });

  it("extracts usage from prompt_tokens/completion_tokens", async () => {
    mockFetch(
      sseResponse({
        chunks: [
          'data: {"choices":[{"delta":{"content":"x"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n',
          "data: [DONE]\n\n",
        ],
      }),
    );
    const { chunks } = await collect(streamOpenAiCompatible(OPENROUTER_OPTS, MESSAGES, NO_TOOLS));
    const done = chunks[chunks.length - 1];
    expect(done).toMatchObject({ type: "done", usage: { inputTokens: 10, outputTokens: 2 } });
  });

  it("yields done when aborted before the request", async () => {
    const ac = new AbortController();
    ac.abort();
    mockFetch(async () => {
      throw ac.signal.reason;
    });
    const { chunks, error } = await collect(
      streamOpenAiCompatible(OPENROUTER_OPTS, MESSAGES, NO_TOOLS, ac.signal),
    );
    expect(error).toBeUndefined();
    expect(chunks).toMatchObject([{ type: "done" }]);
  });

  it("yields an error chunk on a failed request that was not aborted", async () => {
    mockFetch(async () => {
      throw new TypeError("fetch failed");
    });
    const { error } = await collect(streamOpenAiCompatible(OPENROUTER_OPTS, MESSAGES, NO_TOOLS));
    expect(error).toContain("fetch failed");
  });
});

describe("streamGemini with mocked fetch", () => {
  it("streams text parts and reports usage", async () => {
    const { latestInit, latestUrl } = mockFetch(
      sseResponse({
        chunks: [
          'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Hello "}]},"finishReason":null}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":3}}\n\n',
          'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"world"}]},"finishReason":"STOP"}]}\n\n',
          "data: {}\n\n",
        ],
      }),
    );
    const { chunks, text } = await collect(streamGemini(GEMINI_OPTS, MESSAGES, NO_TOOLS));
    expect(text).toBe("Hello world");
    const done = chunks[chunks.length - 1];
    expect(done).toMatchObject({ type: "done", usage: { inputTokens: 5, outputTokens: 3 } });
    const init = latestInit();
    expect(latestUrl()).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=gemini-key",
    );
    expect(String(init.body)).toContain('"contents"');
  });

  it("extracts function calls from parts", async () => {
    mockFetch(
      sseResponse({
        chunks: [
          'data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"write_file","args":{"path":"a.txt","content":"x"}}}]},"finishReason":"STOP"}]}\n\n',
        ],
      }),
    );
    const { chunks } = await collect(streamGemini(GEMINI_OPTS, MESSAGES, NO_TOOLS));
    const calls = chunks.filter((c) => c.type === "tool-call");
    expect(calls).toHaveLength(1);
    if (calls[0].type === "tool-call") {
      expect(calls[0].toolCall).toMatchObject({
        name: "write_file",
        arguments: { path: "a.txt", content: "x" },
      });
    }
  });

  it("gives every function call in one response a unique, stable id (same tool twice)", async () => {
    mockFetch(
      sseResponse({
        chunks: [
          'data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"write_file","args":{"path":"a.txt"}}},{"functionCall":{"name":"write_file","args":{"path":"b.txt"}}},{"functionCall":{"name":"read_file","args":{"path":"a.txt"}}}]},"finishReason":"STOP"}]}\n\n',
        ],
      }),
    );
    const { chunks } = await collect(streamGemini(GEMINI_OPTS, MESSAGES, NO_TOOLS));
    const calls = chunks.filter((c) => c.type === "tool-call");
    expect(calls).toHaveLength(3);
    if (calls.every((c) => c.type === "tool-call")) {
      const ids = calls.map((c) => c.toolCall.id);
      expect(new Set(ids).size).toBe(3);
      expect(ids).toContain("call_write_file_0");
      expect(ids).toContain("call_write_file_1");
      expect(ids).toContain("call_read_file_2");
    }
  });

  it("reports HTTP errors", async () => {
    mockFetch(
      sseResponse({ ok: false, status: 403, statusText: "Forbidden", errorText: "no" }),
    );
    const { error } = await collect(streamGemini(GEMINI_OPTS, MESSAGES, NO_TOOLS));
    expect(error).toContain("HTTP 403");
  });

  it("reports API error objects", async () => {
    mockFetch(
      sseResponse({ chunks: ['data: {"error":{"message":"API key invalid"}}\n\n'] }),
    );
    const { error } = await collect(streamGemini(GEMINI_OPTS, MESSAGES, NO_TOOLS));
    expect(error).toBe("API key invalid");
  });

  it("yields done when aborted before the request", async () => {
    const ac = new AbortController();
    ac.abort();
    mockFetch(async () => {
      throw ac.signal.reason;
    });
    const { chunks, error } = await collect(streamGemini(GEMINI_OPTS, MESSAGES, NO_TOOLS, ac.signal));
    expect(error).toBeUndefined();
    expect(chunks).toMatchObject([{ type: "done" }]);
  });

  it("yields an error chunk on a failed request that was not aborted", async () => {
    mockFetch(async () => {
      throw new TypeError("fetch failed");
    });
    const { error } = await collect(streamGemini(GEMINI_OPTS, MESSAGES, NO_TOOLS));
    expect(error).toContain("fetch failed");
  });

  it("skips malformed JSON data lines without crashing", async () => {
    mockFetch(
      sseResponse({
        chunks: [
          'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"fine"}]},"finishReason":"STOP"}]}\n\n',
          "data: %%garbage%%\n\n",
          "data:\n\n",
        ],
      }),
    );
    const { chunks, text, error } = await collect(streamGemini(GEMINI_OPTS, MESSAGES, NO_TOOLS));
    expect(error).toBeUndefined();
    expect(text).toBe("fine");
    expect(chunks[chunks.length - 1]).toMatchObject({ type: "done" });
  });
});