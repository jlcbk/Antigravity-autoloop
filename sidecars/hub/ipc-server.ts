/**
 * Local loopback IPC HTTP server, token/key provisioning, rule explainer,
 * and HubRuntime orchestrating single-transaction store+decide commits,
 * earliestDueMs timer scheduling, Worker supervision, and desktop notifications.
 */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { expandHomePath, tidyRuns } from "../../engine/context-file.ts";
import {
  createSupervisor,
  type CustomRunnerHandler,
  type Supervisor,
  type SupervisorBackend,
} from "../../engine/supervisor.ts";
import { nextRun, parseCron } from "../../kernel/cron.ts";
import {
  decide,
  type DecideEnv,
  type KernelInput,
} from "../../kernel/decide.ts";
import { earliestDueMs } from "../../kernel/due.ts";
import {
  AuthError,
  ConflictError,
  InputError,
  KernelError,
  NotFoundError,
} from "../../kernel/errors.ts";
import { iso, type View } from "../../kernel/evolve.ts";
import { cardViewOf, groupOf, rulesOf, whyOf } from "../../kernel/query.ts";
import {
  createTokenSigner,
  openStore,
  safeTokenEquals,
  type Store,
} from "../../kernel/store.ts";
import { parseRulesConfig } from "../../protocol/rules-schema.ts";
import type {
  CardView,
  RulesConfig,
  StateSnapshot,
  WhyReport,
} from "../../protocol/types.ts";
import { isPlainObject, ProtocolInputError } from "../../protocol/validate.ts";
import {
  createNotifier,
  type Notifier,
  type NotifierOptions,
} from "./notifier.ts";
import {
  buildStateSnapshot,
  type StateSnapshotOptions,
} from "./state-queries.ts";

export class ForbiddenError extends KernelError {
  constructor(message = "ingest.token 无权执行管理操作，请使用 owner.token") {
    super(message, 403, "FORBIDDEN");
  }
}

export interface HubTokens {
  ownerToken: string;
  ingestToken: string;
  masterKey: string;
}

export interface IpcDiscoveryInfo {
  host: string;
  port: number;
  pid: number;
  startedAt: string;
}

export interface ExplainedRuleItem {
  name: string;
  triggerKind: "cron" | "source" | "watch";
  trigger: unknown;
  to: string;
  agentName: string;
  runner: string;
  model: string | null;
  access: string;
  cwd: string;
  group: string;
  parallel: number | null;
  maxActive: number | null;
  resume: boolean;
  tell: string;
  paused: boolean;
  pausedUntil: string | null;
  nextRunAt: string | null;
  emits: { source: string; types: string[] } | null;
}

export interface ExplainRulesReport {
  valid: true;
  now: string;
  timezone: string;
  activeVersion: number;
  askFirst: string[];
  sources: Array<{ id: string; name: string }>;
  agents: Array<{
    id: string;
    name: string;
    runner: string;
    model: string | null;
    access: string;
    maxActive: number | null;
    timeoutMinutes: number;
  }>;
  rules: ExplainedRuleItem[];
}

export interface HubRuntimeOptions {
  autoloopHome?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  enableSupervisor?: boolean;
  capacity?: number;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  killGraceMs?: number;
  agyBin?: string;
  agentApiBin?: string;
  appDataDir?: string;
  baseEnv?: NodeJS.ProcessEnv;
  deliveryRunner?: CustomRunnerHandler;
  notifier?: Notifier;
  notifierOptions?: NotifierOptions;
  onError?: (err: unknown) => void;
}

export interface IpcServerOptions {
  runtime: HubRuntime;
  autoloopHome?: string;
  ownerToken?: string;
  ingestToken?: string;
  host?: string;
  port?: number;
  rulesFilePath?: string;
  onError?: (err: unknown) => void;
}

export interface IpcServerHandle {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly ipcFilePath: string;
  readonly server: Server;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 1024 * 1024;
const HEX_64_RE = /^[0-9a-fA-F]{64,}$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function ensurePrivateDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  chmodSync(dirPath, 0o700);
}

