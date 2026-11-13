/**
 * Autoloop local diagnostic & control CLI.
 *
 * Transport policy:
 * - Prefers local Sidecar IPC (`<AUTOLOOP_HOME>/ipc.json` + `owner.token`,
 *   with `emit` also supporting `ingest.token`).
 * - Seamlessly falls back to single-transaction SQLite operations against
 *   `<AUTOLOOP_HOME>/hub.db` when Sidecar IPC is not running.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseCron } from "../kernel/cron.ts";
import { decide, type DecideEnv } from "../kernel/decide.ts";
import { InputError, KernelError, NotFoundError } from "../kernel/errors.ts";
import { applyFact, createMemoryView, type View } from "../kernel/evolve.ts";
import { rulesOf, whyOf } from "../kernel/query.ts";
import {
  createTokenSigner,
  openStore,
  safeTokenEquals,
  sha256Hex,
  type Store,
} from "../kernel/store.ts";
import { parseRulesConfig } from "../protocol/rules-schema.ts";
import type {
  CardView,
  InboundEvent,
  PipelineLineView,
  RunSummary,
  StateSnapshot,
  WhyReport,
} from "../protocol/types.ts";
import { ProtocolInputError } from "../protocol/validate.ts";
import {
  ensureHubTokens,
  explainRules,
  resolveAutoloopHome,
  type ExplainRulesReport,
} from "../sidecars/hub/ipc-server.ts";
import { buildStateSnapshot } from "../sidecars/hub/state-queries.ts";

export interface CliIo {
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  env?: NodeJS.ProcessEnv;
}

class IpcHttpError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, statusCode: number, code: string) {
    super(message);
    this.name = "IpcHttpError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

class IpcUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IpcUnavailableError";
  }
}

interface IpcEndpoint {
  baseUrl: string;
  token: string;
}

interface ParsedArgs {
  positionals: string[];
  flags: Set<string>;
  values: Map<string, string>;
}

const ALLOWED_IPC_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const IPC_TIMEOUT_MS = 5000;

const OWNER_ADMIN_COMMANDS = new Set([
  "answer",
  "resolve",
  "pause",
  "resume",
  "replay",
  "run",
  "stop",
  "try",
]);

const SUBAGENT_DENY_MESSAGE =
  "安全隔离拒绝：当前进程处于 Autoloop 子代理运行上下文（AUTOLOOP_RUN_ID / AUTOLOOP_GUARD_FILE），严禁执行批复卡片或篡改调度状态的本人管理命令。请通过 agent-autoloop 回执卡片向用户请示或使用 emit 投递衍生事件。";

const USAGE_TEXT = `Autoloop 本地诊断控制 CLI

用法:
  autoloop <command> [options]

命令:
  status [--json] [--before <run>] [--limit <n>]
      查看待批奏折卡片、流水线状态矩阵、近期轮次与今日/近7日 Token 消耗

  why <run> [--json]
      输出指定轮次的完整因果追溯报告

  check [rulesFile] [--json]
      校验默认 <AUTOLOOP_HOME>/rules.json 或指定规则草稿文件

  explain [rulesFile] [--json]
      校验并解释规则触发器、执行角色与下次 Cron 触发时刻

  emit <type> [--source <s>] [--id <id>] [--subject <sub>] [--summary <sum>]
              [--detail <det>] [--link <url>] [--hops <n>] [--dry-run] [--json]
      向中台投递标准事件（--dry-run 仅试算路由不落盘）

  answer <card> [--choice <idx> | --text <str>] [--json]
      批复指定 open 状态的 ask 卡片并唤醒续办

  resolve <card> --reason <str> [--json]
      手动核实结案指定 open 卡片

  pause <rule> [--reason <str>] [--until <iso>] [--json]
      暂停指定规则（可选自动恢复 ISO 时间）

  resume <rule> [--json]
      恢复已暂停规则并列出暂停期间跳过事件

  replay <rule> [--since <iso|seq>] [--json]
      补跑暂停期间跳过的事件

  run <rule> [--subject <sub>] [--json]
      立即手动触发指定规则运行一轮

  stop <run> [--json]
      强制停止排队中或运行中的轮次

  try [...args]
      运行一键试跑交互向导
`;

function isSubagentContext(env: NodeJS.ProcessEnv): boolean {
  const runId =
    typeof env.AUTOLOOP_RUN_ID === "string" ? env.AUTOLOOP_RUN_ID.trim() : "";
  const guardFile =
    typeof env.AUTOLOOP_GUARD_FILE === "string"
      ? env.AUTOLOOP_GUARD_FILE.trim()
      : "";
  return runId.length > 0 || guardFile.length > 0;
}

function ensurePrivateDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dirPath, 0o700);
  } catch {
    // Ignore chmod errors on unsupported filesystems
  }
}

function parseCommandArgs(
  args: readonly string[],
  valueFlags: ReadonlySet<string>,
  booleanFlags: ReadonlySet<string>,
): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Set<string>();
  const values = new Map<string, string>();
  let endOfOptions = false;

  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (endOfOptions) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      endOfOptions = true;
      continue;
    }
    if (token === "-h") {
      flags.add("help");
      continue;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const eqIdx = token.indexOf("=");
    if (eqIdx !== -1) {
      const name = token.slice(2, eqIdx);
      const val = token.slice(eqIdx + 1);
      if (booleanFlags.has(name)) {
        throw new InputError(`选项 --${name} 不接受参数值`);
      }
      if (!valueFlags.has(name)) {
        throw new InputError(`未知选项: --${name}`);
      }
      values.set(name, val);
      continue;
    }

    const name = token.slice(2);
    if (booleanFlags.has(name)) {
      flags.add(name);
      continue;
    }
    if (valueFlags.has(name)) {
      if (i + 1 >= args.length) {
        throw new InputError(`选项 --${name} 缺少参数值`);
      }
      values.set(name, args[++i]!);
      continue;
    }
    throw new InputError(`未知选项: --${name}`);
  }

  return { positionals, flags, values };
}

function parsePositiveIntArg(raw: string, label: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new InputError(`${label} 必须是正整数`);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new InputError(`${label} 必须是正安全整数`);
  }
  return n;
}

function parseNonNegativeIntArg(raw: string, label: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new InputError(`${label} 必须是非负整数`);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new InputError(`${label} 必须是非负安全整数`);
  }
  return n;
}

function readJsonFile(filePath: string, label: string): unknown {
  if (!existsSync(filePath)) {
    throw new NotFoundError(`未找到${label}: ${filePath}`);
  }
  const raw = readFileSync(filePath, "utf8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new InputError(
      `${label} JSON 解析失败 (${filePath}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function readTokenFile(filePath: string): string | null {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const val = readFileSync(filePath, "utf8").trim();
    return val.length > 0 ? val : null;
  } catch {
    return null;
  }
}

function readIpcEndpoint(
  autoloopHome: string,
  allowIngestFallback: boolean,
  env: NodeJS.ProcessEnv,
): IpcEndpoint | null {
  const ipcPath = path.join(autoloopHome, "ipc.json");
  if (!existsSync(ipcPath)) {
    return null;
  }

  let rawIpc: unknown;
  try {
    rawIpc = JSON.parse(readFileSync(ipcPath, "utf8"));
  } catch {
    return null;
  }
  if (!rawIpc || typeof rawIpc !== "object") {
    return null;
  }

  const obj = rawIpc as Record<string, unknown>;
  const host = typeof obj.host === "string" ? obj.host.trim() : "127.0.0.1";
  const port = Number(obj.port);
  if (
    !ALLOWED_IPC_HOSTS.has(host) ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    return null;
  }

  let token: string | null = null;
  if (isSubagentContext(env)) {
    // Subagent contexts must never read or transmit owner.token.
    token = readTokenFile(path.join(autoloopHome, "ingest.token"));
  } else {
    token = readTokenFile(path.join(autoloopHome, "owner.token"));
    if (!token && allowIngestFallback) {
      token = readTokenFile(path.join(autoloopHome, "ingest.token"));
    }
  }

  if (!token) {
    return null;
  }

  const formattedHost = host.includes(":") ? `[${host}]` : host;
  return {
    baseUrl: `http://${formattedHost}:${port}`,
    token,
  };
}

function isConnectionError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const e = err as {
    code?: unknown;
    cause?: { code?: unknown };
    name?: unknown;
  };
  const code = e.code ?? e.cause?.code;
  if (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND" ||
    code === "EHOSTUNREACH" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_SOCKET"
  ) {
    return true;
  }
  return e.name === "AbortError" || e.name === "TimeoutError";
}

async function requestIpc<T = Record<string, unknown>>(
  endpoint: IpcEndpoint,
  method: "GET" | "POST",
  routePath: string,
  body?: unknown,
): Promise<T> {
  const url = `${endpoint.baseUrl}${routePath}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${endpoint.token}`,
    Accept: "application/json",
  };
  const init: RequestInit = {
    method,
    headers,
    signal: AbortSignal.timeout(IPC_TIMEOUT_MS),
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    if (isConnectionError(err) || err instanceof TypeError) {
      throw new IpcUnavailableError(
        `无法连接 Sidecar IPC (${url}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    throw err;
  }

  const text = await response.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }

  if (!response.ok) {
    const obj =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : null;
    const nestedErr =
      obj?.error && typeof obj.error === "object"
        ? (obj.error as Record<string, unknown>)
        : null;
    const errMsg =
      nestedErr?.message ??
      obj?.message ??
      (typeof obj?.error === "string" ? obj.error : null) ??
      `IPC HTTP ${response.status}`;
    const errCode = nestedErr?.code ?? obj?.code ?? `HTTP_${response.status}`;
    throw new IpcHttpError(String(errMsg), response.status, String(errCode));
  }

  return parsed as T;
}

function buildDecideEnv(
  autoloopHome: string,
  createIfMissing: boolean,
): DecideEnv {
  if (createIfMissing) {
    const tokens = ensureHubTokens(autoloopHome);
    return {
      signToken: createTokenSigner(tokens.masterKey),
      safeTokenEquals,
    };
  }
  const keyPath = path.join(autoloopHome, "master.key");
  let keyHex = "";
  if (existsSync(keyPath)) {
    try {
      const raw = readFileSync(keyPath, "utf8").trim();
      if (/^[0-9a-fA-F]{64,}$/.test(raw) && raw.length % 2 === 0) {
        keyHex = raw;
      }
    } catch {
      // Fall through to deterministic fallback
    }
  }
  if (!keyHex) {
    keyHex = sha256Hex(`autoloop-cli-fallback:${autoloopHome}`);
  }
  return {
    signToken: createTokenSigner(keyHex),
    safeTokenEquals,
  };
}

function readDiskRulesOptional(autoloopHome: string): unknown | null {
  const rulesPath = path.join(autoloopHome, "rules.json");
  if (!existsSync(rulesPath)) {
    return null;
  }
  return readJsonFile(rulesPath, "规则文件");
}

function ensureRulesBootstrappedInView(
  store: Store,
  autoloopHome: string,
  nowMs: number,
  env: DecideEnv,
  commit: boolean,
): View {
  if (rulesOf(store.view) !== null) {
    return store.view;
  }
  const diskConfig = readDiskRulesOptional(autoloopHome);
  if (diskConfig === null) {
    return store.view;
  }
  const cfgRes = decide(
    store.view,
    { type: "configureRules", config: diskConfig },
    nowMs,
    env,
  );
  if (commit) {
    store.commit(cfgRes.facts);
    return store.view;
  }
  const forked = store.view.fork();
  for (const fact of cfgRes.facts) {
    applyFact(forked, fact);
  }
  return forked;
}

async function withIpcOrFallback<T>(
  autoloopHome: string,
  allowIngestFallback: boolean,
  env: NodeJS.ProcessEnv,
  viaIpc: (endpoint: IpcEndpoint) => Promise<T>,
  viaLocal: () => T | Promise<T>,
): Promise<{ mode: "ipc" | "local-fallback"; data: T }> {
  const endpoint = readIpcEndpoint(autoloopHome, allowIngestFallback, env);
  if (endpoint) {
    try {
      const data = await viaIpc(endpoint);
      return { mode: "ipc", data };
    } catch (err) {
      if (!(err instanceof IpcUnavailableError)) {
        throw err;
      }
    }
  }
  const data = await viaLocal();
  return { mode: "local-fallback", data };
}

function withStore<T>(
  autoloopHome: string,
  createHome: boolean,
  fn: (store: Store) => T,
): T {
  if (createHome) {
    ensurePrivateDir(autoloopHome);
  }
  const dbPath = path.join(autoloopHome, "hub.db");
  const store = openStore(dbPath);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

function formatCardLines(card: CardView): string[] {
  const lines: string[] = [];
  const head = `#${card.card} [${card.status}/${card.kind}] rule=${card.rule}${card.lane ? ` lane=${card.lane}` : ""} — ${card.title}`;
  lines.push(head);
  if (card.text) {
    lines.push(`   ${card.text}`);
  }
  if (card.options && card.options.length > 0) {
    const opts = card.options
      .map((opt, idx) =>
        card.recommend === idx ? `[${idx}] ${opt} (★推荐)` : `[${idx}] ${opt}`,
      )
      .join(" | ");
    lines.push(`   选项: ${opts}`);
  }
  if (card.about) {
    lines.push(`   事项: ${card.about}`);
  }
  if (card.chosen !== undefined) {
    lines.push(
      `   已批复: ${card.chosen}${card.choice !== undefined && card.choice !== null ? ` (#${card.choice})` : ""}`,
    );
  }
  return lines;
}

function formatPipelineLines(line: PipelineLineView): string {
  const badge =
    line.status === "paused"
      ? `paused${line.pausedUntil ? ` until ${line.pausedUntil}` : ""}`
      : line.status;
  const parts = [
    `${line.rule} [${badge}]`,
    `group=${line.group}`,
    `to=${line.to}`,
    `active=${line.activeRuns}`,
    `queued=${line.queuedRuns}`,
    `doneToday=${line.doneToday}`,
  ];
  if (line.nextRunAt) {
    parts.push(`next=${line.nextRunAt}`);
  }
  if (line.skippedCount > 0) {
    parts.push(`skipped=${line.skippedCount}`);
  }
  if (line.pauseReason) {
    parts.push(`reason=${line.pauseReason}`);
  }
  return parts.join(" | ");
}

function formatRunLine(run: RunSummary): string {
  const tokens = run.usage
    ? `in=${run.usage.input ?? 0}/out=${run.usage.output ?? 0}/cached=${run.usage.cached ?? 0}`
    : "";
  const parts = [
    `#${run.run} [${run.status}]`,
    `rule=${run.rule}`,
    `agent=${run.agent}${run.model ? `(${run.model})` : ""}`,
    `attempt=${run.attempt}`,
    `session=${run.session ?? "-"}`,
  ];
  if (tokens) {
    parts.push(tokens);
  }
  if (run.summary) {
    parts.push(`summary="${run.summary}"`);
  } else if (run.error) {
    parts.push(`error="${run.error}"`);
  }
  return parts.join(" | ");
}

function formatStatusText(
  snapshot: StateSnapshot,
  mode: "ipc" | "local-fallback",
): string {
  const out: string[] = [];
  out.push(
    `Autoloop 状态总览 (${mode === "ipc" ? "Sidecar IPC" : "本地 SQLite 回退"}) @ ${snapshot.now}`,
  );
  out.push("");

  out.push(`【待批奏折卡片 (${snapshot.cards.length})】`);
  if (snapshot.cards.length === 0) {
    out.push("  暂无待批奏折卡片。");
  } else {
    for (const card of snapshot.cards) {
      for (const l of formatCardLines(card)) {
        out.push(`  ${l}`);
      }
    }
  }
  out.push("");

  out.push(`【流水线状态矩阵 (${snapshot.lines.length})】`);
  if (snapshot.lines.length === 0) {
    out.push("  暂无已配置流水线规则。");
  } else {
    for (const line of snapshot.lines) {
      out.push(`  - ${formatPipelineLines(line)}`);
    }
  }
  out.push("");

  out.push(`【近期轮次 (${snapshot.runs.length})】`);
  if (snapshot.runs.length === 0) {
    out.push("  暂无执行轮次记录。");
  } else {
    for (const run of snapshot.runs) {
      out.push(`  - ${formatRunLine(run)}`);
    }
  }
  out.push("");

  const t = snapshot.spending.today;
  const w = snapshot.spending.last7Days;
  out.push("【Token 消耗统计】");
  out.push(
    `  今日: runs=${t.runs} | input=${t.input} | output=${t.output} | cached=${t.cached} | cost=${t.cost.toFixed(4)}`,
  );
  out.push(
    `  近7日: runs=${w.runs} | input=${w.input} | output=${w.output} | cached=${w.cached} | cost=${w.cost.toFixed(4)}`,
  );

  return out.join("\n");
}

function formatWhyText(report: WhyReport): string {
  const out: string[] = [];
  const r = report.run;
  out.push(`轮次 #${r.run} 因果追溯报告`);
  out.push(
    `状态: ${r.status} | 规则: ${r.rule} (v${report.ruleVersion}) | 事项: ${r.lane || "(default)"}`,
  );
  out.push(
    `执行器: ${r.agent} (${r.runner}${r.model ? ` / ${r.model}` : ""}) | 尝试: #${r.attempt} | 会话: ${r.session ?? "-"}`,
  );
  if (report.ruleSpec) {
    out.push(
      `工作区: ${report.ruleSpec.cwd}${report.ruleSpec.skill ? ` | Skill: ${report.ruleSpec.skill}` : ""} | 组: ${report.ruleSpec.group ?? report.ruleSpec.name}`,
    );
  }
  if (r.summary) {
    out.push(`结论摘要: ${r.summary}`);
  }
  if (r.error) {
    out.push(`错误信息: ${r.error}`);
  }
  if (r.usage) {
    out.push(
      `Token 用量: input=${r.usage.input ?? 0}, output=${r.usage.output ?? 0}, cached=${r.usage.cached ?? 0}, cost=${r.usage.cost ?? 0}`,
    );
  }

  out.push("");
  out.push(`【触发事件 (${report.events.length})】`);
  if (report.events.length === 0) {
    out.push("  无");
  } else {
    for (const ev of report.events) {
      out.push(
        `  - #${ev.seq ?? "-"} [${ev.source}] id=${ev.id} type=${ev.type}${ev.subject ? ` subject=${ev.subject}` : ""} hops=${ev.hops ?? 0} @ ${ev.receivedAt}`,
      );
    }
  }

  if (report.answers.length > 0) {
    out.push("");
    out.push(`【关联批复 (${report.answers.length})】`);
    for (const a of report.answers) {
      out.push(
        `  - card=#${a.card} key=${a.key} "${a.title}" -> ${a.chosen} @ ${a.at}`,
      );
    }
  }

  if (report.timers.length > 0) {
    out.push("");
    out.push(`【触发定时器 (${report.timers.length})】`);
    for (const t of report.timers) {
      out.push(`  - key=${t.key} (${t.about}) @ ${t.at}`);
    }
  }

  if (report.cardsCreated.length > 0 || report.cardsResolved.length > 0) {
    out.push("");
    out.push("【卡片变更】");
    for (const c of report.cardsCreated) {
      out.push(`  - 新建 #${c.card} [${c.kind}/${c.status}] ${c.title}`);
    }
    if (report.cardsResolved.length > 0) {
      out.push(
        `  - 已结案卡片: ${report.cardsResolved.map((id) => `#${id}`).join(", ")}`,
      );
    }
  }

  if (report.eventsEmitted.length > 0) {
    out.push("");
    out.push(`【衍生事件 (${report.eventsEmitted.length})】`);
    for (const ev of report.eventsEmitted) {
      out.push(
        `  - [${ev.source}] id=${ev.id} type=${ev.type}${ev.subject ? ` subject=${ev.subject}` : ""} hops=${ev.hops}`,
      );
    }
  }

  out.push("");
  out.push(`【时间线 (${report.timeline.length})】`);
  for (const item of report.timeline) {
    out.push(`  - ${item.at} [${item.kind}] ${item.detail}`);
  }

  return out.join("\n");
}

function formatExplainText(report: ExplainRulesReport): string {
  const out: string[] = [];
  out.push(
    `规则解析报告 (valid=${String(report.valid)}, version=v${report.activeVersion}, timezone=${report.timezone}) @ ${report.now}`,
  );
  out.push(
    `askFirst (${report.askFirst.length}): ${report.askFirst.length > 0 ? report.askFirst.join(", ") : "无"}`,
  );
  out.push(
    `事件源 (${report.sources.length}): ${report.sources.map((s) => `${s.id}(${s.name})`).join(", ") || "无"}`,
  );
  out.push(
    `执行角色 (${report.agents.length}): ${report.agents.map((a) => `${a.id}[${a.runner}${a.model ? `:${a.model}` : ""}/${a.access}]`).join(", ") || "无"}`,
  );
  out.push("");
  out.push(`【规则明细 (${report.rules.length})】`);
  for (const r of report.rules) {
    const triggerDesc =
      r.triggerKind === "cron"
        ? `cron="${String((r.trigger as { cron?: string }).cron ?? "")}" next=${r.nextRunAt ?? "-"}`
        : r.triggerKind === "watch"
          ? `watch=${JSON.stringify(r.trigger)}`
          : `source=${String((r.trigger as { source?: string }).source ?? "")} types=${JSON.stringify((r.trigger as { types?: string[] }).types ?? [])}`;
    out.push(
      `  - ${r.name}: ${triggerDesc} -> to=${r.to}(${r.runner}${r.model ? `/${r.model}` : ""}, ${r.access}) cwd=${r.cwd}${r.paused ? ` [PAUSED${r.pausedUntil ? ` until ${r.pausedUntil}` : ""}]` : ""}`,
    );
  }
  return out.join("\n");
}

/**
 * Executes the Autoloop CLI with explicit argv and optional IO/env injection.
 */
