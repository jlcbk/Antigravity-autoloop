#!/usr/bin/env node
/**
 * Antigravity PreToolUse lifecycle guard for Autoloop runs.
 * - Zero-interference fast path when AUTOLOOP_GUARD_FILE is unset or missing.
 * - Self-protects `<AUTOLOOP_HOME>` control-plane secrets/DB/rules and `guard.json`
 *   against unauthorized reading or tampering.
 * - Enforces `access === "read"` against file-mutating tools, write commands,
 *   sub-shell (`sh`/`bash`/`zsh`/`dash -c`) writes, and interpreter `-e`/`-c` execution.
 * - Enforces built-in catastrophic redlines and `askFirst` policies (across
 *   `env`/`sudo` wrappers, sub-shells, and inline `node -e` / `python -c` scripts)
 *   unless explicitly authorized in `approvedKeys`.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const READ_ONLY_DENY_REASON =
  "当前 Autoloop 规则为只读模式 (access=read)，禁止修改文件或执行内联脚本。";
const ASK_FIRST_DENY_REASON =
  "该操作触碰 Autoloop askFirst 安全红线且尚未获得批奏折授权。请勿强行执行，改为在回复末尾输出 agent-autoloop ask 回执卡片请示用户。";
const CONFIG_PROTECT_DENY_REASON =
  "Autoloop 安全红线禁止修改 Antigravity 全局 ~/.gemini/config/config.json 配置文件。";
const CONTROL_PLANE_PROTECT_DENY_REASON =
  "Autoloop 安全红线禁止触碰受保护的控制面密钥、护栏文件 (guard.json / owner.token / master.key) 或篡改中台数据库与规则配置 (hub.db / rules.json)。";
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

const SEARCH_DIR_TOOL_NAMES = new Set([
  "grep_search",
  "grep",
  "ripgrep",
  "search_files",
]);

const FILE_ARG_KEYS = new Set([
  "targetfile",
  "absolutepath",
  "path",
  "filepath",
  "file_path",
  "file",
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

const NO_ACCESS_CONTROL_FILES = [
  "owner.token",
  "ingest.token",
  "master.key",
  "ipc.json",
];

const DB_CONTROL_FILES = ["hub.db", "hub.db-wal", "hub.db-shm"];

const TEXT_READONLY_CONTROL_FILES = ["rules.json"];

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

const PASSIVE_READ_COMMANDS = new Set([
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

const MAX_SUBSHELL_DEPTH = 5;

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

function matchesTokenBoundary(candidate, target) {
  if (!candidate || !target) return false;
  if (candidate === target) return true;
  const boundaryRe = new RegExp(`(?:^|-)${escapeRegExp(target)}(?:-|$)`);
  return boundaryRe.test(candidate);
}

function expandEnvAndHome(rawPath) {
  if (typeof rawPath !== "string" || rawPath.length === 0) return "";
  const home = os.homedir();
  let out = rawPath
    .replace(/\$\{AUTOLOOP_GUARD_FILE\}|\$AUTOLOOP_GUARD_FILE\b/g, () =>
      String(process.env.AUTOLOOP_GUARD_FILE ?? ""),
    )
    .replace(/\$\{AUTOLOOP_CONTEXT\}|\$AUTOLOOP_CONTEXT\b/g, () =>
      String(process.env.AUTOLOOP_CONTEXT ?? ""),
    )
    .replace(/\$\{AUTOLOOP_HOME\}|\$AUTOLOOP_HOME\b/g, () =>
      String(process.env.AUTOLOOP_HOME ?? ""),
    )
    .replace(/\$\{PLUGIN_DATA\}|\$PLUGIN_DATA\b/g, () =>
      String(process.env.PLUGIN_DATA ?? ""),
    )
    .replace(/\$\{HOME\}|\$HOME\b/g, () => home);
  if (out === "~") return home;
  if (out.startsWith("~/")) return path.join(home, out.slice(2));
  return out;
}

function stripDarwinPrivatePrefix(p) {
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

function resolveRealOrNearestParent(resolvedPath) {
  try {
    if (existsSync(resolvedPath)) {
      return realpathSync(resolvedPath);
    }
  } catch {
    // Fall through to ancestor check.
  }
  const parent = path.dirname(resolvedPath);
  if (parent && parent !== resolvedPath) {
    try {
      if (existsSync(parent)) {
        return path.join(realpathSync(parent), path.basename(resolvedPath));
      }
    } catch {
      // Keep path.resolve result.
    }
  }
  return resolvedPath;
}

function normalizeComparablePath(targetPath, baseDir = "") {
  const expanded = expandEnvAndHome(targetPath);
  if (!expanded) return "";
  const resolved =
    !path.isAbsolute(expanded) && baseDir
      ? path.resolve(baseDir, expanded)
      : path.resolve(expanded);
  const canonical = resolveRealOrNearestParent(resolved);
  return stripDarwinPrivatePrefix(canonical);
}

function isStrictlyInside(childPath, parentPath) {
  const rel = path.relative(parentPath, childPath);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function buildControlPlaneSpec(guardFile, guardCwd) {
  const normGuardFile = normalizeComparablePath(guardFile);
  const normCwd = guardCwd ? normalizeComparablePath(guardCwd) : "";
  const homes = new Set();

  // Derive <AUTOLOOP_HOME> from <AUTOLOOP_HOME>/runs/<run>-<attempt>/guard.json
  const guardParent = path.dirname(normGuardFile);
  const guardGrandParent = path.dirname(guardParent);
  if (path.basename(guardGrandParent) === "runs") {
    homes.add(path.dirname(guardGrandParent));
  } else if (guardParent && guardParent !== "/") {
    if (guardParent !== normCwd) {
      homes.add(guardParent);
    }
  }

  if (process.env.AUTOLOOP_HOME?.trim()) {
    homes.add(normalizeComparablePath(process.env.AUTOLOOP_HOME.trim()));
  }
  if (process.env.PLUGIN_DATA?.trim()) {
    homes.add(normalizeComparablePath(process.env.PLUGIN_DATA.trim()));
  }

  homes.add(
    normalizeComparablePath(
      path.join(os.homedir(), ".gemini", "antigravity", "autoloop_data"),
    ),
  );
  homes.add(normalizeComparablePath(path.join(os.homedir(), ".autoloop")));

  const noAccessExact = new Set([normGuardFile]);
  const dbProtectedExact = new Set();
  const textReadOnlyExact = new Set();

  if (process.env.AUTOLOOP_CONTEXT?.trim()) {
    textReadOnlyExact.add(
      normalizeComparablePath(process.env.AUTOLOOP_CONTEXT.trim()),
    );
  }

  for (const home of homes) {
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
    homes,
    noAccessExact,
    dbProtectedExact,
    textReadOnlyExact,
  };
}

function isNoAccessControlPath(normPath, cpSpec) {
  if (!normPath) return false;
  if (cpSpec.noAccessExact.has(normPath)) {
    return true;
  }
  if (path.basename(normPath) === "guard.json") {
    const runsDir = path.dirname(path.dirname(normPath));
    if (
      path.basename(runsDir) === "runs" &&
      cpSpec.homes.has(path.dirname(runsDir))
    ) {
      return true;
    }
  }
  return false;
}

function isDbControlPath(normPath, cpSpec) {
  if (!normPath) return false;
  return cpSpec.dbProtectedExact.has(normPath);
}

function isReadOnlyTextControlPath(normPath, cpSpec) {
  if (!normPath) return false;
  if (cpSpec.textReadOnlyExact.has(normPath)) {
    return true;
  }
  if (path.basename(normPath) === "context.json") {
    const runsDir = path.dirname(path.dirname(normPath));
    if (
      path.basename(runsDir) === "runs" &&
      cpSpec.homes.has(path.dirname(runsDir))
    ) {
      return true;
    }
  }
  return false;
}

function isNoWriteControlPath(normPath, cpSpec) {
  if (!normPath) return false;
  return (
    isNoAccessControlPath(normPath, cpSpec) ||
    isDbControlPath(normPath, cpSpec) ||
    isReadOnlyTextControlPath(normPath, cpSpec)
  );
}

function isProtectedGlobalConfigPath(normPath) {
  if (!normPath) return false;
  const configSuffix = path.join(".gemini", "config", "config.json");
  return normPath.endsWith(configSuffix);
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

function extractCommandSubstitutions(commandLine) {
  const subs = [];
  let quote = null;
  let escaped = false;

  for (let i = 0; i < commandLine.length; i++) {
    const ch = commandLine[i];
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

/**
 * Unwrap leading `K=V` assignments and `env` / `sudo` / `command` / `nohup` /
 * `nice` / `time` / `exec` wrappers together with their option flags & arguments.
 */
