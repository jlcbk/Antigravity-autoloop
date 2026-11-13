/**
 * Real OS `SIGKILL` (-9) Crash-Recovery & Persistence Tests (Layer 3).
 *
 * Prevents:
 * 1. Silent loss of acknowledged transactions (`store.view.seq < maxAckedSeq`) when a
 *    worker process is terminated mid-commit or near a WAL checkpoint via `SIGKILL`.
 * 2. Torn or half-applied projections across SQLite `facts`, `projections`, and
 *    in-memory `View` state after ungraceful process termination.
 * 3. State-machine invariant regressions (`INV-01`..`INV-12`) or divergence after
 *    fingerprint-triggered full streaming rebuild from `facts`.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { openStore } from "../kernel/store.ts";
import { buildStateSnapshot } from "../sidecars/hub/state-queries.ts";
import { runCrashCampaign } from "../sim/crash.ts";
import { assertInvariants } from "../sim/invariants.ts";

describe("WP-21 SIGKILL Crash Recovery", () => {
  it("survives 30 real SIGKILL worker crashes with zero acknowledged fact loss and all 12 invariants intact", async () => {
    const dbDir = mkdtempSync(path.join(os.tmpdir(), "autoloop-crash-test-"));

    try {
      const report = await runCrashCampaign({
        iterations: 30,
        dbDir,
        seed: 20_261_114,
      });

      assert.equal(report.ok, true);
      assert.equal(report.iterationsRequested, 30);
      assert.equal(report.iterationsCompleted, 30);
      assert.ok(
        report.totalAckedCommits >= 30,
        `expected >= 30 acked commits, got ${report.totalAckedCommits}`,
      );
      assert.ok(
        report.finalSeq >= report.totalAckedCommits,
        `expected finalSeq (${report.finalSeq}) >= totalAckedCommits (${report.totalAckedCommits})`,
      );
      assert.ok(
        report.maxUnackedAhead <= 1,
        `expected maxUnackedAhead <= 1, got ${report.maxUnackedAhead}`,
      );
      assert.ok(
        report.fingerprintRebuildChecks >= 3,
        `expected >= 3 fingerprint rebuild checks, got ${report.fingerprintRebuildChecks}`,
      );

      // Reopen post-campaign database directly and verify integrity + invariants
      const store = openStore(report.dbPath);
      try {
        const integrity = store.queryAll<{ integrity_check: string }>(
          "PRAGMA integrity_check",
        );
        assert.equal(integrity[0]?.integrity_check, "ok");
        assert.equal(store.view.seq, report.finalSeq);
        assertInvariants(store);
      } finally {
        store.close();
      }

      // Simulate wiped projections + stale fingerprint on the post-crash DB and verify full rebuild
      const rawDb = new DatabaseSync(report.dbPath);
      try {
        rawDb.exec("DELETE FROM projections");
        rawDb
          .prepare(
            "INSERT INTO store_meta (key, value) VALUES ('fingerprint', 'stale-v0') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          )
          .run();
      } finally {
        rawDb.close();
      }

      const rebuilt = openStore(report.dbPath);
      try {
        assert.equal(rebuilt.view.seq, report.finalSeq);
        assertInvariants(rebuilt);
        const snapshot = buildStateSnapshot(rebuilt, 1_765_000_000_000);
        assert.ok(snapshot.etag.startsWith(`v${report.finalSeq}-`));
      } finally {
        rebuilt.close();
      }
    } finally {
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  it("cleans up its temporary dbDir automatically when dbDir is omitted", async () => {
    const report = await runCrashCampaign({
      iterations: 4,
      seed: 4242,
    });

    assert.equal(report.ok, true);
    assert.equal(report.iterationsCompleted, 4);
    assert.ok(report.fingerprintRebuildChecks >= 1);
    assert.equal(
      existsSync(path.dirname(report.dbPath)),
      false,
      "expected runCrashCampaign to clean up auto-created temp dir",
    );
  });
});
