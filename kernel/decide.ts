/**
 * Deterministic pure state machine kernel for event ingestion, rule routing,
 * multi-level concurrency claiming, run lifecycle transitions, atomic receipts,
 * card decisions, scheduled wakeups, and hop circuit breaking.
 *
 * Pure domain module: zero IO, zero ambient clocks, and zero external imports.
 */

import type {
  AgentProfile,
  CardView,
  InboundEvent,
  Job,
  RuleSpec,
  RulesConfig,
  RunResult,
  RunSummary,
  RunUsage,
  SkippedEventView,
} from "../protocol/types.ts";
import { parseRulesConfig } from "../protocol/rules-schema.ts";
import {
  ProtocolInputError,
  isValidIsoDateTimeWithOffset,
  parseInboundEvent,
  parseRunResult,
} from "../protocol/validate.ts";
import { latestBefore, nextRun, parseCron } from "./cron.ts";
import { RUN_LEASE_MS, deadlines } from "./due.ts";
import {
  AuthError,
  ConflictError,
  InputError,
  NotFoundError,
} from "./errors.ts";
import {
  iso,
  rows,
  type Change,
  type Fact,
  type Row,
  type Table,
  type View,
} from "./evolve.ts";
import {
  canClaimRun,
  cardViewOf,
  groupOf,
  jobOf,
  laneOf,
  openInScope,
  rulesOf,
  runSummaryOf,
  typeMatches,
} from "./query.ts";

export const MAX_HOPS = 8;
export const MAX_ATTEMPTS = 10;
const MAX_BACKOFF_MS = 30 * 60_000;
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

export interface DecideEnv {
  signToken(runId: number, attempt: number, claimId: string): string;
  safeTokenEquals?(a: string, b: string): boolean;
}

export type KernelInput =
  | { type: "configureRules"; config: unknown }
  | { type: "ingestEvent"; source: string; event: unknown }
  | {
      type: "claimWork";
      claimId: string;
      capacity?: number;
      running?: number[];
    }
  | {
      type: "markStarted";
      run: number;
      token: string;
      session?: string | null;
    }
  | {
      type: "submitResult";
      run: number;
      token: string;
      result: unknown;
    }
  | {
      type: "answerCard";
      card: number;
      choice?: number;
      text?: string;
    }
  | {
      type: "resolveCard";
      card: number;
      reason: string;
    }
  | { type: "stopRun"; run: number }
  | {
      type: "pauseRule";
      rule: string;
      reason?: string;
      until?: string | null;
    }
  | { type: "resumeRule"; rule: string }
  | {
      type: "replayRule";
      rule: string;
      since?: string | number;
    }
  | {
      type: "runRule";
      rule: string;
      subject?: string;
    }
  | { type: "tick" };

export interface DecideResult<T = any> {
  facts: Fact[];
  value: T;
}

interface DraftRecorder {
  draft: View;
  set(table: Table, key: string | number, row: Row | null): void;
  nextId(table: Table): number;
  syncDue(nowMs: number): void;
  flushFact(nowMs: number, factType: string): Fact[];
}

interface OriginContext {
  runId: number;
  rule: string;
  grp: string;
  agent: string;
  session: string | null;
}

interface IngestOutcome {
  duplicate: boolean;
  eventId: number | null;
  routed: string[];
  paused: string[];
  runs: number[];
  breakerCard: CardView | null;
}

function createRecorder(baseView: View): DraftRecorder {
  const draft = baseView.fork();
  const changeMap = new Map<string, Change>();
  const localIds: Partial<Record<Table, number>> = {};

  function set(table: Table, key: string | number, row: Row | null): void {
    const k = String(key);
    draft.set(table, k, row);
    changeMap.set(`${table}\0${k}`, { table, key: k, row });
  }

  function nextId(table: Table): number {
    const base = Math.max(draft.next[table] ?? 0, localIds[table] ?? 0);
    const id = base + 1;
    localIds[table] = id;
    return id;
  }

  function syncDue(nowMs: number): void {
    const desired = deadlines(draft, nowMs);
    const existingByKey = new Map<string, Row>();
    for (const row of draft.all("due")) {
      const k = `${String(row.kind)}:${String(row.target)}`;
      existingByKey.set(k, row);
    }

    for (const [key] of existingByKey) {
      if (!Object.prototype.hasOwnProperty.call(desired, key)) {
        set("due", key, null);
      }
    }

    for (const [key, nextRow] of Object.entries(desired)) {
      const prevRow = existingByKey.get(key);
      if (
        !prevRow ||
        prevRow.at !== nextRow.at ||
        prevRow.iso_at !== nextRow.iso_at ||
        prevRow.kind !== nextRow.kind ||
        prevRow.target !== nextRow.target
      ) {
        set("due", key, nextRow);
      }
    }
  }

  function flushFact(nowMs: number, factType: string): Fact[] {
    if (changeMap.size === 0) {
      return [];
    }
    return [
      {
        version: 1,
        seq: baseView.seq + 1,
        at: nowMs,
        type: factType,
        changes: Array.from(changeMap.values()),
      },
    ];
  }

  return { draft, set, nextId, syncDue, flushFact };
}

function wrapProtocol<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ProtocolInputError) {
      throw new InputError(err.message);
    }
    throw err;
  }
}

function assertPositiveInt(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new InputError(`${label} 必须是正安全整数`);
  }
  return value;
}

function assertNonEmptyText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InputError(`${label} 必须是非空字符串`);
  }
  return value;
}

function tokensEqual(
  env: DecideEnv,
  expected: string,
  provided: string,
): boolean {
  if (env.safeTokenEquals) {
    return env.safeTokenEquals(expected, provided);
  }
  const maxLen = Math.max(expected.length, provided.length);
  let diff = expected.length ^ provided.length;
  for (let i = 0; i < maxLen; i++) {
    const a = i < expected.length ? expected.charCodeAt(i) : 0;
    const b = i < provided.length ? provided.charCodeAt(i) : 0;
    diff |= a ^ b;
  }
  return diff === 0;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (
    typeof a !== "object" ||
    a === null ||
    typeof b !== "object" ||
    b === null
  ) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) {
        return false;
      }
    }
    return true;
  }
  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA).filter((k) => objA[k] !== undefined);
  const keysB = Object.keys(objB).filter((k) => objB[k] !== undefined);
  if (keysA.length !== keysB.length) {
    return false;
  }
  for (const key of keysA) {
    if (
      !Object.prototype.hasOwnProperty.call(objB, key) ||
      !deepEqual(objA[key], objB[key])
    ) {
      return false;
    }
  }
  return true;
}

function isPauseActive(pauseRow: Row | undefined, nowMs: number): boolean {
  if (!pauseRow) {
    return false;
  }
  if (pauseRow.until === null || pauseRow.until === undefined) {
    return true;
  }
  const untilMs = Date.parse(String(pauseRow.until));
  return Number.isFinite(untilMs) && untilMs > nowMs;
}

function ruleSourceOf(rule: RuleSpec | undefined): string | null {
  if (!rule) {
    return null;
  }
  return "source" in rule.when ? rule.when.source : null;
}

function ruleMatchesInbound(
  rule: RuleSpec,
  source: string,
  eventType: string,
): boolean {
  if ("source" in rule.when) {
    return (
      rule.when.source === source && typeMatches(rule.when.types, eventType)
    );
  }
  if ("watch" in rule.when) {
    return (
      source === "watch" &&
      typeMatches(rule.when.watch.types ?? ["*"], eventType)
    );
  }
  return false;
}

function skippedViewOf(row: Row): SkippedEventView {
  return {
    seq: Number(row.id ?? row.event_id),
    rule: String(row.rule),
    source: String(row.source),
    sourceName: String(row.source_name ?? row.source),
    eventId: String(row.event_key ?? row.event_id),
    type: String(row.type),
    ...(typeof row.subject === "string" && row.subject.length > 0
      ? { subject: row.subject }
      : {}),
    ...(typeof row.summary === "string" && row.summary.length > 0
      ? { summary: row.summary }
      : {}),
    ...(typeof row.link === "string" && row.link.length > 0
      ? { link: row.link }
      : {}),
    receivedAt: String(row.received_at),
    replayedAt: typeof row.replayed_at === "string" ? row.replayed_at : null,
  };
}

function addRunUsage(
  prev: RunUsage | null | undefined,
  next: RunUsage | null | undefined,
): RunUsage | null {
  if (!prev && !next) {
    return null;
  }
  if (!prev) {
    return { ...next };
  }
  if (!next) {
    return { ...prev };
  }
  const merged: RunUsage = {};
  for (const field of ["input", "output", "cached", "cost"] as const) {
    const a = prev[field];
    const b = next[field];
    if (a !== undefined || b !== undefined) {
      merged[field] = (a ?? 0) + (b ?? 0);
    }
  }
  return merged;
}

function findQueuedRun(
  view: View,
  ruleName: string,
  lane: string,
): Row | undefined {
  const candidates = rows(view, "runs", {
    rule: ruleName,
    lane,
    status: "queued",
  });
  return candidates.find((r) => r.cancel_at == null);
}

