/**
 * Universal Standard ACP (`Agent Client Protocol`) Stdio JSON-RPC 2.0 Runner (`runner === "acp"`).
 *
 * Compatible with `opencode acp`, `gemini --experimental-acp`, `qwen --acp`,
 * `goose acp`, `kimi acp`, `auggie --acp`, and any compliant ACP stdio server.
 *
 * Enforces:
 * - Zero runtime dependencies (Node >= 24 built-ins only) and `shell: false` process-group isolation.
 * - Sanitized environment (`sanitizeRunnerEnv`) + deterministic `PATH` head supplementation.
 * - Dual-framing inbound JSON-RPC 2.0 parser (newline-delimited JSONL + `Content-Length` byte framing).
 * - Session resumption (`session/load`) with pre-prompt `started: false` fallback for stale sessions.
 * - Protocol-level security hard gate on `session/request_permission`, `fs/read_text_file`,
 *   and `fs/write_text_file` (`guard.json` fail-closed, `access` tier, `askFirst`/`approvedKeys`,
 *   sub-shell & inline-script inspection, and control-plane secret/DB/config self-protection).
 */

import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { InputError } from "../kernel/errors.ts";
import { promptFor, readMessage } from "../protocol/receipt.ts";
import type {
  AccessTier,
  Job,
  ParsedMessage,
  RunUsage,
} from "../protocol/types.ts";
import { type RunnerExecution, sanitizeRunnerEnv } from "./agy-runner.ts";

export type { RunnerExecution };

export interface RunAcpOptions {
  job: Job;
  contextFile: string;
  guardFile: string;
  promptOverride?: string;
  baseEnv?: NodeJS.ProcessEnv;
  killGraceMs?: number;
  postResultGraceMs?: number;
  onStarted?: (info: { session: string | null; pid?: number }) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MINUTES = 60;
const DEFAULT_KILL_GRACE_MS = 500;
const DEFAULT_POST_RESULT_GRACE_MS = 5_000;
const MAX_POST_RESULT_GRACE_MS = 30_000;
const MAX_STDERR_CHARS = 8_000;
const MAX_SUBSHELL_DEPTH = 5;

const GUARD_CORRUPT_DENY_REASON =
  "Autoloop guard.json missing or unreadable; rejecting by fail-closed security policy.";
const READ_ONLY_DENY_REASON =
  "Autoloop rule runs in read-only mode (access=read); file mutations and write commands are forbidden.";
const ASK_FIRST_DENY_REASON =
  "Operation hits Autoloop askFirst / catastrophic safety boundary without approval in approvedKeys.";
const CONTROL_PLANE_DENY_REASON =
  "Operation touches protected Autoloop control-plane secrets, database, or configuration files.";
const GLOBAL_CONFIG_DENY_REASON =
  "Modifying global ~/.gemini/config/config.json is forbidden.";

const NO_ACCESS_CONTROL_FILES = [
  "owner.token",
  "ingest.token",
  "master.key",
  "ipc.json",
];

const DB_CONTROL_FILES = ["hub.db", "hub.db-wal", "hub.db-shm"];
const TEXT_READONLY_CONTROL_FILES = ["rules.json"];

const WRITE_TOOL_NAMES = new Set([
  "write_file",
  "edit_file",
  "delete_file",
  "create_file",
  "write_to_file",
  "replace_file_content",
  "multi_replace_file_content",
  "apply_patch",
  "notebook_edit",
  "remove_file",
  "rename_file",
  "move_file",
  "fs/write_text_file",
  "write",
  "edit",
  "patch",
  "multiedit",
]);

const DELETE_TOOL_NAMES = new Set([
  "delete_file",
  "remove_file",
  "delete",
  "rm",
]);

const SEARCH_DIR_TOOL_NAMES = new Set([
  "grep_search",
  "grep",
  "ripgrep",
  "search_files",
  "glob",
]);

const FILE_ARG_KEYS = new Set([
  "targetfile",
  "absolutepath",
  "path",
  "filepath",
  "file_path",
  "file",
  "uri",
  "searchpath",
  "directorypath",
  "searchdirectory",
  "directory",
  "dir",
  "paths",
  "files",
  "source",
  "destination",
  "dest",
  "to",
  "from",
]);

const SHELL_NAMES = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash"]);
const NODE_INTERPRETERS = new Set(["node", "nodejs", "bun", "deno"]);
const PYTHON_INTERPRETER_RE = /^python(?:\d+(?:\.\d+)?)?$/;
const OTHER_INLINE_INTERPRETERS = new Set(["ruby", "perl", "php"]);

const ENV_OPTS_WITH_ARG = new Set([
  "-u",
  "--unset",
  "-C",
  "--chdir",
  "-S",
  "--split-string",
  "-P",
  "--altpath",
]);

const SUDO_OPTS_WITH_ARG = new Set([
  "-u",
  "--user",
  "-g",
  "--group",
  "-C",
  "--close-from",
  "-D",
  "--chdir",
  "-R",
  "--chroot",
  "-T",
  "--command-timeout",
  "-h",
  "--host",
  "-p",
  "--prompt",
  "-r",
  "--role",
  "-t",
  "--type",
  "-U",
  "--other-user",
]);

const SUDO_BOOLEAN_SHORT_FLAGS = new Set([
  "A",
  "b",
  "E",
  "e",
  "H",
  "i",
  "k",
  "K",
  "l",
  "n",
  "P",
  "S",
  "s",
  "V",
  "v",
]);

const GIT_GLOBAL_OPTS_WITH_ARG = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--exec-path",
  "--config-env",
  "--list-cmds",
]);

const TEXT_VIEWER_COMMANDS = new Set([
  "cat",
  "head",
  "tail",
  "ls",
  "stat",
  "grep",
  "rg",
  "jq",
  "wc",
  "file",
  "less",
  "more",
  "nl",
  "egrep",
  "fgrep",
  "yq",
  "diff",
  "cmp",
  "comm",
  "cut",
  "tr",
  "fold",
  "fmt",
  "column",
  "od",
  "hexdump",
  "xxd",
  "shasum",
  "sha256sum",
  "sha1sum",
  "md5",
  "md5sum",
  "cksum",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "test",
  "[",
]);

const READONLY_GIT_SUBCOMMANDS = new Set([
  "status",
  "diff",
  "log",
  "show",
  "rev-parse",
  "ls-files",
  "ls-tree",
  "cat-file",
  "grep",
  "blame",
  "shortlog",
  "describe",
  "for-each-ref",
  "merge-base",
  "check-ignore",
  "check-attr",
  "name-rev",
  "verify-commit",
  "verify-tag",
]);

const MUTATING_COMMANDS = new Set([
  "rm",
  "rmdir",
  "unlink",
  "mv",
  "cp",
  "touch",
  "mkdir",
  "truncate",
  "dd",
  "chmod",
  "chown",
  "ln",
  "tee",
  "install",
  "shred",
  "patch",
]);

const MUTATING_GIT_SUBCOMMANDS = new Set([
  "add",
  "commit",
  "push",
  "reset",
  "clean",
  "rm",
  "mv",
  "checkout",
  "switch",
  "merge",
  "rebase",
  "cherry-pick",
  "apply",
  "am",
  "stash",
  "tag",
]);

interface HighRiskCategory {
  id: string;
  aliases: string[];
  patternMatches: RegExp[];
}

const HIGH_RISK_CATEGORIES: readonly HighRiskCategory[] = [
  {
    id: "rm-rf",
    aliases: ["rm-rf", "rm", "delete-files", "delete-file", "删除文件", "删除"],
    patternMatches: [
      /\brm\b/i,
      /\b删除文件\b/,
      /\bdelete\b/i,
      /\bunlink\b/i,
      /\brmdir\b/i,
    ],
  },
  {
    id: "git-push-force",
    aliases: [
      "git-push-force",
      "git-push",
      "force-push",
      "push-force",
      "强制推送",
    ],
    patternMatches: [/git\s+push/i, /force[\s_-]*push/i, /强制推送/],
  },
  {
    id: "git-reset-hard",
    aliases: ["git-reset-hard", "reset-hard", "git-reset", "强制重置"],
    patternMatches: [/git\s+reset/i, /reset[\s_-]*hard/i],
  },
  {
    id: "drop-db",
    aliases: [
      "drop-table",
      "drop-database",
      "drop-db",
      "删除数据库",
      "数据库删除",
      "删除生产数据",
    ],
    patternMatches: [
      /\bdrop\s+(?:table|database|schema)\b/i,
      /\btruncate\s+table\b/i,
      /删除数据库/,
      /数据库删除/,
      /删除生产数据/,
    ],
  },
];

