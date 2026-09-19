import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export const MAX_TOOL_OUTPUT = 60_000;
export const DEFAULT_READ_LINES = 250;
export const MAX_GREP_MATCHES = 500;
export const MAX_GREP_PATTERN_LENGTH = 2_000;
export const MAX_GREP_FILE_BYTES = 5 * 1024 * 1024;
export const OUTSIDE_WORKSPACE_ERROR = "Path is outside the working directory.";

export const DEFAULT_IGNORE = [
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

export function resolveWorkspacePath(cwd: string, input: unknown): string {
  if (input === null || input === undefined || String(input).trim() === "") {
    throw new Error("Path must not be empty.");
  }
  const raw = String(input);
  if (path.isAbsolute(raw)) throw new Error(OUTSIDE_WORKSPACE_ERROR);
  const abs = path.resolve(cwd, raw);
  const rel = path.relative(cwd, abs);
  if (rel === "") return abs;
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(OUTSIDE_WORKSPACE_ERROR);
  return abs;
}

export function isPathInside(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export async function canonicalBase(cwd: string): Promise<string> {
  try {
    return await fsp.realpath(cwd);
  } catch {
    return path.resolve(cwd);
  }
}

// TOCTOU (time-of-check/time-of-use) disclaimer: realpath-based validation and
// the subsequent filesystem operation run at different instants, so a
// concurrent process could, in theory, swap a directory for a symlink between
// the two. This confinement is a strong defense-in-depth layer for a single
// agent process — it is NOT a kernel-level sandbox (see tools/shell.ts). We
// minimize the window by re-validating immediately before mutation
// operations (e.g. file writes) rather than once at the start of a tool call.

export async function resolveExistingTarget(cwd: string, input: unknown): Promise<string> {
  const abs = resolveWorkspacePath(cwd, input);
  const base = await canonicalBase(cwd);
  const real = await fsp.realpath(abs).catch(() => null);
  if (real !== null && !isPathInside(base, real)) {
    throw new Error(OUTSIDE_WORKSPACE_ERROR);
  }
  return abs;
}

export async function resolveWriteTarget(cwd: string, input: unknown): Promise<string> {
  const abs = resolveWorkspacePath(cwd, input);
  const base = await canonicalBase(cwd);
  const realTarget = await fsp.realpath(abs).catch(() => null);
  if (realTarget !== null) {
    if (!isPathInside(base, realTarget)) throw new Error(OUTSIDE_WORKSPACE_ERROR);
    return abs;
  }
  let cur = path.dirname(abs);
  while (true) {
    const real = await fsp.realpath(cur).catch(() => null);
    if (real !== null) {
      if (!isPathInside(base, real)) throw new Error(OUTSIDE_WORKSPACE_ERROR);
      return abs;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return abs;
}

export function resolveGlobPrefix(cwd: string, pattern: string): void {
  if (path.isAbsolute(pattern)) throw new Error(OUTSIDE_WORKSPACE_ERROR);
  const wildcard = pattern.search(/[*?{]/);
  const prefix = wildcard === -1 ? pattern : pattern.slice(0, wildcard);
  if (prefix === "") return;
  resolveWorkspacePath(cwd, prefix);
}

export function truncate(text: string, max = MAX_TOOL_OUTPUT): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]`;
}

export function isBinary(buf: Buffer): boolean {
  return buf.length > 0 && buf.subarray(0, 4000).includes(0);
}

export async function readTextFile(p: string): Promise<string> {
  const buf = await fsp.readFile(p);
  if (isBinary(buf)) throw new Error(`${p} is a binary file`);
  return buf.toString("utf8");
}

export function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        while (glob[i + 1] === "*") i++;
        if (glob[i + 1] === "/") i++;
        re += "(?:.*/)?";
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end === -1) {
        re += "\\{";
      } else {
        const alts = glob
          .slice(i + 1, end)
          .split(",")
          .map((s) => globToRegExp(s).source);
        re += `(?:${alts.join("|")})`;
        i = end;
      }
    } else if ("\\^$.|+()[]".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
    i++;
  }
  return new RegExp(`^${re}$`);
}

/**
 * Recursively list files under `dir`, skipping every symbolic link (both file
 * and directory links) so a scan can never escape into a target outside the
 * workspace. `ignore` is matched against entry names at each level.
 */
export async function walkFiles(
  dir: string,
  ignore: string[],
  maxResults: number,
): Promise<string[]> {
  const results: string[] = [];
  async function visit(rel: string): Promise<void> {
    if (results.length >= maxResults) return;
    const abs = path.join(dir, rel);
    let entries: fs.Dirent[] = [];
    try {
      entries = await fsp.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (results.length >= maxResults) return;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (ignore.includes(e.name)) continue;
      if (e.isDirectory()) {
        await visit(childRel);
      } else if (e.isFile()) {
        results.push(childRel);
      }
    }
  }
  await visit("");
  return results;
}