function enqueueOrMergeRun(
  rec: DraftRecorder,
  ruleSpec: RuleSpec,
  rulesVersion: number,
  lane: string,
  eventId: number,
  nowMs: number,
  options?: {
    manual?: boolean;
    timelineDetail?: string;
    resumeSession?: string | null;
    resumeAgent?: string | null;
    resumeModel?: string | null;
    resumeRunner?: string | null;
  },
): { runId: number; merged: boolean } {
  const existing = findQueuedRun(rec.draft, ruleSpec.name, lane);
  const nowIso = iso(nowMs);

  if (existing) {
    rec.set("run_events", `${existing.id}:${eventId}`, {
      run_id: existing.id,
      event_id: eventId,
    });
    let changed = false;
    let updated = existing;
    if (
      options?.resumeSession &&
      (existing.resume === null || existing.resume === undefined)
    ) {
      updated = {
        ...updated,
        resume: options.resumeSession,
        resume_agent: options.resumeAgent ?? null,
        resume_model: options.resumeModel ?? null,
        resume_runner: options.resumeRunner ?? null,
      };
      changed = true;
    }
    if (options?.manual && !existing.manual) {
      updated = { ...updated, manual: true };
      changed = true;
    }
    if (changed) {
      rec.set("runs", String(existing.id), updated);
    }
    return { runId: existing.id as number, merged: true };
  }

  const runId = rec.nextId("runs");
  const isManual = options?.manual === true;
  const detail =
    options?.timelineDetail ?? (isManual ? "manual run queued" : "run queued");

  const runRow: Row = {
    id: runId,
    rule: ruleSpec.name,
    rules_version: rulesVersion,
    agent: ruleSpec.to,
    grp: groupOf(ruleSpec),
    lane,
    status: "queued",
    attempts: 0,
    claim: null,
    token: null,
    last_result: null,
    last_response: null,
    cancel_at: null,
    resume: options?.resumeSession ?? null,
    resume_agent: options?.resumeAgent ?? null,
    resume_model: options?.resumeModel ?? null,
    resume_runner: options?.resumeRunner ?? null,
    session: null,
    summary: null,
    error: null,
    usage: null,
    manual: isManual,
    created_at: nowIso,
    not_before: nowIso,
    claimed_at: null,
    started_at: null,
    heartbeat_at: null,
    ended_at: null,
    timeline: [{ at: nowIso, kind: "queued", detail }],
  };

  rec.set("runs", String(runId), runRow);
  rec.set("run_events", `${runId}:${eventId}`, {
    run_id: runId,
    event_id: eventId,
  });
  return { runId, merged: false };
}

function ingestEventInternal(
  rec: DraftRecorder,
  source: string,
  ev: InboundEvent,
  nowMs: number,
  origin?: OriginContext,
): IngestOutcome {
  const seenKey = `event:${source}:${ev.id}`;
  const existingSeen = rec.draft.get("seen", seenKey);
  if (existingSeen) {
    return {
      duplicate: true,
      eventId:
        typeof existingSeen.event_id === "number"
          ? existingSeen.event_id
          : null,
      routed: [],
      paused: [],
      runs: [],
      breakerCard: null,
    };
  }

  const nowIso = iso(nowMs);
  const eventId = rec.nextId("events");
  const hops = ev.hops ?? 0;
  const routed: string[] = [];
  const paused: string[] = [];
  const runIds: number[] = [];

  const eventRow: Row = {
    id: eventId,
    source,
    key: ev.id,
    type: ev.type,
    subject: ev.subject ?? "",
    summary: ev.summary ?? "",
    detail: ev.detail ?? "",
    link: ev.link ?? "",
    hops,
    routed,
    paused,
    received_at: nowIso,
  };

  rec.set("seen", seenKey, {
    kind: "event",
    name: `${source}:${ev.id}`,
    event_id: eventId,
    seen_at: nowIso,
  });
  rec.set("seen", `source:${source}`, {
    kind: "source",
    name: source,
    seen_at: nowIso,
  });

  if (hops > MAX_HOPS) {
    rec.set("events", String(eventId), eventRow);
    const cardId = rec.nextId("cards");
    const breakerRow: Row = {
      id: cardId,
      key: `hops-breaker:${eventId}`,
      kind: "notice",
      status: "open",
      rule: "_system",
      lane: ev.subject ?? "",
      grp: "_system",
      source,
      agent: origin?.agent ?? null,
      session: origin?.session ?? null,
      run_id: origin?.runId ?? null,
      title: `跳数熔断告警：事件 ${ev.type} 已达 ${hops} 跳`,
      text: `事件 ${source}:${ev.id}（type=${ev.type}${ev.subject ? `, subject=${ev.subject}` : ""}）传递跳数 hops=${hops} 超过上限 ${MAX_HOPS}，已阻断继续派发新轮次。`,
      options: [],
      about: `hops=${hops} > ${MAX_HOPS}`,
      fyi: false,
      choice: null,
      chosen: null,
      answer_text: null,
      resolved_reason: null,
      answer_event: null,
      version: 1,
      created_at: nowIso,
      decided_at: null,
      closed_at: null,
    };
    rec.set("cards", String(cardId), breakerRow);
    return {
      duplicate: false,
      eventId,
      routed: [],
      paused: [],
      runs: [],
      breakerCard: cardViewOf(breakerRow),
    };
  }

  const rulesEntry = rulesOf(rec.draft);
  if (rulesEntry) {
    const sourceName = rulesEntry.config.sources[source]?.name ?? source;
    for (const ruleSpec of rulesEntry.config.rules) {
      if (!ruleMatchesInbound(ruleSpec, source, ev.type)) {
        continue;
      }
      if (isPauseActive(rec.draft.get("pauses", ruleSpec.name), nowMs)) {
        paused.push(ruleSpec.name);
        const skippedId = rec.nextId("skipped");
        rec.set("skipped", `${ruleSpec.name}:${eventId}`, {
          id: skippedId,
          rule: ruleSpec.name,
          event_id: eventId,
          source,
          source_name: sourceName,
          event_key: ev.id,
          type: ev.type,
          subject: ev.subject ?? "",
          summary: ev.summary ?? "",
          link: ev.link ?? "",
          received_at: nowIso,
          replayed_at: null,
          replay_run_id: null,
        });
        continue;
      }

      routed.push(ruleSpec.name);
      const lane = laneOf(ruleSpec, ev.subject);
      const { runId } = enqueueOrMergeRun(
        rec,
        ruleSpec,
        rulesEntry.version,
        lane,
        eventId,
        nowMs,
        { timelineDetail: `event ${source}:${ev.id}` },
      );
      runIds.push(runId);
    }
  }

  rec.set("events", String(eventId), eventRow);
  return {
    duplicate: false,
    eventId,
    routed,
    paused,
    runs: runIds,
    breakerCard: null,
  };
}

/**
 * Resolve a safe session ID for a run being claimed.
 * Excludes sessions occupied by any active (`claimed` / `unknown`) run,
 * sessions associated with any `cancelled` run, and sessions created under a
 * different agent profile, model, or runner.
 */
function settleSession(
  view: View,
  runRow: Row,
  ruleSpec: RuleSpec,
  agentProfile: AgentProfile,
): string | null {
  const targetAgent = ruleSpec.to;
  const targetModel = agentProfile.model ?? null;
  const targetRunner = agentProfile.runner;

  const busySessions = new Set<string>();
  const cancelledSessions = new Set<string>();

  for (const r of view.all("runs")) {
    if (typeof r.session !== "string" || r.session.length === 0) {
      continue;
    }
    if (
      r.id !== runRow.id &&
      (r.status === "claimed" || r.status === "unknown")
    ) {
      busySessions.add(r.session);
    }
    if (r.status === "cancelled" || r.cancel_at != null) {
      cancelledSessions.add(r.session);
    }
  }

  function isCompatible(
    candidate: unknown,
    originAgent?: unknown,
    originModel?: unknown,
    originRunner?: unknown,
  ): candidate is string {
    if (typeof candidate !== "string" || candidate.length === 0) {
      return false;
    }
    if (busySessions.has(candidate) || cancelledSessions.has(candidate)) {
      return false;
    }
    if (
      typeof originAgent === "string" &&
      originAgent.length > 0 &&
      originAgent !== targetAgent
    ) {
      return false;
    }
    if (originModel !== undefined && originModel !== targetModel) {
      return false;
    }
    if (
      typeof originRunner === "string" &&
      originRunner.length > 0 &&
      originRunner !== targetRunner
    ) {
      return false;
    }
    return true;
  }

  const attempts = typeof runRow.attempts === "number" ? runRow.attempts : 0;
  if (attempts > 0) {
    // Retries preserve `runRow.session` only when a prior attempt had started.
    // However, if a newer wakeup event (answerCard / timer) merged a fresh `resume`
    // session into this queued run while waiting for retry, honor it safely here
    // without falling back to `ruleSpec.resume`.
    if (typeof runRow.session === "string" && runRow.session.length > 0) {
      return isCompatible(
        runRow.session,
        runRow.agent,
        runRow.model,
        runRow.runner,
      )
        ? runRow.session
        : null;
    }
    if (typeof runRow.resume === "string" && runRow.resume.length > 0) {
      return isCompatible(
        runRow.resume,
        runRow.resume_agent,
        runRow.resume_model,
        runRow.resume_runner,
      )
        ? runRow.resume
        : null;
    }
    return null;
  }

  if (typeof runRow.session === "string" && runRow.session.length > 0) {
    return isCompatible(
      runRow.session,
      runRow.agent,
      runRow.model,
      runRow.runner,
    )
      ? runRow.session
      : null;
  }

  if (typeof runRow.resume === "string" && runRow.resume.length > 0) {
    return isCompatible(
      runRow.resume,
      runRow.resume_agent,
      runRow.resume_model,
      runRow.resume_runner,
    )
      ? runRow.resume
      : null;
  }

  if (ruleSpec.resume === true) {
    const lane = typeof runRow.lane === "string" ? runRow.lane : "";
    const laneRuns = rows(
      view,
      "runs",
      { rule: ruleSpec.name, lane },
      undefined,
      true,
    );
    const terminalSet = new Set(["done", "nothing", "failed", "cancelled"]);
    for (const prev of laneRuns) {
      if (prev.id === runRow.id || !terminalSet.has(String(prev.status))) {
        continue;
      }
      if (prev.status === "cancelled" || prev.cancel_at != null) {
        return null;
      }
      if (prev.status === "done" || prev.status === "nothing") {
        return isCompatible(prev.session, prev.agent, prev.model, prev.runner)
          ? prev.session
          : null;
      }
    }
  }

  return null;
}