class AcpRpcError extends Error {
  code: number;
  data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "AcpRpcError";
    this.code = code;
    this.data = data;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function failedParsed(summary: string): ParsedMessage {
  return {
    outcome: "failed",
    summary,
    receipt: null,
    problem: null,
  };
}

function expandHomeDir(rawPath: string, homeDir: string): string {
  if (rawPath === "~") {
    return homeDir;
  }
  if (rawPath.startsWith("~/")) {
    return path.join(homeDir, rawPath.slice(2));
  }
  return rawPath;
}

function stripFileUri(raw: string): string {
  if (raw.startsWith("file://")) {
    try {
      const url = new URL(raw);
      return decodeURIComponent(url.pathname);
    } catch {
      return raw.slice("file://".length);
    }
  }
  return raw;
}

function supplementAcpPath(
  currentPath: string | undefined,
  homeDir: string,
): string {
  const headEntries = [
    path.join(homeDir, ".opencode", "bin"),
    path.join(homeDir, ".local", "bin"),
    path.join(homeDir, ".local", "lib", "node-v24.19.0-darwin-arm64", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  const restEntries = (currentPath ?? "")
    .split(path.delimiter)
    .filter((entry) => entry.length > 0);
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const entry of [...headEntries, ...restEntries]) {
    if (!seen.has(entry)) {
      seen.add(entry);
      merged.push(entry);
    }
  }
  return merged.join(path.delimiter);
}

function signalProcessGroup(proc: ChildProcess, sig: NodeJS.Signals): void {
  const pid = proc.pid;
  if (pid !== undefined && pid > 0) {
    try {
      process.kill(-pid, sig);
      return;
    } catch {
      // Fallback to direct child signal if process group already exited.
    }
  }
  try {
    proc.kill(sig);
  } catch {
    // Already terminated.
  }
}

// ---------------------------------------------------------------------------
// Security Guard & Path / Command Inspection
// ---------------------------------------------------------------------------

interface LoadedGuardState {
  access: AccessTier;
  cwd: string;
  askFirst: string[];
  approvedKeys: string[];
  cpSpec: ControlPlaneSpec;
}

interface ControlPlaneSpec {
  normGuardFile: string;
  normCwd: string;
  searchRestrictedHomes: Set<string>;
  fileHomes: Set<string>;
  noAccessExact: Set<string>;
  dbProtectedExact: Set<string>;
  textReadOnlyExact: Set<string>;
}

function stripDarwinPrivatePrefix(p: string): string {
  if (p.startsWith("/private/tmp/")) {
    return p.slice("/private".length);
  }
  if (p === "/private/tmp") {
    return "/tmp";
  }
  if (p.startsWith("/private/var/")) {
    return p.slice("/private".length);
  }
  if (p === "/private/var") {
    return "/var";
  }
  return p;
}

function resolveRealOrNearestParent(resolvedPath: string): string {
  try {
    if (existsSync(resolvedPath)) {
      return realpathSync(resolvedPath);
    }
  } catch {
    // Fall through to parent check.
  }
  const parent = path.dirname(resolvedPath);
  if (parent && parent !== resolvedPath) {
    try {
      if (existsSync(parent)) {
        return path.join(realpathSync(parent), path.basename(resolvedPath));
      }
    } catch {
      // Keep path.resolve output.
    }
  }
  return resolvedPath;
}

function expandEnvVarsInPath(
  rawPath: string,
  envCtx: {
    homeDir: string;
    guardFile: string;
    contextFile: string;
    autoloopHome?: string;
    pluginData?: string;
  },
): string {
  const stripped = stripFileUri(rawPath.trim());
  if (!stripped) return "";
  const replaced = stripped
    .replace(
      /\$\{AUTOLOOP_GUARD_FILE\}|\$AUTOLOOP_GUARD_FILE\b/g,
      () => envCtx.guardFile,
    )
    .replace(
      /\$\{AUTOLOOP_CONTEXT\}|\$AUTOLOOP_CONTEXT\b/g,
      () => envCtx.contextFile,
    )
    .replace(
      /\$\{AUTOLOOP_HOME\}|\$AUTOLOOP_HOME\b/g,
      () => envCtx.autoloopHome ?? "",
    )
    .replace(
      /\$\{PLUGIN_DATA\}|\$PLUGIN_DATA\b/g,
      () => envCtx.pluginData ?? "",
    )
    .replace(/\$\{HOME\}|\$HOME\b/g, () => envCtx.homeDir);
  return expandHomeDir(replaced, envCtx.homeDir);
}

function normalizeComparablePath(
  targetPath: string,
  baseDir: string,
  envCtx: {
    homeDir: string;
    guardFile: string;
    contextFile: string;
    autoloopHome?: string;
    pluginData?: string;
  },
): string {
  const expanded = expandEnvVarsInPath(targetPath, envCtx);
  if (!expanded) return "";
  const resolved =
    !path.isAbsolute(expanded) && baseDir
      ? path.resolve(baseDir, expanded)
      : path.resolve(expanded);
  const canonical = resolveRealOrNearestParent(resolved);
  return stripDarwinPrivatePrefix(canonical);
}

function isStrictlyInside(childPath: string, parentPath: string): boolean {
  const rel = path.relative(parentPath, childPath);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function buildControlPlaneSpec(
  guardFile: string,
  contextFile: string,
  guardCwd: string,
  envCtx: {
    homeDir: string;
    guardFile: string;
    contextFile: string;
    autoloopHome?: string;
    pluginData?: string;
  },
): ControlPlaneSpec {
  const normGuardFile = normalizeComparablePath(guardFile, "", envCtx);
  const normContextFile = normalizeComparablePath(contextFile, "", envCtx);
  const normCwd = guardCwd ? normalizeComparablePath(guardCwd, "", envCtx) : "";

  const searchRestrictedHomes = new Set<string>();
  const fileHomes = new Set<string>();

  const guardParent = path.dirname(normGuardFile);
  const guardGrandParent = path.dirname(guardParent);
  if (path.basename(guardGrandParent) === "runs") {
    const derivedHome = path.dirname(guardGrandParent);
    searchRestrictedHomes.add(derivedHome);
    fileHomes.add(derivedHome);
  } else if (guardParent && guardParent !== "/") {
    fileHomes.add(guardParent);
    if (guardParent !== normCwd) {
      searchRestrictedHomes.add(guardParent);
    }
  }

  if (envCtx.autoloopHome?.trim()) {
    const h = normalizeComparablePath(envCtx.autoloopHome.trim(), "", envCtx);
    searchRestrictedHomes.add(h);
    fileHomes.add(h);
  }
  if (envCtx.pluginData?.trim()) {
    const h = normalizeComparablePath(envCtx.pluginData.trim(), "", envCtx);
    searchRestrictedHomes.add(h);
    fileHomes.add(h);
  }

  for (const defaultHome of [
    path.join(envCtx.homeDir, ".gemini", "antigravity", "autoloop_data"),
    path.join(envCtx.homeDir, ".autoloop"),
  ]) {
    const h = normalizeComparablePath(defaultHome, "", envCtx);
    searchRestrictedHomes.add(h);
    fileHomes.add(h);
  }

  const noAccessExact = new Set<string>([normGuardFile]);
  const dbProtectedExact = new Set<string>();
  const textReadOnlyExact = new Set<string>();

  if (normContextFile) {
    textReadOnlyExact.add(normContextFile);
  }

  for (const home of fileHomes) {
    if (!home) continue;
    for (const f of NO_ACCESS_CONTROL_FILES) {
      noAccessExact.add(path.join(home, f));
    }
    for (const f of DB_CONTROL_FILES) {
      dbProtectedExact.add(path.join(home, f));
    }
    for (const f of TEXT_READONLY_CONTROL_FILES) {
      textReadOnlyExact.add(path.join(home, f));
    }
  }

  return {
    normGuardFile,
    normCwd,
    searchRestrictedHomes,
    fileHomes,
    noAccessExact,
    dbProtectedExact,
    textReadOnlyExact,
  };
}

function isNoAccessControlPath(
  normPath: string,
  cpSpec: ControlPlaneSpec,
): boolean {
  if (!normPath) return false;
  if (cpSpec.noAccessExact.has(normPath)) {
    return true;
  }
  if (path.basename(normPath) === "guard.json") {
    const runsDir = path.dirname(path.dirname(normPath));
    if (
      path.basename(runsDir) === "runs" &&
      cpSpec.fileHomes.has(path.dirname(runsDir))
    ) {
      return true;
    }
  }
  return false;
}

function isDbControlPath(normPath: string, cpSpec: ControlPlaneSpec): boolean {
  if (!normPath) return false;
  if (cpSpec.dbProtectedExact.has(normPath)) {
    return true;
  }
  const base = path.basename(normPath);
  if (
    (base === "hub.db" ||
      base.startsWith("hub.db-") ||
      base.startsWith("hub.db.")) &&
    cpSpec.fileHomes.has(path.dirname(normPath))
  ) {
    return true;
  }
  return false;
}

function isReadOnlyTextControlPath(
  normPath: string,
  cpSpec: ControlPlaneSpec,
): boolean {
  if (!normPath) return false;
  if (cpSpec.textReadOnlyExact.has(normPath)) {
    return true;
  }
  if (path.basename(normPath) === "context.json") {
    const runsDir = path.dirname(path.dirname(normPath));
    if (
      path.basename(runsDir) === "runs" &&
      cpSpec.fileHomes.has(path.dirname(runsDir))
    ) {
      return true;
    }
  }
  return false;
}

function isNoWriteControlPath(
  normPath: string,
  cpSpec: ControlPlaneSpec,
): boolean {
  return (
    isNoAccessControlPath(normPath, cpSpec) ||
    isDbControlPath(normPath, cpSpec) ||
    isReadOnlyTextControlPath(normPath, cpSpec)
  );
}

function isProtectedGlobalConfigPath(normPath: string): boolean {
  if (!normPath) return false;
  const suffix = path.join(".gemini", "config", "config.json");
  return normPath.endsWith(suffix);
}

function stricterAccess(a: AccessTier, b: AccessTier): AccessTier {
  const rank: Record<AccessTier, number> = { read: 0, edit: 1, full: 2 };
  return rank[a] <= rank[b] ? a : b;
}

function parseAccessTier(value: unknown): AccessTier | null {
  if (value === "read" || value === "edit" || value === "full") {
    return value;
  }
  return null;
}

function loadGuardState(
  guardFile: string,
  contextFile: string,
  job: Job,
  expandedCwd: string,
  envCtx: {
    homeDir: string;
    guardFile: string;
    contextFile: string;
    autoloopHome?: string;
    pluginData?: string;
  },
): LoadedGuardState | null {
  if (!guardFile || !existsSync(guardFile)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(guardFile, "utf8"));
  } catch {
    return null;
  }
  const guardObj = asRecord(parsed);
  if (!guardObj) {
    return null;
  }

  const guardAccess =
    guardObj.access === undefined ? "edit" : parseAccessTier(guardObj.access);
  if (!guardAccess) {
    return null;
  }
  const jobAccess: AccessTier = job.agent.access ?? "edit";
  const effectiveAccess = stricterAccess(guardAccess, jobAccess);

  const guardCwd =
    typeof guardObj.cwd === "string" && guardObj.cwd.trim().length > 0
      ? guardObj.cwd.trim()
      : expandedCwd;

  const rawAskFirst = Array.isArray(guardObj.askFirst)
    ? guardObj.askFirst
    : Array.isArray(guardObj.askFirstPatterns)
      ? guardObj.askFirstPatterns
      : [];
  const mergedAskFirst = new Set<string>();
  for (const item of [...rawAskFirst, ...(job.askFirst ?? [])]) {
    if (typeof item === "string" && item.trim().length > 0) {
      mergedAskFirst.add(item.trim());
    }
  }

  const approvedKeys: string[] = [];
  if (Array.isArray(guardObj.approvedKeys)) {
    for (const k of guardObj.approvedKeys) {
      if (typeof k === "string" && k.trim().length > 0) {
        approvedKeys.push(k.trim());
      }
    }
  }

  const cpSpec = buildControlPlaneSpec(
    guardFile,
    contextFile,
    guardCwd,
    envCtx,
  );
  return {
    access: effectiveAccess,
    cwd: guardCwd,
    askFirst: [...mergedAskFirst],
    approvedKeys,
    cpSpec,
  };
}

function normalizeToken(value: string): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesTokenBoundary(candidate: string, target: string): boolean {
  if (!candidate || !target) return false;
  if (candidate === target) return true;
  const boundaryRe = new RegExp(`(?:^|-)${escapeRegExp(target)}(?:-|$)`);
  return boundaryRe.test(candidate);
}

function isApprovedFor(
  approvedKeys: readonly string[],
  categoryId: string | undefined,
  pattern: string | undefined,
): boolean {
  const normApproved = approvedKeys
    .map((k) => normalizeToken(k))
    .filter((k) => k.length > 0);
  if (normApproved.length === 0) return false;

  if (pattern) {
    const normPattern = normalizeToken(pattern);
    if (normPattern.length > 0) {
      for (const k of normApproved) {
        if (matchesTokenBoundary(k, normPattern)) {
          return true;
        }
      }
    }
  }

  if (categoryId) {
    const cat = HIGH_RISK_CATEGORIES.find((c) => c.id === categoryId);
    if (cat) {
      for (const k of normApproved) {
        for (const alias of cat.aliases) {
          const normAlias = normalizeToken(alias);
          if (matchesTokenBoundary(k, normAlias)) {
            return true;
          }
        }
      }
    }
  }

  return false;
}

function splitShellSegments(commandLine: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let i = 0; i < commandLine.length; i++) {
    const ch = commandLine[i]!;
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      current += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      }
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    const two = commandLine.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      i += 1;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "\n" || ch === "\r") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) {
    segments.push(current.trim());
  }
  return segments;
}

