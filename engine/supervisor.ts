/**
 * Worker supervision loop for claiming jobs, isolating run files, dispatching
 * to native runners, sending heartbeats, cancelling process groups cleanly,
 * and performing up to 2 in-place receipt repairs on the original session.
 */

import { randomUUID } from "node:crypto";
import { repairPrompt } from "../protocol/receipt.ts";
import type { Job, Receipt, RunResult, RunUsage } from "../protocol/types.ts";
import { runAcpAgent } from "./acp-runner.ts";
import { runAgentApiUi } from "./agentapi-runner.ts";
import { runAgyPrint, type RunnerExecution } from "./agy-runner.ts";
import { runClaudePrint } from "./claude-runner.ts";
import { runCodexExec } from "./codex-runner.ts";
import { runCommandProbe } from "./command-runner.ts";
import { writeRunFiles } from "./context-file.ts";
import { runHerdrAgent } from "./herdr-runner.ts";

export type MaybePromise<T> = T | Promise<T>;

export interface ClaimWorkInput {
  claimId: string;
  capacity: number;
  running: number[];
}

export interface ClaimWorkOutput {
  jobs: Job[];
  cancel: number[];
}

export interface MarkStartedInput {
  run: number;
  token: string;
  session?: string | null;
}

export interface SubmitResultInput {
  run: number;
  token: string;
  result: RunResult;
}

export interface SupervisorBackend {
  claimWork(input: ClaimWorkInput): MaybePromise<ClaimWorkOutput>;
  markStarted(input: MarkStartedInput): MaybePromise<unknown>;
  submitResult(input: SubmitResultInput): MaybePromise<unknown>;
}

export interface CustomRunnerContext {
  job: Job;
  contextFile: string;
  guardFile: string;
  promptOverride?: string;
  baseEnv?: NodeJS.ProcessEnv;
  killGraceMs?: number;
  onStarted: (info: { session: string | null; pid?: number }) => void;
  signal: AbortSignal;
}

export type CustomRunnerHandler = (
  ctx: CustomRunnerContext,
) => Promise<RunnerExecution>;

export interface SupervisorOptions {
  autoloopHome: string;
  backend: SupervisorBackend;
  capacity?: number;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  killGraceMs?: number;
  postResultGraceMs?: number;
  agyBin?: string;
  agentApiBin?: string;
  codexBin?: string;
  claudeBin?: string;
  herdrBin?: string;
  appDataDir?: string;
  baseEnv?: NodeJS.ProcessEnv;
  deliveryRunner?: CustomRunnerHandler;
  onError?: (err: unknown) => void;
}

export interface Supervisor {
  start(): void;
  stop(): Promise<void>;
  kick(): Promise<void>;
  activeRuns(): number[];
}

interface ActiveRunEntry {
  job: Job;
  abortController: AbortController;
  kernelCancelled: boolean;
  donePromise: Promise<void>;
}

const DEFAULT_CAPACITY = 4;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_RECEIPT_REPAIRS = 2;

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function accumulateUsage(
  acc: RunUsage | undefined,
  next: RunUsage | undefined,
): RunUsage | undefined {
  if (!acc && !next) {
    return undefined;
  }
  const merged: RunUsage = {};
  let hasAny = false;

  for (const field of ["input", "output", "cached", "cost"] as const) {
    const a = acc?.[field];
    const b = next?.[field];
    if (a !== undefined || b !== undefined) {
      merged[field] = (a ?? 0) + (b ?? 0);
      hasAny = true;
    }
  }

  return hasAny ? merged : undefined;
}

function attachExposedSession(
  target: RunResult,
  exposedSession: string | null | undefined,
): void {
  if (exposedSession !== undefined) {
    const mutableTarget: { session?: string | null } = target;
    mutableTarget.session = exposedSession;
  }
}

