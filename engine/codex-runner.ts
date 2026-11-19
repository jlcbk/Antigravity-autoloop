import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promptFor, readMessage } from "../protocol/receipt.ts";
import type { Job, RunUsage } from "../protocol/types.ts";
import { type RunnerExecution, sanitizeRunnerEnv } from "./agy-runner.ts";

export type { RunnerExecution } from "./agy-runner.ts";

export interface RunCodexOptions {
  job: Job;
  contextFile: string;
  guardFile: string;
  promptOverride?: string;
  codexBin?: string;
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
  "thread.started",
  "turn.started",
  "item.started",
  "item.updated",
  "item.completed",
  "turn.completed",
  "init",
  "system",
  "session",
  "started",
  "assistant",
  "message",
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
 * Prepend standard user/Homebrew CLI binary directories ahead of inherited `PATH`
 * so minimal GUI Sidecar environments reliably locate `codex` and `node`.
 */
export function augmentRunnerPath(baseEnv: NodeJS.ProcessEnv): string {
  const home = nonEmptyString(baseEnv.HOME) ?? os.homedir();
  const prefixDirs = [
    `${home}/.local/bin`,
    `${home}/.local/lib/node-v24.19.0-darwin-arm4/bin`,
    `${home}/.local/lib/node-v24.19.0-darwin-arm64/bin`,
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  const existing = (baseEnv.PATH ?? "")
    .split(path.delimiter)
    .filter((entry) => entry.length > 0);

  const seen = new Set<string>();
  const merged: string[] = [];
  for (const dir of [...prefixDirs, ...existing]) {
    if (!seen.has(dir)) {
      seen.add(dir);
      merged.push(dir);
    }
  }
  return merged.join(path.delimiter);
}

/**
 * Resolve the executable and optional custom prefix arguments for `codex`.
 */
export function resolveCodexCommand(
  job: Job,
  codexBin?: string,
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
    nonEmptyString(codexBin) ??
    nonEmptyString(baseEnv?.AUTOLOOP_CODEX_BIN) ??
    "codex";
  return { bin, prefixArgs: [] };
}

/**
 * Build `codex exec` / `codex exec ... resume` CLI arguments without shell interpolation.
 * Note: `-C`, `--skip-git-repo-check`, `--color`, and `-s` belong on parent `exec`
 * (before `resume`), while `--json`, `-o`, `-m`, `-c` follow `resume` when resuming.
 */
export function buildCodexArgs(
  job: Job,
  prefixArgs: readonly string[],
  expandedCwd: string,
  lastMsgFile: string,
): string[] {
  const execParentArgs: string[] = [
    ...prefixArgs,
    "exec",
    "-C",
    expandedCwd,
    "--skip-git-repo-check",
    "--color",
    "never",
  ];

  const access = job.agent.access ?? "edit";
  if (access === "read") {
    execParentArgs.push("-s", "read-only");
  } else if (access === "full") {
    execParentArgs.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    execParentArgs.push("-s", "workspace-write");
  }

  const turnFlags: string[] = ["--json", "-o", lastMsgFile];
  if (typeof job.agent.model === "string" && job.agent.model.length > 0) {
    turnFlags.push("-m", job.agent.model);
  }
  if (typeof job.agent.effort === "string" && job.agent.effort.length > 0) {
    const mappedEffort =
      job.agent.effort === "max" ? "xhigh" : job.agent.effort;
    turnFlags.push("-c", `model_reasoning_effort="${mappedEffort}"`);
  }

  if (typeof job.session === "string" && job.session.length > 0) {
    return [...execParentArgs, "resume", ...turnFlags, job.session, "-"];
  }

  return [...execParentArgs, ...turnFlags, "-"];
}

function extractSessionIdFromRecord(
  record: Record<string, unknown>,
): string | null {
  return (
    nonEmptyString(record.thread_id) ??
    nonEmptyString(record.threadId) ??
    nonEmptyString(record.session_id) ??
    nonEmptyString(record.sessionId) ??
    nonEmptyString(record.conversation_id) ??
    nonEmptyString(record.conversationId)
  );
}

function extractCodexSessionId(event: Record<string, unknown>): string | null {
  const direct = extractSessionIdFromRecord(event);
  if (direct) {
    return direct;
  }

  for (const nestedKey of [
    "thread",
    "session",
    "conversation",
    "data",
    "result",
    "metadata",
  ]) {
    const nested = asRecord(event[nestedKey]);
    if (!nested) {
      continue;
    }
    const found =
      extractSessionIdFromRecord(nested) ??
      (nestedKey === "thread" ||
      nestedKey === "session" ||
      nestedKey === "conversation"
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
    for (const part of value) {
      if (typeof part === "string") {
        out += part;
        continue;
      }
      const block = asRecord(part);
      if (!block) {
        continue;
      }
      const blockType =
        typeof block.type === "string" ? block.type.toLowerCase() : "";
      if (
        blockType === "thinking" ||
        blockType === "reasoning" ||
        blockType === "tool_use"
      ) {
        continue;
      }
      if (
        blockType === "text" ||
        blockType === "output_text" ||
        blockType === "agent_message" ||
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
  return "";
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

function extractCodexUsage(event: Record<string, unknown>): RunUsage | null {
  const eventType =
    typeof event.type === "string" ? event.type.toLowerCase() : "";
  const usageObj = asRecord(event.usage);

  const source =
    usageObj ??
    (eventType === "usage" ||
    eventType === "turn.completed" ||
    eventType === "result"
      ? event
      : null);
  if (!source) {
    return null;
  }

  const rawInput =
    finiteNumber(source.input_tokens) ??
    finiteNumber(source.input) ??
    finiteNumber(source.inputTokens);
  const rawCached =
    finiteNumber(source.cached_input_tokens) ??
    finiteNumber(source.cached) ??
    finiteNumber(source.cache_read_input_tokens) ??
    finiteNumber(source.cache_read_tokens) ??
    finiteNumber(source.cached_tokens) ??
    finiteNumber(source.cachedInputTokens);
  const rawOutput =
    finiteNumber(source.output_tokens) ??
    finiteNumber(source.output) ??
    finiteNumber(source.outputTokens);
  const rawCost =
    finiteNumber(source.cost) ??
    finiteNumber(source.cost_usd) ??
    finiteNumber(source.total_cost_usd) ??
    finiteNumber(event.cost) ??
    finiteNumber(event.cost_usd) ??
    finiteNumber(event.total_cost_usd);

  const usage: RunUsage = {};
  if (rawInput !== undefined || rawCached !== undefined) {
    usage.input = Math.max(rawInput ?? 0, rawCached ?? 0);
  }
  if (rawOutput !== undefined) {
    usage.output = rawOutput;
  }
  if (rawCached !== undefined) {
    usage.cached = rawCached;
  }
  if (rawCost !== undefined) {
    usage.cost = rawCost;
  }

  if (
    usage.input === undefined &&
    usage.output === undefined &&
    usage.cached === undefined &&
    usage.cost === undefined
  ) {
    return null;
  }
  return usage;
}

interface CodexStreamState {
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
  finalUsage: RunUsage | null;
}

function createCodexStreamState(): CodexStreamState {
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
    finalUsage: null,
  };
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

function processCodexJsonlLine(
  line: string,
  state: CodexStreamState,
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
    eventType === "turn.failed" ||
    event.is_error === true ||
    (eventType === "result" && subtype === "error");

  if (isErrorEvent) {
    const errText = extractErrorText(event);
    if (errText) {
      state.lastStreamError = errText;
    }
    if (eventType === "turn.failed" || eventType === "result") {
      state.sawErrorResult = true;
      state.sawFinalResult = true;
    }
  } else {
    const foundSession = extractCodexSessionId(event);
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

  if (eventType === "item.started" || eventType === "message_start") {
    state.currentTurnDelta = "";
  } else if (eventType === "item.completed") {
    const item = asRecord(event.item);
    if (item) {
      const itemType =
        typeof item.type === "string" ? item.type.toLowerCase() : "";
      const itemRole =
        typeof item.role === "string" ? item.role.toLowerCase() : "";
      if (
        (itemType === "agent_message" ||
          itemType === "assistant_message" ||
          itemType === "message" ||
          itemType === "text") &&
        itemRole !== "user" &&
        itemRole !== "system" &&
        itemRole !== "developer"
      ) {
        const text =
          extractTextFromValue(item.text) ||
          extractTextFromValue(item.content) ||
          extractTextFromValue(item.message);
        if (text.length > 0) {
          state.lastAssistantText = text;
          state.currentTurnDelta = "";
        }
      }
    }
  } else if (
    eventType === "item.delta" ||
    eventType === "agent_message.delta" ||
    eventType === "text_delta" ||
    eventType === "content_block_delta"
  ) {
    const delta = extractDeltaText(event);
    if (delta.length > 0) {
      state.currentTurnDelta += delta;
      state.allDeltas += delta;
    }
  } else if (eventType === "assistant" || eventType === "message") {
    const msgObj = asRecord(event.message);
    const role =
      typeof event.role === "string"
        ? event.role.toLowerCase()
        : typeof msgObj?.role === "string"
          ? msgObj.role.toLowerCase()
          : "";
    if (role !== "user" && role !== "system" && role !== "developer") {
      const text =
        extractTextFromValue(event.message) ||
        extractTextFromValue(event.content) ||
        extractTextFromValue(event.text);
      if (text.length > 0) {
        state.lastAssistantText = text;
        state.currentTurnDelta = "";
      }
    }
  } else if (eventType === "turn.completed" && !isErrorEvent) {
    state.sawFinalResult = true;
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

  const usage = extractCodexUsage(event);
  if (usage) {
    if (eventType === "turn.completed" || eventType === "result") {
      state.finalUsage = state.finalUsage
        ? mergeUsageObjects(state.finalUsage, usage)
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

function finalizeRawText(state: CodexStreamState): string {
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

function finalizeUsage(state: CodexStreamState): RunUsage | undefined {
  const inc = state.incrementalUsage;
  const incUsage: RunUsage = {};
  if (inc.hasInput || inc.hasCached) {
    incUsage.input = Math.max(inc.input, inc.cached);
  }
  if (inc.hasOutput) incUsage.output = inc.output;
  if (inc.hasCached) incUsage.cached = inc.cached;
  if (inc.hasCost) incUsage.cost = inc.cost;
  const hasAnyInc =
    inc.hasInput || inc.hasOutput || inc.hasCached || inc.hasCost;

  const res = state.finalUsage;
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
      // Process already exited.
    }
  }
}

/**
 * Execute a single headless `codex exec --json` (or `codex exec ... resume --json`)
 * turn with stdin prompt isolation, `-o` last-message fallback, and process-group cleanup.
 */
export async function runCodexExec(
  options: RunCodexOptions,
): Promise<RunnerExecution> {
  const {
    job,
    contextFile,
    guardFile,
    promptOverride,
    codexBin,
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

  const { bin, prefixArgs } = resolveCodexCommand(job, codexBin, baseEnv);
  const expandedCwd = expandCwd(job.rule.cwd, baseEnv);
  const prompt = promptOverride ?? promptFor(job, contextFile);

  const runDir = path.dirname(contextFile);
  try {
    mkdirSync(runDir, { recursive: true });
  } catch {
    // Best-effort directory creation; spawn/codex will report errors if invalid.
  }
  const lastMsgFile = path.join(
    runDir,
    `codex-last-msg-${randomBytes(8).toString("hex")}.txt`,
  );

  const args = buildCodexArgs(job, prefixArgs, expandedCwd, lastMsgFile);
  const cleanEnv = sanitizeRunnerEnv(baseEnv, job, contextFile, guardFile);
  cleanEnv.PATH = augmentRunnerPath(baseEnv);

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

    const state = createCodexStreamState();
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
        processCodexJsonlLine(line, state, notifyStarted);
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
        processCodexJsonlLine(stdoutBuffer, state, notifyStarted);
        stdoutBuffer = "";
      }

      let rawText = finalizeRawText(state);
      if (rawText.trim().length === 0 && !state.sawErrorResult) {
        try {
          const fallbackText = readFileSync(lastMsgFile, "utf8");
          if (fallbackText.trim().length > 0) {
            rawText = fallbackText;
          }
        } catch {
          // Ignore when -o file was never written.
        }
      }

      try {
        rmSync(lastMsgFile, { force: true });
      } catch {
        // Best-effort cleanup of temporary last-message file.
      }

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