function extractCommandSubstitutions(commandLine: string): string[] {
  const subs: string[] = [];
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let i = 0; i < commandLine.length; i++) {
    const ch = commandLine[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === "'" && !quote) {
      quote = "'";
      continue;
    }
    if (ch === '"') {
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (ch === "$" && commandLine[i + 1] === "(") {
      let depth = 1;
      let j = i + 2;
      while (j < commandLine.length && depth > 0) {
        if (commandLine[j] === "\\" && j + 1 < commandLine.length) {
          j += 2;
          continue;
        }
        if (commandLine[j] === "(") depth += 1;
        else if (commandLine[j] === ")") depth -= 1;
        j += 1;
      }
      if (depth === 0) {
        const inner = commandLine.slice(i + 2, j - 1).trim();
        if (inner) subs.push(inner);
        i = j - 1;
      }
      continue;
    }
    if (ch === "`") {
      let j = i + 1;
      while (j < commandLine.length) {
        if (commandLine[j] === "\\" && j + 1 < commandLine.length) {
          j += 2;
          continue;
        }
        if (commandLine[j] === "`") {
          const inner = commandLine.slice(i + 1, j).trim();
          if (inner) subs.push(inner);
          i = j;
          break;
        }
        j += 1;
      }
    }
  }
  return subs;
}

function tokenizeSegment(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

function unwrapCommandTokens(initialTokens: string[]): string[] {
  let tokens = initialTokens;
  let idx = 0;
  while (idx < tokens.length) {
    const tok = tokens[idx]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) {
      idx += 1;
      continue;
    }
    const base = path.basename(tok).toLowerCase();

    if (base === "env") {
      idx += 1;
      while (idx < tokens.length) {
        const opt = tokens[idx]!;
        if (opt === "--") {
          idx += 1;
          break;
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(opt)) {
          idx += 1;
          continue;
        }
        if (ENV_OPTS_WITH_ARG.has(opt)) {
          if ((opt === "-S" || opt === "--split-string") && tokens[idx + 1]) {
            const extra = tokenizeSegment(tokens[idx + 1]!);
            tokens = [
              ...tokens.slice(0, idx),
              ...extra,
              ...tokens.slice(idx + 2),
            ];
            continue;
          }
          idx += 2;
          continue;
        }
        if (opt.startsWith("-S") && opt.length > 2) {
          const extra = tokenizeSegment(opt.slice(2));
          tokens = [
            ...tokens.slice(0, idx),
            ...extra,
            ...tokens.slice(idx + 1),
          ];
          continue;
        }
        if (opt.startsWith("-")) {
          idx += 1;
          continue;
        }
        break;
      }
      continue;
    }

    if (base === "sudo") {
      idx += 1;
      while (idx < tokens.length) {
        const opt = tokens[idx]!;
        if (opt === "--") {
          idx += 1;
          break;
        }
        if (SUDO_OPTS_WITH_ARG.has(opt)) {
          idx += 2;
          continue;
        }
        if (opt.startsWith("--")) {
          idx += 1;
          continue;
        }
        if (opt.startsWith("-") && opt.length > 1) {
          const flags = opt.slice(1);
          let consumesNext = false;
          for (let k = 0; k < flags.length; k++) {
            const ch = flags[k]!;
            if (SUDO_OPTS_WITH_ARG.has(`-${ch}`)) {
              if (k === flags.length - 1) consumesNext = true;
              break;
            }
            if (!SUDO_BOOLEAN_SHORT_FLAGS.has(ch)) break;
          }
          idx += consumesNext ? 2 : 1;
          continue;
        }
        break;
      }
      continue;
    }

    if (base === "command") {
      idx += 1;
      while (idx < tokens.length) {
        const opt = tokens[idx]!;
        if (opt === "--") {
          idx += 1;
          break;
        }
        if (opt === "-p") {
          idx += 1;
          continue;
        }
        break;
      }
      continue;
    }

    if (base === "nohup" || base === "time") {
      idx += 1;
      if (base === "time" && tokens[idx] === "-p") {
        idx += 1;
      }
      continue;
    }

    if (base === "nice") {
      idx += 1;
      while (idx < tokens.length) {
        const opt = tokens[idx]!;
        if (opt === "--") {
          idx += 1;
          break;
        }
        if (opt === "-n" || opt === "--adjustment") {
          idx += 2;
          continue;
        }
        if (opt.startsWith("--adjustment=") || /^-[+-]?\d+$/.test(opt)) {
          idx += 1;
          continue;
        }
        break;
      }
      continue;
    }

    if (base === "exec") {
      idx += 1;
      while (idx < tokens.length) {
        const opt = tokens[idx]!;
        if (opt === "--") {
          idx += 1;
          break;
        }
        if (opt === "-a") {
          idx += 2;
          continue;
        }
        if (opt === "-c" || opt === "-l") {
          idx += 1;
          continue;
        }
        break;
      }
      continue;
    }

    break;
  }
  return tokens.slice(idx);
}

interface EmbeddedExecution {
  kind: "shell" | "interpreter";
  runtime: string;
  code: string;
}

interface AnalyzedSegment {
  raw: string;
  tokens: string[];
  embedded: EmbeddedExecution | null;
}

function extractEmbeddedExecution(tokens: string[]): EmbeddedExecution | null {
  if (tokens.length === 0) return null;
  const cmd = path.basename(tokens[0]!).toLowerCase();

  if (SHELL_NAMES.has(cmd)) {
    let i = 1;
    while (i < tokens.length) {
      const tok = tokens[i]!;
      if (tok === "--") break;
      if (tok === "-o" || tok === "+o") {
        i += 2;
        continue;
      }
      if (tok === "-c" || /^-[a-zA-Z]*c$/.test(tok)) {
        const script = tokens[i + 1];
        return typeof script === "string"
          ? { kind: "shell", runtime: cmd, code: script }
          : null;
      }
      if (tok.startsWith("-") || tok.startsWith("+")) {
        i += 1;
        continue;
      }
      break;
    }
    return null;
  }

  if (NODE_INTERPRETERS.has(cmd)) {
    for (let i = 1; i < tokens.length; i++) {
      const tok = tokens[i]!;
      if (tok === "--") break;
      if (
        tok === "-e" ||
        tok === "--eval" ||
        tok === "-p" ||
        tok === "--print"
      ) {
        return {
          kind: "interpreter",
          runtime: cmd,
          code: typeof tokens[i + 1] === "string" ? tokens[i + 1]! : "",
        };
      }
      if (tok.startsWith("--eval=")) {
        return {
          kind: "interpreter",
          runtime: cmd,
          code: tok.slice("--eval=".length),
        };
      }
      if (tok.startsWith("--print=")) {
        return {
          kind: "interpreter",
          runtime: cmd,
          code: tok.slice("--print=".length),
        };
      }
      if (!tok.startsWith("-")) break;
    }
    return null;
  }

  if (PYTHON_INTERPRETER_RE.test(cmd)) {
    for (let i = 1; i < tokens.length; i++) {
      const tok = tokens[i]!;
      if (tok === "--") break;
      if (tok === "-c" || /^-[IubBEsS]*c$/.test(tok)) {
        return {
          kind: "interpreter",
          runtime: "python",
          code: typeof tokens[i + 1] === "string" ? tokens[i + 1]! : "",
        };
      }
      if (tok === "-W" || tok === "-X") {
        i += 1;
        continue;
      }
      if (!tok.startsWith("-")) break;
    }
    return null;
  }

  if (OTHER_INLINE_INTERPRETERS.has(cmd)) {
    for (let i = 1; i < tokens.length; i++) {
      const tok = tokens[i]!;
      if (tok === "--") break;
      if (
        ((cmd === "ruby" || cmd === "perl") &&
          (tok === "-e" || tok === "-E")) ||
        (cmd === "php" && tok === "-r")
      ) {
        return {
          kind: "interpreter",
          runtime: cmd,
          code: typeof tokens[i + 1] === "string" ? tokens[i + 1]! : "",
        };
      }
      if (!tok.startsWith("-")) break;
    }
    return null;
  }

  return null;
}

function collectEffectiveSegments(
  commandLine: string,
  depth = 0,
): AnalyzedSegment[] {
  if (!commandLine || depth > MAX_SUBSHELL_DEPTH) {
    return [];
  }
  const results: AnalyzedSegment[] = [];
  const rawSegments = splitShellSegments(commandLine);

  for (const seg of rawSegments) {
    const tokens = unwrapCommandTokens(tokenizeSegment(seg));
    const embedded = extractEmbeddedExecution(tokens);
    results.push({ raw: seg, tokens, embedded });
    if (embedded && embedded.kind === "shell" && embedded.code) {
      results.push(...collectEffectiveSegments(embedded.code, depth + 1));
    }
  }

  for (const sub of extractCommandSubstitutions(commandLine)) {
    results.push(...collectEffectiveSegments(sub, depth + 1));
  }

  return results;
}

interface GitSegmentInfo {
  subcommand: string;
  args: string[];
}

function parseGitSegment(tokens: string[]): GitSegmentInfo | null {
  if (tokens.length === 0) return null;
  if (path.basename(tokens[0]!).toLowerCase() !== "git") return null;

  let i = 1;
  while (i < tokens.length) {
    const tok = tokens[i]!;
    if (tok === "--") {
      i += 1;
      break;
    }
    if (!tok.startsWith("-")) break;
    if (GIT_GLOBAL_OPTS_WITH_ARG.has(tok)) {
      i += 2;
      continue;
    }
    if (
      tok.startsWith("--git-dir=") ||
      tok.startsWith("--work-tree=") ||
      tok.startsWith("--namespace=") ||
      tok.startsWith("--super-prefix=") ||
      tok.startsWith("--exec-path=") ||
      tok.startsWith("--config-env=") ||
      (tok.startsWith("-C") && tok.length > 2) ||
      (tok.startsWith("-c") && tok.length > 2)
    ) {
      i += 1;
      continue;
    }
    i += 1;
  }

  if (i >= tokens.length) {
    return { subcommand: "", args: [] };
  }
  return { subcommand: tokens[i]!.toLowerCase(), args: tokens.slice(i + 1) };
}

function isGitForcePush(gitInfo: GitSegmentInfo | null): boolean {
  if (!gitInfo || gitInfo.subcommand !== "push") return false;
  let afterDoubleDash = false;
  for (const arg of gitInfo.args) {
    if (!afterDoubleDash && arg === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash) {
      if (
        arg === "-f" ||
        arg === "--force" ||
        arg === "--force-with-lease" ||
        arg.startsWith("--force-with-lease=") ||
        arg === "--force-if-includes" ||
        /^-[^-]*f/.test(arg)
      ) {
        return true;
      }
    }
    if (arg.startsWith("+") && arg.length > 1) {
      return true;
    }
  }
  return false;
}

function isGitResetHard(gitInfo: GitSegmentInfo | null): boolean {
  if (!gitInfo || gitInfo.subcommand !== "reset") return false;
  return gitInfo.args.some((arg) => arg === "--hard");
}

function isGitApplyReadOnly(gitInfo: GitSegmentInfo | null): boolean {
  if (!gitInfo || gitInfo.subcommand !== "apply") return false;
  return gitInfo.args.some(
    (arg) =>
      arg === "--stat" ||
      arg === "--numstat" ||
      arg === "--summary" ||
      arg === "--check",
  );
}

