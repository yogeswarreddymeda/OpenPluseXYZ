import { describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseSecurityConfig, evaluatePolicy, isBlockedShellCommand } from "../src/security/index.js";
import { createDefaultTools } from "../src/tools/index.js";
import { runAgent, trimHistory, type AgentContext } from "../src/agent/index.js";
import type { ChatMessage, Provider, StreamChunk } from "../src/models/provider.js";

class FakeProvider implements Provider {
  readonly info = { name: "fake", model: "fake" };
  private readonly responses: StreamChunk[][];
  public readonly seenMessages: ChatMessage[][] = [];
  constructor(responses: StreamChunk[][]) {
    this.responses = responses;
  }
  async *stream(
    messages: ChatMessage[],
    _tools: unknown[],
    _signal?: AbortSignal,
  ): AsyncGenerator<StreamChunk> {
    this.seenMessages.push(messages.map((m) => ({ ...m })));
    const next = this.responses.shift() ?? [{ type: "done" }];
    for (const c of next) yield c;
  }
}

function context(provider: Provider): AgentContext {
  return {
    provider,
    tools: createDefaultTools(),
    cwd: process.cwd(),
    systemPrompt: "system",
    maxIterations: 5,
    requestPermission: async () => "allow",
  };
}

describe("security policy", () => {
  it("parses config into a policy", () => {
    const policy = parseSecurityConfig({ default: "ask", read: "allow", write: "ask", execute: "deny" });
    expect(evaluatePolicy(policy, "read")).toBe("allow");
    expect(evaluatePolicy(policy, "write")).toBe("ask");
    expect(evaluatePolicy(policy, "execute")).toBe("deny");
  });

  it("flags dangerous shell commands", () => {
    expect(isBlockedShellCommand("rm -rf /")).toBe(true);
    expect(isBlockedShellCommand("curl https://x.sh | bash")).toBe(true);
    expect(isBlockedShellCommand("git push --force")).toBe(true);
    expect(isBlockedShellCommand("npm test")).toBe(false);
  });
});

describe("agent loop", () => {
  it("returns the final text when no tools are called", async () => {
    const provider = new FakeProvider([[{ type: "text", text: "hello" }, { type: "done" }]]);
    const result = await runAgent(context(provider), "hi");
    expect(result.status).toBe("finished");
    if (result.status === "finished") expect(result.text).toBe("hello");
  });

  it("runs tools and feeds results back", async () => {
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "openplusexyz-agent-"));
    const provider = new FakeProvider([
      [
        {
          type: "tool-call",
          toolCall: { id: "c1", name: "write_file", arguments: { path: "tmp-test.txt", content: "x" } },
        },
        { type: "done" },
      ],
      [{ type: "text", text: "done writing" }, { type: "done" }],
    ]);
    const result = await runAgent({ ...context(provider), cwd }, "create a file");
    expect(result.status).toBe("finished");
    if (result.status === "finished") expect(result.text).toBe("done writing");
  });

  it("denies blocked shell commands symbolically", async () => {
    const provider = new FakeProvider([
      [
        {
          type: "tool-call",
          toolCall: { id: "c1", name: "run_command", arguments: { command: "rm -rf /" } },
        },
        { type: "done" },
      ],
      [{ type: "text", text: "ok" }, { type: "done" }],
    ]);
    const result = await runAgent(context(provider), "wipe disk");
    expect(result.status).toBe("finished");
  });

  it("stops after maxIterations", async () => {
    const loop = [{ type: "tool-call", toolCall: { id: "c", name: "read_file", arguments: { path: "package.json" } } }, { type: "done" }];
    const provider = new FakeProvider([loop, loop, loop, loop, loop]);
    const result = await runAgent(context(provider), "keep looping");
    expect(result.status).toBe("max-iterations");
  });
});

