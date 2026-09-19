import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";

describe("parseArgs", () => {
  it("parses a plain prompt", () => {
    const parsed = parseArgs(["fix", "the", "bug"]);
    expect(parsed).toMatchObject({ prompt: ["fix", "the", "bug"], help: false, version: false });
    expect(parsed.cwd).toBeUndefined();
    expect(parsed.provider).toBeUndefined();
    expect(parsed.model).toBeUndefined();
  });

  it("supports flags in any order with the prompt after them", () => {
    const parsed = parseArgs(["--provider", "gemini", "explain", "--cwd", "/tmp/x", "--model", "flash", "this"]);
    expect(parsed.cwd).toBe("/tmp/x");
    expect(parsed.provider).toBe("gemini");
    expect(parsed.model).toBe("flash");
    expect(parsed.prompt).toEqual(["explain", "this"]);
  });

  it("never leaks flag values into the prompt", () => {
    const parsed = parseArgs(["--cwd", "/proj", "--model", "m1", "run", "--provider", "ollama", "tests"]);
    expect(parsed.prompt).toEqual(["run", "tests"]);
    expect(parsed.cwd).toBe("/proj");
    expect(parsed.model).toBe("m1");
    expect(parsed.provider).toBe("ollama");
  });

  it("errors on a missing value at end of argv", () => {
    expect(() => parseArgs(["--cwd"])).toThrow("Missing value for --cwd");
    expect(() => parseArgs(["explain", "--model"])).toThrow("Missing value for --model");
    expect(() => parseArgs(["--provider"])).toThrow("Missing value for --provider");
  });

  it("errors on a missing value followed by another flag", () => {
    expect(() => parseArgs(["--cwd", "--provider", "gemini"])).toThrow("Missing value for --cwd");
  });

  it("errors on unknown options", () => {
    expect(() => parseArgs(["--bogus"])).toThrow("Unknown option: --bogus");
  });

  it("recognises help and version flags anywhere", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(parseArgs(["--version"]).version).toBe(true);
    expect(parseArgs(["-v"]).version).toBe(true);
    expect(parseArgs(["prompt", "--help"]).help).toBe(true);
  });

  it("returns an empty prompt for no arguments", () => {
    expect(parseArgs([])).toMatchObject({ prompt: [], help: false, version: false });
  });
});