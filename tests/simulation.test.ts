/**
 * Deterministic Seeded Simulation & Replay Tests (Layer 3 / WP-20).
 *
 * Prevents:
 * 1. Non-determinism or hidden ambient state (wall clock, Math.random, unordered maps)
 *    causing identical seeds to diverge in `finalSeq`, `projectionHash`, or `coverage`.
 * 2. State-machine invariant regressions (`INV-01`..`INV-12`) under high-intensity
 *    chaotic interleavings: event bursts, duplicate delivery, wildcard/watch routing,
 *    concurrent claims, heartbeat vs lease expiry (`unknown`), stale/bad tokens,
 *    pre-start vs post-start failures, queued-event retry merging, 10-attempt failure
 *    alerts, atomic receipt combinations (`ask`, `notice`, `resolve`, `later`, `events`),
 *    hops > 8 circuit breaking, `answerCard`/`resolveCard` races, `stopRun` cancel
 *    irreversibility, rule hot-reloads, timed/indefinite pauses, idempotent `replayRule`,
 *    DST/sleep clock jumps, and SQLite `SCHEMA_FINGERPRINT` forced rebuilds.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InputError } from "../kernel/errors.ts";
import { runSimulation, type SimulationCoverage } from "../sim/random.ts";

const REQUIRED_COVERAGE_KEYS: readonly (keyof SimulationCoverage)[] = [
  "eventsIngested",
  "duplicates",
  "burstEvents",
  "watchEvents",
  "wildcardRoutes",
  "breakerTripped",
  "breakerFromDerived",
  "runsCreated",
  "runsMerged",
  "runsClaimed",
  "claimIdReplays",
  "heartbeats",
  "runsStarted",
  "runsExpiredUnknown",
  "runsCompletedDone",
  "runsCompletedNothing",
  "runsFailedRequeued",
  "runsFailedBeforeStart",
  "runsFailedAfterStart",
  "runsFailedMaxAttempts",
  "runsCancelled",
  "runsCancelledAfterStop",
  "staleTokensRejected",
  "badTokensRejected",
  "submitReplays",
  "askCardsCreated",
  "askDeduped",
  "noticeOpenCreated",
  "noticeFyiCreated",
  "askCardsAnswered",
  "doubleAnswersRejected",
  "cardsResolvedByReceipt",
  "resolvesRejected",
  "cardsResolvedByUser",
  "answerResolveRaces",
  "timersScheduled",
  "timersUpdated",
  "timersCancelled",
  "timersFired",
  "derivedEventsEmitted",
  "derivedEventsRejected",
  "rulesConfigured",
  "rulesRemovedWithQueued",
  "rulesPausedIndefinite",
  "rulesPausedUntil",
  "rulesAutoUnpaused",
  "eventsSkippedWhilePaused",
  "rulesResumed",
  "rulesReplayed",
  "replayIdempotentZero",
  "rulesTriggeredManual",
  "cronFired",
  "longClockJumps",
];

describe("Deterministic Chaos Simulation (WP-20)", () => {
  for (const seed of [24301, 42, 99991]) {
    it(`passes 20,000-step deterministic simulation with full branch coverage (seed=${seed})`, () => {
      const stats = runSimulation({
        seed,
        steps: 20_000,
        checkStoreEvery: 2000,
      });

      assert.equal(stats.seed, seed);
      assert.equal(stats.steps, 20_000);
      assert.equal(stats.invariantChecks, 20_020);
      assert.equal(stats.storeChecks, 20);
      assert.equal(stats.fingerprintRebuilds, 10);
      assert.ok(stats.totalFacts > 0);
      assert.match(stats.projectionHash, /^[0-9a-f]{64}$/);

      for (const [cmd, count] of Object.entries(stats.commandCounts)) {
        assert.ok(count > 0, `seed=${seed}: command ${cmd} was never hit`);
      }

      assert.ok(stats.expectedErrors.input > 0);
      assert.ok(stats.expectedErrors.auth > 0);
      assert.ok(stats.expectedErrors.conflict > 0);
      assert.ok(stats.expectedErrors.notFound > 0);

      for (const key of REQUIRED_COVERAGE_KEYS) {
        assert.ok(
          stats.coverage[key] > 0,
          `seed=${seed}: coverage.${key} was ${stats.coverage[key]}, expected > 0`,
        );
      }
    });
  }

  it("replays identical trajectories byte-for-byte for the same seed and diverges across seeds", () => {
    const runA = runSimulation({
      seed: 24301,
      steps: 5000,
      checkStoreEvery: 1000,
    });
    const runB = runSimulation({
      seed: 24301,
      steps: 5000,
      checkStoreEvery: 1000,
    });
    const runOther = runSimulation({
      seed: 42,
      steps: 5000,
      checkStoreEvery: 1000,
    });

    assert.deepEqual(runA, runB);
    assert.notEqual(runA.projectionHash, runOther.projectionHash);
  });

  it("verifies frequent store & fingerprint rebuild checkpoints and rejects invalid step counts", () => {
    const stats = runSimulation({
      seed: 1337,
      steps: 300,
      checkStoreEvery: 75,
    });
    assert.equal(stats.storeChecks, 8);
    assert.equal(stats.fingerprintRebuilds, 4);
    assert.equal(stats.invariantChecks, 308);

    assert.throws(
      () => runSimulation({ seed: 1, steps: 0 }),
      (err: unknown) => err instanceof InputError,
    );
    assert.throws(
      () => runSimulation({ seed: 1, steps: -10 }),
      (err: unknown) => err instanceof InputError,
    );
  });
});