export function atomicWritePrivateFile(
  filePath: string,
  content: string,
): void {
  const dir = path.dirname(filePath);
  ensurePrivateDir(dir);
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
      // Best-effort cleanup
    }
    throw err;
  }
}

function readOrCreateSecretFile(
  filePath: string,
  validator?: (val: string) => boolean,
): string {
  if (existsSync(filePath)) {
    try {
      const existing = readFileSync(filePath, "utf8").trim();
      if (existing.length > 0 && (!validator || validator(existing))) {
        chmodSync(filePath, 0o600);
        return existing;
      }
    } catch {
      // Fall through to regenerate
    }
  }
  const secret = randomBytes(32).toString("hex");
  atomicWritePrivateFile(filePath, `${secret}\n`);
  return secret;
}

/**
 * Resolves the Autoloop data root directory.
 * Precedence: `env.AUTOLOOP_HOME` -> `env.PLUGIN_DATA` -> `path.join(os.homedir(), ".autoloop")`.
 */
export function resolveAutoloopHome(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const rawHome = env.AUTOLOOP_HOME?.trim();
  if (rawHome) {
    return expandHomePath(rawHome);
  }
  const pluginData = env.PLUGIN_DATA?.trim();
  if (pluginData) {
    return expandHomePath(pluginData);
  }
  return path.join(os.homedir(), ".autoloop");
}

/**
 * Idempotently provisions or loads `owner.token`, `ingest.token`, and `master.key`
 * inside `<autoloopHome>` with strict `0o600` file permissions.
 */
export function ensureHubTokens(autoloopHome: string): HubTokens {
  const home = expandHomePath(autoloopHome);
  ensurePrivateDir(home);

  const ownerToken = readOrCreateSecretFile(path.join(home, "owner.token"));
  const ingestToken = readOrCreateSecretFile(path.join(home, "ingest.token"));
  const masterKey = readOrCreateSecretFile(
    path.join(home, "master.key"),
    (val) => val.length % 2 === 0 && HEX_64_RE.test(val),
  );

  return { ownerToken, ingestToken, masterKey };
}

function wrapInputError<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ProtocolInputError) {
      throw new InputError(err.message);
    }
    throw err;
  }
}

/**
 * Validates a RulesConfig (active or draft) and explains each rule's routing,
 * agent bindings, pause state, and next Cron fire timestamp.
 */
export function explainRules(
  rawConfig: unknown,
  view: View,
  nowMs: number,
): ExplainRulesReport {
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) {
    throw new InputError(`无效时间戳: ${String(nowMs)}`);
  }

  const config = wrapInputError(() => parseRulesConfig(rawConfig));
  const fallbackTz = config.timezone ?? "UTC";
  const activeEntry = rulesOf(view);

  const rules: ExplainedRuleItem[] = config.rules.map((rule) => {
    const agent = config.agents[rule.to]!;
    const pauseRow = view.get("pauses", rule.name);
    let paused = false;
    let pausedUntil: string | null = null;
    if (pauseRow) {
      if (pauseRow.until === null || pauseRow.until === undefined) {
        paused = true;
      } else {
        const untilMs = Date.parse(String(pauseRow.until));
        if (Number.isFinite(untilMs) && untilMs > nowMs) {
          paused = true;
          pausedUntil = String(pauseRow.until);
        }
      }
    }

    let triggerKind: "cron" | "source" | "watch";
    let nextRunAt: string | null = null;
    if ("cron" in rule.when) {
      triggerKind = "cron";
      parseCron(rule.when.cron, fallbackTz);
      nextRunAt = iso(nextRun(rule.when.cron, fallbackTz, nowMs));
    } else if ("watch" in rule.when) {
      triggerKind = "watch";
    } else {
      triggerKind = "source";
    }

    return {
      name: rule.name,
      triggerKind,
      trigger: rule.when,
      to: rule.to,
      agentName: agent.name,
      runner: agent.runner,
      model: agent.model ?? null,
      access: agent.access ?? "edit",
      cwd: rule.cwd,
      group: groupOf(rule),
      parallel: rule.parallel ?? null,
      maxActive: rule.maxActive ?? null,
      resume: rule.resume ?? false,
      tell: rule.tell ?? "needed",
      paused,
      pausedUntil,
      nextRunAt,
      emits: rule.emits ?? null,
    };
  });

  return {
    valid: true,
    now: iso(nowMs),
    timezone: fallbackTz,
    activeVersion: activeEntry?.version ?? 0,
    askFirst: [...config.askFirst],
    sources: Object.entries(config.sources).map(([id, s]) => ({
      id,
      name: s.name,
    })),
    agents: Object.entries(config.agents).map(([id, a]) => ({
      id,
      name: a.name,
      runner: a.runner,
      model: a.model ?? null,
      access: a.access ?? "edit",
      maxActive: a.maxActive ?? null,
      timeoutMinutes: a.timeoutMinutes ?? 60,
    })),
    rules,
  };
}

