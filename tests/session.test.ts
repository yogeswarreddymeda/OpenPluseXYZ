import { describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config/index.js";
import { Session } from "../src/session.js";

async function makeCwd(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), "openplusexyz-sess-"));
}

describe("Session provider/model switching", () => {
  it("recreates the session when switching provider", async () => {
    const cwd = await makeCwd();
    const cfg = await loadConfig({ cwd });
    const session = await Session.create(cfg, cwd);

    const switched = await session.applyChanges({ provider: "ollama" });
    expect(switched).not.toBe(session);
    expect(switched.activeProvider).toBe("ollama");
    expect(switched.activeModel).toBe("qwen2.5-coder:7b");
    expect(session.activeProvider).toBe(cfg.provider);
  });

  it("recreates the session when switching model", async () => {
    const cwd = await makeCwd();
    const cfg = await loadConfig({ cwd });
    const session = await Session.create(cfg, cwd);
    const oldModel = session.activeModel;

    const switched = await session.applyChanges({ model: "custom/model" });
    expect(switched.activeModel).toBe("custom/model");
    expect(switched.activeProvider).toBe(oldModel ? session.activeProvider : session.activeProvider);
    expect(session.activeModel).toBe(oldModel);
  });

  it("throws on an unknown provider and leaves the prior session untouched", async () => {
    const cwd = await makeCwd();
    const cfg = await loadConfig({ cwd });
    const session = await Session.create(cfg, cwd);
    const before = { provider: session.activeProvider, model: session.activeModel };

    await expect(session.applyChanges({ provider: "not-a-provider" })).rejects.toThrow(
      /Unknown provider/,
    );

    expect(session.activeProvider).toBe(before.provider);
    expect(session.activeModel).toBe(before.model);
  });

  it("builds a provider default from the active provider settings", async () => {
    const cwd = await makeCwd();
    const cfg = await loadConfig({ cwd });
    const session = await Session.create(cfg, cwd);
    expect(["openrouter", "gemini", "ollama"]).toContain(session.activeProvider);
    expect(session.activeModel.length).toBeGreaterThan(0);
  });
});
