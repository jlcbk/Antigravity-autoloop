/**
 * Zero-token local command probe runner (`runner === "command"`).
 * Executes configured `[file, ...args]` directly without a shell, isolates
 * environment secrets, and parses stdout via `readMessage()`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { InputError } from "../kernel/errors.ts";
import { readMessage } from "../protocol/receipt.ts";
import type { Job, ParsedMessage, RunUsage } from "../protocol/types.ts";

export interface RunnerExecution {
  outcome: "done" | "nothing" | "failed" | "cancelled";
  summary: string;
  rawText: string;
  parsed: ParsedMessage;
  session: string | null;
  started: boolean;
  usage?: RunUsage;
  error?: string;
  exitCode: number | null;
}

export interface CommandProbeOptions {
  job: Job;
  contextFile: string;
  guardFile: string;
  baseEnv?: NodeJS.ProcessEnv;
  killGraceMs?: number;
  onProcess?: (proc: ChildProcess) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

const DEFAULT_KILL_GRACE_MS = 3_000;

function expandHomePath(targetPath: string, homeDir = os.homedir()): string {
  if (targetPath === "~") {
    return homeDir;
  }
  if (targetPath.startsWith("~/")) {
    return path.join(homeDir, targetPath.slice(2));
  }
  return targetPath;
}

function buildSanitizedEnv(
  baseEnv: NodeJS.ProcessEnv,
  job: Job,
  contextFile: string,
  guardFile: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    const upper = key.toUpperCase();
    if (
      upper === "AUTOLOOP_OWNER_TOKEN" ||
      upper === "ANTIGRAVITY_SIDECAR_UI_TOKEN"
    ) {
      continue;
    }
    env[key] = value;
  }
  env.AUTOLOOP_RUN_ID = String(job.run);
  env.AUTOLOOP_CONTEXT = contextFile;
  env.AUTOLOOP_GUARD_FILE = guardFile;
  return env;
}

function killProcessGroup(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (proc.pid !== undefined) {
    try {
      process.kill(-proc.pid, signal);
      return;
    } catch {
      // Fallback to direct process kill if process group is already gone or unavailable.
    }
  }
  try {
    proc.kill(signal);
  } catch {
    // Ignore ESRCH when process has already exited.
  }
}

function failedParsed(summary: string): ParsedMessage {
  return {
    outcome: "failed",
    summary,
    receipt: null,
    problem: null,
  };
}

function firstLineOf(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return "";
}

/**
 * Run a zero-token local command probe configured on `job.agent.command`.
 */