function unwrapCommandTokens(tokens) {
  let idx = 0;
  while (idx < tokens.length) {
    const tok = tokens[idx];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) {
      idx += 1;
      continue;
    }

    const base = path.basename(tok).toLowerCase();

    if (base === "env") {
      idx += 1;
      while (idx < tokens.length) {
        const opt = tokens[idx];
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
            const splitExtra = tokenizeSegment(tokens[idx + 1]);
            tokens = [
              ...tokens.slice(0, idx),
              ...splitExtra,
              ...tokens.slice(idx + 2),
            ];
            continue;
          }
          idx += 2;
          continue;
        }
        if (opt.startsWith("-S") && opt.length > 2) {
          const splitExtra = tokenizeSegment(opt.slice(2));
          tokens = [
            ...tokens.slice(0, idx),
            ...splitExtra,
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
        const opt = tokens[idx];
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
            const ch = flags[k];
            if (SUDO_OPTS_WITH_ARG.has(`-${ch}`)) {
              if (k === flags.length - 1) {
                consumesNext = true;
              }
              break;
            }
            if (!SUDO_BOOLEAN_SHORT_FLAGS.has(ch)) {
              break;
            }
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
        const opt = tokens[idx];
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
        const opt = tokens[idx];
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
        const opt = tokens[idx];
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

/**
 * Inspect unwrapped tokens for sub-shell `-c <script>` or interpreter `-e/-c <code>`.
 */
function extractEmbeddedExecution(tokens) {
  if (tokens.length === 0) return null;
  const cmd = path.basename(tokens[0]).toLowerCase();

  if (SHELL_NAMES.has(cmd)) {
    let i = 1;
    while (i < tokens.length) {
      const tok = tokens[i];
      if (tok === "--") break;
      if (tok === "-o" || tok === "+o") {
        i += 2;
        continue;
      }
      if (tok === "-c" || /^-[a-zA-Z]*c$/.test(tok)) {
        const script = tokens[i + 1];
        if (typeof script === "string") {
          return { kind: "shell", runtime: cmd, code: script };
        }
        return null;
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
      const tok = tokens[i];
      if (tok === "--") break;
      if (
        tok === "-e" ||
        tok === "--eval" ||
        tok === "-p" ||
        tok === "--print"
      ) {
        if (typeof tokens[i + 1] === "string") {
          return { kind: "interpreter", runtime: cmd, code: tokens[i + 1] };
        }
        return { kind: "interpreter", runtime: cmd, code: "" };
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
      const tok = tokens[i];
      if (tok === "--") break;
      if (tok === "-c" || /^-[IubBEsS]*c$/.test(tok)) {
        if (typeof tokens[i + 1] === "string") {
          return { kind: "interpreter", runtime: "python", code: tokens[i + 1] };
        }
        return { kind: "interpreter", runtime: "python", code: "" };
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
      const tok = tokens[i];
      if (tok === "--") break;
      if (
        ((cmd === "ruby" || cmd === "perl") &&
          (tok === "-e" || tok === "-E")) ||
        (cmd === "php" && tok === "-r")
      ) {
        return {
          kind: "interpreter",
          runtime: cmd,
          code: typeof tokens[i + 1] === "string" ? tokens[i + 1] : "",
        };
      }
      if (!tok.startsWith("-")) break;
    }
    return null;
  }

  return null;
}

/**
 * Recursively expand top-level shell segments, `$(...)`/backtick command substitutions,
 * and `sh`/`bash`/`zsh`/`dash -c` sub-shell scripts into analyzed segment entries.
 */
function collectEffectiveSegments(commandLine, depth = 0) {
  if (
    typeof commandLine !== "string" ||
    commandLine.length === 0 ||
    depth > MAX_SUBSHELL_DEPTH
  ) {
    return [];
  }

  const results = [];
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
        : normalizeComparablePath(target, normCwd);
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

function extractStringLiterals(code) {
  const literals = [];
  const re = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
  let match;
  while ((match = re.exec(code)) !== null) {
    if (match[2]) {
      literals.push(match[2]);
    }
  }
  return literals;
}

function extractCandidatePathsFromCode(code) {
  const candidates = new Set(extractStringLiterals(code));
  const barePathRe = /(?:~\/|\/)[A-Za-z0-9_./-]+/g;
  let m;
  while ((m = barePathRe.exec(code)) !== null) {
    if (m[0]) {
      candidates.add(m[0]);
    }
  }
  return Array.from(candidates);
}

function extractRedirectTargets(rawSeg) {
  const targets = [];
  const re = /(?:^|[^0-9&])>{1,2}\s*(['"]?)([^\s'";|&]+)\1/g;
  let m;
  while ((m = re.exec(rawSeg)) !== null) {
    if (m[2] && !m[2].startsWith("&") && m[2] !== "/dev/null") {
      targets.push(m[2]);
    }
  }
  return targets;
}

const TEXT_VIEWER_COMMANDS = new Set([
  ...PASSIVE_READ_COMMANDS,
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

function isGitApplyReadOnly(gitInfo) {
  if (!gitInfo || gitInfo.subcommand !== "apply") return false;
  return gitInfo.args.some(
    (arg) =>
      arg === "--stat" ||
      arg === "--numstat" ||
      arg === "--summary" ||
      arg === "--check",
  );
}

function isReadOnlyGitInvocation(gitInfo) {
  if (!gitInfo) return false;
  if (!gitInfo.subcommand) return true;
  if (READONLY_GIT_SUBCOMMANDS.has(gitInfo.subcommand)) return true;
  return isGitApplyReadOnly(gitInfo);
}

function isSafeReadCommandOnTextTarget(entry) {
  if (!entry || entry.embedded) return false;
  const toks = entry.tokens;
  if (toks.length === 0) return false;
  const cmd = path.basename(toks[0]).toLowerCase();

  if (TEXT_VIEWER_COMMANDS.has(cmd)) {
    return true;
  }

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
    const hasInplace = toks.some(
      (t) =>
        t === "-i" ||
        t.startsWith("-i") ||
        t === "--inplace" ||
        t === "inplace",
    );
    return !hasInplace;
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

  if (PYTHON_INTERPRETER_RE.test(cmd)) {
    return (
      toks[1] === "-m" &&
      toks[2] === "json.tool" &&
      toks.length <= 4
    );
  }

  if (cmd === "autoloop") {
    const sub = String(toks[1] ?? "").toLowerCase();
    return sub === "check" || sub === "explain" || sub === "status" || sub === "why";
  }

  if (NODE_INTERPRETERS.has(cmd) && /cli\/main\.[cm]?[jt]s$/i.test(toks[1] ?? "")) {
    const sub = String(toks[2] ?? "").toLowerCase();
    return sub === "check" || sub === "explain" || sub === "status" || sub === "why";
  }

  return false;
}

function inlineCodeHasWriteIntent(code) {
  if (!code) return false;
  const stripped = code.replace(
    /\b(?:process|sys)\s*\.\s*(?:stdout|stderr)\s*\.\s*write\b/g,
    " ",
  );

  if (
    /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|rmSync|rmdirSync|unlinkSync|renameSync|copyFileSync|cpSync|truncateSync|ftruncateSync|chmodSync|chownSync|utimesSync|linkSync|symlinkSync|writeSync)\b/.test(
      stripped,
    )
  ) {
    return true;
  }

  if (
    /\b(?:fs|fsp|fsPromises|promises|Bun)\s*\.\s*(?:write|writeFile|appendFile|rm|rmdir|unlink|rename|copyFile|cp|truncate|chmod|chown|utimes|link|symlink)\b/.test(
      stripped,
    )
  ) {
    return true;
  }

  if (
    /\bopen\s*\([^)]*(?:,\s*['"][^'"]*[wax+][^'"]*['"]|mode\s*=\s*['"][^'"]*[wax+])/.test(
      stripped,
    )
  ) {
    return true;
  }

  if (/\.write(?:_text|_bytes|lines)?\s*\(/.test(stripped)) {
    return true;
  }

  if (
    /\b(?:os|shutil|pathlib|File|FileUtils)\s*\.\s*(?:remove|unlink|rmdir|removedirs|rmtree|rename|renames|replace|copy|copy2|copyfile|move|chmod|chown|truncate|rm|rm_rf)\b/.test(
      stripped,
    )
  ) {
    return true;
  }

  if (
    /\bfile_put_contents\s*\(|\b(?:execSync|execFileSync|spawnSync|child_process|subprocess)\b|\bos\s*\.\s*system\s*\(/.test(
      stripped,
    )
  ) {
    return true;
  }

  return false;
}

/**
 * Inspect shell command (including sub-shells & interpreter inline code) for
 * forbidden access to `config.json` or `<AUTOLOOP_HOME>` control-plane files.
 * Returns a deny reason string or null if clean.
 */
function inspectCommandProtectedTargets(commandLine, cpSpec) {
  if (typeof commandLine !== "string" || commandLine.length === 0) {
    return null;
  }

  // Direct reference to AUTOLOOP_GUARD_FILE env variable is always denied
  if (/AUTOLOOP_GUARD_FILE/.test(commandLine)) {
    return CONTROL_PLANE_PROTECT_DENY_REASON;
  }

  const baseDir = cpSpec.normCwd || process.cwd();
  const entries = collectEffectiveSegments(commandLine);

  for (const entry of entries) {
    const cmd = path.basename(entry.tokens[0] ?? "").toLowerCase();
    const redirects = extractRedirectTargets(entry.raw);
    const hasRedirect = redirects.length > 0;
    const isSafeDbMetaRead =
      !hasRedirect &&
      !entry.embedded &&
      (cmd === "ls" || cmd === "stat" || cmd === "file");
    const isSafeTextRead =
      !hasRedirect && isSafeReadCommandOnTextTarget(entry);

    // Check redirect targets (always write operations!)
    for (const rTarget of redirects) {
      const normR = normalizeComparablePath(rTarget, baseDir);
      if (isProtectedGlobalConfigPath(normR)) {
        return CONFIG_PROTECT_DENY_REASON;
      }
      if (isNoWriteControlPath(normR, cpSpec)) {
        return CONTROL_PLANE_PROTECT_DENY_REASON;
      }
    }

    // Check segment tokens
    for (let i = 1; i < entry.tokens.length; i++) {
      const tok = entry.tokens[i];
      if (!tok || tok === "-") continue;
      // Strip leading option assignment like `--file=/path` or `of=/path`
      const eqIdx = tok.indexOf("=");
      const candidate =
        eqIdx !== -1 && /^[A-Za-z0-9_-]+=.+/.test(tok)
          ? tok.slice(eqIdx + 1)
          : tok;
      if (candidate.startsWith("-") && !candidate.includes("/")) {
        continue;
      }
      const normCandidate = normalizeComparablePath(candidate, baseDir);
      if (isNoAccessControlPath(normCandidate, cpSpec)) {
        return CONTROL_PLANE_PROTECT_DENY_REASON;
      }
      if (isDbControlPath(normCandidate, cpSpec) && !isSafeDbMetaRead) {
        return CONTROL_PLANE_PROTECT_DENY_REASON;
      }
      if (!isSafeTextRead) {
        if (isProtectedGlobalConfigPath(normCandidate)) {
          return CONFIG_PROTECT_DENY_REASON;
        }
        if (isReadOnlyTextControlPath(normCandidate, cpSpec)) {
          return CONTROL_PLANE_PROTECT_DENY_REASON;
        }
      }
    }

    // Check string literals & env vars inside interpreter inline scripts (`node -e`, `python -c`, etc.)
    if (entry.embedded && entry.embedded.kind === "interpreter") {
      const code = entry.embedded.code || "";
      if (
        /AUTOLOOP_GUARD_FILE|AUTOLOOP_OWNER_TOKEN|AUTOLOOP_MASTER_KEY|AUTOLOOP_INGEST_TOKEN/.test(
          code,
        )
      ) {
        return CONTROL_PLANE_PROTECT_DENY_REASON;
      }
      const hasWriteIntent = inlineCodeHasWriteIntent(code);
      if (hasWriteIntent && /\bAUTOLOOP_CONTEXT\b/.test(code)) {
        return CONTROL_PLANE_PROTECT_DENY_REASON;
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
        const normLit = normalizeComparablePath(lit, baseDir);
        if (isNoAccessControlPath(normLit, cpSpec)) {
          return CONTROL_PLANE_PROTECT_DENY_REASON;
        }
        if (isDbControlPath(normLit, cpSpec)) {
          return CONTROL_PLANE_PROTECT_DENY_REASON;
        }
        if (hasWriteIntent) {
          if (isProtectedGlobalConfigPath(normLit)) {
            return CONFIG_PROTECT_DENY_REASON;
          }
          if (isReadOnlyTextControlPath(normLit, cpSpec)) {
            return CONTROL_PLANE_PROTECT_DENY_REASON;
          }
        }
      }
    }
  }

  return null;
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

function detectInterpreterCategories(code) {
  const cats = new Set();
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

function detectCategories(commandLine) {
  const categories = new Set();
  const normalized = commandLine.replace(/\s+/g, " ").trim();
  const entries = collectEffectiveSegments(commandLine);

  for (const entry of entries) {
    const toks = entry.tokens;
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

  const entries = collectEffectiveSegments(commandLine);

  for (const entry of entries) {
    const rawLower = entry.raw.replace(/\s+/g, " ").trim().toLowerCase();
    if (rawLower.includes(normPat)) {
      return true;
    }
    const unwrappedJoined = entry.tokens.join(" ").toLowerCase();
    if (unwrappedJoined.includes(normPat)) {
      return true;
    }
    const gitInfo = parseGitSegment(entry.tokens);
    if (gitInfo && gitInfo.subcommand) {
      const normalizedGit = ["git", gitInfo.subcommand, ...gitInfo.args]
        .join(" ")
        .toLowerCase();
      if (normalizedGit.includes(normPat)) {
        return true;
      }
    }
    if (entry.embedded && entry.embedded.code) {
      const normCode = entry.embedded.code
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      if (normCode.includes(normPat)) {
        return true;
      }
    }
  }

  const detectedCats = detectCategories(commandLine);

  for (const cat of HIGH_RISK_CATEGORIES) {
    const patternHitsCat = cat.patternMatches.some((re) => re.test(normPat));
    if (!patternHitsCat) continue;

    if (detectedCats.has(cat.id)) {
      return true;
    }

    if (cat.id === "rm-rf") {
      for (const entry of entries) {
        const cmd = path.basename(entry.tokens[0] ?? "").toLowerCase();
        if (cmd === "rm" || cmd === "rmdir" || cmd === "unlink") {
          return true;
        }
        if (
          cmd === "find" &&
          entry.tokens.some((t) => t === "-delete")
        ) {
          return true;
        }
      }
    }
  }

  return false;
}

function isWriteShellCommand(commandLine) {
  const entries = collectEffectiveSegments(commandLine);
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

  for (const entry of entries) {
    if (extractRedirectTargets(entry.raw).length > 0) {
      return true;
    }

    // Under access=read, block inline interpreter code execution (-e / -c)
    if (entry.embedded && entry.embedded.kind === "interpreter") {
      return true;
    }

    const toks = entry.tokens;
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
      mutatingGitSubcommands.has(gitInfo.subcommand) &&
      !isGitApplyReadOnly(gitInfo)
    ) {
      return true;
    }
    if (cmd === "find" && toks.some((t) => t === "-delete")) {
      return true;
    }
  }

  return false;
}

function extractAllFileArgs(args) {
  const out = [];
  if (!args || typeof args !== "object") return out;
  for (const [key, value] of Object.entries(args)) {
    if (!FILE_ARG_KEYS.has(key.toLowerCase())) {
      continue;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      out.push(value.trim());
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.trim().length > 0) {
          out.push(item.trim());
        }
      }
    }
  }
  return out;
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

  const cpSpec = buildControlPlaneSpec(guardFile, guardCwd);
  const baseDir = cpSpec.normCwd || process.cwd();
  const fileArgs = extractAllFileArgs(args);

  // 0. Universal control-plane secret & guard.json protection across ALL tools (read, grep, write, etc.)
  for (const rawTarget of fileArgs) {
    const normTarget = normalizeComparablePath(rawTarget, baseDir);
    if (isNoAccessControlPath(normTarget, cpSpec)) {
      respond({ decision: "deny", reason: CONTROL_PLANE_PROTECT_DENY_REASON });
      return;
    }
    if (
      SEARCH_DIR_TOOL_NAMES.has(toolName) &&
      cpSpec.homes.has(normTarget)
    ) {
      respond({ decision: "deny", reason: CONTROL_PLANE_PROTECT_DENY_REASON });
      return;
    }
  }

  // 1. Write / edit / delete file tools
  if (WRITE_TOOL_NAMES.has(toolName)) {
    for (const rawTarget of fileArgs) {
      const normTarget = normalizeComparablePath(rawTarget, baseDir);
      if (isProtectedGlobalConfigPath(normTarget)) {
        respond({ decision: "deny", reason: CONFIG_PROTECT_DENY_REASON });
        return;
      }
      if (isNoWriteControlPath(normTarget, cpSpec)) {
        respond({
          decision: "deny",
          reason: CONTROL_PLANE_PROTECT_DENY_REASON,
        });
        return;
      }
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

    // 2a. Always deny touching protected secrets/guard.json or mutating config.json/hub.db/rules.json
    const protectedDenyReason = inspectCommandProtectedTargets(
      commandLine,
      cpSpec,
    );
    if (protectedDenyReason) {
      respond({ decision: "deny", reason: protectedDenyReason });
      return;
    }

    // 2b. Always deny root or out-of-cwd recursive/forced rm (including inside sub-shells)
    const effectiveEntries = collectEffectiveSegments(commandLine);
    for (const entry of effectiveEntries) {
      const rmInfo = analyzeRmSegment(entry.tokens, guardCwd);
      if (rmInfo && (rmInfo.recursive || rmInfo.force) && rmInfo.outOfBounds) {
        respond({ decision: "deny", reason: ASK_FIRST_DENY_REASON });
        return;
      }
    }

    // 2c. Read-only mode denies write commands, sub-shell writes, and interpreter -e/-c execution
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
