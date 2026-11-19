/**
 * Pure domain query helpers for event routing, concurrency gating, scope filtering,
 * view serialization, job payload assembly, and causal `why` trace construction.
 */

import type {
  AgentProfile,
  CardView,
  InboundEvent,
  Job,
  JobAnswerContext,
  JobDecidedCardContext,
  JobEventContext,
  JobOpenCardContext,
  JobTimerContext,
  Receipt,
  RuleSpec,
  RulesConfig,
  RunnerKind,
  RunResult,
  RunStatus,
  RunSummary,
  RunUsage,
  WhyReport,
} from "../protocol/types.ts";
import { NotFoundError } from "./errors.ts";
import { rows, type Row, type View } from "./evolve.ts";

/**
 * Match an event type against exact strings, `"*"`, or `"prefix.*"` patterns.
 */
export function typeMatches(
  patterns: readonly string[],
  eventType: string,
): boolean {
  if (eventType.length === 0) {
    return false;
  }
  for (const pattern of patterns) {
    if (pattern === "*" || pattern === eventType) {
      return true;
    }
    if (pattern.endsWith(".*")) {
      const prefix = pattern.slice(0, -1);
      if (eventType.startsWith(prefix) && eventType.length > prefix.length) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Compute the isolation lane key for a rule and optional event subject.
 */
export function laneOf(rule: RuleSpec, subject?: string): string {
  if (rule.parallel !== undefined && subject && subject.length > 0) {
    return subject;
  }
  return "";
}

/**
 * Compute the concurrency group name for a rule.
 */
export function groupOf(rule: RuleSpec): string {
  return rule.group ?? rule.name;
}

/**
 * Read the active rules configuration and version from the projection view.
 */
export function rulesOf(
  view: View,
): { version: number; config: RulesConfig } | null {
  const row = view.get("config", "rules");
  if (!row || !row.value) {
    return null;
  }
  return {
    version: row.version as number,
    config: row.value as RulesConfig,
  };
}

function isPauseEffective(pauseRow: Row | undefined, nowMs: number): boolean {
  if (!pauseRow) {
    return false;
  }
  if (pauseRow.until === null || pauseRow.until === undefined) {
    return true;
  }
  const untilMs = Date.parse(String(pauseRow.until));
  return Number.isFinite(untilMs) && untilMs > nowMs;
}

function findRule(config: RulesConfig, ruleName: string): RuleSpec | undefined {
  return config.rules.find((r) => r.name === ruleName);
}

function ruleSourceOf(rule: RuleSpec): string | null {
  return "source" in rule.when ? rule.when.source : null;
}

/**
 * Check whether a queued run satisfies schedule, pause, and multi-level concurrency limits.
 */
export function canClaimRun(
  view: View,
  runRow: Row,
  nowMs: number,
  workerCapacity: number,
): boolean {
  if (runRow.status !== "queued") {
    return false;
  }

  // 1. Backoff / readiness timestamp check
  const notBeforeMs = Date.parse(String(runRow.not_before ?? ""));
  if (Number.isNaN(notBeforeMs) || notBeforeMs > nowMs) {
    return false;
  }

  const rules = rulesOf(view);
  if (!rules) {
    return false;
  }
  const rule = findRule(rules.config, String(runRow.rule));
  if (!rule) {
    return false;
  }

  const agentId = rule.to;
  const agentProfile = rules.config.agents[agentId];
  if (!agentProfile) {
    return false;
  }

  // 2. Active rule pause check (indefinite or until > nowMs)
  if (isPauseEffective(view.get("pauses", rule.name), nowMs)) {
    return false;
  }

  // 3. Global worker capacity check
  const claimedRuns = rows(view, "runs", { status: "claimed" });
  if (claimedRuns.length >= workerCapacity) {
    return false;
  }

  // 4. Single active run per (grp, lane) across rules sharing the same group
  const grp = groupOf(rule);
  const runLane = typeof runRow.lane === "string" ? runRow.lane : "";
  if (
    claimedRuns.some(
      (r) => (r.grp || r.rule) === grp && (r.lane ?? "") === runLane,
    )
  ) {
    return false;
  }

  // 5. Group concurrency limit (rules without `parallel` default to 1)
  const groupLimit = rule.parallel ?? 1;
  const groupActive = claimedRuns.filter((r) => r.grp === grp).length;
  if (groupActive >= groupLimit) {
    return false;
  }

  // 6. Per-rule maxActive limit
  const ruleLimit = rule.maxActive ?? Infinity;
  const ruleActive = claimedRuns.filter((r) => r.rule === rule.name).length;
  if (ruleActive >= ruleLimit) {
    return false;
  }

  // 7. Per-agent profile maxActive limit
  const agentLimit = agentProfile.maxActive ?? Infinity;
  const agentActive = claimedRuns.filter((r) => r.agent === agentId).length;
  if (agentActive >= agentLimit) {
    return false;
  }

  return true;
}

/**
 * Find all open cards within `(grp, source)` created at or before `beforeIso`.
 */
export function openInScope(
  view: View,
  grp: string,
  source: string | null,
  beforeIso?: string,
): Row[] {
  const candidates = rows(view, "cards", { status: "open", grp, source });
  if (beforeIso === undefined) {
    return candidates;
  }
  const cutoffMs = Date.parse(beforeIso);
  if (Number.isNaN(cutoffMs)) {
    return candidates;
  }
  return candidates.filter((card) => {
    const createdMs = Date.parse(String(card.created_at ?? ""));
    return Number.isFinite(createdMs) && createdMs <= cutoffMs;
  });
}

/**
 * Convert an internal `cards` row into the public `CardView` contract.
 */
export function cardViewOf(cardRow: Row): CardView {
  const out: CardView = {
    card: cardRow.id as number,
    kind: cardRow.kind,
    status: cardRow.status,
    rule: cardRow.rule as string,
    lane: (cardRow.lane as string) ?? "",
    key: cardRow.key as string,
    title: cardRow.title as string,
    text: cardRow.text as string,
    createdAt: cardRow.created_at as string,
  };

  if (
    cardRow.kind === "ask" ||
    (Array.isArray(cardRow.options) && cardRow.options.length > 0)
  ) {
    out.options = [...(cardRow.options as string[])];
  }
  if (typeof cardRow.recommend === "number") {
    out.recommend = cardRow.recommend;
  }
  if (typeof cardRow.about === "string" && cardRow.about.length > 0) {
    out.about = cardRow.about;
  }
  if (cardRow.kind === "notice" || cardRow.fyi === true) {
    out.fyi = Boolean(cardRow.fyi);
  }
  if (typeof cardRow.choice === "number") {
    out.choice = cardRow.choice;
  } else if (cardRow.status === "decided") {
    out.choice = null;
  }
  if (typeof cardRow.chosen === "string") {
    out.chosen = cardRow.chosen;
  }
  if (typeof cardRow.answer_text === "string") {
    out.answerText = cardRow.answer_text;
  }
  if (typeof cardRow.resolved_reason === "string") {
    out.resolvedReason = cardRow.resolved_reason;
  }
  if (typeof cardRow.run_id === "number") {
    out.run = cardRow.run_id;
  }
  if (cardRow.session !== undefined) {
    out.session = (cardRow.session as string | null) ?? null;
  }
  if (cardRow.decided_at !== undefined) {
    out.decidedAt = (cardRow.decided_at as string | null) ?? null;
  }
  if (cardRow.closed_at !== undefined) {
    out.closedAt = (cardRow.closed_at as string | null) ?? null;
  }

  return out;
}

/**
 * Convert an internal `runs` row into the public `RunSummary` contract.
 */
export function runSummaryOf(view: View, runRow: Row): RunSummary {
  const rules = rulesOf(view);
  const agentProfile = rules?.config.agents[String(runRow.agent)];

  const summary: RunSummary = {
    run: runRow.id as number,
    rule: runRow.rule as string,
    lane: (runRow.lane as string) ?? "",
    group: runRow.grp as string,
    agent: runRow.agent as string,
    runner: (agentProfile?.runner ?? "command") as RunnerKind,
    status: runRow.status as RunStatus,
    attempt: runRow.attempts as number,
    session: (runRow.session as string | null) ?? null,
    createdAt: runRow.created_at as string,
    claimedAt: (runRow.claimed_at as string | null) ?? null,
    startedAt: (runRow.started_at as string | null) ?? null,
    endedAt: (runRow.ended_at as string | null) ?? null,
    notBefore: (runRow.not_before as string | null) ?? null,
    cancelAt: (runRow.cancel_at as string | null) ?? null,
    heartbeatAt: (runRow.heartbeat_at as string | null) ?? null,
  };

  if (
    typeof agentProfile?.model === "string" &&
    agentProfile.model.length > 0
  ) {
    summary.model = agentProfile.model;
  }
  if (typeof runRow.summary === "string") {
    summary.summary = runRow.summary;
  }
  if (typeof runRow.error === "string") {
    summary.error = runRow.error;
  }
  if (runRow.usage !== null && runRow.usage !== undefined) {
    summary.usage = runRow.usage as RunUsage;
  }

  return summary;
}

function linkedEventRows(view: View, runId: number): Row[] {
  const links = rows(view, "run_events", { run_id: runId });
  links.sort((a, b) => (a.event_id as number) - (b.event_id as number));
  const eventRows: Row[] = [];
  for (const link of links) {
    const ev = view.get("events", String(link.event_id));
    if (ev) {
      eventRows.push(ev);
    }
  }
  return eventRows;
}

function toInboundEvent(ev: Row): InboundEvent {
  const out: InboundEvent = {
    id: String(ev.key ?? ev.id),
    type: String(ev.type),
  };
  if (typeof ev.subject === "string" && ev.subject.length > 0) {
    out.subject = ev.subject;
  }
  if (typeof ev.summary === "string" && ev.summary.length > 0) {
    out.summary = ev.summary;
  }
  if (typeof ev.detail === "string" && ev.detail.length > 0) {
    out.detail = ev.detail;
  }
  if (typeof ev.link === "string" && ev.link.length > 0) {
    out.link = ev.link;
  }
  if (typeof ev.hops === "number") {
    out.hops = ev.hops;
  }
  return out;
}

function toJobEventContext(
  ev: Row,
  sources: Record<string, { name: string }> | undefined,
): JobEventContext {
  const source = String(ev.source);
  return {
    ...toInboundEvent(ev),
    source,
    sourceName: sources?.[source]?.name ?? source,
    receivedAt: String(ev.received_at),
  };
}

function linkedAnsweredCards(view: View, eventIds: Set<number>): Row[] {
  if (eventIds.size === 0) {
    return [];
  }
  return rows(view, "cards").filter(
    (c) => typeof c.answer_event === "number" && eventIds.has(c.answer_event),
  );
}

function extractFiredTimerContexts(
  view: View,
  evRows: readonly Row[],
  eventIds: Set<number>,
): JobTimerContext[] {
  if (eventIds.size === 0) {
    return [];
  }
  const activeMatches = rows(view, "timers").filter(
    (t) => typeof t.event_id === "number" && eventIds.has(t.event_id),
  );
  const coveredEventIds = new Set<number>(
    activeMatches.map((t) => t.event_id as number),
  );
  const out: JobTimerContext[] = activeMatches.map((t) => ({
    key: String(t.key),
    about: String(t.about),
    at: String(t.at),
  }));

  for (const ev of evRows) {
    const evId = ev.id as number;
    if (coveredEventIds.has(evId)) {
      continue;
    }
    if (ev.type === "timer.due" && typeof ev.timer_key === "string") {
      out.push({
        key: ev.timer_key,
        about: String(ev.timer_about ?? ev.summary ?? ""),
        at: String(ev.timer_at ?? ev.received_at ?? ""),
      });
    }
  }
  return out;
}

function pickRuleForJob(
  ruleSpec: RuleSpec,
): Pick<RuleSpec, "name" | "cwd" | "skill" | "prompt" | "title" | "emits"> {
  const picked: Pick<
    RuleSpec,
    "name" | "cwd" | "skill" | "prompt" | "title" | "emits"
  > = {
    name: ruleSpec.name,
    cwd: ruleSpec.cwd,
  };
  if (ruleSpec.skill !== undefined) picked.skill = ruleSpec.skill;
  if (ruleSpec.prompt !== undefined) picked.prompt = ruleSpec.prompt;
  if (ruleSpec.title !== undefined) picked.title = ruleSpec.title;
  if (ruleSpec.emits !== undefined) picked.emits = ruleSpec.emits;
  return picked;
}

/**
 * Assemble the complete `Job` payload for an active run and its per-run token.
 */
export function jobOf(view: View, runId: number, token: string): Job {
  const runRow = view.get("runs", String(runId));
  if (!runRow) {
    throw new NotFoundError(`未找到轮次 ${runId}`);
  }

  const rules = rulesOf(view);
  if (!rules) {
    throw new NotFoundError("规则配置尚未初始化");
  }

  const ruleSpec = findRule(rules.config, String(runRow.rule));
  if (!ruleSpec) {
    throw new NotFoundError(`未找到规则 ${String(runRow.rule)}`);
  }

  const agentId = String(runRow.agent);
  const agentProfile: AgentProfile | undefined = rules.config.agents[agentId];
  if (!agentProfile) {
    throw new NotFoundError(`未找到执行器配置 ${agentId}`);
  }

  const evRows = linkedEventRows(view, runId);
  const eventIdSet = new Set<number>(evRows.map((ev) => ev.id as number));
  const sources = rules.config.sources;

  const events: JobEventContext[] = evRows.map((ev) =>
    toJobEventContext(ev, sources),
  );

  const answers: JobAnswerContext[] = linkedAnsweredCards(view, eventIdSet).map(
    (c) => ({
      card: c.id as number,
      key: String(c.key),
      title: String(c.title),
      options: Array.isArray(c.options) ? [...(c.options as string[])] : [],
      choice: typeof c.choice === "number" ? c.choice : null,
      chosen: String(c.chosen ?? c.answer_text ?? ""),
      about: String(c.about ?? ""),
      at: String(c.decided_at ?? c.created_at),
    }),
  );

  const timers: JobTimerContext[] = extractFiredTimerContexts(
    view,
    evRows,
    eventIdSet,
  );

  const lane = typeof runRow.lane === "string" ? runRow.lane : "";
  const waiting: JobTimerContext[] = rows(view, "timers", {
    rule: ruleSpec.name,
    lane,
    event_id: null,
  }).map((t) => ({
    key: String(t.key),
    about: String(t.about),
    at: String(t.at),
  }));

  const grp = String(runRow.grp ?? groupOf(ruleSpec));
  const beforeIso =
    typeof runRow.claimed_at === "string" ? runRow.claimed_at : undefined;
  const open: JobOpenCardContext[] = openInScope(
    view,
    grp,
    ruleSourceOf(ruleSpec),
    beforeIso,
  ).map((c) => ({
    card: c.id as number,
    key: String(c.key),
    title: String(c.title),
    text: String(c.text),
    at: String(c.created_at),
  }));

  const answeredCardIds = new Set<number>(answers.map((a) => a.card));
  const decided: JobDecidedCardContext[] = rows(view, "cards", {
    status: ["decided", "done"],
    rule: ruleSpec.name,
    lane,
  })
    .filter((c) => !answeredCardIds.has(c.id as number))
    .map((c) => ({
      card: c.id as number,
      key: String(c.key),
      title: String(c.title),
      choice: String(c.chosen ?? c.answer_text ?? ""),
      at: String(c.decided_at ?? c.created_at),
    }));

  return {
    run: runId,
    token,
    attempt: runRow.attempts as number,
    rule: pickRuleForJob(ruleSpec),
    agent: { ...agentProfile, id: agentId },
    session: (runRow.session as string | null) ?? null,
    askFirst: [...rules.config.askFirst],
    context: {
      events,
      answers,
      timers,
      waiting,
      open,
      decided,
    },
  };
}

function pickRuleSpecForWhy(
  ruleSpec: RuleSpec,
): NonNullable<WhyReport["ruleSpec"]> {
  const picked: NonNullable<WhyReport["ruleSpec"]> = {
    name: ruleSpec.name,
    to: ruleSpec.to,
    cwd: ruleSpec.cwd,
  };
  if (ruleSpec.skill !== undefined) picked.skill = ruleSpec.skill;
  if (ruleSpec.title !== undefined) picked.title = ruleSpec.title;
  if (ruleSpec.group !== undefined) picked.group = ruleSpec.group;
  if (ruleSpec.parallel !== undefined) picked.parallel = ruleSpec.parallel;
  if (ruleSpec.maxActive !== undefined) picked.maxActive = ruleSpec.maxActive;
  return picked;
}

function buildWhyReceipt(
  lastResult: RunResult | null | undefined,
  lastResponse: Row | null | undefined,
): WhyReport["receipt"] | undefined {
  const receipt: NonNullable<WhyReport["receipt"]> = {};
  let hasContent = false;

  if (lastResult) {
    for (const key of [
      "ask",
      "notice",
      "resolve",
      "later",
      "events",
    ] as const) {
      if (lastResult[key] !== undefined) {
        (receipt as Record<string, unknown>)[key] = lastResult[key];
        hasContent = true;
      }
    }
  }

  const rejectedResolves = lastResponse?.rejectedResolves as
    Array<{ card: number; reason: string; error: string }> | undefined;
  if (Array.isArray(rejectedResolves) && rejectedResolves.length > 0) {
    receipt.rejectedResolves = rejectedResolves;
    hasContent = true;
  }

  const rejectedEvents = lastResponse?.rejectedEvents as
    Array<{ type: string; error: string }> | undefined;
  if (Array.isArray(rejectedEvents) && rejectedEvents.length > 0) {
    receipt.rejectedEvents = rejectedEvents;
    hasContent = true;
  }

  return hasContent ? receipt : undefined;
}

function synthesizeTimeline(
  runRow: Row,
): Array<{ at: string; kind: string; detail: string }> {
  const timeline: Array<{ at: string; kind: string; detail: string }> = [];
  if (typeof runRow.created_at === "string") {
    timeline.push({
      at: runRow.created_at,
      kind: "queued",
      detail: runRow.manual ? "manual run queued" : "run queued",
    });
  }
  if (typeof runRow.claimed_at === "string") {
    timeline.push({
      at: runRow.claimed_at,
      kind: "claimed",
      detail: `attempt #${String(runRow.attempts ?? 1)}`,
    });
  }
  if (typeof runRow.started_at === "string") {
    timeline.push({
      at: runRow.started_at,
      kind: "started",
      detail: runRow.session ? `session ${String(runRow.session)}` : "started",
    });
  }
  if (typeof runRow.cancel_at === "string") {
    timeline.push({
      at: runRow.cancel_at,
      kind: "cancel_requested",
      detail: "stop requested",
    });
  }
  if (typeof runRow.ended_at === "string") {
    timeline.push({
      at: runRow.ended_at,
      kind: String(runRow.status),
      detail: String(runRow.error ?? runRow.summary ?? runRow.status),
    });
  }
  return timeline;
}

/**
 * Build a complete causal explanation report (`WhyReport`) for a run ID.
 */
export function whyOf(view: View, runId: number): WhyReport {
  const runRow = view.get("runs", String(runId));
  if (!runRow) {
    throw new NotFoundError(`未找到轮次 ${runId}`);
  }

  const rules = rulesOf(view);
  const ruleSpec = rules
    ? findRule(rules.config, String(runRow.rule))
    : undefined;
  const sources = rules?.config.sources;

  const evRows = linkedEventRows(view, runId);
  const eventIdSet = new Set<number>(evRows.map((ev) => ev.id as number));

  const events = evRows.map((ev) => ({
    ...toJobEventContext(ev, sources),
    seq: ev.id as number,
  }));

  const answers = linkedAnsweredCards(view, eventIdSet).map((c) => ({
    card: c.id as number,
    key: String(c.key),
    title: String(c.title),
    choice: typeof c.choice === "number" ? c.choice : null,
    chosen: String(c.chosen ?? c.answer_text ?? ""),
    at: String(c.decided_at ?? c.created_at),
  }));

  const timers = extractFiredTimerContexts(view, evRows, eventIdSet);

  const lastResult = runRow.last_result as RunResult | null | undefined;
  const lastResponse = runRow.last_response as Row | null | undefined;
  const receipt = buildWhyReceipt(lastResult, lastResponse);

  const cardsCreated = rows(view, "cards", { run_id: runId }).map(cardViewOf);

  let cardsResolved: number[];
  if (Array.isArray(lastResponse?.cardsResolved)) {
    cardsResolved = [...(lastResponse.cardsResolved as number[])];
  } else if (Array.isArray(lastResult?.resolve)) {
    const rejectedIds = new Set(
      (receipt?.rejectedResolves ?? []).map((r) => r.card),
    );
    cardsResolved = lastResult.resolve
      .map((r) => r.card)
      .filter((id) => !rejectedIds.has(id));
  } else {
    cardsResolved = [];
  }

  let eventsEmitted: Array<InboundEvent & { source: string; hops: number }>;
  if (Array.isArray(lastResponse?.eventsEmitted)) {
    eventsEmitted = [
      ...(lastResponse.eventsEmitted as Array<
        InboundEvent & { source: string; hops: number }
      >),
    ];
  } else if (Array.isArray(lastResult?.events) && ruleSpec?.emits) {
    const rejectedTypes = new Set(
      (receipt?.rejectedEvents ?? []).map((e) => e.type),
    );
    const maxInputHops = evRows.reduce(
      (max, ev) => Math.max(max, typeof ev.hops === "number" ? ev.hops : 0),
      0,
    );
    const derivedHops = maxInputHops + 1;
    const emitSource = ruleSpec.emits.source;
    eventsEmitted = lastResult.events
      .filter((ev) => !rejectedTypes.has(ev.type))
      .map((ev) => ({
        ...ev,
        source: emitSource,
        hops: derivedHops,
      }));
  } else {
    eventsEmitted = [];
  }

  const timeline =
    Array.isArray(runRow.timeline) && runRow.timeline.length > 0
      ? [
          ...(runRow.timeline as Array<{
            at: string;
            kind: string;
            detail: string;
          }>),
        ]
      : synthesizeTimeline(runRow);

  const report: WhyReport = {
    run: runSummaryOf(view, runRow),
    ruleVersion: (runRow.rules_version as number) ?? 0,
    events,
    answers,
    timers,
    cardsCreated,
    cardsResolved,
    eventsEmitted,
    timeline,
  };

  if (ruleSpec) {
    report.ruleSpec = pickRuleSpecForWhy(ruleSpec);
  }
  if (receipt !== undefined) {
    report.receipt = receipt;
  }

  return report;
}
