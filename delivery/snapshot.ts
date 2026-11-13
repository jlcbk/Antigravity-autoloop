/**
 * Bare Git snapshot extractor for untrusted branch review.
 * Reads `.autoloop/delivery.json` and `AGENTS.md` exclusively from the trusted
 * base branch via `git show`, never checks out the target branch, and writes
 * `diff.patch` atomically with `0o600` permissions.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { expandHomePath } from "../engine/context-file.ts";
import { isPlainObject } from "../protocol/validate.ts";

export type MergeStrategy = "ff-only" | "merge" | "squash" | "gh-pr";

export interface DeliveryConfig {
  baseBranch: string;
  checkCommand?: string;
  smokeCommand?: string;
  mergeStrategy?: MergeStrategy;
  sensitivePaths?: string[];
  maxReviewRounds?: number;
  reviewerModels?: Record<string, string>;
}

export interface BranchSnapshot {
  repoDir: string;
  baseBranch: string;
  targetRef: string;
  baseSha: string;
  headSha: string;
  mergeBaseSha: string;
  changedFiles: string[];
  diffFile: string;
  diffStat: string;
  reviewNotes: string;
  config: DeliveryConfig;
}

export interface ExtractBranchSnapshotOptions {
  repoDir: string;
  targetRef: string;
  baseBranch?: string;
  outputDir: string;
}

const VALID_MERGE_STRATEGIES = new Set<MergeStrategy>([
  "ff-only",
  "merge",
  "squash",
  "gh-pr",
]);
const DEFAULT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const DIFF_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const MAX_REVIEW_NOTES_CHARS = 16_000;
// eslint-disable-next-line no-control-regex
const UNSAFE_REF_CHAR_RE = /[\x00-\x1f\x7f\s]/;
const REVIEW_HEADING_RE = /(?:审查|review)/i;
const MARKDOWN_HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

function assertSafeGitRef(ref: string, label: string): string {
  if (typeof ref !== "string" || ref.length === 0) {
    throw new Error(`${label} must be a non-empty Git ref`);
  }
  if (ref.startsWith("-")) {
    throw new Error(`${label} must not start with "-"`);
  }
  if (
    UNSAFE_REF_CHAR_RE.test(ref) ||
    ref.includes("..") ||
    ref.includes(":") ||
    ref.includes("@{") ||
    ref.includes("\\")
  ) {
    throw new Error(`${label} contains unsafe characters: ${ref}`);
  }
  return ref;
}

function runGit(
  repoDir: string,
  args: string[],
  maxBuffer = DEFAULT_MAX_BUFFER_BYTES,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd: repoDir,
        shell: false,
        encoding: "utf8",
        maxBuffer,
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
      (err, stdout, stderr) => {
        if (err) {
          const detail = stderr.trim() || err.message;
          reject(new Error(`git ${args.join(" ")} failed: ${detail}`));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

async function detectDefaultBaseBranch(repoDir: string): Promise<string> {
  for (const candidate of ["main", "master"]) {
    try {
      await runGit(repoDir, ["rev-parse", "--verify", `${candidate}^{commit}`]);
      return candidate;
    } catch {
      // Try next candidate
    }
  }
  try {
    const { stdout } = await runGit(repoDir, [
      "symbolic-ref",
      "--short",
      "HEAD",
    ]);
    const current = stdout.trim();
    if (current.length > 0) {
      return assertSafeGitRef(current, "baseBranch");
    }
  } catch {
    // Fallback to "main" so caller gets a clear ref-resolution error
  }
  return "main";
}

async function readTrustedBlob(
  repoDir: string,
  baseBranch: string,
  repoPath: string,
): Promise<string | null> {
  const { stdout: treeLine } = await runGit(repoDir, [
    "ls-tree",
    baseBranch,
    "--",
    repoPath,
  ]);
  const trimmedTree = treeLine.trim();
  if (trimmedTree.length === 0) {
    return null;
  }
  const match = /^(\d{6})\s+(\w+)\s+[0-9a-f]+\t/.exec(trimmedTree);
  if (!match || match[2] !== "blob" || match[1] === "120000") {
    return null;
  }

  const { stdout } = await runGit(repoDir, [
    "show",
    `${baseBranch}:${repoPath}`,
  ]);
  return stdout;
}

function parseOptionalNonEmptyString(
  value: unknown,
  label: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function parseDeliveryConfig(
  rawText: string | null,
  fallbackBaseBranch: string,
): DeliveryConfig {
  if (rawText === null) {
    return { baseBranch: fallbackBaseBranch };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid .autoloop/delivery.json on base branch: ${msg}`);
  }

  if (!isPlainObject(parsed)) {
    throw new Error(".autoloop/delivery.json must be a JSON object");
  }

  const baseBranchRaw = parseOptionalNonEmptyString(
    parsed.baseBranch,
    "delivery.baseBranch",
  );
  const config: DeliveryConfig = {
    baseBranch: baseBranchRaw
      ? assertSafeGitRef(baseBranchRaw, "delivery.baseBranch")
      : fallbackBaseBranch,
  };

  const checkCommand = parseOptionalNonEmptyString(
    parsed.checkCommand,
    "delivery.checkCommand",
  );
  if (checkCommand !== undefined) {
    config.checkCommand = checkCommand;
  }

  const smokeCommand = parseOptionalNonEmptyString(
    parsed.smokeCommand,
    "delivery.smokeCommand",
  );
  if (smokeCommand !== undefined) {
    config.smokeCommand = smokeCommand;
  }

  if (parsed.mergeStrategy !== undefined) {
    if (
      typeof parsed.mergeStrategy !== "string" ||
      !VALID_MERGE_STRATEGIES.has(parsed.mergeStrategy as MergeStrategy)
    ) {
      throw new Error(
        'delivery.mergeStrategy must be one of "ff-only", "merge", "squash", "gh-pr"',
      );
    }
    config.mergeStrategy = parsed.mergeStrategy as MergeStrategy;
  }

  if (parsed.sensitivePaths !== undefined) {
    if (!Array.isArray(parsed.sensitivePaths)) {
      throw new Error("delivery.sensitivePaths must be an array of strings");
    }
    config.sensitivePaths = parsed.sensitivePaths.map((entry, idx) => {
      if (typeof entry !== "string" || entry.trim().length === 0) {
        throw new Error(
          `delivery.sensitivePaths[${idx}] must be a non-empty string`,
        );
      }
      return entry.trim();
    });
  }

  if (parsed.maxReviewRounds !== undefined) {
    if (
      typeof parsed.maxReviewRounds !== "number" ||
      !Number.isSafeInteger(parsed.maxReviewRounds) ||
      parsed.maxReviewRounds < 1
    ) {
      throw new Error(
        "delivery.maxReviewRounds must be a positive safe integer",
      );
    }
    config.maxReviewRounds = parsed.maxReviewRounds;
  }

  if (parsed.reviewerModels !== undefined) {
    if (!isPlainObject(parsed.reviewerModels)) {
      throw new Error("delivery.reviewerModels must be an object map");
    }
    const models: Record<string, string> = {};
    for (const [key, val] of Object.entries(parsed.reviewerModels)) {
      if (key.trim().length === 0) {
        throw new Error("delivery.reviewerModels keys must be non-empty");
      }
      if (typeof val !== "string" || val.trim().length === 0) {
        throw new Error(
          `delivery.reviewerModels["${key}"] must be a non-empty string`,
        );
      }
      models[key] = val.trim();
    }
    config.reviewerModels = models;
  }

  return config;
}

/**
 * Extracts review-specific sections (e.g., `## 审查要点`, `## 审查必查清单`, `## Review Notes`)
 * from trusted `AGENTS.md`, falling back to the full document if no dedicated review heading exists.
 */
