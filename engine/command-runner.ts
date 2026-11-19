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
import type { Job, ParsedMessage } from "../protocol/types.ts";
import { sanitizeRunnerEnv, type RunnerExecution } from "./agy-runner.ts";

export type { RunnerExecution };

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
const STDOUT_HEAD_LIMIT_BYTES = 64 * 1024;
const STDOUT_TAIL_LIMIT_BYTES = 512 * 1024;
const STDERR_HEAD_LIMIT_BYTES = 64 * 1024;
const STDERR_TAIL_LIMIT_BYTES = 256 * 1024;

interface BoundedStreamCollector {
  push(chunk: Buffer | string): void;
  toString(): string;
}

function createBoundedStreamCollector(
  headLimitBytes: number,
  tailLimitBytes: number,
): BoundedStreamCollector {
  let totalBytes = 0;
  let headBytes = 0;
  let tailBytes = 0;
  const headChunks: Buffer[] = [];
  const tailChunks: Buffer[] = [];

  function pushTail(part: Buffer): void {
    if (part.length === 0) {
      return;
    }
    if (part.length >= tailLimitBytes) {
      tailChunks.length = 0;
      tailChunks.push(part.subarray(part.length - tailLimitBytes));
      tailBytes = tailLimitBytes;
      return;
    }
    tailChunks.push(part);
    tailBytes += part.length;
    while (
      tailChunks.length > 0 &&
      tailBytes - tailChunks[0]!.length >= tailLimitBytes
    ) {
      const evicted = tailChunks.shift()!;
      tailBytes -= evicted.length;
    }
    if (tailBytes > tailLimitBytes && tailChunks.length > 0) {
      const excess = tailBytes - tailLimitBytes;
      tailChunks[0] = tailChunks[0]!.subarray(excess);
      tailBytes -= excess;
    }
  }

  return {
    push(chunk: Buffer | string): void {
      const buf =
        typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      if (buf.length === 0) {
        return;
      }
      totalBytes += buf.length;
      if (headBytes < headLimitBytes) {
        const takeHead = Math.min(buf.length, headLimitBytes - headBytes);
        headChunks.push(
          takeHead === buf.length ? buf : buf.subarray(0, takeHead),
        );
        headBytes += takeHead;
        if (takeHead < buf.length) {
          pushTail(buf.subarray(takeHead));
        }
        return;
      }
      pushTail(buf);
    },
    toString(): string {
      if (totalBytes === 0) {
        return "";
      }
      if (totalBytes <= headLimitBytes + tailLimitBytes) {
        return Buffer.concat([...headChunks, ...tailChunks]).toString("utf8");
      }
      const headStr = Buffer.concat(headChunks)
        .toString("utf8")
        .replace(/\uFFFD+$/g, "");
      const tailStr = Buffer.concat(tailChunks)
        .toString("utf8")
        .replace(/^\uFFFD+/g, "");
      const dropped = totalBytes - headBytes - tailBytes;
      return `${headStr}\n...[autoloop truncated ${dropped} bytes]...\n${tailStr}`;
    },
  };
}

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
  return sanitizeRunnerEnv(baseEnv, job, contextFile, guardFile);
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
      timedOut: false,
      cancelled: true,
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

    const stdoutCollector = createBoundedStreamCollector(
      STDOUT_HEAD_LIMIT_BYTES,
      STDOUT_TAIL_LIMIT_BYTES,
    );
    const stderrCollector = createBoundedStreamCollector(
      STDERR_HEAD_LIMIT_BYTES,
      STDERR_TAIL_LIMIT_BYTES,
    );

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
      stdoutCollector.push(chunk);
    });

    proc.stderr?.on("data", (chunk: Buffer | string) => {
      stderrCollector.push(chunk);
    });

    proc.once("spawn", () => {
      started = true;
    });

    proc.once("error", (err: Error) => {
      const stdout = stdoutCollector.toString();
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
          timedOut: false,
          cancelled: true,
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
        timedOut: false,
        cancelled: false,
      });
    });

    proc.once("close", (code: number | null) => {
      const stdout = stdoutCollector.toString();
      const stderr = stderrCollector.toString();

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
          timedOut: false,
          cancelled: true,
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
          timedOut: true,
          cancelled: false,
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
            timedOut: false,
            cancelled: false,
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
            timedOut: false,
            cancelled: false,
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
          timedOut: false,
          cancelled: false,
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
        timedOut: false,
        cancelled: false,
      });
    });
  });
}
