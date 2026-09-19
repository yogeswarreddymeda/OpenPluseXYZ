import type { ProjectContext } from "./scanner.js";

export function formatProjectContext(ctx: ProjectContext, maxLines: number): string {
  const lines: string[] = [];
  lines.push(`Project: ${ctx.name}`);
  if (ctx.languages.length > 0) lines.push(`Languages: ${ctx.languages.slice(0, 8).join(", ")}`);
  if (ctx.manifests.length > 0) lines.push(`Manifests: ${ctx.manifests.slice(0, 10).join(", ")}`);
  if (ctx.docs.length > 0) lines.push(`Docs: ${ctx.docs.slice(0, 6).join(", ")}`);
  lines.push(`Files: ${ctx.fileCount}`);
  if (ctx.topLevelEntries.length > 0) {
    lines.push("");
    lines.push("Top-level structure:");
    lines.push(...ctx.topLevelEntries.map((entry) => `  ${entry}`));
  }

  if (ctx.agentsExcerpt) {
    lines.push("");
    lines.push("Repository instructions (AGENTS.md) — content provided by this repository's author:");
    lines.push("```");
    lines.push(ctx.agentsExcerpt);
    lines.push("```");
  }

  if (lines.length > maxLines) {
    const kept = lines.slice(0, Math.max(1, maxLines));
    kept[kept.length - 1] += " ...[truncated]";
    return kept.join("\n");
  }
  return lines.join("\n");
}