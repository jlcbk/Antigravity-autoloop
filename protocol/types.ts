/**
 * Frozen protocol contracts shared across kernel, execution, host, MCP, CLI, and UI layers.
 * Uses Node 24 erasable TypeScript syntax with zero runtime dependencies.
 */

export interface InboundEvent {
  /** 来源内幂等唯一键，最长 200 字符 */
  id: string;
  /** 事件类型（仅允许 [a-zA-Z0-9._-]，最长 64 字符），如 "git.branch.ready"、"cron.due" */
  type: string;
  /** 业务事项标识（仅允许 [a-zA-Z0-9#._:/@-]，最长 100 字符），会进入安全提示词头部 */
  subject?: string;
  /** 一句话摘要（最长 200 字符），仅写入 context.json，严禁拼入提示词 */
  summary?: string;
  /** 详细负载文本（最长 8000 字符），仅写入 context.json，严禁拼入提示词 */
  detail?: string;
  /** 纯 ASCII http/https/file 链接（最长 500 字符） */
  link?: string;
  /** 事件传递跳数，外部源默认为 0，回执衍生自动 +1，超过 8 触发熔断 */
  hops?: number;
}

export type AccessTier = "read" | "edit" | "full";
export type RunnerKind =
  | "agy-print"
  | "agentapi-ui"
  | "command"
  | "delivery"
  | "codex"
  | "claude"
  | "acp"
  | "herdr";
export type TellPolicy = "always" | "needed" | "never";
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface AgentProfile {
  name: string;
  runner: RunnerKind;
  /** 模型标识 ID */
  model?: string;
  effort?: EffortLevel;
  access?: AccessTier;
  /**
   * 可执行命令与参数数组：
   * - runner === "command" 或 "acp" 时必填（如 ["opencode", "acp"]）
   * - runner === "codex"、"claude" 或 "herdr" 时可选（如 ["zcode"]、["dsh"]、["herdr", "--machine", "vps"]）
   */
  command?: string[];
  /**
   * runner === "herdr" 时的目标选择器（如 "w3:p1"、"reviewer"、"kind:codex"、"spawn:opencode"）
   */
  target?: string;
  /** 跨所有规则最大同时运行轮数 */
  maxActive?: number;
  /** 单轮超时分钟数，默认 60 */
  timeoutMinutes?: number;
}

export type RuleTrigger =
  | { cron: string }
  | { source: string; types: string[] }
  | { watch: { paths: string[]; debounceMs?: number; types?: string[] } };

export interface RuleSpec {
  name: string;
  when: RuleTrigger;
  /** 对应 agents 中的键名 */
  to: string;
  /** 任务执行的工作区绝对路径或 ~/ 路径 */
  cwd: string;
  /** 要加载的 Skill 名称 */
  skill?: string;
  /** 补充任务指令（可信来源） */
  prompt?: string;
  /** 会话标题模板，仅允许首字符字母数字的无空白标识符，支持 {subject} 与 {id} */
  title?: string;
  /** 并发控制组名，默认等于规则 name */
  group?: string;
  /** 存在时按 subject 切分独立事项（Lane），并指定同组最大并发轮数 */
  parallel?: number;
  /** 单条规则最大同时运行轮数 */
  maxActive?: number;
  /** 同事项新事件是否默认续接上一轮成功会话 */
  resume?: boolean;
  /** 通知策略，默认 "needed" */
  tell?: TellPolicy;
  /** 允许回执发出的衍生事件白名单 */
  emits?: { source: string; types: string[] };
}

export interface RulesConfig {
  timezone?: string;
  /** 全局必须先上呈「票拟」卡片获批的动作类别与命令模式 */
  askFirst: string[];
  sources: Record<string, { name: string }>;
  agents: Record<string, AgentProfile>;
  rules: RuleSpec[];
}

export interface JobEventContext extends InboundEvent {
  source: string;
  sourceName: string;
  receivedAt: string;
}

export interface JobAnswerContext {
  card: number;
  key: string;
  title: string;
  options: string[];
  choice: number | null;
  chosen: string;
  about: string;
  at: string;
}

export interface JobTimerContext {
  key: string;
  about: string;
  at: string;
}

export interface JobOpenCardContext {
  card: number;
  key: string;
  title: string;
  text: string;
  at: string;
}

export interface JobDecidedCardContext {
  card: number;
  key: string;
  title: string;
  choice: string;
  at: string;
}

export interface Job {
  run: number;
  /** 单轮单次执行专属 HMAC Token */
  token: string;
  attempt: number;
  rule: Pick<RuleSpec, "name" | "cwd" | "skill" | "prompt" | "title" | "emits">;
  agent: AgentProfile & { id: string };
  /** 期望续接的会话 ID（无法续接时安全降级开新会话） */
  session: string | null;
  askFirst: string[];
  context: {
    events: JobEventContext[];
    answers: JobAnswerContext[];
    timers: JobTimerContext[];
    waiting: JobTimerContext[];
    open: JobOpenCardContext[];
    decided: JobDecidedCardContext[];
  };
}

