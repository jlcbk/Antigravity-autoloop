import { type ChildProcess, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promptFor, readMessage } from "../protocol/receipt.ts";
import type { Job, RunUsage } from "../protocol/types.ts";
import { type RunnerExecution, sanitizeRunnerEnv } from "./agy-runner.ts";
import { augmentRunnerPath } from "./codex-runner.ts";

export type { RunnerExecution } from "./agy-runner.ts";

export interface RunClaudeOptions {
  job: Job;
  contextFile: string;
  guardFile: string;
  promptOverride?: string;
  claudeBin?: string;
  baseEnv?: NodeJS.ProcessEnv;
  killGraceMs?: number;
  postResultGraceMs?: number;
  onStarted?: (info: { session: string | null; pid?: number }) => void;
  onProcess?: (proc: ChildProcess) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MINUTES = 60;
const DEFAULT_KILL_GRACE_MS = 500;
const DEFAULT_POST_RESULT_GRACE_MS = 30_000;
const MAX_STDERR_CHARS = 8_000;

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

function expandCwd(cwd: string, baseEnv: NodeJS.ProcessEnv): string {
  const home = nonEmptyString(baseEnv.HOME) ?? os.homedir();
  if (cwd === "~") {
    return home;
  }
  if (cwd.startsWith("~/")) {
    return path.join(home, cwd.slice(2));
  }
  return cwd;
}

/**
 * Resolve executable and optional prefix arguments for `claude`, `zcode`, or `dsh`.
 */
export function resolveClaudeCommand(
  job: Job,
  claudeBin?: string,
  baseEnv?: NodeJS.ProcessEnv,
): { bin: string; prefixArgs: string[] } {
  const cmd = job.agent.command;
  if (
    Array.isArray(cmd) &&
    cmd.length > 0 &&
    typeof cmd[0] === "string" &&
    cmd[0].trim().length > 0
  ) {
    return {
      bin: cmd[0],
      prefixArgs: cmd.slice(1),
    };
  }

  const bin =
    nonEmptyString(claudeBin) ??
    nonEmptyString(baseEnv?.AUTOLOOP_CLAUDE_BIN) ??
    "claude";
  return { bin, prefixArgs: [] };
}

/**
 * Build CLI arguments for `claude` / `zcode` / `dsh` in `-p --verbose --output-format stream-json` mode.
 * Prompt text is never passed on argv; it is written via stdin to prevent `E2BIG` and shell injection.
 */
export function buildClaudeArgs(
  job: Job,
  prefixArgs: readonly string[],
): string[] {
  const args: string[] = [
    ...prefixArgs,
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
  ];

  if (typeof job.agent.model === "string" && job.agent.model.length > 0) {
    args.push("--model", job.agent.model);
  }

  if (typeof job.agent.effort === "string" && job.agent.effort.length > 0) {
    args.push("--effort", job.agent.effort);
  }

  const access = job.agent.access ?? "edit";
  if (access === "read") {
    args.push("--permission-mode", "plan");
  } else if (access === "full") {
    args.push(
      "--permission-mode",
      "bypassPermissions",
      "--allow-dangerously-skip-permissions",
    );
  } else {
    args.push("--permission-mode", "acceptEdits");
  }

  if (typeof job.session === "string" && job.session.length > 0) {
    args.push("--resume", job.session);
  }

  return args;
}

function extractSessionIdFromRecord(
  record: Record<string, unknown>,
): string | null {
  return (
    nonEmptyString(record.session_id) ??
    nonEmptyString(record.sessionId) ??
    nonEmptyString(record.conversation_id) ??
    nonEmptyString(record.conversationId)
  );
}

function extractClaudeSessionId(event: Record<string, unknown>): string | null {
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
      if (
        blockType === "thinking" ||
        blockType === "tool_use" ||
        blockType === "tool_result"
      ) {
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

function extractErrorText(event: Record<string, unknown>): string | null {
  if (Array.isArray(event.errors)) {
    const parts: string[] = [];
    for (const entry of event.errors) {
      if (typeof entry === "string" && entry.trim().length > 0) {
        parts.push(entry.trim());
      } else {
        const rec = asRecord(entry);
        const msg = nonEmptyString(rec?.message) ?? nonEmptyString(rec?.error);
        if (msg) {
          parts.push(msg);
        }
      }
    }
    if (parts.length > 0) {
      return parts.join("; ");
    }
  }

  const errObj = asRecord(event.error);
  if (errObj) {
    const msg = nonEmptyString(errObj.message) ?? nonEmptyString(errObj.code);
    if (msg) {
      return msg;
    }
  }

  return (
    nonEmptyString(event.error) ??
    nonEmptyString(event.result) ??
    nonEmptyString(event.message)
  );
}

/**
 * Extract usage for Claude / ZCode / DSH stream events aligned with #271:
 * Claude's `usage.input_tokens` excludes prompt cache reads/writes, so total input is:
 * `totalInput = (usage.input_tokens ?? 0) + cacheRead + cacheCreate`,
 * with `RunUsage.input = totalInput` and `RunUsage.cached = cacheRead` (`cached <= input`).
 */
export function extractClaudeUsage(
  event: Record<string, unknown>,
): RunUsage | null {
  const eventType =
    typeof event.type === "string" ? event.type.toLowerCase() : "";
  const messageObj = asRecord(event.message);
  const usageObj = asRecord(event.usage) ?? asRecord(messageObj?.usage);
  const source =
    usageObj ??
    (eventType === "usage" || eventType === "result" ? event : null);

  const topCost =
    finiteNumber(event.total_cost_usd) ??
    finiteNumber(event.cost_usd) ??
    finiteNumber(event.costUsd) ??
    finiteNumber(event.cost);

  if (!source) {
    return topCost !== undefined ? { cost: topCost } : null;
  }

  const hasAnthropicTokens =
    finiteNumber(source.input_tokens) !== undefined ||
    finiteNumber(source.cache_read_input_tokens) !== undefined ||
    finiteNumber(source.cache_creation_input_tokens) !== undefined ||
    finiteNumber(source.cache_read_tokens) !== undefined ||
    finiteNumber(source.cache_creation_tokens) !== undefined ||
    finiteNumber(source.cached_tokens) !== undefined;

  const cacheRead =
    finiteNumber(source.cache_read_input_tokens) ??
    finiteNumber(source.cache_read_tokens) ??
    finiteNumber(source.cached_tokens) ??
    finiteNumber(source.cachedInputTokens) ??
    finiteNumber(source.cached) ??
    0;
  const cacheCreate =
    finiteNumber(source.cache_creation_input_tokens) ??
    finiteNumber(source.cache_creation_tokens) ??
    0;

  const found: RunUsage = {};

  if (hasAnthropicTokens) {
    const totalInput =
      (finiteNumber(source.input_tokens) ?? 0) + cacheRead + cacheCreate;
    found.input = Math.max(totalInput, cacheRead);
    found.cached = cacheRead;
  } else {
    const genericInput =
      finiteNumber(source.input) ?? finiteNumber(source.inputTokens);
    const genericCached =
      finiteNumber(source.cached) ?? finiteNumber(source.cachedInputTokens);
    if (genericInput !== undefined || genericCached !== undefined) {
      found.input = Math.max(genericInput ?? 0, genericCached ?? 0);
    }
    if (genericCached !== undefined) {
      found.cached = genericCached;
    }
  }

  const output =
    finiteNumber(source.output_tokens) ??
    finiteNumber(source.output) ??
    finiteNumber(source.outputTokens);
  if (output !== undefined) {
    found.output = output;
  }

  const cost =
    topCost ??
    finiteNumber(source.total_cost_usd) ??
    finiteNumber(source.cost_usd) ??
    finiteNumber(source.costUsd) ??
    finiteNumber(source.cost);
  if (cost !== undefined) {
    found.cost = cost;
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

function mergeUsageObjects(a: RunUsage, b: RunUsage): RunUsage {
  const merged: RunUsage = { ...a };
  if (b.input !== undefined) merged.input = b.input;
  if (b.output !== undefined) merged.output = b.output;
  if (b.cached !== undefined) merged.cached = b.cached;
  if (b.cost !== undefined) merged.cost = b.cost;
  if (merged.cached !== undefined) {
    merged.input = Math.max(merged.input ?? 0, merged.cached);
  }
  return merged;
}

interface ClaudeStreamState {
  started: boolean;
  reportedNonNullSession: boolean;
  sawFinalResult: boolean;
  sawErrorResult: boolean;
  session: string | null;
  resultText: string | null;
  lastAssistantText: string | null;
  currentTurnDelta: string;
  allDeltas: string;
  lastStreamError: string | null;
  perMessageUsage: Map<string, RunUsage>;
  anonymousIncrementalCount: number;
  resultUsage: RunUsage | null;
}

function createClaudeStreamState(): ClaudeStreamState {
  return {
    started: false,
    reportedNonNullSession: false,
    sawFinalResult: false,
    sawErrorResult: false,
    session: null,
    resultText: null,
    lastAssistantText: null,
    currentTurnDelta: "",
    allDeltas: "",
    lastStreamError: null,
    perMessageUsage: new Map(),
    anonymousIncrementalCount: 0,
    resultUsage: null,
  };
}

function processClaudeNdjsonLine(
  line: string,
  state: ClaudeStreamState,
  onStartedEvent: (session: string | null) => void,
): void {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
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
    (eventType === "result" && subtype.startsWith("error"));

  if (isErrorEvent) {
    const errText = extractErrorText(event);
    if (errText) {
      state.lastStreamError = errText;
    }
    if (eventType === "result") {
      state.sawErrorResult = true;
      state.sawFinalResult = true;
    }
  } else {
    const foundSession = extractClaudeSessionId(event);
    if (foundSession && state.session === null) {
      state.session = foundSession;
    }

    const confirmsStart =
      foundSession !== null ||
      START_CONFIRM_TYPES.has(eventType) ||
      subtype === "init" ||
      event.started === true;

    if (confirmsStart && !state.started) {
      state.started = true;
      if (state.session !== null) {
        state.reportedNonNullSession = true;
      }
      onStartedEvent(state.session);
    } else if (
      state.started &&
      !state.reportedNonNullSession &&
      state.session !== null
    ) {
      state.reportedNonNullSession = true;
      onStartedEvent(state.session);
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

  const usage = extractClaudeUsage(event);
  if (usage) {
    if (eventType === "result") {
      state.resultUsage = state.resultUsage
        ? mergeUsageObjects(state.resultUsage, usage)
        : usage;
    } else {
      const messageObj = asRecord(event.message);
      const msgId =
        nonEmptyString(messageObj?.id) ?? nonEmptyString(event.message_id);
      if (msgId) {
        const existing = state.perMessageUsage.get(msgId);
        state.perMessageUsage.set(
          msgId,
          existing ? mergeUsageObjects(existing, usage) : usage,
        );
      } else {
        state.anonymousIncrementalCount += 1;
        state.perMessageUsage.set(
          `__anon_${state.anonymousIncrementalCount}`,
          usage,
        );
      }
    }
  }
}

function finalizeRawText(state: ClaudeStreamState): string {
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

function finalizeUsage(state: ClaudeStreamState): RunUsage | undefined {
  let hasInput = false;
  let hasOutput = false;
  let hasCached = false;
  let hasCost = false;
  let sumInput = 0;
  let sumOutput = 0;
  let sumCached = 0;
  let sumCost = 0;

  for (const u of state.perMessageUsage.values()) {
    if (u.input !== undefined) {
      sumInput += u.input;
      hasInput = true;
    }
    if (u.output !== undefined) {
      sumOutput += u.output;
      hasOutput = true;
    }
    if (u.cached !== undefined) {
      sumCached += u.cached;
      hasCached = true;
    }
    if (u.cost !== undefined) {
      sumCost += u.cost;
      hasCost = true;
    }
  }

  const incUsage: RunUsage = {};
  if (hasInput || hasCached) {
    incUsage.input = Math.max(sumInput, sumCached);
  }
  if (hasOutput) incUsage.output = sumOutput;
  if (hasCached) incUsage.cached = sumCached;
  if (hasCost) incUsage.cost = sumCost;
  const hasAnyInc = hasInput || hasOutput || hasCached || hasCost;

  const res = state.resultUsage;
  if (res) {
    const hasResTokens =
      res.input !== undefined ||
      res.output !== undefined ||
      res.cached !== undefined;
    if (hasResTokens) {
      const finalUsage: RunUsage = { ...res };
      if (finalUsage.cached !== undefined) {
        finalUsage.input = Math.max(finalUsage.input ?? 0, finalUsage.cached);
      }
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
 * Execute a single headless `claude` / `zcode` / `dsh` `-p --verbose --output-format stream-json`
 * turn with stdin prompt delivery, #271 cache token accounting, and process-group reclamation.
 */
export async function runClaudePrint(
  options: RunClaudeOptions,
): Promise<RunnerExecution> {
  const {
    job,
    contextFile,
    guardFile,
    promptOverride,
    claudeBin,
    baseEnv = process.env,
    killGraceMs = DEFAULT_KILL_GRACE_MS,
    postResultGraceMs = DEFAULT_POST_RESULT_GRACE_MS,
    onStarted,
    onProcess,
    signal,
    timeoutMs = (job.agent.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES) * 60_000,
  } = options;

  if (signal?.aborted) {
    return {
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
    };
  }

  const { bin, prefixArgs } = resolveClaudeCommand(job, claudeBin, baseEnv);
  const expandedCwd = expandCwd(job.rule.cwd, baseEnv);
  const prompt = promptOverride ?? promptFor(job, contextFile);
  const args = buildClaudeArgs(job, prefixArgs);

  const cleanEnv = sanitizeRunnerEnv(baseEnv, job, contextFile, guardFile);
  cleanEnv.PATH = augmentRunnerPath(baseEnv);
  delete cleanEnv.CLAUDECODE;
  delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

  return new Promise<RunnerExecution>((resolve) => {
    const proc = spawn(bin, args, {
      cwd: expandedCwd,
      env: cleanEnv,
      detached: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    onProcess?.(proc);

    proc.stdin?.on("error", () => {});
    proc.stdin?.end(prompt, "utf8");

    const state = createClaudeStreamState();
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

    let lastNotifiedSession: string | null | undefined = undefined;
    const notifyStarted = (session: string | null) => {
      const effectiveSession = session ?? job.session ?? null;
      if (
        lastNotifiedSession !== undefined &&
        effectiveSession === lastNotifiedSession
      ) {
        return;
      }
      lastNotifiedSession = effectiveSession;
      onStarted?.(
        proc.pid !== undefined
          ? { session: effectiveSession, pid: proc.pid }
          : { session: effectiveSession },
      );
    };

    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      let newlineIdx = stdoutBuffer.indexOf("\n");
      while (newlineIdx !== -1) {
        const line = stdoutBuffer.slice(0, newlineIdx);
        stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
        processClaudeNdjsonLine(line, state, notifyStarted);
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
        processClaudeNdjsonLine(stdoutBuffer, state, notifyStarted);
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
      const effectiveExitCode =
        graceTerminated && !state.sawErrorResult ? 0 : exitCode;

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

      if (state.sawErrorResult || effectiveExitCode !== 0) {
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
