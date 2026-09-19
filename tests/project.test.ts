import { describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { scanProject, formatProjectContext, summarizeProject } from "../src/project/index.js";

async function makeProject(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "openplusexyz-proj-"));
  await fsp.mkdir(path.join(dir, "src"), { recursive: true });
  await fsp.mkdir(path.join(dir, "tests"), { recursive: true });
  await fsp.mkdir(path.join(dir, "node_modules", "dep"), { recursive: true });
  await fsp.mkdir(path.join(dir, "dist"), { recursive: true });
  await fsp.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "my-app" }), "utf8");
  await fsp.writeFile(path.join(dir, "README.md"), "# my-app\n\nDocs here.\n", "utf8");
  await fsp.writeFile(path.join(dir, "AGENTS.md"), "project guidelines\n", "utf8");
  await fsp.writeFile(path.join(dir, "tsconfig.json"), "{}", "utf8");
  await fsp.writeFile(path.join(dir, "src", "index.ts"), "export {};\n", "utf8");
  await fsp.writeFile(path.join(dir, "src", "helper.ts"), "", "utf8");
  await fsp.writeFile(path.join(dir, "src", "style.css"), "", "utf8");
  await fsp.writeFile(path.join(dir, "tests", "x.test.ts"), "", "utf8");
  await fsp.writeFile(path.join(dir, "node_modules", "dep", "index.js"), "", "utf8");
  await fsp.writeFile(path.join(dir, "dist", "index.js"), "", "utf8");
  return dir;
}

describe("project scanner", () => {
  it("detects name, languages, manifests, docs, and structure", async () => {
    const dir = await makeProject();
    const ctx = await scanProject({ cwd: dir });
    expect(ctx.name).toBe("my-app");
    expect(ctx.languages).toContain("TypeScript");
    expect(ctx.languages).toContain("CSS");
    expect(ctx.manifests).toContain("package.json");
    expect(ctx.manifests).toContain("tsconfig.json");
    expect(ctx.docs).toContain("README.md");
    expect(ctx.docs).toContain("AGENTS.md");
    expect(ctx.topLevelEntries).toContain("src/");
    expect(ctx.fileCount).toBeGreaterThanOrEqual(4);
  });

  it("respects ignore directories", async () => {
    const dir = await makeProject();
    const ctx = await scanProject({ cwd: dir });
    expect(ctx.topLevelEntries).not.toContain("node_modules/");
    expect(ctx.topLevelEntries).not.toContain("dist/");
    expect(ctx.languages).not.toContain("JavaScript");
  });

  it("formats a compact context summary", async () => {
    const dir = await makeProject();
    const ctx = await scanProject({ cwd: dir });
    const text = formatProjectContext(ctx, 20);
    expect(text).toContain("Project: my-app");
    expect(text).toContain("Languages:");
    expect(text).toContain("Manifests:");
    expect(text).toContain("Top-level structure:");
    expect(text).toContain("src/");
    expect(text.split("\n").length).toBeLessThanOrEqual(20);
  });

  it("caps output at contextLines", async () => {
    const dir = await makeProject();
    const text = await summarizeProject({ cwd: dir, maxLines: 3 });
    expect(text.split("\n").length).toBeLessThanOrEqual(3);
    expect(text).toContain("[truncated]");
  });

  it("falls back to directory basename when no package name", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "somename-zz-"));
    const ctx = await scanProject({ cwd: dir });
    expect(ctx.name).toBe(path.basename(dir));
    expect(ctx.languages).toEqual([]);
    expect(ctx.topLevelEntries).toEqual([]);
  });

  it("includes a bounded AGENTS.md excerpt in the project context", async () => {
    const dir = await makeProject();
    const ctx = await scanProject({ cwd: dir });
    expect(ctx.agentsExcerpt).toContain("project guidelines");

    const long = path.join(dir, "AGENTS.md");
    await fsp.writeFile(
      long,
      Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n"),
      "utf8",
    );
    const bounded = await scanProject({ cwd: dir, maxExcerptLines: 5 });
    expect(bounded.agentsExcerpt!.split("\n").length).toBeLessThanOrEqual(6);
    expect(bounded.agentsExcerpt).toContain("[agents instructions continue");
  });

  it("does not traverse symlinked directories during a scan", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "openplusexyz-symscan-"));
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "openplusexyz-outside-"));
    await fsp.writeFile(path.join(outside, "leak.rb"), "", "utf8");
    let linked = false;
    try {
      await fsp.symlink(outside, path.join(dir, "link"), "dir");
      linked = true;
    } catch {
      // symlinks unavailable on this platform; the traversal is still exercised
    }
    await fsp.writeFile(path.join(dir, "main.py"), "", "utf8");

    const ctx = await scanProject({ cwd: dir });
    expect(ctx.languages).toEqual(["Python"]);
    expect(ctx.fileCount).toBe(1);
    expect(ctx.languages).not.toContain("Ruby");
    if (linked) expect(ctx.topLevelEntries).not.toContain("link/");
  });
});