export function extractReviewNotes(agentsMd: string): string {
  const trimmed = agentsMd.replace(/\r\n/g, "\n").trim();
  if (trimmed.length === 0) {
    return "";
  }

  const lines = trimmed.split("\n");
  const sections: string[] = [];
  let activeLevel = 0;
  let current: string[] = [];

  for (const line of lines) {
    const heading = MARKDOWN_HEADING_RE.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const title = heading[2]!;
      if (activeLevel > 0 && level <= activeLevel) {
        sections.push(current.join("\n").trim());
        activeLevel = 0;
        current = [];
      }
      if (activeLevel === 0 && REVIEW_HEADING_RE.test(title)) {
        activeLevel = level;
        current = [line];
        continue;
      }
    }
    if (activeLevel > 0) {
      current.push(line);
    }
  }

  if (activeLevel > 0 && current.length > 0) {
    sections.push(current.join("\n").trim());
  }

  const extracted =
    sections.length > 0 ? sections.filter(Boolean).join("\n\n") : trimmed;
  if (extracted.length <= MAX_REVIEW_NOTES_CHARS) {
    return extracted;
  }
  return `${extracted.slice(0, MAX_REVIEW_NOTES_CHARS)}\n...(truncated)`;
}

/**
 * Atomically writes sensitive text to `filePath` with strict `0o600` permissions.
 */
