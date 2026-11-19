/**
 * Interactive Antigravity UI session runner (`runner === "agentapi-ui"`).
 * Spawns `agentapi new-conversation` / `send-message` without a shell, isolates
 * privileged env tokens, and watches `<appDataDir>/brain/<session>/.system_generated/logs/transcript.jsonl`
 * from a pre-delivery line high-water mark until the turn completes.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { watch as fsWatch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promptFor, readMessage } from "../protocol/receipt.ts";
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

export interface AgentApiUiOptions {
  job: Job;
  contextFile: string;
  guardFile: string;
  promptOverride?: string;
  agentApiBin?: string;
  appDataDir?: string;
  baseEnv?: NodeJS.ProcessEnv;
  pollIntervalMs?: number;
  killGraceMs?: number;
  onStarted?: (info: { session: string | null; pid?: number }) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface CliExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  pid?: number;
  aborted: boolean;
  timedOut: boolean;
  spawnError?: Error;
}

interface TranscriptStep {
  step_index?: number;
  source?: string;
  type?: string;
  status?: string;
  content?: string;
  error?: string;
  tool_calls?: unknown[];
  truncated_fields?: string[];
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_KILL_GRACE_MS = 3_000;
const UUID_RE =
  /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;
const LABELED_ID_RE =
  /(?:conversation[_-]?id|session[_-]?id|conversation|session)\s*(?:[:=]|is)\s*["']?([A-Za-z0-9][A-Za-z0-9._:-]*)["']?/i;
const BARE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/;

function firstNonEmpty(
  ...values: Array<string | undefined>
): string | undefined {
  for (const val of values) {
    if (typeof val === "string" && val.trim().length > 0) {
      return val.trim();
    }
  }
  return undefined;
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

function renderSafeTitle(job: Job): string | undefined {
  if (!job.rule.title) {
    return undefined;
  }
  const primary = job.context.events[0];
  const subject = primary?.subject ?? "";
  const id = primary?.id ?? String(job.run);
  const raw = job.rule.title
    .replaceAll("{subject}", subject)
    .replaceAll("{id}", id);
  // Strip control chars and collapse whitespace so the CLI title remains a safe single-line token.
  // eslint-disable-next-line no-control-regex
  const sanitized = raw
    .replace(/[\x00-\x1f\x7f\s]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (sanitized.length === 0) {
    return undefined;
  }
  return /^[a-zA-Z0-9]/.test(sanitized) ? sanitized : `run-${sanitized}`;
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

function killProcessGroup(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (proc.pid !== undefined) {
    try {
      process.kill(-proc.pid, signal);
      return;
    } catch {
      // Fallback if process group is already gone.
    }
  }
  try {
    proc.kill(signal);
  } catch {
    // Ignore ESRCH.
  }
}

async function execAgentApiCli(
  bin: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    killGraceMs: number;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<CliExecResult> {
  if (options.signal?.aborted) {
    return {
      stdout: "",
      stderr: "",
      exitCode: null,
      aborted: true,
      timedOut: false,
    };
  }

  return new Promise<CliExecResult>((resolve) => {
    let settled = false;
    let aborted = false;
    let timedOut = false;
    let terminating = false;

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const proc = spawn(bin, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

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
      }, options.killGraceMs);
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

    const finish = (result: CliExecResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };

    if (options.signal) {
      options.signal.addEventListener("abort", onAbort, { once: true });
      if (options.signal.aborted) {
        onAbort();
      }
    }

    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        triggerTermination();
      }, options.timeoutMs);
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

    proc.once("error", (err: Error) => {
      finish({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode: null,
        pid: proc.pid,
        aborted,
        timedOut,
        spawnError: err,
      });
    });

    proc.once("close", (code: number | null) => {
      finish({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode: code,
        pid: proc.pid,
        aborted,
        timedOut,
      });
    });
  });
}

function idFromJsonRecord(record: unknown): string | null {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    return null;
  }
  const obj = record as Record<string, unknown>;
  for (const key of [
    "conversationId",
    "conversation_id",
    "sessionId",
    "session_id",
    "id",
  ]) {
    const value = obj[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function extractConversationId(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const fromJson = idFromJsonRecord(parsed);
    if (fromJson) {
      return fromJson;
    }
  } catch {
    // Fallback to line-by-line JSON or text extraction.
  }

  const lines = trimmed.split(/\r?\n/).reverse();
  for (const line of lines) {
    const candidate = line.trim();
    if (!candidate.startsWith("{")) {
      continue;
    }
    try {
      const fromLine = idFromJsonRecord(JSON.parse(candidate) as unknown);
      if (fromLine) {
        return fromLine;
      }
    } catch {
      // Ignore non-JSON lines.
    }
  }

  const labeledMatch = LABELED_ID_RE.exec(trimmed);
  if (labeledMatch?.[1]) {
    return labeledMatch[1];
  }

  const uuidMatch = UUID_RE.exec(trimmed);
  if (uuidMatch?.[1]) {
    return uuidMatch[1];
  }

  if (!/\s/.test(trimmed) && BARE_ID_RE.test(trimmed)) {
    return trimmed;
  }

  return null;
}

function transcriptFilePath(appDataDir: string, session: string): string {
  return path.join(
    appDataDir,
    "brain",
    session,
    ".system_generated",
    "logs",
    "transcript.jsonl",
  );
}

function transcriptFullFilePath(appDataDir: string, session: string): string {
  return path.join(
    appDataDir,
    "brain",
    session,
    ".system_generated",
    "logs",
    "transcript_full.jsonl",
  );
}

async function readNonEmptyLines(filePath: string): Promise<string[] | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    return raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: unknown }).code === "ENOENT"
    ) {
      return null;
    }
    throw err;
  }
}

async function readTranscriptLineCount(filePath: string): Promise<number> {
  const lines = await readNonEmptyLines(filePath);
  return lines ? lines.length : 0;
}

async function resolveFullContentIfTruncated(
  fullPath: string,
  step: TranscriptStep,
  absoluteLineIndex: number,
): Promise<string> {
  const fallback = typeof step.content === "string" ? step.content : "";
  if (
    !Array.isArray(step.truncated_fields) ||
    !step.truncated_fields.includes("content")
  ) {
    return fallback;
  }

  const fullLines = await readNonEmptyLines(fullPath);
  if (!fullLines) {
    return fallback;
  }

  if (step.step_index !== undefined) {
    for (let i = fullLines.length - 1; i >= 0; i--) {
      try {
        const candidate = JSON.parse(fullLines[i]!) as TranscriptStep;
        if (
          candidate.step_index === step.step_index &&
          typeof candidate.content === "string"
        ) {
          return candidate.content;
        }
      } catch {
        // Ignore partial line in full transcript.
      }
    }
  }

  const sameIndexLine = fullLines[absoluteLineIndex];
  if (sameIndexLine) {
    try {
      const candidate = JSON.parse(sameIndexLine) as TranscriptStep;
      if (typeof candidate.content === "string") {
        return candidate.content;
      }
    } catch {
      // Fall back to compact content.
    }
  }

  return fallback;
}

function collectUsage(steps: TranscriptStep[]): RunUsage | undefined {
  let input = 0;
  let output = 0;
  let cached = 0;
  let sawInput = false;
  let sawOutput = false;
  let sawCached = false;

  for (const step of steps) {
    if (step.type !== "PLANNER_RESPONSE") {
      continue;
    }
    if (
      typeof step.input_tokens === "number" &&
      Number.isFinite(step.input_tokens)
    ) {
      input += step.input_tokens;
      sawInput = true;
    }
    if (
      typeof step.output_tokens === "number" &&
      Number.isFinite(step.output_tokens)
    ) {
      output += step.output_tokens;
      sawOutput = true;
    }
    if (
      typeof step.cache_read_tokens === "number" &&
      Number.isFinite(step.cache_read_tokens)
    ) {
      cached += step.cache_read_tokens;
      sawCached = true;
    }
  }

  if (!sawInput && !sawOutput && !sawCached) {
    return undefined;
  }

  const usage: RunUsage = {};
  if (sawInput) usage.input = input;
  if (sawOutput) usage.output = output;
  if (sawCached) usage.cached = cached;
  return usage;
}

async function inspectTranscriptDelta(
  transcriptPath: string,
  fullPath: string,
  highWaterMark: number,
  session: string,
): Promise<RunnerExecution | null> {
  const lines = await readNonEmptyLines(transcriptPath);
  if (!lines || lines.length <= highWaterMark) {
    return null;
  }

  const deltaLines = lines.slice(highWaterMark);
  const parsedSteps: Array<{ step: TranscriptStep; absIndex: number }> = [];

  for (let i = 0; i < deltaLines.length; i++) {
    const rawLine = deltaLines[i]!;
    try {
      const parsed = JSON.parse(rawLine) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        parsedSteps.push({
          step: parsed as TranscriptStep,
          absIndex: highWaterMark + i,
        });
      }
    } catch {
      // If the very last line is still flushing, keep waiting on subsequent polls.
      if (i === deltaLines.length - 1) {
        break;
      }
    }
  }

  if (parsedSteps.length === 0) {
    return null;
  }

  const usage = collectUsage(parsedSteps.map((entry) => entry.step));

  for (let i = parsedSteps.length - 1; i >= 0; i--) {
    const { step, absIndex } = parsedSteps[i]!;
    if (step.type !== "PLANNER_RESPONSE") {
      continue;
    }

    if (step.status === "ERROR") {
      const content = await resolveFullContentIfTruncated(
        fullPath,
        step,
        absIndex,
      );
      const errMsg =
        (typeof step.error === "string" && step.error.trim()) ||
        content.trim() ||
        "PLANNER_RESPONSE step ended with status ERROR";
      const summary = firstLineOf(errMsg) || "会话执行步骤报错";
      return {
        outcome: "failed",
        summary,
        rawText: content,
        parsed: failedParsed(summary),
        session,
        started: true,
        ...(usage ? { usage } : {}),
        error: errMsg,
        exitCode: 0,
      };
    }

    const hasToolCalls =
      Array.isArray(step.tool_calls) && step.tool_calls.length > 0;
    if (
      step.status === "DONE" &&
      !hasToolCalls &&
      typeof step.content === "string"
    ) {
      const content = await resolveFullContentIfTruncated(
        fullPath,
        step,
        absIndex,
      );
      const parsed = readMessage(content);
      return {
        outcome: parsed.outcome,
        summary: parsed.summary,
        rawText: content,
        parsed,
        session,
        started: true,
        ...(usage ? { usage } : {}),
        ...(parsed.outcome === "failed"
          ? { error: parsed.summary || "Agent 会话返回失败结论" }
          : {}),
        exitCode: 0,
      };
    }
  }

  return null;
}

async function waitForTranscriptTurn(options: {
  transcriptPath: string;
  fullPath: string;
  highWaterMark: number;
  session: string;
  pollIntervalMs: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<RunnerExecution> {
  if (options.signal?.aborted) {
    return {
      outcome: "cancelled",
      summary: "等待会话回复已取消",
      rawText: "",
      parsed: failedParsed("等待会话回复已取消"),
      session: options.session,
      started: true,
      error: "Cancelled by abort signal",
      exitCode: null,
    };
  }

  if (options.timeoutMs !== undefined && options.timeoutMs <= 0) {
    const msg = "等待 agentapi 会话回复超时";
    return {
      outcome: "failed",
      summary: msg,
      rawText: "",
      parsed: failedParsed(msg),
      session: options.session,
      started: true,
      error: msg,
      exitCode: null,
    };
  }

  const immediate = await inspectTranscriptDelta(
    options.transcriptPath,
    options.fullPath,
    options.highWaterMark,
    options.session,
  );
  if (immediate) {
    return immediate;
  }

  return new Promise<RunnerExecution>((resolve) => {
    let settled = false;
    let checking = false;
    let dirty = false;
    let watcher: FSWatcher | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (pollTimer !== undefined) {
        clearInterval(pollTimer);
        pollTimer = undefined;
      }
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      }
      if (watcher) {
        try {
          watcher.close();
        } catch {
          // Ignore close errors.
        }
        watcher = undefined;
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

    const ensureWatcher = (): void => {
      if (watcher || settled) {
        return;
      }
      try {
        watcher = fsWatch(options.transcriptPath, () => {
          void runCheck();
        });
        watcher.on("error", () => {
          if (watcher) {
            try {
              watcher.close();
            } catch {
              // Ignore close errors.
            }
            watcher = undefined;
          }
        });
      } catch {
        // File or parent directory may not exist yet; poll timer will retry.
      }
    };

    const runCheck = async (): Promise<void> => {
      if (settled) {
        return;
      }
      if (checking) {
        dirty = true;
        return;
      }
      checking = true;
      try {
        ensureWatcher();
        const result = await inspectTranscriptDelta(
          options.transcriptPath,
          options.fullPath,
          options.highWaterMark,
          options.session,
        );
        if (result) {
          finish(result);
          return;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        finish({
          outcome: "failed",
          summary: firstLineOf(msg) || "读取 transcript.jsonl 失败",
          rawText: "",
          parsed: failedParsed(firstLineOf(msg) || msg),
          session: options.session,
          started: true,
          error: msg,
          exitCode: null,
        });
        return;
      } finally {
        checking = false;
      }

      if (dirty && !settled) {
        dirty = false;
        void runCheck();
      }
    };

    const onAbort = (): void => {
      finish({
        outcome: "cancelled",
        summary: "等待会话回复已取消",
        rawText: "",
        parsed: failedParsed("等待会话回复已取消"),
        session: options.session,
        started: true,
        error: "Cancelled by abort signal",
        exitCode: null,
      });
    };

    if (options.signal) {
      options.signal.addEventListener("abort", onAbort, { once: true });
      if (options.signal.aborted) {
        onAbort();
        return;
      }
    }

    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        const msg = `等待 agentapi 会话回复超时 (${options.timeoutMs}ms)`;
        finish({
          outcome: "failed",
          summary: msg,
          rawText: "",
          parsed: failedParsed(msg),
          session: options.session,
          started: true,
          error: msg,
          exitCode: null,
        });
      }, options.timeoutMs);
    }

    ensureWatcher();
    pollTimer = setInterval(() => {
      void runCheck();
    }, options.pollIntervalMs);
  });
}

/**
 * Wake or start an interactive Antigravity conversation via `agentapi` and wait
 * for the turn to complete in `transcript.jsonl`.
 */
