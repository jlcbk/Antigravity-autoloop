/**
 * Cron Timezone Engine & Due Deadline Calculator Tests.
 *
 * Prevents regressions in:
 * 1. Cron expression validation (rejecting malformed fields, out-of-range values, invalid IANA zones).
 * 2. Exact IANA wall-clock scheduling across month boundaries, leap years (including century non-leap 2100),
 *    and POSIX DOM+DOW OR/AND rules.
 * 3. DST transition safety: skipping non-existent spring-forward minutes and firing fall-back
 *    repeated wall-clock minutes once only (first occurrence), including positive-offset and 30-min DST zones.
 * 4. Sleep-wakeup recovery (`latestBefore` returning only the single most recent trigger) and
 *    timezone-aligned daily accounting (`dayStartMs` in Asia/Shanghai and midnight-DST zones).
 * 5. Pure `deadlines()` aggregation across all five wakeup kinds (`cron`, `timer`, `retry`, `lease`, `unpause`)
 *    and `earliestDueMs()` lookup.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  dayStartMs,
  latestBefore,
  nextRun,
  parseCron,
} from "../kernel/cron.ts";
import {
  HEARTBEAT_INTERVAL_MS,
  MINUTE,
  RUN_LEASE_MS,
  deadlines,
  earliestDueMs,
} from "../kernel/due.ts";
import { InputError } from "../kernel/errors.ts";
import { createMemoryView, iso } from "../kernel/evolve.ts";

describe("kernel/cron", () => {
  it("parses standard 5-field expressions, lists, ranges, steps, Sunday 0/7, and CRON_TZ", () => {
    const parsed = parseCron("*/15 9-17 1,15 1-10/2 7", "Asia/Shanghai");
    assert.equal(parsed.timeZone, "Asia/Shanghai");
    assert.equal(parsed.minutes[0], true);
    assert.equal(parsed.minutes[15], true);
    assert.equal(parsed.minutes[30], true);
    assert.equal(parsed.minutes[45], true);
    assert.equal(parsed.minutes[10], false);
    assert.equal(parsed.daysOfWeek[0], true);
    assert.equal(parsed.daysOfWeek[1], false);

    const withTz = parseCron(
      "  CRON_TZ=America/New_York   30 8 * * 5-7  ",
      "UTC",
    );
    assert.equal(withTz.timeZone, "America/New_York");
    assert.equal(withTz.daysOfWeek[5], true);
    assert.equal(withTz.daysOfWeek[6], true);
    assert.equal(withTz.daysOfWeek[0], true);
    assert.equal(withTz.daysOfWeek[1], false);

    // Next occurrence with CRON_TZ overrides fallback timeZone
    const after = Date.parse("2025-06-15T12:00:00Z"); // Sun 08:00 EDT in NY
    const next = nextRun("CRON_TZ=America/New_York 30 8 * * *", "UTC", after);
    assert.equal(next, Date.parse("2025-06-15T12:30:00Z"));
  });

  it("rejects malformed cron expressions and invalid timezones with InputError", () => {
    const invalidExprs = [
      "",
      "   ",
      "* * * *",
      "* * * * * *",
      "60 * * * *",
      "* 24 * * *",
      "* * 0 * *",
      "* * 32 * *",
      "* * * 0 *",
      "* * * 13 *",
      "* * * * 8",
      "10-5 * * * *",
      "*/0 * * * *",
      "1,,2 * * * *",
      "MON * * * *",
      "CRON_TZ=UTC",
      "CRON_TZ= * * * * *",
    ];

    for (const expr of invalidExprs) {
      assert.throws(() => parseCron(expr, "UTC"), InputError, `expr: ${expr}`);
    }

    assert.throws(() => parseCron("* * * * *", "Mars/Olympus"), InputError);
    assert.throws(() => parseCron("* * * * *", ""), InputError);
    assert.throws(() => nextRun("* * * * *", "UTC", Number.NaN), InputError);
    assert.throws(
      () => latestBefore("* * * * *", "UTC", Number.POSITIVE_INFINITY),
      InputError,
    );
    assert.throws(() => dayStartMs(0, "Invalid/Zone"), InputError);
  });

  it("handles month boundaries, 31-day skips, leap years, and non-leap century 2100", () => {
    // Jan 31 -> skips Feb -> Mar 31
    assert.equal(
      nextRun("0 0 31 * *", "UTC", Date.parse("2025-01-31T00:00:00Z")),
      Date.parse("2025-03-31T00:00:00Z"),
    );

    // Leap year Feb 29 -> 2028
    assert.equal(
      nextRun("0 0 29 2 *", "UTC", Date.parse("2024-02-29T00:00:00Z")),
      Date.parse("2028-02-29T00:00:00Z"),
    );

    // Non-leap century 2100 skipped: 2096-02-29 -> 2104-02-29
    assert.equal(
      nextRun("0 0 29 2 *", "UTC", Date.parse("2096-02-29T00:00:00Z")),
      Date.parse("2104-02-29T00:00:00Z"),
    );

    // POSIX OR semantics when both DOM and DOW are restricted: 15th OR Monday
    // 2025-06-14 is Saturday, 2025-06-15 is Sunday (15th), 2025-06-16 is Monday (DOW 1)
    const sat = Date.parse("2025-06-14T10:00:00Z");
    const firstOr = nextRun("0 9 15 * 1", "UTC", sat);
    assert.equal(firstOr, Date.parse("2025-06-15T09:00:00Z"));
    const secondOr = nextRun("0 9 15 * 1", "UTC", firstOr);
    assert.equal(secondOr, Date.parse("2025-06-16T09:00:00Z"));

    // Minute alignment zeroes out seconds/ms and enforces strict > afterMs
    const subMinute = Date.parse("2025-06-15T09:00:30.500Z");
    assert.equal(
      nextRun("0 9 * * *", "UTC", subMinute),
      Date.parse("2025-06-16T09:00:00.000Z"),
    );
    assert.equal(
      latestBefore("0 9 * * *", "UTC", subMinute),
      Date.parse("2025-06-15T09:00:00.000Z"),
    );
  });

  it("skips non-existent local times during America/New_York spring-forward DST", () => {
    const tz = "America/New_York";
    // 2025-03-09: 01:59 EST (06:59Z) jumps directly to 03:00 EDT (07:00Z).
    const beforeGap = Date.parse("2025-03-09T06:59:00Z");

    // 02:30 does not exist on 2025-03-09 -> skips to 2025-03-10 02:30 EDT (06:30Z)
    assert.equal(
      nextRun("30 2 * * *", tz, beforeGap),
      Date.parse("2025-03-10T06:30:00Z"),
    );

    // Every-minute cron jumps from 01:59 EST (06:59Z) straight to 03:00 EDT (07:00Z)
    assert.equal(
      nextRun("* * * * *", tz, beforeGap),
      Date.parse("2025-03-09T07:00:00Z"),
    );

    // latestBefore after the spring-forward gap returns previous day's 02:30 EST
    const afterGap = Date.parse("2025-03-09T07:30:00Z"); // 03:30 EDT
    assert.equal(
      latestBefore("30 2 * * *", tz, afterGap),
      Date.parse("2025-03-08T07:30:00Z"),
    );
  });

  it("triggers repeated fall-back DST local times once only (first occurrence)", () => {
    const ny = "America/New_York";
    // 2025-11-02 fall-back:
    // 05:00Z..05:59Z = 01:00..01:59 EDT (first occurrence)
    // 06:00Z..06:59Z = 01:00..01:59 EST (second occurrence - MUST NOT re-trigger)
    // 07:00Z         = 02:00 EST
    const first0130 = Date.parse("2025-11-02T05:30:00Z");
    const second0110 = Date.parse("2025-11-02T06:10:00Z");
    const second0140 = Date.parse("2025-11-02T06:40:00Z");

    // Before first 01:30 -> triggers at first 01:30 EDT (05:30Z)
    assert.equal(
      nextRun("30 1 * * *", ny, Date.parse("2025-11-02T05:00:00Z")),
      first0130,
    );

    // After first 01:30 -> skips second 01:30 EST (06:30Z) and goes to next day
    assert.equal(
      nextRun("30 1 * * *", ny, first0130),
      Date.parse("2025-11-03T06:30:00Z"),
    );

    // Even when starting inside the second 01:xx hour before 01:30 EST, must NOT fire at 06:30Z
    assert.equal(
      nextRun("30 1 * * *", ny, second0110),
      Date.parse("2025-11-03T06:30:00Z"),
    );

    // latestBefore after second 01:30 EST returns first 01:30 EDT (05:30Z)
    assert.equal(latestBefore("30 1 * * *", ny, second0140), first0130);

    // Tricky: at 01:40 EST (06:40Z, second occurrence), 01:45 EDT (05:45Z, first occurrence)
    // already happened 55 real minutes ago and must be returned by latestBefore!
    assert.equal(
      latestBefore("45 1 * * *", ny, second0140),
      Date.parse("2025-11-02T05:45:00Z"),
    );

    // Every-minute cron skips the entire repeated 01:00..01:59 EST hour
    assert.equal(
      nextRun("* * * * *", ny, Date.parse("2025-11-02T05:59:00Z")),
      Date.parse("2025-11-02T07:00:00Z"),
    );
    assert.equal(
      latestBefore("* * * * *", ny, second0140),
      Date.parse("2025-11-02T05:59:00Z"),
    );

    // Positive UTC offset fall-back: Europe/Berlin 2025-10-26 (02:00 CEST 00:00Z, 02:00 CET 01:00Z)
    const berlin = "Europe/Berlin";
    const berlinFirst = Date.parse("2025-10-26T00:30:00Z");
    assert.equal(
      nextRun("30 2 * * *", berlin, Date.parse("2025-10-26T00:00:00Z")),
      berlinFirst,
    );
    assert.equal(
      nextRun("30 2 * * *", berlin, berlinFirst),
      Date.parse("2025-10-27T01:30:00Z"),
    );

    // 30-minute DST fall-back: Australia/Lord_Howe 2025-04-06 (02:00 +11 -> 01:30 +10:30)
    const lordHowe = "Australia/Lord_Howe";
    const lhFirst = Date.parse("2025-04-05T14:45:00Z"); // 01:45 +11:00
    assert.equal(
      nextRun("45 1 * * *", lordHowe, Date.parse("2025-04-05T14:00:00Z")),
      lhFirst,
    );
    assert.equal(
      nextRun("45 1 * * *", lordHowe, lhFirst),
      Date.parse("2025-04-06T15:15:00Z"), // next day 01:45 +10:30
    );
  });

  it("computes Asia/Shanghai daily boundaries and single-shot sleep wakeup via latestBefore", () => {
    const sh = "Asia/Shanghai";
    // 2025-06-15 23:59:59.999 +08:00 === 2025-06-15T15:59:59.999Z
    const justBeforeMidnight = Date.parse("2025-06-15T15:59:59.999Z");
    assert.equal(
      dayStartMs(justBeforeMidnight, sh),
      Date.parse("2025-06-14T16:00:00.000Z"),
    );

    // 2025-06-16 00:00:00.000 +08:00 === 2025-06-15T16:00:00.000Z
    const exactMidnight = Date.parse("2025-06-15T16:00:00.000Z");
    assert.equal(
      dayStartMs(exactMidnight, sh),
      Date.parse("2025-06-15T16:00:00.000Z"),
    );

    // Midnight spring-forward DST (America/Sao_Paulo 2018-11-04 jumped 00:00 -> 01:00 -02:00)
    assert.equal(
      dayStartMs(Date.parse("2018-11-04T12:00:00Z"), "America/Sao_Paulo"),
      Date.parse("2018-11-04T03:00:00.000Z"),
    );

    // Sleep wakeup: slept for 10 hours on an hourly job -> only returns the latest missed trigger
    const wakeAt = Date.parse("2025-06-15T10:12:00Z"); // 18:12 +08:00
    assert.equal(
      latestBefore("0 * * * *", sh, wakeAt),
      Date.parse("2025-06-15T10:00:00Z"),
    );
  });
});