function handleConfigureRules(
  rec: DraftRecorder,
  rawConfig: unknown,
  nowMs: number,
): DecideResult {
  const config = wrapProtocol(() => parseRulesConfig(rawConfig));
  const fallbackTz = config.timezone ?? "UTC";
  const cronNextByRule = new Map<
    string,
    { timezone: string; nextAt: string }
  >();

  for (const rule of config.rules) {
    if ("cron" in rule.when) {
      const parsed = parseCron(rule.when.cron, fallbackTz);
      const nextMs = nextRun(rule.when.cron, fallbackTz, nowMs);
      cronNextByRule.set(rule.name, {
        timezone: parsed.timeZone,
        nextAt: iso(nextMs),
      });
    }
  }

  const prev = rulesOf(rec.draft);
  const version = (prev?.version ?? 0) + 1;
  const nowIso = iso(nowMs);

  rec.set("config", "rules", {
    id: "rules",
    version,
    value: config,
    updated_at: nowIso,
  });

  const newCronNames = new Set<string>();
  for (const rule of config.rules) {
    if (!("cron" in rule.when)) {
      continue;
    }
    newCronNames.add(rule.name);
    const info = cronNextByRule.get(rule.name)!;
    const existingSched = rec.draft.get("schedules", rule.name);
    const sameCron =
      existingSched &&
      existingSched.cron === rule.when.cron &&
      existingSched.timezone === info.timezone &&
      typeof existingSched.next_at === "string";

    rec.set("schedules", rule.name, {
      rule: rule.name,
      cron: rule.when.cron,
      timezone: info.timezone,
      next_at: sameCron ? existingSched.next_at : info.nextAt,
      last_run_at: existingSched?.last_run_at ?? null,
      skipped_at: sameCron ? (existingSched?.skipped_at ?? null) : null,
    });
  }

  for (const sched of rec.draft.all("schedules")) {
    const ruleName = String(sched.rule);
    if (!newCronNames.has(ruleName)) {
      rec.set("schedules", ruleName, null);
    }
  }

  const newRuleNames = new Set(config.rules.map((r) => r.name));
  const removedRules: string[] = [];
  const cancelledRuns: number[] = [];

  if (prev) {
    for (const prevRule of prev.config.rules) {
      if (newRuleNames.has(prevRule.name)) {
        continue;
      }
      removedRules.push(prevRule.name);
      const queued = rows(rec.draft, "runs", {
        rule: prevRule.name,
        status: "queued",
      });
      let cancelledForRule = 0;
      for (const run of queued) {
        rec.set("runs", String(run.id), {
          ...run,
          status: "cancelled",
          cancel_at: run.cancel_at ?? nowIso,
          ended_at: nowIso,
          error: "rule removed from config",
          timeline: [
            ...(Array.isArray(run.timeline) ? run.timeline : []),
            {
              at: nowIso,
              kind: "cancelled",
              detail: "rule removed from config",
            },
          ],
        });
        cancelledRuns.push(run.id as number);
        cancelledForRule += 1;
      }

      const cardId = rec.nextId("cards");
      rec.set("cards", String(cardId), {
        id: cardId,
        key: `rule-removed:${prevRule.name}:v${version}`,
        kind: "notice",
        status: "open",
        rule: prevRule.name,
        lane: "",
        grp: groupOf(prevRule),
        source: ruleSourceOf(prevRule),
        agent: prevRule.to,
        session: null,
        run_id: null,
        title: `规则已移除：${prevRule.name}`,
        text:
          cancelledForRule > 0
            ? `规则 ${prevRule.name} 已从配置中移除，系统已自动取消其 ${cancelledForRule} 个未领取排队轮次。`
            : `规则 ${prevRule.name} 已从配置中移除。`,
        options: [],
        about: `config version ${version}`,
        fyi: false,
        choice: null,
        chosen: null,
        answer_text: null,
        resolved_reason: null,
        answer_event: null,
        version: 1,
        created_at: nowIso,
        decided_at: null,
        closed_at: null,
      });
    }
  }

  rec.syncDue(nowMs);
  return {
    facts: rec.flushFact(nowMs, "rules.configured"),
    value: {
      version,
      rulesCount: config.rules.length,
      removedRules,
      cancelledRuns,
    },
  };
}

function handleIngestEvent(
  rec: DraftRecorder,
  source: unknown,
  rawEvent: unknown,
  nowMs: number,
): DecideResult<IngestOutcome> {
  if (
    typeof source !== "string" ||
    source.trim().length === 0 ||
    /\s/.test(source) ||
    CONTROL_CHAR_RE.test(source)
  ) {
    throw new InputError(
      "ingestEvent.source 必须是不含空白和控制字符的非空字符串",
    );
  }
  const ev = wrapProtocol(() => parseInboundEvent(rawEvent, "event"));
  const outcome = ingestEventInternal(rec, source, ev, nowMs);
  if (outcome.duplicate) {
    return { facts: [], value: outcome };
  }
  rec.syncDue(nowMs);
  return {
    facts: rec.flushFact(
      nowMs,
      outcome.breakerCard ? "event.breaker_tripped" : "event.ingested",
    ),
    value: outcome,
  };
}

function handleClaimWork(
  rec: DraftRecorder,
  input: Extract<KernelInput, { type: "claimWork" }>,
  nowMs: number,
  env: DecideEnv,
): DecideResult<{ jobs: Job[]; cancel: number[] }> {
  const claimId = assertNonEmptyText(input.claimId, "claimWork.claimId");
  const capacity = input.capacity === undefined ? 2 : input.capacity;
  if (
    typeof capacity !== "number" ||
    !Number.isSafeInteger(capacity) ||
    capacity < 0
  ) {
    throw new InputError("claimWork.capacity 必须是非负安全整数");
  }

  const runningIds = input.running ?? [];
  if (!Array.isArray(runningIds)) {
    throw new InputError("claimWork.running 必须是数组");
  }

  const nowIso = iso(nowMs);
  const cancelSet = new Set<number>();

  for (const rawId of runningIds) {
    const runId = assertPositiveInt(rawId, "claimWork.running[]");
    const runRow = rec.draft.get("runs", String(runId));
    if (!runRow) {
      continue;
    }
    if (runRow.cancel_at != null || runRow.status === "cancelled") {
      cancelSet.add(runId);
    }
    if (runRow.status === "claimed" || runRow.status === "unknown") {
      if (runRow.heartbeat_at !== nowIso) {
        rec.set("runs", String(runId), {
          ...runRow,
          heartbeat_at: nowIso,
        });
      }
    }
  }

  // Idempotent replay for an already-processed claimId
  const alreadyClaimed = rows(rec.draft, "runs", {
    status: "claimed",
    claim: claimId,
  });
  if (alreadyClaimed.length > 0) {
    const jobs = alreadyClaimed.map((r) => {
      const token =
        typeof r.token === "string" && r.token.length > 0
          ? r.token
          : env.signToken(r.id as number, r.attempts as number, claimId);
      return jobOf(rec.draft, r.id as number, token);
    });
    rec.syncDue(nowMs);
    return {
      facts: rec.flushFact(nowMs, "work.heartbeat"),
      value: { jobs, cancel: Array.from(cancelSet) },
    };
  }

  const jobs: Job[] = [];
  const rulesEntry = rulesOf(rec.draft);

  if (rulesEntry && capacity > 0) {
    const queuedRuns = rows(rec.draft, "runs", { status: "queued" });
    for (const runRow of queuedRuns) {
      if (runRow.cancel_at != null) {
        continue;
      }
      if (!canClaimRun(rec.draft, runRow, nowMs, capacity)) {
        continue;
      }
      const ruleSpec = rulesEntry.config.rules.find(
        (r) => r.name === runRow.rule,
      );
      if (!ruleSpec) {
        continue;
      }
      const agentProfile = rulesEntry.config.agents[ruleSpec.to];
      if (!agentProfile) {
        continue;
      }

      const runId = runRow.id as number;
      const attempts = ((runRow.attempts as number) ?? 0) + 1;
      const session = settleSession(rec.draft, runRow, ruleSpec, agentProfile);
      const token = env.signToken(runId, attempts, claimId);

      const claimedRow: Row = {
        ...runRow,
        rules_version: rulesEntry.version,
        agent: ruleSpec.to,
        grp: groupOf(ruleSpec),
        model: agentProfile.model ?? null,
        runner: agentProfile.runner,
        status: "claimed",
        attempts,
        claim: claimId,
        token,
        session,
        claimed_at: nowIso,
        heartbeat_at: nowIso,
        timeline: [
          ...(Array.isArray(runRow.timeline) ? runRow.timeline : []),
          { at: nowIso, kind: "claimed", detail: `attempt #${attempts}` },
        ],
      };
      rec.set("runs", String(runId), claimedRow);
      jobs.push(jobOf(rec.draft, runId, token));
    }
  }

  rec.syncDue(nowMs);
  return {
    facts: rec.flushFact(
      nowMs,
      jobs.length > 0 ? "work.claimed" : "work.heartbeat",
    ),
    value: { jobs, cancel: Array.from(cancelSet) },
  };
}