export async function runAgentApiUi(
  options: AgentApiUiOptions,
): Promise<RunnerExecution> {
  const baseEnv = options.baseEnv ?? process.env;
  const homeDir = baseEnv.HOME || os.homedir();
  const bin =
    firstNonEmpty(
      options.agentApiBin,
      options.baseEnv?.ANTIGRAVITY_AGENTAPI_EXE,
      process.env.ANTIGRAVITY_AGENTAPI_EXE,
    ) ?? "agentapi";
  const subcommandPrefix = /^language_server(?:\.exe)?$/i.test(
    path.basename(bin),
  )
    ? ["agentapi"]
    : [];
  const appDataDir =
    options.appDataDir ?? path.join(homeDir, ".gemini", "antigravity");
  const expandedCwd = expandHomePath(options.job.rule.cwd, homeDir);
  const sanitizedEnv = buildSanitizedEnv(
    baseEnv,
    options.job,
    options.contextFile,
    options.guardFile,
  );
  const prompt =
    options.promptOverride ?? promptFor(options.job, options.contextFile);
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const effectiveTimeoutMs =
    options.timeoutMs ??
    (options.job.agent.timeoutMinutes !== undefined
      ? options.job.agent.timeoutMinutes * 60_000
      : undefined);
  const deadlineMs =
    effectiveTimeoutMs !== undefined && effectiveTimeoutMs > 0
      ? Date.now() + effectiveTimeoutMs
      : undefined;

  if (options.signal?.aborted) {
    return {
      outcome: "cancelled",
      summary: "agentapi 会话在启动前已取消",
      rawText: "",
      parsed: failedParsed("agentapi 会话在启动前已取消"),
      session: options.job.session ?? null,
      started: false,
      error: "Cancelled by abort signal before start",
      exitCode: null,
    };
  }

  let session: string | null = options.job.session ?? null;
  let highWaterMark = 0;

  if (!session) {
    const args: string[] = [...subcommandPrefix, "new-conversation"];
    if (options.job.agent.model) {
      args.push(`--model=${options.job.agent.model}`);
    }
    const safeTitle = renderSafeTitle(options.job);
    if (safeTitle) {
      args.push(`--title=${safeTitle}`);
    }
    args.push(prompt);

    const cliResult = await execAgentApiCli(bin, args, {
      cwd: expandedCwd,
      env: sanitizedEnv,
      killGraceMs,
      signal: options.signal,
      timeoutMs: effectiveTimeoutMs,
    });

    if (cliResult.aborted || options.signal?.aborted) {
      return {
        outcome: "cancelled",
        summary: "agentapi new-conversation 已取消",
        rawText: cliResult.stdout,
        parsed: failedParsed("agentapi new-conversation 已取消"),
        session: null,
        started: false,
        error: "Cancelled by abort signal",
        exitCode: cliResult.exitCode,
      };
    }

    if (cliResult.timedOut) {
      const msg = `agentapi new-conversation 执行超时 (${effectiveTimeoutMs}ms)`;
      return {
        outcome: "failed",
        summary: msg,
        rawText: cliResult.stdout,
        parsed: failedParsed(msg),
        session: null,
        started: false,
        error: msg,
        exitCode: cliResult.exitCode,
      };
    }

    if (cliResult.spawnError || cliResult.exitCode !== 0) {
      const errDetail =
        cliResult.spawnError?.message ||
        cliResult.stderr.trim() ||
        cliResult.stdout.trim() ||
        `agentapi new-conversation 退出码 ${String(cliResult.exitCode)}`;
      const summary =
        firstLineOf(errDetail) || "agentapi new-conversation 失败";
      return {
        outcome: "failed",
        summary,
        rawText: cliResult.stdout,
        parsed: failedParsed(summary),
        session: null,
        started: false,
        error: errDetail,
        exitCode: cliResult.exitCode,
      };
    }

    const extracted = extractConversationId(cliResult.stdout);
    if (!extracted) {
      const msg = "agentapi new-conversation 未返回有效的 conversationId";
      return {
        outcome: "failed",
        summary: msg,
        rawText: cliResult.stdout,
        parsed: failedParsed(msg),
        session: null,
        started: false,
        error: msg,
        exitCode: 0,
      };
    }

    session = extracted;
    highWaterMark = 0;
    options.onStarted?.({ session, pid: cliResult.pid });
  } else {
    const tPath = transcriptFilePath(appDataDir, session);
    highWaterMark = await readTranscriptLineCount(tPath);

    const args = [...subcommandPrefix, "send-message", session, prompt];
    const cliResult = await execAgentApiCli(bin, args, {
      cwd: expandedCwd,
      env: sanitizedEnv,
      killGraceMs,
      signal: options.signal,
      timeoutMs: effectiveTimeoutMs,
    });

    if (cliResult.aborted || options.signal?.aborted) {
      return {
        outcome: "cancelled",
        summary: "agentapi send-message 已取消",
        rawText: cliResult.stdout,
        parsed: failedParsed("agentapi send-message 已取消"),
        session,
        started: false,
        error: "Cancelled by abort signal",
        exitCode: cliResult.exitCode,
      };
    }

    if (cliResult.timedOut) {
      const msg = `agentapi send-message 执行超时 (${effectiveTimeoutMs}ms)`;
      return {
        outcome: "failed",
        summary: msg,
        rawText: cliResult.stdout,
        parsed: failedParsed(msg),
        session,
        started: false,
        error: msg,
        exitCode: cliResult.exitCode,
      };
    }

    if (cliResult.spawnError || cliResult.exitCode !== 0) {
      const errDetail =
        cliResult.spawnError?.message ||
        cliResult.stderr.trim() ||
        cliResult.stdout.trim() ||
        `agentapi send-message 退出码 ${String(cliResult.exitCode)}`;
      const summary = firstLineOf(errDetail) || "agentapi send-message 失败";
      return {
        outcome: "failed",
        summary,
        rawText: cliResult.stdout,
        parsed: failedParsed(summary),
        session,
        started: false,
        error: errDetail,
        exitCode: cliResult.exitCode,
      };
    }

    options.onStarted?.({ session, pid: cliResult.pid });
  }

  const remainingMs =
    deadlineMs !== undefined ? Math.max(0, deadlineMs - Date.now()) : undefined;

  return waitForTranscriptTurn({
    transcriptPath: transcriptFilePath(appDataDir, session),
    fullPath: transcriptFullFilePath(appDataDir, session),
    highWaterMark,
    session,
    pollIntervalMs,
    signal: options.signal,
    timeoutMs: remainingMs,
  });
}
