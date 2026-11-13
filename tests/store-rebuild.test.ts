/**
 * Store & State-Snapshot Behavioral Tests (Layer 2).
 *
 * Prevents:
 * 1. Partial writes or dirty in-memory state when a SQLite commit fails mid-transaction.
 * 2. Data loss, field drift, or auto-increment high-water mark (`view.next`) regression
 *    after `projections` deletion or `SCHEMA_FINGERPRINT` version upgrade.
 * 3. Weak/short HMAC master keys or non-constant-time token verification.
 * 4. Incorrect `spending`, `cards` priority ordering, `lines` status, or `runs` pagination
 *    in `buildStateSnapshot`.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { ConflictError, InputError } from "../kernel/errors.ts";
import { type Fact, type Table } from "../kernel/evolve.ts";
import {
  SCHEMA_FINGERPRINT,
  createTokenSigner,
  openStore,
  safeTokenEquals,
  sha256Hex,
} from "../kernel/store.ts";
import type { RulesConfig } from "../protocol/types.ts";
import { buildStateSnapshot } from "../sidecars/hub/state-queries.ts";

const ALL_TABLES: readonly Table[] = [
  "config",
  "events",
  "runs",
  "run_events",
  "cards",
  "timers",
  "schedules",
  "pauses",
  "skipped",
  "seen",
  "due",
];

function withTempDb(fn: (dbPath: string, tmpDir: string) => void): void {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "autoloop-store-test-"));
  const dbPath = path.join(tmpDir, "hub.db");
  try {
    fn(dbPath, tmpDir);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function makeSampleConfig(): RulesConfig {
  return {
    timezone: "Asia/Shanghai",
    askFirst: ["rm -rf"],
    sources: {
      github: { name: "GitHub" },
    },
    agents: {
      worker: {
        name: "Worker",
        runner: "agy-print",
        model: "gemini-4-hydrogen-high",
        access: "edit",
      },
    },
    rules: [
      {
        name: "triage",
        when: { source: "github", types: ["issue.opened"] },
        to: "worker",
        cwd: "/tmp/repo",
        group: "triage-grp",
      },
      {
        name: "morning",
        when: { cron: "0 9 * * *" },
        to: "worker",
        cwd: "/tmp/repo",
      },
    ],
  };
}

function buildRichFacts(baseMs: number): Fact[] {
  const cfg = makeSampleConfig();
  return [
    {
      version: 1,
      seq: 1,
      at: baseMs,
      type: "rules.configured",
      changes: [
        {
          table: "config",
          key: "rules",
          row: {
            id: "rules",
            version: 1,
            value: cfg,
            updated_at: new Date(baseMs).toISOString(),
          },
        },
        {
          table: "schedules",
          key: "morning",
          row: {
            rule: "morning",
            cron: "0 9 * * *",
            timezone: "Asia/Shanghai",
            next_at: new Date(baseMs + 3_600_000).toISOString(),
            last_run_at: null,
            skipped_at: null,
          },
        },
      ],
    },
    {
      version: 1,
      seq: 2,
      at: baseMs + 1000,
      type: "event.ingested",
      changes: [
        {
          table: "events",
          key: "1",
          row: {
            id: 1,
            source: "github",
            key: "gh-101",
            type: "issue.opened",
            subject: "issue#101",
            summary: "Fix crash",
            detail: "Stack trace...",
            link: "https://example.com/issues/101",
            hops: 0,
            routed: ["triage"],
            paused: [],
            received_at: new Date(baseMs + 1000).toISOString(),
          },
        },
        {
          table: "runs",
          key: "1",
          row: {
            id: 1,
            rule: "triage",
            rules_version: 1,
            agent: "worker",
            grp: "triage-grp",
            lane: "",
            status: "done",
            attempts: 1,
            claim: "c-1",
            token: "tok-1",
            last_result: null,
            last_response: null,
            cancel_at: null,
            resume: null,
            session: "sess-1",
            summary: "Fixed issue 101",
            error: null,
            usage: { input: 1000, output: 200, cached: 500, cost: 0.05 },
            manual: false,
            created_at: new Date(baseMs + 1000).toISOString(),
            not_before: new Date(baseMs + 1000).toISOString(),
            claimed_at: new Date(baseMs + 2000).toISOString(),
            started_at: new Date(baseMs + 2500).toISOString(),
            heartbeat_at: new Date(baseMs + 3000).toISOString(),
            ended_at: new Date(baseMs + 5000).toISOString(),
          },
        },
        {
          table: "run_events",
          key: "1:1",
          row: { run_id: 1, event_id: 1 },
        },
      ],
    },
    {
      version: 1,
      seq: 3,
      at: baseMs + 6000,
      type: "timer.created",
      changes: [
        {
          table: "timers",
          key: "7",
          row: {
            id: 7,
            rule: "triage",
            lane: "",
            key: "follow-up",
            source: "github",
            agent: "worker",
            session: "sess-1",
            about: "recheck PR",
            at: new Date(baseMs + 60_000).toISOString(),
            event_id: null,
            created_at: new Date(baseMs + 6000).toISOString(),
          },
        },
        {
          table: "due",
          key: "timer:7",
          row: {
            kind: "timer",
            target: "7",
            at: baseMs + 60_000,
            iso_at: new Date(baseMs + 60_000).toISOString(),
          },
        },
      ],
    },
    {
      version: 1,
      seq: 4,
      at: baseMs + 61_000,
      type: "timer.deleted_and_card_opened",
      changes: [
        // Delete timer id=7 so high-water mark next.timers=7 must still survive rebuild!
        { table: "timers", key: "7", row: null },
        { table: "due", key: "timer:7", row: null },
        {
          table: "cards",
          key: "3",
          row: {
            id: 3,
            key: "confirm-deploy",
            kind: "ask",
            status: "open",
            rule: "triage",
            lane: "",
            grp: "triage-grp",
            source: "github",
            agent: "worker",
            session: "sess-1",
            run_id: 1,
            title: "Deploy fix?",
            text: "Ready to ship",
            options: ["Ship", "Hold"],
            recommend: 0,
            about: "deploy",
            fyi: false,
            choice: null,
            chosen: null,
            answer_text: null,
            resolved_reason: null,
            answer_event: null,
            version: 1,
            created_at: new Date(baseMs + 61_000).toISOString(),
            decided_at: null,
            closed_at: null,
          },
        },
        {
          table: "pauses",
          key: "morning",
          row: {
            rule: "morning",
            reason: "maintenance",
            paused_at: new Date(baseMs + 61_000).toISOString(),
            until: new Date(baseMs + 3_600_000).toISOString(),
          },
        },
        {
          table: "skipped",
          key: "morning:1",
          row: {
            id: 1,
            rule: "morning",
            event_id: 1,
            source: "github",
            source_name: "GitHub",
            event_key: "gh-101",
            type: "issue.opened",
            subject: "issue#101",
            summary: "Fix crash",
            link: "https://example.com/issues/101",
            received_at: new Date(baseMs + 61_000).toISOString(),
            replayed_at: null,
            replay_run_id: null,
          },
        },
        {
          table: "seen",
          key: "source:github",
          row: {
            kind: "source",
            name: "github",
            seen_at: new Date(baseMs + 61_000).toISOString(),
          },
        },
      ],
    },
  ];
}

describe("kernel/store.ts & sidecars/hub/state-queries.ts", () => {
  it("validates masterKeyHex, signs deterministically, and compares tokens in constant time", () => {
    assert.throws(() => createTokenSigner(""), InputError);
    assert.throws(() => createTokenSigner("deadbeef"), InputError);
    assert.throws(() => createTokenSigner("zz".repeat(32)), InputError);
    assert.throws(() => createTokenSigner("aa".repeat(31) + "a"), InputError);

    const key = "0123456789abcdef".repeat(4);
    const sign = createTokenSigner(key);
    const tok1 = sign(42, 1, "claim-abc");
    const tok2 = sign(42, 1, "claim-abc");
    const tokDiffAttempt = sign(42, 2, "claim-abc");
    const tokDiffClaim = sign(42, 1, "claim-xyz");

    assert.equal(tok1.length, 64);
    assert.equal(tok1, tok2);
    assert.notEqual(tok1, tokDiffAttempt);
    assert.notEqual(tok1, tokDiffClaim);
    assert.equal(safeTokenEquals(tok1, tok2), true);
    assert.equal(safeTokenEquals(tok1, tokDiffAttempt), false);
    assert.equal(safeTokenEquals(tok1, "short"), false);
    assert.equal(sha256Hex("hello").length, 64);
    assert.equal(sha256Hex("hello"), sha256Hex("hello"));
  });

  it("commits facts in a single transaction and rolls back both SQLite and memory view on mid-tx error", () => {
    withTempDb((dbPath) => {
      const store = openStore(dbPath);
      const baseMs = Date.UTC(2026, 10, 13, 12, 0, 0);
      const [f1, f2] = buildRichFacts(baseMs);

      store.commit([]);
      assert.equal(store.view.seq, 0);

      store.commit([f1!]);
      assert.equal(store.view.seq, 1);

      // Duplicate / non-increasing seq rejected before modifying state
      assert.throws(() => store.commit([f1!]), ConflictError);
      assert.equal(store.view.seq, 1);

      // Inject a SQLite failure mid-transaction on projections insert
      store.close();
      const rawDb = new DatabaseSync(dbPath);
      rawDb.exec(`
        CREATE TRIGGER inject_boom
        BEFORE INSERT ON projections
        WHEN NEW.key = 'boom'
        BEGIN
          SELECT RAISE(ABORT, 'injected mid-tx failure');
        END;
      `);
      rawDb.close();

      const reopened = openStore(dbPath);
      const badBatch: Fact[] = [
        f2!,
        {
          version: 1,
          seq: 3,
          at: baseMs + 2000,
          type: "boom.event",
          changes: [
            { table: "seen", key: "boom", row: { kind: "k", name: "n" } },
          ],
        },
      ];

      assert.throws(() => reopened.commit(badBatch), /injected mid-tx failure/);
      // Memory view must remain untouched
      assert.equal(reopened.view.seq, 1);
      assert.equal(reopened.view.get("events", "1"), undefined);
      assert.equal(reopened.view.get("runs", "1"), undefined);
      assert.equal(reopened.view.get("seen", "boom"), undefined);
      // Facts table must remain untouched
      assert.equal(reopened.readFacts().length, 1);
      reopened.close();
    });
  });

  it("rebuilds projections losslessly from facts when projections are emptied or fingerprint changes, preserving high-water marks", () => {
    withTempDb((dbPath) => {
      const baseMs = Date.UTC(2026, 10, 13, 12, 0, 0);
      const facts = buildRichFacts(baseMs);

      const store1 = openStore(dbPath);
      assert.equal(store1.fingerprint, SCHEMA_FINGERPRINT);
      store1.commit(facts);

      assert.equal(store1.view.seq, 4);
      assert.equal(store1.view.next.timers, 7);
      assert.equal(store1.view.get("timers", "7"), undefined);

      const snapshotBefore: Record<string, unknown[]> = {};
      for (const t of ALL_TABLES) {
        snapshotBefore[t] = store1.view.all(t);
      }
      const nextBefore = { ...store1.view.next };
      store1.close();

      // 1) Normal fast-hydrate reopen preserves deleted timer high-water mark
      const fastReopened = openStore(dbPath);
      assert.equal(fastReopened.view.seq, 4);
      assert.deepEqual(fastReopened.view.next, nextBefore);
      for (const t of ALL_TABLES) {
        assert.deepEqual(fastReopened.view.all(t), snapshotBefore[t]);
      }
      fastReopened.close();

      // 2) Delete all projections externally -> auto-rebuild from facts
      const rawDb = new DatabaseSync(dbPath);
      rawDb.exec("DELETE FROM projections;");
      rawDb.close();

      const rebuiltFromEmpty = openStore(dbPath);
      assert.equal(rebuiltFromEmpty.view.seq, 4);
      assert.deepEqual(rebuiltFromEmpty.view.next, nextBefore);
      for (const t of ALL_TABLES) {
        assert.deepEqual(rebuiltFromEmpty.view.all(t), snapshotBefore[t]);
      }
      rebuiltFromEmpty.close();

      // 3) Fingerprint upgrade -> auto-rebuild from facts
      const upgraded = openStore(dbPath, { fingerprint: "autoloop-store-v2" });
      assert.equal(upgraded.fingerprint, "autoloop-store-v2");
      assert.equal(upgraded.view.seq, 4);
      assert.deepEqual(upgraded.view.next, nextBefore);
      for (const t of ALL_TABLES) {
        assert.deepEqual(upgraded.view.all(t), snapshotBefore[t]);
      }

      // Verify SQL read views and readFacts pagination
      const sqlRuns = upgraded.queryAll<{
        id: number;
        status: string;
        usage_input: number;
      }>("SELECT id, status, usage_input FROM v_runs");
      assert.deepEqual(sqlRuns, [{ id: 1, status: "done", usage_input: 1000 }]);

      const sqlCards = upgraded.queryAll<{ id: number; status: string }>(
        "SELECT id, status FROM v_cards",
      );
      assert.deepEqual(sqlCards, [{ id: 3, status: "open" }]);

      assert.equal(
        upgraded
          .readFacts(1, 2)
          .map((f) => f.seq)
          .join(","),
        "2,3",
      );
      upgraded.close();
    });
  });

  it("aggregates StateSnapshot spending, open-first cards, pipeline lines, and paginated runs", () => {
    withTempDb((dbPath) => {
      const store = openStore(dbPath);
      // 2026-11-13 10:00:00 Asia/Shanghai (UTC+8 => 02:00:00Z)
      const nowMs = Date.UTC(2026, 10, 13, 2, 0, 0);
      const threeDaysAgoMs = nowMs - 3 * 86_400_000;
      const tenDaysAgoMs = nowMs - 10 * 86_400_000;
      const cfg = makeSampleConfig();

      const facts: Fact[] = [
        {
          version: 1,
          seq: 1,
          at: nowMs,
          type: "init",
          changes: [
            {
              table: "config",
              key: "rules",
              row: {
                id: "rules",
                version: 1,
                value: cfg,
                updated_at: new Date(nowMs).toISOString(),
              },
            },
            {
              table: "schedules",
              key: "morning",
              row: {
                rule: "morning",
                cron: "0 9 * * *",
                timezone: "Asia/Shanghai",
                next_at: new Date(nowMs + 82_800_000).toISOString(),
                last_run_at: new Date(threeDaysAgoMs).toISOString(),
                skipped_at: null,
              },
            },
            {
              table: "pauses",
              key: "morning",
              row: {
                rule: "morning",
                reason: "quiet hours",
                paused_at: new Date(nowMs - 1000).toISOString(),
                until: new Date(nowMs + 600_000).toISOString(),
              },
            },
            // Run 1: 10 days ago (outside last7Days)
            {
              table: "runs",
              key: "1",
              row: {
                id: 1,
                rule: "triage",
                rules_version: 1,
                agent: "worker",
                grp: "triage-grp",
                lane: "",
                status: "done",
                attempts: 1,
                claim: "c1",
                token: "t1",
                last_result: null,
                last_response: null,
                cancel_at: null,
                resume: null,
                session: "s1",
                summary: "old",
                error: null,
                usage: { input: 9999, cost: 9.99 },
                manual: false,
                created_at: new Date(tenDaysAgoMs).toISOString(),
                not_before: new Date(tenDaysAgoMs).toISOString(),
                claimed_at: new Date(tenDaysAgoMs).toISOString(),
                started_at: new Date(tenDaysAgoMs).toISOString(),
                heartbeat_at: new Date(tenDaysAgoMs).toISOString(),
                ended_at: new Date(tenDaysAgoMs).toISOString(),
              },
            },
            // Run 2: 3 days ago (inside last7Days, outside today), partial usage
            {
              table: "runs",
              key: "2",
              row: {
                id: 2,
                rule: "triage",
                rules_version: 1,
                agent: "worker",
                grp: "triage-grp",
                lane: "",
                status: "done",
                attempts: 1,
                claim: "c2",
                token: "t2",
                last_result: null,
                last_response: null,
                cancel_at: null,
                resume: null,
                session: "s2",
                summary: "3d ago",
                error: null,
                usage: { input: 300, cost: 0.02 },
                manual: false,
                created_at: new Date(threeDaysAgoMs).toISOString(),
                not_before: new Date(threeDaysAgoMs).toISOString(),
                claimed_at: new Date(threeDaysAgoMs).toISOString(),
                started_at: new Date(threeDaysAgoMs).toISOString(),
                heartbeat_at: new Date(threeDaysAgoMs).toISOString(),
                ended_at: new Date(threeDaysAgoMs).toISOString(),
              },
            },
            // Run 3: today claimed & running
            {
              table: "runs",
              key: "3",
              row: {
                id: 3,
                rule: "triage",
                rules_version: 1,
                agent: "worker",
                grp: "triage-grp",
                lane: "",
                status: "claimed",
                attempts: 1,
                claim: "c3",
                token: "t3",
                last_result: null,
                last_response: null,
                cancel_at: null,
                resume: null,
                session: "s3",
                summary: null,
                error: null,
                usage: { input: 100, output: 50, cached: 25, cost: 0.01 },
                manual: false,
                created_at: new Date(nowMs - 5000).toISOString(),
                not_before: new Date(nowMs - 5000).toISOString(),
                claimed_at: new Date(nowMs - 4000).toISOString(),
                started_at: new Date(nowMs - 3000).toISOString(),
                heartbeat_at: new Date(nowMs - 1000).toISOString(),
                ended_at: null,
              },
            },
            // Run 4: today queued (must NOT be counted in spending)
            {
              table: "runs",
              key: "4",
              row: {
                id: 4,
                rule: "triage",
                rules_version: 1,
                agent: "worker",
                grp: "triage-grp",
                lane: "lane-2",
                status: "queued",
                attempts: 0,
                claim: null,
                token: null,
                last_result: null,
                last_response: null,
                cancel_at: null,
                resume: null,
                session: null,
                summary: null,
                error: null,
                usage: null,
                manual: false,
                created_at: new Date(nowMs - 1000).toISOString(),
                not_before: new Date(nowMs - 1000).toISOString(),
                claimed_at: null,
                started_at: null,
                heartbeat_at: null,
                ended_at: null,
              },
            },
            // Cards: decided card id=10, open card id=5, closed card id=2
            {
              table: "cards",
              key: "10",
              row: {
                id: 10,
                key: "k10",
                kind: "ask",
                status: "decided",
                rule: "triage",
                lane: "",
                grp: "triage-grp",
                source: "github",
                agent: "worker",
                session: "s2",
                run_id: 2,
                title: "Decided Card",
                text: "text",
                options: ["A", "B"],
                about: "about",
                fyi: false,
                choice: 0,
                chosen: "A",
                answer_text: null,
                resolved_reason: null,
                answer_event: 99,
                version: 2,
                created_at: new Date(nowMs - 2000).toISOString(),
                decided_at: new Date(nowMs - 1000).toISOString(),
                closed_at: null,
              },
            },
            {
              table: "cards",
              key: "5",
              row: {
                id: 5,
                key: "k5",
                kind: "ask",
                status: "open",
                rule: "triage",
                lane: "",
                grp: "triage-grp",
                source: "github",
                agent: "worker",
                session: "s3",
                run_id: 3,
                title: "Open Card",
                text: "text",
                options: ["X", "Y"],
                about: "about",
                fyi: false,
                choice: null,
                chosen: null,
                answer_text: null,
                resolved_reason: null,
                answer_event: null,
                version: 1,
                created_at: new Date(nowMs - 5000).toISOString(),
                decided_at: null,
                closed_at: null,
              },
            },
            {
              table: "cards",
              key: "2",
              row: {
                id: 2,
                key: "k2",
                kind: "notice",
                status: "closed",
                rule: "triage",
                lane: "",
                grp: "triage-grp",
                source: "github",
                agent: "worker",
                session: "s1",
                run_id: 1,
                title: "Closed Notice",
                text: "done",
                options: [],
                about: "",
                fyi: true,
                choice: null,
                chosen: null,
                answer_text: null,
                resolved_reason: null,
                answer_event: null,
                version: 1,
                created_at: new Date(threeDaysAgoMs).toISOString(),
                decided_at: null,
                closed_at: new Date(threeDaysAgoMs).toISOString(),
              },
            },
            // Skipped events: 25 entries, one already replayed
            ...Array.from({ length: 25 }, (_, i) => ({
              table: "skipped" as const,
              key: `morning:${i + 1}`,
              row: {
                id: i + 1,
                rule: "morning",
                event_id: i + 1,
                source: "github",
                source_name: "GitHub",
                event_key: `gh-${i + 1}`,
                type: "issue.opened",
                subject: `issue#${i + 1}`,
                summary: `s-${i + 1}`,
                link: "",
                received_at: new Date(nowMs - (25 - i) * 1000).toISOString(),
                replayed_at: i === 0 ? new Date(nowMs).toISOString() : null,
                replay_run_id: i === 0 ? 3 : null,
              },
            })),
          ],
        },
      ];

      store.commit(facts);

      const page1 = buildStateSnapshot(store, nowMs, { limit: 2 });
      assert.equal(
        page1.etag,
        buildStateSnapshot(store, nowMs, { limit: 2 }).etag,
      );
      assert.notEqual(
        page1.etag,
        buildStateSnapshot(store, nowMs + 60_000, { limit: 2 }).etag,
      );

      // Spending checks
      assert.deepEqual(page1.spending.today, {
        runs: 1,
        input: 100,
        output: 50,
        cached: 25,
        cost: 0.01,
      });
      assert.equal(page1.spending.last7Days.runs, 2);
      assert.equal(page1.spending.last7Days.input, 400);
      assert.equal(page1.spending.last7Days.output, 50);
      assert.equal(page1.spending.last7Days.cached, 25);
      assert.ok(Math.abs(page1.spending.last7Days.cost - 0.03) < 1e-9);

      // Open card must be pinned above decided card
      assert.deepEqual(
        page1.cards.map((c) => [c.card, c.status]),
        [
          [5, "open"],
          [10, "decided"],
        ],
      );
      assert.deepEqual(
        page1.recentCards.map((c) => c.card),
        [2],
      );

      // Pipeline lines
      assert.equal(page1.lines.length, 2);
      const triageLine = page1.lines.find((l) => l.rule === "triage")!;
      assert.equal(triageLine.status, "running");
      assert.equal(triageLine.activeRuns, 1);
      assert.equal(triageLine.queuedRuns, 1);
      assert.equal(triageLine.doneToday, 0);

      const morningLine = page1.lines.find((l) => l.rule === "morning")!;
      assert.equal(morningLine.status, "paused");
      assert.equal(morningLine.pauseReason, "quiet hours");
      assert.equal(morningLine.skippedCount, 24);

      // Runs pagination
      assert.deepEqual(
        page1.runs.map((r) => r.run),
        [4, 3],
      );
      assert.equal(page1.hasMoreRuns, true);

      const page2 = buildStateSnapshot(store, nowMs, {
        beforeRun: 3,
        limit: 2,
      });
      assert.deepEqual(
        page2.runs.map((r) => r.run),
        [2, 1],
      );
      assert.equal(page2.hasMoreRuns, false);

      // Skipped capped at latest 20
      assert.equal(page1.skipped.length, 20);
      assert.equal(page1.skipped[0]?.seq, 25);
      assert.equal(page1.skipped[19]?.seq, 6);

      store.close();
    });
  });
});
