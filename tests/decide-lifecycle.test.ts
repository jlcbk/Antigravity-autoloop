/**
 * Guards against run lifecycle, retry, cancellation, card state-machine, and tick/lease invariants:
 * 1. `claimWork` failing idempotency on repeated `claimId`, or `markStarted` accepting forged tokens.
 * 2. Retrying failures discarding an already-started session (redoing side effects) vs keeping an unstarted broken session, or failing to coalesce queued `(rule, lane)` events.
 * 3. Exceeding `MAX_ATTEMPTS` (10) failing to halt retries or failing to emit an alert `notice` card.
 * 4. `stopRun` followed by child exit `failed` accidentally retrying instead of locking into `cancelled`.
 * 5. Terminal `submitResult` failing idempotency (`facts: []`) or failing to throw `ConflictError` (409) on changed payload.
 * 6. Card invariants breaking: duplicate open `ask` cards on `(rule, lane, key)`, `fyi` leaking into open scope, out-of-scope `resolve`, double-answering or answering+resolving the same card.
 * 7. `tick` flooding cron backlogs after host sleep, dropping `timers` session resume, or rejecting late `submitResult` on a lease-expired `unknown` run holding its valid token.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decide,
  MAX_ATTEMPTS,
  type DecideEnv,
  type KernelInput,
} from "../kernel/decide.ts";
import {
  applyFact,
  createMemoryView,
  iso,
  rows,
  type View,
} from "../kernel/evolve.ts";
import {
  AuthError,
  ConflictError,
  InputError,
  NotFoundError,
} from "../kernel/errors.ts";
import { RUN_LEASE_MS } from "../kernel/due.ts";
import { openInScope } from "../kernel/query.ts";
import { createTokenSigner, safeTokenEquals } from "../kernel/store.ts";
import type { RulesConfig } from "../protocol/types.ts";

const MASTER_KEY = "fedcba9876543210".repeat(4);
const TEST_ENV: DecideEnv = {
  signToken: createTokenSigner(MASTER_KEY),
  safeTokenEquals,
  retryBaseMs: 2000,
};

const T0 = Date.parse("2026-11-10T10:00:00.000Z");

function commit<T = any>(
  view: View,
  input: KernelInput,
  nowMs = T0,
  env: DecideEnv = TEST_ENV,
): { facts: ReturnType<typeof decide>["facts"]; value: T } {
  const beforeSeq = view.seq;
  const res = decide<T>(view, input, nowMs, env);
  assert.equal(view.seq, beforeSeq, "decide() must not mutate input view");
  for (const f of res.facts) {
    applyFact(view, f);
  }
  return res;
}

function makeConfig(overrides: Partial<RulesConfig> = {}): RulesConfig {
  return {
    timezone: "UTC",
    askFirst: [],
    sources: {
      github: { name: "GitHub" },
      ops: { name: "Ops" },
    },
    agents: {
      worker: {
        name: "Worker",
        runner: "agy-print",
        model: "m-1",
        access: "edit",
        timeoutMinutes: 30,
        maxActive: 4,
      },
    },
    rules: [
      {
        name: "deploy",
        when: { source: "github", types: ["release.*"] },
        to: "worker",
        cwd: "/tmp/app",
        prompt: "Deploy release",
        group: "prod",
        parallel: 2,
        resume: true,
      },
      {
        name: "alerts",
        when: { source: "ops", types: ["alert.*"] },
        to: "worker",
        cwd: "/tmp/app",
        prompt: "Inspect alert",
        group: "sec",
      },
    ],
    ...overrides,
  };
}

describe("WP-05 decide lifecycle, retries, stop, receipts, cards, and tick", () => {
  it("supports claimWork idempotency, running heartbeats, and markStarted auth + idempotency", () => {
    const view = createMemoryView();
    commit(view, { type: "configureRules", config: makeConfig() }, T0);
    commit(
      view,
      {
        type: "ingestEvent",
        source: "github",
        event: { id: "rel-1", type: "release.created", subject: "v1" },
      },
      T0 + 100,
    );

    const claim1 = commit(
      view,
      { type: "claimWork", claimId: "cid-1", capacity: 1 },
      T0 + 200,
    );
    assert.equal(claim1.value.jobs.length, 1);
    const job = claim1.value.jobs[0];

    // Idempotent replay of same claimId without heartbeat change -> 0 facts, same job.
    const replay = commit(
      view,
      { type: "claimWork", claimId: "cid-1", capacity: 1 },
      T0 + 300,
    );
    assert.equal(replay.facts.length, 0);
    assert.equal(replay.value.jobs.length, 1);
    assert.equal(replay.value.jobs[0].run, job.run);
    assert.equal(replay.value.jobs[0].token, job.token);

    // Invalid token or missing run on markStarted throws AuthError / NotFoundError.
    assert.throws(
      () =>
        commit(
          view,
          { type: "markStarted", run: job.run, token: "bad-token" },
          T0 + 400,
        ),
      AuthError,
    );
    assert.throws(
      () =>
        commit(
          view,
          { type: "markStarted", run: 9999, token: job.token },
          T0 + 400,
        ),
      NotFoundError,
    );

    // Valid markStarted sets started_at and session; repeat is idempotent.
    const ms1 = commit(
      view,
      {
        type: "markStarted",
        run: job.run,
        token: job.token,
        session: "sess-a",
      },
      T0 + 500,
    );
    assert.equal(ms1.value.session, "sess-a");
    assert.equal(ms1.value.startedAt, iso(T0 + 500));

    const ms2 = commit(
      view,
      {
        type: "markStarted",
        run: job.run,
        token: job.token,
        session: "sess-a",
      },
      T0 + 500,
    );
    assert.equal(ms2.facts.length, 0);

    // Heartbeat via claimWork updates heartbeat_at for running run.
    commit(
      view,
      { type: "claimWork", claimId: "cid-hb", capacity: 1, running: [job.run] },
      T0 + 60_000,
    );
    assert.equal(
      view.get("runs", String(job.run))?.heartbeat_at,
      iso(T0 + 60_000),
    );
  });

  it("handles pre-start vs post-start failure differently, merges queued runs on retry, and halts at MAX_ATTEMPTS", () => {
    const view = createMemoryView();
    commit(view, { type: "configureRules", config: makeConfig() }, T0);

    // Establish an initial completed session `sess-prev` on lane "v1".
    commit(
      view,
      {
        type: "ingestEvent",
        source: "github",
        event: { id: "init", type: "release.created", subject: "v1" },
      },
      T0 + 10,
    );
    const cInit = commit(
      view,
      { type: "claimWork", claimId: "c-init", capacity: 1 },
      T0 + 20,
    );
    commit(
      view,
      {
        type: "submitResult",
        run: cInit.value.jobs[0].run,
        token: cInit.value.jobs[0].token,
        result: { outcome: "done", session: "sess-prev" },
      },
      T0 + 30,
    );

    // Next run claims with `sess-prev`, but fails BEFORE markStarted -> next claim MUST clear session to null!
    commit(
      view,
      {
        type: "ingestEvent",
        source: "github",
        event: { id: "r1", type: "release.created", subject: "v1" },
      },
      T0 + 100,
    );
    const cFail1 = commit(
      view,
      { type: "claimWork", claimId: "c-f1", capacity: 1 },
      T0 + 200,
    );
    const job = cFail1.value.jobs[0];
    assert.equal(job.session, "sess-prev");

    const retryTime1 = T0 + 300;
    const sub1 = commit(
      view,
      {
        type: "submitResult",
        run: job.run,
        token: job.token,
        result: { outcome: "failed", error: "resume session corrupted" },
      },
      retryTime1,
    );
    assert.equal(sub1.value.requeued, true);
    assert.equal(sub1.value.notBefore, iso(retryTime1 + 2000)); // 1000 * 2^1

    // Attempt 2 starts cleanly (`markStarted`) with `sess-new`, then fails AFTER starting -> must KEEP `sess-new`!
    const tAttempt2 = retryTime1 + 2000;
    const cFail2 = commit(
      view,
      { type: "claimWork", claimId: "c-f2", capacity: 1 },
      tAttempt2,
    );
    assert.equal(cFail2.value.jobs.length, 1);
    assert.equal(
      cFail2.value.jobs[0].session,
      null,
      "pre-start failure must clear stale session to allow clean fresh start",
    );

    commit(
      view,
      {
        type: "markStarted",
        run: job.run,
        token: cFail2.value.jobs[0].token,
        session: "sess-new",
      },
      tAttempt2 + 100,
    );

    // While Attempt 2 is claimed on ("deploy", "v1"), ingest another event so a 2nd queued run exists on ("deploy", "v1").
    // When Attempt 2 fails after markStarted, the 2nd queued run must be merged into retrying run #job.run!
    commit(
      view,
      {
        type: "ingestEvent",
        source: "github",
        event: { id: "r1-extra", type: "release.created", subject: "v1" },
      },
      tAttempt2 + 150,
    );
    assert.equal(
      rows(view, "runs", { rule: "deploy", lane: "v1", status: "queued" })
        .length,
      1,
    );

    // Fail after markStarted -> preserves sess-new, merges r1-extra, and applies 2^2 = 4000ms backoff.
    const retryTime2 = tAttempt2 + 200;
    const sub2 = commit(
      view,
      {
        type: "submitResult",
        run: job.run,
        token: cFail2.value.jobs[0].token,
        result: {
          outcome: "failed",
          error: "transient network error",
          session: "sess-new",
        },
      },
      retryTime2,
    );
    assert.equal(sub2.value.requeued, true);
    assert.equal(sub2.value.notBefore, iso(retryTime2 + 4000));
    assert.equal(
      rows(view, "runs", { rule: "deploy", lane: "v1", status: "queued" })
        .length,
      1,
      "queued run on same (rule, lane) must merge into retrying run",
    );
    assert.equal(rows(view, "run_events", { run_id: job.run }).length, 2);

    // Confirm backoff blocks early claim, then succeeds at notBefore with preserved `sess-new`.
    const tooEarly = commit(
      view,
      { type: "claimWork", claimId: "too-early", capacity: 1 },
      retryTime2 + 3999,
    );
    assert.equal(tooEarly.value.jobs.length, 0);

    // Exhaust attempts up to MAX_ATTEMPTS (10).
    let now = retryTime2 + 4000;
    let currentClaim = commit(
      view,
      { type: "claimWork", claimId: "c-f3", capacity: 1 },
      now,
    );
    assert.equal(currentClaim.value.jobs.length, 1);
    assert.equal(
      currentClaim.value.jobs[0].session,
      "sess-new",
      "post-start failure must preserve started session on retry",
    );
    assert.equal(currentClaim.value.jobs[0].attempt, 3);

    for (let att = 3; att < MAX_ATTEMPTS; att++) {
      now += 100;
      const res = commit(
        view,
        {
          type: "submitResult",
          run: job.run,
          token: currentClaim.value.jobs[0].token,
          result: { outcome: "failed", error: `fail #${att}` },
        },
        now,
      );
      assert.equal(res.value.requeued, true);
      now += Math.min(30 * 60_000, 1000 * 2 ** att);
      currentClaim = commit(
        view,
        { type: "claimWork", claimId: `c-f${att + 1}`, capacity: 1 },
        now,
      );
      assert.equal(currentClaim.value.jobs.length, 1);
    }

    // 10th attempt failure -> terminal `failed` + alert notice card!
    const finalFail = commit(
      view,
      {
        type: "submitResult",
        run: job.run,
        token: currentClaim.value.jobs[0].token,
        result: { outcome: "failed", error: "exhausted" },
      },
      now + 100,
    );
    assert.equal(finalFail.value.requeued, false);
    assert.equal(finalFail.value.status, "failed");
    assert.equal(finalFail.value.cardsCreated.length, 1);
    assert.equal(finalFail.value.cardsCreated[0].kind, "notice");
    assert.equal(finalFail.value.cardsCreated[0].status, "open");
  });

  it("forces stopped runs to cancelled even if child reports failed, and enforces terminal idempotency vs 409 conflict", () => {
    const view = createMemoryView();
    commit(view, { type: "configureRules", config: makeConfig() }, T0);

    // 1. Stopping a queued run cancels immediately.
    commit(
      view,
      {
        type: "ingestEvent",
        source: "github",
        event: { id: "q1", type: "release.created", subject: "q" },
      },
      T0 + 10,
    );
    const qRunId = rows(view, "runs")[0].id as number;
    const stopQ = commit(view, { type: "stopRun", run: qRunId }, T0 + 20);
    assert.equal(stopQ.value.changed, true);
    assert.equal(stopQ.value.run.status, "cancelled");
    assert.equal(
      commit(view, { type: "stopRun", run: qRunId }, T0 + 30).value.changed,
      false,
    );
    assert.throws(
      () => commit(view, { type: "stopRun", run: 99999 }, T0 + 30),
      NotFoundError,
    );

    // 2. Claimed run stopped via stopRun appears in claimWork.cancel and converts `failed` -> `cancelled`.
    commit(
      view,
      {
        type: "ingestEvent",
        source: "github",
        event: { id: "r2", type: "release.created", subject: "run2" },
      },
      T0 + 40,
    );
    const c = commit(
      view,
      { type: "claimWork", claimId: "c-stop", capacity: 1 },
      T0 + 50,
    );
    const job = c.value.jobs[0];

    commit(view, { type: "stopRun", run: job.run }, T0 + 60);
    const hb = commit(
      view,
      { type: "claimWork", claimId: "c-hb", capacity: 1, running: [job.run] },
      T0 + 70,
    );
    assert.deepEqual(hb.value.cancel, [job.run]);

    const subCancelled = commit(
      view,
      {
        type: "submitResult",
        run: job.run,
        token: job.token,
        result: {
          outcome: "failed",
          error: "SIGTERM 143",
          notice: [
            {
              title: "Should not emit",
              text: "Cancelled run must not emit receipts",
            },
          ],
        },
      },
      T0 + 80,
    );
    assert.equal(subCancelled.value.status, "cancelled");
    assert.equal(subCancelled.value.requeued, false);
    assert.equal(rows(view, "cards").length, 0);

    // 3. Terminal idempotency (reordered JSON keys -> same cached response, 0 facts) vs ConflictError (409).
    commit(
      view,
      {
        type: "ingestEvent",
        source: "github",
        event: { id: "r3", type: "release.created", subject: "run3" },
      },
      T0 + 90,
    );
    const c3 = commit(
      view,
      { type: "claimWork", claimId: "c-idem", capacity: 1 },
      T0 + 100,
    );
    const job3 = c3.value.jobs[0];

    const subDone = commit(
      view,
      {
        type: "submitResult",
        run: job3.run,
        token: job3.token,
        result: { outcome: "done", summary: "shipped", session: "s3" },
      },
      T0 + 110,
    );
    assert.equal(subDone.value.status, "done");

    // Reordered keys, semantically identical result -> 0 facts, exact response.
    const replaySub = commit(
      view,
      {
        type: "submitResult",
        run: job3.run,
        token: job3.token,
        result: { session: "s3", summary: "shipped", outcome: "done" },
      },
      T0 + 120,
    );
    assert.equal(replaySub.facts.length, 0);
    assert.deepEqual(replaySub.value, subDone.value);

    // Differing result -> 409 ConflictError!
    assert.throws(
      () =>
        commit(
          view,
          {
            type: "submitResult",
            run: job3.run,
            token: job3.token,
            result: { outcome: "nothing", summary: "changed my mind" },
          },
          T0 + 130,
        ),
      ConflictError,
    );

    // Wrong token -> AuthError.
    assert.throws(
      () =>
        commit(
          view,
          {
            type: "submitResult",
            run: job3.run,
            token: "forged",
            result: { outcome: "done" },
          },
          T0 + 130,
        ),
      AuthError,
    );
  });

  it("enforces receipt card dedup, fyi closed, scoped resolve, answerCard/resolveCard mutual exclusion, and later timers", () => {
    const view = createMemoryView();
    commit(view, { type: "configureRules", config: makeConfig() }, T0);

    // Create an out-of-scope open card in `alerts` (source=ops, group=sec) first.
    commit(
      view,
      {
        type: "ingestEvent",
        source: "ops",
        event: { id: "a1", type: "alert.fired" },
      },
      T0 + 10,
    );
    const cAlert = commit(
      view,
      { type: "claimWork", claimId: "c-alert", capacity: 1 },
      T0 + 20,
    );
    const alertJob = cAlert.value.jobs[0];
    const alertSub = commit(
      view,
      {
        type: "submitResult",
        run: alertJob.run,
        token: alertJob.token,
        result: {
          outcome: "done",
          notice: [{ key: "sec-1", title: "Sec alert", text: "Keep open" }],
        },
      },
      T0 + 30,
    );
    const outOfScopeCardId = alertSub.value.cardsCreated[0].card;

    // Now run `deploy` on v1.
    commit(
      view,
      {
        type: "ingestEvent",
        source: "github",
        event: { id: "d1", type: "release.created", subject: "v1" },
      },
      T0 + 40,
    );
    const cDep1 = commit(
      view,
      { type: "claimWork", claimId: "c-dep1", capacity: 1 },
      T0 + 50,
    );
    const depJob1 = cDep1.value.jobs[0];

    const sub1 = commit(
      view,
      {
        type: "submitResult",
        run: depJob1.run,
        token: depJob1.token,
        result: {
          outcome: "done",
          session: "sess-ask",
          ask: [
            {
              key: "approve-prod",
              title: "Approve deploy?",
              text: "Ready for rollout",
              options: ["Approve", "Rollback"],
              recommend: 0,
              about: "v1 rollout",
            },
          ],
          notice: [
            {
              key: "precheck",
              title: "Precheck passed",
              text: "ok",
              fyi: true,
            },
            {
              key: "staging-up",
              title: "Staging ready",
              text: "check staging",
            },
          ],
          later: [
            {
              key: "poll-health",
              at: iso(T0 + 600_000),
              about: "Check health",
            },
          ],
        },
      },
      T0 + 60,
    );

    assert.equal(sub1.value.cardsCreated.length, 3);
    const askCard = sub1.value.cardsCreated.find((c: any) => c.kind === "ask");
    const fyiCard = sub1.value.cardsCreated.find(
      (c: any) => c.key === "precheck",
    );
    const openNotice = sub1.value.cardsCreated.find(
      (c: any) => c.key === "staging-up",
    );
    assert.equal(askCard.status, "open");
    assert.equal(fyiCard.status, "closed");
    assert.equal(openNotice.status, "open");

    // fyi notice must NOT appear in openInScope!
    const scopedOpen = openInScope(view, "prod", "github");
    assert.equal(
      scopedOpen.some((c) => c.id === fyiCard.card),
      false,
    );

    // Run 2 emits duplicate ask key `approve-prod`, tries to resolve `outOfScopeCardId` + `openNotice`,
    // and cancels `poll-health` timer.
    commit(
      view,
      {
        type: "ingestEvent",
        source: "github",
        event: { id: "d2", type: "release.created", subject: "v1" },
      },
      T0 + 70,
    );
    const cDep2 = commit(
      view,
      { type: "claimWork", claimId: "c-dep2", capacity: 1 },
      T0 + 80,
    );
    const depJob2 = cDep2.value.jobs[0];

    const sub2 = commit(
      view,
      {
        type: "submitResult",
        run: depJob2.run,
        token: depJob2.token,
        result: {
          outcome: "done",
          ask: [
            {
              key: "approve-prod",
              title: "Duplicate ask",
              text: "Should be deduped",
              options: ["Yes", "No"],
              about: "dup",
            },
          ],
          resolve: [
            { card: outOfScopeCardId, reason: "Out of scope attempt" },
            { card: openNotice.card, reason: "Staging verified" },
          ],
          later: [{ key: "poll-health", cancel: true }],
        },
      },
      T0 + 90,
    );

    assert.equal(
      sub2.value.cardsCreated.length,
      0,
      "duplicate open ask key must not create second card",
    );
    assert.deepEqual(sub2.value.cardsResolved, [openNotice.card]);
    assert.equal(sub2.value.rejectedResolves.length, 1);
    assert.equal(sub2.value.rejectedResolves[0].card, outOfScopeCardId);
    assert.equal(
      rows(view, "timers", { rule: "deploy", lane: "v1" }).length,
      0,
    );

    // answerCard with choice=0 transitions ask -> decided and queues wakeup carrying `sess-ask`.
    // Resolving or re-answering a decided card throws ConflictError!
    assert.throws(
      () =>
        commit(
          view,
          { type: "answerCard", card: askCard.card, choice: 99 },
          T0 + 100,
        ),
      InputError,
    );
    const ans = commit(
      view,
      { type: "answerCard", card: askCard.card, choice: 0 },
      T0 + 100,
    );
    assert.equal(ans.value.card.status, "decided");
    assert.equal(ans.value.card.chosen, "Approve");

    assert.throws(
      () =>
        commit(
          view,
          { type: "answerCard", card: askCard.card, text: "second" },
          T0 + 110,
        ),
      ConflictError,
    );
    assert.throws(
      () =>
        commit(
          view,
          {
            type: "resolveCard",
            card: askCard.card,
            reason: "race with answer",
          },
          T0 + 110,
        ),
      ConflictError,
    );

    // Completing the wakeup run transitions the decided card -> done!
    const cWake = commit(
      view,
      { type: "claimWork", claimId: "c-wake", capacity: 1 },
      T0 + 120,
    );
    assert.equal(cWake.value.jobs[0].session, "sess-ask");
    commit(
      view,
      {
        type: "submitResult",
        run: cWake.value.jobs[0].run,
        token: cWake.value.jobs[0].token,
        result: { outcome: "done", summary: "Deployed after approval" },
      },
      T0 + 130,
    );
    assert.equal(view.get("cards", String(askCard.card))?.status, "done");

    // resolveCard twice on open notice throws ConflictError.
    commit(
      view,
      {
        type: "resolveCard",
        card: outOfScopeCardId,
        reason: "Handled manually",
      },
      T0 + 140,
    );
    assert.equal(view.get("cards", String(outOfScopeCardId))?.status, "closed");
    assert.throws(
      () =>
        commit(
          view,
          { type: "resolveCard", card: outOfScopeCardId, reason: "twice" },
          T0 + 150,
        ),
      ConflictError,
    );
  });

  it("tick fires single catchup cron after sleep, unpauses timed rules without backlog, wakes timers with session, and expires leases to unknown while allowing late submit", () => {
    const view = createMemoryView();
    commit(
      view,
      {
        type: "configureRules",
        config: makeConfig({
          rules: [
            {
              name: "hourly",
              when: { cron: "0 * * * *" },
              to: "worker",
              cwd: "/tmp/app",
              prompt: "Hourly job",
            },
            {
              name: "pausedCron",
              when: { cron: "30 * * * *" },
              to: "worker",
              cwd: "/tmp/app",
              prompt: "Paused cron",
            },
            {
              name: "watcher",
              when: { source: "github", types: ["issue.opened"] },
              to: "worker",
              cwd: "/tmp/app",
              prompt: "Watch issue",
              group: "watchgrp",
              parallel: 2,
            },
          ],
        }),
      },
      T0, // 10:00:00Z -> next hourly = 11:00Z, next pausedCron = 10:30Z
    );

    // Pause `pausedCron` until 12:45Z (so 10:30, 11:30, 12:30 fall inside pause window).
    const pauseUntil = Date.parse("2026-11-10T12:45:00.000Z");
    commit(
      view,
      {
        type: "pauseRule",
        rule: "pausedCron",
        reason: "Maint",
        until: iso(pauseUntil),
      },
      T0 + 1000,
    );

    // Watcher starts a run at T0 + 2000 and schedules a `later` timer at 12:50Z with session `sess-timer`,
    // plus starts a second run on another lane whose heartbeat goes stale past RUN_LEASE_MS.
    commit(
      view,
      {
        type: "ingestEvent",
        source: "github",
        event: { id: "w1", type: "issue.opened", subject: "I-1" },
      },
      T0 + 2000,
    );
    commit(
      view,
      {
        type: "ingestEvent",
        source: "github",
        event: { id: "w2", type: "issue.opened", subject: "I-2" },
      },
      T0 + 2000,
    );
    const cw = commit(
      view,
      { type: "claimWork", claimId: "cw", capacity: 2 },
      T0 + 3000,
    );
    const jobTimer = cw.value.jobs.find(
      (j: any) => j.context.events[0].subject === "I-1",
    )!;
    const jobLease = cw.value.jobs.find(
      (j: any) => j.context.events[0].subject === "I-2",
    )!;

    const timerAt = Date.parse("2026-11-10T12:50:00.000Z");
    commit(
      view,
      {
        type: "submitResult",
        run: jobTimer.run,
        token: jobTimer.token,
        result: {
          outcome: "done",
          session: "sess-timer",
          later: [{ key: "recheck", at: iso(timerAt), about: "Recheck I-1" }],
        },
      },
      T0 + 4000,
    );

    // Simulate machine sleeping from 10:05Z until 12:55Z!
    // `hourly` missed 11:00Z and 12:00Z -> must fire ONLY ONCE (12:00Z), advancing next_at to 13:00Z!
    // `pausedCron` unpauses (until=12:45Z <= 12:55Z) and skips 10:30/11:30/12:30 -> next_at=13:30Z, 0 fires!
    // `timer` recheck (12:50Z <= 12:55Z) fires with `sess-timer`!
    // `jobLease` exceeded RUN_LEASE_MS (5m) -> becomes `unknown`!
    const wakeMs = Date.parse("2026-11-10T12:55:00.000Z");
    assert.ok(wakeMs - (T0 + 3000) >= RUN_LEASE_MS);
    const tk = commit(view, { type: "tick" }, wakeMs);

    assert.deepEqual(tk.value.unpaused, ["pausedCron"]);
    assert.deepEqual(tk.value.expiredRuns, [jobLease.run]);
    assert.equal(view.get("runs", String(jobLease.run))?.status, "unknown");

    assert.equal(tk.value.cronFired.length, 1);
    assert.equal(tk.value.cronFired[0].rule, "hourly");
    assert.equal(tk.value.cronFired[0].firedAt, "2026-11-10T12:00:00.000Z");
    assert.equal(tk.value.cronFired[0].nextAt, "2026-11-10T13:00:00.000Z");
    assert.equal(
      view.get("schedules", "pausedCron")?.next_at,
      "2026-11-10T13:30:00.000Z",
    );

    assert.equal(tk.value.timersFired.length, 1);
    assert.equal(tk.value.timersFired[0].key, "recheck");

    // Claiming wakeup run from timer delivers `sess-timer`.
    const cAfter = commit(
      view,
      { type: "claimWork", claimId: "c-after", capacity: 10 },
      wakeMs + 100,
    );
    const wokenJob = cAfter.value.jobs.find(
      (j: any) => j.run === tk.value.timersFired[0].run,
    );
    assert.ok(wokenJob);
    assert.equal(wokenJob.session, "sess-timer");

    // Meanwhile, the lease-expired `unknown` run STILL succeeds on a late `submitResult` with its valid token!
    const lateSubmit = commit(
      view,
      {
        type: "submitResult",
        run: jobLease.run,
        token: jobLease.token,
        result: {
          outcome: "done",
          summary: "Finished right after lease timeout",
        },
      },
      wakeMs + 200,
    );
    assert.equal(lateSubmit.value.status, "done");
    assert.equal(view.get("runs", String(jobLease.run))?.status, "done");
  });

  it("preserves answerCard resume session merged during pre-start retry backoff and pre-start queued merge", () => {
    const view = createMemoryView();
    commit(view, { type: "configureRules", config: makeConfig() }, T0);

    // Case A: answerCard arrives AFTER pre-start failure while run is waiting in backoff.
    // 1. Run 1 emits an ask card carrying `sess-card`.
    commit(
      view,
      {
        type: "ingestEvent",
        source: "github",
        event: { id: "m1", type: "release.created", subject: "lane-a" },
      },
      T0 + 10,
    );
    const c1 = commit(
      view,
      { type: "claimWork", claimId: "ca-1", capacity: 1 },
      T0 + 20,
    );
    const r1Sub = commit(
      view,
      {
        type: "submitResult",
        run: c1.value.jobs[0].run,
        token: c1.value.jobs[0].token,
        result: {
          outcome: "done",
          session: "sess-card",
          ask: [
            {
              key: "need-ok",
              title: "Confirm",
              text: "Continue?",
              options: ["Yes", "No"],
              about: "case A",
            },
          ],
        },
      },
      T0 + 30,
    );
    const cardAId = r1Sub.value.cardsCreated[0].card;

    // 2. Run 2 updates lane latest session to `sess-stale`.
    commit(
      view,
      {
        type: "ingestEvent",
        source: "github",
        event: { id: "m2", type: "release.created", subject: "lane-a" },
      },
      T0 + 40,
    );
    const c2 = commit(
      view,
      { type: "claimWork", claimId: "ca-2", capacity: 1 },
      T0 + 50,
    );
    commit(
      view,
      {
        type: "submitResult",
        run: c2.value.jobs[0].run,
        token: c2.value.jobs[0].token,
        result: { outcome: "done", session: "sess-stale" },
      },
      T0 + 60,
    );

    // 3. Run 3 gets `sess-stale`, fails BEFORE markStarted -> enters backoff with session=null, resume=null.
    commit(
      view,
      {
        type: "ingestEvent",
        source: "github",
        event: { id: "m3", type: "release.created", subject: "lane-a" },
      },
      T0 + 70,
    );
    const c3 = commit(
      view,
      { type: "claimWork", claimId: "ca-3", capacity: 1 },
      T0 + 80,
    );
    assert.equal(c3.value.jobs[0].session, "sess-stale");
    const r3Id = c3.value.jobs[0].run;
    const failAtA = T0 + 90;
    const f3 = commit(
      view,
      {
        type: "submitResult",
        run: r3Id,
        token: c3.value.jobs[0].token,
        result: { outcome: "failed", error: "pre-start crash" },
      },
      failAtA,
    );
    assert.equal(f3.value.requeued, true);

    // 4. Answer ask card during backoff -> merges into Run 3 and records `resume = "sess-card"`.
    const ansA = commit(
      view,
      { type: "answerCard", card: cardAId, choice: 0 },
      failAtA + 100,
    );
    assert.equal(ansA.value.run, r3Id);
    assert.equal(view.get("runs", String(r3Id))?.resume, "sess-card");

    // 5. Claim Attempt #2 after backoff -> must honor `sess-card`, NOT null and NOT `sess-stale`!
    const c3Retry = commit(
      view,
      { type: "claimWork", claimId: "ca-3r", capacity: 1 },
      failAtA + 2000,
    );
    assert.equal(c3Retry.value.jobs.length, 1);
    assert.equal(c3Retry.value.jobs[0].run, r3Id);
    assert.equal(c3Retry.value.jobs[0].attempt, 2);
    assert.equal(c3Retry.value.jobs[0].session, "sess-card");

    // Finish Run 3 so lane-a closes cleanly.
    commit(
      view,
      {
        type: "submitResult",
        run: r3Id,
        token: c3Retry.value.jobs[0].token,
        result: { outcome: "done", session: "sess-card" },
      },
      failAtA + 2100,
    );

    // Case B: answerCard creates a separate queued wakeup run WHILE another run is claimed,
    // then that claimed run fails pre-start and merges the queued wakeup run into itself!
    commit(
      view,
      {
        type: "ingestEvent",
        source: "github",
        event: { id: "mb1", type: "release.created", subject: "lane-b" },
      },
      T0 + 5000,
    );
    const cb1 = commit(
      view,
      { type: "claimWork", claimId: "cb-1", capacity: 1 },
      T0 + 5010,
    );
    const rb1Sub = commit(
      view,
      {
        type: "submitResult",
        run: cb1.value.jobs[0].run,
        token: cb1.value.jobs[0].token,
        result: {
          outcome: "done",
          session: "sess-card-b",
          ask: [
            {
              key: "need-ok-b",
              title: "Confirm B",
              text: "Continue B?",
              options: ["Yes", "No"],
              about: "case B",
            },
          ],
        },
      },
      T0 + 5020,
    );
    const cardBId = rb1Sub.value.cardsCreated[0].card;

    // Start Run B2 with sess-card-b claimed, then answer cardB -> creates queued Run B3 with resume="sess-card-b".
    commit(
      view,
      {
        type: "ingestEvent",
        source: "github",
        event: { id: "mb2", type: "release.created", subject: "lane-b" },
      },
      T0 + 5030,
    );
    const cb2 = commit(
      view,
      { type: "claimWork", claimId: "cb-2", capacity: 1 },
      T0 + 5040,
    );
    const rb2Id = cb2.value.jobs[0].run;
    const ansB = commit(
      view,
      { type: "answerCard", card: cardBId, choice: 0 },
      T0 + 5050,
    );
    assert.notEqual(ansB.value.run, rb2Id);

    // Run B2 fails BEFORE markStarted -> merges Run B3 into Run B2 preserving Run B3's `resume = "sess-card-b"`.
    const failAtB = T0 + 5060;
    commit(
      view,
      {
        type: "submitResult",
        run: rb2Id,
        token: cb2.value.jobs[0].token,
        result: { outcome: "failed", error: "pre-start crash B" },
      },
      failAtB,
    );
    const cb2Retry = commit(
      view,
      { type: "claimWork", claimId: "cb-2r", capacity: 1 },
      failAtB + 2000,
    );
    assert.equal(cb2Retry.value.jobs.length, 1);
    assert.equal(cb2Retry.value.jobs[0].run, rb2Id);
    assert.equal(cb2Retry.value.jobs[0].session, "sess-card-b");
  });
});