describe("kernel/due", () => {
  it("exports frozen lease and heartbeat constants", () => {
    assert.equal(MINUTE, 60_000);
    assert.equal(RUN_LEASE_MS, 5 * 60_000);
    assert.equal(HEARTBEAT_INTERVAL_MS, 60_000);
  });

  it("aggregates all five pending deadline kinds and respects effective pauses", () => {
    const view = createMemoryView();
    const nowMs = Date.parse("2025-06-15T10:00:00.000Z");

    // 1. schedules (active, indefinitely paused, timed-paused active, timed-paused expired)
    view.set("schedules", "daily-brief", {
      rule: "daily-brief",
      cron: "0 9 * * *",
      timezone: "Asia/Shanghai",
      next_at: "2025-06-16T01:00:00.000Z",
      last_run_at: null,
      skipped_at: null,
    });
    view.set("schedules", "indef-paused", {
      rule: "indef-paused",
      cron: "* * * * *",
      timezone: "UTC",
      next_at: "2025-06-15T10:01:00.000Z",
      last_run_at: null,
      skipped_at: null,
    });
    view.set("schedules", "timed-paused", {
      rule: "timed-paused",
      cron: "* * * * *",
      timezone: "UTC",
      next_at: "2025-06-15T10:01:00.000Z",
      last_run_at: null,
      skipped_at: null,
    });
    view.set("schedules", "expired-pause", {
      rule: "expired-pause",
      cron: "*/5 * * * *",
      timezone: "UTC",
      next_at: "2025-06-15T10:05:00.000Z",
      last_run_at: null,
      skipped_at: null,
    });

    view.set("pauses", "indef-paused", {
      rule: "indef-paused",
      reason: "manual",
      paused_at: "2025-06-15T09:00:00.000Z",
      until: null,
    });
    view.set("pauses", "timed-paused", {
      rule: "timed-paused",
      reason: "maintenance",
      paused_at: "2025-06-15T09:30:00.000Z",
      until: "2025-06-15T11:00:00.000Z",
    });
    view.set("pauses", "expired-pause", {
      rule: "expired-pause",
      reason: "short",
      paused_at: "2025-06-15T09:00:00.000Z",
      until: "2025-06-15T09:55:00.000Z",
    });

    // 2. timers (pending vs already fired)
    view.set("timers", "1", {
      id: 1,
      rule: "daily-brief",
      lane: "",
      key: "check-again",
      source: null,
      agent: null,
      session: null,
      about: "recheck",
      at: "2025-06-15T10:15:00.000Z",
      event_id: null,
      created_at: "2025-06-15T09:50:00.000Z",
    });
    view.set("timers", "2", {
      id: 2,
      rule: "daily-brief",
      lane: "",
      key: "already-fired",
      source: null,
      agent: null,
      session: null,
      about: "done",
      at: "2025-06-15T09:55:00.000Z",
      event_id: 99,
      created_at: "2025-06-15T09:40:00.000Z",
    });

    // 3. runs: queued retry (> nowMs vs <= nowMs), claimed with heartbeat vs claimed without heartbeat, unknown
    view.set("runs", "10", {
      id: 10,
      status: "queued",
      not_before: "2025-06-15T10:02:00.000Z",
    });
    view.set("runs", "11", {
      id: 11,
      status: "queued",
      not_before: "2025-06-15T10:00:00.000Z", // <= nowMs: ready immediately, no retry deadline
    });
    view.set("runs", "12", {
      id: 12,
      status: "claimed",
      claimed_at: "2025-06-15T09:56:00.000Z",
      heartbeat_at: "2025-06-15T09:59:00.000Z",
    });
    view.set("runs", "13", {
      id: 13,
      status: "claimed",
      claimed_at: "2025-06-15T09:57:00.000Z",
      heartbeat_at: null,
    });
    view.set("runs", "14", {
      id: 14,
      status: "unknown",
      claimed_at: "2025-06-15T09:40:00.000Z",
      heartbeat_at: null,
    });

    const got = deadlines(view, nowMs);

    assert.deepEqual(Object.keys(got).sort(), [
      "cron:daily-brief",
      "cron:expired-pause",
      "lease:12",
      "lease:13",
      "retry:10",
      "timer:1",
      "unpause:expired-pause",
      "unpause:timed-paused",
    ]);

    assert.deepEqual(got["cron:daily-brief"], {
      kind: "cron",
      target: "daily-brief",
      at: Date.parse("2025-06-16T01:00:00.000Z"),
      iso_at: iso(Date.parse("2025-06-16T01:00:00.000Z")),
    });
    assert.deepEqual(got["cron:expired-pause"], {
      kind: "cron",
      target: "expired-pause",
      at: Date.parse("2025-06-15T10:05:00.000Z"),
      iso_at: "2025-06-15T10:05:00.000Z",
    });
    assert.deepEqual(got["timer:1"], {
      kind: "timer",
      target: "1",
      at: Date.parse("2025-06-15T10:15:00.000Z"),
      iso_at: "2025-06-15T10:15:00.000Z",
    });
    assert.deepEqual(got["retry:10"], {
      kind: "retry",
      target: "10",
      at: Date.parse("2025-06-15T10:02:00.000Z"),
      iso_at: "2025-06-15T10:02:00.000Z",
    });
    assert.deepEqual(got["lease:12"], {
      kind: "lease",
      target: "12",
      at: Date.parse("2025-06-15T09:59:00.000Z") + RUN_LEASE_MS,
      iso_at: "2025-06-15T10:04:00.000Z",
    });
    assert.deepEqual(got["lease:13"], {
      kind: "lease",
      target: "13",
      at: Date.parse("2025-06-15T09:57:00.000Z") + RUN_LEASE_MS,
      iso_at: "2025-06-15T10:02:00.000Z",
    });
    assert.deepEqual(got["unpause:timed-paused"], {
      kind: "unpause",
      target: "timed-paused",
      at: Date.parse("2025-06-15T11:00:00.000Z"),
      iso_at: "2025-06-15T11:00:00.000Z",
    });
    assert.deepEqual(got["unpause:expired-pause"], {
      kind: "unpause",
      target: "expired-pause",
      at: Date.parse("2025-06-15T09:55:00.000Z"),
      iso_at: "2025-06-15T09:55:00.000Z",
    });
  });

  it("computes earliestDueMs from due table rows or returns null when empty", () => {
    const view = createMemoryView();
    assert.equal(earliestDueMs(view), null);

    view.set("due", "cron:a", {
      kind: "cron",
      target: "a",
      at: 2000,
      iso_at: iso(2000),
    });
    view.set("due", "lease:3", {
      kind: "lease",
      target: "3",
      at: 1500,
      iso_at: iso(1500),
    });
    view.set("due", "timer:1", {
      kind: "timer",
      target: "1",
      at: 3000,
      iso_at: iso(3000),
    });

    assert.equal(earliestDueMs(view), 1500);
  });
});
