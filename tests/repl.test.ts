import { describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDefaultTools } from "../src/tools/index.js";
import { parseSecurityConfig } from "../src/security/index.js";
import { Session } from "../src/session.js";
import { ReplController, TRIM_NOTICE, OVER_LIMIT_NOTICE } from "../src/repl.js";
import type { AppConfig } from "../src/config/index.js";
import type { ChatMessage, Provider, StreamChunk, ToolDefinition } from "../src/models/provider.js";

class FakeProvider implements Provider {
  readonly info: { name: string; model: string };
  private readonly responses: StreamChunk[][];
  public readonly seenMessages: ChatMessage[][] = [];
  constructor(name: string, model: string, responses: StreamChunk[][]) {
    this.info = { name, model };
    this.responses = responses;
  }
  async *stream(
    messages: ChatMessage[],
    _tools: ToolDefinition[],
    _signal?: AbortSignal,
  ): AsyncGenerator<StreamChunk> {
    this.seenMessages.push(messages.map((m) => ({ ...m })));
    const next = this.responses.shift() ?? [{ type: "done" }];
    for (const c of next) yield c;
  }
}

function minimalConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    provider: "fake",
    model: "",
    temperature: 0.3,
    maxTokens: 1024,
    maxIterations: 5,
    contextLines: 250,
    maxHistoryMessages: 1000,
    maxHistoryChars: 1_000_000,
    security: parseSecurityConfig({
      default: "allow",
      read: "allow",
      write: "allow",
      execute: "allow",
    }),
    ignore: [],
    providers: { fake: { model: "base-model" } },
    ...overrides,
  };
}

async function makeSession(
  name = "fake",
  model = "base-model",
  responses: StreamChunk[][] = [[{ type: "text", text: "hi" }, { type: "done" }]],
): Promise<{ session: Session; provider: FakeProvider; cwd: string }> {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "openplusexyz-repl-"));
  const provider = new FakeProvider(name, model, responses);
  const session = new Session(minimalConfig({ provider: name, model }), cwd, provider, createDefaultTools(), "system");
  return { session, provider, cwd };
}