/**
 * In-process runtime combining SQLite Store, deterministic Decide kernel,
 * precision `earliestDueMs` timer, Supervisor loop, and card notifications.
 */
export class HubRuntime {
  readonly autoloopHome: string;
  readonly store: Store;
  readonly tokens: HubTokens;
  readonly notifier: Notifier;
  readonly supervisor: Supervisor | null;
  readonly supervisorBackend: SupervisorBackend;

  readonly #now: () => number;
  readonly #decideEnv: DecideEnv;
  readonly #onError: ((err: unknown) => void) | undefined;
  readonly #rulesListeners = new Set<(config: RulesConfig) => void>();

  #dueTimer: ReturnType<typeof setTimeout> | null = null;
  #started = false;
  #closed = false;

  constructor(options: HubRuntimeOptions = {}) {
    const env = options.env ?? process.env;
    this.autoloopHome = options.autoloopHome
      ? expandHomePath(options.autoloopHome)
      : resolveAutoloopHome(env);
    ensurePrivateDir(this.autoloopHome);

    this.tokens = ensureHubTokens(this.autoloopHome);
    this.store = openStore(path.join(this.autoloopHome, "hub.db"));
    this.#now = options.now ?? (() => Date.now());
    this.#onError = options.onError;

    const signToken = createTokenSigner(this.tokens.masterKey);
    this.#decideEnv = { signToken, safeTokenEquals };

    this.notifier =
      options.notifier ??
      createNotifier({
        onError: this.#onError,
        ...options.notifierOptions,
      });

    this.supervisorBackend = {
      claimWork: (input) =>
        this.dispatch({
          type: "claimWork",
          claimId: input.claimId,
          capacity: input.capacity,
          running: input.running,
        }),
      markStarted: (input) =>
        this.dispatch({
          type: "markStarted",
          run: input.run,
          token: input.token,
          session: input.session,
        }),
      submitResult: (input) =>
        this.dispatch({
          type: "submitResult",
          run: input.run,
          token: input.token,
          result: input.result,
        }),
    };

    const enableSup = options.enableSupervisor ?? true;
    this.supervisor = enableSup
      ? createSupervisor({
          autoloopHome: this.autoloopHome,
          backend: this.supervisorBackend,
          capacity: options.capacity,
          pollIntervalMs: options.pollIntervalMs,
          heartbeatIntervalMs: options.heartbeatIntervalMs,
          killGraceMs: options.killGraceMs,
          agyBin: options.agyBin,
          agentApiBin: options.agentApiBin,
          appDataDir: options.appDataDir,
          baseEnv: options.baseEnv,
          deliveryRunner: options.deliveryRunner,
          onError: this.#onError,
        })
      : null;
  }

  onRulesChanged(listener: (config: RulesConfig) => void): () => void {
    this.#rulesListeners.add(listener);
    return () => {
      this.#rulesListeners.delete(listener);
    };
  }

