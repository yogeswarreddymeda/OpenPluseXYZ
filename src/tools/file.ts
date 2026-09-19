import fsp from "node:fs/promises";
import path from "node:path";
import type { Tool } from "./registry.js";
import {
  DEFAULT_IGNORE,
  DEFAULT_READ_LINES,
  readTextFile,
  resolveExistingTarget,
  resolveWriteTarget,
  walkFiles,
} from "./util.js";

const readFile: Tool = {
  definition: {
    name: "read_file",
    description: `Read a text file with optional line range. Useful for inspecting code, configs, or documentation. Returns lines prefixed with line numbers. Paths must resolve inside the working directory.`,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file, relative to the working directory.",
        },
        offset: {
          type: "integer",
          description: "First line number to read, 1-based.",
        },
        limit: {
          type: "integer",
          description: `Maximum number of lines to return (default ${DEFAULT_READ_LINES}).`,
        },
      },
      required: ["path"],
    },
  },
  permission: "read",
  async execute(args, ctx) {
    let target: string;
    try {
      target = await resolveExistingTarget(ctx.cwd, args.path ?? "");
    } catch (e) {
      return (e as Error).message;
    }
    let text: string;
    try {
      text = await readTextFile(target);
    } catch (e) {
      return `Error reading ${target}: ${(e as Error).message}`;
    }
    const lines = text.split("\n");
    const offset = Math.max(1, Number(args.offset ?? 1) | 0);
    const limit = Math.max(1, Number(args.limit ?? DEFAULT_READ_LINES) | 0);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const width = String(offset - 1 + slice.length).length;
    const numbered = slice
      .map((l, i) => `${String(offset + i).padStart(width)}: ${l}`)
      .join("\n");
    const truncated = offset - 1 + limit < lines.length ? "\n...[more lines follow]" : "";
    return numbered ? `${numbered}${truncated}` : `File empty (${lines.length} lines). ${truncated}`;
  },
};

const writeFile: Tool = {
  definition: {
    name: "write_file",
    description:
      "Create or overwrite a file with the given content. Creates parent directories if needed. Paths must resolve inside the working directory.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file, relative to the working directory." },
        content: { type: "string", description: "Full file content to write." },
      },
      required: ["path", "content"],
    },
  },
  permission: "write",
  async execute(args, ctx) {
    let target: string;
    try {
      target = await resolveWriteTarget(ctx.cwd, args.path ?? "");
    } catch (e) {
      return (e as Error).message;
    }
    const content = String(args.content ?? "");
    try {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      target = await resolveWriteTarget(ctx.cwd, args.path ?? "");
      await fsp.writeFile(target, content, "utf8");
      return `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${target}`;
    } catch (e) {
      return `Error writing ${target}: ${(e as Error).message}`;
    }
  },
};

const editFile: Tool = {
  definition: {
    name: "edit_file",
    description:
      "Replace an exact substring in a file. When old_string appears multiple times, set replace_all=true or include more surrounding context for a unique match. Paths must resolve inside the working directory.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file, relative to the working directory." },
        old_string: { type: "string", description: "Exact text to replace." },
        new_string: { type: "string", description: "Replacement text." },
        replace_all: {
          type: "boolean",
          description: "Replace every occurrence of old_string.",
        },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  permission: "write",
  async execute(args, ctx) {
    let target: string;
    try {
      target = await resolveExistingTarget(ctx.cwd, args.path ?? "");
    } catch (e) {
      return (e as Error).message;
    }
    const oldString = String(args.old_string ?? "");
    const newString = String(args.new_string ?? "");
    let text: string;
    try {
      text = await readTextFile(target);
    } catch (e) {
      return `Error reading ${target}: ${(e as Error).message}`;
    }
    if (!oldString) return `edit_file: old_string must not be empty (${target})`;
    const matches = text.split(oldString).length - 1;
    if (matches === 0) return `old_string not found in ${target}`;
    if (matches > 1 && !args.replace_all) {
      return `${matches} occurrences of old_string in ${target}; use replace_all=true or a more specific old_string`;
    }
    const updated = args.replace_all
      ? text.split(oldString).join(newString)
      : text.replace(oldString, newString);
    try {
      let writeTarget = await resolveExistingTarget(ctx.cwd, args.path ?? "");
      await fsp.writeFile(writeTarget, updated, "utf8");
    } catch (e) {
      return `Error writing ${target}: ${(e as Error).message}`;
    }
    return `Replaced ${args.replace_all ? matches : 1} occurrence(s) in ${target}`;
  },
};

const listFiles: Tool = {
  definition: {
    name: "list_files",
    description:
      "Recursively list files under a directory, skipping common ignore dirs. Paths must resolve inside the working directory.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory to list, relative to the working directory." },
        maxDepth: { type: "integer", description: "Maximum recursion depth." },
        maxResults: { type: "integer", description: "Maximum number of file paths to return." },
      },
      required: [],
    },
  },
  permission: "read",
  async execute(args, ctx) {
    let dir: string;
    try {
      dir = await resolveExistingTarget(ctx.cwd, args.path ?? ".");
    } catch (e) {
      return (e as Error).message;
    }
    const maxDepth = Math.max(1, Number(args.maxDepth ?? 6) | 0);
    const maxResults = Math.max(1, Number(args.maxResults ?? 500) | 0);
    const ignore = ctx.ignore ?? DEFAULT_IGNORE;
    let fileList = await walkFiles(dir, ignore, maxResults);
    fileList = fileList
      .filter((f) => f.split("/").length - 1 < maxDepth)
      .sort();
    const truncated = fileList.length >= maxResults ? "\n...[more files omitted]" : "";
    return fileList.join("\n") + truncated;
  },
};

export const fileTools: Tool[] = [readFile, writeFile, editFile, listFiles];