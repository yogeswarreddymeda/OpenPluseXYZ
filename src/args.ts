export interface ParsedArgs {
  cwd?: string;
  provider?: string;
  model?: string;
  prompt: string[];
  help: boolean;
  version: boolean;
}

const VALUE_FLAGS = new Set(["--cwd", "--provider", "--model"]);

/**
 * Parse CLI arguments explicitly. Flags may appear in any order, each consumes
 * exactly one following value, and everything else becomes prompt words. A
 * flag whose value is missing (end of argv or another flag) is a hard error so
 * option values can never leak into the prompt.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { prompt: [], help: false, version: false };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      parsed.help = true;
      i++;
      continue;
    }
    if (arg === "-v" || arg === "--version") {
      parsed.version = true;
      i++;
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`Missing value for ${arg}`);
      }
      if (arg === "--cwd") parsed.cwd = value;
      if (arg === "--provider") parsed.provider = value;
      if (arg === "--model") parsed.model = value;
      i += 2;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    parsed.prompt.push(arg);
    i++;
  }
  return parsed;
}