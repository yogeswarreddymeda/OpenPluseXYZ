import type { ChatMessage, Provider, StreamChunk, ToolCall } from "../models/provider.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { PermissionAction, PolicyVerdict } from "../security/index.js";
import { isBlockedShellCommand } from "../security/index.js";

export interface AgentEventHandlers {
  onText?: (text: string) => void;
  onToolStart?: (call: ToolCall) => void;
  onToolResult?: (call: ToolCall, result: string) => void;
}

export interface AgentContext {
  provider: Provider;
  tools: ToolRegistry;
  cwd: string;
  systemPrompt: string;
  maxIterations: number;
  maxHistoryMessages?: number;
  maxHistoryChars?: number;
  requestPermission: (action: PermissionAction, detail: string) => Promise<PolicyVerdict>;
  resolveAsk?: (action: PermissionAction, detail: string) => Promise<boolean>;
  ignore?: string[];
  events?: AgentEventHandlers;
  signal?: AbortSignal;
}

export type AgentResult =
  | {
      status: "finished";
      text: string;
      iterations: number;
      usage?: { inputTokens?: number; outputTokens?: number };
      messages: ChatMessage[];
      historyTrimmed: boolean;
      historyOverLimit: boolean;
    }
  | {
      status: "max-iterations";
      text: string;
      iterations: number;
      messages: ChatMessage[];
      historyTrimmed: boolean;
      historyOverLimit: boolean;
    }
  | {
      status: "error";
      error: string;
      iterations: number;
      messages: ChatMessage[];
      historyTrimmed: boolean;
      historyOverLimit: boolean;
    };

async function askPermission(
  ctx: AgentContext,
  action: PermissionAction,
  detail: string,
): Promise<boolean> {
  const verdict = await ctx.requestPermission(action, detail);
  if (verdict === "allow") return true;
  if (verdict === "deny") return false;
  if (ctx.resolveAsk) return ctx.resolveAsk(action, detail);
  return false;
}

function replyForDenied(call: ToolCall): string {
  return `ERROR: Permission denied for tool "${call.name}". The user or policy did not approve this action.`;
}

export interface HistoryLimits {
  maxMessages?: number;
  maxChars?: number;
}

interface Segment {
  messages: ChatMessage[];
  chars: number;
}

export function buildSegments(rest: ChatMessage[]): Segment[] {
  const segments: Segment[] = [];
  let current: ChatMessage[] = [];
  const chars = (m: ChatMessage): number => {
    const textLen = typeof m.content === "string" ? m.content.length : 0;
    const toolLen = (m.toolCalls ?? []).reduce(
      (n, c) => n + (JSON.stringify(c.arguments)?.length ?? 0),
      0,
    );
    return textLen + toolLen;
  };
  const flush = (): void => {
    if (current.length > 0) {
      segments.push({
        messages: current,
        chars: current.reduce((n, m) => n + chars(m), 0),
      });
      current = [];
    }
  };
  for (const m of rest) {
    if (m.role === "user" && current.length > 0) {
      flush();
      current.push(m);
    } else if (m.role === "assistant" && !m.toolCalls?.length && current.length > 0) {
      current.push(m);
      flush();
    } else {
      current.push(m);
    }
  }
  flush();
  return segments;
}

export function trimHistory(
  messages: ChatMessage[],
  limits: HistoryLimits,
): { messages: ChatMessage[]; trimmed: boolean; overLimit: boolean } {
  const maxMessages = limits.maxMessages ?? Infinity;
  const maxChars = limits.maxChars ?? Infinity;
  if (!Number.isFinite(maxMessages) && !Number.isFinite(maxChars)) {
    return { messages, trimmed: false, overLimit: false };
  }

  const system = messages.find((m) => m.role === "system");
  const rest = messages.filter((m) => m !== system);
  if (rest.length === 0) return { messages, trimmed: false, overLimit: false };

  const segments = buildSegments(rest);
  const newest = segments[segments.length - 1];
  const overLimit = Number.isFinite(maxChars) ? newest.chars > maxChars : false;

  let start = segments.length - 1;
  let totalMsgs = segments[start].messages.length;
  let totalChars = segments[start].chars;
  while (start > 0) {
    const prev = segments[start - 1];
    if (totalMsgs + prev.messages.length > maxMessages) break;
    if (totalChars + prev.chars > maxChars) break;
    start--;
    totalMsgs += prev.messages.length;
    totalChars += prev.chars;
  }

  const keptRest = segments.slice(start).flatMap((s) => s.messages);
  const kept = system ? [system, ...keptRest] : keptRest;
  return { messages: kept, trimmed: kept.length !== messages.length, overLimit };
}

