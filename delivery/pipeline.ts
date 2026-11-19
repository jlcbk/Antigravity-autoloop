/**
 * Five-step isolated worktree delivery pipeline (`delivery/pipeline.ts`).
 *
 * Step 1: Bare snapshot extraction & heterogeneous read-only model review
 * Step 2: Ephemeral isolated `git worktree` checkCommand execution (always cleaned in `finally`)
 * Step 3: Base-branch drift/conflict check & sensitivePaths human approval gate
 * Step 4: Safe merge (`ff-only`, `merge` --no-ff, `squash`, or `gh-pr`) preserving dirty worktrees
 * Step 5: Post-merge `smokeCommand` verification & closure notice receipt
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RunnerExecution } from "../engine/agy-runner.ts";
import { expandHomePath } from "../engine/context-file.ts";
import type { CustomRunnerHandler } from "../engine/supervisor.ts";
import { readMessage } from "../protocol/receipt.ts";
import type {
  InboundEvent,
  JobAnswerContext,
  JobDecidedCardContext,
  JobEventContext,
  Receipt,
} from "../protocol/types.ts";
import { isPlainObject } from "../protocol/validate.ts";
import {
  getEntryBlockingFindings,
  hasCodeBlockingFindings,
  readReviewLedger,
  reviewBranchSnapshot,
  type ReviewOutcome,
} from "./reviewer.ts";
import {
  atomicWritePrivateText,
  extractBranchSnapshot,
  type BranchSnapshot,
  type MergeStrategy,
} from "./snapshot.ts";

export type DeliveryPipelineStatus =
  | "merged"
  | "changes_requested"
  | "awaiting_approval"
  | "rejected"
  | "check_failed"
  | "conflict"
  | "smoke_failed"
  | "cancelled";

export type DeliveryStep = "review" | "check" | "gate" | "merge" | "smoke";

export interface DeliveryPipelineOptions {
  repoDir: string;
  targetRef: string;
  baseBranch?: string;
  workDir?: string;
  outputDir?: string;
  ledgerFile?: string;
  approvalsFile?: string;
  authorModel?: string;
  reviewerModelOverride?: string;
  agyBin?: string;
  codexBin?: string;
  claudeBin?: string;
  ghBin?: string;
  postResultGraceMs?: number;
  baseEnv?: NodeJS.ProcessEnv;
  reviewTimeoutMs?: number;
  checkTimeoutMs?: number;
  smokeTimeoutMs?: number;
  mergeTimeoutMs?: number;
  approvedKeys?: readonly string[];
  rejectedKeys?: readonly string[];
  answers?: readonly JobAnswerContext[];
  decided?: readonly JobDecidedCardContext[];
  signal?: AbortSignal;
  eventIdPrefix?: string;
}

export interface DeliveryPipelineResult {
  status: DeliveryPipelineStatus;
  step: DeliveryStep;
  merged: boolean;
  outcome: "done" | "nothing" | "failed" | "cancelled";
  summary: string;
  snapshot?: BranchSnapshot;
  review?: ReviewOutcome;
  matchedSensitiveFiles: string[];
  conflictedFiles: string[];
  checkOutput?: string;
  smokeOutput?: string;
  mergeStrategy?: MergeStrategy;
  mergedSha?: string;
  workingTreeNotice?: string;
  receipt: Receipt;
  error?: string;
}

export interface DeliveryRunnerDefaults {
  repoDir?: string;
  baseBranch?: string;
  workDir?: string;
  ledgerFile?: string;
  approvalsFile?: string;
  authorModel?: string;
  reviewerModelOverride?: string;
  agyBin?: string;
  codexBin?: string;
  claudeBin?: string;
  ghBin?: string;
  postResultGraceMs?: number;
  reviewTimeoutMs?: number;
  checkTimeoutMs?: number;
  smokeTimeoutMs?: number;
  mergeTimeoutMs?: number;
}

interface ApprovalLedgerEntry {
  key: string;
  targetRef: string;
  headSha: string;
  decision: "approved" | "rejected";
  at: string;
}

interface ApprovalLedger {
  version: 1;
  entries: ApprovalLedgerEntry[];
}

interface CommandRunOutput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  error?: string;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MERGE_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_KILL_GRACE_MS = 500;
const DEFAULT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_CHARS = 12_000;
const EVENT_SUBJECT_RE = /^[a-zA-Z0-9#][a-zA-Z0-9#._:/@-]*$/;
const SAFE_MODEL_ID_RE = /^[a-zA-Z0-9._-]+$/;

const REJECTION_CHOICE_RE =
  /^(?:(?:拒绝|不同意|驳回|不批准|不允许|不合并|退回|取消|放弃|暂缓|暂不|跳过|稍后|搁置|推迟)|(?:否)(?:[\s:：!！。,.]|$)|(?:reject(?:ed)?|deny|denied|decline(?:d)?|refuse(?:d)?|disapprove(?:d)?|cancel(?:led)?|defer(?:red)?|hold|skip(?:ped)?|later|postpone(?:d)?|ignore(?:d)?|abort|stop|no)(?:[\s:：!！。,.]|$))/i;

const SENSITIVE_EXACT_ENV_KEYS = new Set([
  "AUTOLOOP_OWNER_TOKEN",
  "ANTIGRAVITY_SIDECAR_UI_TOKEN",
  "ANTIGRAVITY_SIDECAR_TOKEN",
  "ANTIGRAVITY_OWNER_TOKEN",
  "AUTOLOOP_ADMIN_TOKEN",
  "AUTOLOOP_IPC_TOKEN",
  "AUTOLOOP_UI_TOKEN",
  "AUTOLOOP_MASTER_KEY",
  "SIDECAR_UI_TOKEN",
  "AUTOLOOP_GUARD_FILE",
  "AUTOLOOP_RUN_ID",
  "AUTOLOOP_CONTEXT",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
]);

function isStrippedEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (SENSITIVE_EXACT_ENV_KEYS.has(upper)) {
    return true;
  }
  if (
    (upper.startsWith("AUTOLOOP_") ||
      upper.startsWith("ANTIGRAVITY_SIDECAR")) &&
    (upper.endsWith("_TOKEN") ||
      upper.endsWith("_SECRET") ||
      upper.endsWith("_KEY"))
  ) {
    return true;
  }
  return false;
}

function sanitizeSubprocessEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined || isStrippedEnvKey(key)) {
      continue;
    }
    clean[key] = value;
  }
  clean.GIT_TERMINAL_PROMPT = "0";
  clean.GIT_OPTIONAL_LOCKS = "0";
  return clean;
}

function sanitizeGitEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const clean = sanitizeSubprocessEnv(baseEnv);
  return clean;
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 14))}...(truncated)`;
}

function singleLine(text: string): string {
  return text.replace(/[\r\n]+/g, " ").trim();
}

function makeEventId(
  prefix: string | undefined,
  step: string,
  targetRef: string,
  headSha: string,
): string {
  const cleanPrefix = prefix ? `${prefix}-` : "deliv-";
  const cleanRef = targetRef.replace(/[^a-zA-Z0-9._-]/g, "_");
  const raw = `${cleanPrefix}${step}-${cleanRef}-${headSha.slice(0, 12)}`;
  return raw.slice(0, 200);
}

function sanitizeEventSubject(targetRef: string): string | undefined {
  if (
    targetRef.length > 0 &&
    targetRef.length <= 100 &&
    EVENT_SUBJECT_RE.test(targetRef)
  ) {
    return targetRef;
  }
  return undefined;
}

/**
 * Deterministic ask card key for 3-round review escalation.
 */
