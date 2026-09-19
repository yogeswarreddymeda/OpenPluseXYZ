import { scanProject } from "./scanner.js";
import { formatProjectContext } from "./context.js";

export { scanProject, type ProjectContext, type ScanOptions } from "./scanner.js";
export { formatProjectContext } from "./context.js";

export async function summarizeProject(opts: {
  cwd: string;
  ignore?: string[];
  maxLines: number;
}): Promise<string> {
  const ctx = await scanProject({ cwd: opts.cwd, ignore: opts.ignore });
  return formatProjectContext(ctx, opts.maxLines);
}