  start(): void {
    if (this.#closed || this.#started) {
      return;
    }
    this.#started = true;
    try {
      tidyRuns(this.autoloopHome, this.#now());
    } catch (err) {
      this.#onError?.(err);
    }
    try {
      this.tick();
    } catch (err) {
      this.#onError?.(err);
    }
    this.rescheduleDueTimer();
    this.supervisor?.start();
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#started = false;
    this.#clearDueTimer();
    if (this.supervisor) {
      await this.supervisor.stop();
    }
    this.store.close();
  }

  #clearDueTimer(): void {
    if (this.#dueTimer !== null) {
      clearTimeout(this.#dueTimer);
      this.#dueTimer = null;
    }
  }

  rescheduleDueTimer(): void {
    this.#clearDueTimer();
    if (this.#closed) {
      return;
    }
    const nextDue = earliestDueMs(this.store.view);
    if (nextDue === null) {
      return;
    }
    const rawDelay = nextDue - this.#now();
    const delay = Math.max(1, Math.min(0x7fffffff, rawDelay));
    this.#dueTimer = setTimeout(() => {
      this.#dueTimer = null;
      if (this.#closed) {
        return;
      }
      try {
        this.tick();
      } catch (err) {
        this.#onError?.(err);
      }
      this.supervisor?.kick().catch((err) => this.#onError?.(err));
    }, delay);
    this.#dueTimer.unref?.();
  }

  dispatch<T = any>(input: KernelInput): T {
    if (this.#closed) {
      throw new ConflictError("HubRuntime 已关闭");
    }
    const nowMs = this.#now();
    const prevSeq = this.store.view.seq;
    let value!: T;
    let newNotifyCandidates: CardView[] = [];

    const committedFact = this.store.commitLatest((latestView) => {
      const res = decide<T>(latestView, input, nowMs, this.#decideEnv);
      value = res.value;
      newNotifyCandidates = [];
      if (res.facts.length > 1) {
        throw new ConflictError(
          `单次 decide 最多返回 1 条 Fact，实际返回 ${res.facts.length} 条`,
        );
      }
      const fact = res.facts[0] ?? null;
      if (fact !== null) {
        for (const change of fact.changes) {
          if (change.table === "cards" && change.row !== null) {
            const isNewlyCreated =
              latestView.get("cards", change.key) === undefined;
            if (
              isNewlyCreated &&
              (change.row.status === "open" || change.row.fyi === true)
            ) {
              newNotifyCandidates.push(cardViewOf(change.row));
            }
          }
        }
      }
      return fact;
    });

    if (committedFact !== null && newNotifyCandidates.length > 0) {
      const activeConfig = rulesOf(this.store.view)?.config;
      void this.notifier
        .notifyCards(newNotifyCandidates, activeConfig)
        .catch((e) => {
          this.#onError?.(e);
        });
    }

    if (input.type === "configureRules") {
      const activeConfig = rulesOf(this.store.view)?.config;
      if (activeConfig) {
        for (const listener of this.#rulesListeners) {
          try {
            listener(activeConfig);
          } catch (err) {
            this.#onError?.(err);
          }
        }
      }
    }

    if (
      committedFact !== null ||
      this.store.view.seq > prevSeq ||
      input.type === "tick"
    ) {
      this.rescheduleDueTimer();
    }

    if (
      this.#started &&
      this.supervisor &&
      (input.type === "ingestEvent" ||
        input.type === "answerCard" ||
        input.type === "replayRule" ||
        input.type === "runRule" ||
        input.type === "resumeRule" ||
        input.type === "configureRules" ||
        input.type === "stopRun" ||
        input.type === "tick")
    ) {
      void this.supervisor.kick().catch((err) => this.#onError?.(err));
    }

    return value;
  }

  getHealth(): { ok: true; pid: number; seq: number } {
    return {
      ok: true,
      pid: process.pid,
      seq: this.store.view.seq,
    };
  }

  getState(options?: StateSnapshotOptions): StateSnapshot {
    return buildStateSnapshot(this.store, this.#now(), options);
  }

  getWhy(runId: number): WhyReport {
    if (
      typeof runId !== "number" ||
      !Number.isSafeInteger(runId) ||
      runId <= 0
    ) {
      throw new InputError("run 必须是正整数");
    }
    return whyOf(this.store.view, runId);
  }

  explainRules(rawConfig?: unknown, nowMs?: number): ExplainRulesReport {
    const targetConfig =
      rawConfig !== undefined ? rawConfig : rulesOf(this.store.view)?.config;
    if (targetConfig === undefined) {
      throw new NotFoundError("规则配置尚未初始化");
    }
    const targetNow = nowMs !== undefined ? nowMs : this.#now();
    return explainRules(targetConfig, this.store.view, targetNow);
  }

  configureRules(config: unknown): unknown {
    return this.dispatch({ type: "configureRules", config });
  }

  ingestEvent(
    source: string,
    event: unknown,
    dryRun = false,
  ): Record<string, unknown> {
    if (typeof dryRun !== "boolean") {
      throw new InputError("dryRun 必须是布尔值");
    }
    if (dryRun) {
      const { value } = decide<Record<string, unknown>>(
        this.store.view,
        { type: "ingestEvent", source, event },
        this.#now(),
        this.#decideEnv,
      );
      return { ...value, dryRun: true };
    }
    const value = this.dispatch<Record<string, unknown>>({
      type: "ingestEvent",
      source,
      event,
    });
    return { ...value, dryRun: false };
  }

  answerCard(input: { card: number; choice?: number; text?: string }): unknown {
    return this.dispatch({
      type: "answerCard",
      card: input.card,
      choice: input.choice,
      text: input.text,
    });
  }

  resolveCard(input: { card: number; reason: string }): unknown {
    return this.dispatch({
      type: "resolveCard",
      card: input.card,
      reason: input.reason,
    });
  }

  stopRun(run: number): unknown {
    return this.dispatch({ type: "stopRun", run });
  }

  pauseRule(input: {
    rule: string;
    reason?: string;
    until?: string | null;
  }): unknown {
    return this.dispatch({
      type: "pauseRule",
      rule: input.rule,
      reason: input.reason,
      until: input.until,
    });
  }

  resumeRule(rule: string): unknown {
    return this.dispatch({ type: "resumeRule", rule });
  }

  replayRule(input: { rule: string; since?: string | number }): unknown {
    return this.dispatch({
      type: "replayRule",
      rule: input.rule,
      since: input.since,
    });
  }

  runRule(input: { rule: string; subject?: string }): unknown {
    return this.dispatch({
      type: "runRule",
      rule: input.rule,
      subject: input.subject,
    });
  }

  tick(): unknown {
    return this.dispatch({ type: "tick" });
  }
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  extraHeaders?: Record<string, string>,
): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...extraHeaders,
  });
  res.end(body);
}

