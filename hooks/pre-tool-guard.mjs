#!/usr/bin/env node
/**
 * Antigravity PreToolUse lifecycle guard for Autoloop runs.
 * - Zero-interference fast path when AUTOLOOP_GUARD_FILE is unset or missing.
 * - Enforces `access === "read"` against file-mutating tools and write commands.
 * - Enforces built-in catastrophic redlines and `askFirst` policies unless
 *   explicitly authorized in `approvedKeys` (via strict token-boundary matching).
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const READ_ONLY_DENY_REASON =
  "当前 Autoloop 规则为只读模式 (access=read)，禁止修改文件。";
const ASK_FIRST_DENY_REASON =
  "该操作触碰 Autoloop askFirst 安全红线且尚未获得批奏折授权。请勿强行执行，改为在回复末尾输出 agent-autoloop ask 回执卡片请示用户。";
const CONFIG_PROTECT_DENY_REASON =
  "Autoloop 安全红线禁止修改 Antigravity 全局 ~/.gemini/config/config.json 配置文件。";
const GUARD_CORRUPT_DENY_REASON =
  "Autoloop 运行护栏文件 (guard.json) 读取或解析失败，按 fail-closed 安全策略拒绝执行。";

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
]);

const DELETE_TOOL_NAMES = new Set(["delete_file", "remove_file"]);

const FILE_ARG_KEYS = new Set([
  "targetfile",
  "absolutepath",
  "path",
  "filepath",
  "file_path",
  "file",
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

const HIGH_RISK_CATEGORIES = [
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
      "数据库删除",
      "删除生产数据",
    ],
    patternMatches: [
      /\bdrop\s+(?:table|database|schema)\b/i,
      /\btruncate\s+table\b/i,
      /数据库删除/,
      /删除生产数据/,
    ],
  },
];

function respond(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      resolve(data);
    });
    process.stdin.on("error", () => {
      resolve(data);
    });
  });
}

function normalizeToken(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Match `target` against `candidate` strictly on `-` token boundaries,
 * preventing short tokens like "rm" from matching inside "confirm" or "format".
 */
function matchesTokenBoundary(candidate, target) {
  if (!candidate || !target) return false;
  if (candidate === target) return true;
  const boundaryRe = new RegExp(`(?:^|-)${escapeRegExp(target)}(?:-|$)`);
  return boundaryRe.test(candidate);
}

function expandHome(p) {
  if (typeof p !== "string" || p.length === 0) return "";
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function normalizeComparablePath(targetPath) {
  const expanded = expandHome(targetPath);
  const resolved = path.resolve(expanded);
  let canonical = resolved;
  try {
    if (existsSync(resolved)) {
      canonical = realpathSync(resolved);
    }
  } catch {
    // Keep path.resolve result when realpath cannot be read.
  }
  if (canonical.startsWith("/private/tmp/")) {
    return canonical.slice("/private".length);
  }
  if (canonical === "/private/tmp") {
    return "/tmp";
  }
  if (canonical.startsWith("/private/var/")) {
    return canonical.slice("/private".length);
  }
  if (canonical === "/private/var") {
    return "/var";
  }
  return canonical;
}

function isStrictlyInside(childPath, parentPath) {
  const rel = path.relative(parentPath, childPath);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function splitShellSegments(commandLine) {
  const segments = [];
  let current = "";
  let quote = null;
  let escaped = false;

  for (let i = 0; i < commandLine.length; i++) {
    const ch = commandLine[i];
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

function tokenizeSegment(segment) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaped = false;

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
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

function unwrapCommandTokens(tokens) {
  let idx = 0;
  while (idx < tokens.length) {
    const tok = tokens[idx];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) {
      idx += 1;
      continue;
    }
    if (
      tok === "sudo" ||
      tok === "env" ||
      tok === "command" ||
      tok === "nohup"
    ) {
      idx += 1;
      continue;
    }
    break;
  }
  return tokens.slice(idx);
}

/**
 * Parse a `git` invocation skipping global pre-subcommand options
 * (e.g. `-C <dir>`, `-c <k=v>`, `--git-dir <dir>`, `--work-tree <dir>`, `--no-pager`)
 * so subcommand checks cannot be bypassed with `git -C repo <subcommand>`.
 */
function parseGitSegment(tokens) {
  if (tokens.length === 0) return null;
  const cmdBase = path.basename(tokens[0]).toLowerCase();
  if (cmdBase !== "git") return null;

  let i = 1;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok === "--") {
      i += 1;
      break;
    }
    if (!tok.startsWith("-")) {
      break;
    }
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
  return {
    subcommand: tokens[i].toLowerCase(),
    args: tokens.slice(i + 1),
  };
}

function isGitForcePush(gitInfo) {
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

function isGitResetHard(gitInfo) {
  if (!gitInfo || gitInfo.subcommand !== "reset") return false;
  return gitInfo.args.some((arg) => arg === "--hard");
}

function analyzeRmSegment(tokens, guardCwd) {
  if (tokens.length === 0) return null;
  const cmdBase = path.basename(tokens[0]).toLowerCase();
  if (cmdBase !== "rm") return null;

  let recursive = false;
  let force = false;
  let endOfFlags = false;
  const targets = [];

  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i];
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
  const normCwd = guardCwd ? normalizeComparablePath(guardCwd) : null;

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
        ? normalizeComparablePath(target)
        : normalizeComparablePath(path.resolve(normCwd, target));
      if (!isStrictlyInside(resolvedTarget, normCwd)) {
        outOfBounds = true;
        break;
      }
    }
  }

  return {
    isRm: true,
    recursive,
    force,
    isRecursiveForce: recursive && force,
    outOfBounds,
    targets,
  };
}