export function reviewEscalationCardKey(
  targetRef: string,
  headSha: string,
): string {
  return `delivery:review:${targetRef}:${headSha}`;
}

/**
 * Deterministic ask card key for sensitive path final approval.
 */
export function sensitivePathsCardKey(
  targetRef: string,
  headSha: string,
): string {
  return `delivery:sensitive:${targetRef}:${headSha}`;
}

function globToRegexSource(glob: string): string {
  let out = "";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 3;
          continue;
        }
        out += ".*";
        i += 2;
        continue;
      }
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    if ("\\^$.|+()[]{}".includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
    i += 1;
  }
  return out;
}

function normalizeRepoRelPath(raw: string): string {
  let p = raw.replace(/\\/g, "/").trim();
  while (p.startsWith("./")) {
    p = p.slice(2);
  }
  while (p.startsWith("/")) {
    p = p.slice(1);
  }
  return p;
}

/**
 * Matches a changed repository-relative file path against a `sensitivePaths` rule.
 * Supports directory prefixes (`kernel/`, `hooks`), exact paths (`package.json`),
 * and glob patterns (`*.json`, `protocol/**`, `kernel/*.ts`).
 */
export function matchesSensitivePath(
  filePath: string,
  pattern: string,
): boolean {
  const file = normalizeRepoRelPath(filePath);
  const rawPat = normalizeRepoRelPath(pattern);
  if (!file || !rawPat) {
    return false;
  }

  const hasGlob = rawPat.includes("*") || rawPat.includes("?");
  if (!hasGlob) {
    if (rawPat.endsWith("/")) {
      const dir = rawPat.slice(0, -1);
      return dir.length > 0 && (file === dir || file.startsWith(`${dir}/`));
    }
    return file === rawPat || file.startsWith(`${rawPat}/`);
  }

  const normalizedPat = rawPat.endsWith("/") ? `${rawPat}**` : rawPat;
  const regexBody = globToRegexSource(normalizedPat);
  const anchored = normalizedPat.includes("/")
    ? new RegExp(`^${regexBody}$`)
    : new RegExp(`^(?:.*/)?${regexBody}$`);
  return anchored.test(file);
}

function isRejectionChoice(choiceText: string): boolean {
  const trimmed = choiceText.trim();
  if (trimmed.length === 0) {
    return true;
  }
  return REJECTION_CHOICE_RE.test(trimmed);
}

function readApprovalLedger(approvalsFile?: string): ApprovalLedger {
  if (!approvalsFile) {
    return { version: 1, entries: [] };
  }
  const resolved = path.resolve(expandHomePath(approvalsFile));
  if (!existsSync(resolved)) {
    return { version: 1, entries: [] };
  }
  try {
    const raw = readFileSync(resolved, "utf8").trim();
    if (!raw) {
      return { version: 1, entries: [] };
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed) || !Array.isArray(parsed.entries)) {
      return { version: 1, entries: [] };
    }
    const entries: ApprovalLedgerEntry[] = [];
    for (const item of parsed.entries) {
      if (
        isPlainObject(item) &&
        typeof item.key === "string" &&
        typeof item.targetRef === "string" &&
        typeof item.headSha === "string" &&
        (item.decision === "approved" || item.decision === "rejected") &&
        typeof item.at === "string"
      ) {
        entries.push({
          key: item.key,
          targetRef: item.targetRef,
          headSha: item.headSha,
          decision: item.decision,
          at: item.at,
        });
      }
    }
    return { version: 1, entries };
  } catch {
    return { version: 1, entries: [] };
  }
}

function writeApprovalLedger(
  approvalsFile: string,
  ledger: ApprovalLedger,
): void {
  const resolved = path.resolve(expandHomePath(approvalsFile));
  atomicWritePrivateText(resolved, `${JSON.stringify(ledger, null, 2)}\n`);
}

function collectKeyDecisions(options: {
  approvedKeys?: readonly string[];
  rejectedKeys?: readonly string[];
  answers?: readonly JobAnswerContext[];
  decided?: readonly JobDecidedCardContext[];
  approvalsFile?: string;
  targetRef: string;
  headSha: string;
}): { approved: Set<string>; rejected: Set<string> } {
  const approved = new Set<string>();
  const rejected = new Set<string>();

  const ledger = readApprovalLedger(options.approvalsFile);
  for (const entry of ledger.entries) {
    if (
      entry.targetRef === options.targetRef &&
      entry.headSha === options.headSha
    ) {
      if (entry.decision === "approved") {
        rejected.delete(entry.key);
        approved.add(entry.key);
      } else {
        approved.delete(entry.key);
        rejected.add(entry.key);
      }
    }
  }

  const newlyRecorded: ApprovalLedgerEntry[] = [];
  const nowIso = new Date().toISOString();

  for (const dec of options.decided ?? []) {
    if (!dec.key) continue;
    if (isRejectionChoice(dec.choice)) {
      approved.delete(dec.key);
      rejected.add(dec.key);
      newlyRecorded.push({
        key: dec.key,
        targetRef: options.targetRef,
        headSha: options.headSha,
        decision: "rejected",
        at: dec.at || nowIso,
      });
    } else {
      rejected.delete(dec.key);
      approved.add(dec.key);
      newlyRecorded.push({
        key: dec.key,
        targetRef: options.targetRef,
        headSha: options.headSha,
        decision: "approved",
        at: dec.at || nowIso,
      });
    }
  }

  for (const ans of options.answers ?? []) {
    if (!ans.key) continue;
    const isRejected = isRejectionChoice(ans.chosen);
    if (isRejected) {
      approved.delete(ans.key);
      rejected.add(ans.key);
      newlyRecorded.push({
        key: ans.key,
        targetRef: options.targetRef,
        headSha: options.headSha,
        decision: "rejected",
        at: ans.at || nowIso,
      });
    } else {
      rejected.delete(ans.key);
      approved.add(ans.key);
      newlyRecorded.push({
        key: ans.key,
        targetRef: options.targetRef,
        headSha: options.headSha,
        decision: "approved",
        at: ans.at || nowIso,
      });
    }
  }

  if (options.approvalsFile && newlyRecorded.length > 0) {
    const mergedMap = new Map<string, ApprovalLedgerEntry>();
    for (const entry of ledger.entries) {
      mergedMap.set(
        `${entry.targetRef}\0${entry.headSha}\0${entry.key}`,
        entry,
      );
    }
    for (const entry of newlyRecorded) {
      if (entry.key.endsWith(`:${options.headSha}`)) {
        mergedMap.set(
          `${entry.targetRef}\0${entry.headSha}\0${entry.key}`,
          entry,
        );
      }
    }
    writeApprovalLedger(options.approvalsFile, {
      version: 1,
      entries: [...mergedMap.values()],
    });
  }

  for (const key of options.approvedKeys ?? []) {
    if (key) {
      rejected.delete(key);
      approved.add(key);
    }
  }
  for (const key of options.rejectedKeys ?? []) {
    if (key) {
      approved.delete(key);
      rejected.add(key);
    }
  }

  return { approved, rejected };
}

function runGit(
  cwd: string,
  args: string[],
  baseEnv?: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        shell: false,
        encoding: "utf8",
        maxBuffer: DEFAULT_MAX_BUFFER_BYTES,
        env: sanitizeGitEnv(baseEnv),
      },
      (err, stdout, stderr) => {
        if (err) {
          const code =
            typeof (err as NodeJS.ErrnoException).code === "number"
              ? ((err as NodeJS.ErrnoException).code as unknown as number)
              : null;
          if (code !== null) {
            resolve({ stdout, stderr, exitCode: code });
            return;
          }
          const detail = stderr.trim() || err.message;
          reject(new Error(`git ${args.join(" ")} failed: ${detail}`));
          return;
        }
        resolve({ stdout, stderr, exitCode: 0 });
      },
    );
  });
}