function extractBearerOrHeaderToken(req: IncomingMessage): string | null {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string") {
    const trimmed = authHeader.trim();
    if (trimmed.slice(0, 7).toLowerCase() === "bearer ") {
      const token = trimmed.slice(7).trim();
      if (token.length > 0) {
        return token;
      }
    }
  }
  const altHeader = req.headers["x-autoloop-token"];
  if (typeof altHeader === "string" && altHeader.trim().length > 0) {
    return altHeader.trim();
  }
  return null;
}

function parseOptionalPositiveInt(
  raw: string | null,
  label: string,
): number | undefined {
  if (raw === null || raw === "") {
    return undefined;
  }
  if (!/^\d+$/.test(raw)) {
    throw new InputError(`${label} 必须是正整数`);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new InputError(`${label} 必须是正安全整数`);
  }
  return n;
}

async function readJsonBody(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw new InputError("请求体过大，超过 1MB 上限");
    }
    chunks.push(buf);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw.length === 0) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InputError("请求体不是合法的 JSON");
  }
  if (!isPlainObject(parsed)) {
    throw new InputError("请求体必须是 JSON 对象");
  }
  return parsed;
}

const OWNER_ONLY_ROUTES = new Set([
  "POST /ipc/cards/answer",
  "POST /ipc/cards/resolve",
  "POST /ipc/runs/stop",
  "POST /ipc/rules/pause",
  "POST /ipc/rules/resume",
  "POST /ipc/rules/replay",
  "POST /ipc/rules/run",
  "POST /ipc/rules/reload",
]);

