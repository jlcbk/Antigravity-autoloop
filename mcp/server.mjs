#!/usr/bin/env node
/**
 * Autoloop Hub Stdio MCP Server (`autoloop_hub`).
 *
 * Zero-dependency JSON-RPC 2.0 over Stdio (supports both newline-delimited JSON
 * and optional Content-Length header framing).
 *
 * Security Critical:
 * - When `AUTOLOOP_RUN_ID` or `AUTOLOOP_GUARD_FILE` is set in `process.env`,
 *   the caller is an Autoloop-dispatched business subagent:
 *   1. `tools/list` hides all 7 owner admin tools (`answer`, `resolve`, `pause`,
 *      `resume`, `replay`, `run`, `stop`), exposing only read-only + `emit`.
 *   2. `tools/call` hard-rejects any attempt to invoke those 7 admin tools.
 *   3. IPC auth only reads `ingest.token` and never touches `owner.token`.
 *
 * Transport Routing:
 * - Prefers local Sidecar IPC (`<AUTOLOOP_HOME>/ipc.json` + Bearer token).
 * - Falls back seamlessly to single-transaction local SQLite (`<AUTOLOOP_HOME>/hub.db`)
 *   when `ipc.json` is absent or Sidecar is not listening, with a clickable
 *   `[Autoloop 工作台](sidecar://autoloop/hub/)` hint.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseCron, nextRun } from "../kernel/cron.ts";
import { decide } from "../kernel/decide.ts";
import { InputError, KernelError, NotFoundError } from "../kernel/errors.ts";
import { applyFact, createMemoryView } from "../kernel/evolve.ts";
import { groupOf, rulesOf, whyOf } from "../kernel/query.ts";
import {
  createTokenSigner,
  openStore,
  safeTokenEquals,
  sha256Hex,
} from "../kernel/store.ts";
import { parseRulesConfig } from "../protocol/rules-schema.ts";
import { ProtocolInputError } from "../protocol/validate.ts";
import { buildStateSnapshot } from "../sidecars/hub/state-queries.ts";

const SERVER_NAME = "autoloop_hub";
const SERVER_VERSION = "1.0.0";
const DEFAULT_PROTOCOL_VERSION = "2025-03-26";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
]);
const ALLOWED_IPC_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const IPC_TIMEOUT_MS = 5000;
const WORKBENCH_HINT =
  "Sidecar 守护进程当前未运行，已自动切换为本地 SQLite 单事务回退模式。可点击打开 [Autoloop 工作台](sidecar://autoloop/hub/) 查看面板或拉起守护进程。";

export const OWNER_ADMIN_TOOLS = new Set([
  "autoloop_answer",
  "autoloop_resolve",
  "autoloop_pause",
  "autoloop_resume",
  "autoloop_replay",
  "autoloop_run",
  "autoloop_stop",
]);

const SUBAGENT_DENY_MESSAGE =
  "安全隔离拒绝：当前会话处于 Autoloop 子代理运行上下文（AUTOLOOP_RUN_ID / AUTOLOOP_GUARD_FILE），被调度的子代理严禁代用户自批奏折或篡改中台调度状态。请通过回复末尾的 agent-autoloop 回执卡片向用户请示或使用 autoloop_emit 投递衍生事件。";

export const TOOL_DEFINITIONS = [
  {
    name: "autoloop_status",
    description:
      "查看 Autoloop 中台当前状态：待批奏折卡片（open/decided）、各自动化流水线运行态（运行中/空闲/已暂停）、近期轮次列表及今日与近 7 日 Token 消耗统计。",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        beforeRun: {
          type: "integer",
          minimum: 1,
          description: "分页游标：仅返回 run ID 小于该值的历史轮次。",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "返回轮次条数上限，默认 50。",
        },
      },
    },
  },
  {
    name: "autoloop_why",
    description:
      "按 run ID 查询指定执行轮次的完整因果链报告：触发事件、规则版本与规格、关联提问回答与定时器、实际回执、新建/结案卡片、衍生事件与时间线。",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["run"],
      properties: {
        run: {
          type: "integer",
          minimum: 1,
          description: "要溯源查询的轮次 ID。",
        },
      },
    },
  },
  {
    name: "autoloop_explain_rules",
    description:
      "校验并解释当前生效或草稿 rules.json 配置：检查 Schema 合法性、Cron 表达式、事件路由、并发组与下次 Cron 触发时刻。",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        config: {
          type: "object",
          description:
            "可选草稿 RulesConfig JSON 对象；省略时自动读取当前运行中规则或 <AUTOLOOP_HOME>/rules.json。",
        },
        nowMs: {
          type: "number",
          description:
            "可选基准时间戳（Unix 毫秒），用于计算下次 Cron 触发时间。",
        },
      },
    },
  },
  {
    name: "autoloop_emit",
    description:
      "向 Autoloop 中台投递一条标准本地事件（按 source + id 幂等去重）；支持 dryRun=true 在内存沙盒中试算路由而不落盘。",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["source", "event"],
      properties: {
        source: {
          type: "string",
          minLength: 1,
          description:
            "事件源键名（需在 rules.json 的 sources 中声明或用于记录）。",
        },
        event: {
          type: "object",
          additionalProperties: false,
          required: ["id", "type"],
          properties: {
            id: {
              type: "string",
              minLength: 1,
              maxLength: 200,
              description: "来源内幂等唯一键。",
            },
            type: {
              type: "string",
              minLength: 1,
              maxLength: 64,
              description: "事件类型，仅允许 [a-zA-Z0-9._-]。",
            },
            subject: {
              type: "string",
              maxLength: 100,
              description: "业务事项标识，仅允许 [a-zA-Z0-9#._:/@-]。",
            },
            summary: {
              type: "string",
              maxLength: 200,
              description: "一句话摘要（仅写入 context.json）。",
            },
            detail: {
              type: "string",
              maxLength: 8000,
              description: "详细负载文本（仅写入 context.json）。",
            },
            link: {
              type: "string",
              maxLength: 500,
              description: "纯 ASCII http/https/file 链接。",
            },
            hops: {
              type: "integer",
              minimum: 0,
              description: "事件跳数（默认 0，超过 8 触发熔断）。",
            },
          },
        },
        dryRun: {
          type: "boolean",
          description: "为 true 时仅在内存沙盒试算匹配规则，不写入数据库。",
        },
      },
    },
  },
  {
    name: "autoloop_answer",
    description:
      "本人管理操作：代用户批复指定 open 状态的 ask 卡片（传入选项下标 choice 或自由文字 text），并原子生成唤醒事件续办原会话。",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["card"],
      properties: {
        card: {
          type: "integer",
          minimum: 1,
          description: "待批复的 open 状态 ask 卡片 ID。",
        },
        choice: {
          type: "integer",
          minimum: 0,
          description: "选择的选项下标（从 0 开始）。",
        },
        text: {
          type: "string",
          description:
            "自由文字批复或补充说明（choice 与 text 至少提供一项）。",
        },
      },
    },
  },
  {
    name: "autoloop_resolve",
    description:
      "本人管理操作：将已无需决策或已处理完毕的 open 卡片标记为 closed 结案。",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["card", "reason"],
      properties: {
        card: {
          type: "integer",
          minimum: 1,
          description: "要结案的 open 卡片 ID。",
        },
        reason: {
          type: "string",
          minLength: 1,
          description: "结案原因说明。",
        },
      },
    },
  },
  {
    name: "autoloop_pause",
    description:
      "本人管理操作：暂停指定自动化规则（可选 until 自动恢复时间）；暂停期间到来的匹配事件仅记入跳过日志而不积压。",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["rule"],
      properties: {
        rule: {
          type: "string",
          minLength: 1,
          description: "要暂停的规则名称。",
        },
        reason: {
          type: "string",
          description: "可选暂停原因。",
        },
        until: {
          type: ["string", "null"],
          description:
            "可选自动恢复时间（带显式时区偏移 Z 或 ±HH:MM 的 ISO 8601 字符串）；省略或 null 表示无限期暂停。",
        },
      },
    },
  },
  {
    name: "autoloop_resume",
    description:
      "本人管理操作：恢复已暂停的规则，并返回暂停期间跳过未补跑的事件列表。",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["rule"],
      properties: {
        rule: {
          type: "string",
          minLength: 1,
          description: "要恢复的规则名称。",
        },
      },
    },
  },
  {
    name: "autoloop_replay",
    description:
      "本人管理操作：按可选起始时间 since 补跑指定规则在暂停期间跳过的事件（每条跳过事件最多补跑一次）。",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["rule"],
      properties: {
        rule: {
          type: "string",
          minLength: 1,
          description: "要补跑跳过事件的规则名称。",
        },
        since: {
          type: ["string", "number"],
          description: "可选起始时间（ISO 字符串或 Unix 毫秒时间戳）。",
        },
      },
    },
  },
  {
    name: "autoloop_run",
    description:
      "本人管理操作：立即手动触发指定规则执行一轮（可指定 subject 切分 Lane）。",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["rule"],
      properties: {
        rule: {
          type: "string",
          minLength: 1,
          description: "要手动触发的规则名称。",
        },
        subject: {
          type: "string",
          description: "可选事项标识，用于 parallel 规则指定独立 Lane。",
        },
      },
    },
  },
  {
    name: "autoloop_stop",
    description:
      "本人管理操作：强制停止排队中或运行中的轮次（标记 cancel_at，绝不触发失败重试）。",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["run"],
      properties: {
        run: {
          type: "integer",
          minimum: 1,
          description: "要强制停止的轮次 ID。",
        },
      },
    },
  },
];

class IpcHttpError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.name = "IpcHttpError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

class IpcUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "IpcUnavailableError";
  }
}

function expandHome(targetPath) {
  if (targetPath === "~") {
    return os.homedir();
  }
  if (targetPath.startsWith("~/")) {
    return path.join(os.homedir(), targetPath.slice(2));
  }
  return targetPath;
}

export function resolveAutoloopHome(env = process.env) {
  const explicit =
    typeof env.AUTOLOOP_HOME === "string" ? env.AUTOLOOP_HOME.trim() : "";
  if (explicit.length > 0) {
    return path.resolve(expandHome(explicit));
  }
  const pluginData =
    typeof env.PLUGIN_DATA === "string" ? env.PLUGIN_DATA.trim() : "";
  if (pluginData.length > 0) {
    return path.resolve(expandHome(pluginData));
  }
  return path.join(os.homedir(), ".autoloop");
}

export function isSubagentContext(env = process.env) {
  const runId =
    typeof env.AUTOLOOP_RUN_ID === "string" ? env.AUTOLOOP_RUN_ID.trim() : "";
  const guardFile =
    typeof env.AUTOLOOP_GUARD_FILE === "string"
      ? env.AUTOLOOP_GUARD_FILE.trim()
      : "";
  return runId.length > 0 || guardFile.length > 0;
}

function asPlainObject(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InputError(`${label} 必须是 JSON 对象`);
  }
  return value;
}

function ensurePrivateDir(dirPath) {
  mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dirPath, 0o700);
  } catch {
    // Ignore chmod error on unsupported filesystems
  }
}

function buildDecideEnv(autoloopHome) {
  const keyPath = path.join(autoloopHome, "master.key");
  let keyHex = "";
  if (existsSync(keyPath)) {
    try {
      const raw = readFileSync(keyPath, "utf8").trim();
      if (/^[0-9a-fA-F]{64,}$/.test(raw) && raw.length % 2 === 0) {
        keyHex = raw;
      }
    } catch {
      // Fall back to deterministic local key
    }
  }
  if (!keyHex) {
    keyHex = sha256Hex(`autoloop-mcp-fallback:${autoloopHome}`);
  }
  return {
    signToken: createTokenSigner(keyHex),
    safeTokenEquals,
  };
}

function readIpcEndpoint(autoloopHome, subagent) {
  const ipcPath = path.join(autoloopHome, "ipc.json");
  if (!existsSync(ipcPath)) {
    return null;
  }

  let rawIpc;
  try {
    rawIpc = JSON.parse(readFileSync(ipcPath, "utf8"));
  } catch {
    return null;
  }

  if (!rawIpc || typeof rawIpc !== "object") {
    return null;
  }

  const host =
    typeof rawIpc.host === "string" ? rawIpc.host.trim() : "127.0.0.1";
  const port = Number(rawIpc.port);
  if (
    !ALLOWED_IPC_HOSTS.has(host) ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    return null;
  }

  // Security isolation: subagent context MUST ONLY ever read ingest.token, never owner.token.
  const tokenFile = subagent ? "ingest.token" : "owner.token";
  const tokenPath = path.join(autoloopHome, tokenFile);
  if (!existsSync(tokenPath)) {
    return null;
  }

  let token = "";
  try {
    token = readFileSync(tokenPath, "utf8").trim();
  } catch {
    return null;
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

function isConnectionError(err) {
  if (!err || typeof err !== "object") {
    return false;
  }
  const code = err.code ?? err.cause?.code;
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
  return err.name === "AbortError" || err.name === "TimeoutError";
}

async function requestIpc(endpoint, method, routePath, body) {
  const url = `${endpoint.baseUrl}${routePath}`;
  const headers = {
    Authorization: `Bearer ${endpoint.token}`,
    Accept: "application/json",
  };
  const init = {
    method,
    headers,
    signal: AbortSignal.timeout(IPC_TIMEOUT_MS),
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  let response;
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
  let parsed = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }

  if (!response.ok) {
    const errMsg =
      parsed && typeof parsed === "object"
        ? (parsed.error?.message ??
          parsed.message ??
          (typeof parsed.error === "string" ? parsed.error : null) ??
          `IPC HTTP ${response.status}`)
        : `IPC HTTP ${response.status}`;
    const errCode =
      parsed && typeof parsed === "object"
        ? (parsed.error?.code ?? parsed.code ?? `HTTP_${response.status}`)
        : `HTTP_${response.status}`;
    throw new IpcHttpError(String(errMsg), response.status, String(errCode));
  }

  return parsed;
}

function readDiskRulesConfig(autoloopHome) {
  const rulesPath = path.join(autoloopHome, "rules.json");
  if (!existsSync(rulesPath)) {
    return null;
  }
  const raw = readFileSync(rulesPath, "utf8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new InputError(
      `rules.json 解析失败: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function ensureRulesBootstrappedInView(
  store,
  autoloopHome,
  nowMs,
  env,
  commit,
) {
  if (rulesOf(store.view) !== null) {
    return store.view;
  }
  const diskConfig = readDiskRulesConfig(autoloopHome);
  if (!diskConfig) {
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

function explainRulesLocal(rawConfig, nowMs) {
  const config = parseRulesConfig(rawConfig);
  const timezone = config.timezone ?? "UTC";

  const rules = config.rules.map((rule) => {
    const agent = config.agents[rule.to];
    let trigger;
    if ("cron" in rule.when) {
      parseCron(rule.when.cron, timezone);
      const nextMs = nextRun(rule.when.cron, timezone, nowMs);
      trigger = {
        kind: "cron",
        cron: rule.when.cron,
        timezone,
        nextRunAt: new Date(nextMs).toISOString(),
      };
    } else if ("watch" in rule.when) {
      trigger = {
        kind: "watch",
        paths: rule.when.watch.paths,
        debounceMs: rule.when.watch.debounceMs ?? 0,
        types: rule.when.watch.types ?? ["*"],
      };
    } else {
      trigger = {
        kind: "source",
        source: rule.when.source,
        sourceName: config.sources[rule.when.source]?.name ?? rule.when.source,
        types: rule.when.types,
      };
    }

    return {
      name: rule.name,
      trigger,
      to: rule.to,
      agent: agent
        ? {
            name: agent.name,
            runner: agent.runner,
            model: agent.model ?? null,
            effort: agent.effort ?? null,
            access: agent.access ?? "edit",
            maxActive: agent.maxActive ?? null,
            timeoutMinutes: agent.timeoutMinutes ?? 60,
          }
        : null,
      cwd: rule.cwd,
      group: groupOf(rule),
      parallel: rule.parallel ?? 1,
      maxActive: rule.maxActive ?? null,
      resume: rule.resume ?? false,
      tell: rule.tell ?? "needed",
      ...(rule.skill ? { skill: rule.skill } : {}),
      ...(rule.title ? { title: rule.title } : {}),
      ...(rule.emits ? { emits: rule.emits } : {}),
    };
  });

  return {
    valid: true,
    timezone,
    askFirst: config.askFirst,
    sources: config.sources,
    agents: Object.keys(config.agents),
    rules,
  };
}

function formatFallbackResult(payload) {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return {
      ...payload,
      mode: "local-fallback",
      hint: WORKBENCH_HINT,
    };
  }
  return {
    result: payload,
    mode: "local-fallback",
    hint: WORKBENCH_HINT,
  };
}

function formatIpcResult(payload) {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return {
      ...payload,
      mode: "ipc",
    };
  }
  return {
    result: payload,
    mode: "ipc",
  };
}

function executeLocalFallback(toolName, args, autoloopHome, nowMs) {
  const dbPath = path.join(autoloopHome, "hub.db");
  const env = buildDecideEnv(autoloopHome);

  switch (toolName) {
    case "autoloop_status": {
      const beforeRun = args.beforeRun;
      const limit = args.limit;
      if (
        beforeRun !== undefined &&
        (!Number.isSafeInteger(beforeRun) || beforeRun <= 0)
      ) {
        throw new InputError("beforeRun 必须是正整数");
      }
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) {
        throw new InputError("limit 必须是正整数");
      }

      if (!existsSync(dbPath)) {
        const snapshot = buildStateSnapshot(createMemoryView(), nowMs, {
          beforeRun,
          limit,
        });
        return formatFallbackResult(snapshot);
      }

      const store = openStore(dbPath);
      try {
        const snapshot = buildStateSnapshot(store, nowMs, {
          beforeRun,
          limit,
        });
        return formatFallbackResult(snapshot);
      } finally {
        store.close();
      }
    }

    case "autoloop_why": {
      const run = args.run;
      if (!Number.isSafeInteger(run) || run <= 0) {
        throw new InputError("run 必须是正整数");
      }
      if (!existsSync(dbPath)) {
        throw new NotFoundError(`未找到轮次 ${run}（本地数据库尚未初始化）`);
      }
      const store = openStore(dbPath);
      try {
        const report = whyOf(store.view, run);
        return formatFallbackResult(report);
      } finally {
        store.close();
      }
    }

    case "autoloop_explain_rules": {
      const targetNowMs =
        typeof args.nowMs === "number" && Number.isFinite(args.nowMs)
          ? args.nowMs
          : nowMs;

      let rawConfig = args.config;
      if (rawConfig === undefined) {
        if (existsSync(dbPath)) {
          const store = openStore(dbPath);
          try {
            rawConfig = rulesOf(store.view)?.config;
          } finally {
            store.close();
          }
        }
        if (rawConfig === undefined) {
          rawConfig = readDiskRulesConfig(autoloopHome);
        }
      }
      if (rawConfig === undefined || rawConfig === null) {
        throw new NotFoundError(
          "未提供 config，且当前数据库与 rules.json 中均未找到规则配置",
        );
      }
      return formatFallbackResult(explainRulesLocal(rawConfig, targetNowMs));
    }

    case "autoloop_emit": {
      const source = args.source;
      if (typeof source !== "string" || source.trim().length === 0) {
        throw new InputError("source 必须是非空字符串");
      }
      const event = asPlainObject(args.event, "event");
      const dryRun = args.dryRun === true;

      if (dryRun && !existsSync(dbPath)) {
        let view = createMemoryView();
        const diskConfig = readDiskRulesConfig(autoloopHome);
        if (diskConfig) {
          const cfgRes = decide(
            view,
            { type: "configureRules", config: diskConfig },
            nowMs,
            env,
          );
          for (const fact of cfgRes.facts) {
            applyFact(view, fact);
          }
        }
        const res = decide(
          view,
          { type: "ingestEvent", source: source.trim(), event },
          nowMs,
          env,
        );
        return formatFallbackResult({ ...res.value, dryRun: true });
      }

      ensurePrivateDir(autoloopHome);
      const store = openStore(dbPath);
      try {
        const targetView = ensureRulesBootstrappedInView(
          store,
          autoloopHome,
          nowMs,
          env,
          !dryRun,
        );
        const res = decide(
          targetView,
          { type: "ingestEvent", source: source.trim(), event },
          nowMs,
          env,
        );
        if (!dryRun) {
          store.commit(res.facts);
        }
        return formatFallbackResult({ ...res.value, dryRun });
      } finally {
        store.close();
      }
    }

    case "autoloop_answer": {
      ensurePrivateDir(autoloopHome);
      const store = openStore(dbPath);
      try {
        ensureRulesBootstrappedInView(store, autoloopHome, nowMs, env, true);
        const res = decide(
          store.view,
          {
            type: "answerCard",
            card: args.card,
            ...(args.choice !== undefined ? { choice: args.choice } : {}),
            ...(args.text !== undefined ? { text: args.text } : {}),
          },
          nowMs,
          env,
        );
        store.commit(res.facts);
        return formatFallbackResult(res.value);
      } finally {
        store.close();
      }
    }

    case "autoloop_resolve": {
      ensurePrivateDir(autoloopHome);
      const store = openStore(dbPath);
      try {
        ensureRulesBootstrappedInView(store, autoloopHome, nowMs, env, true);
        const res = decide(
          store.view,
          {
            type: "resolveCard",
            card: args.card,
            reason: args.reason,
          },
          nowMs,
          env,
        );
        store.commit(res.facts);
        return formatFallbackResult(res.value);
      } finally {
        store.close();
      }
    }

    case "autoloop_pause": {
      ensurePrivateDir(autoloopHome);
      const store = openStore(dbPath);
      try {
        ensureRulesBootstrappedInView(store, autoloopHome, nowMs, env, true);
        const res = decide(
          store.view,
          {
            type: "pauseRule",
            rule: args.rule,
            ...(args.reason !== undefined ? { reason: args.reason } : {}),
            ...(args.until !== undefined ? { until: args.until } : {}),
          },
          nowMs,
          env,
        );
        store.commit(res.facts);
        return formatFallbackResult(res.value);
      } finally {
        store.close();
      }
    }

    case "autoloop_resume": {
      ensurePrivateDir(autoloopHome);
      const store = openStore(dbPath);
      try {
        ensureRulesBootstrappedInView(store, autoloopHome, nowMs, env, true);
        const res = decide(
          store.view,
          { type: "resumeRule", rule: args.rule },
          nowMs,
          env,
        );
        store.commit(res.facts);
        return formatFallbackResult(res.value);
      } finally {
        store.close();
      }
    }

    case "autoloop_replay": {
      ensurePrivateDir(autoloopHome);
      const store = openStore(dbPath);
      try {
        ensureRulesBootstrappedInView(store, autoloopHome, nowMs, env, true);
        const res = decide(
          store.view,
          {
            type: "replayRule",
            rule: args.rule,
            ...(args.since !== undefined ? { since: args.since } : {}),
          },
          nowMs,
          env,
        );
        store.commit(res.facts);
        return formatFallbackResult(res.value);
      } finally {
        store.close();
      }
    }

    case "autoloop_run": {
      ensurePrivateDir(autoloopHome);
      const store = openStore(dbPath);
      try {
        ensureRulesBootstrappedInView(store, autoloopHome, nowMs, env, true);
        const res = decide(
          store.view,
          {
            type: "runRule",
            rule: args.rule,
            ...(args.subject !== undefined ? { subject: args.subject } : {}),
          },
          nowMs,
          env,
        );
        store.commit(res.facts);
        return formatFallbackResult(res.value);
      } finally {
        store.close();
      }
    }

    case "autoloop_stop": {
      ensurePrivateDir(autoloopHome);
      const store = openStore(dbPath);
      try {
        ensureRulesBootstrappedInView(store, autoloopHome, nowMs, env, true);
        const res = decide(
          store.view,
          { type: "stopRun", run: args.run },
          nowMs,
          env,
        );
        store.commit(res.facts);
        return formatFallbackResult(res.value);
      } finally {
        store.close();
      }
    }

    default:
      throw new InputError(`未知工具: ${toolName}`);
  }
}

async function executeViaIpc(endpoint, toolName, args) {
  switch (toolName) {
    case "autoloop_status": {
      const params = new URLSearchParams();
      if (args.beforeRun !== undefined) {
        params.set("before", String(args.beforeRun));
      }
      if (args.limit !== undefined) {
        params.set("limit", String(args.limit));
      }
      const qs = params.toString();
      const route = qs ? `/ipc/state?${qs}` : "/ipc/state";
      return formatIpcResult(await requestIpc(endpoint, "GET", route));
    }

    case "autoloop_why": {
      if (!Number.isSafeInteger(args.run) || args.run <= 0) {
        throw new InputError("run 必须是正整数");
      }
      const route = `/ipc/why?run=${encodeURIComponent(String(args.run))}`;
      return formatIpcResult(await requestIpc(endpoint, "GET", route));
    }

    case "autoloop_explain_rules": {
      const body = {};
      if (args.config !== undefined) body.config = args.config;
      if (args.nowMs !== undefined) body.nowMs = args.nowMs;
      return formatIpcResult(
        await requestIpc(endpoint, "POST", "/ipc/explain", body),
      );
    }

    case "autoloop_emit": {
      return formatIpcResult(
        await requestIpc(endpoint, "POST", "/ipc/emit", {
          source: args.source,
          event: args.event,
          ...(args.dryRun !== undefined ? { dryRun: args.dryRun } : {}),
        }),
      );
    }

    case "autoloop_answer": {
      return formatIpcResult(
        await requestIpc(endpoint, "POST", "/ipc/cards/answer", {
          card: args.card,
          ...(args.choice !== undefined ? { choice: args.choice } : {}),
          ...(args.text !== undefined ? { text: args.text } : {}),
        }),
      );
    }

    case "autoloop_resolve": {
      return formatIpcResult(
        await requestIpc(endpoint, "POST", "/ipc/cards/resolve", {
          card: args.card,
          reason: args.reason,
        }),
      );
    }

    case "autoloop_pause": {
      return formatIpcResult(
        await requestIpc(endpoint, "POST", "/ipc/rules/pause", {
          rule: args.rule,
          ...(args.reason !== undefined ? { reason: args.reason } : {}),
          ...(args.until !== undefined ? { until: args.until } : {}),
        }),
      );
    }

    case "autoloop_resume": {
      return formatIpcResult(
        await requestIpc(endpoint, "POST", "/ipc/rules/resume", {
          rule: args.rule,
        }),
      );
    }

    case "autoloop_replay": {
      return formatIpcResult(
        await requestIpc(endpoint, "POST", "/ipc/rules/replay", {
          rule: args.rule,
          ...(args.since !== undefined ? { since: args.since } : {}),
        }),
      );
    }

    case "autoloop_run": {
      return formatIpcResult(
        await requestIpc(endpoint, "POST", "/ipc/rules/run", {
          rule: args.rule,
          ...(args.subject !== undefined ? { subject: args.subject } : {}),
        }),
      );
    }

    case "autoloop_stop": {
      return formatIpcResult(
        await requestIpc(endpoint, "POST", "/ipc/runs/stop", {
          run: args.run,
        }),
      );
    }

    default:
      throw new InputError(`未知工具: ${toolName}`);
  }
}

export async function callAutoloopTool(toolName, rawArgs, env = process.env) {
  const known = TOOL_DEFINITIONS.some((t) => t.name === toolName);
  if (!known) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: `未知工具: ${String(toolName)}`,
              code: "UNKNOWN_TOOL",
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  const subagent = isSubagentContext(env);
  if (subagent && OWNER_ADMIN_TOOLS.has(toolName)) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: SUBAGENT_DENY_MESSAGE,
              code: "FORBIDDEN_SUBAGENT_ADMIN",
              tool: toolName,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  const args =
    rawArgs === undefined || rawArgs === null
      ? {}
      : asPlainObject(rawArgs, "arguments");
  const autoloopHome = resolveAutoloopHome(env);
  const nowMs = Date.now();

  try {
    const endpoint = readIpcEndpoint(autoloopHome, subagent);
    let data;
    if (endpoint) {
      try {
        data = await executeViaIpc(endpoint, toolName, args);
      } catch (err) {
        if (err instanceof IpcUnavailableError) {
          data = executeLocalFallback(toolName, args, autoloopHome, nowMs);
        } else {
          throw err;
        }
      }
    } else {
      data = executeLocalFallback(toolName, args, autoloopHome, nowMs);
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(data, null, 2),
        },
      ],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code =
      err instanceof KernelError ||
      err instanceof ProtocolInputError ||
      err instanceof IpcHttpError
        ? err.code
        : "TOOL_ERROR";
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: message, code }, null, 2),
        },
      ],
    };
  }
}

export function listToolsForEnv(env = process.env) {
  if (isSubagentContext(env)) {
    return TOOL_DEFINITIONS.filter((tool) => !OWNER_ADMIN_TOOLS.has(tool.name));
  }
  return TOOL_DEFINITIONS;
}

export async function handleJsonRpcMessage(msg, env = process.env) {
  if (Array.isArray(msg)) {
    if (msg.length === 0) {
      return {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid Request: empty batch" },
      };
    }
    const responses = [];
    for (const item of msg) {
      const res = await handleJsonRpcMessage(item, env);
      if (res !== null) {
        responses.push(res);
      }
    }
    return responses.length > 0 ? responses : null;
  }

  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") {
    return {
      jsonrpc: "2.0",
      id: msg && typeof msg === "object" && "id" in msg ? msg.id : null,
      error: { code: -32600, message: "Invalid Request" },
    };
  }

  const hasId =
    Object.prototype.hasOwnProperty.call(msg, "id") && msg.id !== undefined;
  const id = msg.id ?? null;
  const method = msg.method;

  if (typeof method !== "string") {
    return hasId
      ? {
          jsonrpc: "2.0",
          id,
          error: { code: -32600, message: "Invalid Request: missing method" },
        }
      : null;
  }

  // Notifications have no id and must not receive responses.
  if (!hasId) {
    return null;
  }

  const params =
    msg.params && typeof msg.params === "object" && !Array.isArray(msg.params)
      ? msg.params
      : {};

  switch (method) {
    case "initialize": {
      const requestedVersion =
        typeof params.protocolVersion === "string"
          ? params.protocolVersion
          : "";
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requestedVersion)
        ? requestedVersion
        : DEFAULT_PROTOCOL_VERSION;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: SERVER_NAME,
            version: SERVER_VERSION,
          },
        },
      };
    }

    case "ping":
      return { jsonrpc: "2.0", id, result: {} };

    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: listToolsForEnv(env),
        },
      };

    case "tools/call": {
      if (typeof params.name !== "string" || params.name.length === 0) {
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32602,
            message: "Invalid params: tools/call requires non-empty 'name'",
          },
        };
      }
      const toolResult = await callAutoloopTool(
        params.name,
        params.arguments,
        env,
      );
      return {
        jsonrpc: "2.0",
        id,
        result: toolResult,
      };
    }

    default:
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32601,
          message: `Method not found: ${method}`,
        },
      };
  }
}

function findHeaderTerminator(buf) {
  const crlfcrlf = buf.indexOf("\r\n\r\n");
  const lflf = buf.indexOf("\n\n");
  if (crlfcrlf === -1 && lflf === -1) {
    return null;
  }
  if (crlfcrlf !== -1 && (lflf === -1 || crlfcrlf < lflf)) {
    return { index: crlfcrlf, length: 4 };
  }
  return { index: lflf, length: 2 };
}

function skipLeadingWhitespace(buf) {
  let offset = 0;
  while (offset < buf.length) {
    const b = buf[offset];
    if (b === 0x20 || b === 0x09 || b === 0x0d || b === 0x0a) {
      offset += 1;
    } else {
      break;
    }
  }
  return offset > 0 ? buf.subarray(offset) : buf;
}

export function startStdioServer(
  stdin = process.stdin,
  stdout = process.stdout,
  env = process.env,
) {
  let buffer = Buffer.alloc(0);
  let stdinEnded = false;
  const inFlight = new Set();

  function writeMessage(payload) {
    if (payload !== null && payload !== undefined) {
      stdout.write(`${JSON.stringify(payload)}\n`);
    }
  }

  function dispatchRawJson(jsonText) {
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      writeMessage({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      return;
    }

    const job = (async () => {
      try {
        const response = await handleJsonRpcMessage(parsed, env);
        writeMessage(response);
      } catch (err) {
        writeMessage({
          jsonrpc: "2.0",
          id:
            parsed && typeof parsed === "object" && "id" in parsed
              ? parsed.id
              : null,
          error: {
            code: -32603,
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
    })();

    inFlight.add(job);
    job.finally(() => {
      inFlight.delete(job);
      maybeFinish();
    });
  }

  function drainBuffer(flushAtEof) {
    while (buffer.length > 0) {
      buffer = skipLeadingWhitespace(buffer);
      if (buffer.length === 0) {
        break;
      }

      const firstByte = buffer[0];
      const looksLikeJson = firstByte === 0x7b || firstByte === 0x5b; // '{' or '['

      if (!looksLikeJson) {
        const headerPreview = buffer
          .subarray(0, Math.min(buffer.length, 256))
          .toString("ascii");
        if (/^[A-Za-z-]+\s*:/.test(headerPreview)) {
          const term = findHeaderTerminator(buffer);
          if (!term) {
            if (flushAtEof) {
              buffer = Buffer.alloc(0);
            }
            break;
          }
          const headerText = buffer.subarray(0, term.index).toString("ascii");
          const match = /(?:^|\r?\n)content-length\s*:\s*(\d+)/i.exec(
            headerText,
          );
          if (!match) {
            buffer = buffer.subarray(term.index + term.length);
            writeMessage({
              jsonrpc: "2.0",
              id: null,
              error: {
                code: -32700,
                message: "Parse error: missing Content-Length header",
              },
            });
            continue;
          }
          const contentLength = Number(match[1]);
          const bodyStart = term.index + term.length;
          if (buffer.length < bodyStart + contentLength) {
            break;
          }
          const bodyText = buffer
            .subarray(bodyStart, bodyStart + contentLength)
            .toString("utf8");
          buffer = buffer.subarray(bodyStart + contentLength);
          dispatchRawJson(bodyText);
          continue;
        }
      }

      const nlIndex = buffer.indexOf(0x0a);
      if (nlIndex === -1) {
        if (flushAtEof) {
          const tail = buffer.toString("utf8").trim();
          buffer = Buffer.alloc(0);
          if (tail.length > 0) {
            dispatchRawJson(tail);
          }
        }
        break;
      }

      const line = buffer
        .subarray(0, nlIndex)
        .toString("utf8")
        .replace(/\r$/, "")
        .trim();
      buffer = buffer.subarray(nlIndex + 1);
      if (line.length > 0) {
        dispatchRawJson(line);
      }
    }
  }

  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  function maybeFinish() {
    if (stdinEnded && inFlight.size === 0) {
      resolveDone();
    }
  }

  stdin.on("data", (chunk) => {
    const bufChunk = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk, "utf8");
    buffer = Buffer.concat([buffer, bufChunk]);
    drainBuffer(false);
  });

  stdin.on("end", () => {
    stdinEnded = true;
    drainBuffer(true);
    maybeFinish();
  });

  stdin.on("error", () => {
    stdinEnded = true;
    maybeFinish();
  });

  return done;
}

function isMainEntry() {
  if (!process.argv[1]) {
    return false;
  }
  try {
    const entryUrl = pathToFileURL(realpathSync(process.argv[1])).href;
    return import.meta.url === entryUrl;
  } catch {
    return false;
  }
}

if (isMainEntry()) {
  startStdioServer().then(() => {
    process.exit(0);
  });
}