async function runGitOrThrow(
  cwd: string,
  args: string[],
  baseEnv?: NodeJS.ProcessEnv,
): Promise<string> {
  const res = await runGit(cwd, args, baseEnv);
  if (res.exitCode !== 0) {
    const detail = res.stderr.trim() || res.stdout.trim();
    throw new Error(
      `git ${args.join(" ")} exited with ${res.exitCode}: ${detail}`,
    );
  }
  return res.stdout;
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
      // Already terminated
    }
  }
}

function runShellCommand(options: {
  cwd: string;
  command: string;
  baseEnv?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<CommandRunOutput> {
  const {
    cwd,
    command,
    baseEnv = process.env,
    timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
    signal,
  } = options;

  if (signal?.aborted) {
    return Promise.resolve({
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      cancelled: true,
      error: "Aborted before command start",
    });
  }

  const shellBin = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
  const shellArgs =
    process.platform === "win32"
      ? ["/d", "/s", "/c", command]
      : ["-c", command];

  return new Promise<CommandRunOutput>((resolve) => {
    const proc = spawn(shellBin, shellArgs, {
      cwd,
      env: sanitizeSubprocessEnv(baseEnv),
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let terminating = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanupTimers = () => {
      if (timeoutTimer !== null) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      if (graceTimer !== null) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
      signal?.removeEventListener("abort", onAbort);
    };

    const terminate = () => {
      if (terminating || settled) {
        return;
      }
      terminating = true;
      signalProcessGroup(proc, "SIGTERM");
      graceTimer = setTimeout(() => {
        graceTimer = null;
        if (!settled) {
          signalProcessGroup(proc, "SIGKILL");
        }
      }, DEFAULT_KILL_GRACE_MS);
      graceTimer.unref?.();
    };

    const onAbort = () => {
      cancelled = true;
      terminate();
    };

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
      }
    }

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timeoutTimer = null;
        timedOut = true;
        terminate();
      }, timeoutMs);
      timeoutTimer.unref?.();
    }

    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => {
      if (stdout.length < MAX_COMMAND_OUTPUT_CHARS) {
        stdout += chunk.slice(0, MAX_COMMAND_OUTPUT_CHARS - stdout.length);
      }
    });

    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => {
      if (stderr.length < MAX_COMMAND_OUTPUT_CHARS) {
        stderr += chunk.slice(0, MAX_COMMAND_OUTPUT_CHARS - stderr.length);
      }
    });

    proc.once("error", (err: Error) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      resolve({
        exitCode: null,
        stdout,
        stderr,
        timedOut,
        cancelled,
        error: err.message,
      });
    });

    proc.once("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      resolve({
        exitCode: code,
        stdout,
        stderr,
        timedOut,
        cancelled,
        ...(timedOut
          ? { error: `Command timed out after ${timeoutMs}ms` }
          : {}),
      });
    });
  });
}

function runExecFile(
  file: string,
  args: string[],
  options: {
    cwd: string;
    baseEnv?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        cwd: options.cwd,
        shell: false,
        encoding: "utf8",
        maxBuffer: DEFAULT_MAX_BUFFER_BYTES,
        timeout: options.timeoutMs ?? DEFAULT_MERGE_TIMEOUT_MS,
        signal: options.signal,
        env: sanitizeSubprocessEnv(options.baseEnv),
      },
      (err, stdout, stderr) => {
        if (err) {
          const detail = stderr.trim() || stdout.trim() || err.message;
          reject(new Error(`${file} ${args.join(" ")} failed: ${detail}`));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

async function withIsolatedWorktree<T>(
  repoDir: string,
  commitIsh: string,
  baseEnv: NodeJS.ProcessEnv | undefined,
  fn: (worktreeDir: string) => Promise<T>,
): Promise<T> {
  const parent = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "autoloop-wt-")),
  );
  chmodSync(parent, 0o700);
  const worktreeDir = path.join(parent, "wt");
  let worktreeAdded = false;

  try {
    await runGitOrThrow(
      repoDir,
      ["worktree", "add", "--detach", worktreeDir, commitIsh],
      baseEnv,
    );
    worktreeAdded = true;
    return await fn(worktreeDir);
  } finally {
    if (worktreeAdded) {
      try {
        await runGit(
          repoDir,
          ["worktree", "remove", "--force", worktreeDir],
          baseEnv,
        );
      } catch {
        // Best-effort worktree removal before prune/rm
      }
    }
    try {
      await runGit(repoDir, ["worktree", "prune"], baseEnv);
    } catch {
      // Best-effort prune
    }
    try {
      rmSync(parent, { recursive: true, force: true });
    } catch {
      // Best-effort temp dir cleanup
    }
  }
}

async function getGitIdentityArgs(
  repoDir: string,
  baseEnv?: NodeJS.ProcessEnv,
): Promise<string[]> {
  const args: string[] = [];
  const nameRes = await runGit(repoDir, ["config", "user.name"], baseEnv);
  if (nameRes.exitCode !== 0 || nameRes.stdout.trim().length === 0) {
    args.push("-c", "user.name=Autoloop Delivery");
  }
  const emailRes = await runGit(repoDir, ["config", "user.email"], baseEnv);
  if (emailRes.exitCode !== 0 || emailRes.stdout.trim().length === 0) {
    args.push("-c", "user.email=autoloop@local.invalid");
  }
  return args;
}

function parseConflictedFilesFromMergeTree(output: string): string[] {
  const files = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const conflictMatch = /^CONFLICT\s+\([^)]+\):.*?\bin\s+(.+)$/.exec(
      line.trim(),
    );
    if (conflictMatch && conflictMatch[1]) {
      files.add(conflictMatch[1].trim());
    }
    const tabIdx = line.indexOf("\t");
    if (
      tabIdx > 0 &&
      /^[0-7]{6}\s+[0-9a-f]+\s+[123]$/.test(line.slice(0, tabIdx))
    ) {
      files.add(line.slice(tabIdx + 1).trim());
    }
  }
  return [...files];
}

