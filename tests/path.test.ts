import { describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDefaultTools } from "../src/tools/index.js";
import {
  resolveWorkspacePath,
  resolveGlobPrefix,
  isPathInside,
} from "../src/tools/util.js";

const tools = createDefaultTools();

async function makeWorkspace(): Promise<{ cwd: string; parent: string }> {
  const parent = await fsp.mkdtemp(path.join(os.tmpdir(), "openplusexyz-safe-"));
  const cwd = path.join(parent, "workspace");
  await fsp.mkdir(path.join(cwd, "nested", "deep"), { recursive: true });
  await fsp.writeFile(path.join(cwd, "nested", "deep", "file.txt"), "hello\nworld\n", "utf8");
  const outside = path.join(parent, "outside.txt");
  await fsp.writeFile(outside, "secret", "utf8");
  return { cwd, parent };
}

describe("resolveWorkspacePath", () => {
  it("allows nested paths inside the workspace", () => {
    const cwd = path.resolve("proj");
    expect(resolveWorkspacePath(cwd, "src/app.ts")).toBe(path.join(cwd, "src", "app.ts"));
    expect(resolveWorkspacePath(cwd, "a/b/../c.ts")).toBe(path.join(cwd, "a", "c.ts"));
  });

  it("allows the workspace itself", () => {
    const cwd = path.resolve("proj");
    expect(resolveWorkspacePath(cwd, ".")).toBe(cwd);
  });

  it("rejects relative traversal outside the workspace", () => {
    const cwd = path.resolve("proj");
    expect(() => resolveWorkspacePath(cwd, path.join("..", "outside.txt"))).toThrow(
      "Path is outside the working directory.",
    );
    expect(() => resolveWorkspacePath(cwd, path.join("src", "..", "..", "secret.txt"))).toThrow(
      "Path is outside the working directory.",
    );
    expect(() => resolveWorkspacePath(cwd, "..")).toThrow("Path is outside the working directory.");
  });

  it("rejects absolute paths even when nested inside", () => {
    const cwd = path.resolve("proj");
    expect(() => resolveWorkspacePath(cwd, path.join(cwd, "src", "app.ts"))).toThrow(
      "Path is outside the working directory.",
    );
  });

  it("rejects empty paths", () => {
    expect(() => resolveWorkspacePath("proj", "")).toThrow("Path must not be empty.");
    expect(() => resolveWorkspacePath("proj", undefined)).toThrow("Path must not be empty.");
  });

  it("rejects glob patterns escaping the workspace", () => {
    const cwd = path.resolve("proj");
    expect(() => resolveGlobPrefix(cwd, "../outside/**/*.ts")).toThrow(
      "Path is outside the working directory.",
    );
    expect(() => resolveGlobPrefix(cwd, `${cwd}/**/*.ts`)).toThrow(
      "Path is outside the working directory.",
    );
    expect(() => resolveGlobPrefix(cwd, "src/**/*.ts")).not.toThrow();
  });
});

describe("file tool path confinement", () => {
  it("read_file reads an allowed nested path", async () => {
    const { cwd } = await makeWorkspace();
    const result = await tools.run("read_file", { path: "nested/deep/file.txt" }, { cwd });
    expect(result).toContain("1: hello");
    expect(result).toContain("2: world");
  });

  it("read_file rejects ../ paths", async () => {
    const { cwd } = await makeWorkspace();
    const result = await tools.run("read_file", { path: "../outside.txt" }, { cwd });
    expect(result).toBe("Path is outside the working directory.");
  });

  it("read_file rejects absolute paths", async () => {
    const { cwd } = await makeWorkspace();
    const result = await tools.run("read_file", { path: path.join(cwd, "nested", "deep", "file.txt") }, { cwd });
    expect(result).toBe("Path is outside the working directory.");
  });

  it("list_files rejects ..", async () => {
    const { cwd } = await makeWorkspace();
    const result = await tools.run("list_files", { path: ".." }, { cwd });
    expect(result).toBe("Path is outside the working directory.");
  });

  it("glob rejects patterns outside the workspace", async () => {
    const { cwd } = await makeWorkspace();
    const result = await tools.run("glob", { pattern: "../**/*.txt" }, { cwd });
    expect(result).toBe("Path is outside the working directory.");
  });

  it("grep rejects glob outside the workspace", async () => {
    const { cwd } = await makeWorkspace();
    const result = await tools.run("grep", { pattern: "foo", glob: "../**/*.txt" }, { cwd });
    expect(result).toBe("Path is outside the working directory.");
  });

  it("write_file rejects traversal and does not create anything", async () => {
    const { cwd, parent } = await makeWorkspace();
    const bad = path.join(parent, "evil.txt");
    const result = await tools.run("write_file", { path: "../evil.txt", content: "x" }, { cwd });
    expect(result).toBe("Path is outside the working directory.");
    await expect(fsp.readFile(bad, "utf8")).rejects.toThrow();
  });

  it("write_file rejects absolute paths", async () => {
    const { cwd, parent } = await makeWorkspace();
    const absolute = path.resolve(parent, "evil.txt");
    const result = await tools.run("write_file", { path: absolute, content: "x" }, { cwd });
    expect(result).toBe("Path is outside the working directory.");
    await expect(fsp.readFile(absolute, "utf8")).rejects.toThrow();
  });

  it("edit_file rejects traversal", async () => {
    const { cwd, parent } = await makeWorkspace();
    const outside = path.join(parent, "outside.txt");
    await fsp.writeFile(outside, "hello", "utf8");
    const result = await tools.run(
      "edit_file",
      { path: "../outside.txt", old_string: "hello", new_string: "bye" },
      { cwd },
    );
    expect(result).toBe("Path is outside the working directory.");
    expect(await fsp.readFile(outside, "utf8")).toBe("hello");
  });

  it("write_file can create nested folders inside the workspace", async () => {
    const { cwd } = await makeWorkspace();
    const result = await tools.run(
      "write_file",
      { path: "deep/new/dir/file.txt", content: "ok" },
      { cwd },
    );
    expect(result).toContain("Wrote 2 bytes");
    expect(await fsp.readFile(path.join(cwd, "deep/new/dir/file.txt"), "utf8")).toBe("ok");
  });
});