function isReadOnlyGitInvocation(gitInfo: GitSegmentInfo | null): boolean {
  if (!gitInfo) return false;
  if (!gitInfo.subcommand) return true;
  if (READONLY_GIT_SUBCOMMANDS.has(gitInfo.subcommand)) return true;
  return isGitApplyReadOnly(gitInfo);
}

function analyzeRmSegment(
  tokens: string[],
  normCwd: string | null,
  envCtx: {
    homeDir: string;
    guardFile: string;
    contextFile: string;
    autoloopHome?: string;
    pluginData?: string;
  },
): { recursive: boolean; force: boolean; outOfBounds: boolean } | null {
  if (tokens.length === 0) return null;
  if (path.basename(tokens[0]!).toLowerCase() !== "rm") return null;

  let recursive = false;
  let force = false;
  let endOfFlags = false;
  const targets: string[] = [];

  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (!endOfFlags && tok === "--") {
      endOfFlags = true;
      continue;
    }
    if (!endOfFlags && tok.startsWith("--")) {
      if (tok === "--recursive") recursive = true;
      if (tok === "--force") force = true;
      continue;
    }
    if (!endOfFlags && tok.startsWith("-") && tok.length > 1) {
      for (const flag of tok.slice(1)) {
        if (flag === "r" || flag === "R") recursive = true;
        if (flag === "f") force = true;
      }
      continue;
    }
    targets.push(tok);
  }

  let outOfBounds = false;
  for (const target of targets) {
    if (
      target === "/" ||
      target === "/*" ||
      target === "~" ||
      target.startsWith("~/") ||
      target === "$HOME" ||
      target === "${HOME}" ||
      target.startsWith("$HOME/") ||
      target.startsWith("${HOME}/")
    ) {
      outOfBounds = true;
      break;
    }
    if (normCwd) {
      const resolvedTarget = path.isAbsolute(target)
        ? normalizeComparablePath(target, "", envCtx)
        : normalizeComparablePath(target, normCwd, envCtx);
      if (!isStrictlyInside(resolvedTarget, normCwd)) {
        outOfBounds = true;
        break;
      }
    }
  }

  return { recursive, force, outOfBounds };
}