const KNOWN_IPC_ROUTES = new Set([
  "GET /ipc/health",
  "GET /ipc/state",
  "GET /ipc/why",
  "POST /ipc/explain",
  "POST /ipc/emit",
  ...OWNER_ONLY_ROUTES,
]);

/**
 * Starts the loopback-only authenticated local IPC HTTP server on `127.0.0.1:0`
 * (or configured port) and atomically writes `<autoloopHome>/ipc.json` (`0o600`).
 */
export async function startIpcServer(
  options: IpcServerOptions,
): Promise<IpcServerHandle> {
  const runtime = options.runtime;
  const autoloopHome = options.autoloopHome
    ? expandHomePath(options.autoloopHome)
    : runtime.autoloopHome;
  const host = options.host ?? "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new InputError(`IPC 服务仅允许绑定回环地址，禁止绑定: ${host}`);
  }
  const ownerToken = options.ownerToken ?? runtime.tokens.ownerToken;
  const ingestToken = options.ingestToken ?? runtime.tokens.ingestToken;
  const rulesFilePath =
    options.rulesFilePath ?? path.join(autoloopHome, "rules.json");
  const ipcFilePath = path.join(autoloopHome, "ipc.json");

  const server = createServer(async (req, res) => {
    try {
      const method = (req.method ?? "GET").toUpperCase();
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const routeKey = `${method} ${url.pathname}`;

      if (routeKey === "GET /ipc/health") {
        sendJson(res, 200, runtime.getHealth());
        return;
      }

      const providedToken = extractBearerOrHeaderToken(req);
      if (!providedToken) {
        throw new AuthError("缺少本地 IPC 鉴权凭据");
      }

      const isOwner = safeTokenEquals(providedToken, ownerToken);
      const isIngest = !isOwner && safeTokenEquals(providedToken, ingestToken);
      if (!isOwner && !isIngest) {
        throw new AuthError("无效的本地 IPC 凭据");
      }

      if (!KNOWN_IPC_ROUTES.has(routeKey)) {
        throw new NotFoundError(`未知 IPC 路由: ${routeKey}`);
      }

      if (OWNER_ONLY_ROUTES.has(routeKey) && !isOwner) {
        throw new ForbiddenError();
      }

      switch (routeKey) {
        case "GET /ipc/state": {
          const beforeRun = parseOptionalPositiveInt(
            url.searchParams.get("before"),
            "before",
          );
          const limit = parseOptionalPositiveInt(
            url.searchParams.get("limit"),
            "limit",
          );
          const snapshot = runtime.getState({ beforeRun, limit });
          const reqEtag =
            url.searchParams.get("etag") ??
            (typeof req.headers["if-none-match"] === "string"
              ? req.headers["if-none-match"]
              : null);
          if (reqEtag && reqEtag === snapshot.etag) {
            res.writeHead(304, { ETag: snapshot.etag });
            res.end();
            return;
          }
          sendJson(res, 200, snapshot, { ETag: snapshot.etag });
          return;
        }

        case "GET /ipc/why": {
          const runId = parseOptionalPositiveInt(
            url.searchParams.get("run"),
            "run",
          );
          if (runId === undefined) {
            throw new InputError("缺少查询参数 run");
          }
          sendJson(res, 200, runtime.getWhy(runId));
          return;
        }

        case "POST /ipc/explain": {
          const body = await readJsonBody(req);
          if (body.nowMs !== undefined && typeof body.nowMs !== "number") {
            throw new InputError("nowMs 必须是有限数字");
          }
          sendJson(
            res,
            200,
            runtime.explainRules(body.config, body.nowMs as number | undefined),
          );
          return;
        }

        case "POST /ipc/emit": {
          const body = await readJsonBody(req);
          const dryRun = body.dryRun === undefined ? false : body.dryRun;
          if (typeof dryRun !== "boolean") {
            throw new InputError("dryRun 必须是布尔值");
          }
          const result = runtime.ingestEvent(
            body.source as string,
            body.event,
            dryRun,
          );
          sendJson(res, 200, result);
          return;
        }

        case "POST /ipc/cards/answer": {
          const body = await readJsonBody(req);
          const result = runtime.answerCard({
            card: body.card as number,
            choice: body.choice as number | undefined,
            text: body.text as string | undefined,
          });
          sendJson(res, 200, result);
          return;
        }

        case "POST /ipc/cards/resolve": {
          const body = await readJsonBody(req);
          const result = runtime.resolveCard({
            card: body.card as number,
            reason: body.reason as string,
          });
          sendJson(res, 200, result);
          return;
        }

        case "POST /ipc/runs/stop": {
          const body = await readJsonBody(req);
          sendJson(res, 200, runtime.stopRun(body.run as number));
          return;
        }

        case "POST /ipc/rules/pause": {
          const body = await readJsonBody(req);
          const result = runtime.pauseRule({
            rule: body.rule as string,
            reason: body.reason as string | undefined,
            until: body.until as string | null | undefined,
          });
          sendJson(res, 200, result);
          return;
        }

        case "POST /ipc/rules/resume": {
          const body = await readJsonBody(req);
          sendJson(res, 200, runtime.resumeRule(body.rule as string));
          return;
        }

        case "POST /ipc/rules/replay": {
          const body = await readJsonBody(req);
          const result = runtime.replayRule({
            rule: body.rule as string,
            since: body.since as string | number | undefined,
          });
          sendJson(res, 200, result);
          return;
        }

        case "POST /ipc/rules/run": {
          const body = await readJsonBody(req);
          const result = runtime.runRule({
            rule: body.rule as string,
            subject: body.subject as string | undefined,
          });
          sendJson(res, 200, result);
          return;
        }

        case "POST /ipc/rules/reload": {
          const body = await readJsonBody(req);
          let configToLoad = body.config;
          if (configToLoad === undefined) {
            if (!existsSync(rulesFilePath)) {
              throw new NotFoundError(`未找到规则文件: ${rulesFilePath}`);
            }
            const rawText = readFileSync(rulesFilePath, "utf8");
            try {
              configToLoad = JSON.parse(rawText);
            } catch (err) {
              throw new InputError(
                `rules.json 语法错误: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
          sendJson(res, 200, runtime.configureRules(configToLoad));
          return;
        }

        default:
          throw new NotFoundError(`未知 IPC 路由: ${routeKey}`);
      }
    } catch (err) {
      if (err instanceof KernelError) {
        sendJson(res, err.statusCode, { error: err.message, code: err.code });
        return;
      }
      if (err instanceof ProtocolInputError) {
        sendJson(res, 400, { error: err.message, code: err.code });
        return;
      }
      options.onError?.(err);
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : String(err),
        code: "INTERNAL_ERROR",
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onErr = (err: Error) => {
      server.off("listening", onListen);
      reject(err);
    };
    const onListen = () => {
      server.off("error", onErr);
      resolve();
    };
    server.once("error", onErr);
    server.once("listening", onListen);
    server.listen(options.port ?? 0, host);
  });

  const addr = server.address() as AddressInfo;
  const discovery: IpcDiscoveryInfo = {
    host,
    port: addr.port,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  atomicWritePrivateFile(
    ipcFilePath,
    `${JSON.stringify(discovery, null, 2)}\n`,
  );

  let closed = false;
  return {
    host,
    port: addr.port,
    url: `http://${host}:${addr.port}`,
    ipcFilePath,
    server,
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      try {
        if (existsSync(ipcFilePath)) {
          const existing = JSON.parse(
            readFileSync(ipcFilePath, "utf8"),
          ) as Partial<IpcDiscoveryInfo>;
          if (existing.pid === process.pid && existing.port === addr.port) {
            rmSync(ipcFilePath, { force: true });
          }
        }
      } catch {
        // Best-effort cleanup
      }
    },
  };
}