function prepareMessages(
  ctx: AgentContext,
  userInput: string,
  history?: ChatMessage[],
): { messages: ChatMessage[]; trimmed: boolean } {
  const source: ChatMessage[] = history ? history.map((m) => ({ ...m })) : [];
  if (source.length === 0 || source[0].role !== "system") {
    source.unshift({ role: "system", content: ctx.systemPrompt });
  }
  const { messages, trimmed } = trimHistory(source, {
    maxMessages: ctx.maxHistoryMessages,
    maxChars: ctx.maxHistoryChars,
  });
  messages.push({ role: "user", content: userInput });
  return { messages, trimmed };
}

export async function runAgent(
  ctx: AgentContext,
  userInput: string,
  history?: ChatMessage[],
): Promise<AgentResult> {
  const { messages, trimmed } = prepareMessages(ctx, userInput, history);

  const finalize = (
    msgs: ChatMessage[],
    preTrimmed: boolean,
  ): { messages: ChatMessage[]; historyTrimmed: boolean; historyOverLimit: boolean } => {
    const result = trimHistory(msgs, {
      maxMessages: ctx.maxHistoryMessages,
      maxChars: ctx.maxHistoryChars,
    });
    return {
      messages: result.messages,
      historyTrimmed: preTrimmed || result.trimmed,
      historyOverLimit: result.overLimit,
    };
  };

  const events = ctx.events ?? {};
  let finalText = "";
  let usage: { inputTokens?: number; outputTokens?: number } | undefined;

  for (let iteration = 0; iteration < ctx.maxIterations; iteration++) {
    if (ctx.signal?.aborted) {
      const fin = finalize(messages, trimmed);
      return {
        status: "error",
        error: "Aborted",
        iterations: iteration,
        messages: fin.messages,
        historyTrimmed: fin.historyTrimmed,
        historyOverLimit: fin.historyOverLimit,
      };
    }

    let text = "";
    const toolCalls: ToolCall[] = [];

    const chunkHandler = (chunk: StreamChunk): void => {
      switch (chunk.type) {
        case "text":
          text += chunk.text;
          events.onText?.(chunk.text);
          break;
        case "tool-call":
          toolCalls.push(chunk.toolCall);
          break;
        case "done":
          usage = chunk.usage;
          break;
        case "error":
          throw new Error(chunk.error);
      }
    };

    try {
      for await (const chunk of ctx.provider.stream(messages, ctx.tools.definitions(), ctx.signal)) {
        chunkHandler(chunk);
      }
    } catch (e) {
      const fin = finalize(messages, trimmed);
      return {
        status: "error",
        error: (e as Error).message,
        iterations: iteration,
        messages: fin.messages,
        historyTrimmed: fin.historyTrimmed,
        historyOverLimit: fin.historyOverLimit,
      };
    }

    if (toolCalls.length === 0) {
      finalText = text;
      messages.push({ role: "assistant", content: text });
      const fin = finalize(messages, trimmed);
      return {
        status: "finished",
        text: finalText,
        iterations: iteration + 1,
        usage,
        messages: fin.messages,
        historyTrimmed: fin.historyTrimmed,
        historyOverLimit: fin.historyOverLimit,
      };
    }

    messages.push({ role: "assistant", content: text, toolCalls });

    for (const call of toolCalls) {
      const detail = JSON.stringify(call.arguments);
      events.onToolStart?.(call);

      const command = call.name === "run_command" ? String(call.arguments.command ?? "") : "";
      const blocked = command !== "" && isBlockedShellCommand(command);

      let result: string;
      if (blocked) {
        result = replyForDenied(call);
      } else if (await askPermission(ctx, ctx.tools.get(call.name)?.permission ?? "read", detail)) {
        try {
          result = await ctx.tools.run(call.name, call.arguments, {
            cwd: ctx.cwd,
            ignore: ctx.ignore,
          });
        } catch (e) {
          result = `ERROR: tool threw: ${(e as Error).message}`;
        }
      } else {
        result = replyForDenied(call);
      }

      events.onToolResult?.(call, result);
      messages.push({
        role: "tool",
        name: call.name,
        toolCallId: call.id,
        content: result,
      });
    }
  }

  const fin = finalize(messages, trimmed);
  return {
    status: "max-iterations",
    text: finalText,
    iterations: ctx.maxIterations,
    messages: fin.messages,
    historyTrimmed: fin.historyTrimmed,
    historyOverLimit: fin.historyOverLimit,
  };
}