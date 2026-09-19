import type { Tool } from "./registry.js";
import { runCommand } from "./shell.js";

async function git(args: string[], cwd: string): Promise<string> {
  const { code, output } = await runCommand(`git ${args.join(" ")}`, { cwd });
  if (code !== 0) return `git ${args.join(" ")} failed (exit ${code})\n${output}`;
  return output;
}

const gitStatus: Tool = {
  definition: {
    name: "git_status",
    description: "Show the working tree status (read-only).",
    parameters: { type: "object", properties: {}, required: [] },
  },
  permission: "read",
  async execute(_args, ctx) {
    return git(["status", "--short"], ctx.cwd);
  },
};

const gitDiff: Tool = {
  definition: {
    name: "git_diff",
    description: "Show uncommitted changes (read-only).",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Optional path to limit the diff." },
        staged: { type: "boolean", description: "Show staged changes instead of unstaged." },
      },
      required: [],
    },
  },
  permission: "read",
  async execute(args, ctx) {
    const pathArg = String(args.path ?? "");
    const stagedArg = args.staged ? ["--staged"] : [];
    const rest = pathArg ? [pathArg] : [];
    return git([...stagedArg, "diff", "--no-color", ...rest], ctx.cwd);
  },
};

const gitLog: Tool = {
  definition: {
    name: "git_log",
    description: "Show recent commit history (read-only).",
    parameters: {
      type: "object",
      properties: {
        count: { type: "integer", description: "Number of commits." },
      },
      required: [],
    },
  },
  permission: "read",
  async execute(args, ctx) {
    const count = Math.min(50, Math.max(1, Number(args.count ?? 10) | 0));
    return git(["log", `-${count}`, "--oneline", "--decorate"], ctx.cwd);
  },
};

export const gitTools: Tool[] = [gitStatus, gitDiff, gitLog];