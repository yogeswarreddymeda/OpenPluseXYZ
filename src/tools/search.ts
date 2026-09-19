import fsp from "node:fs/promises";
import path from "node:path";
import type { Tool } from "./registry.js";
import {
  DEFAULT_IGNORE,
  globToRegExp,
  MAX_GREP_MATCHES,
  MAX_GREP_PATTERN_LENGTH,
  MAX_GREP_FILE_BYTES,
  isBinary,
  resolveGlobPrefix,
  walkFiles,
} from "./util.js";

export function checkGrepPattern(pattern: string): string | null {
  if (pattern.length > MAX_GREP_PATTERN_LENGTH) {
    return `grep: pattern too long (${pattern.length} chars, max ${MAX_GREP_PATTERN_LENGTH})`;
  }
  const nestedQuantifier = /\([^()]*[+*]\)[+*}]/;
  const nestedQuantifierDeep = /\([^()]*\([^()]*[+*]\)[+*]\)[+*}]/;
  const runawayDotStars = /(?:\.\*){2,}/;
  if (nestedQuantifier.test(pattern) || nestedQuantifierDeep.test(pattern) || runawayDotStars.test(pattern)) {
    return "grep: pattern is too complex (nested quantifiers like (a+)+ or repeated .* can be catastrophic); simplify or escape it";
  }
  return null;
}

const glob: Tool = {
  definition: {
    name: "glob",
    description:
      "Find files by glob pattern, e.g. **/*.ts, src/**/*.test.ts. Patterns must resolve inside the working directory.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern relative to the working directory." },
        maxResults: { type: "integer", description: "Maximum number of matches." },
      },
      required: ["pattern"],
    },
  },
  permission: "read",
  async execute(args, ctx) {
    const pattern = String(args.pattern ?? "");
    if (!pattern.trim()) return "glob: pattern must not be empty";
    try {
      resolveGlobPrefix(ctx.cwd, pattern);
    } catch (e) {
      return (e as Error).message;
    }
    const maxResults = Math.max(1, Number(args.maxResults ?? 300) | 0);
    const ignore = ctx.ignore ?? DEFAULT_IGNORE;
    const re = globToRegExp(pattern);
    const files = (await walkFiles(ctx.cwd, ignore, maxResults)).filter((f) => re.test(f));
    const truncated = files.length >= maxResults ? "\n...[more files omitted]" : "";
    return files.join("\n") || `No files match ${pattern}` + truncated;
  },
};

const grep: Tool = {
  definition: {
    name: "grep",
    description:
      "Search file contents with a JS regular expression. Returns file:line matches. Optional glob must resolve inside the working directory.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression to search for." },
        glob: { type: "string", description: "Optional glob to limit files, e.g. **/*.ts." },
        caseInsensitive: { type: "boolean", description: "Ignore case when matching." },
        maxMatches: { type: "integer", description: "Maximum number of matches." },
      },
      required: ["pattern"],
    },
  },
  permission: "read",
  async execute(args, ctx) {
    const pattern = String(args.pattern ?? "");
    if (!pattern.trim()) return "grep: pattern must not be empty";
    const refused = checkGrepPattern(pattern);
    if (refused) return refused;
    const maxResults = Math.max(1, Number(args.maxMatches ?? MAX_GREP_MATCHES) | 0);
    const ignore = ctx.ignore ?? DEFAULT_IGNORE;
    const flags = args.caseInsensitive ? "i" : "";
    let re: RegExp;
    try {
      re = new RegExp(pattern, flags);
    } catch (e) {
      return `Invalid regex: ${(e as Error).message}`;
    }
    let fileRe: RegExp | null = null;
    if (args.glob && String(args.glob).trim()) {
      try {
        resolveGlobPrefix(ctx.cwd, String(args.glob));
      } catch (e) {
        return (e as Error).message;
      }
      fileRe = globToRegExp(String(args.glob));
    }
    const files = (await walkFiles(ctx.cwd, ignore, 1000)).filter((f) => !fileRe || fileRe.test(f));

    const results: string[] = [];
    let skippedLarge = 0;
    outer: for (const f of files) {
      let buf: Buffer;
      try {
        buf = await fsp.readFile(path.join(ctx.cwd, f));
      } catch {
        continue;
      }
      if (buf.length > MAX_GREP_FILE_BYTES) {
        skippedLarge++;
        continue;
      }
      if (isBinary(buf)) continue;
      const text = buf.toString("utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          const trimmed = lines[i].trim();
          results.push(`${f}:${i + 1}: ${trimmed.slice(0, 300)}`);
          if (results.length >= maxResults) break outer;
        }
      }
    }
    let truncated = "";
    if (skippedLarge > 0) {
      truncated += `\n...[skipped ${skippedLarge} file(s) over ${MAX_GREP_FILE_BYTES} bytes]`;
    }
    if (results.length >= maxResults) {
      truncated += `\n...[truncated at ${maxResults} matches]`;
    }
    return results.length ? results.join("\n") + truncated : `No matches for ${pattern}` + truncated;
  },
};

export const searchTools: Tool[] = [glob, grep];