function handleMarkStarted(
  rec: DraftRecorder,
  input: Extract<KernelInput, { type: "markStarted" }>,
  nowMs: number,
  env: DecideEnv,
): DecideResult<{ run: number; startedAt: string; session: string | null }> {
  const runId = assertPositiveInt(input.run, "markStarted.run");
  const runRow = rec.draft.get("runs", String(runId));
  if (!runRow) {
    throw new NotFoundError(`未找到轮次 ${runId}`);
  }
  if (
    typeof input.token !== "string" ||
    input.token.length === 0 ||
    typeof runRow.token !== "string" ||
    !tokensEqual(env, runRow.token, input.token)
  ) {
    throw new AuthError(`轮次 ${runId} 令牌无效`);
  }

  const nextSession =
    typeof input.session === "string" && input.session.trim().length > 0
      ? input.session.trim()
      : ((runRow.session as string | null) ?? null);

  if (runRow.status !== "claimed" && runRow.status !== "unknown") {
    if (runRow.started_at != null && nextSession === (runRow.session ?? null)) {
      return {
        facts: [],
        value: {
          run: runId,
          startedAt: String(runRow.started_at),
          session: nextSession,
        },
      };
    }
    throw new ConflictError(
      `轮次 ${runId} 状态为 ${String(runRow.status)}，无法标记启动`,
    );
  }

  const nowIso = iso(nowMs);
  const startedAt =
    typeof runRow.started_at === "string" ? runRow.started_at : nowIso;
  const isFirstStart = runRow.started_at == null;
  const sameHeartbeat = runRow.heartbeat_at === nowIso;
  const sameSession = nextSession === (runRow.session ?? null);

  if (!isFirstStart && sameHeartbeat && sameSession) {
    return {
      facts: [],
      value: { run: runId, startedAt, session: nextSession },
    };
  }

  const updatedRow: Row = {
    ...runRow,
    started_at: startedAt,
    heartbeat_at: nowIso,
    session: nextSession,
    timeline: isFirstStart
      ? [
          ...(Array.isArray(runRow.timeline) ? runRow.timeline : []),
          {
            at: startedAt,
            kind: "started",
            detail: nextSession ? `session ${nextSession}` : "started",
          },
        ]
      : runRow.timeline,
  };

  rec.set("runs", String(runId), updatedRow);
  rec.syncDue(nowMs);
  return {
    facts: rec.flushFact(nowMs, "run.started"),
    value: { run: runId, startedAt, session: nextSession },
  };
}

function linkedEventRowsForRun(view: View, runId: number): Row[] {
  const links = rows(view, "run_events", { run_id: runId });
  const out: Row[] = [];
  for (const link of links) {
    const ev = view.get("events", String(link.event_id));
    if (ev) {
      out.push(ev);
    }
  }
  return out;
}