function touchesProtectedConfig(commandLine, filePath) {
  const configSuffix = path.join(".gemini", "config", "config.json");
  if (typeof filePath === "string" && filePath.length > 0) {
    const norm = normalizeComparablePath(filePath);
    if (norm.endsWith(configSuffix)) {
      return true;
    }
  }
  if (typeof commandLine === "string" && commandLine.length > 0) {
    if (/\.gemini\/config\/config\.json/i.test(commandLine)) {
      const segments = splitShellSegments(commandLine);
      for (const seg of segments) {
        if (!/\.gemini\/config\/config\.json/i.test(seg)) continue;
        const toks = unwrapCommandTokens(tokenizeSegment(seg));
        const cmd = path.basename(toks[0] ?? "").toLowerCase();
        const hasRedirect = /(?:^|[^0-9&])>{1,2}/.test(seg);
        const passive =
          !hasRedirect &&
          new Set([
            "cat",
            "head",
            "tail",
            "ls",
            "stat",
            "grep",
            "rg",
            "jq",
          ]).has(cmd);
        if (!passive) {
          return true;
        }
      }
    }
  }
  return false;
}

function isApprovedFor(approvedKeys, categoryId, pattern) {
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

function detectCategories(commandLine) {
  const categories = new Set();
  const normalized = commandLine.replace(/\s+/g, " ").trim();
  const segments = splitShellSegments(commandLine);

  for (const seg of segments) {
    const toks = unwrapCommandTokens(tokenizeSegment(seg));
    const rmInfo = analyzeRmSegment(toks, null);
    if (rmInfo && (rmInfo.recursive || rmInfo.force)) {
      categories.add("rm-rf");
    }
    const gitInfo = parseGitSegment(toks);
    if (isGitForcePush(gitInfo)) {
      categories.add("git-push-force");
    }
    if (isGitResetHard(gitInfo)) {
      categories.add("git-reset-hard");
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

function commandMatchesPattern(commandLine, pattern) {
  const normCmd = commandLine.replace(/\s+/g, " ").trim().toLowerCase();
  const normPat = String(pattern ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!normPat) return false;

  if (normCmd.includes(normPat)) {
    return true;
  }

  const segments = splitShellSegments(commandLine);
  // Also compare against git segments with global options stripped
  for (const seg of segments) {
    const toks = unwrapCommandTokens(tokenizeSegment(seg));
    const gitInfo = parseGitSegment(toks);
    if (gitInfo && gitInfo.subcommand) {
      const normalizedGit = ["git", gitInfo.subcommand, ...gitInfo.args]
        .join(" ")
        .toLowerCase();
      if (normalizedGit.includes(normPat)) {
        return true;
      }
    }
  }

  for (const cat of HIGH_RISK_CATEGORIES) {
    const patternHitsCat = cat.patternMatches.some((re) => re.test(normPat));
    if (!patternHitsCat) continue;

    if (cat.id === "rm-rf") {
      for (const seg of segments) {
        const toks = unwrapCommandTokens(tokenizeSegment(seg));
        const cmd = path.basename(toks[0] ?? "").toLowerCase();
        if (cmd === "rm" || cmd === "rmdir" || cmd === "unlink") {
          return true;
        }
      }
      if (/\bfind\b[^\n;|&]*-delete\b/i.test(normCmd)) return true;
    }

    if (cat.id === "git-push-force") {
      for (const seg of segments) {
        const toks = unwrapCommandTokens(tokenizeSegment(seg));
        if (isGitForcePush(parseGitSegment(toks))) {
          return true;
        }
      }
    }

    if (cat.id === "git-reset-hard") {
      for (const seg of segments) {
        const toks = unwrapCommandTokens(tokenizeSegment(seg));
        if (isGitResetHard(parseGitSegment(toks))) {
          return true;
        }
      }
    }

    if (cat.id === "drop-db") {
      if (
        /\b(?:drop\s+(?:table|database|schema)|truncate\s+table)\b/i.test(
          normCmd,
        )
      ) {
        return true;
      }
    }
  }

  return false;
}

function isWriteShellCommand(commandLine) {
  const segments = splitShellSegments(commandLine);
  const mutatingCommands = new Set([
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
  ]);
  const mutatingGitSubcommands = new Set([
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

  for (const seg of segments) {
    const redirectMatch = /(?:^|[^0-9&])(>{1,2})\s*(\S+)/.exec(seg);
    if (
      redirectMatch &&
      redirectMatch[2] !== "/dev/null" &&
      !redirectMatch[2].startsWith("&")
    ) {
      return true;
    }

    const toks = unwrapCommandTokens(tokenizeSegment(seg));
    if (toks.length === 0) continue;
    const cmd = path.basename(toks[0]).toLowerCase();

    if (mutatingCommands.has(cmd)) {
      return true;
    }
    if (
      cmd === "sed" &&
      toks.some((t) => t === "-i" || t.startsWith("-i") || t === "--in-place")
    ) {
      return true;
    }
    if (cmd === "perl" && toks.some((t) => t === "-i" || t.startsWith("-i"))) {
      return true;
    }
    const gitInfo = parseGitSegment(toks);
    if (gitInfo && mutatingGitSubcommands.has(gitInfo.subcommand)) {
      return true;
    }
    if (cmd === "find" && toks.some((t) => t === "-delete")) {
      return true;
    }
  }

  return false;
}

function extractFileArg(args) {
  if (!args || typeof args !== "object") return "";
  for (const [key, value] of Object.entries(args)) {
    if (
      FILE_ARG_KEYS.has(key.toLowerCase()) &&
      typeof value === "string" &&
      value.trim().length > 0
    ) {
      return value.trim();
    }
  }
  return "";
}

function extractCommandLine(args) {
  if (!args || typeof args !== "object") return "";
  for (const key of ["CommandLine", "commandLine", "command", "cmd"]) {
    if (typeof args[key] === "string") {
      return args[key];
    }
  }
  return "";
}

async function main() {
  const stdinRaw = await readStdin();

  const guardFile = process.env.AUTOLOOP_GUARD_FILE;
  if (!guardFile || !existsSync(guardFile)) {
    respond({ decision: "allow" });
    return;
  }

  let guard;
  try {
    guard = JSON.parse(readFileSync(guardFile, "utf8"));
    if (!guard || typeof guard !== "object" || Array.isArray(guard)) {
      respond({ decision: "deny", reason: GUARD_CORRUPT_DENY_REASON });
      return;
    }
  } catch {
    respond({ decision: "deny", reason: GUARD_CORRUPT_DENY_REASON });
    return;
  }

  let payload = {};
  try {
    if (stdinRaw.trim().length > 0) {
      payload = JSON.parse(stdinRaw);
    }
  } catch {
    respond({ decision: "deny", reason: GUARD_CORRUPT_DENY_REASON });
    return;
  }

  const toolCall = payload?.toolCall ?? {};
  const toolName = String(toolCall?.name ?? "")
    .trim()
    .toLowerCase();
  const args =
    toolCall?.args && typeof toolCall.args === "object" ? toolCall.args : {};

  const access = typeof guard?.access === "string" ? guard.access : "edit";
  const guardCwd = typeof guard?.cwd === "string" ? guard.cwd : "";
  const askFirst = Array.isArray(guard?.askFirst)
    ? guard.askFirst
    : Array.isArray(guard?.askFirstPatterns)
      ? guard.askFirstPatterns
      : [];
  const approvedKeys = Array.isArray(guard?.approvedKeys)
    ? guard.approvedKeys
    : [];

  // 1. Write / edit / delete file tools
  if (WRITE_TOOL_NAMES.has(toolName)) {
    const targetFile = extractFileArg(args);
    if (touchesProtectedConfig("", targetFile)) {
      respond({ decision: "deny", reason: CONFIG_PROTECT_DENY_REASON });
      return;
    }
    if (access === "read") {
      respond({ decision: "deny", reason: READ_ONLY_DENY_REASON });
      return;
    }
    if (DELETE_TOOL_NAMES.has(toolName)) {
      for (const pat of askFirst) {
        const hitsDelete = HIGH_RISK_CATEGORIES[0].patternMatches.some((re) =>
          re.test(String(pat)),
        );
        if (hitsDelete && !isApprovedFor(approvedKeys, "rm-rf", pat)) {
          respond({ decision: "deny", reason: ASK_FIRST_DENY_REASON });
          return;
        }
      }
    }
    respond({ decision: "allow" });
    return;
  }

  // 2. Shell command execution
  if (toolName === "run_command") {
    const commandLine = extractCommandLine(args);

    // 2a. Always deny modifying ~/.gemini/config/config.json
    if (touchesProtectedConfig(commandLine, "")) {
      respond({ decision: "deny", reason: CONFIG_PROTECT_DENY_REASON });
      return;
    }

    // 2b. Always deny root or out-of-cwd recursive/forced rm
    const segments = splitShellSegments(commandLine);
    for (const seg of segments) {
      const toks = unwrapCommandTokens(tokenizeSegment(seg));
      const rmInfo = analyzeRmSegment(toks, guardCwd);
      if (rmInfo && (rmInfo.recursive || rmInfo.force) && rmInfo.outOfBounds) {
        respond({ decision: "deny", reason: ASK_FIRST_DENY_REASON });
        return;
      }
    }

    // 2c. Read-only mode denies write commands
    if (access === "read" && isWriteShellCommand(commandLine)) {
      respond({ decision: "deny", reason: READ_ONLY_DENY_REASON });
      return;
    }

    // 2d. Built-in high-risk command categories (require matching approvedKeys)
    const hitCategories = detectCategories(commandLine);
    for (const catId of hitCategories) {
      const matchingPatterns = askFirst.filter((p) =>
        commandMatchesPattern(commandLine, p),
      );
      const approvedByCat = isApprovedFor(approvedKeys, catId, undefined);
      const approvedByPattern = matchingPatterns.some((p) =>
        isApprovedFor(approvedKeys, catId, p),
      );
      if (!approvedByCat && !approvedByPattern) {
        respond({ decision: "deny", reason: ASK_FIRST_DENY_REASON });
        return;
      }
    }

    // 2e. Configured askFirst patterns (require matching approvedKeys)
    for (const pattern of askFirst) {
      if (commandMatchesPattern(commandLine, pattern)) {
        const matchedCat = HIGH_RISK_CATEGORIES.find((cat) =>
          cat.patternMatches.some((re) => re.test(String(pattern))),
        )?.id;
        if (!isApprovedFor(approvedKeys, matchedCat, pattern)) {
          respond({ decision: "deny", reason: ASK_FIRST_DENY_REASON });
          return;
        }
      }
    }
  }

  respond({ decision: "allow" });
}

main().catch(() => {
  const guardFile = process.env.AUTOLOOP_GUARD_FILE;
  if (guardFile && existsSync(guardFile)) {
    respond({ decision: "deny", reason: GUARD_CORRUPT_DENY_REASON });
  } else {
    respond({ decision: "allow" });
  }
});
