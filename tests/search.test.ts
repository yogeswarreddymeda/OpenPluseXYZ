import { describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDefaultTools } from "../src/tools/index.js";
import {
  MAX_GREP_FILE_BYTES,
  MAX_GREP_PATTERN_LENGTH,
} from "../src/tools/util.js";
import { checkGrepPattern } from "../src/tools/search.js";

const tools = createDefaultTools();

async function makeWorkspace(): Promise<string> {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "openplusexyz-grep-"));
  await fsp.writeFile(path.join(cwd, "a.txt"), "alpha beta\ngamma\n", "utf8");
  await fsp.writeFile(path.join(cwd, "b.txt"), "alpha delta\n", "utf8");
  return cwd;
}

describe("grep guardrails", () => {
  it("searches normally with results", async () => {
    const cwd = await makeWorkspace();
    const result = await tools.run("grep", { pattern: "alpha" }, { cwd });
    expect(result).toContain("a.txt:1:");
    expect(result).toContain("b.txt:1:");
    expect(result).not.toMatch(/No matches/);
  });

  it("searches case-insensitively", async () => {
    const cwd = await makeWorkspace();
    const result = await tools.run(
      "grep",
      { pattern: "ALPHA", caseInsensitive: true },
      { cwd },
    );
    expect(result).toContain("a.txt");
  });

  it("reports no matches clearly", async () => {
    const cwd = await makeWorkspace();
    const result = await tools.run("grep", { pattern: "zzz-no-such" }, { cwd });
    expect(result).toBe("No matches for zzz-no-such");
  });

  it("rejects overlength patterns", async () => {
    const cwd = await makeWorkspace();
    const long = "a".repeat(MAX_GREP_PATTERN_LENGTH + 1);
    const result = await tools.run("grep", { pattern: long }, { cwd });
    expect(result).toContain("pattern too long");
    expect(result).toContain(String(MAX_GREP_PATTERN_LENGTH));
  });

  it("rejects catastrophic nested-quantifier patterns", async () => {
    expect(checkGrepPattern("(a+)+")).toMatch(/too complex/);
    expect(checkGrepPattern("(a*)*")).toMatch(/too complex/);
    expect(checkGrepPattern("((b+)+)")).toMatch(/too complex/);
    expect(checkGrepPattern(".*.*")).toMatch(/too complex/);
  });

  it("allows ordinary quantifier patterns", () => {
    expect(checkGrepPattern("a+")).toBeNull();
    expect(checkGrepPattern("(foo|bar)+")).toBeNull();
    expect(checkGrepPattern("[0-9]{2,4}-x")).toBeNull();
  });

  it("skips files over the size cap and says so", async () => {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "openplusexyz-grep-"));
    await fsp.writeFile(path.join(cwd, "ok.txt"), "needle here\n", "utf8");
    const big = Buffer.alloc(MAX_GREP_FILE_BYTES + 64, 0x61);
    await fsp.writeFile(path.join(cwd, "big.txt"), big);
    const result = await tools.run("grep", { pattern: "needle" }, { cwd });
    expect(result).toContain("ok.txt");
    expect(result).toMatch(/skipped 1 file\(s\) over \d+ bytes/);
  });
});