export function atomicWritePrivateText(
  filePath: string,
  content: string,
): void {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const base = path.basename(filePath);
  const tmpPath = path.join(
    dir,
    `.${base}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    writeFileSync(tmpPath, content, { encoding: "utf8", mode: 0o600 });
    chmodSync(tmpPath, 0o600);
    renameSync(tmpPath, filePath);
    chmodSync(filePath, 0o600);
  } catch (err) {
    try {
      if (existsSync(tmpPath)) {
        rmSync(tmpPath, { force: true });
      }
    } catch {
      // Best-effort temp cleanup
    }
    throw err;
  }
}

/**
 * Extracts a bare Git object-store snapshot for `targetRef` against `baseBranch`.
 * Never checks out `targetRef` and never reads configuration or instructions from `targetRef`
 * or the working tree.
 */
export async function extractBranchSnapshot(
  options: ExtractBranchSnapshotOptions,
): Promise<BranchSnapshot> {
  const repoDir = path.resolve(expandHomePath(options.repoDir));
  const outputDir = path.resolve(expandHomePath(options.outputDir));

  let repoStat;
  try {
    repoStat = statSync(repoDir);
  } catch {
    throw new Error(`Repository directory does not exist: ${repoDir}`);
  }
  if (!repoStat.isDirectory()) {
    throw new Error(`Repository path is not a directory: ${repoDir}`);
  }

  const targetRef = assertSafeGitRef(options.targetRef, "targetRef");
  const baseBranch =
    options.baseBranch !== undefined
      ? assertSafeGitRef(options.baseBranch, "baseBranch")
      : await detectDefaultBaseBranch(repoDir);

  const { stdout: baseShaRaw } = await runGit(repoDir, [
    "rev-parse",
    "--verify",
    `${baseBranch}^{commit}`,
  ]);
  const baseSha = baseShaRaw.trim();

  const { stdout: headShaRaw } = await runGit(repoDir, [
    "rev-parse",
    "--verify",
    `${targetRef}^{commit}`,
  ]);
  const headSha = headShaRaw.trim();

  let mergeBaseSha: string;
  try {
    const { stdout: mbRaw } = await runGit(repoDir, [
      "merge-base",
      baseSha,
      headSha,
    ]);
    mergeBaseSha = mbRaw.trim();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to compute merge-base between ${baseBranch} and ${targetRef}: ${detail}`,
    );
  }

  // Read delivery config and review notes exclusively from the trusted base branch blob objects.
  const deliveryJsonRaw = await readTrustedBlob(
    repoDir,
    baseBranch,
    ".autoloop/delivery.json",
  );
  const config = parseDeliveryConfig(deliveryJsonRaw, baseBranch);

  const agentsMdRaw = await readTrustedBlob(repoDir, baseBranch, "AGENTS.md");
  const reviewNotes = extractReviewNotes(agentsMdRaw ?? "");

  const range = `${mergeBaseSha}..${headSha}`;
  const { stdout: changedRaw } = await runGit(repoDir, [
    "-c",
    "core.quotePath=false",
    "diff",
    "--name-only",
    range,
  ]);
  const changedFiles = changedRaw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const { stdout: statRaw } = await runGit(repoDir, [
    "-c",
    "core.quotePath=false",
    "diff",
    "--stat",
    "--no-ext-diff",
    range,
  ]);
  const diffStat = statRaw.trimEnd();

  const { stdout: diffPatch } = await runGit(
    repoDir,
    ["-c", "core.quotePath=false", "diff", "--no-ext-diff", "--binary", range],
    DIFF_MAX_BUFFER_BYTES,
  );

  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const diffFile = path.join(outputDir, "diff.patch");
  atomicWritePrivateText(diffFile, diffPatch);

  return {
    repoDir,
    baseBranch,
    targetRef,
    baseSha,
    headSha,
    mergeBaseSha,
    changedFiles,
    diffFile,
    diffStat,
    reviewNotes,
    config,
  };
}