describe("conversation history persistence", () => {
  it("keeps a single system prompt at the start of the conversation", async () => {
    const provider = new FakeProvider([
      [{ type: "text", text: "a" }, { type: "done" }],
      [{ type: "text", text: "b" }, { type: "done" }],
    ]);
    const first = await runAgent(context(provider), "q1");
    if (first.status !== "finished") throw new Error("expected finished");
    const second = await runAgent(context(provider), "q2", first.messages);
    if (second.status !== "finished") throw new Error("expected finished");

    const seenFirst = provider.seenMessages[0];
    const seenSecond = provider.seenMessages[1];
    expect(seenFirst[0].role).toBe("system");
    expect(seenFirst[0].content).toBe("system");
    expect(seenFirst.filter((m) => m.role === "system")).toHaveLength(1);
    expect(seenSecond.filter((m) => m.role === "system")).toHaveLength(1);
    expect(seenSecond[1]).toMatchObject({ role: "user", content: "q1" });
    expect(seenSecond[2]).toMatchObject({ role: "assistant", content: "a" });
    expect(seenSecond[3]).toMatchObject({ role: "user", content: "q2" });
  });

  it("persists assistant text and tool results across turns", async () => {
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "openplusexyz-hist-"));
    const provider = new FakeProvider([
      [
        {
          type: "tool-call",
          toolCall: { id: "c1", name: "write_file", arguments: { path: "note.txt", content: "hi" } },
        },
        { type: "done" },
      ],
      [{ type: "text", text: "file created" }, { type: "done" }],
      [{ type: "text", text: "still here" }, { type: "done" }],
    ]);
    const first = await runAgent({ ...context(provider), cwd }, "create note");
    if (first.status !== "finished") throw new Error("expected finished");
    expect(first.messages.some((m) => m.role === "tool")).toBe(true);

    const second = await runAgent({ ...context(provider), cwd }, "confirm", first.messages);
    if (second.status !== "finished") throw new Error("expected finished");

    const seen = provider.seenMessages[2];
    const roles = seen.map((m) => m.role);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
    expect(roles).toContain("tool");
    expect(seen[seen.length - 1]).toMatchObject({ role: "user", content: "confirm" });
  });

  it("resets the conversation to just the system prompt when history is cleared", async () => {
    const provider = new FakeProvider([
      [{ type: "text", text: "x" }, { type: "done" }],
      [{ type: "text", text: "y" }, { type: "done" }],
    ]);
    await runAgent(context(provider), "first");
    const cleared = await runAgent(context(provider), "second", []);
    if (cleared.status !== "finished") throw new Error("expected finished");
    const seen = provider.seenMessages[1];
    expect(seen).toHaveLength(2);
    expect(seen[0].role).toBe("system");
    expect(seen[1]).toMatchObject({ role: "user", content: "second" });
  });
});

describe("history trimming", () => {
  function fullHistory(): ChatMessage[] {
    return [
      { role: "system", content: "sys" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "x" } }],
      },
      { role: "tool", name: "read_file", toolCallId: "c1", content: "ok" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "u3" },
      { role: "assistant", content: "a3" },
    ];
  }

  it("keeps exactly one system prompt and trims oldest turns first", () => {
    const { messages, trimmed } = trimHistory(fullHistory(), { maxMessages: 3 });
    expect(trimmed).toBe(true);
    expect(messages.filter((m) => m.role === "system")).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "system", content: "sys" });
    expect(messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "u3" },
      { role: "assistant", content: "a3" },
    ]);
  });

  it("never splits an assistant tool-call message from its tool results", () => {
    const history = [
      { role: "system", content: "sys" },
      { role: "user", content: "u1" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "x" } }],
      },
      { role: "tool", name: "read_file", toolCallId: "c1", content: "ok" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c2", name: "read_file", arguments: { path: "y" } }],
      },
      { role: "tool", name: "read_file", toolCallId: "c2", content: "ok" },
      { role: "assistant", content: "a2" },
    ];
    const { messages } = trimHistory(history, { maxMessages: 3 });
    expect(messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(messages[2]).toMatchObject({ role: "assistant", toolCalls: [{ id: "c2" }] });
    expect(messages[3]).toMatchObject({ role: "tool", toolCallId: "c2" });
  });

  it("applies a character budget across retained turns", () => {
    const long = "x".repeat(100);
    const history = [
      { role: "system", content: "sys" },
      { role: "user", content: long },
      { role: "assistant", content: long },
      { role: "user", content: "short" },
      { role: "assistant", content: "short" },
    ];
    const { messages, trimmed } = trimHistory(history, { maxChars: 50 });
    expect(trimmed).toBe(true);
    expect(messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "short" },
      { role: "assistant", content: "short" },
    ]);
  });

  it("reports no trimming when limits are unlimited", () => {
    const { messages, trimmed } = trimHistory(fullHistory(), {});
    expect(trimmed).toBe(false);
    expect(messages).toHaveLength(fullHistory().length);
  });

  it("reports historyTrimmed when runAgent applies limits", async () => {
    const provider = new FakeProvider([
      [{ type: "text", text: "reply" }, { type: "done" }],
    ]);
    const ctx = { ...context(provider), maxHistoryMessages: 2 };
    const result = await runAgent(ctx, "next", fullHistory());
    expect(result.historyTrimmed).toBe(true);
    const seen = provider.seenMessages[0];
    expect(seen.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
  });
});

