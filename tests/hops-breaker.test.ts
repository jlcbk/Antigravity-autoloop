/**
 * Guards against hop circuit-breaker and `rule.emits` whitelist bypasses:
 * 1. Receipt-derived events resetting `hops` to 0 instead of propagating `maxInputHops + 1`.
 * 2. Pausing/resuming via `ask` (`answerCard`) or `later` (`timers` + `tick`) clearing or corrupting `hops`.
 * 3. Merged multi-event runs failing to take the MAXIMUM input hop across all triggering events.
 * 4. Infinite event loops failing to allow `hops === 8` (`MAX_HOPS`) and break cleanly at `hops === 9` (`> MAX_HOPS`) with zero new dispatches and an open system breaker card.
 * 5. Rules without `emits` or emitting non-whitelisted types either bypassing authorization or aborting valid receipt items.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decide,
  MAX_HOPS,
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
import { createTokenSigner, safeTokenEquals } from "../kernel/store.ts";
import type { RulesConfig } from "../protocol/types.ts";

const MASTER_KEY = "1234567890abcdef".repeat(4);
const TEST_ENV: DecideEnv = {
  signToken: createTokenSigner(MASTER_KEY),
  safeTokenEquals,
};

const T0 = Date.parse("2026-11-10T10:00:00.000Z");

function commit<T = any>(
  view: View,
  input: KernelInput,
  nowMs = T0,
): { facts: ReturnType<typeof decide>["facts"]; value: T } {
  const beforeSeq = view.seq;
  const res = decide<T>(view, input, nowMs, TEST_ENV);
  assert.equal(view.seq, beforeSeq, "decide() must not mutate caller view");
  for (const fact of res.facts) {
    applyFact(view, fact);
  }
  return res;
}

function makeConfig(): RulesConfig {
  return {
    timezone: "UTC",
    askFirst: [],
    sources: {
      loop: { name: "Loop" },
      ext: { name: "External" },
    },
    agents: {
      runner: {
        name: "Runner",
        runner: "agy-print",
        model: "m-hop",
        access: "edit",
        timeoutMinutes: 30,
        maxActive: 4,
      },
    },
    rules: [
      {
        name: "stepper",
        when: { source: "loop", types: ["loop.step", "loop.allowed.*"] },
        to: "runner",
        cwd: "/tmp/loop",
        prompt: "Step forward",
        emits: { source: "loop", types: ["loop.step"] },
      },
      {
        name: "noEmit",
        when: { source: "ext", types: ["ext.noemit"] },
        to: "runner",
        cwd: "/tmp/loop",
        prompt: "No emits allowed",
      },
      {
        name: "restrictedEmit",
        when: { source: "ext", types: ["ext.restricted"] },
        to: "runner",
        cwd: "/tmp/loop",
        prompt: "Only loop.allowed.* allowed",
        emits: { source: "loop", types: ["loop.allowed.*"] },
      },
    ],
  };
}

describe("WP-05 hops propagation and MAX_HOPS circuit breaker", () => {
  it("propagates maxInputHops + 1 across emits, preserves hops across ask and later, allows hops=8, and trips breaker at hops=9", () => {
    const view = createMemoryView();
    commit(view, { type: "configureRules", config: makeConfig() }, T0);

    // Start at hops=0 -> emit derived event -> hops=1
    let now = T0 + 100;
    const ing0 = commit(
      view,
      {
        type: "ingestEvent",
        source: "loop",
        event: { id: "h0", type: "loop.step", subject: "chain-1" },
      },
      now,
    );
    assert.equal(ing0.value.runs.length, 1);

    let claim = commit(
      view,
      { type: "claimWork", claimId: "ch-1", capacity: 1 },
      (now += 10),
    );
    let sub = commit(
      view,
      {
        type: "submitResult",
        run: claim.value.jobs[0].run,
        token: claim.value.jobs[0].token,
        result: {
          outcome: "done",
          events: [{ id: "h1", type: "loop.step", subject: "chain-1" }],
        },
      },
      (now += 10),
    );
    assert.equal(sub.value.eventsEmitted[0].hops, 1);

    // At hops=1 -> ask card -> answerCard preserves hops=1 -> woken run emits derived event at hops=2
    claim = commit(
      view,
      { type: "claimWork", claimId: "ch-ask", capacity: 1 },
      (now += 10),
    );
    sub = commit(
      view,
      {
        type: "submitResult",
        run: claim.value.jobs[0].run,
        token: claim.value.jobs[0].token,
        result: {
          outcome: "done",
          session: "sess-ask-hop",
          ask: [
            {
              key: "confirm-step",
              title: "Continue chain?",
              text: "Step 1 asking",
              options: ["Continue", "Stop"],
              about: "hop chain",
            },
          ],
        },
      },
      (now += 10),
    );
    const askCardId = sub.value.cardsCreated[0].card;
    const ans = commit(
      view,
      { type: "answerCard", card: askCardId, choice: 0 },
      (now += 10),
    );
    const ansEvent = view.get("events", String(ans.value.eventId));
    assert.equal(
      ansEvent?.hops,
      1,
      "answerCard wakeup event must preserve hops=1 without reset",
    );

    claim = commit(
      view,
      { type: "claimWork", claimId: "ch-after-ask", capacity: 1 },
      (now += 10),
    );
    sub = commit(
      view,
      {
        type: "submitResult",
        run: claim.value.jobs[0].run,
        token: claim.value.jobs[0].token,
        result: {
          outcome: "done",
          events: [{ id: "h2", type: "loop.step", subject: "chain-1" }],
        },
      },
      (now += 10),
    );
    assert.equal(sub.value.eventsEmitted[0].hops, 2);

    // At hops=2 -> later timer -> tick fires timer preserving hops=2 -> woken run emits hops=3
    claim = commit(
      view,
      { type: "claimWork", claimId: "ch-later", capacity: 1 },
      (now += 10),
    );
    const timerAt = now + 60_000;
    commit(
      view,
      {
        type: "submitResult",
        run: claim.value.jobs[0].run,
        token: claim.value.jobs[0].token,
        result: {
          outcome: "done",
          session: "sess-later-hop",
          later: [
            { key: "wait-step", at: iso(timerAt), about: "Resume chain" },
          ],
        },
      },
      (now += 10),
    );

    now = timerAt + 10;
    const tk = commit(view, { type: "tick" }, now);
    assert.equal(tk.value.timersFired.length, 1);
    const timerEvent = view.get(
      "events",
      String(tk.value.timersFired[0].eventId),
    );
    assert.equal(
      timerEvent?.hops,
      2,
      "timer wakeup event must preserve hops=2 without reset",
    );

    claim = commit(
      view,
      { type: "claimWork", claimId: "ch-after-later", capacity: 1 },
      (now += 10),
    );
    sub = commit(
      view,
      {
        type: "submitResult",
        run: claim.value.jobs[0].run,
        token: claim.value.jobs[0].token,
        result: {
          outcome: "done",
          events: [{ id: "h3", type: "loop.step", subject: "chain-1" }],
        },
      },
      (now += 10),
    );
    assert.equal(sub.value.eventsEmitted[0].hops, 3);

    // Merged multi-event run must take max(hops) across its input events:
    // Currently a queued run exists from event h3 (hops=3). Merge an event with hops=7 onto the SAME queued run!
    commit(
      view,
      {
        type: "ingestEvent",
        source: "loop",
        event: {
          id: "h7-merge",
          type: "loop.step",
          subject: "chain-1",
          hops: 7,
        },
      },
      (now += 10),
    );
    const runsNow = rows(view, "runs", { rule: "stepper", status: "queued" });
    assert.equal(runsNow.length, 1);

    // Claim and complete -> derived event must be max(3, 7) + 1 = 8 (=== MAX_HOPS -> ALLOWED!).
    claim = commit(
      view,
      { type: "claimWork", claimId: "ch-hop8", capacity: 1 },
      (now += 10),
    );
    sub = commit(
      view,
      {
        type: "submitResult",
        run: claim.value.jobs[0].run,
        token: claim.value.jobs[0].token,
        result: {
          outcome: "done",
          events: [{ id: "h8", type: "loop.step", subject: "chain-1" }],
        },
      },
      (now += 10),
    );
    assert.equal(sub.value.eventsEmitted[0].hops, MAX_HOPS);
    assert.equal(
      sub.value.breakerCards.length,
      0,
      "hops === 8 must still be allowed",
    );

    // Verify hops === 8 run IS claimable and executes, then when it emits hops=9 (> MAX_HOPS), breaker trips!
    const queuedAt8 = rows(view, "runs", { rule: "stepper", status: "queued" });
    assert.equal(queuedAt8.length, 1);
    claim = commit(
      view,
      { type: "claimWork", claimId: "ch-hop9-trigger", capacity: 1 },
      (now += 10),
    );
    assert.equal(claim.value.jobs.length, 1);

    const broken = commit(
      view,
      {
        type: "submitResult",
        run: claim.value.jobs[0].run,
        token: claim.value.jobs[0].token,
        result: {
          outcome: "done",
          events: [{ id: "h9", type: "loop.step", subject: "chain-1" }],
        },
      },
      (now += 10),
    );
    assert.equal(broken.value.eventsEmitted[0].hops, MAX_HOPS + 1);
    assert.equal(broken.value.breakerCards.length, 1);
    assert.equal(broken.value.breakerCards[0].kind, "notice");
    assert.equal(broken.value.breakerCards[0].status, "open");
    assert.equal(broken.value.breakerCards[0].rule, "_system");

    // Critically: zero new runs may be queued for hops === 9!
    assert.equal(rows(view, "runs", { status: "queued" }).length, 0);
    const ev9 = rows(view, "events", { key: "h9" })[0];
    assert.equal(ev9.hops, 9);
    assert.deepEqual(ev9.routed, []);
  });

  it("enforces circuit breaker on direct ingestEvent with hops > MAX_HOPS while allowing hops === MAX_HOPS", () => {
    const view = createMemoryView();
    commit(view, { type: "configureRules", config: makeConfig() }, T0);

    // Direct ingest at hops=8 succeeds and queues a run.
    const ok8 = commit(
      view,
      {
        type: "ingestEvent",
        source: "loop",
        event: { id: "direct-8", type: "loop.step", hops: 8 },
      },
      T0 + 100,
    );
    assert.equal(ok8.value.breakerCard, null);
    assert.equal(ok8.value.runs.length, 1);

    // Direct ingest at hops=9 logs event+seen, dispatches 0 runs, and creates breaker card.
    const brk9 = commit(
      view,
      {
        type: "ingestEvent",
        source: "loop",
        event: { id: "direct-9", type: "loop.step", hops: 9 },
      },
      T0 + 200,
    );
    assert.deepEqual(brk9.value.routed, []);
    assert.deepEqual(brk9.value.runs, []);
    assert.ok(brk9.value.breakerCard);
    assert.equal(brk9.value.breakerCard.kind, "notice");
    assert.equal(brk9.value.breakerCard.status, "open");
    assert.equal(
      rows(view, "runs").length,
      1,
      "must not dispatch any new run at hops=9",
    );

    // Duplicate replay of direct-9 returns duplicate: true with 0 facts and no 2nd breaker card.
    const dup9 = commit(
      view,
      {
        type: "ingestEvent",
        source: "loop",
        event: { id: "direct-9", type: "loop.step", hops: 9 },
      },
      T0 + 300,
    );
    assert.equal(dup9.value.duplicate, true);
    assert.equal(dup9.facts.length, 0);
    assert.equal(rows(view, "cards", { kind: "notice" }).length, 1);
  });

  it("rejects unauthorized rule.emits cleanly in rejectedEvents without aborting valid receipt items", () => {
    const view = createMemoryView();
    commit(view, { type: "configureRules", config: makeConfig() }, T0);

    commit(
      view,
      {
        type: "ingestEvent",
        source: "ext",
        event: { id: "e1", type: "ext.noemit" },
      },
      T0 + 100,
    );
    commit(
      view,
      {
        type: "ingestEvent",
        source: "ext",
        event: { id: "e2", type: "ext.restricted" },
      },
      T0 + 110,
    );

    const claim = commit(
      view,
      { type: "claimWork", claimId: "c-emits", capacity: 10 },
      T0 + 200,
    );
    const jobNoEmit = claim.value.jobs.find(
      (j: any) => j.rule.name === "noEmit",
    )!;
    const jobRestricted = claim.value.jobs.find(
      (j: any) => j.rule.name === "restrictedEmit",
    )!;

    // 1. noEmit tries to emit an event alongside a valid notice -> notice succeeds, event rejected.
    const res1 = commit(
      view,
      {
        type: "submitResult",
        run: jobNoEmit.run,
        token: jobNoEmit.token,
        result: {
          outcome: "done",
          notice: [
            {
              key: "kept",
              title: "Kept notice",
              text: "Valid receipt part must persist",
            },
          ],
          events: [{ id: "unauth-1", type: "loop.step" }],
        },
      },
      T0 + 300,
    );
    assert.equal(res1.value.status, "done");
    assert.equal(res1.value.cardsCreated.length, 1);
    assert.equal(res1.value.eventsEmitted.length, 0);
    assert.deepEqual(res1.value.rejectedEvents, [
      { type: "loop.step", error: "EMITS_NOT_CONFIGURED" },
    ]);
    assert.equal(rows(view, "events", { key: "unauth-1" }).length, 0);

    // 2. restrictedEmit emits one allowed event and one forbidden event -> partial accept/reject works cleanly.
    const res2 = commit(
      view,
      {
        type: "submitResult",
        run: jobRestricted.run,
        token: jobRestricted.token,
        result: {
          outcome: "done",
          events: [
            { id: "allowed-1", type: "loop.allowed.go" },
            { id: "forbid-1", type: "loop.forbidden" },
          ],
        },
      },
      T0 + 400,
    );
    assert.equal(res2.value.eventsEmitted.length, 1);
    assert.equal(res2.value.eventsEmitted[0].id, "allowed-1");
    assert.deepEqual(res2.value.rejectedEvents, [
      { type: "loop.forbidden", error: "EMITS_TYPE_FORBIDDEN" },
    ]);
    assert.equal(rows(view, "events", { key: "allowed-1" }).length, 1);
    assert.equal(rows(view, "events", { key: "forbid-1" }).length, 0);
  });
});