function handleSubmitResult(
  rec: DraftRecorder,
  input: Extract<KernelInput, { type: "submitResult" }>,
  nowMs: number,
  env: DecideEnv,
): DecideResult {
  const runId = assertPositiveInt(input.run, "submitResult.run");
  const runRow = rec.draft.get("runs", String(runId));
  if (!runRow) {
    throw new NotFoundError(`未找到轮次 ${runId}`);
  }
  if (
    typeof input.token !== "string" ||
    input.token.length === 0 ||
    typeof runRow.token !== "string" ||
    !tokensEqual(env, runRow.token, input.token)
  ) {
    throw new AuthError(`轮次 ${runId} 令牌无效`);
  }

  const result = wrapProtocol(() => parseRunResult(input.result));
  const terminalStatuses = new Set(["done", "nothing", "failed", "cancelled"]);

  if (terminalStatuses.has(String(runRow.status))) {
    if (runRow.last_result != null && deepEqual(runRow.last_result, result)) {
      return { facts: [], value: runRow.last_response };
    }
    throw new ConflictError(
      `轮次 ${runId} 已处于终态 ${String(runRow.status)}，提交结果冲突`,
    );
  }

  if (runRow.status !== "claimed" && runRow.status !== "unknown") {
    throw new ConflictError(
      `轮次 ${runId} 状态为 ${String(runRow.status)}，不可提交结果`,
    );
  }

  const nowIso = iso(nowMs);
  const attempts = (runRow.attempts as number) ?? 1;
  const finalSession =
    result.session ??
    (typeof runRow.session === "string" && runRow.session.length > 0
      ? runRow.session
      : null);
  const mergedUsage = addRunUsage(
    runRow.usage as RunUsage | null,
    result.usage,
  );

  // 1. Cancelled (by stopRun cancel_at or explicit outcome === "cancelled")
  if (runRow.cancel_at != null || result.outcome === "cancelled") {
    const response = {
      run: runId,
      status: "cancelled",
      attempt: attempts,
      requeued: false,
      cardsCreated: [],
      cardsResolved: [],
      rejectedResolves: [],
      timersUpdated: [],
      eventsEmitted: [],
      rejectedEvents: [],
      breakerCards: [],
    };
    rec.set("runs", String(runId), {
      ...runRow,
      status: "cancelled",
      cancel_at: runRow.cancel_at ?? nowIso,
      ended_at: nowIso,
      heartbeat_at: nowIso,
      session: finalSession,
      summary: result.summary ?? runRow.summary ?? null,
      error: result.error ?? runRow.error ?? null,
      usage: mergedUsage,
      last_result: result,
      last_response: response,
      timeline: [
        ...(Array.isArray(runRow.timeline) ? runRow.timeline : []),
        {
          at: nowIso,
          kind: "cancelled",
          detail: result.error ?? result.summary ?? "cancelled",
        },
      ],
    });
    rec.syncDue(nowMs);
    return {
      facts: rec.flushFact(nowMs, "run.cancelled"),
      value: response,
    };
  }

  const rulesEntry = rulesOf(rec.draft);
  const ruleSpec = rulesEntry?.config.rules.find((r) => r.name === runRow.rule);
  const ruleSource = ruleSourceOf(ruleSpec);

  // 2. Failed outcome (backoff retry if attempts < MAX_ATTEMPTS, else terminal failed + alert)
  if (result.outcome === "failed") {
    if (attempts < MAX_ATTEMPTS) {
      const delayMs = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempts);
      const notBeforeIso = iso(nowMs + delayMs);
      const hadStarted = runRow.started_at != null;
      let retrySession = hadStarted ? finalSession : null;
      let retryResume = hadStarted ? (runRow.resume ?? null) : null;
      let retryResumeAgent = hadStarted ? (runRow.resume_agent ?? null) : null;
      let retryResumeModel = hadStarted ? (runRow.resume_model ?? null) : null;
      let retryResumeRunner = hadStarted
        ? (runRow.resume_runner ?? null)
        : null;
      let retryManual = Boolean(runRow.manual);

      // Merge any other queued runs on the same (rule, lane) into this retrying run
      const otherQueued = rows(rec.draft, "runs", {
        rule: runRow.rule,
        lane: runRow.lane,
        status: "queued",
      }).filter((other) => other.id !== runId && other.cancel_at == null);

      for (const other of otherQueued) {
        if (other.manual) {
          retryManual = true;
        }
        if (
          !hadStarted &&
          !retrySession &&
          !retryResume &&
          typeof other.resume === "string" &&
          other.resume.length > 0 &&
          other.resume !== runRow.resume
        ) {
          retryResume = other.resume;
          retryResumeAgent = other.resume_agent ?? null;
          retryResumeModel = other.resume_model ?? null;
          retryResumeRunner = other.resume_runner ?? null;
        }
        const otherLinks = rows(rec.draft, "run_events", { run_id: other.id });
        for (const link of otherLinks) {
          rec.set("run_events", `${other.id}:${link.event_id}`, null);
          rec.set("run_events", `${runId}:${link.event_id}`, {
            run_id: runId,
            event_id: link.event_id,
          });
        }
        rec.set("runs", String(other.id), null);
      }

      const response = {
        run: runId,
        status: "queued",
        attempt: attempts,
        requeued: true,
        notBefore: notBeforeIso,
        cardsCreated: [],
        cardsResolved: [],
        rejectedResolves: [],
        timersUpdated: [],
        eventsEmitted: [],
        rejectedEvents: [],
        breakerCards: [],
      };

      rec.set("runs", String(runId), {
        ...runRow,
        status: "queued",
        token: null,
        claim: null,
        claimed_at: null,
        started_at: null,
        heartbeat_at: null,
        not_before: notBeforeIso,
        session: retrySession,
        resume: retryResume,
        resume_agent: retryResumeAgent,
        resume_model: retryResumeModel,
        resume_runner: retryResumeRunner,
        manual: retryManual,
        summary: result.summary ?? runRow.summary ?? null,
        error: result.error ?? result.summary ?? "run failed",
        usage: mergedUsage,
        last_result: result,
        last_response: response,
        timeline: [
          ...(Array.isArray(runRow.timeline) ? runRow.timeline : []),
          {
            at: nowIso,
            kind: "retry_queued",
            detail: `attempt #${attempts} failed, retry at ${notBeforeIso}`,
          },
        ],
      });

      rec.syncDue(nowMs);
      return {
        facts: rec.flushFact(nowMs, "run.requeued"),
        value: response,
      };
    }

    // Exhausted MAX_ATTEMPTS -> terminal failed + open notice alert card
    const alertId = rec.nextId("cards");
    const alertCardRow: Row = {
      id: alertId,
      key: `run-failed:${runId}`,
      kind: "notice",
      status: "open",
      rule: String(runRow.rule),
      lane: String(runRow.lane ?? ""),
      grp: String(runRow.grp),
      source: ruleSource,
      agent: String(runRow.agent),
      model: runRow.model ?? null,
      session: finalSession,
      run_id: runId,
      title: `轮次连续失败告警：${String(runRow.rule)} (#${runId})`,
      text: `规则 ${String(runRow.rule)}${runRow.lane ? ` (${String(runRow.lane)})` : ""} 的轮次 #${runId} 已连续失败 ${attempts} 次（达到上限 ${MAX_ATTEMPTS}）：${result.error ?? result.summary ?? "未知错误"}`,
      options: [],
      about: `attempts=${attempts}/${MAX_ATTEMPTS}`,
      fyi: false,
      choice: null,
      chosen: null,
      answer_text: null,
      resolved_reason: null,
      answer_event: null,
      version: 1,
      created_at: nowIso,
      decided_at: null,
      closed_at: null,
    };
    rec.set("cards", String(alertId), alertCardRow);

    const alertView = cardViewOf(alertCardRow);
    const response = {
      run: runId,
      status: "failed",
      attempt: attempts,
      requeued: false,
      cardsCreated: [alertView],
      cardsResolved: [],
      rejectedResolves: [],
      timersUpdated: [],
      eventsEmitted: [],
      rejectedEvents: [],
      breakerCards: [],
    };

    rec.set("runs", String(runId), {
      ...runRow,
      status: "failed",
      ended_at: nowIso,
      heartbeat_at: nowIso,
      session: finalSession,
      summary: result.summary ?? runRow.summary ?? null,
      error: result.error ?? result.summary ?? "max attempts exceeded",
      usage: mergedUsage,
      last_result: result,
      last_response: response,
      timeline: [
        ...(Array.isArray(runRow.timeline) ? runRow.timeline : []),
        {
          at: nowIso,
          kind: "failed",
          detail: result.error ?? result.summary ?? "max attempts exceeded",
        },
      ],
    });

    rec.syncDue(nowMs);
    return {
      facts: rec.flushFact(nowMs, "run.failed"),
      value: response,
    };
  }

  // 3. Success outcomes: "done" | "nothing"
  const inputEvents = linkedEventRowsForRun(rec.draft, runId);
  const inputEventIds = new Set(inputEvents.map((ev) => ev.id as number));
  const maxInputHops = inputEvents.reduce(
    (max, ev) => Math.max(max, typeof ev.hops === "number" ? ev.hops : 0),
    0,
  );

  // Snapshot resolve scope BEFORE creating any new cards in this receipt
  const resolvableIds = new Set(
    openInScope(
      rec.draft,
      String(runRow.grp),
      ruleSource,
      typeof runRow.claimed_at === "string" ? runRow.claimed_at : undefined,
    ).map((c) => c.id as number),
  );

  // Advance decided ask cards answered for this run's triggering events -> done
  const decidedCards = rows(rec.draft, "cards", {
    status: "decided",
    rule: runRow.rule,
    lane: runRow.lane,
  });
  for (const card of decidedCards) {
    if (
      typeof card.answer_event === "number" &&
      inputEventIds.has(card.answer_event)
    ) {
      rec.set("cards", String(card.id), {
        ...card,
        status: "done",
        closed_at: nowIso,
        version: ((card.version as number) ?? 1) + 1,
      });
    }
  }

  const cardsCreated: CardView[] = [];
  const cardsResolved: number[] = [];
  const rejectedResolves: Array<{
    card: number;
    reason: string;
    error: string;
  }> = [];
  const timersUpdated: Array<{ key: string; action: string; at?: string }> = [];
  const eventsEmitted: Array<InboundEvent & { source: string; hops: number }> =
    [];
  const rejectedEvents: Array<{ type: string; error: string }> = [];
  const breakerCards: CardView[] = [];

  // 3a. Receipt: ask
  for (const askItem of result.ask ?? []) {
    const existingOpen = rows(rec.draft, "cards", {
      kind: "ask",
      status: "open",
      rule: runRow.rule,
      lane: runRow.lane,
      key: askItem.key,
    });
    if (existingOpen.length > 0) {
      continue;
    }

    const cardId = rec.nextId("cards");
    const cardRow: Row = {
      id: cardId,
      key: askItem.key,
      kind: "ask",
      status: "open",
      rule: String(runRow.rule),
      lane: String(runRow.lane ?? ""),
      grp: String(runRow.grp),
      source: ruleSource,
      agent: String(runRow.agent),
      model: runRow.model ?? null,
      runner: runRow.runner ?? null,
      session: finalSession,
      run_id: runId,
      hops: maxInputHops,
      title: askItem.title,
      text: askItem.text,
      options: [...askItem.options],
      ...(askItem.recommend !== undefined
        ? { recommend: askItem.recommend }
        : {}),
      about: askItem.about,
      fyi: false,
      choice: null,
      chosen: null,
      answer_text: null,
      resolved_reason: null,
      answer_event: null,
      version: 1,
      created_at: nowIso,
      decided_at: null,
      closed_at: null,
    };
    rec.set("cards", String(cardId), cardRow);
    cardsCreated.push(cardViewOf(cardRow));
  }

  // 3b. Receipt: notice
  for (const noticeItem of result.notice ?? []) {
    const isFyi = noticeItem.fyi === true;
    if (!isFyi && noticeItem.key !== undefined) {
      const existingOpen = rows(rec.draft, "cards", {
        kind: "notice",
        status: "open",
        rule: runRow.rule,
        lane: runRow.lane,
        key: noticeItem.key,
      });
      if (existingOpen.length > 0) {
        continue;
      }
    }

    const cardId = rec.nextId("cards");
    const cardRow: Row = {
      id: cardId,
      key: noticeItem.key ?? `notice:${runId}:${cardId}`,
      kind: "notice",
      status: isFyi ? "closed" : "open",
      rule: String(runRow.rule),
      lane: String(runRow.lane ?? ""),
      grp: String(runRow.grp),
      source: ruleSource,
      agent: String(runRow.agent),
      model: runRow.model ?? null,
      runner: runRow.runner ?? null,
      session: finalSession,
      run_id: runId,
      title: noticeItem.title,
      text: noticeItem.text,
      options: [],
      about: "",
      fyi: isFyi,
      choice: null,
      chosen: null,
      answer_text: null,
      resolved_reason: null,
      answer_event: null,
      version: 1,
      created_at: nowIso,
      decided_at: null,
      closed_at: isFyi ? nowIso : null,
    };
    rec.set("cards", String(cardId), cardRow);
    cardsCreated.push(cardViewOf(cardRow));
  }

  // 3c. Receipt: resolve
  for (const resItem of result.resolve ?? []) {
    const cardRow = rec.draft.get("cards", String(resItem.card));
    if (!cardRow) {
      rejectedResolves.push({
        card: resItem.card,
        reason: resItem.reason,
        error: "NOT_FOUND",
      });
      continue;
    }
    if (cardRow.status !== "open") {
      rejectedResolves.push({
        card: resItem.card,
        reason: resItem.reason,
        error: "NOT_OPEN",
      });
      continue;
    }
    if (!resolvableIds.has(resItem.card)) {
      rejectedResolves.push({
        card: resItem.card,
        reason: resItem.reason,
        error: "NOT_IN_SCOPE",
      });
      continue;
    }

    rec.set("cards", String(resItem.card), {
      ...cardRow,
      status: "closed",
      resolved_reason: resItem.reason,
      closed_at: nowIso,
      version: ((cardRow.version as number) ?? 1) + 1,
    });
    cardsResolved.push(resItem.card);
  }

  // 3d. Receipt: later
  for (const laterItem of result.later ?? []) {
    const existingTimers = rows(rec.draft, "timers", {
      rule: runRow.rule,
      lane: runRow.lane,
      key: laterItem.key,
      event_id: null,
    });

    if ("cancel" in laterItem && laterItem.cancel === true) {
      for (const t of existingTimers) {
        rec.set("timers", String(t.id), null);
      }
      if (existingTimers.length > 0) {
        timersUpdated.push({ key: laterItem.key, action: "cancelled" });
      }
      continue;
    }

    if (existingTimers.length > 0) {
      const target = existingTimers[0]!;
      rec.set("timers", String(target.id), {
        ...target,
        source: ruleSource,
        agent: String(runRow.agent),
        model: runRow.model ?? null,
        runner: runRow.runner ?? null,
        session: finalSession,
        hops: maxInputHops,
        about: laterItem.about,
        at: laterItem.at,
      });
      for (let i = 1; i < existingTimers.length; i++) {
        rec.set("timers", String(existingTimers[i]!.id), null);
      }
      timersUpdated.push({
        key: laterItem.key,
        action: "updated",
        at: laterItem.at,
      });
    } else {
      const timerId = rec.nextId("timers");
      rec.set("timers", String(timerId), {
        id: timerId,
        rule: String(runRow.rule),
        lane: String(runRow.lane ?? ""),
        key: laterItem.key,
        source: ruleSource,
        agent: String(runRow.agent),
        model: runRow.model ?? null,
        runner: runRow.runner ?? null,
        session: finalSession,
        hops: maxInputHops,
        about: laterItem.about,
        at: laterItem.at,
        event_id: null,
        created_at: nowIso,
      });
      timersUpdated.push({
        key: laterItem.key,
        action: "scheduled",
        at: laterItem.at,
      });
    }
  }

  // Finalize run row BEFORE routing emitted events so same-(rule, lane) events
  // can queue a fresh next run and `rule.resume` sees this run as terminal.
  const response = {
    run: runId,
    status: result.outcome,
    attempt: attempts,
    requeued: false,
    cardsCreated,
    cardsResolved,
    rejectedResolves,
    timersUpdated,
    eventsEmitted,
    rejectedEvents,
    breakerCards,
  };

  const completedRunRow: Row = {
    ...runRow,
    status: result.outcome,
    ended_at: nowIso,
    heartbeat_at: nowIso,
    session: finalSession,
    summary: result.summary ?? null,
    error: null,
    usage: mergedUsage,
    last_result: result,
    last_response: response,
    timeline: [
      ...(Array.isArray(runRow.timeline) ? runRow.timeline : []),
      {
        at: nowIso,
        kind: result.outcome,
        detail: result.summary ?? result.outcome,
      },
    ],
  };
  rec.set("runs", String(runId), completedRunRow);

  // 3e. Receipt: events (whitelisted by rule.emits, inheriting maxInputHops + 1)
  const origin: OriginContext = {
    runId,
    rule: String(runRow.rule),
    grp: String(runRow.grp),
    agent: String(runRow.agent),
    session: finalSession,
  };

  for (const rawDerived of result.events ?? []) {
    if (!ruleSpec?.emits) {
      rejectedEvents.push({
        type: rawDerived.type,
        error: "EMITS_NOT_CONFIGURED",
      });
      continue;
    }
    if (!typeMatches(ruleSpec.emits.types, rawDerived.type)) {
      rejectedEvents.push({
        type: rawDerived.type,
        error: "EMITS_TYPE_FORBIDDEN",
      });
      continue;
    }

    const derivedHops = maxInputHops + 1;
    const derivedEvent: InboundEvent = {
      ...rawDerived,
      hops: derivedHops,
    };
    const ingestRes = ingestEventInternal(
      rec,
      ruleSpec.emits.source,
      derivedEvent,
      nowMs,
      origin,
    );
    if (!ingestRes.duplicate) {
      eventsEmitted.push({
        ...derivedEvent,
        source: ruleSpec.emits.source,
        hops: derivedHops,
      });
      if (ingestRes.breakerCard) {
        breakerCards.push(ingestRes.breakerCard);
      }
    }
  }

  // Re-persist response snapshot after populating eventsEmitted / rejectedEvents / breakerCards
  rec.set("runs", String(runId), {
    ...completedRunRow,
    last_response: response,
  });

  rec.syncDue(nowMs);
  return {
    facts: rec.flushFact(nowMs, "run.submitted"),
    value: response,
  };
}

