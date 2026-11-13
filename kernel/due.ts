import { iso, rows, type Row, type View } from "./evolve.ts";

export const MINUTE = 60_000;
export const RUN_LEASE_MS = 5 * MINUTE;
export const HEARTBEAT_INTERVAL_MS = MINUTE;

export type DueKind = "cron" | "timer" | "retry" | "lease" | "unpause";

function makeDueRow(kind: DueKind, target: string, at: number): Row {
  return {
    kind,
    target,
    at,
    iso_at: iso(at),
  };
}

function isEffectivelyPaused(
  view: View,
  ruleName: string,
  nowMs: number,
): boolean {
  const pause = view.get("pauses", ruleName);
  if (!pause) {
    return false;
  }
  if (pause.until === null || pause.until === undefined) {
    return true;
  }
  const untilMs = Date.parse(String(pause.until));
  return Number.isFinite(untilMs) && untilMs > nowMs;
}

/**
 * Purely computes all pending `due` table entries across the five wakeup categories:
 * 1. `cron`: active (non-paused) schedules (`next_at`)
 * 2. `timer`: unfired timers (`event_id === null`)
 * 3. `retry`: queued runs waiting for backoff (`not_before > nowMs`)
 * 4. `lease`: claimed runs lease timeout (`heartbeat_at ?? claimed_at` + `RUN_LEASE_MS`)
 * 5. `unpause`: timed rule pauses with non-null `until`
 */
export function deadlines(view: View, nowMs: number): Record<string, Row> {
  const result: Record<string, Row> = {};

  for (const sched of rows(view, "schedules")) {
    const rule = String(sched.rule);
    if (isEffectivelyPaused(view, rule, nowMs)) {
      continue;
    }
    if (typeof sched.next_at !== "string") {
      continue;
    }
    const at = Date.parse(sched.next_at);
    if (Number.isFinite(at)) {
      result[`cron:${rule}`] = makeDueRow("cron", rule, at);
    }
  }

  for (const timer of rows(view, "timers", { event_id: null })) {
    if (typeof timer.at !== "string") {
      continue;
    }
    const at = Date.parse(timer.at);
    if (Number.isFinite(at)) {
      const target = String(timer.id);
      result[`timer:${target}`] = makeDueRow("timer", target, at);
    }
  }

  for (const run of rows(view, "runs", { status: "queued" })) {
    if (typeof run.not_before !== "string") {
      continue;
    }
    const at = Date.parse(run.not_before);
    if (Number.isFinite(at) && at > nowMs) {
      const target = String(run.id);
      result[`retry:${target}`] = makeDueRow("retry", target, at);
    }
  }

  for (const run of rows(view, "runs", { status: "claimed" })) {
    const anchor = run.heartbeat_at ?? run.claimed_at;
    if (typeof anchor !== "string") {
      continue;
    }
    const baseMs = Date.parse(anchor);
    if (Number.isFinite(baseMs)) {
      const at = baseMs + RUN_LEASE_MS;
      const target = String(run.id);
      result[`lease:${target}`] = makeDueRow("lease", target, at);
    }
  }

  for (const pause of rows(view, "pauses")) {
    if (pause.until === null || pause.until === undefined) {
      continue;
    }
    const at = Date.parse(String(pause.until));
    if (Number.isFinite(at)) {
      const target = String(pause.rule);
      result[`unpause:${target}`] = makeDueRow("unpause", target, at);
    }
  }

  return result;
}

/**
 * Returns the earliest `at` timestamp across all rows in `view.all("due")`,
 * or `null` when no due entries exist.
 */
export function earliestDueMs(view: View): number | null {
  const dueRows = view.all("due");
  let earliest: number | null = null;

  for (const row of dueRows) {
    if (typeof row.at === "number" && Number.isFinite(row.at)) {
      if (earliest === null || row.at < earliest) {
        earliest = row.at;
      }
    }
  }

  return earliest;
}