export interface ReceiptAsk {
  key: string;
  title: string;
  text: string;
  options: string[];
  recommend?: number;
  about: string;
}

export interface ReceiptNotice {
  key?: string;
  title: string;
  text: string;
  fyi?: boolean;
}

export interface ReceiptResolve {
  card: number;
  reason: string;
}

export type ReceiptLater =
  | { key: string; at: string; about: string; cancel?: false }
  | { key: string; cancel: true };

export interface Receipt {
  ask?: ReceiptAsk[];
  notice?: ReceiptNotice[];
  resolve?: ReceiptResolve[];
  later?: ReceiptLater[];
  events?: InboundEvent[];
}

export type RunOutcome = "done" | "nothing" | "failed" | "cancelled";

export interface RunUsage {
  input?: number;
  output?: number;
  cached?: number;
  cost?: number;
}

export interface RunResult extends Receipt {
  outcome: RunOutcome;
  summary?: string;
  error?: string;
  /** 本轮实际使用的会话 ID */
  session?: string;
  usage?: RunUsage;
}

export interface ParsedMessage {
  outcome: "done" | "nothing" | "failed";
  summary: string;
  receipt: Receipt | null;
  problem: string | null;
}

export type CardKind = "ask" | "notice";
export type CardStatus = "open" | "decided" | "done" | "closed";
export type RunStatus =
  | "queued"
  | "claimed"
  | "unknown"
  | "done"
  | "nothing"
  | "failed"
  | "cancelled";

export interface CardView {
  card: number;
  kind: CardKind;
  status: CardStatus;
  rule: string;
  lane: string;
  key: string;
  title: string;
  text: string;
  options?: string[];
  recommend?: number;
  about?: string;
  fyi?: boolean;
  choice?: number | null;
  chosen?: string;
  answerText?: string;
  resolvedReason?: string;
  run?: number;
  session?: string | null;
  createdAt: string;
  decidedAt?: string | null;
  closedAt?: string | null;
}

export interface RunSummary {
  run: number;
  rule: string;
  lane: string;
  group: string;
  agent: string;
  runner: RunnerKind;
  model?: string;
  status: RunStatus;
  attempt: number;
  session: string | null;
  summary?: string;
  error?: string;
  usage?: RunUsage;
  createdAt: string;
  claimedAt?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  notBefore?: string | null;
  cancelAt?: string | null;
  heartbeatAt?: string | null;
}

export interface PipelineLineView {
  rule: string;
  group: string;
  to: string;
  cwd: string;
  status: "running" | "idle" | "paused";
  activeRuns: number;
  queuedRuns: number;
  doneToday: number;
  lastRunAt?: string | null;
  nextRunAt?: string | null;
  pausedUntil?: string | null;
  pauseReason?: string | null;
  skippedCount: number;
}

export interface TimerView {
  key: string;
  rule: string;
  lane: string;
  about: string;
  at: string;
  session?: string | null;
}

export interface PauseView {
  rule: string;
  reason?: string;
  pausedAt: string;
  until?: string | null;
}

export interface SkippedEventView {
  seq: number;
  rule: string;
  source: string;
  sourceName: string;
  eventId: string;
  type: string;
  subject?: string;
  summary?: string;
  link?: string;
  receivedAt: string;
  replayedAt?: string | null;
}

export interface SpendingWindow {
  runs: number;
  input: number;
  output: number;
  cached: number;
  cost: number;
}

export interface SpendingSummary {
  today: SpendingWindow;
  last7Days: SpendingWindow;
}

export interface StateSnapshot {
  etag: string;
  now: string;
  cards: CardView[];
  recentCards: CardView[];
  lines: PipelineLineView[];
  runs: RunSummary[];
  hasMoreRuns?: boolean;
  timers: TimerView[];
  pauses: PauseView[];
  skipped: SkippedEventView[];
  spending: SpendingSummary;
}

export interface WhyReport {
  run: RunSummary;
  ruleVersion: number;
  ruleSpec?: Pick<
    RuleSpec,
    | "name"
    | "to"
    | "cwd"
    | "skill"
    | "title"
    | "group"
    | "parallel"
    | "maxActive"
  >;
  events: Array<
    InboundEvent & {
      seq?: number;
      source: string;
      sourceName: string;
      receivedAt: string;
    }
  >;
  answers: Array<{
    card: number;
    key: string;
    title: string;
    choice: number | null;
    chosen: string;
    at: string;
  }>;
  timers: Array<{ key: string; about: string; at: string }>;
  receipt?: Receipt & {
    rejectedResolves?: Array<{ card: number; reason: string; error: string }>;
    rejectedEvents?: Array<{ type: string; error: string }>;
  };
  cardsCreated: CardView[];
  cardsResolved: number[];
  eventsEmitted: Array<InboundEvent & { source: string; hops: number }>;
  timeline: Array<{ at: string; kind: string; detail: string }>;
}
