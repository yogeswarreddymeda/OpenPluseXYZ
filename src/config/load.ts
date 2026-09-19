import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSecurityConfig } from "../security/index.js";
import type { AppConfig, ProviderSettings } from "./types.js";

const DEFAULT_IGNORE = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".venv",
  "coverage",
  ".cache",
  "out",
];

function isEnvValue(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function loadDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

interface LoadOptions {
  cwd?: string;
  configFile?: string;
  envFile?: string;
}

async function findDefaultConfigFile(): Promise<string | undefined> {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "config", "default.json");
    try {
      await fsp.access(candidate);
      return candidate;
    } catch {
      // keep walking up toward the repo root
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export async function loadConfig(opts: LoadOptions = {}): Promise<AppConfig> {
  const defaultFile = opts.configFile ?? (await findDefaultConfigFile());
  const raw = (await readJson(defaultFile ?? "")) ?? {};

  const securityRaw = (raw["security"] ?? {}) as Record<string, string>;
  const providersRaw = (raw["providers"] ?? {}) as Record<string, Partial<ProviderSettings>>;
  const ignoreRaw = (raw["ignore"] ?? []) as string[];

  const envFile = opts.envFile ?? path.join(opts.cwd ?? process.cwd(), ".env");
  const dotEnv = loadDotEnv(await fsp.readFile(envFile, "utf8").catch(() => ""));
  for (const [key, value] of Object.entries(dotEnv)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }

  // OPENPLUSE_* remains supported as a deprecated compatibility alias. The
  // OpenPluseXYZ names always win when both are set.
  const providerEnv = process.env["OPENPLUSEXYZ_PROVIDER"] ?? process.env["OPENPLUSE_PROVIDER"];
  const modelEnv = process.env["OPENPLUSEXYZ_MODEL"] ?? process.env["OPENPLUSE_MODEL"];
  const temperatureEnv = process.env["OPENPLUSEXYZ_TEMPERATURE"] ?? process.env["OPENPLUSE_TEMPERATURE"];
  const maxTokensEnv = process.env["OPENPLUSEXYZ_MAX_TOKENS"] ?? process.env["OPENPLUSE_MAX_TOKENS"];

  const defaultModel = {
    openrouter: "anthropic/claude-sonnet-4",
    gemini: "gemini-2.5-flash",
    ollama: "qwen2.5-coder:7b",
  } as Record<string, string>;

  const provider = providerEnv ?? String(raw["provider"] ?? "openrouter");
  const providers: Record<string, ProviderSettings> = {};
  for (const [name, settings] of Object.entries(providersRaw)) {
    providers[name] = {
      model: settings.model ?? defaultModel[name] ?? "",
      baseUrl: settings.baseUrl,
    };
  }
  if (!providers[provider]) {
    providers[provider] = { model: defaultModel[provider] ?? "" };
  }
  if (modelEnv && provider && providers[provider]) {
    providers[provider] = { ...providers[provider], model: modelEnv };
  }

  return {
    provider,
    model: modelEnv ?? String(raw["model"] ?? ""),
    temperature: clampNumber(
      temperatureEnv !== undefined ? temperatureEnv : raw["temperature"],
      0,
      2,
      0.3,
    ),
    maxTokens: clampInt(maxTokensEnv !== undefined ? maxTokensEnv : raw["maxTokens"], 1, 1_000_000, 4096),
    maxIterations: clampInt(raw["maxIterations"], 1, 1000, 15),
    contextLines: clampInt(raw["contextLines"], 5, 100_000, 250),
    maxHistoryMessages: clampInt(raw["maxHistoryMessages"], 3, 100_000, 200),
    maxHistoryChars: clampInt(raw["maxHistoryChars"], 1_000, 10_000_000, 200_000),
    security: parseSecurityConfig(securityRaw),
    ignore: ignoreRaw.length > 0 ? ignoreRaw : DEFAULT_IGNORE,
    providers,
  };
}