function handleAnswerCard(
  rec: DraftRecorder,
  input: Extract<KernelInput, { type: "answerCard" }>,
  nowMs: number,
): DecideResult<{ card: CardView; eventId: number; run: number | null }> {
  const cardId = assertPositiveInt(input.card, "answerCard.card");
  const cardRow = rec.draft.get("cards", String(cardId));
  if (!cardRow) {
    throw new NotFoundError(`未找到卡片 ${cardId}`);
  }
  if (cardRow.kind !== "ask") {
    throw new InputError(
      `卡片 ${cardId} 类型为 ${String(cardRow.kind)}，仅 ask 卡片可回答`,
    );
  }
  if (cardRow.status !== "open") {
    throw new ConflictError(
      `卡片 ${cardId} 当前状态为 ${String(cardRow.status)}，不可重复回答`,
    );
  }

  const options = Array.isArray(cardRow.options)
    ? (cardRow.options as string[])
    : [];
  const hasChoice = input.choice !== undefined;
  const trimmedText =
    typeof input.text === "string" && input.text.trim().length > 0
      ? input.text.trim()
      : null;

  if (input.text !== undefined && typeof input.text !== "string") {
    throw new InputError("answerCard.text 必须是字符串");
  }
  if (!hasChoice && trimmedText === null) {
    throw new InputError("answerCard 必须提供合法的 choice 下标或非空 text");
  }

  let choice: number | null = null;
  let chosen: string;
  if (hasChoice) {
    if (
      typeof input.choice !== "number" ||
      !Number.isSafeInteger(input.choice) ||
      input.choice < 0 ||
      input.choice >= options.length
    ) {
      throw new InputError(
        `answerCard.choice 必须是 0 到 ${options.length - 1} 之间的整数下标`,
      );
    }
    choice = input.choice;
    chosen = options[choice]!;
  } else {
    chosen = trimmedText!;
  }

  const nowIso = iso(nowMs);
  let inheritedHops =
    typeof cardRow.hops === "number" ? (cardRow.hops as number) : null;
  if (inheritedHops === null && typeof cardRow.run_id === "number") {
    const srcEvents = linkedEventRowsForRun(rec.draft, cardRow.run_id);
    inheritedHops = srcEvents.reduce(
      (max, ev) => Math.max(max, typeof ev.hops === "number" ? ev.hops : 0),
      0,
    );
  }
  const hops = inheritedHops ?? 0;

  const eventId = rec.nextId("events");
  const ruleName = String(cardRow.rule);
  const lane = String(cardRow.lane ?? "");
  const rulesEntry = rulesOf(rec.draft);
  const ruleSpec = rulesEntry?.config.rules.find((r) => r.name === ruleName);

  rec.set("events", String(eventId), {
    id: eventId,
    source: cardRow.source ?? "card",
    key: `ans-card-${cardId}`,
    type: "card.answered",
    subject: lane,
    summary: "",
    detail: "",
    link: "",
    hops,
    routed: ruleSpec ? [ruleName] : [],
    paused: [],
    received_at: nowIso,
  });

  const updatedCard: Row = {
    ...cardRow,
    status: "decided",
    choice,
    chosen,
    answer_text: trimmedText,
    answer_event: eventId,
    decided_at: nowIso,
    version: ((cardRow.version as number) ?? 1) + 1,
  };
  rec.set("cards", String(cardId), updatedCard);

  let runId: number | null = null;
  if (ruleSpec && rulesEntry) {
    const res = enqueueOrMergeRun(
      rec,
      ruleSpec,
      rulesEntry.version,
      lane,
      eventId,
      nowMs,
      {
        timelineDetail: `card #${cardId} answered`,
        resumeSession:
          typeof cardRow.session === "string" && cardRow.session.length > 0
            ? cardRow.session
            : null,
        resumeAgent: typeof cardRow.agent === "string" ? cardRow.agent : null,
        resumeModel: cardRow.model !== undefined ? cardRow.model : undefined,
        resumeRunner:
          typeof cardRow.runner === "string" ? cardRow.runner : null,
      },
    );
    runId = res.runId;
  }

  rec.syncDue(nowMs);
  return {
    facts: rec.flushFact(nowMs, "card.answered"),
    value: {
      card: cardViewOf(updatedCard),
      eventId,
      run: runId,
    },
  };
}

function handleResolveCard(
  rec: DraftRecorder,
  input: Extract<KernelInput, { type: "resolveCard" }>,
  nowMs: number,
): DecideResult<{ card: CardView }> {
  const cardId = assertPositiveInt(input.card, "resolveCard.card");
  const reason = assertNonEmptyText(input.reason, "resolveCard.reason").trim();

  const cardRow = rec.draft.get("cards", String(cardId));
  if (!cardRow) {
    throw new NotFoundError(`未找到卡片 ${cardId}`);
  }
  if (cardRow.status !== "open") {
    throw new ConflictError(
      `卡片 ${cardId} 当前状态为 ${String(cardRow.status)}，不可结案`,
    );
  }

  const nowIso = iso(nowMs);
  const updatedCard: Row = {
    ...cardRow,
    status: "closed",
    resolved_reason: reason,
    closed_at: nowIso,
    version: ((cardRow.version as number) ?? 1) + 1,
  };
  rec.set("cards", String(cardId), updatedCard);
  rec.syncDue(nowMs);

  return {
    facts: rec.flushFact(nowMs, "card.resolved"),
    value: { card: cardViewOf(updatedCard) },
  };
}