export async function runCli(argv: string[], io?: CliIo): Promise<number> {
  const stdout = io?.stdout ?? ((s: string) => process.stdout.write(s));
  const stderr = io?.stderr ?? ((s: string) => process.stderr.write(s));
  const env = io?.env ?? process.env;

  const emitOut = (text: string) => {
    stdout(text.endsWith("\n") ? text : `${text}\n`);
  };
  const emitErr = (text: string) => {
    stderr(text.endsWith("\n") ? text : `${text}\n`);
  };

  if (
    argv.length === 0 ||
    argv[0] === "--help" ||
    argv[0] === "-h" ||
    argv[0] === "help"
  ) {
    emitOut(USAGE_TEXT);
    return 0;
  }

  const command = argv[0]!;
  const rest = argv.slice(1);
  const wantJson = rest.includes("--json");

  try {
    if (isSubagentContext(env) && OWNER_ADMIN_COMMANDS.has(command)) {
      throw new KernelError(
        SUBAGENT_DENY_MESSAGE,
        403,
        "FORBIDDEN_SUBAGENT_ADMIN",
      );
    }

    if (command === "try") {
      const tryMod = (await import(
        new URL("./try.ts", import.meta.url).href
      )) as {
        runTryWizard?: (
          args: string[],
          tryIo?: CliIo,
        ) =>
          | Promise<number | { ok?: unknown } | void>
          | number
          | { ok?: unknown }
          | void;
      };
      if (typeof tryMod.runTryWizard !== "function") {
        throw new Error("cli/try.ts 未导出 runTryWizard 函数");
      }
      const res = await tryMod.runTryWizard(rest, { stdout, stderr, env });
      if (typeof res === "number") {
        return res;
      }
      if (res && typeof res === "object" && typeof res.ok === "boolean") {
        return res.ok ? 0 : 1;
      }
      return 0;
    }

    const autoloopHome = resolveAutoloopHome(env);
    const nowMs = Date.now();

    switch (command) {
      case "status": {
        const parsed = parseCommandArgs(
          rest,
          new Set(["before", "limit"]),
          new Set(["json", "help"]),
        );
        if (parsed.flags.has("help")) {
          emitOut(USAGE_TEXT);
          return 0;
        }
        if (parsed.positionals.length > 0) {
          throw new InputError(
            `status 不接受额外位置参数: ${parsed.positionals[0]}`,
          );
        }
        const beforeRaw = parsed.values.get("before");
        const limitRaw = parsed.values.get("limit");
        const beforeRun =
          beforeRaw !== undefined
            ? parsePositiveIntArg(beforeRaw, "--before")
            : undefined;
        const limit =
          limitRaw !== undefined
            ? parsePositiveIntArg(limitRaw, "--limit")
            : undefined;

        const { mode, data } = await withIpcOrFallback<StateSnapshot>(
          autoloopHome,
          false,
          env,
          async (endpoint) => {
            const qs = new URLSearchParams();
            if (beforeRun !== undefined) qs.set("before", String(beforeRun));
            if (limit !== undefined) qs.set("limit", String(limit));
            const query = qs.toString();
            return requestIpc<StateSnapshot>(
              endpoint,
              "GET",
              query ? `/ipc/state?${query}` : "/ipc/state",
            );
          },
          () => {
            const dbPath = path.join(autoloopHome, "hub.db");
            if (!existsSync(dbPath)) {
              return buildStateSnapshot(createMemoryView(), nowMs, {
                beforeRun,
                limit,
              });
            }
            return withStore(autoloopHome, false, (store) =>
              buildStateSnapshot(store, nowMs, { beforeRun, limit }),
            );
          },
        );

        if (parsed.flags.has("json")) {
          emitOut(JSON.stringify({ ...data, mode }, null, 2));
        } else {
          emitOut(formatStatusText(data, mode));
        }
        return 0;
      }

      case "why": {
        const parsed = parseCommandArgs(
          rest,
          new Set<string>(),
          new Set(["json", "help"]),
        );
        if (parsed.flags.has("help")) {
          emitOut(USAGE_TEXT);
          return 0;
        }
        if (parsed.positionals.length !== 1) {
          throw new InputError("why 需要且仅需要一个 <run> 参数");
        }
        const runId = parsePositiveIntArg(parsed.positionals[0]!, "<run>");

        const { mode, data } = await withIpcOrFallback<WhyReport>(
          autoloopHome,
          false,
          env,
          (endpoint) =>
            requestIpc<WhyReport>(
              endpoint,
              "GET",
              `/ipc/why?run=${encodeURIComponent(String(runId))}`,
            ),
          () => {
            const dbPath = path.join(autoloopHome, "hub.db");
            if (!existsSync(dbPath)) {
              throw new NotFoundError(
                `未找到轮次 ${runId}（本地数据库尚未初始化）`,
              );
            }
            return withStore(autoloopHome, false, (store) =>
              whyOf(store.view, runId),
            );
          },
        );

        if (parsed.flags.has("json")) {
          emitOut(JSON.stringify({ ...data, mode }, null, 2));
        } else {
          emitOut(formatWhyText(data));
        }
        return 0;
      }

      case "check": {
        const parsed = parseCommandArgs(
          rest,
          new Set<string>(),
          new Set(["json", "help"]),
        );
        if (parsed.flags.has("help")) {
          emitOut(USAGE_TEXT);
          return 0;
        }
        if (parsed.positionals.length > 1) {
          throw new InputError("check 最多接受一个 [rulesFile] 参数");
        }
        const targetFile = parsed.positionals[0]
          ? path.resolve(parsed.positionals[0])
          : path.join(autoloopHome, "rules.json");
        const rawConfig = readJsonFile(targetFile, "规则文件");
        const config = parseRulesConfig(rawConfig);
        const tz = config.timezone ?? "UTC";
        for (const rule of config.rules) {
          if ("cron" in rule.when) {
            parseCron(rule.when.cron, tz);
          }
        }

        const report = {
          valid: true,
          file: targetFile,
          timezone: tz,
          askFirstCount: config.askFirst.length,
          sourcesCount: Object.keys(config.sources).length,
          agentsCount: Object.keys(config.agents).length,
          rulesCount: config.rules.length,
          rules: config.rules.map((r) => r.name),
        };
        if (parsed.flags.has("json")) {
          emitOut(JSON.stringify(report, null, 2));
        } else {
          emitOut(
            `校验通过: ${targetFile} (规则 ${report.rulesCount} 条, 角色 ${report.agentsCount} 个, 事件源 ${report.sourcesCount} 个, 时区 ${tz})`,
          );
        }
        return 0;
      }

      case "explain": {
        const parsed = parseCommandArgs(
          rest,
          new Set<string>(),
          new Set(["json", "help"]),
        );
        if (parsed.flags.has("help")) {
          emitOut(USAGE_TEXT);
          return 0;
        }
        if (parsed.positionals.length > 1) {
          throw new InputError("explain 最多接受一个 [rulesFile] 参数");
        }
        const rulesFileArg = parsed.positionals[0]
          ? path.resolve(parsed.positionals[0])
          : null;
        const explicitConfig = rulesFileArg
          ? readJsonFile(rulesFileArg, "规则文件")
          : undefined;

        const { mode, data } = await withIpcOrFallback<ExplainRulesReport>(
          autoloopHome,
          false,
          env,
          async (endpoint) => {
            if (explicitConfig !== undefined) {
              return requestIpc<ExplainRulesReport>(
                endpoint,
                "POST",
                "/ipc/explain",
                { config: explicitConfig },
              );
            }
            try {
              return await requestIpc<ExplainRulesReport>(
                endpoint,
                "POST",
                "/ipc/explain",
                {},
              );
            } catch (err) {
              if (err instanceof IpcHttpError && err.statusCode === 404) {
                const diskConfig = readDiskRulesOptional(autoloopHome);
                if (diskConfig !== null) {
                  return requestIpc<ExplainRulesReport>(
                    endpoint,
                    "POST",
                    "/ipc/explain",
                    { config: diskConfig },
                  );
                }
              }
              throw err;
            }
          },
          () => {
            const dbPath = path.join(autoloopHome, "hub.db");
            if (existsSync(dbPath)) {
              return withStore(autoloopHome, false, (store) => {
                const targetConfig =
                  explicitConfig !== undefined
                    ? explicitConfig
                    : (rulesOf(store.view)?.config ??
                      readDiskRulesOptional(autoloopHome));
                if (targetConfig === null || targetConfig === undefined) {
                  throw new NotFoundError(
                    "规则配置尚未初始化，且未找到 rules.json",
                  );
                }
                return explainRules(targetConfig, store.view, nowMs);
              });
            }
            const targetConfig =
              explicitConfig !== undefined
                ? explicitConfig
                : readDiskRulesOptional(autoloopHome);
            if (targetConfig === null || targetConfig === undefined) {
              throw new NotFoundError(
                "规则配置尚未初始化，且未找到 rules.json",
              );
            }
            return explainRules(targetConfig, createMemoryView(), nowMs);
          },
        );

        if (parsed.flags.has("json")) {
          emitOut(JSON.stringify({ ...data, mode }, null, 2));
        } else {
          emitOut(formatExplainText(data));
        }
        return 0;
      }

      case "emit": {
        const parsed = parseCommandArgs(
          rest,
          new Set([
            "source",
            "id",
            "subject",
            "summary",
            "detail",
            "link",
            "hops",
          ]),
          new Set(["dry-run", "json", "help"]),
        );
        if (parsed.flags.has("help")) {
          emitOut(USAGE_TEXT);
          return 0;
        }
        if (parsed.positionals.length !== 1) {
          throw new InputError("emit 需要且仅需要一个 <type> 参数");
        }
        const eventType = parsed.positionals[0]!;
        const source = parsed.values.get("source") ?? "cli";
        const id =
          parsed.values.get("id") ??
          `cli-${nowMs}-${randomBytes(4).toString("hex")}`;
        const dryRun = parsed.flags.has("dry-run");

        const event: InboundEvent = { id, type: eventType };
        if (parsed.values.has("subject")) {
          event.subject = parsed.values.get("subject");
        }
        if (parsed.values.has("summary")) {
          event.summary = parsed.values.get("summary");
        }
        if (parsed.values.has("detail")) {
          event.detail = parsed.values.get("detail");
        }
        if (parsed.values.has("link")) {
          event.link = parsed.values.get("link");
        }
        if (parsed.values.has("hops")) {
          event.hops = parseNonNegativeIntArg(
            parsed.values.get("hops")!,
            "--hops",
          );
        }

        const { mode, data } = await withIpcOrFallback<Record<string, unknown>>(
          autoloopHome,
          true,
          env,
          (endpoint) =>
            requestIpc<Record<string, unknown>>(endpoint, "POST", "/ipc/emit", {
              source,
              event,
              dryRun,
            }),
          () => {
            const dbPath = path.join(autoloopHome, "hub.db");
            if (dryRun && !existsSync(dbPath)) {
              const decideEnv = buildDecideEnv(autoloopHome, false);
              const view = createMemoryView();
              const diskConfig = readDiskRulesOptional(autoloopHome);
              if (diskConfig !== null) {
                const cfgRes = decide(
                  view,
                  { type: "configureRules", config: diskConfig },
                  nowMs,
                  decideEnv,
                );
                for (const fact of cfgRes.facts) {
                  applyFact(view, fact);
                }
              }
              const res = decide<Record<string, unknown>>(
                view,
                { type: "ingestEvent", source, event },
                nowMs,
                decideEnv,
              );
              return { ...res.value, dryRun: true };
            }

            const decideEnv = buildDecideEnv(autoloopHome, !dryRun);
            return withStore(autoloopHome, true, (store) => {
              const targetView = ensureRulesBootstrappedInView(
                store,
                autoloopHome,
                nowMs,
                decideEnv,
                !dryRun,
              );
              const res = decide<Record<string, unknown>>(
                targetView,
                { type: "ingestEvent", source, event },
                nowMs,
                decideEnv,
              );
              if (!dryRun) {
                store.commit(res.facts);
              }
              return { ...res.value, dryRun };
            });
          },
        );

        const payload = { ...data, mode };
        if (parsed.flags.has("json")) {
          emitOut(JSON.stringify(payload, null, 2));
        } else {
          const routed = Array.isArray(data.routed)
            ? data.routed.join(", ")
            : "";
          const paused = Array.isArray(data.paused)
            ? data.paused.join(", ")
            : "";
          const runs = Array.isArray(data.runs)
            ? data.runs.map((r) => `#${String(r)}`).join(", ")
            : "";
          emitOut(
            `${dryRun ? "[试算] " : ""}事件 ${source}:${id} (${eventType}) -> duplicate=${String(Boolean(data.duplicate))} routed=[${routed}] paused=[${paused}] runs=[${runs}]`,
          );
        }
        return 0;
      }

      case "answer": {
        const parsed = parseCommandArgs(
          rest,
          new Set(["choice", "text"]),
          new Set(["json", "help"]),
        );
        if (parsed.flags.has("help")) {
          emitOut(USAGE_TEXT);
          return 0;
        }
        if (parsed.positionals.length !== 1) {
          throw new InputError("answer 需要且仅需要一个 <card> 参数");
        }
        const card = parsePositiveIntArg(parsed.positionals[0]!, "<card>");
        const choiceRaw = parsed.values.get("choice");
        const text = parsed.values.get("text");
        if (choiceRaw === undefined && text === undefined) {
          throw new InputError(
            "answer 必须提供 --choice <idx> 或 --text <str>",
          );
        }
        const choice =
          choiceRaw !== undefined
            ? parseNonNegativeIntArg(choiceRaw, "--choice")
            : undefined;

        const { mode, data } = await withIpcOrFallback<Record<string, unknown>>(
          autoloopHome,
          false,
          env,
          (endpoint) =>
            requestIpc<Record<string, unknown>>(
              endpoint,
              "POST",
              "/ipc/cards/answer",
              {
                card,
                ...(choice !== undefined ? { choice } : {}),
                ...(text !== undefined ? { text } : {}),
              },
            ),
          () => {
            const decideEnv = buildDecideEnv(autoloopHome, true);
            return withStore(autoloopHome, true, (store) => {
              ensureRulesBootstrappedInView(
                store,
                autoloopHome,
                nowMs,
                decideEnv,
                true,
              );
              const res = decide<Record<string, unknown>>(
                store.view,
                {
                  type: "answerCard",
                  card,
                  ...(choice !== undefined ? { choice } : {}),
                  ...(text !== undefined ? { text } : {}),
                },
                nowMs,
                decideEnv,
              );
              store.commit(res.facts);
              return res.value;
            });
          },
        );

        const payload = { ...data, mode };
        if (parsed.flags.has("json")) {
          emitOut(JSON.stringify(payload, null, 2));
        } else {
          const cardInfo = data.card as CardView | undefined;
          emitOut(
            `已批复卡片 #${card}${cardInfo?.chosen ? `: "${cardInfo.chosen}"` : ""}${data.run ? ` -> 续办轮次 #${String(data.run)}` : ""}`,
          );
        }
        return 0;
      }

      case "resolve": {
        const parsed = parseCommandArgs(
          rest,
          new Set(["reason"]),
          new Set(["json", "help"]),
        );
        if (parsed.flags.has("help")) {
          emitOut(USAGE_TEXT);
          return 0;
        }
        if (parsed.positionals.length !== 1) {
          throw new InputError("resolve 需要且仅需要一个 <card> 参数");
        }
        const card = parsePositiveIntArg(parsed.positionals[0]!, "<card>");
        const reason = parsed.values.get("reason");
        if (!reason || reason.trim().length === 0) {
          throw new InputError("resolve 必须提供非空 --reason <str>");
        }

        const { mode, data } = await withIpcOrFallback<Record<string, unknown>>(
          autoloopHome,
          false,
          env,
          (endpoint) =>
            requestIpc<Record<string, unknown>>(
              endpoint,
              "POST",
              "/ipc/cards/resolve",
              { card, reason },
            ),
          () => {
            const decideEnv = buildDecideEnv(autoloopHome, true);
            return withStore(autoloopHome, true, (store) => {
              ensureRulesBootstrappedInView(
                store,
                autoloopHome,
                nowMs,
                decideEnv,
                true,
              );
              const res = decide<Record<string, unknown>>(
                store.view,
                { type: "resolveCard", card, reason },
                nowMs,
                decideEnv,
              );
              store.commit(res.facts);
              return res.value;
            });
          },
        );

        const payload = { ...data, mode };
        if (parsed.flags.has("json")) {
          emitOut(JSON.stringify(payload, null, 2));
        } else {
          emitOut(`已结案卡片 #${card} (${reason.trim()})`);
        }
        return 0;
      }

      case "pause": {
        const parsed = parseCommandArgs(
          rest,
          new Set(["reason", "until"]),
          new Set(["json", "help"]),
        );
        if (parsed.flags.has("help")) {
          emitOut(USAGE_TEXT);
          return 0;
        }
        if (parsed.positionals.length !== 1) {
          throw new InputError("pause 需要且仅需要一个 <rule> 参数");
        }
        const rule = parsed.positionals[0]!;
        const reason = parsed.values.get("reason");
        const until = parsed.values.get("until");

        const { mode, data } = await withIpcOrFallback<Record<string, unknown>>(
          autoloopHome,
          false,
          env,
          (endpoint) =>
            requestIpc<Record<string, unknown>>(
              endpoint,
              "POST",
              "/ipc/rules/pause",
              {
                rule,
                ...(reason !== undefined ? { reason } : {}),
                ...(until !== undefined ? { until } : {}),
              },
            ),
          () => {
            const decideEnv = buildDecideEnv(autoloopHome, true);
            return withStore(autoloopHome, true, (store) => {
              ensureRulesBootstrappedInView(
                store,
                autoloopHome,
                nowMs,
                decideEnv,
                true,
              );
              const res = decide<Record<string, unknown>>(
                store.view,
                {
                  type: "pauseRule",
                  rule,
                  ...(reason !== undefined ? { reason } : {}),
                  ...(until !== undefined ? { until } : {}),
                },
                nowMs,
                decideEnv,
              );
              store.commit(res.facts);
              return res.value;
            });
          },
        );

        const payload = { ...data, mode };
        if (parsed.flags.has("json")) {
          emitOut(JSON.stringify(payload, null, 2));
        } else {
          emitOut(
            `已暂停规则 ${rule}${data.until ? ` (自动恢复时间: ${String(data.until)})` : ""}`,
          );
        }
        return 0;
      }

      case "resume": {
        const parsed = parseCommandArgs(
          rest,
          new Set<string>(),
          new Set(["json", "help"]),
        );
        if (parsed.flags.has("help")) {
          emitOut(USAGE_TEXT);
          return 0;
        }
        if (parsed.positionals.length !== 1) {
          throw new InputError("resume 需要且仅需要一个 <rule> 参数");
        }
        const rule = parsed.positionals[0]!;

        const { mode, data } = await withIpcOrFallback<Record<string, unknown>>(
          autoloopHome,
          false,
          env,
          (endpoint) =>
            requestIpc<Record<string, unknown>>(
              endpoint,
              "POST",
              "/ipc/rules/resume",
              { rule },
            ),
          () => {
            const decideEnv = buildDecideEnv(autoloopHome, true);
            return withStore(autoloopHome, true, (store) => {
              ensureRulesBootstrappedInView(
                store,
                autoloopHome,
                nowMs,
                decideEnv,
                true,
              );
              const res = decide<Record<string, unknown>>(
                store.view,
                { type: "resumeRule", rule },
                nowMs,
                decideEnv,
              );
              store.commit(res.facts);
              return res.value;
            });
          },
        );

        const payload = { ...data, mode };
        if (parsed.flags.has("json")) {
          emitOut(JSON.stringify(payload, null, 2));
        } else {
          const skippedCount = Array.isArray(data.skipped)
            ? data.skipped.length
            : 0;
          emitOut(
            `已恢复规则 ${rule} (暂停期间未补跑跳过事件: ${skippedCount} 条)`,
          );
        }
        return 0;
      }

      case "replay": {
        const parsed = parseCommandArgs(
          rest,
          new Set(["since"]),
          new Set(["json", "help"]),
        );
        if (parsed.flags.has("help")) {
          emitOut(USAGE_TEXT);
          return 0;
        }
        if (parsed.positionals.length !== 1) {
          throw new InputError("replay 需要且仅需要一个 <rule> 参数");
        }
        const rule = parsed.positionals[0]!;
        const sinceRaw = parsed.values.get("since");
        const since: string | number | undefined =
          sinceRaw === undefined
            ? undefined
            : /^-?\d+$/.test(sinceRaw)
              ? Number(sinceRaw)
              : sinceRaw;

        const { mode, data } = await withIpcOrFallback<Record<string, unknown>>(
          autoloopHome,
          false,
          env,
          (endpoint) =>
            requestIpc<Record<string, unknown>>(
              endpoint,
              "POST",
              "/ipc/rules/replay",
              {
                rule,
                ...(since !== undefined ? { since } : {}),
              },
            ),
          () => {
            const decideEnv = buildDecideEnv(autoloopHome, true);
            return withStore(autoloopHome, true, (store) => {
              ensureRulesBootstrappedInView(
                store,
                autoloopHome,
                nowMs,
                decideEnv,
                true,
              );
              const res = decide<Record<string, unknown>>(
                store.view,
                {
                  type: "replayRule",
                  rule,
                  ...(since !== undefined ? { since } : {}),
                },
                nowMs,
                decideEnv,
              );
              store.commit(res.facts);
              return res.value;
            });
          },
        );

        const payload = { ...data, mode };
        if (parsed.flags.has("json")) {
          emitOut(JSON.stringify(payload, null, 2));
        } else {
          emitOut(
            `已补跑规则 ${rule}: 共补跑 ${String(data.replayedCount ?? 0)} 条跳过事件`,
          );
        }
        return 0;
      }

      case "run": {
        const parsed = parseCommandArgs(
          rest,
          new Set(["subject"]),
          new Set(["json", "help"]),
        );
        if (parsed.flags.has("help")) {
          emitOut(USAGE_TEXT);
          return 0;
        }
        if (parsed.positionals.length !== 1) {
          throw new InputError("run 需要且仅需要一个 <rule> 参数");
        }
        const rule = parsed.positionals[0]!;
        const subject = parsed.values.get("subject");

        const { mode, data } = await withIpcOrFallback<Record<string, unknown>>(
          autoloopHome,
          false,
          env,
          (endpoint) =>
            requestIpc<Record<string, unknown>>(
              endpoint,
              "POST",
              "/ipc/rules/run",
              {
                rule,
                ...(subject !== undefined ? { subject } : {}),
              },
            ),
          () => {
            const decideEnv = buildDecideEnv(autoloopHome, true);
            return withStore(autoloopHome, true, (store) => {
              ensureRulesBootstrappedInView(
                store,
                autoloopHome,
                nowMs,
                decideEnv,
                true,
              );
              const res = decide<Record<string, unknown>>(
                store.view,
                {
                  type: "runRule",
                  rule,
                  ...(subject !== undefined ? { subject } : {}),
                },
                nowMs,
                decideEnv,
              );
              store.commit(res.facts);
              return res.value;
            });
          },
        );

        const payload = { ...data, mode };
        if (parsed.flags.has("json")) {
          emitOut(JSON.stringify(payload, null, 2));
        } else {
          emitOut(
            `已手动触发规则 ${rule}: run=#${String(data.run ?? "-")} (merged=${String(Boolean(data.merged))})`,
          );
        }
        return 0;
      }

      case "stop": {
        const parsed = parseCommandArgs(
          rest,
          new Set<string>(),
          new Set(["json", "help"]),
        );
        if (parsed.flags.has("help")) {
          emitOut(USAGE_TEXT);
          return 0;
        }
        if (parsed.positionals.length !== 1) {
          throw new InputError("stop 需要且仅需要一个 <run> 参数");
        }
        const runId = parsePositiveIntArg(parsed.positionals[0]!, "<run>");

        const { mode, data } = await withIpcOrFallback<Record<string, unknown>>(
          autoloopHome,
          false,
          env,
          (endpoint) =>
            requestIpc<Record<string, unknown>>(
              endpoint,
              "POST",
              "/ipc/runs/stop",
              { run: runId },
            ),
          () => {
            const dbPath = path.join(autoloopHome, "hub.db");
            if (!existsSync(dbPath)) {
              throw new NotFoundError(
                `未找到轮次 ${runId}（本地数据库尚未初始化）`,
              );
            }
            const decideEnv = buildDecideEnv(autoloopHome, true);
            return withStore(autoloopHome, false, (store) => {
              const res = decide<Record<string, unknown>>(
                store.view,
                { type: "stopRun", run: runId },
                nowMs,
                decideEnv,
              );
              store.commit(res.facts);
              return res.value;
            });
          },
        );

        const payload = { ...data, mode };
        if (parsed.flags.has("json")) {
          emitOut(JSON.stringify(payload, null, 2));
        } else {
          const runSummary = data.run as RunSummary | undefined;
          emitOut(
            `已请求停止轮次 #${runId}: status=${runSummary?.status ?? "unknown"} changed=${String(Boolean(data.changed))}`,
          );
        }
        return 0;
      }

      default:
        throw new InputError(
          `未知子命令: ${command}（运行 autoloop --help 查看用法）`,
        );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code =
      err instanceof KernelError ||
      err instanceof ProtocolInputError ||
      err instanceof IpcHttpError
        ? err.code
        : "CLI_ERROR";

    if (wantJson) {
      emitErr(JSON.stringify({ error: message, code }, null, 2));
    } else {
      emitErr(`[${code}] ${message}`);
    }
    return 1;
  }
}
