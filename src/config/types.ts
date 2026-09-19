import type { SecurityConfig } from "../security/index.js";

export interface ProviderSettings {
  model: string;
  baseUrl?: string;
}

export interface AppConfig {
  provider: string;
  model: string;
  temperature: number;
  maxTokens: number;
  maxIterations: number;
  contextLines: number;
  maxHistoryMessages: number;
  maxHistoryChars: number;
  security: SecurityConfig;
  ignore: string[];
  providers: Record<string, ProviderSettings>;
}