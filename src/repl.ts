import type { ChatMessage } from "./models/index.js";
import type { AgentResult } from "./agent/index.js";
import { Session } from "./session.js";

export function formatMessage(m: ChatMessage): string {
  switch (m.role) {
    case "system":
      return `[system]\n${m.content}`;
    case "user":
      return `[user]\n${m.content}`;
    case "assistant":
      return m.toolCalls && m.toolCalls.length > 0
        ? `[assistant]\n${m.content ?? ""}\n[calls] ${m.toolCalls.map((c) => c.name).join(", ")}`
        : `[assistant]\n${m.content}`;
    case "tool":
      return `[tool:${m.name ?? "?"}]\n${m.content}`;
    default:
      return `[${m.role}]`;
  }
}

export function historyLines(history: ChatMessage[]): string[] {
  if (history.length === 0) return ["(conversation is empty)"];
  return [history.map((m) => formatMessage(m)).join("\n\n")];
}

export function resultLines(run: AgentResult): string[] {
  if (run.status === "error") return [`[error] ${run.error}`];
  if (run.status === "max-iterations") return [`[stopped after ${run.iterations} iterations]`];
  const usage = run.usage
    ? `\n[tokens in: ${run.usage.inputTokens ?? "?"} out: ${run.usage.outputTokens ?? "?"}]`
    : "";
  return [`[done]${usage}`];
}

export const HELP_TEXT = [
  "/help            show this help",
  "/model <name>    switch model",
  "/provider <name> switch provider (openrouter, gemini, ollama)",
  "/history         print the conversation",
  "/clear           reset the conversation (keeps system prompt)",
  "/exit, /quit     leave the REPL",
].join("\n");

export const TRIM_NOTICE = "-- (older history was trimmed to fit limits)";
export const OVER_LIMIT_NOTICE = "-- (the newest turn exceeds the configured history limit)";

export interface ReplOptions {
  applyChanges?: (changes: { provider?: string; model?: string }) => Promise<Session>;
}

export class ReplController {
  history: ChatMessage[] = [];
  historyTrimmed = false;
  historyOverLimit = false;

  constructor(
    public session: Session,
    private readonly options: ReplOptions = {},
  ) {}

  private async change(changes: { provider?: string; model?: string }): Promise<void> {
    const apply = this.options.applyChanges ?? ((c) => this.session.applyChanges(c));
    this.session = await apply(changes);
  }

  async handleLine(line: string): Promise<{ exit: boolean; output: string[] }> {
    const input = line.trim();
    if (input === "") return { exit: false, output: [] };

    if (input === "/exit" || input === "/quit") {
      return { exit: true, output: [] };
    }
    if (input === "/help") {
      return { exit: false, output: [HELP_TEXT] };
    }
    if (input === "/history") {
      const output = historyLines(this.history);
      if (this.historyTrimmed) output.push(TRIM_NOTICE);
      if (this.historyOverLimit) output.push(OVER_LIMIT_NOTICE);
      return { exit: false, output };
    }
    if (input === "/clear") {
      this.history = [];
      this.historyTrimmed = false;
      this.historyOverLimit = false;
      return { exit: false, output: ["conversation cleared"] };
    }
    if (input.startsWith("/model ")) {
      const model = input.slice(7).trim();
      try {
        await this.change({ model });
        return { exit: false, output: [`model -> ${this.session.activeModel}`] };
      } catch (e) {
        return { exit: false, output: [`[error] ${(e as Error).message}`] };
      }
    }
    if (input.startsWith("/provider ")) {
      const provider = input.slice(10).trim();
      try {
        await this.change({ provider });
        return {
          exit: false,
          output: [`provider -> ${this.session.activeProvider}  model: ${this.session.activeModel}`],
        };
      } catch (e) {
        return { exit: false, output: [`[error] ${(e as Error).message}`] };
      }
    }
    if (input === "/provider" || input === "/model") {
      return {
        exit: false,
        output: [
          `current provider: ${this.session.activeProvider}  model: ${this.session.activeModel}`,
        ],
      };
    }

    const run = await this.session.runTurn(input, this.history);
    this.history = run.messages;
    // historyTrimmed stays true for the whole session: once older messages have
    // been dropped they stay dropped, and /history should keep saying so. The
    // over-limit flag, by contrast, reflects the CURRENT retained history:
    // after a later normal-sized turn the newest segment no longer exceeds the
    // limit, so it is overwritten rather than accumulated.
    this.historyTrimmed = this.historyTrimmed || run.historyTrimmed;
    this.historyOverLimit = run.historyOverLimit;
    return { exit: false, output: ["", ...resultLines(run), ""] };
  }
}