function attachReceiptFields(target: RunResult, receipt: Receipt): void {
  if (receipt.ask !== undefined) target.ask = receipt.ask;
  if (receipt.notice !== undefined) target.notice = receipt.notice;
  if (receipt.resolve !== undefined) target.resolve = receipt.resolve;
  if (receipt.later !== undefined) target.later = receipt.later;
  if (receipt.events !== undefined) target.events = receipt.events;
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function canRepairSession(runner: Job["agent"]["runner"]): boolean {
  switch (runner) {
    case "agy-print":
    case "agentapi-ui":
    case "codex":
    case "claude":
    case "acp":
    case "herdr":
      return true;
    case "command":
    case "delivery":
      return false;
    default: {
      const unknownRunner: never = runner;
      void unknownRunner;
      return false;
    }
  }
}

/**
 * Create a worker supervisor bound to a local or IPC `SupervisorBackend`.
 */
export function createSupervisor(options: SupervisorOptions): Supervisor {
  const capacity =
    options.capacity !== undefined &&
    Number.isSafeInteger(options.capacity) &&
    options.capacity >= 0
      ? options.capacity
      : DEFAULT_CAPACITY;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;

  const instanceId = randomUUID().slice(0, 8);
  let claimSeq = 0;

  let runningLoop = false;
  let stopping = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  const active = new Map<number, ActiveRunEntry>();
  let claimChain: Promise<void> = Promise.resolve();
  let kickQueued = false;
  let kickInFlight: Promise<void> | null = null;

  function nextClaimId(): string {
    claimSeq += 1;
    return `sup-${instanceId}-${claimSeq}`;
  }

  function activeRuns(): number[] {
    return Array.from(active.keys());
  }

  function cancelRuns(runIds: number[]): void {
    for (const runId of runIds) {
      const entry = active.get(runId);
      if (!entry || entry.kernelCancelled) {
        continue;
      }
      entry.kernelCancelled = true;
      entry.abortController.abort();
    }
  }

  async function executeJob(entry: ActiveRunEntry): Promise<void> {
    const { job, abortController } = entry;
    let markedStarted = false;
    let lastMarkedSession: string | null = null;
    let startPromise: Promise<void> = Promise.resolve();
    let totalUsage: RunUsage | undefined;
    let anyStarted = false;
    let latestSession: string | null = null;
    let downgradedFromStaleSession = false;
    let submitted = false;

    const handleStarted = (info: { session: string | null; pid?: number }) => {
      anyStarted = true;
      const session = nonEmptyString(info.session);
      if (session !== null) {
        latestSession = session;
      }
      if (downgradedFromStaleSession && session === null) {
        return;
      }
      if (markedStarted && session === lastMarkedSession) {
        return;
      }
      markedStarted = true;
      lastMarkedSession = session;
      startPromise = startPromise
        .then(async () => {
          await options.backend.markStarted({
            run: job.run,
            token: job.token,
            session,
          });
        })
        .catch((err) => {
          options.onError?.(err);
        });
    };

    try {
      const files = writeRunFiles(options.autoloopHome, job);

      const invokeRunner = (
        targetJob: Job,
        promptOverride?: string,
      ): Promise<RunnerExecution> => {
        switch (targetJob.agent.runner) {
          case "agy-print":
            return runAgyPrint({
              job: targetJob,
              contextFile: files.contextFile,
              guardFile: files.guardFile,
              promptOverride,
              agyBin: options.agyBin,
              baseEnv: options.baseEnv,
              killGraceMs: options.killGraceMs,
              postResultGraceMs: options.postResultGraceMs,
              onStarted: handleStarted,
              signal: abortController.signal,
            });
          case "agentapi-ui":
            return runAgentApiUi({
              job: targetJob,
              contextFile: files.contextFile,
              guardFile: files.guardFile,
              promptOverride,
              agentApiBin: options.agentApiBin,
              appDataDir: options.appDataDir,
              baseEnv: options.baseEnv,
              killGraceMs: options.killGraceMs,
              onStarted: handleStarted,
              signal: abortController.signal,
            });
          case "codex":
            return runCodexExec({
              job: targetJob,
              contextFile: files.contextFile,
              guardFile: files.guardFile,
              promptOverride,
              codexBin: options.codexBin,
              baseEnv: options.baseEnv,
              killGraceMs: options.killGraceMs,
              postResultGraceMs: options.postResultGraceMs,
              onStarted: handleStarted,
              signal: abortController.signal,
            });
          case "claude":
            return runClaudePrint({
              job: targetJob,
              contextFile: files.contextFile,
              guardFile: files.guardFile,
              promptOverride,
              claudeBin: options.claudeBin,
              baseEnv: options.baseEnv,
              killGraceMs: options.killGraceMs,
              postResultGraceMs: options.postResultGraceMs,
              onStarted: handleStarted,
              signal: abortController.signal,
            });
          case "acp":
            return runAcpAgent({
              job: targetJob,
              contextFile: files.contextFile,
              guardFile: files.guardFile,
              promptOverride,
              baseEnv: options.baseEnv,
              killGraceMs: options.killGraceMs,
              postResultGraceMs: options.postResultGraceMs,
              onStarted: handleStarted,
              signal: abortController.signal,
            });
          case "herdr":
            return runHerdrAgent({
              job: targetJob,
              contextFile: files.contextFile,
              guardFile: files.guardFile,
              promptOverride,
              herdrBin: options.herdrBin,
              baseEnv: options.baseEnv,
              killGraceMs: options.killGraceMs,
              onStarted: handleStarted,
              signal: abortController.signal,
            });
          case "command":
            return runCommandProbe({
              job: targetJob,
              contextFile: files.contextFile,
              guardFile: files.guardFile,
              baseEnv: options.baseEnv,
              killGraceMs: options.killGraceMs,
              signal: abortController.signal,
            });
          case "delivery": {
            if (!options.deliveryRunner) {
              throw new Error(
                `未配置 deliveryRunner，无法执行 Agent "${targetJob.agent.id}"`,
              );
            }
            return options.deliveryRunner({
              job: targetJob,
              contextFile: files.contextFile,
              guardFile: files.guardFile,
              promptOverride,
              baseEnv: options.baseEnv,
              killGraceMs: options.killGraceMs,
              onStarted: handleStarted,
              signal: abortController.signal,
            });
          }
          default: {
            const unknownRunner: never = targetJob.agent.runner;
            throw new Error(`不支持的 Runner 类型: ${String(unknownRunner)}`);
          }
        }
      };

      let exec = await invokeRunner(job);
      totalUsage = accumulateUsage(totalUsage, exec.usage);
      if (exec.started) {
        anyStarted = true;
        const initialSession = nonEmptyString(exec.session);
        if (initialSession !== null) {
          latestSession = initialSession;
        }
      } else if (
        nonEmptyString(job.session) !== null &&
        !entry.kernelCancelled &&
        !abortController.signal.aborted &&
        exec.outcome !== "cancelled" &&
        exec.cancelled !== true &&
        exec.timedOut !== true &&
        exec.exitCode !== 0
      ) {
        downgradedFromStaleSession = true;
        const freshJob: Job = {
          ...job,
          session: null,
        };
        exec = await invokeRunner(freshJob);
        totalUsage = accumulateUsage(totalUsage, exec.usage);
        if (exec.started) {
          anyStarted = true;
          const freshSession = nonEmptyString(exec.session);
          if (freshSession !== null) {
            latestSession = freshSession;
          }
        }
      }

      const initialExec = exec;
      const initialBusinessCompleted =
        !entry.kernelCancelled &&
        !abortController.signal.aborted &&
        initialExec.outcome !== "cancelled" &&
        initialExec.cancelled !== true &&
        initialExec.timedOut !== true &&
        initialExec.exitCode === 0 &&
        (initialExec.parsed.outcome === "done" ||
          initialExec.parsed.outcome === "nothing");

      const supportsRepair = canRepairSession(job.agent.runner);

      let repairAttempt = 0;
      while (
        supportsRepair &&
        !entry.kernelCancelled &&
        !abortController.signal.aborted &&
        exec.outcome !== "cancelled" &&
        exec.cancelled !== true &&
        exec.exitCode === 0 &&
        exec.parsed.problem !== null &&
        latestSession !== null &&
        repairAttempt < MAX_RECEIPT_REPAIRS
      ) {
        repairAttempt += 1;
        const repairJob: Job = {
          ...job,
          session: latestSession,
        };
        const repairedExec = await invokeRunner(
          repairJob,
          repairPrompt(exec.parsed.problem),
        );
        totalUsage = accumulateUsage(totalUsage, repairedExec.usage);
        if (repairedExec.started) {
          anyStarted = true;
          const repairedSession = nonEmptyString(repairedExec.session);
          if (repairedSession !== null) {
            latestSession = repairedSession;
          }
        }
        exec = repairedExec;
      }

      if (anyStarted && !markedStarted) {
        markedStarted = true;
        lastMarkedSession = latestSession;
        startPromise = startPromise
          .then(async () => {
            await options.backend.markStarted({
              run: job.run,
              token: job.token,
              session: latestSession,
            });
          })
          .catch((err) => {
            options.onError?.(err);
          });
      }

      await startPromise;

      if (stopping && !entry.kernelCancelled) {
        return;
      }

      const exposedSession: string | null | undefined = !anyStarted
        ? undefined
        : latestSession !== null
          ? latestSession
          : downgradedFromStaleSession
            ? null
            : undefined;

      let result: RunResult;
      if (
        entry.kernelCancelled ||
        exec.outcome === "cancelled" ||
        exec.cancelled === true
      ) {
        result = {
          outcome: "cancelled",
          summary: "stopped by user",
        };
        attachExposedSession(result, exposedSession);
        if (totalUsage !== undefined) result.usage = totalUsage;
      } else if (
        exec.exitCode === 0 &&
        exec.parsed.problem === null &&
        exec.outcome !== "failed"
      ) {
        result = {
          outcome: exec.outcome,
        };
        if (exec.summary) result.summary = exec.summary;
        attachExposedSession(result, exposedSession);
        if (totalUsage !== undefined) result.usage = totalUsage;
        if (exec.parsed.receipt) {
          attachReceiptFields(result, exec.parsed.receipt);
        }
      } else if (
        initialBusinessCompleted &&
        (exec.parsed.problem !== null || exec.exitCode !== 0)
      ) {
        // discardReceipt fallback: preserve completed business outcome without 10x failed retries
        const problem =
          exec.parsed.problem ??
          initialExec.parsed.problem ??
          exec.error ??
          "回执解析异常";
        const preservedOutcome = initialExec.parsed.outcome as
          "done" | "nothing";
        const preservedSummary =
          initialExec.parsed.summary || exec.summary || "";
        result = {
          outcome: preservedOutcome,
        };
        if (preservedSummary) {
          result.summary = preservedSummary;
        }
        attachExposedSession(result, exposedSession);
        if (totalUsage !== undefined) {
          result.usage = totalUsage;
        }
        if (preservedOutcome === "done") {
          result.notice = [
            {
              title: "回执格式损坏已忽略",
              text: `本轮业务已完成，但末尾 agent-autoloop 回执连续修复未通过已丢弃，请人工核查结果：\n${problem}`,
            },
          ];
        }
      } else if (exec.parsed.problem !== null) {
        const errMsg =
          exec.exitCode === 0
            ? exec.parsed.problem
            : (exec.error ?? exec.parsed.problem);
        result = {
          outcome: "failed",
          error: errMsg,
        };
        if (exec.summary) result.summary = exec.summary;
        attachExposedSession(result, exposedSession);
        if (totalUsage !== undefined) result.usage = totalUsage;
      } else {
        result = {
          outcome: "failed",
          error: exec.error ?? (exec.summary || "run failed"),
        };
        if (exec.summary) result.summary = exec.summary;
        attachExposedSession(result, exposedSession);
        if (totalUsage !== undefined) result.usage = totalUsage;
      }

      try {
        await Promise.resolve(
          options.backend.submitResult({
            run: job.run,
            token: job.token,
            result,
          }),
        );
      } catch (submitErr) {
        if (
          exposedSession === null &&
          submitErr instanceof Error &&
          /RunResult\.session/.test(submitErr.message)
        ) {
          const compatResult: RunResult = { ...result };
          delete (compatResult as { session?: string | null }).session;
          await Promise.resolve(
            options.backend.submitResult({
              run: job.run,
              token: job.token,
              result: compatResult,
            }),
          );
        } else {
          throw submitErr;
        }
      }
      submitted = true;
    } catch (err) {
      options.onError?.(err);
      await startPromise;
      if (stopping && !entry.kernelCancelled) {
        return;
      }
      const fallbackResult: RunResult = entry.kernelCancelled
        ? { outcome: "cancelled", summary: "stopped by user" }
        : { outcome: "failed", error: toErrorMessage(err) };
      if (anyStarted && latestSession !== null) {
        fallbackResult.session = latestSession;
      }
      if (totalUsage !== undefined) {
        fallbackResult.usage = totalUsage;
      }
      try {
        await Promise.resolve(
          options.backend.submitResult({
            run: job.run,
            token: job.token,
            result: fallbackResult,
          }),
        );
        submitted = true;
      } catch (submitErr) {
        options.onError?.(submitErr);
      }
    } finally {
      active.delete(job.run);
      if (submitted && !stopping && active.size < capacity) {
        void kick();
      }
    }
  }

  function launchJob(job: Job): void {
    if (stopping || active.has(job.run)) {
      return;
    }
    const entry: ActiveRunEntry = {
      job,
      abortController: new AbortController(),
      kernelCancelled: false,
      donePromise: Promise.resolve(),
    };
    active.set(job.run, entry);
    entry.donePromise = executeJob(entry);
  }

  function enqueueClaim(requestedCapacity: number): Promise<void> {
    const task = claimChain.then(async () => {
      if (stopping) {
        return;
      }
      const response = await Promise.resolve(
        options.backend.claimWork({
          claimId: nextClaimId(),
          capacity: requestedCapacity,
          running: activeRuns(),
        }),
      );
      if (Array.isArray(response.cancel) && response.cancel.length > 0) {
        cancelRuns(response.cancel);
      }
      if (!stopping && Array.isArray(response.jobs)) {
        for (const job of response.jobs) {
          launchJob(job);
        }
      }
    });
    claimChain = task.catch((err) => {
      options.onError?.(err);
    });
    return task;
  }

  async function kick(): Promise<void> {
    if (stopping) {
      return;
    }
    if (kickInFlight) {
      kickQueued = true;
      return kickInFlight;
    }

    const runKickCycle = async (): Promise<void> => {
      try {
        do {
          kickQueued = false;
          if (stopping) {
            break;
          }
          try {
            await enqueueClaim(capacity);
          } catch (err) {
            options.onError?.(err);
          }
        } while (kickQueued && !stopping);
      } finally {
        kickInFlight = null;
      }
    };

    kickInFlight = runKickCycle();
    return kickInFlight;
  }

  async function sendHeartbeat(): Promise<void> {
    if (stopping || active.size === 0) {
      return;
    }
    try {
      await enqueueClaim(0);
    } catch (err) {
      options.onError?.(err);
    }
  }

  function start(): void {
    if (runningLoop) {
      return;
    }
    runningLoop = true;
    stopping = false;

    if (pollIntervalMs > 0) {
      pollTimer = setInterval(() => {
        void kick();
      }, pollIntervalMs);
      pollTimer.unref?.();
    }

    if (heartbeatIntervalMs > 0) {
      heartbeatTimer = setInterval(() => {
        void sendHeartbeat();
      }, heartbeatIntervalMs);
      heartbeatTimer.unref?.();
    }

    void kick();
  }

  async function stop(): Promise<void> {
    stopping = true;
    runningLoop = false;

    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    await claimChain;

    for (const entry of active.values()) {
      entry.abortController.abort();
    }

    const pending = Array.from(active.values(), (entry) => entry.donePromise);
    await Promise.allSettled(pending);
  }

  return {
    start,
    stop,
    kick,
    activeRuns,
  };
}