async function checkMergeDriftAndConflicts(options: {
  repoDir: string;
  baseBranch: string;
  headSha: string;
  mergeStrategy: MergeStrategy;
  baseEnv?: NodeJS.ProcessEnv;
}): Promise<{
  currentBaseSha: string;
  hasConflict: boolean;
  conflictedFiles: string[];
  reason?: string;
}> {
  const { repoDir, baseBranch, headSha, mergeStrategy, baseEnv } = options;

  const currentBaseSha = (
    await runGitOrThrow(
      repoDir,
      ["rev-parse", "--verify", `${baseBranch}^{commit}`],
      baseEnv,
    )
  ).trim();

  const ancestorRes = await runGit(
    repoDir,
    ["merge-base", "--is-ancestor", currentBaseSha, headSha],
    baseEnv,
  );
  const isFastForwardable = ancestorRes.exitCode === 0;

  if (mergeStrategy === "ff-only" && !isFastForwardable) {
    return {
      currentBaseSha,
      hasConflict: true,
      conflictedFiles: [],
      reason: `主干分支 ${baseBranch} (${currentBaseSha.slice(0, 12)}) 已前移，无法执行 ff-only 快进合并`,
    };
  }

  if (isFastForwardable) {
    return {
      currentBaseSha,
      hasConflict: false,
      conflictedFiles: [],
    };
  }

  const mergeTreeRes = await runGit(
    repoDir,
    ["merge-tree", "--write-tree", currentBaseSha, headSha],
    baseEnv,
  );

  if (mergeTreeRes.exitCode === 0) {
    return {
      currentBaseSha,
      hasConflict: false,
      conflictedFiles: [],
    };
  }

  const combinedMsg = `${mergeTreeRes.stdout}\n${mergeTreeRes.stderr}`;
  if (!/unrecognized|unknown option|usage:/i.test(combinedMsg)) {
    const conflictedFiles = parseConflictedFilesFromMergeTree(combinedMsg);
    return {
      currentBaseSha,
      hasConflict: true,
      conflictedFiles,
      reason:
        conflictedFiles.length > 0
          ? `与当前 ${baseBranch} (${currentBaseSha.slice(0, 12)}) 存在合并冲突：${conflictedFiles.join(", ")}`
          : `与当前 ${baseBranch} (${currentBaseSha.slice(0, 12)}) 存在合并冲突`,
    };
  }

  // Fallback for Git < 2.38: isolated worktree dry-run merge
  return withIsolatedWorktree(
    repoDir,
    currentBaseSha,
    baseEnv,
    async (wtDir) => {
      const identityArgs = await getGitIdentityArgs(repoDir, baseEnv);
      const mergeRes = await runGit(
        wtDir,
        [...identityArgs, "merge", "--no-commit", "--no-ff", headSha],
        baseEnv,
      );
      if (mergeRes.exitCode === 0) {
        return {
          currentBaseSha,
          hasConflict: false,
          conflictedFiles: [],
        };
      }
      const unmerged = await runGit(
        wtDir,
        ["diff", "--name-only", "--diff-filter=U"],
        baseEnv,
      );
      const conflictedFiles = unmerged.stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      return {
        currentBaseSha,
        hasConflict: true,
        conflictedFiles,
        reason:
          conflictedFiles.length > 0
            ? `与当前 ${baseBranch} (${currentBaseSha.slice(0, 12)}) 存在合并冲突：${conflictedFiles.join(", ")}`
            : `与当前 ${baseBranch} (${currentBaseSha.slice(0, 12)}) 存在合并冲突`,
      };
    },
  );
}

async function inspectMainWorktreeState(
  repoDir: string,
  baseEnv?: NodeJS.ProcessEnv,
): Promise<{ headBranch: string | null; isClean: boolean }> {
  const symRes = await runGit(
    repoDir,
    ["symbolic-ref", "--short", "HEAD"],
    baseEnv,
  );
  const headBranch =
    symRes.exitCode === 0 && symRes.stdout.trim().length > 0
      ? symRes.stdout.trim()
      : null;

  const statusOut = await runGitOrThrow(
    repoDir,
    ["status", "--porcelain"],
    baseEnv,
  );
  return {
    headBranch,
    isClean: statusOut.trim().length === 0,
  };
}

