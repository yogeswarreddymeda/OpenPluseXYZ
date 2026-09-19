import { describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig, clampInt, clampNumber } from "../src/config/index.js";

describe("numeric config clamping", () => {
  it("clamps integers to a positive range", () => {
    expect(clampInt("bogus", 1, 100, 5)).toBe(5);
    expect(clampInt(-10, 1, 100, 5)).toBe(1);
    expect(clampInt(1e9, 1, 100, 5)).toBe(100);
    expect(clampInt(42, 1, 100, 5)).toBe(42);
  });

  it("clamps floats to a range", () => {
    expect(clampNumber(50, 0, 2, 0.3)).toBe(2);
    expect(clampNumber(0.5, 0, 2, 0.3)).toBe(0.5);
    expect(clampNumber(Number.NaN, 0, 2, 0.3)).toBe(0.3);
  });
});

describe("loadConfig", () => {
  it("applies defaults and clamps invalid values from config files", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "openplusexyz-cfg-"));
    const configFile = path.join(dir, "default.json");
    await fsp.writeFile(
      configFile,
      JSON.stringify({
        provider: "openrouter",
        model: "",
        providers: {
          openrouter: { model: "m1" },
          gemini: { model: "g1" },
          ollama: { model: "o1" },
        },
        temperature: 99,
        maxTokens: -1,
        maxIterations: 0,
        contextLines: 1,
        maxHistoryMessages: "lots",
        maxHistoryChars: -5,
        security: { default: "allow", read: "allow", write: "ask", execute: "ask" },
      }),
      "utf8",
    );
    const cfg = await loadConfig({ cwd: dir, configFile });

    expect(cfg.temperature).toBe(2);
    expect(cfg.maxTokens).toBe(1);
    expect(cfg.maxIterations).toBe(1);
    expect(cfg.contextLines).toBe(5);
    expect(cfg.maxHistoryMessages).toBe(200);
    expect(cfg.maxHistoryChars).toBe(1_000);
  });

  it("reads sensible defaults from the shipped default.json", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "openplusexyz-cfg-"));
    const cfg = await loadConfig({ cwd: dir });
    expect(cfg.provider).toBe("openrouter");
    expect(cfg.maxHistoryMessages).toBeGreaterThan(0);
    expect(cfg.maxHistoryChars).toBeGreaterThan(0);
    expect(Array.isArray(cfg.ignore)).toBe(true);
  });

  it("prefers OPENPLUSEXYZ environment variables while supporting deprecated aliases", async () => {
    const oldProvider = process.env["OPENPLUSE_PROVIDER"];
    const newProvider = process.env["OPENPLUSEXYZ_PROVIDER"];
    try {
      process.env["OPENPLUSE_PROVIDER"] = "gemini";
      process.env["OPENPLUSEXYZ_PROVIDER"] = "ollama";
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "openplusexyz-cfg-"));
      const cfg = await loadConfig({ cwd: dir });
      expect(cfg.provider).toBe("ollama");
    } finally {
      if (oldProvider === undefined) delete process.env["OPENPLUSE_PROVIDER"];
      else process.env["OPENPLUSE_PROVIDER"] = oldProvider;
      if (newProvider === undefined) delete process.env["OPENPLUSEXYZ_PROVIDER"];
      else process.env["OPENPLUSEXYZ_PROVIDER"] = newProvider;
    }
  });
});
