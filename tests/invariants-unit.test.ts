/**
 * Global State-Machine Invariants Unit & Fault-Injection Tests (Layer 2 / WP-19).
 *
 * Prevents:
 * 1. `INV-01`..`INV-12` false positives during legitimate full-lifecycle trajectories
 *    (event ingest, dedup, lane merge, multi-level concurrency, ask/resolve, timers,
 *    lease timeout, stop/cancel, hops circuit breaker, pause/replay, rule hot-reload,
 *    and SQLite fingerprint rebuild).
 * 2. Silent acceptance of corrupted SQLite `facts`/`projections`, concurrency cap
 *    overflows, dual-claimed or dual-queued lanes, active/cancelled session leaks,
 *    hops > 8 dispatches, duplicate `(source, key)` or missing `seen`, illegal card
 *    transitions (`fyi` open, answer+resolve overlap, duplicate open cards),
 *    `cancel_at != null` backsliding to `queued`, repeated `skipped` replays, or
 *    stale/malformed `due` deadline indexes.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import {
  decide,
  MAX_HOPS,
  type DecideEnv,
  type KernelInput,
} from "../kernel/decide.ts";
import { RUN_LEASE_MS } from "../kernel/due.ts";
import { InputError } from "../kernel/errors.ts";
import {
  applyFact,
  createMemoryView,
  iso,
  rows,
  type Fact,
  type Row,
  type View,
} from "../kernel/evolve.ts";
import {
  createTokenSigner,
  openStore,
  safeTokenEquals,
  type Store,
} from "../kernel/store.ts";
import type { RulesConfig } from "../protocol/types.ts";
import {
  assertInvariants,
  InvariantViolationError,
  type InvariantCode,
} from "../sim/invariants.ts";

const MASTER_KEY = "0123456789abcdef".repeat(4);
const TEST_ENV: DecideEnv = {
  signToken: createTokenSigner(MASTER_KEY),
  safeTokenEquals,
};
const T0 = Date.parse("2026-11-10T10:00:00.000Z");

function withTempDb(fn: (dbPath: string, tmpDir: string) => void): void {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "autoloop-inv-test-"));
  const dbPath = path.join(tmpDir, "hub.db");
  try {
    fn(dbPath, tmpDir);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function makeConfig(overrides: Partial<RulesConfig> = {}): RulesConfig {
  return {
    timezone: "UTC",
    askFirst: ["rm -rf"],
    sources: {
      github: { name: "GitHub" },
      loop: { name: "Loop" },
      ci: { name: "CI" },
    },
    agents: {
      worker: {
        name: "Worker",
        runner: "agy-print",
        model: "m-1",
        access: "edit",
        timeoutMinutes: 30,
        maxActive: 3,
      },
      solo: {
        name: "Solo",
        runner: "command",
        command: ["node", "-e", "process.exit(0)"],
        access: "read",
        timeoutMinutes: 10,
        maxActive: 1,
      },
    },
    rules: [
      {
        name: "triage",
        when: { source: "github", types: ["issue.*", "pr.*"] },
        to: "worker",
        cwd: "/tmp/repo",
        prompt: "Triage work",
        group: "eng",
        parallel: 2,
        maxActive: 2,
        resume: true,
        emits: { source: "loop", types: ["loop.*"] },
      },
      {
        name: "stepper",
        when: { source: "loop", types: ["loop.*"] },
        to: "worker",
        cwd: "/tmp/repo",
        prompt: "Advance chain",
        group: "chain",
        parallel: 2,
        emits: { source: "loop", types: ["loop.*"] },
      },
      {
        name: "nightly",
        when: { cron: "0 * * * *" },
        to: "solo",
        cwd: "/tmp/repo",
        prompt: "Hourly check",
      },
      {
        name: "ci-a",
        when: { source: "ci", types: ["build.a"] },
        to: "solo",
        cwd: "/tmp/repo",
        prompt: "CI A",
        group: "ci-grp",
        parallel: 2,
      },
      {
        name: "ci-b",
        when: { source: "ci", types: ["build.b"] },
        to: "solo",
        cwd: "/tmp/repo",
        prompt: "CI B",
        group: "ci-grp",
        parallel: 2,
      },
    ],
    ...overrides,
  };
}

function stepStore<T = any>(
  store: Store,
  input: KernelInput,
  nowMs: number,
  workerCapacity = 4,
): T {
  const res = decide<T>(store.view, input, nowMs, TEST_ENV);
  store.commit(res.facts);
  // If `res.facts` is empty (no-op/duplicate), `due` reflects the last mutating decision,
  // whereas when facts were emitted, `nowMs` is the exact last decision timestamp.
  if (res.facts.length > 0) {
    assertInvariants(store, { nowMs, workerCapacity });
    assertInvariants(store.view, { nowMs, workerCapacity });
  } else {
    assertInvariants(store, { workerCapacity });
    assertInvariants(store.view, { workerCapacity });
  }
  return res.value;
}

function stepView<T = any>(
  view: View,
  input: KernelInput,
  nowMs: number,
  workerCapacity = 4,
): T {
  const res = decide<T>(view, input, nowMs, TEST_ENV);
  for (const fact of res.facts) {
    applyFact(view, fact);
  }
  if (res.facts.length > 0) {
    assertInvariants(view, { nowMs, workerCapacity });
  } else {
    assertInvariants(view, { workerCapacity });
  }
  return res.value;
}

function assertThrowsInvariant(
  fn: () => void,
  expectedCode: InvariantCode,
  label: string,
): InvariantViolationError {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  assert.ok(
    caught instanceof InvariantViolationError,
    `${label}: expected InvariantViolationError (${expectedCode}), got ${String(caught)}`,
  );
  assert.equal(
    caught.code,
    expectedCode,
    `${label}: expected code ${expectedCode}, got ${caught.code}: ${caught.message}`,
  );
  assert.ok(
    caught.message.includes(expectedCode),
    `${label}: error message should include ${expectedCode}`,
  );
  return caught;
}

describe("WP-19 sim/invariants.ts", () => {
  it("passes all 12 invariants across a complete Store + decide lifecycle trajectory", () => {
    withTempDb((dbPath) => {
      const store = openStore(dbPath);
      let now = T0;

      // Empty store
      assertInvariants(store, { nowMs: now, workerCapacity: 4 });
      assertInvariants(store.view, { nowMs: now, workerCapacity: 4 });

      // Configure rules
      stepStore(store, { type: "configureRules", config: makeConfig() }, now);

      // Ingest events + duplicate dedup + same-lane queued merge
      now += 1_000;
      const ev1 = stepStore(
        store,
        {
          type: "ingestEvent",
          source: "github",
          event: { id: "iss-1", type: "issue.opened", subject: "lane-A" },
        },
        now,
      );
      assert.equal(ev1.duplicate, false);

      // Duplicate must not create new facts or break invariants
      const dup = stepStore(
        store,
        {
          type: "ingestEvent",
          source: "github",
          event: { id: "iss-1", type: "issue.opened", subject: "lane-A" },
        },
        now + 500,
      );
      assert.equal(dup.duplicate, true);

      // Ingest second lane + another event merging into queued lane-A
      now += 1_000;
      stepStore(
        store,
        {
          type: "ingestEvent",
          source: "github",
          event: { id: "iss-2", type: "issue.opened", subject: "lane-A" },
        },
        now,
      );
      stepStore(
        store,
        {
          type: "ingestEvent",
          source: "github",
          event: { id: "pr-1", type: "pr.opened", subject: "lane-B" },
        },
        now,
      );

      // Claim both lanes
      now += 1_000;
      const claim1 = stepStore<{ jobs: Array<{ run: number; token: string }> }>(
        store,
        { type: "claimWork", claimId: "claim-1", capacity: 4 },
        now,
      );
      assert.equal(claim1.jobs.length, 2);
      const jobA = claim1.jobs[0]!;
      const jobB = claim1.jobs[1]!;

      // markStarted on both with distinct sessions + heartbeat
      now += 1_000;
      stepStore(
        store,
        {
          type: "markStarted",
          run: jobA.run,
          token: jobA.token,
          session: "sess-a",
        },
        now,
      );
      stepStore(
        store,
        {
          type: "markStarted",
          run: jobB.run,
          token: jobB.token,
          session: "sess-b",
        },
        now,
      );
      stepStore(
        store,
        {
          type: "claimWork",
          claimId: "claim-hb",
          capacity: 4,
          running: [jobA.run, jobB.run],
        },
        now + 100,
      );

      // While lane-A is claimed, ingest a new event on lane-A (queued), then fail jobA -> merges queued run
      now += 500;
      stepStore(
        store,
        {
          type: "ingestEvent",
          source: "github",
          event: { id: "iss-3", type: "issue.edited", subject: "lane-A" },
        },
        now,
      );
      const retrySub = stepStore<{ requeued: boolean; notBefore: string }>(
        store,
        {
          type: "submitResult",
          run: jobA.run,
          token: jobA.token,
          result: { outcome: "failed", error: "transient network error" },
        },
        now,
      );
      assert.equal(retrySub.requeued, true);

      // Advance past retry backoff and claim retried jobA
      now = Date.parse(retrySub.notBefore) + 100;
      const claimRetry = stepStore<{
        jobs: Array<{ run: number; token: string; session: string | null }>;
      }>(
        store,
        { type: "claimWork", claimId: "claim-retry", capacity: 4 },
        now,
      );
      assert.equal(claimRetry.jobs.length, 1);
      assert.equal(claimRetry.jobs[0]!.session, "sess-a");

      // Submit done with ask + fyi notice + open notice + later timer + derived event
      now += 1_000;
      const timerAt = now + 60_000;
      const doneSub = stepStore(
        store,
        {
          type: "submitResult",
          run: claimRetry.jobs[0]!.run,
          token: claimRetry.jobs[0]!.token,
          result: {
            outcome: "done",
            session: "sess-a",
            ask: [
              {
                key: "approve-ship",
                title: "Ship change?",
                text: "Please choose",
                options: ["Ship", "Hold"],
                recommend: 0,
                about: "release gate",
              },
            ],
            notice: [
              { key: "fyi-1", title: "FYI", text: "Started build", fyi: true },
              {
                key: "note-open",
                title: "Check logs",
                text: "Pending check",
                fyi: false,
              },
            ],
            later: [
              {
                key: "recheck",
                at: iso(timerAt),
                about: "Follow up later",
              },
            ],
            events: [
              {
                id: "hop-1",
                type: "loop.step",
                subject: "chain-1",
              },
            ],
          },
        },
        now,
      );
      const askCardId = doneSub.cardsCreated[0].card;
      const openNoticeId = doneSub.cardsCreated[2].card;

      // Answer ask card, claim wakeup run, submit done + resolve openNoticeId
      now += 1_000;
      stepStore(store, { type: "answerCard", card: askCardId, choice: 0 }, now);
      const claimAns = stepStore<{
        jobs: Array<{ run: number; token: string }>;
      }>(store, { type: "claimWork", claimId: "claim-ans", capacity: 4 }, now);
      const ansJob = claimAns.jobs.find((j) => {
        const r = store.view.get("runs", String(j.run));
        return r?.rule === "triage" && r?.lane === "lane-A";
      })!;
      assert.ok(ansJob);
      stepStore(
        store,
        {
          type: "submitResult",
          run: ansJob.run,
          token: ansJob.token,
          result: {
            outcome: "done",
            resolve: [{ card: openNoticeId, reason: "Verified" }],
          },
        },
        now + 500,
      );

      // Tick past RUN_LEASE_MS + timerAt: jobB transitions to `unknown`, timer fires, cron fires
      now = Math.max(timerAt + 1_000, now + RUN_LEASE_MS + 5_000);
      const tk = stepStore(store, { type: "tick" }, now);
      assert.ok(tk.expiredRuns.includes(jobB.run));
      assert.equal(tk.timersFired.length, 1);

      // Late submitResult for `unknown` jobB succeeds cleanly
      now += 500;
      stepStore(
        store,
        {
          type: "submitResult",
          run: jobB.run,
          token: jobB.token,
          result: { outcome: "done", summary: "late completion" },
        },
        now,
      );

      // Stop a claimed run -> cancel_at set -> failed outcome locks to cancelled -> next run doesn't inherit session
      now += 1_000;
      stepStore(
        store,
        {
          type: "ingestEvent",
          source: "github",
          event: { id: "iss-stop", type: "issue.opened", subject: "lane-stop" },
        },
        now,
      );
      const claimStop = stepStore<{
        jobs: Array<{ run: number; token: string }>;
      }>(
        store,
        { type: "claimWork", claimId: "claim-stop", capacity: 4 },
        now + 100,
      );
      const stopJob = claimStop.jobs.find(
        (j) => store.view.get("runs", String(j.run))?.lane === "lane-stop",
      )!;
      stepStore(
        store,
        {
          type: "markStarted",
          run: stopJob.run,
          token: stopJob.token,
          session: "sess-cancelled",
        },
        now + 200,
      );
      stepStore(store, { type: "stopRun", run: stopJob.run }, now + 300);
      const cancelledSub = stepStore(
        store,
        {
          type: "submitResult",
          run: stopJob.run,
          token: stopJob.token,
          result: { outcome: "failed", error: "killed by user" },
        },
        now + 400,
      );
      assert.equal(cancelledSub.status, "cancelled");

      // Next run on lane-stop must not inherit `sess-cancelled`
      stepStore(
        store,
        {
          type: "ingestEvent",
          source: "github",
          event: {
            id: "iss-after-stop",
            type: "issue.opened",
            subject: "lane-stop",
          },
        },
        now + 500,
      );
      const claimAfterStop = stepStore<{
        jobs: Array<{ run: number; token: string; session: string | null }>;
      }>(
        store,
        { type: "claimWork", claimId: "claim-after-stop", capacity: 4 },
        now + 600,
      );
      const afterStopJob = claimAfterStop.jobs.find(
        (j) => store.view.get("runs", String(j.run))?.lane === "lane-stop",
      )!;
      assert.equal(afterStopJob.session, null);
      stepStore(
        store,
        {
          type: "submitResult",
          run: afterStopJob.run,
          token: afterStopJob.token,
          result: { outcome: "nothing" },
        },
        now + 700,
      );

      // Hop circuit breaker: ingest hops=8 -> run executes -> emits hops=9 -> breaker trips with 0 linked runs
      now += 10_000;
      stepStore(
        store,
        {
          type: "ingestEvent",
          source: "loop",
          event: {
            id: "hop-8",
            type: "loop.step",
            subject: "breaker-lane",
            hops: MAX_HOPS,
          },
        },
        now,
      );
      const claimHop8 = stepStore<{
        jobs: Array<{ run: number; token: string }>;
      }>(
        store,
        { type: "claimWork", claimId: "claim-hop8", capacity: 4 },
        now + 100,
      );
      const hop8Job = claimHop8.jobs.find(
        (j) => store.view.get("runs", String(j.run))?.lane === "breaker-lane",
      )!;
      const hop9Res = stepStore(
        store,
        {
          type: "submitResult",
          run: hop8Job.run,
          token: hop8Job.token,
          result: {
            outcome: "done",
            events: [
              { id: "hop-9", type: "loop.step", subject: "breaker-lane" },
            ],
          },
        },
        now + 200,
      );
      assert.equal(hop9Res.breakerCards.length, 1);

      // Pause -> skip event -> resume -> replay (plus replay run merged during active retry!)
      now += 10_000;
      stepStore(
        store,
        {
          type: "ingestEvent",
          source: "github",
          event: {
            id: "active-m",
            type: "issue.opened",
            subject: "lane-merge",
          },
        },
        now,
      );
      const claimM = stepStore<{
        jobs: Array<{ run: number; token: string }>;
      }>(
        store,
        { type: "claimWork", claimId: "claim-merge", capacity: 4 },
        now + 50,
      );
      const activeMergeJob = claimM.jobs.find(
        (j) => store.view.get("runs", String(j.run))?.lane === "lane-merge",
      )!;

      stepStore(
        store,
        { type: "pauseRule", rule: "triage", reason: "maintenance" },
        now + 100,
      );
      stepStore(
        store,
        {
          type: "ingestEvent",
          source: "github",
          event: {
            id: "skipped-1",
            type: "issue.opened",
            subject: "lane-merge",
          },
        },
        now + 200,
      );
      stepStore(store, { type: "resumeRule", rule: "triage" }, now + 300);
      const rep = stepStore<{ replayedCount: number }>(
        store,
        { type: "replayRule", rule: "triage" },
        now + 400,
      );
      assert.equal(rep.replayedCount, 1);
      // Duplicate replay must do nothing
      const rep2 = stepStore<{ replayedCount: number }>(
        store,
        { type: "replayRule", rule: "triage" },
        now + 450,
      );
      assert.equal(rep2.replayedCount, 0);

      // Failing activeMergeJob absorbs the replayed queued run and deletes its run row!
      stepStore(
        store,
        {
          type: "submitResult",
          run: activeMergeJob.run,
          token: activeMergeJob.token,
          result: { outcome: "failed", error: "merge absorbed replay" },
        },
        now + 500,
      );

      // Rule hot-reload: shrink `parallel` while another rule has claimed run & remove `ci-b` with queued run
      stepStore(
        store,
        {
          type: "ingestEvent",
          source: "ci",
          event: { id: "ci-a-1", type: "build.a" },
        },
        now + 600,
      );
      stepStore(
        store,
        { type: "claimWork", claimId: "claim-cia", capacity: 4 },
        now + 700,
      );
      stepStore(
        store,
        {
          type: "ingestEvent",
          source: "ci",
          event: { id: "ci-b-1", type: "build.b" },
        },
        now + 800,
      );
      const reducedConfig = makeConfig({
        rules: makeConfig()
          .rules.filter((r) => r.name !== "ci-b")
          .map((r) => (r.name === "ci-a" ? { ...r, parallel: 1 } : r)),
      });
      stepStore(
        store,
        { type: "configureRules", config: reducedConfig },
        now + 900,
      );

      // Verify reopened store & fingerprint-rebuilt store pass all invariants
      const lastNow = now + 900;
      store.close();
      const hydrated = openStore(dbPath);
      assertInvariants(hydrated, { nowMs: lastNow, workerCapacity: 4 });
      hydrated.close();

      const rebuilt = openStore(dbPath, { fingerprint: "autoloop-store-v2" });
      assertInvariants(rebuilt, { nowMs: lastNow, workerCapacity: 4 });
      rebuilt.close();
    });
  });

  it("INV-01: detects non-contiguous facts.seq gaps and row-count mismatches", () => {
    withTempDb((dbPath) => {
      const store = openStore(dbPath);
      stepStore(store, { type: "configureRules", config: makeConfig() }, T0);
      stepStore(
        store,
        {
          type: "ingestEvent",
          source: "github",
          event: { id: "e1", type: "issue.opened" },
        },
        T0 + 100,
      );
      store.close();

      // Inject gap: delete seq 1 so only seq 2 remains while last_seq=2
      const raw = new DatabaseSync(dbPath);
      raw.exec("DELETE FROM facts WHERE seq = 1");
      raw.close();

      const tampered = openStore(dbPath);
      assertThrowsInvariant(
        () => assertInvariants(tampered),
        "INV-01",
        "deleted fact seq=1",
      );
      tampered.close();
    });

    withTempDb((dbPath) => {
      const store = openStore(dbPath);
      stepStore(store, { type: "configureRules", config: makeConfig() }, T0);
      store.close();

      // Inject jump: change seq=1 to seq=5 directly
      const raw = new DatabaseSync(dbPath);
      raw.exec("UPDATE facts SET seq = 5 WHERE seq = 1");
      raw.exec("UPDATE store_meta SET value = '5' WHERE key = 'last_seq'");
      raw.close();

      const jumped = openStore(dbPath);
      assertThrowsInvariant(
        () => assertInvariants(jumped),
        "INV-01",
        "jumped fact seq=5",
      );
      jumped.close();
    });
  });

  it("INV-02: detects SQLite projections tampering, in-memory view drift, and HWM mismatch", () => {
    // 1. SQLite projections row tampered without touching facts
    withTempDb((dbPath) => {
      const store = openStore(dbPath);
      stepStore(store, { type: "configureRules", config: makeConfig() }, T0);
      stepStore(
        store,
        {
          type: "ingestEvent",
          source: "github",
          event: { id: "e1", type: "issue.opened", subject: "s1" },
        },
        T0 + 100,
      );

      const raw = new DatabaseSync(dbPath);
      const row = raw
        .prepare(
          "SELECT data FROM projections WHERE collection = 'runs' AND key = '1'",
        )
        .get() as { data: string };
      const parsed = JSON.parse(row.data) as Row;
      parsed.summary = "tampered-in-sqlite";
      raw
        .prepare(
          "UPDATE projections SET data = ? WHERE collection = 'runs' AND key = '1'",
        )
        .run(JSON.stringify(parsed));
      raw.close();

      assertThrowsInvariant(
        () => assertInvariants(store),
        "INV-02",
        "tampered SQLite projection data",
      );
      store.close();
    });

    // 2. Extra row inserted in SQLite projections
    withTempDb((dbPath) => {
      const store = openStore(dbPath);
      stepStore(store, { type: "configureRules", config: makeConfig() }, T0);

      const raw = new DatabaseSync(dbPath);
      raw
        .prepare(
          "INSERT INTO projections (collection, key, data) VALUES ('pauses', 'ghost', ?)",
        )
        .run(
          JSON.stringify({
            rule: "ghost",
            reason: null,
            paused_at: iso(T0),
            until: null,
          }),
        );
      raw.close();

      assertThrowsInvariant(
        () => assertInvariants(store),
        "INV-02",
        "extra SQLite projection row",
      );
      store.close();
    });

    // 3. In-memory store.view mutated directly out of sync with facts
    withTempDb((dbPath) => {
      const store = openStore(dbPath);
      stepStore(store, { type: "configureRules", config: makeConfig() }, T0);
      stepStore(
        store,
        {
          type: "ingestEvent",
          source: "github",
          event: { id: "e1", type: "issue.opened" },
        },
        T0 + 100,
      );

      const run1 = store.view.get("runs", "1")!;
      store.view.set("runs", "1", { ...run1, summary: "tampered-in-memory" });
      assertThrowsInvariant(
        () => assertInvariants(store),
        "INV-02",
        "in-memory view drifted from facts",
      );
      store.close();
    });

    // 4. In-memory view.next HWM drifted
    withTempDb((dbPath) => {
      const store = openStore(dbPath);
      stepStore(store, { type: "configureRules", config: makeConfig() }, T0);
      store.view.set("runs", "tmp", { id: 999 });
      store.view.set("runs", "tmp", null);
      assertThrowsInvariant(
        () => assertInvariants(store),
        "INV-02",
        "view.next HWM drifted from facts",
      );
      store.close();
    });
  });

  it("INV-03: detects group parallel overflow, workerCapacity overflow, and historical version overflow", () => {
    // 1. Group parallel exceeded in View
    const view = createMemoryView();
    stepView(view, { type: "configureRules", config: makeConfig() }, T0);
    stepView(
      view,
      {
        type: "ingestEvent",
        source: "github",
        event: { id: "a", type: "issue.opened", subject: "L1" },
      },
      T0 + 10,
    );
    stepView(
      view,
      {
        type: "ingestEvent",
        source: "github",
        event: { id: "b", type: "issue.opened", subject: "L2" },
      },
      T0 + 20,
    );
    stepView(
      view,
      {
        type: "ingestEvent",
        source: "github",
        event: { id: "c", type: "issue.opened", subject: "L3" },
      },
      T0 + 30,
    );
    stepView(view, { type: "claimWork", claimId: "c1", capacity: 5 }, T0 + 40);

    const badParallel = view.fork();
    const run3 = badParallel.get("runs", "3")!;
    badParallel.set("runs", "3", {
      ...run3,
      status: "claimed",
      claimed_at: iso(T0 + 40),
    });
    assertThrowsInvariant(
      () => assertInvariants(badParallel),
      "INV-03",
      "group parallel=2 exceeded with 3 claimed runs",
    );

    // 2. workerCapacity exceeded
    assertThrowsInvariant(
      () => assertInvariants(view, { workerCapacity: 1 }),
      "INV-03",
      "workerCapacity=1 exceeded with 2 claimed runs",
    );

    // 3. Invalid workerCapacity option throws InputError
    assert.throws(
      () => assertInvariants(view, { workerCapacity: -1 }),
      InputError,
    );

    // 4. Historical rules_version concurrency violation detected via Store facts
    withTempDb((dbPath) => {
      const store = openStore(dbPath);
      const cfgV1 = makeConfig({
        rules: [
          {
            name: "r1",
            when: { source: "github", types: ["issue.*"] },
            to: "worker",
            cwd: "/tmp/repo",
            group: "g1",
            parallel: 1,
          },
        ],
      });
      stepStore(store, { type: "configureRules", config: cfgV1 }, T0);
      const cfgV2 = makeConfig({
        rules: [
          {
            name: "r1",
            when: { source: "github", types: ["issue.*"] },
            to: "worker",
            cwd: "/tmp/repo",
            group: "g1",
            parallel: 3,
          },
        ],
      });
      // Inject a bad historical v1 state where 2 runs were claimed under v1 (parallel=1) before v2 raised parallel=3
      const badFact2: Fact = {
        version: 1,
        seq: 2,
        at: T0 + 10,
        type: "work.claimed",
        changes: [
          {
            table: "runs",
            key: "1",
            row: {
              id: 1,
              rule: "r1",
              rules_version: 1,
              agent: "worker",
              grp: "g1",
              lane: "L1",
              status: "claimed",
              attempts: 1,
              session: null,
              cancel_at: null,
              created_at: iso(T0 + 5),
              claimed_at: iso(T0 + 10),
            },
          },
          {
            table: "runs",
            key: "2",
            row: {
              id: 2,
              rule: "r1",
              rules_version: 1,
              agent: "worker",
              grp: "g1",
              lane: "L2",
              status: "claimed",
              attempts: 1,
              session: null,
              cancel_at: null,
              created_at: iso(T0 + 5),
              claimed_at: iso(T0 + 10),
            },
          },
        ],
      };
      store.commit([badFact2]);
      const v2Res = decide(
        store.view,
        { type: "configureRules", config: cfgV2 },
        T0 + 20,
        TEST_ENV,
      );
      store.commit(v2Res.facts);
      assertThrowsInvariant(
        () => assertInvariants(store),
        "INV-03",
        "historical v1 parallel=1 violation caught even after v2 raised parallel=3",
      );
      store.close();
    });
  });

  it("INV-04: detects rule.maxActive and agent.maxActive violations", () => {
    // 1. rule.maxActive violated while group parallel allows more
    const view1 = createMemoryView();
    const cfgRuleCap = makeConfig({
      rules: [
        {
          name: "bounded-rule",
          when: { source: "github", types: ["issue.*"] },
          to: "worker",
          cwd: "/tmp/repo",
          group: "wide-grp",
          parallel: 4,
          maxActive: 1,
        },
      ],
    });
    stepView(view1, { type: "configureRules", config: cfgRuleCap }, T0);
    stepView(
      view1,
      {
        type: "ingestEvent",
        source: "github",
        event: { id: "e1", type: "issue.opened", subject: "L1" },
      },
      T0 + 10,
    );
    stepView(
      view1,
      {
        type: "ingestEvent",
        source: "github",
        event: { id: "e2", type: "issue.opened", subject: "L2" },
      },
      T0 + 20,
    );
    stepView(view1, { type: "claimWork", claimId: "c1", capacity: 5 }, T0 + 30);

    const badRuleCap = view1.fork();
    const qRun = badRuleCap.get("runs", "2")!;
    badRuleCap.set("runs", "2", {
      ...qRun,
      status: "claimed",
      claimed_at: iso(T0 + 30),
    });
    assertThrowsInvariant(
      () => assertInvariants(badRuleCap),
      "INV-04",
      "rule.maxActive=1 exceeded",
    );

    // 2. agent.maxActive violated across two separate rules sharing `solo` agent (maxActive=1)
    const view2 = createMemoryView();
    stepView(view2, { type: "configureRules", config: makeConfig() }, T0);
    stepView(
      view2,
      {
        type: "ingestEvent",
        source: "ci",
        event: { id: "b1", type: "build.a" },
      },
      T0 + 10,
    );
    stepView(
      view2,
      {
        type: "ingestEvent",
        source: "ci",
        event: { id: "b2", type: "build.b" },
      },
      T0 + 20,
    );
    stepView(view2, { type: "claimWork", claimId: "c1", capacity: 5 }, T0 + 30);

    const badAgentCap = view2.fork();
    const soloQueued = badAgentCap.get("runs", "2")!;
    badAgentCap.set("runs", "2", {
      ...soloQueued,
      status: "claimed",
      claimed_at: iso(T0 + 30),
    });
    assertThrowsInvariant(
      () => assertInvariants(badAgentCap),
      "INV-04",
      "agent.maxActive=1 exceeded across ci-a and ci-b",
    );
  });

  it("INV-05: detects dual claimed runs and dual uncancelled queued runs on the same (rule, lane)", () => {
    const view = createMemoryView();
    stepView(view, { type: "configureRules", config: makeConfig() }, T0);
    stepView(
      view,
      {
        type: "ingestEvent",
        source: "github",
        event: { id: "e1", type: "issue.opened", subject: "L1" },
      },
      T0 + 10,
    );
    stepView(view, { type: "claimWork", claimId: "c1", capacity: 2 }, T0 + 20);
    stepView(
      view,
      {
        type: "ingestEvent",
        source: "github",
        event: { id: "e2", type: "issue.opened", subject: "L1" },
      },
      T0 + 30,
    );

    // 1. Dual claimed on (triage, L1)
    const dualClaimed = view.fork();
    const run2 = dualClaimed.get("runs", "2")!;
    dualClaimed.set("runs", "2", {
      ...run2,
      status: "claimed",
      claimed_at: iso(T0 + 35),
    });
    assertThrowsInvariant(
      () => assertInvariants(dualClaimed),
      "INV-05",
      "dual claimed runs on same (rule, lane)",
    );

    // 2. Dual uncancelled queued on (triage, L1)
    const dualQueued = view.fork();
    dualQueued.set("runs", "99", {
      ...run2,
      id: 99,
      status: "queued",
      cancel_at: null,
    });
    assertThrowsInvariant(
      () => assertInvariants(dualQueued),
      "INV-05",
      "dual uncancelled queued runs on same (rule, lane)",
    );
  });

  it("INV-06: detects shared active sessions and cancelled-session inheritance in View and Store", () => {
    const view = createMemoryView();
    stepView(view, { type: "configureRules", config: makeConfig() }, T0);
    stepView(
      view,
      {
        type: "ingestEvent",
        source: "github",
        event: { id: "e1", type: "issue.opened", subject: "L1" },
      },
      T0 + 10,
    );
    stepView(
      view,
      {
        type: "ingestEvent",
        source: "github",
        event: { id: "e2", type: "issue.opened", subject: "L2" },
      },
      T0 + 20,
    );
    const claimed = stepView<{ jobs: Array<{ run: number; token: string }> }>(
      view,
      { type: "claimWork", claimId: "c1", capacity: 4 },
      T0 + 30,
    );
    stepView(
      view,
      {
        type: "markStarted",
        run: claimed.jobs[0]!.run,
        token: claimed.jobs[0]!.token,
        session: "shared-conv",
      },
      T0 + 40,
    );

    // 1. Two claimed runs sharing "shared-conv"
    const dualClaimedSession = view.fork();
    const run2 = dualClaimedSession.get("runs", String(claimed.jobs[1]!.run))!;
    dualClaimedSession.set("runs", String(run2.id), {
      ...run2,
      session: "shared-conv",
    });
    assertThrowsInvariant(
      () => assertInvariants(dualClaimedSession),
      "INV-06",
      "two claimed runs holding same session",
    );

    // 2. One claimed and one unknown run sharing "shared-conv"
    const claimedAndUnknown = dualClaimedSession.fork();
    const run1 = claimedAndUnknown.get("runs", String(claimed.jobs[0]!.run))!;
    claimedAndUnknown.set("runs", String(run1.id), {
      ...run1,
      status: "unknown",
    });
    assertThrowsInvariant(
      () => assertInvariants(claimedAndUnknown),
      "INV-06",
      "claimed and unknown runs sharing same session",
    );

    // 3. Later run inheriting cancelled run's session (View mode + Store mode)
    withTempDb((dbPath) => {
      const store = openStore(dbPath);
      stepStore(store, { type: "configureRules", config: makeConfig() }, T0);
      stepStore(
        store,
        {
          type: "ingestEvent",
          source: "github",
          event: { id: "c1", type: "issue.opened", subject: "L1" },
        },
        T0 + 10,
      );
      const cw = stepStore<{ jobs: Array<{ run: number; token: string }> }>(
        store,
        { type: "claimWork", claimId: "c1", capacity: 4 },
        T0 + 20,
      );
      stepStore(
        store,
        {
          type: "markStarted",
          run: cw.jobs[0]!.run,
          token: cw.jobs[0]!.token,
          session: "dead-sess",
        },
        T0 + 30,
      );
      stepStore(store, { type: "stopRun", run: cw.jobs[0]!.run }, T0 + 40);
      stepStore(
        store,
        {
          type: "submitResult",
          run: cw.jobs[0]!.run,
          token: cw.jobs[0]!.token,
          result: { outcome: "cancelled" },
        },
        T0 + 50,
      );

      // View mode injection: later run on L2 claims "dead-sess"
      const badView = store.view.fork();
      badView.set("runs", "2", {
        id: 2,
        rule: "triage",
        rules_version: 1,
        agent: "worker",
        grp: "eng",
        lane: "L2",
        status: "done",
        attempts: 1,
        session: "dead-sess",
        cancel_at: null,
        created_at: iso(T0 + 60),
        claimed_at: iso(T0 + 70),
        ended_at: iso(T0 + 80),
      });
      assertThrowsInvariant(
        () => assertInvariants(badView),
        "INV-06",
        "View mode: later run inherited cancelled session",
      );

      // Store mode injection via fact stream
      const badFact: Fact = {
        version: 1,
        seq: store.view.seq + 1,
        at: T0 + 70,
        type: "work.claimed",
        changes: [
          {
            table: "runs",
            key: "2",
            row: {
              id: 2,
              rule: "triage",
              rules_version: 1,
              agent: "worker",
              grp: "eng",
              lane: "L2",
              status: "claimed",
              attempts: 1,
              session: "dead-sess",
              cancel_at: null,
              created_at: iso(T0 + 60),
              claimed_at: iso(T0 + 70),
            },
          },
        ],
      };
      store.commit([badFact]);
      assertThrowsInvariant(
        () => assertInvariants(store),
        "INV-06",
        "Store mode: fact stream inherited cancelled session",
      );
      store.close();
    });
  });

  it("INV-07: detects hops > MAX_HOPS (9) event dispatched in run_events", () => {
    const view = createMemoryView();
    stepView(view, { type: "configureRules", config: makeConfig() }, T0);
    stepView(
      view,
      {
        type: "ingestEvent",
        source: "loop",
        event: { id: "over-limit", type: "loop.step", hops: 9 },
      },
      T0 + 10,
    );

    const bad = view.fork();
    bad.set("runs", "1", {
      id: 1,
      rule: "stepper",
      rules_version: 1,
      agent: "worker",
      grp: "chain",
      lane: "",
      status: "queued",
      attempts: 0,
      session: null,
      cancel_at: null,
      created_at: iso(T0 + 10),
      not_before: iso(T0 + 10),
    });
    bad.set("run_events", "1:1", { run_id: 1, event_id: 1 });

    assertThrowsInvariant(
      () => assertInvariants(bad),
      "INV-07",
      "hops=9 event linked to run in run_events",
    );
  });

  it("INV-08: detects duplicate (source, key) in events and missing/corrupt seen index", () => {
    const view = createMemoryView();
    stepView(view, { type: "configureRules", config: makeConfig() }, T0);
    stepView(
      view,
      {
        type: "ingestEvent",
        source: "github",
        event: { id: "dup-key", type: "issue.opened" },
      },
      T0 + 10,
    );

    // 1. Duplicate (source, key) in events
    const dupEv = view.fork();
    const ev1 = dupEv.get("events", "1")!;
    dupEv.set("events", "2", { ...ev1, id: 2 });
    assertThrowsInvariant(
      () => assertInvariants(dupEv),
      "INV-08",
      "duplicate (source, key) in events",
    );

    // 2. Missing `seen` index for external event
    const missingSeen = view.fork();
    missingSeen.set("seen", "event:github:dup-key", null);
    assertThrowsInvariant(
      () => assertInvariants(missingSeen),
      "INV-08",
      "external event missing seen index",
    );

    // 3. Duplicate `seen` entry pointing to same event_id
    const dupSeen = view.fork();
    dupSeen.set("seen", "event:github:other-key", {
      kind: "event",
      name: "github:dup-key",
      event_id: 1,
      seen_at: iso(T0 + 10),
    });
    assertThrowsInvariant(
      () => assertInvariants(dupSeen),
      "INV-08",
      "duplicate seen index for same event_id",
    );
  });

  it("INV-09: detects fyi open cards, missing decided_at, answer+resolve overlap, and duplicate open cards", () => {
    const view = createMemoryView();
    stepView(view, { type: "configureRules", config: makeConfig() }, T0);
    stepView(
      view,
      {
        type: "ingestEvent",
        source: "github",
        event: { id: "e1", type: "issue.opened", subject: "L1" },
      },
      T0 + 10,
    );
    const cw = stepView<{ jobs: Array<{ run: number; token: string }> }>(
      view,
      { type: "claimWork", claimId: "c1", capacity: 2 },
      T0 + 20,
    );
    const sub = stepView(
      view,
      {
        type: "submitResult",
        run: cw.jobs[0]!.run,
        token: cw.jobs[0]!.token,
        result: {
          outcome: "done",
          ask: [
            {
              key: "k-ask",
              title: "Ask",
              text: "Pick",
              options: ["A", "B"],
              about: "gate",
            },
          ],
          notice: [{ key: "k-fyi", title: "FYI", text: "Done", fyi: true }],
        },
      },
      T0 + 30,
    );
    const askId = sub.cardsCreated[0].card;
    const fyiId = sub.cardsCreated[1].card;

    // 1. fyi=true still open
    const badFyiOpen = view.fork();
    const fyiRow = badFyiOpen.get("cards", String(fyiId))!;
    badFyiOpen.set("cards", String(fyiId), {
      ...fyiRow,
      status: "open",
      closed_at: null,
    });
    assertThrowsInvariant(
      () => assertInvariants(badFyiOpen),
      "INV-09",
      "fyi=true notice card in open status",
    );

    // 2. Duplicate open ask card on same (rule, lane, key)
    const badDupCard = view.fork();
    const askRow = badDupCard.get("cards", String(askId))!;
    badDupCard.set("cards", "99", { ...askRow, id: 99 });
    assertThrowsInvariant(
      () => assertInvariants(badDupCard),
      "INV-09",
      "duplicate open ask card on same (rule, lane, key)",
    );

    // 3. decided ask card missing decided_at, and answer + resolve coexistence
    stepView(view, { type: "answerCard", card: askId, choice: 0 }, T0 + 40);

    const badNoDecidedAt = view.fork();
    const decRow = badNoDecidedAt.get("cards", String(askId))!;
    badNoDecidedAt.set("cards", String(askId), {
      ...decRow,
      decided_at: null,
    });
    assertThrowsInvariant(
      () => assertInvariants(badNoDecidedAt),
      "INV-09",
      "decided ask card missing decided_at",
    );

    const badOverlap = view.fork();
    badOverlap.set("cards", String(askId), {
      ...decRow,
      resolved_reason: "overwritten by resolve",
    });
    assertThrowsInvariant(
      () => assertInvariants(badOverlap),
      "INV-09",
      "card has both decided_at and resolved_reason",
    );

    // 4. Store fact-stream card answered then overwritten as closed/resolved
    withTempDb((dbPath) => {
      const store = openStore(dbPath);
      stepStore(store, { type: "configureRules", config: makeConfig() }, T0);
      stepStore(
        store,
        {
          type: "ingestEvent",
          source: "github",
          event: { id: "c-hist", type: "issue.opened", subject: "L1" },
        },
        T0 + 10,
      );
      const cClaim = stepStore<{ jobs: Array<{ run: number; token: string }> }>(
        store,
        { type: "claimWork", claimId: "c-hist", capacity: 2 },
        T0 + 20,
      );
      const cSub = stepStore(
        store,
        {
          type: "submitResult",
          run: cClaim.jobs[0]!.run,
          token: cClaim.jobs[0]!.token,
          result: {
            outcome: "done",
            ask: [
              {
                key: "k-hist",
                title: "Ask",
                text: "Pick",
                options: ["A", "B"],
                about: "gate",
              },
            ],
          },
        },
        T0 + 30,
      );
      const cardId = cSub.cardsCreated[0].card as number;
      stepStore(
        store,
        { type: "answerCard", card: cardId, choice: 0 },
        T0 + 40,
      );

      const answeredCard = store.view.get("cards", String(cardId))!;
      store.commit([
        {
          version: 1,
          seq: store.view.seq + 1,
          at: T0 + 50,
          type: "card.resolved",
          changes: [
            {
              table: "cards",
              key: String(cardId),
              row: {
                ...answeredCard,
                status: "closed",
                decided_at: null,
                answer_event: null,
                resolved_reason: "overwritten in facts",
                closed_at: iso(T0 + 50),
              },
            },
          ],
        },
      ]);
      assertThrowsInvariant(
        () => assertInvariants(store),
        "INV-09",
        "Store fact stream answered then resolved same card",
      );
      store.close();
    });
  });

  it("INV-10: detects cancel_at != null in queued/non-cancelled terminal state and terminal resurrection", () => {
    const view = createMemoryView();
    stepView(view, { type: "configureRules", config: makeConfig() }, T0);
    stepView(
      view,
      {
        type: "ingestEvent",
        source: "github",
        event: { id: "e1", type: "issue.opened", subject: "L1" },
      },
      T0 + 10,
    );

    // 1. cancel_at != null while status === "queued"
    const badQueued = view.fork();
    const run1 = badQueued.get("runs", "1")!;
    badQueued.set("runs", "1", {
      ...run1,
      status: "queued",
      cancel_at: iso(T0 + 20),
    });
    assertThrowsInvariant(
      () => assertInvariants(badQueued),
      "INV-10",
      "cancel_at != null while queued",
    );

    // 2. cancel_at != null while status === "failed"
    const badFailed = view.fork();
    badFailed.set("runs", "1", {
      ...run1,
      status: "failed",
      cancel_at: iso(T0 + 20),
      ended_at: iso(T0 + 30),
    });
    assertThrowsInvariant(
      () => assertInvariants(badFailed),
      "INV-10",
      "cancel_at != null with terminal failed status",
    );

    // 3. Store fact-stream terminal irreversibility violation
    withTempDb((dbPath) => {
      const store = openStore(dbPath);
      stepStore(store, { type: "configureRules", config: makeConfig() }, T0);
      stepStore(
        store,
        {
          type: "ingestEvent",
          source: "github",
          event: { id: "e1", type: "issue.opened" },
        },
        T0 + 10,
      );
      stepStore(store, { type: "stopRun", run: 1 }, T0 + 20);
      const stoppedRow = store.view.get("runs", "1")!;
      store.commit([
        {
          version: 1,
          seq: store.view.seq + 1,
          at: T0 + 30,
          type: "run.requeued",
          changes: [
            {
              table: "runs",
              key: "1",
              row: {
                ...stoppedRow,
                status: "queued",
                cancel_at: null,
                ended_at: null,
              },
            },
          ],
        },
      ]);
      assertThrowsInvariant(
        () => assertInvariants(store),
        "INV-10",
        "cancelled run reverted back to queued in facts",
      );
      store.close();
    });
  });

  it("INV-11: detects missing replay_run_id, duplicate skipped entries, and double replay in facts", () => {
    withTempDb((dbPath) => {
      const store = openStore(dbPath);
      stepStore(store, { type: "configureRules", config: makeConfig() }, T0);
      stepStore(store, { type: "pauseRule", rule: "triage" }, T0 + 10);
      stepStore(
        store,
        {
          type: "ingestEvent",
          source: "github",
          event: { id: "sk-1", type: "issue.opened" },
        },
        T0 + 20,
      );
      stepStore(store, { type: "resumeRule", rule: "triage" }, T0 + 30);
      stepStore(store, { type: "replayRule", rule: "triage" }, T0 + 40);

      // 1. replayed_at != null without valid replay_run_id
      const badNullRun = store.view.fork();
      const skipRow = badNullRun.get("skipped", "triage:1")!;
      badNullRun.set("skipped", "triage:1", {
        ...skipRow,
        replay_run_id: null,
      });
      assertThrowsInvariant(
        () => assertInvariants(badNullRun),
        "INV-11",
        "replayed_at != null with null replay_run_id",
      );

      // 2. replayed_at != null with bogus nonexistent replay_run_id
      const badBogusRun = store.view.fork();
      badBogusRun.set("skipped", "triage:1", {
        ...skipRow,
        replay_run_id: 9999,
      });
      assertThrowsInvariant(
        () => assertInvariants(badBogusRun),
        "INV-11",
        "replayed_at != null with bogus replay_run_id",
      );

      // 3. Duplicate skipped records for same (rule, event_id)
      const dupSkipped = store.view.fork();
      dupSkipped.set("skipped", "triage:1:dup", { ...skipRow, id: 2 });
      assertThrowsInvariant(
        () => assertInvariants(dupSkipped),
        "INV-11",
        "duplicate skipped entry for same (rule, event_id)",
      );

      // 4. Store fact-stream second replay overwriting replayed_at/replay_run_id
      store.commit([
        {
          version: 1,
          seq: store.view.seq + 1,
          at: T0 + 50,
          type: "rule.replayed",
          changes: [
            {
              table: "skipped",
              key: "triage:1",
              row: {
                ...skipRow,
                replayed_at: iso(T0 + 50),
                replay_run_id: 1,
              },
            },
          ],
        },
      ]);
      assertThrowsInvariant(
        () => assertInvariants(store),
        "INV-11",
        "second replay on same skipped record in facts",
      );
      store.close();
    });
  });

  it("INV-12: detects due index mismatch against deadlines(view, nowMs) and malformed due rows", () => {
    const view = createMemoryView();
    stepView(view, { type: "configureRules", config: makeConfig() }, T0);

    // 1. Missing due entry when nowMs is provided
    const missingDue = view.fork();
    missingDue.set("due", "cron:nightly", null);
    assertThrowsInvariant(
      () => assertInvariants(missingDue, { nowMs: T0 }),
      "INV-12",
      "missing due entry compared to deadlines(view, nowMs)",
    );

    // 2. Stale / mismatched `at` when nowMs is provided
    const staleDue = view.fork();
    const cronDue = staleDue.get("due", "cron:nightly")!;
    staleDue.set("due", "cron:nightly", {
      ...cronDue,
      at: (cronDue.at as number) + 1000,
      iso_at: iso((cronDue.at as number) + 1000),
    });
    assertThrowsInvariant(
      () => assertInvariants(staleDue, { nowMs: T0 }),
      "INV-12",
      "mismatched due timestamp compared to deadlines(view, nowMs)",
    );

    // 3. Structural due validation without nowMs (invalid kind / mismatched iso_at)
    const badIsoDue = view.fork();
    badIsoDue.set("due", "cron:nightly", {
      ...cronDue,
      iso_at: "2020-01-01T00:00:00.000Z",
    });
    assertThrowsInvariant(
      () => assertInvariants(badIsoDue),
      "INV-12",
      "due row iso_at inconsistent with numeric at",
    );

    const badKindDue = view.fork();
    badKindDue.set("due", "cron:nightly", {
      ...cronDue,
      kind: "invalid-kind",
    });
    assertThrowsInvariant(
      () => assertInvariants(badKindDue),
      "INV-12",
      "due row invalid kind",
    );

    // 4. Invalid nowMs throws InputError
    assert.throws(
      () => assertInvariants(view, { nowMs: Number.NaN }),
      InputError,
    );
  });
});
