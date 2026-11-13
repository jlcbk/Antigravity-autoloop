/**
 * Read-side state snapshot aggregator for the Sidecar UI, MCP, and CLI layers.
 * Aggregates spending windows, card queues, pipeline lines, paginated runs,
 * pending timers, active pauses, and recent skipped events from a Store or View.
 */

import { dayStartMs } from "../../kernel/cron.ts";
import { iso, type Row, type View } from "../../kernel/evolve.ts";
import {
  cardViewOf,
  groupOf,
  rulesOf,
  runSummaryOf,
} from "../../kernel/query.ts";
import type { Store } from "../../kernel/store.ts";
import type {
  CardView,
  PauseView,
  PipelineLineView,
  RunSummary,
  SkippedEventView,
  SpendingSummary,
  SpendingWindow,
  StateSnapshot,
  TimerView,
} from "../../protocol/types.ts";

export interface StateSnapshotOptions {
  beforeRun?: number;
  limit?: number;
}

const DEFAULT_RUN_LIMIT = 50;
const RECENT_CARDS_LIMIT = 50;
const RECENT_SKIPPED_LIMIT = 20;
const MS_PER_DAY = 86_400_000;

function finiteOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function addUsage(target: SpendingWindow, usage: unknown): void {
  target.runs += 1;
  if (typeof usage !== "object" || usage === null) {
    return;
  }
  const u = usage as Record<string, unknown>;
  target.input += finiteOrZero(u.input);
  target.output += finiteOrZero(u.output);
  target.cached += finiteOrZero(u.cached);
  target.cost += finiteOrZero(u.cost);
}

function resolveView(storeOrView: Store | View): View {
  return "view" in storeOrView ? storeOrView.view : storeOrView;
}

function isPauseActive(pause: Row | undefined, nowMs: number): boolean {
  if (!pause) {
    return false;
  }
  if (pause.until === null || pause.until === undefined) {
    return true;
  }
  const untilMs = Date.parse(String(pause.until));
  return Number.isFinite(untilMs) && untilMs > nowMs;
}

function pickLaterIso(a: string | null, b: unknown): string | null {
  if (typeof b !== "string" || b.length === 0) {
    return a;
  }
  if (a === null) {
    return b;
  }
  const msA = Date.parse(a);
  const msB = Date.parse(b);
  if (!Number.isFinite(msA)) {
    return b;
  }
  if (!Number.isFinite(msB)) {
    return a;
  }
  return msB > msA ? b : a;
}

/**
 * Builds a deterministic `StateSnapshot` from the current store/view at `nowMs`.
 */