async function executeSafeMerge(options: {
  repoDir: string;
  baseBranch: string;
  targetRef: string;
  currentBaseSha: string;
  headSha: string;
  mergeStrategy: MergeStrategy;
  ghBin?: string;
  baseEnv?: NodeJS.ProcessEnv;
  mergeTimeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{
  mergedSha: string;
  updatedMainInPlace: boolean;
  workingTreeNotice?: string;
}> {
  const {
    repoDir,
    baseBranch,
    targetRef,
    currentBaseSha,
    headSha,
    mergeStrategy,
    ghBin = "gh",
    baseEnv,
    mergeTimeoutMs,
    signal,
  } = options;

  if (mergeStrategy === "gh-pr") {
    await runExecFile(ghBin, ["pr", "merge", targetRef, "--merge"], {
      cwd: repoDir,
      baseEnv,
      timeoutMs: mergeTimeoutMs,
      signal,
    });
    const shaRes = await runGit(
      repoDir,
      ["rev-parse", "--verify", `${baseBranch}^{commit}`],
      baseEnv,
    );
    const mergedSha =
      shaRes.exitCode === 0 && shaRes.stdout.trim().length > 0
        ? shaRes.stdout.trim()
        : headSha;
    return {
      mergedSha,
      updatedMainInPlace: false,
    };
  }

  const state = await inspectMainWorktreeState(repoDir, baseEnv);
  const identityArgs = await getGitIdentityArgs(repoDir, baseEnv);
  const mergeMsg = `Merge branch '${targetRef}' into ${baseBranch}`;
  const squashMsg = `Squash merge branch '${targetRef}' into ${baseBranch}`;

  if (state.headBranch === baseBranch && state.isClean) {
    if (mergeStrategy === "ff-only") {
      await runGitOrThrow(repoDir, ["merge", "--ff-only", headSha], baseEnv);
    } else if (mergeStrategy === "squash") {
      await runGitOrThrow(repoDir, ["merge", "--squash", headSha], baseEnv);
      const diffCached = await runGit(
        repoDir,
        ["diff", "--cached", "--quiet"],
        baseEnv,
      );
      if (diffCached.exitCode === 1) {
        await runGitOrThrow(
          repoDir,
          [...identityArgs, "commit", "-m", squashMsg],
          baseEnv,
        );
      }
    } else {
      await runGitOrThrow(
        repoDir,
        [...identityArgs, "merge", "--no-ff", "-m", mergeMsg, headSha],
        baseEnv,
      );
    }
    const mergedSha = (
      await runGitOrThrow(repoDir, ["rev-parse", "HEAD"], baseEnv)
    ).trim();
    return {
      mergedSha,
      updatedMainInPlace: true,
    };
  }

  // Main working tree is dirty or on a different branch: merge inside an isolated
  // worktree and atomically advance `refs/heads/<baseBranch>` via CAS `update-ref`
  // so uncommitted user edits are never touched.
  const mergedSha = await withIsolatedWorktree(
    repoDir,
    currentBaseSha,
    baseEnv,
    async (wtDir) => {
      if (mergeStrategy === "ff-only") {
        await runGitOrThrow(wtDir, ["merge", "--ff-only", headSha], baseEnv);
      } else if (mergeStrategy === "squash") {
        await runGitOrThrow(wtDir, ["merge", "--squash", headSha], baseEnv);
        const diffCached = await runGit(
          wtDir,
          ["diff", "--cached", "--quiet"],
          baseEnv,
        );
        if (diffCached.exitCode === 1) {
          await runGitOrThrow(
            wtDir,
            [...identityArgs, "commit", "-m", squashMsg],
            baseEnv,
          );
        }
      } else {
        await runGitOrThrow(
          wtDir,
          [...identityArgs, "merge", "--no-ff", "-m", mergeMsg, headSha],
          baseEnv,
        );
      }
      return (
        await runGitOrThrow(wtDir, ["rev-parse", "HEAD"], baseEnv)
      ).trim();
    },
  );

  await runGitOrThrow(
    repoDir,
    ["update-ref", `refs/heads/${baseBranch}`, mergedSha, currentBaseSha],
    baseEnv,
  );

  const workingTreeNotice =
    state.headBranch === baseBranch
      ? `主工作区存在未提交改动，已通过隔离 worktree 安全更新 ${baseBranch} 引用并完整保留工作区文件`
      : `主工作区当前位于分支 ${state.headBranch ?? "detached HEAD"}，已通过隔离 worktree 安全合并更新 ${baseBranch}`;

  return {
    mergedSha,
    updatedMainInPlace: false,
    workingTreeNotice,
  };
}

function buildFindingsDetail(review: ReviewOutcome): string {
  if (review.findings.length === 0) {
    return review.summary;
  }
  const lines = review.findings.map((f, idx) => {
    const loc =
      f.file && !f.title.includes(f.file)
        ? `${f.file}${f.line ? `:${f.line}` : ""} `
        : "";
    const howSuffix =
      f.how && !f.text.includes(f.how) ? `（触发路径：${f.how}）` : "";
    return `${idx + 1}. [${f.severity ?? "blocking"}] ${loc}${f.title}: ${f.text}${howSuffix}`;
  });
  return truncateText(lines.join("\n"), 7_500);
}

function cancelledResult(
  step: DeliveryStep,
  snapshot?: BranchSnapshot,
  review?: ReviewOutcome,
): DeliveryPipelineResult {
  return {
    status: "cancelled",
    step,
    merged: false,
    outcome: "cancelled",
    summary: "交付流水线已取消",
    ...(snapshot ? { snapshot } : {}),
    ...(review ? { review } : {}),
    matchedSensitiveFiles: [],
    conflictedFiles: [],
    receipt: {},
    error: "Delivery pipeline cancelled",
  };
}

/**
 * Executes the 5-step isolated delivery pipeline on `targetRef` against `baseBranch`.
 */
export async function runDeliveryPipeline(
  options: DeliveryPipelineOptions,
): Promise<DeliveryPipelineResult> {
  const repoDir = path.resolve(expandHomePath(options.repoDir));
  const baseEnv = options.baseEnv ?? process.env;

  if (options.signal?.aborted) {
    return cancelledResult("review");
  }

  let ephemeralWorkDir: string | null = null;
  const resolvedWorkDir = options.workDir
    ? path.resolve(expandHomePath(options.workDir))
    : null;
  if (resolvedWorkDir) {
    mkdirSync(resolvedWorkDir, { recursive: true, mode: 0o700 });
  } else if (!options.outputDir || !options.ledgerFile) {
    ephemeralWorkDir = mkdtempSync(path.join(os.tmpdir(), "autoloop-deliv-"));
    chmodSync(ephemeralWorkDir, 0o700);
  }

  const outputDir = options.outputDir
    ? path.resolve(expandHomePath(options.outputDir))
    : path.join(resolvedWorkDir ?? ephemeralWorkDir!, "snapshot");
  const ledgerFile = options.ledgerFile
    ? path.resolve(expandHomePath(options.ledgerFile))
    : path.join(resolvedWorkDir ?? ephemeralWorkDir!, "review-ledger.json");
  const approvalsFile = options.approvalsFile
    ? path.resolve(expandHomePath(options.approvalsFile))
    : resolvedWorkDir
      ? path.join(resolvedWorkDir, "approvals.json")
      : undefined;

  try {
    // ── Step 1: Bare snapshot extraction + heterogeneous read-only review ──
    let previousReviewedSha: string | undefined;
    let hasPriorCodeBlocking: boolean | undefined;
    if (existsSync(ledgerFile)) {
      try {
        const priorLedger = readReviewLedger(ledgerFile);
        for (let i = priorLedger.entries.length - 1; i >= 0; i--) {
          const entry = priorLedger.entries[i]!;
          if (
            entry.targetRef === options.targetRef &&
            (!options.baseBranch || entry.baseBranch === options.baseBranch)
          ) {
            const priorBlocking = getEntryBlockingFindings(entry);
            if (priorBlocking.length > 0) {
              previousReviewedSha = entry.headSha;
              hasPriorCodeBlocking = hasCodeBlockingFindings(priorBlocking);
            }
            break;
          }
        }
      } catch {
        // Defer ledger validation error to reviewBranchSnapshot
      }
    }

    const snapshot = await extractBranchSnapshot({
      repoDir,
      targetRef: options.targetRef,
      baseBranch: options.baseBranch,
      outputDir,
      previousReviewedSha,
      hasPriorCodeBlocking,
    });

    if (options.signal?.aborted) {
      return cancelledResult("review", snapshot);
    }

    const decisions = collectKeyDecisions({
      approvedKeys: options.approvedKeys,
      rejectedKeys: options.rejectedKeys,
      answers: options.answers,
      decided: options.decided,
      approvalsFile,
      targetRef: snapshot.targetRef,
      headSha: snapshot.headSha,
    });

    let review: ReviewOutcome;
    try {
      review = await reviewBranchSnapshot({
        snapshot,
        ledgerFile,
        authorModel: options.authorModel,
        reviewerModelOverride: options.reviewerModelOverride,
        agyBin: options.agyBin,
        codexBin: options.codexBin,
        claudeBin: options.claudeBin,
        postResultGraceMs: options.postResultGraceMs,
        baseEnv,
        timeoutMs: options.reviewTimeoutMs,
        signal: options.signal,
      });
    } catch (err) {
      if (options.signal?.aborted) {
        return cancelledResult("review", snapshot);
      }
      throw err;
    }

    if (options.signal?.aborted) {
      return cancelledResult("review", snapshot, review);
    }

    const safeSubject = sanitizeEventSubject(snapshot.targetRef);

    if (review.status === "changes_requested") {
      const detail = buildFindingsDetail(review);
      const summary = singleLine(
        `异构审查发现阻塞项（第 ${review.round} 轮，${review.reviewerModel}），退回修改：${snapshot.targetRef}`,
      );
      const event: InboundEvent = {
        id: makeEventId(
          options.eventIdPrefix,
          "changes-requested",
          snapshot.targetRef,
          snapshot.headSha,
        ),
        type: "git.review.changes_requested",
        ...(safeSubject ? { subject: safeSubject } : {}),
        summary: truncateText(summary, 200),
        detail,
      };
      return {
        status: "changes_requested",
        step: "review",
        merged: false,
        outcome: "done",
        summary,
        snapshot,
        review,
        matchedSensitiveFiles: [],
        conflictedFiles: [],
        receipt: {
          events: [event],
          notice: [
            {
              key: `delivery-changes:${snapshot.targetRef}:${snapshot.headSha}`,
              title: `审查退回：${snapshot.targetRef}`,
              text: detail,
              fyi: true,
            },
          ],
        },
      };
    }

    if (review.status === "escalated_to_human") {
      const escKey = reviewEscalationCardKey(
        snapshot.targetRef,
        snapshot.headSha,
      );
      if (decisions.rejected.has(escKey)) {
        const summary = singleLine(
          `已按人工批示退回并搁置分支 ${snapshot.targetRef} (${snapshot.headSha.slice(0, 12)})`,
        );
        return {
          status: "rejected",
          step: "review",
          merged: false,
          outcome: "done",
          summary,
          snapshot,
          review,
          matchedSensitiveFiles: [],
          conflictedFiles: [],
          receipt: {
            events: [
              {
                id: makeEventId(
                  options.eventIdPrefix,
                  "review-rejected",
                  snapshot.targetRef,
                  snapshot.headSha,
                ),
                type: "git.review.changes_requested",
                ...(safeSubject ? { subject: safeSubject } : {}),
                summary: truncateText(summary, 200),
                detail: buildFindingsDetail(review),
              },
            ],
            notice: [
              {
                key: `delivery-rejected:${snapshot.targetRef}:${snapshot.headSha}`,
                title: `已搁置交付分支：${snapshot.targetRef}`,
                text: summary,
                fyi: true,
              },
            ],
          },
        };
      }

      if (!decisions.approved.has(escKey)) {
        const summary = singleLine(
          `异构审查达 ${review.round} 轮上限，已上呈奏折卡等待人工裁决：${snapshot.targetRef}`,
        );
        return {
          status: "awaiting_approval",
          step: "review",
          merged: false,
          outcome: "done",
          summary,
          snapshot,
          review,
          matchedSensitiveFiles: [],
          conflictedFiles: [],
          receipt: {
            ask: [
              {
                key: escKey,
                title: `【交付审查升级】${snapshot.targetRef} 需人工裁决`,
                text: [
                  `分支：${snapshot.targetRef} (${snapshot.headSha.slice(0, 12)}) -> ${snapshot.baseBranch}`,
                  `审查模型：${review.reviewerModel}（已累计第 ${review.round} 轮）`,
                  `审查结论：${review.summary}`,
                  "",
                  buildFindingsDetail(review),
                ].join("\n"),
                options: ["人工放行继续合并", "退回并搁置分支"],
                recommend: 1,
                about: `分支 ${snapshot.targetRef} 审查超过上限轮次，等待人工决定是否放行`,
              },
            ],
          },
        };
      }
    }

    // ── Step 2: Isolated temporary git worktree checkCommand ──
    let checkOutput = "";
    if (snapshot.config.checkCommand) {
      const checkRes = await withIsolatedWorktree(
        repoDir,
        snapshot.headSha,
        baseEnv,
        (wtDir) =>
          runShellCommand({
            cwd: wtDir,
            command: snapshot.config.checkCommand!,
            baseEnv,
            timeoutMs: options.checkTimeoutMs,
            signal: options.signal,
          }),
      );

      checkOutput = [checkRes.stdout.trim(), checkRes.stderr.trim()]
        .filter(Boolean)
        .join("\n");

      if (checkRes.cancelled || options.signal?.aborted) {
        return cancelledResult("check", snapshot, review);
      }

      if (checkRes.exitCode !== 0) {
        const reason =
          checkRes.error ?? `checkCommand 退出码 ${String(checkRes.exitCode)}`;
        const summary = singleLine(
          `隔离 worktree 门禁检查失败 (${reason})：${snapshot.targetRef}`,
        );
        const detail = truncateText(
          [
            `命令：${snapshot.config.checkCommand}`,
            `结果：${reason}`,
            checkOutput,
          ]
            .filter(Boolean)
            .join("\n\n"),
          7_500,
        );
        return {
          status: "check_failed",
          step: "check",
          merged: false,
          outcome: "done",
          summary,
          snapshot,
          review,
          matchedSensitiveFiles: [],
          conflictedFiles: [],
          checkOutput,
          receipt: {
            events: [
              {
                id: makeEventId(
                  options.eventIdPrefix,
                  "check-failed",
                  snapshot.targetRef,
                  snapshot.headSha,
                ),
                type: "git.delivery.check_failed",
                ...(safeSubject ? { subject: safeSubject } : {}),
                summary: truncateText(summary, 200),
                detail,
              },
            ],
            notice: [
              {
                key: `delivery-check-failed:${snapshot.targetRef}:${snapshot.headSha}`,
                title: `门禁检查未通过：${snapshot.targetRef}`,
                text: detail,
                fyi: true,
              },
            ],
          },
        };
      }
    }

    // ── Step 3: Base drift/conflict check & sensitivePaths human gate ──
    const mergeStrategy: MergeStrategy =
      snapshot.config.mergeStrategy ?? "merge";

    const drift = await checkMergeDriftAndConflicts({
      repoDir,
      baseBranch: snapshot.baseBranch,
      headSha: snapshot.headSha,
      mergeStrategy,
      baseEnv,
    });

    if (drift.hasConflict) {
      const summary = singleLine(
        drift.reason ?? `主干 ${snapshot.baseBranch} 漂移导致合并冲突`,
      );
      const detail = truncateText(
        [
          summary,
          drift.conflictedFiles.length > 0
            ? `冲突文件：\n${drift.conflictedFiles.map((f) => `- ${f}`).join("\n")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
        7_500,
      );
      return {
        status: "conflict",
        step: "gate",
        merged: false,
        outcome: "done",
        summary,
        snapshot,
        review,
        matchedSensitiveFiles: [],
        conflictedFiles: drift.conflictedFiles,
        checkOutput,
        mergeStrategy,
        receipt: {
          events: [
            {
              id: makeEventId(
                options.eventIdPrefix,
                "conflict",
                snapshot.targetRef,
                snapshot.headSha,
              ),
              type: "git.delivery.conflict",
              ...(safeSubject ? { subject: safeSubject } : {}),
              summary: truncateText(summary, 200),
              detail,
            },
          ],
          notice: [
            {
              key: `delivery-conflict:${snapshot.targetRef}:${snapshot.headSha}`,
              title: `合并冲突阻断：${snapshot.targetRef}`,
              text: detail,
              fyi: true,
            },
          ],
        },
      };
    }

    const sensitivePatterns = snapshot.config.sensitivePaths ?? [];
    const matchedSensitiveFiles =
      sensitivePatterns.length === 0
        ? []
        : snapshot.changedFiles.filter((filePath) =>
            sensitivePatterns.some((pattern) =>
              matchesSensitivePath(filePath, pattern),
            ),
          );

    if (matchedSensitiveFiles.length > 0) {
      const sensKey = sensitivePathsCardKey(
        snapshot.targetRef,
        snapshot.headSha,
      );

      if (decisions.rejected.has(sensKey)) {
        const summary = singleLine(
          `已按人工终审意见拒绝合并涉及敏感路径的分支 ${snapshot.targetRef}`,
        );
        return {
          status: "rejected",
          step: "gate",
          merged: false,
          outcome: "done",
          summary,
          snapshot,
          review,
          matchedSensitiveFiles,
          conflictedFiles: [],
          checkOutput,
          mergeStrategy,
          receipt: {
            events: [
              {
                id: makeEventId(
                  options.eventIdPrefix,
                  "sensitive-rejected",
                  snapshot.targetRef,
                  snapshot.headSha,
                ),
                type: "git.review.changes_requested",
                ...(safeSubject ? { subject: safeSubject } : {}),
                summary: truncateText(summary, 200),
                detail: `命中敏感路径：\n${matchedSensitiveFiles.map((f) => `- ${f}`).join("\n")}`,
              },
            ],
            notice: [
              {
                key: `delivery-sensitive-rejected:${snapshot.targetRef}:${snapshot.headSha}`,
                title: `敏感路径改动已退回：${snapshot.targetRef}`,
                text: summary,
                fyi: true,
              },
            ],
          },
        };
      }

      if (!decisions.approved.has(sensKey)) {
        const summary = singleLine(
          `分支 ${snapshot.targetRef} 命中 ${matchedSensitiveFiles.length} 个敏感路径，已发终审奏折卡等待批准`,
        );
        return {
          status: "awaiting_approval",
          step: "gate",
          merged: false,
          outcome: "done",
          summary,
          snapshot,
          review,
          matchedSensitiveFiles,
          conflictedFiles: [],
          checkOutput,
          mergeStrategy,
          receipt: {
            ask: [
              {
                key: sensKey,
                title: `【敏感路径终审】${snapshot.targetRef} 涉及受保护文件`,
                text: [
                  `待合入分支：${snapshot.targetRef} (${snapshot.headSha.slice(0, 12)}) -> ${snapshot.baseBranch}`,
                  `审查结论：${review.summary}（模型：${review.reviewerModel}）`,
                  `门禁检查：${snapshot.config.checkCommand ? "已通过" : "未配置"}`,
                  "",
                  "命中敏感路径文件：",
                  ...matchedSensitiveFiles.map((f) => `- ${f}`),
                  "",
                  `全部变更文件（共 ${snapshot.changedFiles.length} 个）：`,
                  ...snapshot.changedFiles.slice(0, 30).map((f) => `- ${f}`),
                ].join("\n"),
                options: ["批准合并敏感改动", "拒绝合并并退回"],
                recommend: 0,
                about: `分支 ${snapshot.targetRef} 改动命中 sensitivePaths，需人工确认后合入 ${snapshot.baseBranch}`,
              },
            ],
          },
        };
      }
    }

    if (options.signal?.aborted) {
      return cancelledResult("merge", snapshot, review);
    }

    // ── Step 4: Safe merge ──
    const mergeOut = await executeSafeMerge({
      repoDir,
      baseBranch: snapshot.baseBranch,
      targetRef: snapshot.targetRef,
      currentBaseSha: drift.currentBaseSha,
      headSha: snapshot.headSha,
      mergeStrategy,
      ghBin: options.ghBin,
      baseEnv,
      mergeTimeoutMs: options.mergeTimeoutMs,
      signal: options.signal,
    });

    // ── Step 5: Post-merge smoke verification ──
    let smokeOutput = "";
    if (snapshot.config.smokeCommand) {
      const smokeRes = mergeOut.updatedMainInPlace
        ? await runShellCommand({
            cwd: repoDir,
            command: snapshot.config.smokeCommand,
            baseEnv,
            timeoutMs: options.smokeTimeoutMs,
            signal: options.signal,
          })
        : await withIsolatedWorktree(
            repoDir,
            mergeOut.mergedSha,
            baseEnv,
            (wtDir) =>
              runShellCommand({
                cwd: wtDir,
                command: snapshot.config.smokeCommand!,
                baseEnv,
                timeoutMs: options.smokeTimeoutMs,
                signal: options.signal,
              }),
          );

      smokeOutput = [smokeRes.stdout.trim(), smokeRes.stderr.trim()]
        .filter(Boolean)
        .join("\n");

      if (smokeRes.cancelled || options.signal?.aborted) {
        return cancelledResult("smoke", snapshot, review);
      }

      if (smokeRes.exitCode !== 0) {
        const reason =
          smokeRes.error ?? `smokeCommand 退出码 ${String(smokeRes.exitCode)}`;
        const summary = singleLine(
          `分支 ${snapshot.targetRef} 已合并至 ${snapshot.baseBranch} (${mergeOut.mergedSha.slice(0, 12)})，但合并后冒烟验证失败 (${reason})`,
        );
        const detail = truncateText(
          [
            `合并提交：${mergeOut.mergedSha}`,
            `冒烟命令：${snapshot.config.smokeCommand}`,
            `失败原因：${reason}`,
            smokeOutput,
          ]
            .filter(Boolean)
            .join("\n\n"),
          7_500,
        );
        return {
          status: "smoke_failed",
          step: "smoke",
          merged: true,
          outcome: "done",
          summary,
          snapshot,
          review,
          matchedSensitiveFiles,
          conflictedFiles: [],
          checkOutput,
          smokeOutput,
          mergeStrategy,
          mergedSha: mergeOut.mergedSha,
          ...(mergeOut.workingTreeNotice
            ? { workingTreeNotice: mergeOut.workingTreeNotice }
            : {}),
          receipt: {
            events: [
              {
                id: makeEventId(
                  options.eventIdPrefix,
                  "smoke-failed",
                  snapshot.targetRef,
                  mergeOut.mergedSha,
                ),
                type: "git.delivery.smoke_failed",
                ...(safeSubject ? { subject: safeSubject } : {}),
                summary: truncateText(summary, 200),
                detail,
              },
            ],
            notice: [
              {
                key: `delivery-smoke-failed:${snapshot.targetRef}:${mergeOut.mergedSha}`,
                title: `【冒烟告警】${snapshot.targetRef} 合并后验证失败`,
                text: detail,
                fyi: false,
              },
            ],
          },
        };
      }
    }

    const summary = singleLine(
      `交付完成：${snapshot.targetRef} 已通过 ${mergeStrategy} 合入 ${snapshot.baseBranch} (${mergeOut.mergedSha.slice(0, 12)})`,
    );
    const noticeLines = [
      `分支：${snapshot.targetRef} (${snapshot.headSha.slice(0, 12)}) -> ${snapshot.baseBranch} (${mergeOut.mergedSha.slice(0, 12)})`,
      `合并策略：${mergeStrategy}`,
      `异构审查：${review.summary}（模型：${review.reviewerModel}）`,
      `门禁检查：${snapshot.config.checkCommand ? "已通过" : "未配置"}`,
      `冒烟验证：${snapshot.config.smokeCommand ? "已通过" : "未配置"}`,
    ];
    if (mergeOut.workingTreeNotice) {
      noticeLines.push(`工作区提示：${mergeOut.workingTreeNotice}`);
    }

    return {
      status: "merged",
      step: "smoke",
      merged: true,
      outcome: "done",
      summary,
      snapshot,
      review,
      matchedSensitiveFiles,
      conflictedFiles: [],
      checkOutput,
      smokeOutput,
      mergeStrategy,
      mergedSha: mergeOut.mergedSha,
      ...(mergeOut.workingTreeNotice
        ? { workingTreeNotice: mergeOut.workingTreeNotice }
        : {}),
      receipt: {
        notice: [
          {
            key: `delivery-merged:${snapshot.targetRef}:${mergeOut.mergedSha}`,
            title: `交付完成：${snapshot.targetRef} 已合入 ${snapshot.baseBranch}`,
            text: noticeLines.join("\n"),
            fyi: true,
          },
        ],
      },
    };
  } finally {
    if (ephemeralWorkDir) {
      try {
        rmSync(ephemeralWorkDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
    }
  }
}

function readRunnerContextFile(contextFile: string): {
  events: JobEventContext[];
  answers: JobAnswerContext[];
  decided: JobDecidedCardContext[];
} | null {
  try {
    const raw = readFileSync(contextFile, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) {
      return null;
    }
    const ctxObj = isPlainObject(parsed.context) ? parsed.context : parsed;
    return {
      events: Array.isArray(ctxObj.events)
        ? (ctxObj.events as JobEventContext[])
        : [],
      answers: Array.isArray(ctxObj.answers)
        ? (ctxObj.answers as JobAnswerContext[])
        : [],
      decided: Array.isArray(ctxObj.decided)
        ? (ctxObj.decided as JobDecidedCardContext[])
        : [],
    };
  } catch {
    return null;
  }
}

function extractAuthorModelHint(
  events: readonly JobEventContext[],
): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i] as unknown as Record<string, unknown>;
    if (
      typeof ev.authorModel === "string" &&
      SAFE_MODEL_ID_RE.test(ev.authorModel.trim())
    ) {
      return ev.authorModel.trim();
    }
    if (typeof ev.detail === "string" && ev.detail.trim().startsWith("{")) {
      try {
        const parsed: unknown = JSON.parse(ev.detail);
        if (
          isPlainObject(parsed) &&
          typeof parsed.authorModel === "string" &&
          SAFE_MODEL_ID_RE.test(parsed.authorModel.trim())
        ) {
          return parsed.authorModel.trim();
        }
      } catch {
        // Ignore non-JSON event detail
      }
    }
  }
  return undefined;
}

function extractTargetRefFromEvents(
  events: readonly JobEventContext[],
): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const subject = events[i]?.subject;
    if (typeof subject === "string" && subject.trim().length > 0) {
      return subject.trim();
    }
  }
  return undefined;
}

const DELIVERY_CARD_KEY_RE =
  /^delivery:(?:review|sensitive):(.+):([0-9a-f]{40,64})$/;

function extractTargetRefFromCards(
  answers: readonly JobAnswerContext[],
  decided: readonly JobDecidedCardContext[],
): string | undefined {
  for (let i = answers.length - 1; i >= 0; i--) {
    const m = DELIVERY_CARD_KEY_RE.exec(answers[i]?.key ?? "");
    if (m && m[1]) {
      return m[1];
    }
  }
  for (let i = decided.length - 1; i >= 0; i--) {
    const m = DELIVERY_CARD_KEY_RE.exec(decided[i]?.key ?? "");
    if (m && m[1]) {
      return m[1];
    }
  }
  return undefined;
}

function resolveRunnerDeliveryPaths(
  contextFile: string,
  defaults?: DeliveryRunnerDefaults,
): {
  outputDir: string;
  ledgerFile: string;
  approvalsFile: string;
} {
  const runDir = path.dirname(path.resolve(expandHomePath(contextFile)));
  const outputDir = path.join(runDir, "delivery-snapshot");

  if (defaults?.ledgerFile) {
    const ledgerFile = path.resolve(expandHomePath(defaults.ledgerFile));
    const approvalsFile = defaults.approvalsFile
      ? path.resolve(expandHomePath(defaults.approvalsFile))
      : path.join(path.dirname(ledgerFile), "approvals.json");
    return { outputDir, ledgerFile, approvalsFile };
  }

  if (defaults?.workDir) {
    const workDir = path.resolve(expandHomePath(defaults.workDir));
    return {
      outputDir,
      ledgerFile: path.join(workDir, "review-ledger.json"),
      approvalsFile: defaults.approvalsFile
        ? path.resolve(expandHomePath(defaults.approvalsFile))
        : path.join(workDir, "approvals.json"),
    };
  }

  const runsDir = path.dirname(runDir);
  const deliveryStateDir =
    path.basename(runsDir) === "runs"
      ? path.join(path.dirname(runsDir), "delivery")
      : path.join(runDir, "delivery");

  return {
    outputDir,
    ledgerFile: path.join(deliveryStateDir, "review-ledger.json"),
    approvalsFile: defaults?.approvalsFile
      ? path.resolve(expandHomePath(defaults.approvalsFile))
      : path.join(deliveryStateDir, "approvals.json"),
  };
}

function hasReceiptContent(receipt: Receipt): boolean {
  return Boolean(
    (receipt.ask && receipt.ask.length > 0) ||
    (receipt.notice && receipt.notice.length > 0) ||
    (receipt.resolve && receipt.resolve.length > 0) ||
    (receipt.later && receipt.later.length > 0) ||
    (receipt.events && receipt.events.length > 0),
  );
}

function encodeDeliveryExecution(
  summary: string,
  outcome: RunnerExecution["outcome"],
  receipt: Receipt,
  error?: string,
): RunnerExecution {
  const safeSummary = singleLine(summary);
  const rawText = hasReceiptContent(receipt)
    ? `${safeSummary}\n\n\`\`\`agent-autoloop\n${JSON.stringify(receipt)}\n\`\`\``
    : safeSummary;
  const parsed = readMessage(rawText);

  if (parsed.problem !== null) {
    const errMsg = `Delivery receipt encoding error: ${parsed.problem}`;
    const errText = `没跑成：${errMsg}`;
    return {
      outcome: "failed",
      summary: errMsg,
      rawText: errText,
      parsed: readMessage(errText),
      session: null,
      started: true,
      error: errMsg,
      exitCode: 1,
    };
  }

  return {
    outcome,
    summary: safeSummary,
    rawText,
    parsed,
    session: null,
    started: true,
    ...(error !== undefined ? { error } : {}),
    exitCode: outcome === "failed" ? 1 : 0,
  };
}

/**
 * Creates a `CustomRunnerHandler` compatible with `SupervisorOptions.deliveryRunner`.
 */
export function createDeliveryRunner(
  defaults: DeliveryRunnerDefaults = {},
): CustomRunnerHandler {
  return async (ctx) => {
    if (ctx.signal.aborted) {
      const cancelText = "没跑成：交付流水线在启动前已取消";
      return {
        outcome: "cancelled",
        summary: "交付流水线在启动前已取消",
        rawText: cancelText,
        parsed: readMessage(cancelText),
        session: null,
        started: false,
        error: "Cancelled by AbortSignal before start",
        exitCode: null,
      };
    }

    ctx.onStarted({ session: null });

    const fileCtx = readRunnerContextFile(ctx.contextFile);
    const events =
      fileCtx && fileCtx.events.length > 0
        ? fileCtx.events
        : ctx.job.context.events;
    const answers =
      fileCtx && fileCtx.answers.length > 0
        ? fileCtx.answers
        : ctx.job.context.answers;
    const decided =
      fileCtx && fileCtx.decided.length > 0
        ? fileCtx.decided
        : ctx.job.context.decided;

    const targetRef =
      extractTargetRefFromEvents(events) ??
      extractTargetRefFromCards(answers, decided);
    if (!targetRef) {
      const errMsg = "触发事件缺少 subject（待审分支名），无法启动交付流水线";
      return encodeDeliveryExecution(`没跑成：${errMsg}`, "failed", {}, errMsg);
    }

    const repoDir = defaults.repoDir ?? ctx.job.rule.cwd;
    const paths = resolveRunnerDeliveryPaths(ctx.contextFile, defaults);
    let authorModel = defaults.authorModel ?? extractAuthorModelHint(events);
    if (!authorModel && existsSync(paths.ledgerFile)) {
      try {
        const existingLedger = readReviewLedger(paths.ledgerFile);
        for (let i = existingLedger.entries.length - 1; i >= 0; i--) {
          const entry = existingLedger.entries[i]!;
          if (entry.targetRef === targetRef && entry.authorModel) {
            authorModel = entry.authorModel;
            break;
          }
        }
      } catch {
        // Defer ledger validation error to runDeliveryPipeline
      }
    }
    const runTimeoutMs =
      ctx.job.agent.timeoutMinutes !== undefined
        ? ctx.job.agent.timeoutMinutes * 60_000
        : undefined;

    try {
      const result = await runDeliveryPipeline({
        repoDir,
        targetRef,
        baseBranch: defaults.baseBranch,
        workDir: path.dirname(paths.ledgerFile),
        outputDir: paths.outputDir,
        ledgerFile: paths.ledgerFile,
        approvalsFile: paths.approvalsFile,
        authorModel,
        reviewerModelOverride: defaults.reviewerModelOverride,
        agyBin: defaults.agyBin,
        codexBin: defaults.codexBin,
        claudeBin: defaults.claudeBin,
        ghBin: defaults.ghBin,
        postResultGraceMs: defaults.postResultGraceMs,
        baseEnv: ctx.baseEnv,
        reviewTimeoutMs: defaults.reviewTimeoutMs ?? runTimeoutMs,
        checkTimeoutMs: defaults.checkTimeoutMs ?? runTimeoutMs,
        smokeTimeoutMs: defaults.smokeTimeoutMs ?? runTimeoutMs,
        mergeTimeoutMs: defaults.mergeTimeoutMs ?? runTimeoutMs,
        answers,
        decided,
        signal: ctx.signal,
        eventIdPrefix: `run${ctx.job.run}-a${ctx.job.attempt}`,
      });

      if (result.outcome === "cancelled") {
        return {
          outcome: "cancelled",
          summary: result.summary,
          rawText: result.summary,
          parsed: readMessage(result.summary),
          session: null,
          started: true,
          error: result.error ?? "Delivery pipeline cancelled",
          exitCode: null,
        };
      }

      return encodeDeliveryExecution(
        result.summary,
        result.outcome,
        result.receipt,
        result.error,
      );
    } catch (err) {
      if (ctx.signal.aborted) {
        return {
          outcome: "cancelled",
          summary: "交付流水线已取消",
          rawText: "交付流水线已取消",
          parsed: readMessage("交付流水线已取消"),
          session: null,
          started: true,
          error: "Cancelled by AbortSignal",
          exitCode: null,
        };
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      return encodeDeliveryExecution(`没跑成：${errMsg}`, "failed", {}, errMsg);
    }
  };
}
