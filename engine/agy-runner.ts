import { type ChildProcess, spawn } from "node:child_process";
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
  timedOut?: boolean;
  cancelled?: boolean;
}

export interface RunAgyPrintOptions {
  job: Job;
  contextFile: string;
  guardFile: string;
  promptOverride?: string;
  agyBin?: string;
  baseEnv?: NodeJS.ProcessEnv;
  killGraceMs?: number;
  postResultGraceMs?: number;
  onStarted?: (info: { session: string | null; pid: number }) => void;
  onProcess?: (proc: ChildProcess) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type RunAgyOptions = RunAgyPrintOptions;

const DEFAULT_TIMEOUT_MINUTES = 60;
const DEFAULT_KILL_GRACE_MS = 500;
const DEFAULT_POST_RESULT_GRACE_MS = 30_000;
const MAX_STDERR_CHARS = 8_000;

const SENSITIVE_EXACT_KEYS = new Set([
  "AUTOLOOP_OWNER_TOKEN",
  "AUTOLOOP_INGEST_TOKEN",
  "ANTIGRAVITY_SIDECAR_UI_TOKEN",
  "ANTIGRAVITY_SIDECAR_TOKEN",
  "ANTIGRAVITY_CSRF_TOKEN",
  "ANTIGRAVITY_OWNER_TOKEN",
  "AUTOLOOP_ADMIN_TOKEN",
  "AUTOLOOP_IPC_TOKEN",
  "AUTOLOOP_UI_TOKEN",
  "AUTOLOOP_MASTER_KEY",
  "SIDECAR_UI_TOKEN",
]);

const START_CONFIRM_TYPES = new Set([
  "init",
  "system",
  "session",
  "started",
  "ack",
  "assistant",
  "message",
  "message_start",
  "content_block_start",
  "content_block_delta",
  "text_delta",
  "result",
]);

export function isSensitiveEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (SENSITIVE_EXACT_KEYS.has(upper)) {
    return true;
  }
  if (upper.startsWith("ANTIGRAVITY_SIDECAR")) {
    return true;
  }
  if (
    upper.startsWith("AUTOLOOP_") &&
    (upper.endsWith("_TOKEN") ||
      upper.endsWith("_SECRET") ||
      upper.endsWith("_KEY") ||
      upper.endsWith("_PASSWORD"))
  ) {
    return true;
  }
  return false;
}

function expandCwd(cwd: string): string {
  if (cwd === "~") {
    return os.homedir();
  }
  if (cwd.startsWith("~/")) {
    return path.join(os.homedir(), cwd.slice(2));
  }
  return cwd;
}

/**
 * Build CLI arguments for `agy --print --output-format stream-json` without shell interpolation.
 */
export function buildAgyArgs(job: Job, prompt: string): string[] {
  const args: string[] = ["--output-format", "stream-json"];

  if (typeof job.agent.model === "string" && job.agent.model.length > 0) {
    args.push("--model", job.agent.model);
  }

  if (typeof job.agent.effort === "string" && job.agent.effort.length > 0) {
    args.push("--effort", job.agent.effort);
  }

  if (typeof job.session === "string" && job.session.length > 0) {
    args.push("--conversation", job.session);
  }

  const access = job.agent.access ?? "edit";
  if (access === "read") {
    args.push("--mode", "plan", "--sandbox");
  } else if (access === "full") {
    args.push("--mode", "auto");
  } else {
    args.push("--mode", "accept-edits", "--sandbox");
  }

  args.push("--print", prompt);
  return args;
}

/**
 * Strip privileged control-plane credentials and inject per-run Autoloop guard variables.
 */
export function sanitizeRunnerEnv(
  baseEnv: NodeJS.ProcessEnv,
  job: Job,
  contextFile: string,
  guardFile: string,
): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) {
      continue;
    }
    if (isSensitiveEnvKey(key)) {
      continue;
    }
    clean[key] = value;
  }

  clean.AUTOLOOP_RUN_ID = String(job.run);
  clean.AUTOLOOP_CONTEXT = contextFile;
  clean.AUTOLOOP_GUARD_FILE = guardFile;

  return clean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function extractSessionIdFromRecord(
  record: Record<string, unknown>,
): string | null {
  return (
    nonEmptyString(record.conversationId) ??
    nonEmptyString(record.conversation_id) ??
    nonEmptyString(record.sessionId) ??
    nonEmptyString(record.session_id)
  );
}