export function buildStateSnapshot(
  storeOrView: Store | View,
  nowMs: number,
  options?: StateSnapshotOptions,
): StateSnapshot {
  const view = resolveView(storeOrView);
  const rulesEntry = rulesOf(view);
  const timeZone = rulesEntry?.config.timezone ?? "UTC";
  const todayStart = dayStartMs(nowMs, timeZone);
  const sevenDaysStart = dayStartMs(nowMs - 6 * MS_PER_DAY, timeZone);
  const minuteBucket = Math.floor(nowMs / 60_000);

  const rawLimit = options?.limit;
  const limit =
    typeof rawLimit === "number" &&
    Number.isSafeInteger(rawLimit) &&
    rawLimit > 0
      ? rawLimit
      : DEFAULT_RUN_LIMIT;

  const beforeRun = options?.beforeRun;
  const etag = `v${view.seq}-${todayStart}-${minuteBucket}${beforeRun !== undefined ? `-b${beforeRun}` : ""}${limit !== DEFAULT_RUN_LIMIT ? `-l${limit}` : ""}`;

  // 1. Aggregate spending and per-rule run metrics in a single pass
  const allRuns = view.all("runs");
  const spending: SpendingSummary = {
    today: { runs: 0, input: 0, output: 0, cached: 0, cost: 0 },
    last7Days: { runs: 0, input: 0, output: 0, cached: 0, cost: 0 },
  };

  interface RuleRunStats {
    activeRuns: number;
    queuedRuns: number;
    doneToday: number;
    lastRunAt: string | null;
  }
  const ruleStats = new Map<string, RuleRunStats>();

  for (const run of allRuns) {
    const ruleName = String(run.rule ?? "");
    let stats = ruleStats.get(ruleName);
    if (!stats) {
      stats = {
        activeRuns: 0,
        queuedRuns: 0,
        doneToday: 0,
        lastRunAt: null,
      };
      ruleStats.set(ruleName, stats);
    }

    const status = String(run.status ?? "");
    if (status === "claimed") {
      stats.activeRuns += 1;
    } else if (status === "queued") {
      stats.queuedRuns += 1;
    }

    const activityTsRaw = run.ended_at ?? run.claimed_at ?? run.created_at;
    const activityMs =
      typeof activityTsRaw === "string"
        ? Date.parse(activityTsRaw)
        : Number.NaN;

    if (
      (status === "done" || status === "nothing") &&
      Number.isFinite(activityMs) &&
      activityMs >= todayStart
    ) {
      stats.doneToday += 1;
    }

    if (status !== "queued" || run.claimed_at != null || run.ended_at != null) {
      stats.lastRunAt = pickLaterIso(stats.lastRunAt, activityTsRaw);
    }

    const isClaimedOrFinished =
      status !== "queued" ||
      run.claimed_at != null ||
      run.ended_at != null ||
      run.usage != null;

    if (isClaimedOrFinished && Number.isFinite(activityMs)) {
      if (activityMs >= sevenDaysStart) {
        addUsage(spending.last7Days, run.usage);
      }
      if (activityMs >= todayStart) {
        addUsage(spending.today, run.usage);
      }
    }
  }

  // 2. Cards: active (`open` pinned before `decided`) and `recentCards` (`done`/`closed`)
  const allCardViews = view.all("cards").map((row) => cardViewOf(row));
  const cards: CardView[] = [];
  const recentCards: CardView[] = [];

  for (const card of allCardViews) {
    if (card.status === "open" || card.status === "decided") {
      cards.push(card);
    } else {
      recentCards.push(card);
    }
  }

  cards.sort((a, b) => {
    const aOpen = a.status === "open" ? 0 : 1;
    const bOpen = b.status === "open" ? 0 : 1;
    if (aOpen !== bOpen) {
      return aOpen - bOpen;
    }
    return b.card - a.card;
  });

  recentCards.sort((a, b) => b.card - a.card);
  if (recentCards.length > RECENT_CARDS_LIMIT) {
    recentCards.length = RECENT_CARDS_LIMIT;
  }

  // 3. Skipped events & per-rule un-replayed count
  const allSkipped = view.all("skipped");
  const unReplayedSkippedByRule = new Map<string, number>();
  for (const s of allSkipped) {
    if (s.replayed_at === null || s.replayed_at === undefined) {
      const ruleName = String(s.rule ?? "");
      unReplayedSkippedByRule.set(
        ruleName,
        (unReplayedSkippedByRule.get(ruleName) ?? 0) + 1,
      );
    }
  }

  const skipped: SkippedEventView[] = [...allSkipped]
    .sort((a, b) => Number(b.id) - Number(a.id))
    .slice(0, RECENT_SKIPPED_LIMIT)
    .map((row) => ({
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
    }));

  // 4. Pipeline lines
  const lines: PipelineLineView[] = [];
  if (rulesEntry) {
    for (const rule of rulesEntry.config.rules) {
      const stats = ruleStats.get(rule.name);
      const schedule = view.get("schedules", rule.name);
      const pause = view.get("pauses", rule.name);
      const paused = isPauseActive(pause, nowMs);
      const activeRuns = stats?.activeRuns ?? 0;

      lines.push({
        rule: rule.name,
        group: groupOf(rule),
        to: rule.to,
        cwd: rule.cwd,
        status: paused ? "paused" : activeRuns > 0 ? "running" : "idle",
        activeRuns,
        queuedRuns: stats?.queuedRuns ?? 0,
        doneToday: stats?.doneToday ?? 0,
        lastRunAt: pickLaterIso(
          stats?.lastRunAt ?? null,
          schedule?.last_run_at,
        ),
        nextRunAt:
          typeof schedule?.next_at === "string" ? schedule.next_at : null,
        pausedUntil:
          paused && typeof pause?.until === "string" ? pause.until : null,
        pauseReason:
          paused && typeof pause?.reason === "string" ? pause.reason : null,
        skippedCount: unReplayedSkippedByRule.get(rule.name) ?? 0,
      });
    }
  }

  // 5. Paginated runs (newest first)
  const sortedRuns = [...allRuns].sort((a, b) => Number(b.id) - Number(a.id));
  const filteredRuns =
    beforeRun !== undefined
      ? sortedRuns.filter((r) => Number(r.id) < beforeRun)
      : sortedRuns;
  const hasMoreRuns = filteredRuns.length > limit;
  const runs: RunSummary[] = filteredRuns
    .slice(0, limit)
    .map((row) => runSummaryOf(view, row));

  // 6. Pending timers
  const timers: TimerView[] = view
    .all("timers")
    .filter((row) => row.event_id === null || row.event_id === undefined)
    .sort((a, b) => {
      const diff = Date.parse(String(a.at)) - Date.parse(String(b.at));
      if (Number.isFinite(diff) && diff !== 0) {
        return diff;
      }
      return Number(a.id) - Number(b.id);
    })
    .map((row) => ({
      key: String(row.key),
      rule: String(row.rule),
      lane: String(row.lane ?? ""),
      about: String(row.about ?? ""),
      at: String(row.at),
      session: typeof row.session === "string" ? row.session : null,
    }));

  // 7. Active pauses
  const pauses: PauseView[] = view
    .all("pauses")
    .filter((row) => isPauseActive(row, nowMs))
    .sort((a, b) => String(a.rule).localeCompare(String(b.rule)))
    .map((row) => ({
      rule: String(row.rule),
      ...(typeof row.reason === "string" && row.reason.length > 0
        ? { reason: row.reason }
        : {}),
      pausedAt: String(row.paused_at),
      until: typeof row.until === "string" ? row.until : null,
    }));

  return {
    etag,
    now: iso(nowMs),
    cards,
    recentCards,
    lines,
    runs,
    hasMoreRuns,
    timers,
    pauses,
    skipped,
    spending,
  };
}