function handleStopRun(
  rec: DraftRecorder,
  input: Extract<KernelInput, { type: "stopRun" }>,
  nowMs: number,
): DecideResult<{ run: RunSummary; changed: boolean }> {
  const runId = assertPositiveInt(input.run, "stopRun.run");
  const runRow = rec.draft.get("runs", String(runId));
  if (!runRow) {
    throw new NotFoundError(`未找到轮次 ${runId}`);
  }

  const nowIso = iso(nowMs);
  if (runRow.status === "queued") {
    const updatedRow: Row = {
      ...runRow,
      status: "cancelled",
      cancel_at: runRow.cancel_at ?? nowIso,
      ended_at: nowIso,
      error: runRow.error ?? "stopped by user",
      timeline: [
        ...(Array.isArray(runRow.timeline) ? runRow.timeline : []),
        { at: nowIso, kind: "cancel_requested", detail: "stop requested" },
        { at: nowIso, kind: "cancelled", detail: "stopped while queued" },
      ],
    };
    rec.set("runs", String(runId), updatedRow);
    rec.syncDue(nowMs);
    return {
      facts: rec.flushFact(nowMs, "run.stopped"),
      value: { run: runSummaryOf(rec.draft, updatedRow), changed: true },
    };
  }

  if (runRow.status === "claimed" || runRow.status === "unknown") {
    if (runRow.cancel_at != null) {
      return {
        facts: [],
        value: { run: runSummaryOf(rec.draft, runRow), changed: false },
      };
    }
    const updatedRow: Row = {
      ...runRow,
      cancel_at: nowIso,
      timeline: [
        ...(Array.isArray(runRow.timeline) ? runRow.timeline : []),
        { at: nowIso, kind: "cancel_requested", detail: "stop requested" },
      ],
    };
    rec.set("runs", String(runId), updatedRow);
    rec.syncDue(nowMs);
    return {
      facts: rec.flushFact(nowMs, "run.stop_requested"),
      value: { run: runSummaryOf(rec.draft, updatedRow), changed: true },
    };
  }

  // Already terminal
  return {
    facts: [],
    value: { run: runSummaryOf(rec.draft, runRow), changed: false },
  };
}

function handlePauseRule(
  rec: DraftRecorder,
  input: Extract<KernelInput, { type: "pauseRule" }>,
  nowMs: number,
): DecideResult<{
  rule: string;
  pausedAt: string;
  reason: string | null;
  until: string | null;
}> {
  const ruleName = assertNonEmptyText(input.rule, "pauseRule.rule").trim();
  const rulesEntry = rulesOf(rec.draft);
  const ruleSpec = rulesEntry?.config.rules.find((r) => r.name === ruleName);
  if (!ruleSpec) {
    throw new NotFoundError(`未找到规则 ${ruleName}`);
  }

  let untilIso: string | null = null;
  if (input.until !== undefined && input.until !== null) {
    if (
      typeof input.until !== "string" ||
      !isValidIsoDateTimeWithOffset(input.until)
    ) {
      throw new InputError(
        "pauseRule.until 必须是带显式时区偏移（Z 或 ±HH:MM）的合法 ISO 时间",
      );
    }
    const untilMs = Date.parse(input.until);
    if (!Number.isFinite(untilMs) || untilMs <= nowMs) {
      throw new InputError("pauseRule.until 必须晚于当前时间");
    }
    untilIso = iso(untilMs);
  }

  const reason =
    typeof input.reason === "string" && input.reason.trim().length > 0
      ? input.reason.trim()
      : null;
  const nowIso = iso(nowMs);

  rec.set("pauses", ruleName, {
    rule: ruleName,
    reason,
    paused_at: nowIso,
    until: untilIso,
  });
  rec.syncDue(nowMs);

  return {
    facts: rec.flushFact(nowMs, "rule.paused"),
    value: {
      rule: ruleName,
      pausedAt: nowIso,
      reason,
      until: untilIso,
    },
  };
}

function handleResumeRule(
  rec: DraftRecorder,
  input: Extract<KernelInput, { type: "resumeRule" }>,
  nowMs: number,
): DecideResult<{
  rule: string;
  wasPaused: boolean;
  skipped: SkippedEventView[];
}> {
  const ruleName = assertNonEmptyText(input.rule, "resumeRule.rule").trim();
  const rulesEntry = rulesOf(rec.draft);
  const ruleSpec = rulesEntry?.config.rules.find((r) => r.name === ruleName);
  const pauseRow = rec.draft.get("pauses", ruleName);
  if (!ruleSpec && !pauseRow) {
    throw new NotFoundError(`未找到规则 ${ruleName}`);
  }

  const skippedRows = rows(rec.draft, "skipped", { rule: ruleName }).filter(
    (s) => s.replayed_at === null || s.replayed_at === undefined,
  );
  const skipped = skippedRows.map(skippedViewOf);
  const wasPaused = pauseRow !== undefined;

  if (pauseRow) {
    rec.set("pauses", ruleName, null);
  }

  const nowIso = iso(nowMs);
  const sched = rec.draft.get("schedules", ruleName);
  if (sched && typeof sched.next_at === "string") {
    const nextMs = Date.parse(sched.next_at);
    if (Number.isFinite(nextMs) && nextMs <= nowMs) {
      const futureMs = nextRun(
        String(sched.cron),
        String(sched.timezone ?? "UTC"),
        nowMs,
      );
      rec.set("schedules", ruleName, {
        ...sched,
        next_at: iso(futureMs),
        skipped_at: nowIso,
      });
    }
  }

  rec.syncDue(nowMs);
  return {
    facts: rec.flushFact(nowMs, "rule.resumed"),
    value: { rule: ruleName, wasPaused, skipped },
  };
}

function handleReplayRule(
  rec: DraftRecorder,
  input: Extract<KernelInput, { type: "replayRule" }>,
  nowMs: number,
): DecideResult<{
  rule: string;
  replayedCount: number;
  runs: number[];
  eventIds: number[];
}> {
  const ruleName = assertNonEmptyText(input.rule, "replayRule.rule").trim();
  const rulesEntry = rulesOf(rec.draft);
  const ruleSpec = rulesEntry?.config.rules.find((r) => r.name === ruleName);
  if (!ruleSpec || !rulesEntry) {
    throw new NotFoundError(`未找到规则 ${ruleName}`);
  }

  let sinceMs = Number.NEGATIVE_INFINITY;
  if (input.since !== undefined) {
    if (typeof input.since === "number") {
      if (!Number.isFinite(input.since)) {
        throw new InputError("replayRule.since 必须是有限数字或合法时间字符串");
      }
      sinceMs = input.since;
    } else if (typeof input.since === "string") {
      const parsed = Date.parse(input.since);
      if (!Number.isFinite(parsed)) {
        throw new InputError("replayRule.since 必须是合法 ISO 时间字符串");
      }
      sinceMs = parsed;
    } else {
      throw new InputError("replayRule.since 类型无效");
    }
  }

  const candidates = rows(rec.draft, "skipped", { rule: ruleName }).filter(
    (row) => {
      if (row.replayed_at !== null && row.replayed_at !== undefined) {
        return false;
      }
      const receivedMs = Date.parse(String(row.received_at ?? ""));
      return Number.isFinite(receivedMs) && receivedMs >= sinceMs;
    },
  );

  const nowIso = iso(nowMs);
  const runIdSet = new Set<number>();
  const eventIds: number[] = [];

  for (const skipRow of candidates) {
    const eventId = skipRow.event_id as number;
    const subject =
      typeof skipRow.subject === "string" ? skipRow.subject : undefined;
    const lane = laneOf(ruleSpec, subject);
    const { runId } = enqueueOrMergeRun(
      rec,
      ruleSpec,
      rulesEntry.version,
      lane,
      eventId,
      nowMs,
      { timelineDetail: `replay skipped event #${eventId}` },
    );

    rec.set("skipped", `${ruleName}:${eventId}`, {
      ...skipRow,
      replayed_at: nowIso,
      replay_run_id: runId,
    });
    runIdSet.add(runId);
    eventIds.push(eventId);
  }

  if (candidates.length > 0) {
    rec.syncDue(nowMs);
  }

  return {
    facts: rec.flushFact(nowMs, "rule.replayed"),
    value: {
      rule: ruleName,
      replayedCount: candidates.length,
      runs: Array.from(runIdSet),
      eventIds,
    },
  };
}

function handleRunRule(
  rec: DraftRecorder,
  input: Extract<KernelInput, { type: "runRule" }>,
  nowMs: number,
): DecideResult<{
  rule: string;
  run: number;
  eventId: number;
  merged: boolean;
}> {
  const ruleName = assertNonEmptyText(input.rule, "runRule.rule").trim();
  const rulesEntry = rulesOf(rec.draft);
  const ruleSpec = rulesEntry?.config.rules.find((r) => r.name === ruleName);
  if (!ruleSpec || !rulesEntry) {
    throw new NotFoundError(`未找到规则 ${ruleName}`);
  }

  let validatedSubject = "";
  if (input.subject !== undefined && input.subject !== "") {
    const checked = wrapProtocol(() =>
      parseInboundEvent(
        { id: "manual", type: "manual.run", subject: input.subject },
        "runRule",
      ),
    );
    validatedSubject = checked.subject ?? "";
  }

  const nowIso = iso(nowMs);
  const eventId = rec.nextId("events");
  rec.set("events", String(eventId), {
    id: eventId,
    source: "manual",
    key: `manual:${ruleName}:${nowMs}:${eventId}`,
    type: "manual.run",
    subject: validatedSubject,
    summary: "",
    detail: "",
    link: "",
    hops: 0,
    routed: [ruleName],
    paused: [],
    received_at: nowIso,
  });

  const lane = laneOf(ruleSpec, validatedSubject);
  const { runId, merged } = enqueueOrMergeRun(
    rec,
    ruleSpec,
    rulesEntry.version,
    lane,
    eventId,
    nowMs,
    { manual: true, timelineDetail: "manual run triggered" },
  );

  rec.syncDue(nowMs);
  return {
    facts: rec.flushFact(nowMs, "rule.triggered"),
    value: { rule: ruleName, run: runId, eventId, merged },
  };
}