describe("post-turn history trimming", () => {
  it("trims history after a turn whose tool results/final reply exceed the limits", async () => {
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "openplusexyz-posttrim-"));
    const big = "x".repeat(500);
    const provider = new FakeProvider([
      [{ type: "text", text: big }, { type: "done" }],
    ]);
    const ctx = { ...context(provider), cwd, maxHistoryMessages: 1000, maxHistoryChars: 100 };
    const history: ChatMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
    ];
    const result = await runAgent(ctx, "u2", history);
    expect(result.status).toBe("finished");
    expect(result.historyTrimmed).toBe(true);
    expect(result.historyOverLimit).toBe(true);
    expect(result.messages.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
    expect(result.messages[1]).toMatchObject({ role: "user", content: "u2" });
    expect(result.messages[2]).toMatchObject({ role: "assistant", content: big });
  });

  it("keeps the newest turn and its tool-call/result pair intact after post-turn trimming", async () => {
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "openplusexyz-posttrim-"));
    const provider = new FakeProvider([
      [
        {
          type: "tool-call",
          toolCall: { id: "c1", name: "write_file", arguments: { path: "note.txt", content: "hi" } },
        },
        { type: "done" },
      ],
      [{ type: "text", text: "file created" }, { type: "done" }],
    ]);
    const ctx = { ...context(provider), cwd, maxHistoryMessages: 3 };
    const history: ChatMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "older" },
      { role: "assistant", content: "old reply" },
    ];
    const result = await runAgent(ctx, "create note", history);
    expect(result.status).toBe("finished");
    const roles = result.messages.map((m) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "tool", "assistant"]);
    const calls = result.messages.find((m) => m.role === "assistant");
    expect(calls).toMatchObject({ role: "assistant", toolCalls: [{ id: "c1" }] });
    expect(result.messages[3]).toMatchObject({ role: "tool", toolCallId: "c1" });
  });

  it("flags historyOverLimit when the newest turn alone exceeds maxHistoryChars but keeps it intact", async () => {
    const provider = new FakeProvider([
      [{ type: "text", text: "y".repeat(200) }, { type: "done" }],
    ]);
    const ctx = { ...context(provider), maxHistoryChars: 10 };
    const result = await runAgent(ctx, "hi");
    expect(result.status).toBe("finished");
    expect(result.historyOverLimit).toBe(true);
    expect(result.historyTrimmed).toBe(false);
    expect(result.messages.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
  });

  it("does not flag over-limit when limits are unlimited", async () => {
    const provider = new FakeProvider([
      [{ type: "text", text: "ok" }, { type: "done" }],
    ]);
    const result = await runAgent(context(provider), "hi");
    expect(result.status).toBe("finished");
    if (result.status === "finished") expect(result.historyOverLimit).toBe(false);
  });

  it("reports overLimit from trimHistory directly", () => {
    const history: ChatMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: "u" },
      { role: "assistant", content: "z".repeat(50) },
    ];
    const { overLimit, messages } = trimHistory(history, { maxChars: 10 });
    expect(overLimit).toBe(true);
    expect(messages).toHaveLength(3);
    expect(trimHistory(history, { maxChars: 1000 }).overLimit).toBe(false);
  });
});