export async function runCommandProbe(
  options: CommandProbeOptions,
): Promise<RunnerExecution> {
  const command = options.job.agent.command;
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    typeof command[0] !== "string" ||
    command[0].trim().length === 0 ||
    command.some((arg) => typeof arg !== "string")
  ) {
    throw new InputError(
      `Agent "${options.job.agent.id}" 的 command 必须是非空字符串数组 [file, ...args]`,
    );
  }

  if (options.signal?.aborted) {
    return {
      outcome: "cancelled",
      summary: "命令探针在启动前已取消",
      rawText: "",
      parsed: failedParsed("命令探针在启动前已取消"),
      session: null,
      started: false,
      error: "Cancelled by abort signal before start",
      exitCode: null,
    };
  }

  const baseEnv = options.baseEnv ?? process.env;
  const homeDir = baseEnv.HOME || os.homedir();
  const expandedCwd = expandHomePath(options.job.rule.cwd, homeDir);
  const sanitizedEnv = buildSanitizedEnv(
    baseEnv,
    options.job,
    options.contextFile,
    options.guardFile,
  );
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const effectiveTimeoutMs =
    options.timeoutMs ??
    (options.job.agent.timeoutMinutes !== undefined
      ? options.job.agent.timeoutMinutes * 60_000
      : undefined);

  const [file, ...args] = command;

  return new Promise<RunnerExecution>((resolve) => {
    let settled = false;
    let started = false;
    let aborted = false;
    let timedOut = false;
    let terminating = false;

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const proc = spawn(file, args, {
      cwd: expandedCwd,
      env: sanitizedEnv,
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (proc.pid !== undefined) {
      started = true;
    }

    const triggerTermination = (): void => {
      if (terminating || settled) {
        return;
      }
      terminating = true;
      killProcessGroup(proc, "SIGTERM");
      graceTimer = setTimeout(() => {
        if (!settled) {
          killProcessGroup(proc, "SIGKILL");
        }
      }, killGraceMs);
      graceTimer.unref?.();
    };

    const onAbort = (): void => {
      aborted = true;
      triggerTermination();
    };

    const cleanup = (): void => {
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      }
      if (graceTimer !== undefined) {
        clearTimeout(graceTimer);
        graceTimer = undefined;
      }
      options.signal?.removeEventListener("abort", onAbort);
    };

    const finish = (result: RunnerExecution): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };

    options.onProcess?.(proc);

    if (options.signal) {
      options.signal.addEventListener("abort", onAbort, { once: true });
      if (options.signal.aborted) {
        onAbort();
      }
    }

    if (effectiveTimeoutMs !== undefined && effectiveTimeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        triggerTermination();
      }, effectiveTimeoutMs);
      timeoutTimer.unref?.();
    }

    proc.stdout?.on("data", (chunk: Buffer | string) => {
      stdoutChunks.push(
        typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk,
      );
    });

    proc.stderr?.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(
        typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk,
      );
    });

    proc.once("spawn", () => {
      started = true;
    });

    proc.once("error", (err: Error) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      if (aborted || options.signal?.aborted) {
        finish({
          outcome: "cancelled",
          summary: "命令探针已取消",
          rawText: stdout,
          parsed: failedParsed("命令探针已取消"),
          session: null,
          started,
          error: err.message,
          exitCode: null,
        });
        return;
      }
      finish({
        outcome: "failed",
        summary: firstLineOf(err.message) || "命令探针启动失败",
        rawText: stdout,
        parsed: failedParsed(firstLineOf(err.message) || err.message),
        session: null,
        started,
        error: err.message,
        exitCode: null,
      });
    });

    proc.once("close", (code: number | null) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");

      if (aborted || options.signal?.aborted) {
        finish({
          outcome: "cancelled",
          summary: "命令探针已取消",
          rawText: stdout,
          parsed: failedParsed("命令探针已取消"),
          session: null,
          started,
          error: "Cancelled by abort signal",
          exitCode: code,
        });
        return;
      }

      if (timedOut) {
        const msg = `命令探针执行超时 (${effectiveTimeoutMs}ms)`;
        finish({
          outcome: "failed",
          summary: msg,
          rawText: stdout,
          parsed: failedParsed(msg),
          session: null,
          started,
          error: msg,
          exitCode: code,
        });
        return;
      }

      if (code === 0) {
        if (stdout.trim().length === 0) {
          finish({
            outcome: "nothing",
            summary: "",
            rawText: stdout,
            parsed: {
              outcome: "nothing",
              summary: "",
              receipt: null,
              problem: null,
            },
            session: null,
            started: true,
            exitCode: 0,
          });
          return;
        }

        const parsed = readMessage(stdout);
        if (parsed.problem !== null) {
          finish({
            outcome: "failed",
            summary: parsed.summary || parsed.problem,
            rawText: stdout,
            parsed,
            session: null,
            started: true,
            error: parsed.problem,
            exitCode: 0,
          });
          return;
        }

        finish({
          outcome: parsed.outcome,
          summary: parsed.summary,
          rawText: stdout,
          parsed,
          session: null,
          started: true,
          ...(parsed.outcome === "failed"
            ? { error: parsed.summary || "命令探针返回失败结论" }
            : {}),
          exitCode: 0,
        });
        return;
      }

      const errDetail =
        stderr.trim() ||
        stdout.trim() ||
        `命令探针以非零退出码退出 (${String(code)})`;
      const summary = firstLineOf(errDetail) || `退出码 ${String(code)}`;
      finish({
        outcome: "failed",
        summary,
        rawText: stdout,
        parsed: failedParsed(summary),
        session: null,
        started,
        error: errDetail,
        exitCode: code,
      });
    });
  });
}