describe("isPathInside", () => {
  it("treats the base itself and descendants as inside", () => {
    expect(isPathInside("C:\\proj", "C:\\proj")).toBe(true);
    expect(isPathInside("C:\\proj", "C:\\proj\\src\\x.ts")).toBe(true);
  });

  it("rejects siblings and parents", () => {
    expect(isPathInside("C:\\proj", "C:\\proj2\\x.ts")).toBe(false);
    expect(isPathInside("C:\\proj", "C:\\x.ts")).toBe(false);
    expect(isPathInside("C:\\proj", "C:\\other\\x.ts")).toBe(false);
  });
});

async function canCreateSymlinks(): Promise<boolean> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "openplusexyz-link-"));
  try {
    await fsp.symlink(path.join(dir, "target.txt"), path.join(dir, "link.txt"), "file");
    return true;
  } catch {
    return false;
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

// Symlink tests below only run where symlinks can be created. On Windows this
// requires Developer Mode or elevated (admin) privileges, so the whole suite is
// gated by `describe.runIf`, which reports these tests as skipped (visible in
// the vitest summary) rather than failing. To exercise them on any OS, enable
// Windows Developer Mode, or run the suite on Linux/macOS (see README).
const symlinksSupported = await canCreateSymlinks();
if (!symlinksSupported) {
  console.log("note: symlink tests skipped - creating symlinks is unavailable on this system");
}

describe.runIf(symlinksSupported)("symlink escapes", () => {
  async function makeSymlinkWorkspace(): Promise<{ cwd: string; parent: string }> {
    const parent = await fsp.mkdtemp(path.join(os.tmpdir(), "openplusexyz-sym-"));
    const cwd = path.join(parent, "workspace");
    await fsp.mkdir(cwd, { recursive: true });
    const outsideDir = path.join(parent, "outside-dir");
    await fsp.mkdir(outsideDir, { recursive: true });
    await fsp.writeFile(path.join(outsideDir, "secret.txt"), "TOP_SECRET", "utf8");
    await fsp.writeFile(path.join(parent, "outside.txt"), "confidential", "utf8");
    await fsp.symlink(path.join(parent, "outside.txt"), path.join(cwd, "leak.txt"), "file");
    await fsp.symlink(outsideDir, path.join(cwd, "linkdir"), "dir");
    return { cwd, parent };
  }

  it("read_file rejects a symlink file escaping the workspace", async () => {
    const { cwd, parent } = await makeSymlinkWorkspace();
    const result = await tools.run("read_file", { path: "leak.txt" }, { cwd });
    expect(result).toBe("Path is outside the working directory.");
    expect(await fsp.readFile(path.join(parent, "outside.txt"), "utf8")).toBe("confidential");
  });

  it("edit_file rejects a symlink file escaping the workspace", async () => {
    const { cwd, parent } = await makeSymlinkWorkspace();
    const result = await tools.run(
      "edit_file",
      { path: "leak.txt", old_string: "confidential", new_string: "tampered" },
      { cwd },
    );
    expect(result).toBe("Path is outside the working directory.");
    expect(await fsp.readFile(path.join(parent, "outside.txt"), "utf8")).toBe("confidential");
  });

  it("write_file rejects paths through a symlinked directory", async () => {
    const { cwd, parent } = await makeSymlinkWorkspace();
    const result = await tools.run(
      "write_file",
      { path: "linkdir/evil.txt", content: "x" },
      { cwd },
    );
    expect(result).toBe("Path is outside the working directory.");
    await expect(fsp.readFile(path.join(parent, "outside-dir", "evil.txt"), "utf8")).rejects.toThrow();
  });

  it("list_files rejects a symlinked directory", async () => {
    const { cwd } = await makeSymlinkWorkspace();
    const result = await tools.run("list_files", { path: "linkdir" }, { cwd });
    expect(result).toBe("Path is outside the working directory.");
  });

  it("glob ignores symlinked directories", async () => {
    const { cwd } = await makeSymlinkWorkspace();
    const result = await tools.run("glob", { pattern: "**/*.txt" }, { cwd });
    expect(result).toBe("No files match **/*.txt");
  });

  it("grep does not search symlinked directories", async () => {
    const { cwd } = await makeSymlinkWorkspace();
    const result = await tools.run("grep", { pattern: "TOP_SECRET" }, { cwd });
    expect(result).toBe("No matches for TOP_SECRET");
  });
});
