import { spawn, type ChildProcess } from "node:child_process";
import type { Tool } from "./registry.js";
import { truncate } from "./util.js";

export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 600_000;
export const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * After a timeout is requested the original child process is given this long
 * to emit its `close` event and confirm it actually stopped. If the child
 * cannot be confirmed closed within this window, `runCommand` reports a
 * non-timeout failure with a safe diagnostic instead of hanging forever or
 * claiming a timeout the child never honored.
 */
export const TIMEOUT_CONFIRM_MS = 5_000;

export type CommandOutcome = "exit" | "signal" | "timeout";

export interface CommandResult {
  code: number | null;
  signal: string | null;
  output: string;
  outcome: CommandOutcome;
}

export function validateTimeoutMs(raw: unknown): number {
  const n = Number(raw);
  if (Number.isNaN(n)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(n)));
}

export interface TreeKillResult {
  ok: boolean;
  detail: string;
}

/**
 * Terminate the whole tree rooted at the shell process on Windows. The shell
 * parent does not propagate signals to its children, so `taskkill.exe` (the
 * explicit Windows executable) is asked to force-kill the tree rooted at the
 * child's PID. We capture its exit code and stderr for diagnostics and await
 * its completion before the caller may conclude anything about the command.
 * Only exit code 0 means the tree was torn down. A "process not found" result
 * is treated as success: it means the process record is already gone, which is
 * the end state we want.
 *
 * This is the tree teardown used by the timeout enforcer; on its own it is not
 * relied on to stop the command. The enforcer additionally force-terminates
 * the direct child so a failed or blocked `taskkill.exe` can never leave the
 * command running until it exits naturally. Ordering matters: `taskkill` must
 * run while the shell PID is still alive, otherwise `/T` cannot enumerate (and
 * kill) the descended processes that keep `close` from firing.
 */
async function terminateTreeWindows(child: ChildProcess): Promise<TreeKillResult> {
  const pid = child.pid;
  if (pid == null) return { ok: false, detail: "child process id unavailable" };
  return new Promise<TreeKillResult>((resolve) => {
    let killer: ChildProcess;
    try {
      killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (e) {
      resolve({ ok: false, detail: `could not start taskkill.exe: ${(e as Error).message}` });
      return;
    }
    let stderr = "";
    killer.stderr?.on("data", (d) => {
      stderr += d;
    });
    const fail = (detail: string): void => resolve({ ok: false, detail });
    killer.on("error", (e) => fail(`taskkill.exe failed to start: ${e.message}`));
    killer.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true, detail: "" });
        return;
      }
      const text = stderr.trim();
      if (text.toLowerCase().includes("not found")) {
        // The shell process record is already gone; the tree can legitimately
        // be absent (command finished on its own right at the deadline).
        resolve({ ok: true, detail: "" });
        return;
      }
      const extra = text ? `: ${text}` : "";
      fail(`taskkill.exe exited with code ${code}${extra}`);
    });
  });
}

/**
 * Force-terminate the direct child (the shell wrapper) without a shell. This
 * is the guaranteed fallback of the timeout enforcer: even if `taskkill.exe`
 * was denied or blocked, the direct child itself is still force-terminated so
 * the command cannot run until it exits naturally. A `kill()` that reports no
 * signal was sent is not a failure here — it typically means the process is
 * already gone, which is the end state we want.
 */
function attemptDirectKill(child: ChildProcess): { ok: boolean; detail: string } {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { ok: true, detail: "" };
  }
  try {
    child.kill();
    return { ok: true, detail: "" };
  } catch (e) {
    return { ok: false, detail: `child.kill() threw: ${(e as Error).message}` };
  }
}

/**
 * Windows timeout enforcement sequence. `taskkill.exe /PID <pid> /T /F` is
 * spawned directly (never through `shell: true`) to tear the whole tree down;
 * it must run while the shell PID is alive so the descendants that hold the
 * stdio streams open are found and killed too. Afterwards the direct child is
 * force-terminated with `child.kill()` as a guaranteed fallback. Diagnostics
 * are limited to safe, non-sensitive information (taskkill exit code/stderr).
 */
async function enforceWindowsTimeout(child: ChildProcess): Promise<string> {
  const diagnostics: string[] = [];
  const tree = await terminateTreeWindows(child);
  if (!tree.ok) {
    diagnostics.push(`${TIMEOUT_DIAGNOSTIC} taskkill.exe could not stop the process tree: ${tree.detail}`);
  }
  const direct = attemptDirectKill(child);
  if (!direct.ok) {
    diagnostics.push(`${TIMEOUT_DIAGNOSTIC} child.kill() could not terminate the shell: ${direct.detail}`);
  }
  return diagnostics.join("\n");
}

/**
 * Terminate the command's process group on POSIX. The child was spawned
 * detached so its process group equals its PID and one group kill SIGKILLs
 * every descendant synchronously. ESRCH/ENOENT mean the group is already gone,
 * which counts as success.
 */
function terminateTreePosix(child: ChildProcess): TreeKillResult {
  const pid = child.pid;
  if (pid == null) return { ok: false, detail: "child process id unavailable" };
  try {
    process.kill(-pid, "SIGKILL");
    return { ok: true, detail: "" };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ESRCH" || err.code === "ENOENT") return { ok: true, detail: "" };
    return { ok: false, detail: `could not signal process group: ${err.message}` };
  }
}

const TIMEOUT_DIAGNOSTIC = "[timeout enforcer]";

