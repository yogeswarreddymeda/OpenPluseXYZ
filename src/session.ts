import type { AppConfig } from "./config/index.js";
import {
  createProvider,
  type ChatMessage,
  type Provider,
  type ProviderOptions,
} from "./models/index.js";
import { createDefaultTools, type ToolRegistry } from "./tools/index.js";
import {
  buildSystemPrompt,
  runAgent,
  type AgentEventHandlers,
  type AgentResult,
} from "./agent/index.js";
import { evaluatePolicy, type PermissionAction, type PolicyVerdict } from "./security/index.js";
import { summarizeProject } from "./project/index.js";

const API_KEY_ENV: Record<string, string> = {
  openrouter: "OPENROUTER_API_KEY",
  gemini: "GEMINI_API_KEY",
};

export function providerOptions(cfg: AppConfig): ProviderOptions {
  const settings = cfg.providers[cfg.provider];
  if (!settings) {
    throw new Error(`Unknown provider: "${cfg.provider}". Expected ${Object.keys(cfg.providers).join(", ")}.`);
  }
  return {
    model: cfg.model || settings.model,
    baseUrl: settings.baseUrl,
    apiKey: process.env[API_KEY_ENV[cfg.provider]],
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
  };
}

export interface SessionOptions {
  resolveAsk?: (action: PermissionAction, detail: string) => Promise<boolean>;
  events?: AgentEventHandlers;
}

export class Session {
  readonly cfg: AppConfig;
  readonly cwd: string;
  readonly provider: Provider;
  readonly tools: ToolRegistry;
  readonly systemPrompt: string;
  private readonly resolveAsk?: (action: PermissionAction, detail: string) => Promise<boolean>;
  private readonly events: AgentEventHandlers;

  constructor(
    cfg: AppConfig,
    cwd: string,
    provider: Provider,
    tools: ToolRegistry,
    systemPrompt: string,
    opts: SessionOptions = {},
  ) {
    this.cfg = cfg;
    this.cwd = cwd;
    this.provider = provider;
    this.tools = tools;
    this.systemPrompt = systemPrompt;
    this.resolveAsk = opts.resolveAsk;
    this.events = opts.events ?? {};
  }

  static async create(cfg: AppConfig, cwd: string, opts: SessionOptions = {}): Promise<Session> {
    const provider = createProvider(cfg.provider, providerOptions(cfg));
    const tools = createDefaultTools();
    const projectContext = await summarizeProject({
      cwd,
      ignore: cfg.ignore,
      maxLines: cfg.contextLines,
    }).catch(() => "");
    const systemPrompt = buildSystemPrompt({ cwd, projectContext });
    return new Session(cfg, cwd, provider, tools, systemPrompt, opts);
  }

  get activeProvider(): string {
    return this.cfg.provider;
  }

  get activeModel(): string {
    return this.cfg.model || this.cfg.providers[this.cfg.provider]?.model || "";
  }

  async applyChanges(changes: { provider?: string; model?: string }): Promise<Session> {
    const nextCfg: AppConfig = { ...this.cfg };
    if (changes.model !== undefined) nextCfg.model = changes.model;
    if (changes.provider !== undefined) nextCfg.provider = changes.provider;
    return Session.create(nextCfg, this.cwd, { resolveAsk: this.resolveAsk, events: this.events });
  }

  async runTurn(query: string, history: ChatMessage[]): Promise<AgentResult> {
    const requestPermission = async (action: PermissionAction): Promise<PolicyVerdict> =>
      evaluatePolicy(this.cfg.security, action);
    return runAgent(
      {
        provider: this.provider,
        tools: this.tools,
        cwd: this.cwd,
        systemPrompt: this.systemPrompt,
        maxIterations: this.cfg.maxIterations,
        maxHistoryMessages: this.cfg.maxHistoryMessages,
        maxHistoryChars: this.cfg.maxHistoryChars,
        requestPermission,
        resolveAsk: this.resolveAsk,
        ignore: this.cfg.ignore,
        events: this.events,
      },
      query,
      history,
    );
  }
}