function extractSessionId(event: Record<string, unknown>): string | null {
  const direct = extractSessionIdFromRecord(event);
  if (direct) {
    return direct;
  }

  for (const nestedKey of [
    "data",
    "session",
    "conversation",
    "result",
    "message",
    "metadata",
  ]) {
    const nested = asRecord(event[nestedKey]);
    if (!nested) {
      continue;
    }
    const found =
      extractSessionIdFromRecord(nested) ??
      (nestedKey === "session" || nestedKey === "conversation"
        ? nonEmptyString(nested.id)
        : null);
    if (found) {
      return found;
    }
  }

  return null;
}

function extractTextFromValue(value: unknown, depth = 0): string {
  if (depth > 4 || value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    let out = "";
    for (const item of value) {
      if (typeof item === "string") {
        out += item;
        continue;
      }
      const block = asRecord(item);
      if (!block) {
        continue;
      }
      const blockType =
        typeof block.type === "string" ? block.type.toLowerCase() : "";
      if (blockType === "thinking" || blockType === "tool_use") {
        continue;
      }
      if (
        blockType === "text" ||
        blockType === "output_text" ||
        blockType === ""
      ) {
        if (typeof block.text === "string") {
          out += block.text;
        } else if (typeof block.content === "string") {
          out += block.content;
        }
      }
    }
    return out;
  }

  const record = asRecord(value);
  if (!record) {
    return "";
  }

  for (const key of ["text", "content", "response", "message", "result"]) {
    if (record[key] !== undefined) {
      const extracted = extractTextFromValue(record[key], depth + 1);
      if (extracted.length > 0) {
        return extracted;
      }
    }
  }

  return "";
}

function extractDeltaText(event: Record<string, unknown>): string {
  const deltaObj = asRecord(event.delta);
  if (deltaObj) {
    if (typeof deltaObj.text === "string") {
      return deltaObj.text;
    }
    if (typeof deltaObj.content === "string") {
      return deltaObj.content;
    }
  }
  if (typeof event.delta === "string") {
    return event.delta;
  }
  if (typeof event.text === "string") {
    return event.text;
  }
  if (typeof event.content === "string") {
    return event.content;
  }
  return "";
}

function readUsageFields(source: Record<string, unknown>): RunUsage {
  const input =
    finiteNumber(source.input) ??
    finiteNumber(source.input_tokens) ??
    finiteNumber(source.inputTokens);
  const output =
    finiteNumber(source.output) ??
    finiteNumber(source.output_tokens) ??
    finiteNumber(source.outputTokens);
  const cached =
    finiteNumber(source.cached) ??
    finiteNumber(source.cache_read_input_tokens) ??
    finiteNumber(source.cache_read_tokens) ??
    finiteNumber(source.cached_tokens) ??
    finiteNumber(source.cachedInputTokens);
  const cost =
    finiteNumber(source.cost) ??
    finiteNumber(source.cost_usd) ??
    finiteNumber(source.total_cost_usd) ??
    finiteNumber(source.costUsd);

  const usage: RunUsage = {};
  if (input !== undefined) usage.input = input;
  if (output !== undefined) usage.output = output;
  if (cached !== undefined) usage.cached = cached;
  if (cost !== undefined) usage.cost = cost;
  return usage;
}

function mergeUsageObjects(a: RunUsage, b: RunUsage): RunUsage {
  const merged: RunUsage = { ...a };
  if (b.input !== undefined) merged.input = b.input;
  if (b.output !== undefined) merged.output = b.output;
  if (b.cached !== undefined) merged.cached = b.cached;
  if (b.cost !== undefined) merged.cost = b.cost;
  return merged;
}

function extractUsageFromEvent(
  event: Record<string, unknown>,
): RunUsage | null {
  const type = typeof event.type === "string" ? event.type.toLowerCase() : "";
  const messageObj = asRecord(event.message);
  const usageObj = asRecord(event.usage) ?? asRecord(messageObj?.usage);

  let found: RunUsage = {};
  if (usageObj) {
    found = mergeUsageObjects(found, readUsageFields(usageObj));
  }

  if (type === "usage" || type === "result") {
    found = mergeUsageObjects(found, readUsageFields(event));
  } else {
    const topCost =
      finiteNumber(event.cost_usd) ??
      finiteNumber(event.total_cost_usd) ??
      finiteNumber(event.costUsd);
    if (topCost !== undefined) {
      found.cost = topCost;
    }
  }

  if (
    found.input === undefined &&
    found.output === undefined &&
    found.cached === undefined &&
    found.cost === undefined
  ) {
    return null;
  }
  return found;
}