/**
 * Execute a command and classify how it ended:
 * - "exit"    the child exited normally with the returned exit code;
 * - "signal"  the child was terminated by an external signal (not our timeout);
 * - "timeout" the child was stopped by this tool because the timeout elapsed.
 *
 * On a timeout the whole process tree is killed. On Windows, `taskkill.exe
 * /PID <pid> /T /F` is spawned directly (never through a shell) to tear the
 * tree down while the shell PID is still known, and the direct child is then
 * force-terminated with `child.kill()` as a guaranteed fallback. On POSIX the
 * detached process group is SIGKILLed. `outcome: "timeout"` is ONLY reported
 * after the original child's `close` event has confirmed it actually stopped;
 * a failed tree-kill is attached as a `[timeout enforcer]` diagnostic instead
 * of changing the classification. If the child cannot be confirmed closed
 * within `TIMEOUT_CONFIRM_MS` of the deadline, a non-timeout failure is
 * reported rather than a possibly-false timeout. Timers and listeners are
 * cleaned up on every outcome and the promise resolves at most once.
 */
export function runCommand(
  cmd: string,
  opts: { cwd: string; timeoutMs?: number },
): Promise<CommandResult> {
  const timeoutMs = validateTimeoutMs(opts.timeoutMs);
  return new Promise((resolve) => {
    const child = spawn(cmd, {
      cwd: opts.cwd,
      shell: true,
      windowsHide: true,
      env: process.env,
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += d;
    });
    child.stderr?.on("data", (d) => {
      stderr += d;
    });

    let settled = false;
    let timeoutRequested = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let confirmTimer: ReturnType<typeof setTimeout> | undefined;
    let killDiagnostic = "";
    let killSettled: Promise<string> = Promise.resolve("");

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (confirmTimer) clearTimeout(confirmTimer);
      timer = undefined;
      confirmTimer = undefined;
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.removeAllListeners();
    };

    const finish = (
      code: number | null,
      signal: string | null,
      outcome: CommandOutcome,
      extraOutput?: string,
    ) => {
      if (settled) return;
      settled = true;
      cleanup();
      const base = [stdout, stderr].filter(Boolean).join("\n").trim() || "(no output)";
      const output = extraOutput ? `${base}\n${extraOutput}`.trim() : base;
      resolve({
        code,
        signal: outcome === "signal" ? signal : null,
        output: truncate(output),
        outcome,
      });
    };

    timer = setTimeout(() => {
      timeoutRequested = true;
      timer = undefined;

      confirmTimer = setTimeout(() => {
        confirmTimer = undefined;
        // The original child could not be confirmed closed. Never claim a
        // timeout that might be a lie; report a clear non-timeout failure.
        const diag =
          killDiagnostic ||
          `${TIMEOUT_DIAGNOSTIC} the child could not be confirmed stopped after the deadline; not reporting a timeout`;
        finish(null, null, "exit", diag);
      }, TIMEOUT_CONFIRM_MS);

      if (process.platform === "win32") {
        killSettled = enforceWindowsTimeout(child).then((diag) => {
          if (diag) killDiagnostic = diag;
          return diag;
        });
      } else {
        const res = terminateTreePosix(child);
        if (!res.ok) {
          killDiagnostic = `${TIMEOUT_DIAGNOSTIC} could not stop the process group: ${res.detail}`;
        }
      }
    }, timeoutMs);

    child.on("error", (err) => {
      stderr += err.message;
      finish(null, null, "exit");
    });
    child.on("close", (code, signal) => {
      if (timeoutRequested) {
        clearConfirmTimer();
        // The command has actually stopped, so this is a genuine timeout. A
        // failed tree-kill must never be reported as `exit`; it is attached as
        // a diagnostic instead. Resolve after the kill attempt settled.
        void killSettled.then((diag) => {
          finish(null, null, "timeout", diag || killDiagnostic || undefined);
        });
        return;
      }
      if (code !== null) {
        finish(code, null, "exit");
        return;
      }
      finish(code, signal, "signal");
    });

    function clearConfirmTimer() {
      if (confirmTimer) clearTimeout(confirmTimer);
      confirmTimer = undefined;
    }
  });
}

const runShell: Tool = {
  definition: {
    name: "run_command",
    description:
      "Run a shell command in the working directory. Returns exit code and output. IMPORTANT: commands execute with the user's OS permissions and are NOT sandboxed; only run commands you would be comfortable running yourself.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to execute." },
        timeoutMs: {
          type: "integer",
          description: `Timeout in milliseconds (clamped to ${MIN_TIMEOUT_MS}-${MAX_TIMEOUT_MS}).`,
        },
      },
      required: ["command"],
    },
  },
  permission: "execute",
  async execute(args, ctx) {
    const command = String(args.command ?? "");
    if (!command.trim()) return "run_command: command must not be empty";
    const timeoutMs = validateTimeoutMs(args.timeoutMs);
    const { code, signal, output, outcome } = await runCommand(command, {
      cwd: ctx.cwd,
      timeoutMs,
    });
    const status =
      outcome === "timeout"
        ? `timed out after ${timeoutMs}ms`
        : outcome === "signal"
          ? `terminated by signal ${signal}`
          : code === null
            ? "stopped without an exit code"
            : `exit ${code}`;
    return `$ ${command}\n[${status}]\n${output}`;
  },
};

export const shellTools: Tool[] = [runShell];