describe("REPL slash commands", () => {
  it("/model <name> rebuilds the active session and the next turn uses it", async () => {
    const { session, provider, cwd } = await makeSession("fake", "old-model", [[{ type: "text", text: "a" }, { type: "done" }]]);
    const newProvider = new FakeProvider("fake", "new-model", [[{ type: "text", text: "b" }, { type: "done" }]]);
    const repl = new ReplController(session, {
      applyChanges: async (changes) =>
        new Session(
          minimalConfig({ provider: "fake", model: changes.model ?? "new-model" }),
          cwd,
          newProvider,
          createDefaultTools(),
          "system",
        ),
    });

    const first = await repl.handleLine("/model new-model");
    expect(first.output[0]).toBe("model -> new-model");
    expect(repl.session.provider).not.toBe(session.provider);
    expect(repl.session.activeModel).toBe("new-model");

    await repl.handleLine("say hi");
    expect(provider.seenMessages).toHaveLength(0);
    expect(newProvider.seenMessages).toHaveLength(1);
  });

  it("/provider <name> rebuilds the active session and the next turn uses it", async () => {
    const { session, provider, cwd } = await makeSession("fake", "base-model", [[{ type: "text", text: "a" }, { type: "done" }]]);
    const geminiProvider = new FakeProvider("gemini", "gemini-2.5-flash", [[{ type: "text", text: "g" }, { type: "done" }]]);
    const repl = new ReplController(session, {
      applyChanges: async (changes) =>
        new Session(
          minimalConfig({ provider: changes.provider ?? "fake", model: "gemini-2.5-flash" }),
          cwd,
          geminiProvider,
          createDefaultTools(),
          "system",
        ),
    });

    const switched = await repl.handleLine("/provider gemini");
    expect(switched.output[0]).toContain("provider -> gemini");
    expect(repl.session.activeProvider).toBe("gemini");

    await repl.handleLine("hi");
    expect(provider.seenMessages).toHaveLength(0);
    expect(geminiProvider.seenMessages).toHaveLength(1);
  });

  it("an invalid provider leaves the active session and history unchanged", async () => {
    const { session, cwd } = await makeSession("fake", "base-model");
    const sentinel: ChatMessage[] = [{ role: "user", content: "keep me" }];
    const repl = new ReplController(session, {
      applyChanges: async () => {
        throw new Error(`Unknown provider: "nope"`);
      },
    });
    repl.history = sentinel;

    const result = await repl.handleLine("/provider nope");
    expect(result.output[0]).toBe('[error] Unknown provider: "nope"');
    expect(repl.session).toBe(session);
    expect(repl.history).toBe(sentinel);
    expect(repl.history).toEqual([{ role: "user", content: "keep me" }]);
    expect(cwd).toBeDefined();
  });

  it("/history reports when older history was trimmed AND the newest turn is over the limit", async () => {
    const { session } = await makeSession();
    const repl = new ReplController(session);
    repl.history = [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
    ];
    repl.historyTrimmed = true;
    repl.historyOverLimit = true;

    const { output } = await repl.handleLine("/history");
    expect(output.join("\n")).toContain("q1");
    expect(output.join("\n")).toContain("a1");
    expect(output.join("\n")).toContain(TRIM_NOTICE);
    expect(output.join("\n")).toContain(OVER_LIMIT_NOTICE);
  });

  it("/clear resets history while retaining the system prompt on the next turn", async () => {
    const { session, cwd } = await makeSession("fake", "base-model", [
      [{ type: "text", text: "first reply" }, { type: "done" }],
      [{ type: "text", text: "second reply" }, { type: "done" }],
    ]);
    const cwd2 = cwd;
    void cwd2;
    const repl = new ReplController(session);

    await repl.handleLine("q1");
    expect(repl.history.length).toBeGreaterThan(2);
    expect(repl.history.some((m) => m.content === "first reply")).toBe(true);

    const cleared = await repl.handleLine("/clear");
    expect(cleared.output[0]).toBe("conversation cleared");
    expect(repl.history).toEqual([]);

    await repl.handleLine("q2");
    const seen = repl.history;
    expect(seen[0]).toMatchObject({ role: "system", content: "system" });
    expect(seen.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
    expect(seen[1]).toMatchObject({ role: "user", content: "q2" });
    expect(seen.filter((m) => m.role === "system")).toHaveLength(1);
  });
});

describe("historyOverLimit lifetime", () => {
  async function makeTinyHistorySession(responses: StreamChunk[][]): Promise<{ session: Session; cwd: string }> {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "openplusexyz-repl-"));
    const provider = new FakeProvider("fake", "base-model", responses);
    const session = new Session(
      minimalConfig({ maxHistoryChars: 100 }),
      cwd,
      provider,
      createDefaultTools(),
      "system",
    );
    return { session, cwd };
  }

  it("an oversized turn sets historyOverLimit, and a later normal turn after trimming resets it", async () => {
    const big = "x".repeat(500);
    const { session } = await makeTinyHistorySession([
      [
        {
          type: "tool-call",
          toolCall: { id: "c1", name: "write_file", arguments: { path: "note.txt", content: "hi" } },
        },
        { type: "done" },
      ],
      [{ type: "text", text: big }, { type: "done" }],
      [{ type: "text", text: "ok" }, { type: "done" }],
    ]);
    const repl = new ReplController(session);
    repl.history = [
      { role: "user", content: "old" },
      { role: "assistant", content: "old reply" },
    ];

    await repl.handleLine("create the file");
    expect(repl.historyOverLimit).toBe(true);
    expect(repl.historyTrimmed).toBe(true);
    const reported = await repl.handleLine("/history");
    expect(reported.output.join("\n")).toContain(OVER_LIMIT_NOTICE);

    await repl.handleLine("continue now");
    expect(repl.historyOverLimit).toBe(false);
    // once older messages were trimmed they stay trimmed: still cumulative
    expect(repl.historyTrimmed).toBe(true);

    const later = await repl.handleLine("/history");
    const text = later.output.join("\n");
    expect(text).not.toContain(OVER_LIMIT_NOTICE);
    expect(text).toContain(TRIM_NOTICE);
  });

  it("/clear resets both the over-limit and trimmed flags", async () => {
    const big = "x".repeat(500);
    const { session } = await makeTinyHistorySession([
      [{ type: "text", text: big }, { type: "done" }],
    ]);
    const repl = new ReplController(session);

    await repl.handleLine("huge");
    expect(repl.historyOverLimit).toBe(true);

    const cleared = await repl.handleLine("/clear");
    expect(cleared.output[0]).toBe("conversation cleared");
    expect(repl.historyOverLimit).toBe(false);
    expect(repl.historyTrimmed).toBe(false);
  });
});
