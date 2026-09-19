import { describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDefaultTools } from "../src/tools/index.js";
import {
  MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  validateTimeoutMs,
  runCommand,
} from "../src/tools/shell.js";

describe("run_command timeout clamping", () => {
  it("clamps too-small timeouts to the safe minimum", () => {
    expect(validateTimeoutMs(10)).toBe(MIN_TIMEOUT_MS);
    expect(validateTimeoutMs(-5)).toBe(MIN_TIMEOUT_MS);
  });

  it("clamps too-large timeouts to the safe maximum", () => {
    expect(validateTimeoutMs(5_000_000)).toBe(MAX_TIMEOUT_MS);
    expect(validateTimeoutMs(Number.POSITIVE_INFINITY)).toBe(MAX_TIMEOUT_MS);
  });

  it("falls back to the default for invalid input", () => {
    expect(validateTimeoutMs("banana")).toBe(DEFAULT_TIMEOUT_MS);
    expect(validateTimeoutMs(Number.NaN)).toBe(DEFAULT_TIMEOUT_MS);
    expect(validateTimeoutMs(undefined)).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("keeps in-range values", () => {
    expect(validateTimeoutMs(5_000)).toBe(5_000);
  });
});

describe("runCommand outcome classification", () => {
  const node = JSON.stringify(process.execPath);
  const hangCmd = `${node} -e "setTimeout(() => {}, 5000)"`;

  it("reports a successful exit", async () => {
    const { code, output, outcome, signal } = await runCommand(
      `${node} -e "process.stdout.write('hi')"`,
      { cwd: process.cwd() },
    );
    expect(outcome).toBe("exit");
    expect(code).toBe(0);
    expect(signal).toBeNull();
    expect(output).toContain("hi");
  });

  it("reports a normal non-zero exit (not as a timeout, not as a signal)", async () => {
    const { code, outcome, signal } = await runCommand(
      `${node} -e "process.exitCode = 7; process.stdout.write('boom')"`,
      { cwd: process.cwd() },
    );
    expect(outcome).toBe("exit");
    expect(code).toBe(7);
    expect(signal).toBeNull();
  });

  it("actually stops a ~5s command at the clamped 1s timeout and measures under 3s", async () => {
    const start = Date.now();
    const { outcome, code, signal } = await runCommand(hangCmd, {
      cwd: process.cwd(),
      timeoutMs: 1,
    });
    const elapsed = Date.now() - start;
    expect(outcome).toBe("timeout");
    expect(code).toBeNull();
    expect(signal).toBeNull();
    expect(elapsed).toBeLessThan(3000);
  }, 30000);

  it("reports the clamped timeout duration and stops promptly through run_command", async () => {
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "openplusexyz-shell-"));
    const tools = createDefaultTools();
    const start = Date.now();
    const result = await tools.run("run_command", { command: hangCmd, timeoutMs: 1 }, { cwd });
    const elapsed = Date.now() - start;
    // 1ms is clamped to the 1000ms minimum; construct the expected message.
    expect(result).toContain(`[timed out after ${MIN_TIMEOUT_MS}ms]`);
    expect(elapsed).toBeLessThan(3000);
  }, 30000);

  it("does not leave a timed-out descendant process running after runCommand resolves", async () => {
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "openplusexyz-cleanup-"));
    const marker = path.join(cwd, "child.pid");
    // A node process that reports its own PID, then runs forever. If a
    // timeout leaves this descendant alive, the marker PID stays valid.
    // The -e body only uses single quotes so cmd.exe does not mangle it.
    const neverExit = `${node} -e "require('fs').writeFileSync(require('path').join(process.cwd(), 'child.pid'), String(process.pid)); setInterval(() => {}, 100)"`;
    const start = Date.now();
    const { outcome, code, signal } = await runCommand(neverExit, {
      cwd,
      timeoutMs: 1,
    });
    const elapsed = Date.now() - start;
    expect(outcome).toBe("timeout");
    expect(code).toBeNull();
    expect(signal).toBeNull();
    expect(elapsed).toBeLessThan(3000);

    const descendantPid = Number((await fsp.readFile(marker, "utf8")).trim());
    let alive = true;
    try {
      process.kill(descendantPid, 0);
    } catch {
      alive = false;
    }
    // Defensive cleanup first so a failure never leaks a running process.
    if (alive) {
      try {
        process.kill(descendantPid);
      } catch {
        // already gone
      }
    }
    expect(alive).toBe(false);
  }, 30000);

  it("reports a normal exit through the run_command tool", async () => {
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "openplusexyz-shell-"));
    const tools = createDefaultTools();
    const result = await tools.run(
      "run_command",
      { command: `${node} -e "process.stdout.write('shell-tool-ok')"`, timeoutMs: 100_000 },
      { cwd },
    );
    expect(result).toContain("[exit 0]");
    expect(result).toContain("shell-tool-ok");
    expect(result).not.toContain("timed out");
  });

  it("rejects empty commands", async () => {
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "openpluse-shell-"));
    const tools = createDefaultTools();
    const result = await tools.run("run_command", { command: "  " }, { cwd });
    expect(result).toBe("run_command: command must not be empty");
  });
});

// External-signal classification only works where a process can report being
// killed by a signal (POSIX). On Windows the kernel reports termination as an
// exit code (and Node has no SIGTERM delivery semantics), so we skip with a
// clear reason instead of weakening timeout behavior.
const externalSignalSupported = process.platform !== "win32";
if (!externalSignalSupported) {
  console.log(
    "note: external-signal test skipped - this platform does not report POSIX signal termination",
  );
}

describe.runIf(externalSignalSupported)("external signal classification", () => {
  it("classifies a process self-terminated by SIGTERM as signal, not timeout", async () => {
    const start = Date.now();
    const { outcome, code, signal } = await runCommand("kill -s TERM -$$", {
      cwd: process.cwd(),
      timeoutMs: 100_000,
    });
    expect(outcome).toBe("signal");
    expect(signal).toBe("SIGTERM");
    expect(code).toBeNull();
    // Even though the command dies quickly, the long timeout must not be
    // reported as a timeout.
    expect(Date.now() - start).toBeLessThan(10_000);
  }, 30000);
});