function extractErrorText(event: Record<string, unknown>): string | null {
  const errObj = asRecord(event.error);
  if (errObj) {
    const msg = nonEmptyString(errObj.message) ?? nonEmptyString(errObj.code);
    if (msg) {
      return msg;
    }
  }
  return (
    nonEmptyString(event.error) ??
    nonEmptyString(event.message) ??
    nonEmptyString(event.result)
  );
}

interface StreamState {
  started: boolean;
  sawFinalResult: boolean;
  session: string | null;
  resultText: string | null;
  lastAssistantText: string | null;
  currentTurnDelta: string;
  allDeltas: string;
  lastStreamError: string | null;
  incrementalUsage: {
    input: number;
    output: number;
    cached: number;
    cost: number;
    hasInput: boolean;
    hasOutput: boolean;
    hasCached: boolean;
    hasCost: boolean;
  };
  resultUsage: RunUsage | null;
}

function createStreamState(): StreamState {
  return {
    started: false,
    sawFinalResult: false,
    session: null,
    resultText: null,
    lastAssistantText: null,
    currentTurnDelta: "",
    allDeltas: "",
    lastStreamError: null,
    incrementalUsage: {
      input: 0,
      output: 0,
      cached: 0,
      cost: 0,
      hasInput: false,
      hasOutput: false,
      hasCached: false,
      hasCost: false,
    },
    resultUsage: null,
  };
}

function processNdjsonLine(
  line: string,
  state: StreamState,
  onFirstStarted: (session: string | null) => void,
): void {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Ignore non-JSON diagnostic/noise lines without crashing the stream parser.
    return;
  }

  const event = asRecord(parsed);
  if (!event) {
    return;
  }

  const eventType =
    typeof event.type === "string" ? event.type.toLowerCase() : "";
  const subtype =
    typeof event.subtype === "string" ? event.subtype.toLowerCase() : "";
  const isErrorEvent =
    eventType === "error" ||
    event.is_error === true ||
    (eventType === "result" && subtype === "error");

  if (isErrorEvent) {
    const errText = extractErrorText(event);
    if (errText) {
      state.lastStreamError = errText;
    }
  } else {
    const foundSession = extractSessionId(event);
    if (foundSession && state.session === null) {
      state.session = foundSession;
    }

    const confirmsStart =
      foundSession !== null ||
      START_CONFIRM_TYPES.has(eventType) ||
      subtype === "init" ||
      event.started === true ||
      event.accepted === true;

    if (confirmsStart && !state.started) {
      state.started = true;
      onFirstStarted(state.session);
    }
  }

  if (eventType === "message_start") {
    state.currentTurnDelta = "";
  } else if (
    eventType === "text_delta" ||
    eventType === "content_block_delta"
  ) {
    const delta = extractDeltaText(event);
    if (delta.length > 0) {
      state.currentTurnDelta += delta;
      state.allDeltas += delta;
    }
  } else if (eventType === "assistant" || eventType === "message") {
    const messageObj = asRecord(event.message);
    const role =
      typeof event.role === "string"
        ? event.role.toLowerCase()
        : typeof messageObj?.role === "string"
          ? messageObj.role.toLowerCase()
          : "";
    if (role !== "user" && role !== "system") {
      const text =
        extractTextFromValue(event.message) ||
        extractTextFromValue(event.content) ||
        extractTextFromValue(event.text) ||
        extractTextFromValue(event.response);
      if (text.length > 0) {
        state.lastAssistantText = text;
        state.currentTurnDelta = "";
      }
    }
  } else if (eventType === "result" && !isErrorEvent) {
    state.sawFinalResult = true;
    const text =
      extractTextFromValue(event.result) ||
      extractTextFromValue(event.response) ||
      extractTextFromValue(event.text) ||
      extractTextFromValue(event.content) ||
      extractTextFromValue(event.message);
    if (text.length > 0) {
      state.resultText = text;
    }
  }

  const usage = extractUsageFromEvent(event);
  if (usage) {
    if (eventType === "result") {
      state.resultUsage = state.resultUsage
        ? mergeUsageObjects(state.resultUsage, usage)
        : usage;
    } else {
      if (usage.input !== undefined) {
        state.incrementalUsage.input += usage.input;
        state.incrementalUsage.hasInput = true;
      }
      if (usage.output !== undefined) {
        state.incrementalUsage.output += usage.output;
        state.incrementalUsage.hasOutput = true;
      }
      if (usage.cached !== undefined) {
        state.incrementalUsage.cached += usage.cached;
        state.incrementalUsage.hasCached = true;
      }
      if (usage.cost !== undefined) {
        state.incrementalUsage.cost += usage.cost;
        state.incrementalUsage.hasCost = true;
      }
    }
  }
}