function handleTick(
  rec: DraftRecorder,
  nowMs: number,
): DecideResult<{
  unpaused: string[];
  expiredRuns: number[];
  cronFired: Array<{
    rule: string;
    firedAt: string;
    nextAt: string;
    run: number;
    eventId: number;
  }>;
  timersFired: Array<{
    timer: number;
    key: string;
    rule: string;
    lane: string;
    eventId: number;
    run: number | null;
  }>;
}> {
  const nowIso = iso(nowMs);
  const unpaused: string[] = [];
  const expiredRuns: number[] = [];
  const cronFired: Array<{
    rule: string;
    firedAt: string;
    nextAt: string;
    run: number;
    eventId: number;
  }> = [];
  const timersFired: Array<{
    timer: number;
    key: string;
    rule: string;
    lane: string;
    eventId: number;
    run: number | null;
  }> = [];

  // 1. Expire timed pauses whose `until <= nowMs`
  for (const pause of rec.draft.all("pauses")) {
    if (pause.until === null || pause.until === undefined) {
      continue;
    }
    const untilMs = Date.parse(String(pause.until));
    if (!Number.isFinite(untilMs) || untilMs > nowMs) {
      continue;
    }

    const ruleName = String(pause.rule);
    rec.set("pauses", ruleName, null);
    unpaused.push(ruleName);

    // Advance schedule past any occurrence that fell inside the pause window (< untilMs)
    const sched = rec.draft.get("schedules", ruleName);
    if (sched && typeof sched.next_at === "string") {
      const nextAtMs = Date.parse(sched.next_at);
      if (Number.isFinite(nextAtMs) && nextAtMs < untilMs) {
        const afterPauseMs = nextRun(
          String(sched.cron),
          String(sched.timezone ?? "UTC"),
          untilMs - 1,
        );
        rec.set("schedules", ruleName, {
          ...sched,
          next_at: iso(afterPauseMs),
          skipped_at: nowIso,
        });
      }
    }
  }

  // 2. Transition stale claimed runs (> RUN_LEASE_MS without heartbeat) -> unknown
  for (const runRow of rows(rec.draft, "runs", { status: "claimed" })) {
    const anchor = runRow.heartbeat_at ?? runRow.claimed_at;
    if (typeof anchor !== "string") {
      continue;
    }
    const baseMs = Date.parse(anchor);
    if (Number.isFinite(baseMs) && baseMs + RUN_LEASE_MS <= nowMs) {
      const runId = runRow.id as number;
      rec.set("runs", String(runId), {
        ...runRow,
        status: "unknown",
        timeline: [
          ...(Array.isArray(runRow.timeline) ? runRow.timeline : []),
          {
            at: nowIso,
            kind: "unknown",
            detail: "lease expired without heartbeat",
          },
        ],
      });
      expiredRuns.push(runId);
    }
  }

  const rulesEntry = rulesOf(rec.draft);

  // 3. Fire due cron schedules (only latest missed occurrence after sleep/wakeup)
  for (const sched of rec.draft.all("schedules")) {
    const ruleName = String(sched.rule);
    if (typeof sched.next_at !== "string") {
      continue;
    }
    const nextAtMs = Date.parse(sched.next_at);
    if (!Number.isFinite(nextAtMs) || nextAtMs > nowMs) {
      continue;
    }

    const tz = String(sched.timezone ?? "UTC");
    const cronExpr = String(sched.cron);
    const nextFutureMs = nextRun(cronExpr, tz, nowMs);

    if (isPauseActive(rec.draft.get("pauses", ruleName), nowMs)) {
      rec.set("schedules", ruleName, {
        ...sched,
        next_at: iso(nextFutureMs),
        skipped_at: nowIso,
      });
      continue;
    }

    const ruleSpec = rulesEntry?.config.rules.find((r) => r.name === ruleName);
    if (!ruleSpec || !rulesEntry) {
      rec.set("schedules", ruleName, null);
      continue;
    }

    const firedMs = latestBefore(cronExpr, tz, nowMs) ?? nextAtMs;
    const eventId = rec.nextId("events");
    rec.set("events", String(eventId), {
      id: eventId,
      source: "cron",
      key: `cron:${ruleName}:${firedMs}`,
      type: "cron.due",
      subject: "",
      summary: "",
      detail: "",
      link: "",
      hops: 0,
      routed: [ruleName],
      paused: [],
      received_at: nowIso,
    });

    const { runId } = enqueueOrMergeRun(
      rec,
      ruleSpec,
      rulesEntry.version,
      "",
      eventId,
      nowMs,
      { timelineDetail: `cron due at ${iso(firedMs)}` },
    );

    rec.set("schedules", ruleName, {
      ...sched,
      next_at: iso(nextFutureMs),
      last_run_at: nowIso,
    });

    cronFired.push({
      rule: ruleName,
      firedAt: iso(firedMs),
      nextAt: iso(nextFutureMs),
      run: runId,
      eventId,
    });
  }

  // 4. Fire due timers (`event_id === null` and `at <= nowMs`)
  for (const timer of rows(rec.draft, "timers", { event_id: null })) {
    if (typeof timer.at !== "string") {
      continue;
    }
    const atMs = Date.parse(timer.at);
    if (!Number.isFinite(atMs) || atMs > nowMs) {
      continue;
    }

    const timerId = timer.id as number;
    const ruleName = String(timer.rule);
    const lane = typeof timer.lane === "string" ? timer.lane : "";
    const ruleSpec = rulesEntry?.config.rules.find((r) => r.name === ruleName);
    const hops = typeof timer.hops === "number" ? (timer.hops as number) : 0;

    const eventId = rec.nextId("events");
    rec.set("events", String(eventId), {
      id: eventId,
      source: timer.source ?? "timer",
      key: `timer:${timerId}:${String(timer.key)}`,
      type: "timer.due",
      subject: lane,
      summary: typeof timer.about === "string" ? timer.about : "",
      detail: "",
      link: "",
      hops,
      routed: ruleSpec ? [ruleName] : [],
      paused: [],
      received_at: nowIso,
    });

    rec.set("timers", String(timerId), {
      ...timer,
      event_id: eventId,
    });

    let runId: number | null = null;
    if (ruleSpec && rulesEntry) {
      const res = enqueueOrMergeRun(
        rec,
        ruleSpec,
        rulesEntry.version,
        lane,
        eventId,
        nowMs,
        {
          timelineDetail: `timer ${String(timer.key)} fired`,
          resumeSession:
            typeof timer.session === "string" && timer.session.length > 0
              ? timer.session
              : null,
          resumeAgent: typeof timer.agent === "string" ? timer.agent : null,
          resumeModel: timer.model !== undefined ? timer.model : undefined,
          resumeRunner: typeof timer.runner === "string" ? timer.runner : null,
        },
      );
      runId = res.runId;
    }

    timersFired.push({
      timer: timerId,
      key: String(timer.key),
      rule: ruleName,
      lane,
      eventId,
      run: runId,
    });
  }

  rec.syncDue(nowMs);
  return {
    facts: rec.flushFact(nowMs, "clock.ticked"),
    value: { unpaused, expiredRuns, cronFired, timersFired },
  };
}

/**
 * Pure deterministic kernel state transition entry point.
 * Evaluates `input` against a copy-on-write fork of `view` at explicit timestamp `nowMs`,
 * keeping `view` completely untouched and incrementally synchronizing `due` deadlines.
 */
export function decide<T = any>(
  view: View,
  input: KernelInput,
  nowMs: number,
  env: DecideEnv,
): DecideResult<T> {
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) {
    throw new InputError(`无效时间戳: ${String(nowMs)}`);
  }
  if (!input || typeof input !== "object" || typeof input.type !== "string") {
    throw new InputError("KernelInput 必须包含有效的 type 字段");
  }

  const rec = createRecorder(view);

  switch (input.type) {
    case "configureRules":
      return handleConfigureRules(rec, input.config, nowMs) as DecideResult<T>;
    case "ingestEvent":
      return handleIngestEvent(
        rec,
        input.source,
        input.event,
        nowMs,
      ) as DecideResult<T>;
    case "claimWork":
      return handleClaimWork(rec, input, nowMs, env) as DecideResult<T>;
    case "markStarted":
      return handleMarkStarted(rec, input, nowMs, env) as DecideResult<T>;
    case "submitResult":
      return handleSubmitResult(rec, input, nowMs, env) as DecideResult<T>;
    case "answerCard":
      return handleAnswerCard(rec, input, nowMs) as DecideResult<T>;
    case "resolveCard":
      return handleResolveCard(rec, input, nowMs) as DecideResult<T>;
    case "stopRun":
      return handleStopRun(rec, input, nowMs) as DecideResult<T>;
    case "pauseRule":
      return handlePauseRule(rec, input, nowMs) as DecideResult<T>;
    case "resumeRule":
      return handleResumeRule(rec, input, nowMs) as DecideResult<T>;
    case "replayRule":
      return handleReplayRule(rec, input, nowMs) as DecideResult<T>;
    case "runRule":
      return handleRunRule(rec, input, nowMs) as DecideResult<T>;
    case "tick":
      return handleTick(rec, nowMs) as DecideResult<T>;
    default:
      throw new InputError(
        `未知内核指令类型: ${String((input as { type?: unknown }).type)}`,
      );
  }
}