function extractRedirectTargets(rawSeg: string): string[] {
  const targets: string[] = [];
  const re = /(?:^|[^0-9&])>{1,2}\s*(['"]?)([^\s'";|&]+)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rawSeg)) !== null) {
    if (m[2] && !m[2].startsWith("&") && m[2] !== "/dev/null") {
      targets.push(m[2]);
    }
  }
  return targets;
}

function extractCandidatePathsFromCode(code: string): string[] {
  const candidates = new Set<string>();
  const litRe = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
  let m: RegExpExecArray | null;
  while ((m = litRe.exec(code)) !== null) {
    if (m[2]) candidates.add(m[2]);
  }
  const bareRe = /(?:~\/|\/)[A-Za-z0-9_./-]+/g;
  while ((m = bareRe.exec(code)) !== null) {
    if (m[0]) candidates.add(m[0]);
  }
  return [...candidates];
}

function inlineCodeHasWriteIntent(code: string): boolean {
  if (!code) return false;
  const stripped = code.replace(
    /\b(?:process|sys)\s*\.\s*(?:stdout|stderr)\s*\.\s*write\b/g,
    " ",
  );
  return (
    /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|rmSync|rmdirSync|unlinkSync|renameSync|copyFileSync|cpSync|truncateSync|ftruncateSync|chmodSync|chownSync|utimesSync|linkSync|symlinkSync|writeSync)\b/.test(
      stripped,
    ) ||
    /\b(?:fs|fsp|fsPromises|promises|Bun)\s*\.\s*(?:write|writeFile|appendFile|rm|rmdir|unlink|rename|copyFile|cp|truncate|chmod|chown|utimes|link|symlink)\b/.test(
      stripped,
    ) ||
    /\bopen\s*\([^)]*(?:,\s*['"][^'"]*[wax+][^'"]*['"]|mode\s*=\s*['"][^'"]*[wax+])/.test(
      stripped,
    ) ||
    /\.write(?:_text|_bytes|lines)?\s*\(/.test(stripped) ||
    /\b(?:os|shutil|pathlib|File|FileUtils)\s*\.\s*(?:remove|unlink|rmdir|removedirs|rmtree|rename|renames|replace|copy|copy2|copyfile|move|chmod|chown|truncate|rm|rm_rf)\b/.test(
      stripped,
    ) ||
    /\bfile_put_contents\s*\(|\b(?:execSync|execFileSync|spawnSync|child_process|subprocess)\b|\bos\s*\.\s*system\s*\(/.test(
      stripped,
    )
  );
}

function isSafeReadCommandOnTextTarget(entry: AnalyzedSegment): boolean {
  if (entry.embedded) return false;
  const toks = entry.tokens;
  if (toks.length === 0) return false;
  const cmd = path.basename(toks[0]!).toLowerCase();

  if (TEXT_VIEWER_COMMANDS.has(cmd)) return true;
  if (cmd === "sed") {
    return !toks.some(
      (t) =>
        t === "-i" ||
        t.startsWith("-i") ||
        t === "--in-place" ||
        t.startsWith("--in-place="),
    );
  }
  if (cmd === "awk" || cmd === "gawk" || cmd === "mawk" || cmd === "nawk") {
    return !toks.some(
      (t) =>
        t === "-i" ||
        t.startsWith("-i") ||
        t === "--inplace" ||
        t === "inplace",
    );
  }
  if (cmd === "sort") {
    return !toks.some(
      (t) =>
        t === "-o" ||
        t.startsWith("-o") ||
        t === "--output" ||
        t.startsWith("--output="),
    );
  }
  if (cmd === "git") {
    return isReadOnlyGitInvocation(parseGitSegment(toks));
  }
  return false;
}

function inspectCommandProtectedTargets(
  commandLine: string,
  cpSpec: ControlPlaneSpec,
  envCtx: {
    homeDir: string;
    guardFile: string;
    contextFile: string;
    autoloopHome?: string;
    pluginData?: string;
  },
): string | null {
  if (!commandLine) return null;
  if (/AUTOLOOP_GUARD_FILE/.test(commandLine)) {
    return CONTROL_PLANE_DENY_REASON;
  }

  const baseDir = cpSpec.normCwd;
  const entries = collectEffectiveSegments(commandLine);

  for (const entry of entries) {
    const cmd = path.basename(entry.tokens[0] ?? "").toLowerCase();
    const redirects = extractRedirectTargets(entry.raw);
    const hasRedirect = redirects.length > 0;
    const isSafeDbMetaRead =
      !hasRedirect &&
      !entry.embedded &&
      (cmd === "ls" || cmd === "stat" || cmd === "file");
    const isSafeTextRead = !hasRedirect && isSafeReadCommandOnTextTarget(entry);

    for (const rTarget of redirects) {
      const normR = normalizeComparablePath(rTarget, baseDir, envCtx);
      if (isProtectedGlobalConfigPath(normR)) {
        return GLOBAL_CONFIG_DENY_REASON;
      }
      if (isNoWriteControlPath(normR, cpSpec)) {
        return CONTROL_PLANE_DENY_REASON;
      }
    }

    for (let i = 1; i < entry.tokens.length; i++) {
      const tok = entry.tokens[i]!;
      if (!tok || tok === "-") continue;
      const eqIdx = tok.indexOf("=");
      const candidate =
        eqIdx !== -1 && /^[A-Za-z0-9_-]+=.+/.test(tok)
          ? tok.slice(eqIdx + 1)
          : tok;
      if (candidate.startsWith("-") && !candidate.includes("/")) {
        continue;
      }
      const normCandidate = normalizeComparablePath(candidate, baseDir, envCtx);
      if (isNoAccessControlPath(normCandidate, cpSpec)) {
        return CONTROL_PLANE_DENY_REASON;
      }
      if (isDbControlPath(normCandidate, cpSpec) && !isSafeDbMetaRead) {
        return CONTROL_PLANE_DENY_REASON;
      }
      if (!isSafeTextRead) {
        if (isProtectedGlobalConfigPath(normCandidate)) {
          return GLOBAL_CONFIG_DENY_REASON;
        }
        if (isReadOnlyTextControlPath(normCandidate, cpSpec)) {
          return CONTROL_PLANE_DENY_REASON;
        }
      }
    }

    if (entry.embedded && entry.embedded.kind === "interpreter") {
      const code = entry.embedded.code || "";
      if (
        /AUTOLOOP_GUARD_FILE|AUTOLOOP_OWNER_TOKEN|AUTOLOOP_MASTER_KEY|AUTOLOOP_INGEST_TOKEN/.test(
          code,
        )
      ) {
        return CONTROL_PLANE_DENY_REASON;
      }
      const hasWriteIntent = inlineCodeHasWriteIntent(code);
      if (hasWriteIntent && /\bAUTOLOOP_CONTEXT\b/.test(code)) {
        return CONTROL_PLANE_DENY_REASON;
      }
      for (const lit of extractCandidatePathsFromCode(code)) {
        if (
          !lit.includes("/") &&
          !NO_ACCESS_CONTROL_FILES.includes(lit) &&
          !DB_CONTROL_FILES.includes(lit) &&
          !TEXT_READONLY_CONTROL_FILES.includes(lit) &&
          lit !== "guard.json" &&
          lit !== "context.json"
        ) {
          continue;
        }
        const normLit = normalizeComparablePath(lit, baseDir, envCtx);
        if (isNoAccessControlPath(normLit, cpSpec)) {
          return CONTROL_PLANE_DENY_REASON;
        }
        if (isDbControlPath(normLit, cpSpec)) {
          return CONTROL_PLANE_DENY_REASON;
        }
        if (hasWriteIntent) {
          if (isProtectedGlobalConfigPath(normLit)) {
            return GLOBAL_CONFIG_DENY_REASON;
          }
          if (isReadOnlyTextControlPath(normLit, cpSpec)) {
            return CONTROL_PLANE_DENY_REASON;
          }
        }
      }
    }
  }

  return null;
}

function detectInterpreterCategories(code: string): Set<string> {
  const cats = new Set<string>();
  if (!code) return cats;

  if (
    /\b(?:rmSync|rmdirSync|unlinkSync|rmtree|removedirs)\b|\bfs\s*\.\s*(?:rm|rmdir|unlink)\b|\bfsp\s*\.\s*(?:rm|rmdir|unlink)\b|\bos\s*\.\s*(?:remove|unlink|rmdir)\b|\.unlink\s*\(|\brm\s+-[a-zA-Z]*(?:r|f)[a-zA-Z]*\b/.test(
      code,
    )
  ) {
    cats.add("rm-rf");
  }
  if (
    /git\s+push\s+[^\n"']*(?:--force|-f\b)/i.test(code) ||
    /["']push["']\s*,\s*["'](?:--force|-f)["']/i.test(code)
  ) {
    cats.add("git-push-force");
  }
  if (
    /git\s+reset\s+[^\n"']*--hard/i.test(code) ||
    /["']reset["']\s*,\s*["']--hard["']/i.test(code)
  ) {
    cats.add("git-reset-hard");
  }
  if (/\b(?:drop\s+(?:table|database|schema)|truncate\s+table)\b/i.test(code)) {
    cats.add("drop-db");
  }
  return cats;
}

function detectCategories(
  commandLine: string,
  envCtx: {
    homeDir: string;
    guardFile: string;
    contextFile: string;
    autoloopHome?: string;
    pluginData?: string;
  },
): Set<string> {
  const categories = new Set<string>();
  const normalized = commandLine.replace(/\s+/g, " ").trim();
  const entries = collectEffectiveSegments(commandLine);

  for (const entry of entries) {
    const rmInfo = analyzeRmSegment(entry.tokens, null, envCtx);
    if (rmInfo && (rmInfo.recursive || rmInfo.force)) {
      categories.add("rm-rf");
    }
    const gitInfo = parseGitSegment(entry.tokens);
    if (isGitForcePush(gitInfo)) {
      categories.add("git-push-force");
    }
    if (isGitResetHard(gitInfo)) {
      categories.add("git-reset-hard");
    }
    if (entry.embedded && entry.embedded.kind === "interpreter") {
      for (const c of detectInterpreterCategories(entry.embedded.code)) {
        categories.add(c);
      }
    }
  }

  if (
    /\b(?:drop\s+(?:table|database|schema)|truncate\s+table)\b/i.test(
      normalized,
    )
  ) {
    categories.add("drop-db");
  }

  return categories;
}

function commandMatchesPattern(
  commandLine: string,
  pattern: string,
  envCtx: {
    homeDir: string;
    guardFile: string;
    contextFile: string;
    autoloopHome?: string;
    pluginData?: string;
  },
): boolean {
  const normCmd = commandLine.replace(/\s+/g, " ").trim().toLowerCase();
  const normPat = String(pattern ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!normPat) return false;
  if (normCmd.includes(normPat)) return true;

  const entries = collectEffectiveSegments(commandLine);
  for (const entry of entries) {
    if (entry.raw.replace(/\s+/g, " ").trim().toLowerCase().includes(normPat)) {
      return true;
    }
    if (entry.tokens.join(" ").toLowerCase().includes(normPat)) {
      return true;
    }
    const gitInfo = parseGitSegment(entry.tokens);
    if (gitInfo && gitInfo.subcommand) {
      const normGit = ["git", gitInfo.subcommand, ...gitInfo.args]
        .join(" ")
        .toLowerCase();
      if (normGit.includes(normPat)) return true;
    }
    if (entry.embedded && entry.embedded.code) {
      const normCode = entry.embedded.code
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      if (normCode.includes(normPat)) return true;
    }
  }

  const detectedCats = detectCategories(commandLine, envCtx);
  for (const cat of HIGH_RISK_CATEGORIES) {
    if (!cat.patternMatches.some((re) => re.test(normPat))) continue;
    if (detectedCats.has(cat.id)) return true;
    if (cat.id === "rm-rf") {
      for (const entry of entries) {
        const cmd = path.basename(entry.tokens[0] ?? "").toLowerCase();
        if (cmd === "rm" || cmd === "rmdir" || cmd === "unlink") return true;
        if (cmd === "find" && entry.tokens.includes("-delete")) return true;
      }
    }
  }

  return false;
}

function isWriteShellCommand(commandLine: string): boolean {
  const entries = collectEffectiveSegments(commandLine);
  for (const entry of entries) {
    if (extractRedirectTargets(entry.raw).length > 0) {
      return true;
    }
    if (entry.embedded && entry.embedded.kind === "interpreter") {
      return true;
    }
    const toks = entry.tokens;
    if (toks.length === 0) continue;
    const cmd = path.basename(toks[0]!).toLowerCase();
    if (MUTATING_COMMANDS.has(cmd)) return true;
    if (
      cmd === "sed" &&
      toks.some((t) => t === "-i" || t.startsWith("-i") || t === "--in-place")
    ) {
      return true;
    }
    if (cmd === "perl" && toks.some((t) => t === "-i" || t.startsWith("-i"))) {
      return true;
    }
    if (
      (cmd === "awk" || cmd === "gawk" || cmd === "mawk" || cmd === "nawk") &&
      toks.some(
        (t) =>
          t === "-i" ||
          t.startsWith("-i") ||
          t === "--inplace" ||
          t === "inplace",
      )
    ) {
      return true;
    }
    const gitInfo = parseGitSegment(toks);
    if (
      gitInfo &&
      MUTATING_GIT_SUBCOMMANDS.has(gitInfo.subcommand) &&
      !isGitApplyReadOnly(gitInfo)
    ) {
      return true;
    }
    if (cmd === "find" && toks.includes("-delete")) {
      return true;
    }
  }
  return false;
}

function extractFilePathsFromObject(
  obj: Record<string, unknown> | null,
): string[] {
  if (!obj) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (!FILE_ARG_KEYS.has(k.toLowerCase())) continue;
    if (typeof v === "string" && v.trim().length > 0) {
      out.push(v.trim());
    } else if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === "string" && item.trim().length > 0) {
          out.push(item.trim());
        }
      }
    }
  }
  return out;
}

function extractLocationsArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim().length > 0) {
      out.push(item.trim());
      continue;
    }
    const rec = asRecord(item);
    if (!rec) continue;
    for (const key of ["path", "uri", "file", "filePath"]) {
      if (
        typeof rec[key] === "string" &&
        (rec[key] as string).trim().length > 0
      ) {
        out.push((rec[key] as string).trim());
      }
    }
  }
  return out;
}

function selectPermissionResponse(
  optionsValue: unknown,
  allowed: boolean,
): Record<string, unknown> {
  const opts = Array.isArray(optionsValue) ? optionsValue : [];

  const findOptionId = (
    preferredKinds: readonly string[],
    prefixRe: RegExp,
  ): string | null => {
    for (const targetKind of preferredKinds) {
      for (const raw of opts) {
        const rec = asRecord(raw);
        if (!rec) continue;
        const kind = typeof rec.kind === "string" ? rec.kind.toLowerCase() : "";
        const optionId = nonEmptyString(rec.optionId) ?? nonEmptyString(rec.id);
        if (optionId && kind === targetKind) {
          return optionId;
        }
      }
    }
    for (const raw of opts) {
      const rec = asRecord(raw);
      if (!rec) continue;
      const kind = typeof rec.kind === "string" ? rec.kind.toLowerCase() : "";
      const optionId = nonEmptyString(rec.optionId) ?? nonEmptyString(rec.id);
      if (optionId && (prefixRe.test(kind) || prefixRe.test(optionId))) {
        return optionId;
      }
    }
    return null;
  };

  if (!allowed) {
    const rejectId = findOptionId(
      ["reject_once", "reject_always"],
      /^(?:reject|deny)/i,
    );
    if (rejectId) {
      return { outcome: { outcome: "selected", optionId: rejectId } };
    }
    return { outcome: { outcome: "cancelled" } };
  }

  const allowId = findOptionId(["allow_once", "allow_always"], /^allow/i);
  if (allowId) {
    return { outcome: { outcome: "selected", optionId: allowId } };
  }
  return { outcome: { outcome: "cancelled" } };
}

function evaluatePermissionRequest(
  params: Record<string, unknown>,
  guard: LoadedGuardState | null,
  envCtx: {
    homeDir: string;
    guardFile: string;
    contextFile: string;
    autoloopHome?: string;
    pluginData?: string;
  },
): boolean {
  if (!guard) {
    return false;
  }

  const toolCall =
    asRecord(params.toolCall) ?? asRecord(params.permission) ?? {};
  const toolKind = (
    nonEmptyString(toolCall.kind) ??
    nonEmptyString(params.kind) ??
    ""
  ).toLowerCase();
  const toolName = (
    nonEmptyString(toolCall.name) ??
    nonEmptyString(toolCall.toolName) ??
    nonEmptyString(params.toolName) ??
    nonEmptyString(params.name) ??
    ""
  ).toLowerCase();
  const title =
    nonEmptyString(toolCall.title) ?? nonEmptyString(params.title) ?? "";

  const rawInputCandidate =
    toolCall.rawInput ??
    toolCall.input ??
    toolCall.args ??
    params.rawInput ??
    params.input ??
    params.args;

  let rawInputObj = asRecord(rawInputCandidate);
  let rawInputStringCmd = "";
  if (!rawInputObj && typeof rawInputCandidate === "string") {
    const trimmed = rawInputCandidate.trim();
    if (trimmed.startsWith("{")) {
      try {
        rawInputObj = asRecord(JSON.parse(trimmed));
      } catch {
        rawInputObj = null;
      }
    }
    if (!rawInputObj && trimmed.length > 0) {
      rawInputStringCmd = trimmed;
    }
  }

  const contentArr = Array.isArray(toolCall.content) ? toolCall.content : [];
  let hasDiffContent = false;
  const diffPaths: string[] = [];
  for (const item of contentArr) {
    const rec = asRecord(item);
    if (!rec) continue;
    if (rec.type === "diff") {
      hasDiffContent = true;
      if (typeof rec.path === "string" && rec.path.trim().length > 0) {
        diffPaths.push(rec.path.trim());
      }
    }
  }

  const candidatePaths = [
    ...extractLocationsArray(toolCall.locations),
    ...extractLocationsArray(params.locations),
    ...extractFilePathsFromObject(rawInputObj),
    ...extractFilePathsFromObject(toolCall),
    ...extractFilePathsFromObject(params),
    ...diffPaths,
  ];

  const commands: string[] = [];
  if (rawInputObj) {
    for (const key of [
      "CommandLine",
      "commandLine",
      "command",
      "cmd",
      "script",
    ]) {
      const val = rawInputObj[key];
      if (typeof val === "string" && val.trim().length > 0) {
        if (
          (key === "command" || key === "cmd") &&
          Array.isArray(rawInputObj.args)
        ) {
          const argStrs = rawInputObj.args.filter(
            (a): a is string => typeof a === "string",
          );
          commands.push([val, ...argStrs].join(" "));
        } else {
          commands.push(val);
        }
      } else if (Array.isArray(val)) {
        const parts = val.filter((a): a is string => typeof a === "string");
        if (parts.length > 0) commands.push(parts.join(" "));
      }
    }
  }
  for (const outer of [toolCall, params]) {
    for (const key of ["CommandLine", "commandLine", "command", "cmd"]) {
      const val = outer[key];
      if (typeof val === "string" && val.trim().length > 0) {
        commands.push(val);
      }
    }
  }
  if (rawInputStringCmd) {
    commands.push(rawInputStringCmd);
  }

  const isExecuteTool =
    toolKind === "execute" ||
    toolName === "run_command" ||
    toolName === "bash" ||
    toolName === "shell" ||
    toolName === "terminal" ||
    toolName.startsWith("terminal/") ||
    commands.length > 0;

  if (isExecuteTool && commands.length === 0 && title.length > 0) {
    const unquotedTitle = title.replace(/^`+|`+$/g, "").trim();
    if (unquotedTitle) {
      commands.push(unquotedTitle);
    }
  }

  const isDeleteTool = toolKind === "delete" || DELETE_TOOL_NAMES.has(toolName);
  const isMutatingFileTool =
    toolKind === "edit" ||
    toolKind === "delete" ||
    toolKind === "move" ||
    hasDiffContent ||
    WRITE_TOOL_NAMES.has(toolName) ||
    /^(?:write|edit|create|delete|remove|rename|move|patch|replace|apply_patch)\b/i.test(
      toolName,
    );
  const isSearchTool =
    toolKind === "search" || SEARCH_DIR_TOOL_NAMES.has(toolName);

  const baseDir = guard.cpSpec.normCwd;

  // 1. Inspect all file path arguments against control-plane boundaries
  for (const rawTarget of candidatePaths) {
    const normTarget = normalizeComparablePath(rawTarget, baseDir, envCtx);
    if (isNoAccessControlPath(normTarget, guard.cpSpec)) {
      return false;
    }
    if (isDbControlPath(normTarget, guard.cpSpec)) {
      return false;
    }
    if (isSearchTool && guard.cpSpec.searchRestrictedHomes.has(normTarget)) {
      return false;
    }
    if (isMutatingFileTool) {
      if (isProtectedGlobalConfigPath(normTarget)) {
        return false;
      }
      if (isNoWriteControlPath(normTarget, guard.cpSpec)) {
        return false;
      }
    }
  }

  // 2. Enforce read-only mode on mutating file tools
  if (guard.access === "read" && isMutatingFileTool) {
    return false;
  }

  // 3. Enforce delete askFirst policy on file delete tools
  if (isDeleteTool) {
    const rmCat = HIGH_RISK_CATEGORIES[0]!;
    const hitPatterns = guard.askFirst.filter((p) =>
      rmCat.patternMatches.some((re) => re.test(p)),
    );
    const approvedByCat = isApprovedFor(guard.approvedKeys, "rm-rf", undefined);
    const approvedByPat = hitPatterns.some((p) =>
      isApprovedFor(guard.approvedKeys, "rm-rf", p),
    );
    if (!approvedByCat && !approvedByPat) {
      return false;
    }
  }

  // 4. Enforce shell / terminal command rules
  if (isExecuteTool) {
    if (guard.access === "read" && commands.length === 0) {
      return false;
    }

    for (const cmdLine of commands) {
      if (inspectCommandProtectedTargets(cmdLine, guard.cpSpec, envCtx)) {
        return false;
      }

      const effectiveEntries = collectEffectiveSegments(cmdLine);
      for (const entry of effectiveEntries) {
        const rmInfo = analyzeRmSegment(
          entry.tokens,
          guard.cpSpec.normCwd || null,
          envCtx,
        );
        if (
          rmInfo &&
          (rmInfo.recursive || rmInfo.force) &&
          rmInfo.outOfBounds
        ) {
          return false;
        }
      }

      if (guard.access === "read" && isWriteShellCommand(cmdLine)) {
        return false;
      }

      const hitCategories = detectCategories(cmdLine, envCtx);
      for (const catId of hitCategories) {
        const matchingPatterns = guard.askFirst.filter((p) =>
          commandMatchesPattern(cmdLine, p, envCtx),
        );
        const approvedByCat = isApprovedFor(
          guard.approvedKeys,
          catId,
          undefined,
        );
        const approvedByPat = matchingPatterns.some((p) =>
          isApprovedFor(guard.approvedKeys, catId, p),
        );
        if (!approvedByCat && !approvedByPat) {
          return false;
        }
      }

      for (const pattern of guard.askFirst) {
        if (commandMatchesPattern(cmdLine, pattern, envCtx)) {
          const matchedCat = HIGH_RISK_CATEGORIES.find((cat) =>
            cat.patternMatches.some((re) => re.test(pattern)),
          )?.id;
          if (!isApprovedFor(guard.approvedKeys, matchedCat, pattern)) {
            return false;
          }
        }
      }
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// ACP Streaming Content & Usage Extraction
// ---------------------------------------------------------------------------

function extractTextFromAcpContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    let acc = "";
    for (const item of content) {
      acc += extractTextFromAcpContent(item);
    }
    return acc;
  }
  const rec = asRecord(content);
  if (!rec) {
    return "";
  }
  const blockType = typeof rec.type === "string" ? rec.type.toLowerCase() : "";
  if (
    blockType === "thought" ||
    blockType === "thinking" ||
    blockType === "tool_use" ||
    blockType === "tool_call"
  ) {
    return "";
  }
  if (typeof rec.text === "string") {
    return rec.text;
  }
  if (typeof rec.content === "string" || Array.isArray(rec.content)) {
    return extractTextFromAcpContent(rec.content);
  }
  if (asRecord(rec.content)) {
    return extractTextFromAcpContent(rec.content);
  }
  return "";
}

function readUsageFields(source: Record<string, unknown>): RunUsage | null {
  const input =
    finiteNumber(source.input) ??
    finiteNumber(source.inputTokens) ??
    finiteNumber(source.input_tokens) ??
    finiteNumber(source.promptTokens) ??
    finiteNumber(source.prompt_tokens);
  const output =
    finiteNumber(source.output) ??
    finiteNumber(source.outputTokens) ??
    finiteNumber(source.output_tokens) ??
    finiteNumber(source.completionTokens) ??
    finiteNumber(source.completion_tokens) ??
    finiteNumber(source.candidatesTokens);
  const cached =
    finiteNumber(source.cached) ??
    finiteNumber(source.cachedInputTokens) ??
    finiteNumber(source.cachedTokens) ??
    finiteNumber(source.cached_tokens) ??
    finiteNumber(source.cache_read_input_tokens) ??
    finiteNumber(source.cacheReadInputTokens);
  const cost =
    finiteNumber(source.cost) ??
    finiteNumber(source.costUsd) ??
    finiteNumber(source.cost_usd) ??
    finiteNumber(source.total_cost_usd) ??
    finiteNumber(source.totalCostUsd);

  if (
    input === undefined &&
    output === undefined &&
    cached === undefined &&
    cost === undefined
  ) {
    return null;
  }
  const u: RunUsage = {};
  if (input !== undefined) u.input = input;
  if (output !== undefined) u.output = output;
  if (cached !== undefined) u.cached = cached;
  if (cost !== undefined) u.cost = cost;
  return u;
}

// ---------------------------------------------------------------------------
// Stdout Dual-Framing JSON-RPC Parser (JSONL + Content-Length)
// ---------------------------------------------------------------------------

function skipLeadingWhitespaceBytes(buf: Buffer): Buffer {
  let i = 0;
  while (
    i < buf.length &&
    (buf[i] === 0x20 || buf[i] === 0x09 || buf[i] === 0x0d || buf[i] === 0x0a)
  ) {
    i += 1;
  }
  return i > 0 ? buf.subarray(i) : buf;
}

function findHeaderTerminator(
  buf: Buffer,
): { index: number; length: number } | null {
  const crlfIdx = buf.indexOf("\r\n\r\n");
  const lfIdx = buf.indexOf("\n\n");
  if (crlfIdx !== -1 && (lfIdx === -1 || crlfIdx <= lfIdx)) {
    return { index: crlfIdx, length: 4 };
  }
  if (lfIdx !== -1) {
    return { index: lfIdx, length: 2 };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main Runner Entrypoint
// ---------------------------------------------------------------------------

export async function runAcpAgent(
  options: RunAcpOptions,
): Promise<RunnerExecution> {
  const {
    job,
    contextFile,
    guardFile,
    promptOverride,
    baseEnv = process.env,
    killGraceMs = DEFAULT_KILL_GRACE_MS,
    postResultGraceMs = DEFAULT_POST_RESULT_GRACE_MS,
    onStarted,
    signal,
    timeoutMs = (job.agent.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES) * 60_000,
  } = options;

  const command = job.agent.command;
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    typeof command[0] !== "string" ||
    command[0].trim().length === 0 ||
    command.some((arg) => typeof arg !== "string")
  ) {
    throw new InputError(
      `Agent "${job.agent.id}" requires non-empty command array [bin, ...args] for runner "acp"`,
    );
  }

  if (signal?.aborted) {
    return {
      outcome: "cancelled",
      summary: "",
      rawText: "",
      parsed: failedParsed(""),
      session: null,
      started: false,
      error: "Aborted before process start",
      exitCode: null,
      timedOut: false,
      cancelled: true,
    };
  }

  const [bin, ...args] = command;
  const homeDir = baseEnv.HOME || os.homedir();
  const expandedCwd = expandHomeDir(job.rule.cwd, homeDir);
  const env = sanitizeRunnerEnv(baseEnv, job, contextFile, guardFile);
  env.PATH = supplementAcpPath(env.PATH, homeDir);

  const envCtx = {
    homeDir,
    guardFile,
    contextFile,
    autoloopHome: baseEnv.AUTOLOOP_HOME,
    pluginData: baseEnv.PLUGIN_DATA,
  };

  const configuredAccess: AccessTier = job.agent.access ?? "edit";
  const promptText = promptOverride ?? promptFor(job, contextFile);
  const effectivePostGraceMs = Math.max(
    0,
    Math.min(postResultGraceMs, MAX_POST_RESULT_GRACE_MS),
  );

  const proc = spawn(bin, args, {
    cwd: expandedCwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    detached: true,
  });

  proc.stdin?.on("error", () => {
    // Ignore EPIPE when child closes stdin early.
  });

  let stdoutBuf: Buffer = Buffer.alloc(0);
  let stderrBuf = "";
  let spawnError = null as Error | null;
  let closed = false;
  let closeCode = null as number | null;
  let closeSignal = null as NodeJS.Signals | null;

  let started = false;
  let activeSessionId: string | null = null;
  let acceptingPromptUpdates = false;
  let accumulatedChunks = "";
  let fallbackMessageText = "";

  const incUsage = {
    input: 0,
    output: 0,
    cached: 0,
    cost: 0,
    hasInput: false,
    hasOutput: false,
    hasCached: false,
    hasCost: false,
  };
  let finalPromptUsage: RunUsage | null = null;

  let cancelled = false;
  let timedOut = false;
  let graceTerminated = false;
  let killEscalationStarted = false;

  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let cancelDelayTimer: ReturnType<typeof setTimeout> | null = null;
  let killGraceTimer: ReturnType<typeof setTimeout> | null = null;
  let forceDestroyTimer: ReturnType<typeof setTimeout> | null = null;
  let postResultTimer: ReturnType<typeof setTimeout> | null = null;

  let nextRequestId = 1;
  const pendingRequests = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (err: Error) => void;
    }
  >();

  let resolveClose!: () => void;
  const closePromise = new Promise<void>((res) => {
    resolveClose = res;
  });

  const clearAllTimers = () => {
    if (timeoutTimer !== null) {
      clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }
    if (cancelDelayTimer !== null) {
      clearTimeout(cancelDelayTimer);
      cancelDelayTimer = null;
    }
    if (killGraceTimer !== null) {
      clearTimeout(killGraceTimer);
      killGraceTimer = null;
    }
    if (forceDestroyTimer !== null) {
      clearTimeout(forceDestroyTimer);
      forceDestroyTimer = null;
    }
    if (postResultTimer !== null) {
      clearTimeout(postResultTimer);
      postResultTimer = null;
    }
  };

  const rejectAllPending = (reason: Error) => {
    for (const [id, entry] of pendingRequests.entries()) {
      pendingRequests.delete(id);
      entry.reject(reason);
    }
  };

  const writeJsonRpc = (payload: Record<string, unknown>): boolean => {
    if (closed || !proc.stdin || proc.stdin.destroyed || !proc.stdin.writable) {
      return false;
    }
    try {
      proc.stdin.write(`${JSON.stringify(payload)}\n`);
      return true;
    } catch {
      return false;
    }
  };

  const terminateProcessGroup = () => {
    if (closed || killEscalationStarted) {
      return;
    }
    killEscalationStarted = true;
    try {
      proc.stdin?.end();
    } catch {
      // Ignore stdin close error.
    }
    signalProcessGroup(proc, "SIGTERM");
    const grace = Math.max(0, killGraceMs);
    killGraceTimer = setTimeout(() => {
      killGraceTimer = null;
      if (!closed) {
        signalProcessGroup(proc, "SIGKILL");
        forceDestroyTimer = setTimeout(() => {
          forceDestroyTimer = null;
          if (!closed) {
            proc.stdin?.destroy();
            proc.stdout?.destroy();
            proc.stderr?.destroy();
            closed = true;
            rejectAllPending(new Error("ACP process force-killed"));
            resolveClose();
          }
        }, 150);
      }
    }, grace);
  };

  const sendCancelNotification = () => {
    if (activeSessionId) {
      writeJsonRpc({
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId: activeSessionId },
      });
    }
  };

  const handleAbort = () => {
    if (cancelled) return;
    cancelled = true;
    graceTerminated = false;
    sendCancelNotification();
    rejectAllPending(new Error("Run cancelled by AbortSignal"));
    if (activeSessionId && !closed) {
      // Brief flush window so child ACP server receives session/cancel on stdin before SIGTERM
      const flushMs = Math.min(30, Math.max(10, Math.floor(killGraceMs / 4)));
      cancelDelayTimer = setTimeout(() => {
        cancelDelayTimer = null;
        terminateProcessGroup();
      }, flushMs);
    } else {
      terminateProcessGroup();
    }
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
      if (!closed && !cancelled) {
        timedOut = true;
        sendCancelNotification();
        rejectAllPending(new Error(`ACP run timed out after ${timeoutMs}ms`));
        terminateProcessGroup();
      }
    }, timeoutMs);
  }

  const recordIncrementalUsage = (u: RunUsage | null) => {
    if (!u) return;
    if (u.input !== undefined) {
      incUsage.input += u.input;
      incUsage.hasInput = true;
    }
    if (u.output !== undefined) {
      incUsage.output += u.output;
      incUsage.hasOutput = true;
    }
    if (u.cached !== undefined) {
      incUsage.cached += u.cached;
      incUsage.hasCached = true;
    }
    if (u.cost !== undefined) {
      incUsage.cost += u.cost;
      incUsage.hasCost = true;
    }
  };

  const handleSessionUpdate = (params: Record<string, unknown>) => {
    if (!acceptingPromptUpdates) {
      return;
    }

    const updateObj = asRecord(params.update) ?? params;
    const kind = (
      nonEmptyString(updateObj.sessionUpdate) ??
      nonEmptyString(updateObj.type) ??
      ""
    ).toLowerCase();

    if (
      kind === "agent_message_chunk" ||
      kind === "assistant_message_chunk" ||
      kind === "text" ||
      kind === "text_delta"
    ) {
      const chunkText =
        extractTextFromAcpContent(updateObj.content) ||
        (typeof updateObj.text === "string" ? updateObj.text : "") ||
        extractTextFromAcpContent(updateObj.message);
      if (chunkText.length > 0) {
        accumulatedChunks += chunkText;
      }
    } else if (kind === "agent_message" || kind === "message") {
      const role =
        typeof updateObj.role === "string" ? updateObj.role.toLowerCase() : "";
      if (role !== "user" && role !== "system") {
        const msgText =
          extractTextFromAcpContent(updateObj.content) ||
          extractTextFromAcpContent(updateObj.message) ||
          (typeof updateObj.text === "string" ? updateObj.text : "");
        if (msgText.length > 0) {
          fallbackMessageText = msgText;
        }
      }
    }

    const usageCandidate =
      asRecord(params.usage) ??
      asRecord(updateObj.usage) ??
      (kind === "usage_update" || kind === "usage" ? updateObj : null);
    if (usageCandidate) {
      recordIncrementalUsage(readUsageFields(usageCandidate));
    }
  };

  const handleFsReadTextFile = (
    params: Record<string, unknown>,
  ): Record<string, unknown> => {
    const guard = loadGuardState(
      guardFile,
      contextFile,
      job,
      expandedCwd,
      envCtx,
    );
    if (!guard) {
      throw new AcpRpcError(-32000, GUARD_CORRUPT_DENY_REASON);
    }

    const rawPath = nonEmptyString(params.path) ?? nonEmptyString(params.uri);
    if (!rawPath) {
      throw new AcpRpcError(
        -32602,
        "fs/read_text_file requires a non-empty path",
      );
    }

    const baseDir = guard.cpSpec.normCwd || expandedCwd;
    const normPath = normalizeComparablePath(rawPath, baseDir, envCtx);
    if (
      isNoAccessControlPath(normPath, guard.cpSpec) ||
      isDbControlPath(normPath, guard.cpSpec)
    ) {
      throw new AcpRpcError(-32000, CONTROL_PLANE_DENY_REASON);
    }

    const expanded = expandEnvVarsInPath(rawPath, envCtx);
    const resolvedFile = path.isAbsolute(expanded)
      ? path.resolve(expanded)
      : path.resolve(baseDir, expanded);

    let content: string;
    try {
      content = readFileSync(resolvedFile, "utf8");
    } catch (err) {
      throw new AcpRpcError(
        -32000,
        err instanceof Error ? err.message : String(err),
      );
    }

    const lineParam = finiteNumber(params.line);
    const limitParam = finiteNumber(params.limit);
    if (lineParam !== undefined || limitParam !== undefined) {
      const lines = content.split(/\r?\n/);
      const startIdx =
        lineParam !== undefined && lineParam > 1
          ? Math.floor(lineParam) - 1
          : 0;
      const sliced =
        limitParam !== undefined && limitParam >= 0
          ? lines.slice(startIdx, startIdx + Math.floor(limitParam))
          : lines.slice(startIdx);
      return { content: sliced.join("\n") };
    }

    return { content };
  };

  const handleFsWriteTextFile = (
    params: Record<string, unknown>,
  ): Record<string, unknown> => {
    const guard = loadGuardState(
      guardFile,
      contextFile,
      job,
      expandedCwd,
      envCtx,
    );
    if (!guard) {
      throw new AcpRpcError(-32000, GUARD_CORRUPT_DENY_REASON);
    }
    if (guard.access === "read") {
      throw new AcpRpcError(-32000, READ_ONLY_DENY_REASON);
    }

    const rawPath = nonEmptyString(params.path) ?? nonEmptyString(params.uri);
    if (!rawPath || typeof params.content !== "string") {
      throw new AcpRpcError(
        -32602,
        "fs/write_text_file requires path (string) and content (string)",
      );
    }

    const baseDir = guard.cpSpec.normCwd || expandedCwd;
    const normPath = normalizeComparablePath(rawPath, baseDir, envCtx);
    if (isProtectedGlobalConfigPath(normPath)) {
      throw new AcpRpcError(-32000, GLOBAL_CONFIG_DENY_REASON);
    }
    if (isNoWriteControlPath(normPath, guard.cpSpec)) {
      throw new AcpRpcError(-32000, CONTROL_PLANE_DENY_REASON);
    }

    const expanded = expandEnvVarsInPath(rawPath, envCtx);
    const resolvedFile = path.isAbsolute(expanded)
      ? path.resolve(expanded)
      : path.resolve(baseDir, expanded);

    try {
      mkdirSync(path.dirname(resolvedFile), { recursive: true });
      writeFileSync(resolvedFile, params.content, "utf8");
    } catch (err) {
      throw new AcpRpcError(
        -32000,
        err instanceof Error ? err.message : String(err),
      );
    }

    return {};
  };

  const handleReverseRequest = (
    id: unknown,
    method: string,
    params: Record<string, unknown>,
  ) => {
    try {
      if (method === "session/request_permission") {
        const guard = loadGuardState(
          guardFile,
          contextFile,
          job,
          expandedCwd,
          envCtx,
        );
        const allowed = evaluatePermissionRequest(params, guard, envCtx);
        const result = selectPermissionResponse(params.options, allowed);
        writeJsonRpc({ jsonrpc: "2.0", id, result });
        return;
      }

      if (method === "fs/read_text_file") {
        const result = handleFsReadTextFile(params);
        writeJsonRpc({ jsonrpc: "2.0", id, result });
        return;
      }

      if (method === "fs/write_text_file") {
        const result = handleFsWriteTextFile(params);
        writeJsonRpc({ jsonrpc: "2.0", id, result });
        return;
      }

      if (method.startsWith("terminal/")) {
        const guard = loadGuardState(
          guardFile,
          contextFile,
          job,
          expandedCwd,
          envCtx,
        );
        if (!guard || guard.access === "read") {
          writeJsonRpc({
            jsonrpc: "2.0",
            id,
            error: { code: -32000, message: READ_ONLY_DENY_REASON },
          });
          return;
        }
      }

      writeJsonRpc({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
    } catch (err) {
      const code = err instanceof AcpRpcError ? err.code : -32603;
      const message = err instanceof Error ? err.message : String(err);
      writeJsonRpc({
        jsonrpc: "2.0",
        id,
        error: { code, message },
      });
    }
  };

  const dispatchParsedJson = (parsed: unknown) => {
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        dispatchParsedJson(item);
      }
      return;
    }
    const msg = asRecord(parsed);
    if (!msg) return;

    const method = typeof msg.method === "string" ? msg.method : null;
    const hasId = msg.id !== undefined && msg.id !== null;

    if (method !== null && hasId) {
      handleReverseRequest(msg.id, method, asRecord(msg.params) ?? {});
      return;
    }

    if (method !== null && !hasId) {
      if (method === "session/update") {
        handleSessionUpdate(asRecord(msg.params) ?? {});
      }
      return;
    }

    if (method === null && hasId) {
      const key = String(msg.id);
      const pending = pendingRequests.get(key);
      if (!pending) return;
      pendingRequests.delete(key);

      if (msg.error !== undefined && msg.error !== null) {
        const errRec = asRecord(msg.error);
        const code = finiteNumber(errRec?.code) ?? -32000;
        const message =
          nonEmptyString(errRec?.message) ??
          (typeof msg.error === "string" ? msg.error : "ACP JSON-RPC error");
        pending.reject(new AcpRpcError(code, message, errRec?.data));
      } else {
        pending.resolve(msg.result);
      }
    }
  };

  const drainStdout = (eof: boolean) => {
    while (stdoutBuf.length > 0) {
      stdoutBuf = skipLeadingWhitespaceBytes(stdoutBuf);
      if (stdoutBuf.length === 0) break;

      const preview = stdoutBuf
        .subarray(0, Math.min(stdoutBuf.length, 128))
        .toString("ascii");

      if (/^(?:content-length|content-type)\s*:/i.test(preview)) {
        const term = findHeaderTerminator(stdoutBuf);
        if (!term) {
          if (eof) {
            stdoutBuf = Buffer.alloc(0);
          }
          break;
        }
        const headerStr = stdoutBuf.subarray(0, term.index).toString("ascii");
        const clMatch = /(?:^|\r?\n)content-length\s*:\s*(\d+)/i.exec(
          headerStr,
        );
        if (!clMatch) {
          stdoutBuf = stdoutBuf.subarray(term.index + term.length);
          continue;
        }
        const contentLen = Number(clMatch[1]);
        const bodyStart = term.index + term.length;
        if (stdoutBuf.length < bodyStart + contentLen) {
          if (eof) {
            stdoutBuf = Buffer.alloc(0);
          }
          break;
        }
        const jsonText = stdoutBuf
          .subarray(bodyStart, bodyStart + contentLen)
          .toString("utf8");
        stdoutBuf = stdoutBuf.subarray(bodyStart + contentLen);
        try {
          dispatchParsedJson(JSON.parse(jsonText));
        } catch {
          // Ignore malformed JSON body.
        }
        continue;
      }

      const nlIdx = stdoutBuf.indexOf(0x0a);
      if (nlIdx === -1) {
        if (eof) {
          const tail = stdoutBuf.toString("utf8").trim();
          stdoutBuf = Buffer.alloc(0);
          if (tail.startsWith("{") || tail.startsWith("[")) {
            try {
              dispatchParsedJson(JSON.parse(tail));
            } catch {
              // Ignore trailing noise.
            }
          }
        }
        break;
      }

      const line = stdoutBuf
        .subarray(0, nlIdx)
        .toString("utf8")
        .replace(/\r$/, "")
        .trim();
      stdoutBuf = stdoutBuf.subarray(nlIdx + 1);
      if (line.length === 0) continue;
      if (line.startsWith("{") || line.startsWith("[")) {
        try {
          dispatchParsedJson(JSON.parse(line));
        } catch {
          // Ignore non-JSON diagnostic noise line.
        }
      }
    }
  };

  proc.stdout?.on("data", (chunk: Buffer | string) => {
    const bufChunk = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk, "utf8");
    stdoutBuf =
      stdoutBuf.length === 0 ? bufChunk : Buffer.concat([stdoutBuf, bufChunk]);
    drainStdout(false);
  });

  proc.stderr?.setEncoding("utf8");
  proc.stderr?.on("data", (chunk: string) => {
    if (stderrBuf.length < MAX_STDERR_CHARS) {
      stderrBuf += chunk.slice(0, MAX_STDERR_CHARS - stderrBuf.length);
    }
  });

  proc.on("error", (err: Error) => {
    spawnError = err;
    closed = true;
    rejectAllPending(err);
    resolveClose();
  });

  proc.on("close", (code: number | null, exitSig: NodeJS.Signals | null) => {
    if (!closed) {
      drainStdout(true);
      closed = true;
      closeCode = code;
      closeSignal = exitSig;
      rejectAllPending(
        new Error(
          stderrBuf.trim() ||
            (exitSig
              ? `ACP process killed by signal ${exitSig}`
              : `ACP process exited early with code ${code ?? "null"}`),
        ),
      );
      resolveClose();
    }
  });

  const sendRequest = (
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> => {
    if (cancelled) {
      return Promise.reject(new Error("Run cancelled by AbortSignal"));
    }
    if (timedOut) {
      return Promise.reject(
        new Error(`ACP run timed out after ${timeoutMs}ms`),
      );
    }
    if (spawnError) {
      return Promise.reject(spawnError);
    }
    if (closed) {
      return Promise.reject(
        new Error(stderrBuf.trim() || "ACP process already closed"),
      );
    }

    const id = nextRequestId++;
    return new Promise<unknown>((resolve, reject) => {
      const key = String(id);
      pendingRequests.set(key, { resolve, reject });
      const ok = writeJsonRpc({ jsonrpc: "2.0", id, method, params });
      if (!ok) {
        pendingRequests.delete(key);
        reject(new Error("Failed to write JSON-RPC request to ACP stdin"));
      }
    });
  };

  const buildFinalUsage = (): RunUsage | undefined => {
    const inc: RunUsage = {};
    if (incUsage.hasInput) inc.input = incUsage.input;
    if (incUsage.hasOutput) inc.output = incUsage.output;
    if (incUsage.hasCached) inc.cached = incUsage.cached;
    if (incUsage.hasCost) inc.cost = incUsage.cost;
    const hasAnyInc =
      incUsage.hasInput ||
      incUsage.hasOutput ||
      incUsage.hasCached ||
      incUsage.hasCost;

    if (finalPromptUsage) {
      const merged: RunUsage = { ...finalPromptUsage };
      if (merged.input === undefined && inc.input !== undefined) {
        merged.input = inc.input;
      }
      if (merged.output === undefined && inc.output !== undefined) {
        merged.output = inc.output;
      }
      if (merged.cached === undefined && inc.cached !== undefined) {
        merged.cached = inc.cached;
      }
      if (merged.cost === undefined && inc.cost !== undefined) {
        merged.cost = inc.cost;
      }
      return merged;
    }
    return hasAnyInc ? inc : undefined;
  };

  try {
    // Step 1: initialize
    await sendRequest("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: configuredAccess !== "read",
        },
        terminal: configuredAccess !== "read",
      },
      clientInfo: {
        name: "antigravity-autoloop",
        version: "1.2.0",
      },
    });

    // Step 2: session/load or session/new
    const requestedSession = nonEmptyString(job.session);
    if (requestedSession) {
      let loadRes: unknown;
      try {
        loadRes = await sendRequest("session/load", {
          sessionId: requestedSession,
          cwd: expandedCwd,
          mcpServers: [],
        });
      } catch (err) {
        terminateProcessGroup();
        await closePromise;
        if (cancelled) {
          throw err;
        }
        if (timedOut) {
          throw err;
        }
        const detail = err instanceof Error ? err.message : String(err);
        const summary = `ACP session/load failed: ${detail}`;
        return {
          started: false,
          exitCode: 1,
          timedOut: false,
          cancelled: false,
          session: null,
          outcome: "failed",
          summary,
          rawText: "",
          parsed: failedParsed(summary),
          error: summary,
        };
      }
      activeSessionId =
        nonEmptyString(asRecord(loadRes)?.sessionId) ?? requestedSession;
    } else {
      const newRes = asRecord(
        await sendRequest("session/new", {
          cwd: expandedCwd,
          mcpServers: [],
        }),
      );
      const createdId =
        nonEmptyString(newRes?.sessionId) ??
        nonEmptyString(newRes?.session_id) ??
        nonEmptyString(newRes?.id);
      if (!createdId) {
        throw new Error("ACP session/new response did not include a sessionId");
      }
      activeSessionId = createdId;
    }

    started = true;
    onStarted?.({ session: activeSessionId, pid: proc.pid });

    // Optional best-effort session/set_model
    const modelId = nonEmptyString(job.agent.model);
    if (modelId) {
      try {
        await sendRequest("session/set_model", {
          sessionId: activeSessionId,
          modelId,
        });
      } catch (err) {
        // Ignore unsupported / method-not-found or model switch errors on compliant ACP servers
        if (!(err instanceof AcpRpcError)) {
          throw err;
        }
      }
    }

    // Step 3 & 4: session/prompt + streaming session/update + reverse RPC gates
    accumulatedChunks = "";
    fallbackMessageText = "";
    acceptingPromptUpdates = true;

    const promptRes = asRecord(
      await sendRequest("session/prompt", {
        sessionId: activeSessionId,
        prompt: [{ type: "text", text: promptText }],
      }),
    );

    acceptingPromptUpdates = false;

    if (promptRes) {
      const resUsageObj = asRecord(promptRes.usage) ?? promptRes;
      const u = readUsageFields(resUsageObj);
      if (u) {
        finalPromptUsage = u;
      }
      if (!accumulatedChunks && !fallbackMessageText) {
        fallbackMessageText =
          extractTextFromAcpContent(promptRes.content) ||
          extractTextFromAcpContent(promptRes.message) ||
          (typeof promptRes.text === "string" ? promptRes.text : "");
      }
    }

    // Step 5: Gracefully close stdin and reap resident ACP server after postResultGraceMs
    if (timeoutTimer !== null) {
      clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }
    try {
      proc.stdin?.end();
    } catch {
      // Ignore close error.
    }

    if (!closed) {
      postResultTimer = setTimeout(() => {
        postResultTimer = null;
        if (!closed && !cancelled) {
          graceTerminated = true;
          terminateProcessGroup();
        }
      }, effectivePostGraceMs);
    }

    await closePromise;

    const fullText = accumulatedChunks || fallbackMessageText;
    const parsed = readMessage(fullText);
    const usage = buildFinalUsage();

    if (cancelled) {
      return {
        outcome: "cancelled",
        summary: parsed.summary,
        rawText: fullText,
        parsed,
        session: activeSessionId,
        started: true,
        usage,
        error: "Run cancelled by AbortSignal",
        exitCode: closeCode,
        timedOut: false,
        cancelled: true,
      };
    }

    void graceTerminated;
    return {
      outcome: parsed.outcome,
      summary: parsed.summary,
      rawText: fullText,
      parsed,
      session: activeSessionId,
      started: true,
      usage,
      error:
        parsed.outcome === "failed"
          ? (parsed.problem ?? (parsed.summary || undefined))
          : undefined,
      exitCode: 0,
      timedOut: false,
      cancelled: false,
    };
  } catch (err) {
    acceptingPromptUpdates = false;
    if (!cancelled) {
      terminateProcessGroup();
    }
    await closePromise;

    const fullText = accumulatedChunks || fallbackMessageText;
    const parsed = fullText ? readMessage(fullText) : failedParsed("");
    const usage = buildFinalUsage();
    const effectiveSession = started ? activeSessionId : null;

    if (cancelled) {
      return {
        outcome: "cancelled",
        summary: parsed.summary,
        rawText: fullText,
        parsed,
        session: effectiveSession,
        started,
        usage,
        error: "Run cancelled by AbortSignal",
        exitCode: closeCode,
        timedOut: false,
        cancelled: true,
      };
    }

    if (timedOut) {
      return {
        outcome: "failed",
        summary: "",
        rawText: fullText,
        parsed,
        session: effectiveSession,
        started,
        usage,
        error: `ACP run timed out after ${timeoutMs}ms`,
        exitCode: closeCode,
        timedOut: true,
        cancelled: false,
      };
    }

    if (spawnError) {
      return {
        outcome: "failed",
        summary: "",
        rawText: fullText,
        parsed,
        session: effectiveSession,
        started,
        usage,
        error: spawnError.message,
        exitCode: null,
        timedOut: false,
        cancelled: false,
      };
    }

    const detail =
      err instanceof Error
        ? err.message
        : stderrBuf.trim() ||
          (closeSignal
            ? `ACP process killed by signal ${closeSignal}`
            : `ACP process exited with code ${closeCode ?? 1}`);

    return {
      outcome: "failed",
      summary: "",
      rawText: fullText,
      parsed,
      session: effectiveSession,
      started,
      usage,
      error: detail,
      exitCode: closeCode && closeCode !== 0 ? closeCode : 1,
      timedOut: false,
      cancelled: false,
    };
  } finally {
    clearAllTimers();
    if (signal) {
      signal.removeEventListener("abort", handleAbort);
    }
  }
}