function finalizeRawText(state: StreamState): string {
  if (state.resultText !== null && state.resultText.length > 0) {
    return state.resultText;
  }
  if (state.lastAssistantText !== null) {
    return state.currentTurnDelta.length > 0
      ? state.lastAssistantText + state.currentTurnDelta
      : state.lastAssistantText;
  }
  return state.currentTurnDelta.length > 0
    ? state.currentTurnDelta
    : state.allDeltas;
}

function finalizeUsage(state: StreamState): RunUsage | undefined {
  const inc = state.incrementalUsage;
  const incUsage: RunUsage = {};
  if (inc.hasInput) incUsage.input = inc.input;
  if (inc.hasOutput) incUsage.output = inc.output;
  if (inc.hasCached) incUsage.cached = inc.cached;
  if (inc.hasCost) incUsage.cost = inc.cost;
  const hasAnyInc =
    inc.hasInput || inc.hasOutput || inc.hasCached || inc.hasCost;

  const res = state.resultUsage;
  if (res) {
    const hasResTokens =
      res.input !== undefined ||
      res.output !== undefined ||
      res.cached !== undefined;
    if (hasResTokens) {
      const finalUsage: RunUsage = { ...res };
      if (finalUsage.cost === undefined && incUsage.cost !== undefined) {
        finalUsage.cost = incUsage.cost;
      }
      return finalUsage;
    }
    if (hasAnyInc) {
      return mergeUsageObjects(incUsage, res);
    }
    return { ...res };
  }

  return hasAnyInc ? incUsage : undefined;
}

function signalProcessGroup(proc: ChildProcess, sig: NodeJS.Signals): void {
  const pid = proc.pid;
  if (pid === undefined || pid <= 0) {
    return;
  }
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      proc.kill(sig);
    } catch {
      // Process already terminated.
    }
  }
}

/**
 * Execute a single headless `agy --print --output-format stream-json` attempt in an
 * isolated process group and sanitized environment.
 */
export function runAgyPrint(
  options: RunAgyPrintOptions,
): Promise<RunnerExecution> {
  const {
    job,
    contextFile,
    guardFile,
    promptOverride,
    agyBin,
    baseEnv = process.env,
    killGraceMs = DEFAULT_KILL_GRACE_MS,
    postResultGraceMs = DEFAULT_POST_RESULT_GRACE_MS,
    onStarted,
    onProcess,
    signal,
    timeoutMs = (job.agent.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES) * 60_000,
  } = options;

  if (signal?.aborted) {
    return Promise.resolve({
      outcome: "cancelled",
      summary: "",
      rawText: "",
      parsed: readMessage(""),
      session: null,
      started: false,
      error: "Aborted before process start",
      exitCode: null,
      timedOut: false,
      cancelled: true,
    });
  }

  const exe = agyBin ?? baseEnv.ANTIGRAVITY_AGY_EXE ?? "agy";
  const prompt = promptOverride ?? promptFor(job, contextFile);
  const args = buildAgyArgs(job, prompt);
  const cleanEnv = sanitizeRunnerEnv(baseEnv, job, contextFile, guardFile);
  const cwd = expandCwd(job.rule.cwd);

  return new Promise<RunnerExecution>((resolve) => {
    const proc = spawn(exe, args, {
      cwd,
      env: cleanEnv,
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    onProcess?.(proc);

    const state = createStreamState();
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let timedOut = false;
    let cancelled = false;
    let graceTerminated = false;
    let settled = false;
    let killEscalationStarted = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    let postResultTimer: ReturnType<typeof setTimeout> | null = null;
    let forceCloseTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanupTimers = () => {
      if (timeoutTimer !== null) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      if (graceTimer !== null) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
      if (postResultTimer !== null) {
        clearTimeout(postResultTimer);
        postResultTimer = null;
      }
      if (forceCloseTimer !== null) {
        clearTimeout(forceCloseTimer);
        forceCloseTimer = null;
      }
      if (signal) {
        signal.removeEventListener("abort", handleAbort);
      }
    };

    const terminateGroup = () => {
      if (killEscalationStarted || settled) {
        return;
      }
      killEscalationStarted = true;
      signalProcessGroup(proc, "SIGTERM");
      const grace = Math.max(0, killGraceMs);
      graceTimer = setTimeout(() => {
        graceTimer = null;
        if (!settled) {
          signalProcessGroup(proc, "SIGKILL");
          forceCloseTimer = setTimeout(() => {
            forceCloseTimer = null;
            if (!settled) {
              proc.stdout?.destroy();
              proc.stderr?.destroy();
              finalize(null, "SIGKILL");
            }
          }, 100);
        }
      }, grace);
    };

    const startPostResultGrace = () => {
      if (
        postResultTimer !== null ||
        settled ||
        cancelled ||
        timedOut ||
        !Number.isFinite(postResultGraceMs) ||
        postResultGraceMs < 0
      ) {
        return;
      }
      if (timeoutTimer !== null) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      postResultTimer = setTimeout(
        () => {
          postResultTimer = null;
          if (settled || cancelled) {
            return;
          }
          graceTerminated = true;
          timedOut = false;
          terminateGroup();
        },
        Math.max(0, postResultGraceMs),
      );
    };

    const handleAbort = () => {
      cancelled = true;
      graceTerminated = false;
      terminateGroup();
    };

    if (signal) {
      signal.addEventListener("abort", handleAbort, { once: true });
      if (signal.aborted) {
        handleAbort();
      }
    }

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timeoutTimer = null;
        if (state.sawFinalResult && !cancelled) {
          graceTerminated = true;
          timedOut = false;
        } else {
          timedOut = true;
        }
        terminateGroup();
      }, timeoutMs);
    }

    const notifyStarted = (session: string | null) => {
      onStarted?.({
        session: session ?? job.session ?? null,
        pid: proc.pid ?? 0,
      });
    };

    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      let newlineIdx = stdoutBuffer.indexOf("\n");
      while (newlineIdx !== -1) {
        const line = stdoutBuffer.slice(0, newlineIdx);
        stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
        processNdjsonLine(line, state, notifyStarted);
        if (state.sawFinalResult) {
          startPostResultGrace();
        }
        newlineIdx = stdoutBuffer.indexOf("\n");
      }
    });

    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => {
      if (stderrBuffer.length < MAX_STDERR_CHARS) {
        stderrBuffer += chunk.slice(0, MAX_STDERR_CHARS - stderrBuffer.length);
      }
    });

    const finalize = (
      exitCode: number | null,
      exitSignal: NodeJS.Signals | null,
      spawnError?: Error,
    ) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanupTimers();

      if (stdoutBuffer.length > 0) {
        processNdjsonLine(stdoutBuffer, state, notifyStarted);
        stdoutBuffer = "";
      }

      const rawText = finalizeRawText(state);
      const parsed = readMessage(rawText);
      const usage = finalizeUsage(state);
      const session = state.started
        ? (state.session ?? job.session ?? null)
        : null;

      if (cancelled) {
        resolve({
          outcome: "cancelled",
          summary: parsed.summary,
          rawText,
          parsed,
          session,
          started: state.started,
          usage,
          error: "Run cancelled by AbortSignal",
          exitCode,
          timedOut: false,
          cancelled: true,
        });
        return;
      }

      const effectiveTimedOut = graceTerminated ? false : timedOut;
      const effectiveExitCode = graceTerminated ? 0 : exitCode;

      if (effectiveTimedOut) {
        resolve({
          outcome: "failed",
          summary: "",
          rawText,
          parsed,
          session,
          started: state.started,
          usage,
          error: `Run timed out after ${timeoutMs}ms`,
          exitCode: effectiveExitCode,
          timedOut: true,
          cancelled: false,
        });
        return;
      }

      if (spawnError) {
        resolve({
          outcome: "failed",
          summary: "",
          rawText,
          parsed,
          session,
          started: state.started,
          usage,
          error: spawnError.message,
          exitCode: null,
          timedOut: false,
          cancelled: false,
        });
        return;
      }

      if (effectiveExitCode !== 0) {
        const detail =
          state.lastStreamError ??
          (stderrBuffer.trim() ||
            (exitSignal
              ? `Process killed by signal ${exitSignal}`
              : `Process exited with code ${effectiveExitCode}`));
        resolve({
          outcome: "failed",
          summary: "",
          rawText,
          parsed,
          session,
          started: state.started,
          usage,
          error: detail,
          exitCode: effectiveExitCode,
          timedOut: false,
          cancelled: false,
        });
        return;
      }

      resolve({
        outcome: parsed.outcome,
        summary: parsed.summary,
        rawText,
        parsed,
        session,
        started: state.started,
        usage,
        error:
          parsed.outcome === "failed"
            ? (state.lastStreamError ??
              parsed.problem ??
              (parsed.summary || undefined))
            : undefined,
        exitCode: 0,
        timedOut: false,
        cancelled: false,
      });
    };

    proc.on("error", (err: Error) => {
      finalize(null, null, err);
    });

    proc.on(
      "close",
      (code: number | null, exitSignal: NodeJS.Signals | null) => {
        finalize(code, exitSignal);
      },
    );
  });
}
