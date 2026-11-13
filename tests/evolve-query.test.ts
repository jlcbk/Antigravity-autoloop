/**
 * Behavioral specification tests for kernel/evolve.ts and kernel/query.ts.
 *
 * Prevents real operational and correctness failures:
 * 1. View fork leakage where draft dry-runs pollute committed state or parent updates leak into forks.
 * 2. High-water mark (`next`) regression on row deletion or non-numeric key corruption (`config: "rules"`).
 * 3. Lexicographical mis-sorting of numeric IDs ("10" before "2") in `rows()`.
 * 4. Over-permissive wildcard matching ("git.*" matching "github.push") or missing lane isolation.
 * 5. Concurrency limit bypass across worker capacity, `(rule, lane)`, `group.parallel` (default 1),
 *    `rule.maxActive`, `agent.maxActive`, or active/expired rule pauses.
 * 6. Cross-scope or post-claim card resolution leakage in `openInScope`, `jobOf`, and `whyOf` causal assembly.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InputError, NotFoundError } from "../kernel/errors.ts";
import {
  applyFact,
  createMemoryView,
  iso,
  rows,
  type Fact,
  type View,
} from "../kernel/evolve.ts";
import {
  canClaimRun,
  cardViewOf,
  groupOf,
  jobOf,
  laneOf,
  openInScope,
  rulesOf,
  runSummaryOf,
  typeMatches,
  whyOf,
} from "../kernel/query.ts";
import type { RulesConfig, RuleSpec } from "../protocol/types.ts";

function makeRulesConfig(overrides?: Partial<RulesConfig>): RulesConfig {
  return {
    timezone: "Asia/Shanghai",
    askFirst: ["deploy", "rm -rf"],
    sources: {
      github: { name: "GitHub" },
      cron: { name: "Cron" },
    },
    agents: {
      workerA: {
        name: "Worker A",
        runner: "agy-print",
        model: "model-alpha",
        access: "edit",
        maxActive: 3,
      },
      workerB: {
        name: "Worker B",
        runner: "command",
        command: ["node", "probe.mjs"],
        maxActive: 1,
      },
    },
    rules: [
      {
        name: "pr-review",
        when: { source: "github", types: ["pr.*"] },
        to: "workerA",
        cwd: "/repo",
        skill: "review",
        prompt: "Review PR",
        title: "PR-{subject}",
        group: "repo-main",
        parallel: 2,
        maxActive: 2,
        emits: { source: "github", types: ["pr.reviewed"] },
      },
      {
        name: "repo-sync",
        when: { source: "github", types: ["push"] },
        to: "workerA",
        cwd: "/repo",
        group: "repo-main",
      },
      {
        name: "daily-brief",
        when: { cron: "0 9 * * *" },
        to: "workerB",
        cwd: "/repo",
      },
    ],
    ...overrides,
  };
}

function seedRules(
  view: View,
  config: RulesConfig,
  seq = 1,
  version = 1,
): void {
  applyFact(view, {
    version: 1,
    seq,
    at: 1_700_000_000_000,
    type: "rules.configured",
    changes: [
      {
        table: "config",
        key: "rules",
        row: {
          id: "rules",
          version,
          value: config,
          updated_at: iso(1_700_000_000_000),
        },
      },
    ],
  });
}

describe("kernel/evolve", () => {
  it("formats deterministic UTC ISO timestamps and rejects non-finite ms", () => {
    assert.equal(iso(0), "1970-01-01T00:00:00.000Z");
    assert.equal(iso(1_700_000_000_123), "2023-11-14T22:13:20.123Z");
    assert.throws(() => iso(Number.NaN), InputError);
    assert.throws(() => iso(Infinity), InputError);
  });

  it("maintains monotonic next high-water marks across sets, deletes, and string-id config rows", () => {
    const view = createMemoryView();
    assert.equal(view.seq, 0);
    assert.deepEqual(view.next, {});

    view.set("config", "rules", { id: "rules", version: 1, value: {} });
    assert.equal(view.next.config, undefined);

    view.set("runs", 1, { id: 1, status: "queued" });
    view.set("runs", "5", { id: 5, status: "queued" });
    view.set("runs", 3, { id: 3, status: "done" });
    assert.equal(view.next.runs, 5);

    // Deleting row 5 must never regress high-water mark
    view.set("runs", 5, null);
    assert.equal(view.get("runs", "5"), undefined);
    assert.equal(view.next.runs, 5);
  });

  it("applies facts sequentially and isolates fork() from both child and parent mutations", () => {
    const parent = createMemoryView();
    const f1: Fact = {
      version: 1,
      seq: 1,
      at: 1000,
      type: "init",
      changes: [
        { table: "events", key: "1", row: { id: 1, type: "a" } },
        { table: "runs", key: "1", row: { id: 1, status: "queued" } },
      ],
    };
    applyFact(parent, f1);
    assert.equal(parent.seq, 1);

    const draft = parent.fork();
    applyFact(draft, {
      version: 1,
      seq: 2,
      at: 2000,
      type: "draft.claim",
      changes: [
        { table: "runs", key: "1", row: { id: 1, status: "claimed" } },
        { table: "runs", key: "2", row: { id: 2, status: "queued" } },
      ],
    });

    // Parent must remain untouched by draft mutations
    assert.equal(parent.seq, 1);
    assert.equal(parent.get("runs", 1)?.status, "queued");
    assert.equal(parent.get("runs", 2), undefined);
    assert.equal(parent.next.runs, 1);

    // Subsequent parent mutations must not leak into the already-taken draft
    applyFact(parent, {
      version: 1,
      seq: 3,
      at: 3000,
      type: "parent.cancel",
      changes: [
        { table: "runs", key: "1", row: { id: 1, status: "cancelled" } },
        { table: "events", key: "2", row: { id: 2, type: "b" } },
      ],
    });

    assert.equal(draft.seq, 2);
    assert.equal(draft.get("runs", 1)?.status, "claimed");
    assert.equal(draft.get("events", 2), undefined);
    assert.equal(draft.next.runs, 2);
  });

  it("sorts integer keys numerically, string keys lexicographically, and supports array filters/limit/reverse", () => {
    const view = createMemoryView();
    // Insert out of numeric order (10 before 2 before 0)
    view.set("runs", "10", { id: 10, status: "done", rule: "r1" });
    view.set("runs", "2", { id: 2, status: "claimed", rule: "r1" });
    view.set("runs", "1", { id: 1, status: "unknown", rule: "r2" });
    view.set("runs", "0", { id: 0, status: "queued", rule: "r1" });

    assert.deepEqual(
      rows(view, "runs").map((r) => r.id),
      [0, 1, 2, 10],
    );
    assert.deepEqual(
      rows(view, "runs", { status: ["claimed", "unknown"] }).map((r) => r.id),
      [1, 2],
    );
    assert.deepEqual(
      rows(view, "runs", { rule: "r1" }, 2, true).map((r) => r.id),
      [10, 2],
    );
    assert.deepEqual(rows(view, "runs", undefined, 0), []);

    // Composite non-integer keys sort lexicographically
    view.set("skipped", "b:2", { id: 1, rule: "b" });
    view.set("skipped", "a:10", { id: 2, rule: "a" });
    view.set("skipped", "a:2", { id: 3, rule: "a" });
    assert.deepEqual(
      rows(view, "skipped").map((r) => r.id),
      [2, 3, 1],
    );
  });
});

describe("kernel/query", () => {
  it("matches exact, full wildcard, and prefix.* event types without false prefix matches", () => {
    assert.equal(typeMatches(["*"], "anything.at.all"), true);
    assert.equal(typeMatches(["git.push"], "git.push"), true);
    assert.equal(typeMatches(["git.push"], "git.pull"), false);
    assert.equal(typeMatches(["git.*"], "git.push"), true);
    assert.equal(typeMatches(["git.*"], "git.branch.ready"), true);
    assert.equal(typeMatches(["git.*"], "github.push"), false);
    assert.equal(typeMatches(["git.*"], "git"), false);
    assert.equal(typeMatches(["git.*"], "git."), false);
    assert.equal(typeMatches([], "git.push"), false);
  });

  it("computes laneOf and groupOf consistently", () => {
    const parallelRule: RuleSpec = {
      name: "r1",
      when: { source: "s", types: ["*"] },
      to: "a",
      cwd: "/tmp",
      group: "g1",
      parallel: 3,
    };
    const serialRule: RuleSpec = {
      name: "r2",
      when: { source: "s", types: ["*"] },
      to: "a",
      cwd: "/tmp",
    };

    assert.equal(laneOf(parallelRule, "pr-1"), "pr-1");
    assert.equal(laneOf(parallelRule, ""), "");
    assert.equal(laneOf(parallelRule), "");
    assert.equal(laneOf(serialRule, "pr-1"), "");

    assert.equal(groupOf(parallelRule), "g1");
    assert.equal(groupOf(serialRule), "r2");
  });

  it("enforces all 7 canClaimRun concurrency, backoff, and pause invariants", () => {
    const now = 1_700_000_060_000;
    const view = createMemoryView();
    assert.equal(rulesOf(view), null);

    const cfg = makeRulesConfig();
    seedRules(view, cfg);
    assert.equal(rulesOf(view)?.version, 1);

    const baseQueuedRun = {
      id: 1,
      rule: "pr-review",
      rules_version: 1,
      agent: "workerA",
      grp: "repo-main",
      lane: "pr-1",
      status: "queued",
      attempts: 0,
      not_before: iso(now),
      created_at: iso(now - 1000),
    };
    view.set("runs", 1, baseQueuedRun);

    // Baseline: claimable
    assert.equal(canClaimRun(view, baseQueuedRun, now, 5), true);

    // Non-queued run cannot be claimed
    assert.equal(
      canClaimRun(view, { ...baseQueuedRun, status: "claimed" }, now, 5),
      false,
    );

    // ① not_before > nowMs
    assert.equal(
      canClaimRun(view, { ...baseQueuedRun, not_before: iso(now + 1) }, now, 5),
      false,
    );

    // ② Active pause (until null or until > nowMs) blocks; expired pause (until <= nowMs) allows
    view.set("pauses", "pr-review", {
      rule: "pr-review",
      reason: "maint",
      paused_at: iso(now - 5000),
      until: null,
    });
    assert.equal(canClaimRun(view, baseQueuedRun, now, 5), false);

    view.set("pauses", "pr-review", {
      rule: "pr-review",
      reason: "maint",
      paused_at: iso(now - 5000),
      until: iso(now + 1000),
    });
    assert.equal(canClaimRun(view, baseQueuedRun, now, 5), false);

    view.set("pauses", "pr-review", {
      rule: "pr-review",
      reason: "maint",
      paused_at: iso(now - 5000),
      until: iso(now),
    });
    assert.equal(canClaimRun(view, baseQueuedRun, now, 5), true);
    view.set("pauses", "pr-review", null);

    // ③ workerCapacity limit
    assert.equal(canClaimRun(view, baseQueuedRun, now, 0), false);
    view.set("runs", 10, {
      id: 10,
      rule: "daily-brief",
      agent: "workerB",
      grp: "daily-brief",
      lane: "",
      status: "claimed",
    });
    assert.equal(canClaimRun(view, baseQueuedRun, now, 1), false);
    assert.equal(canClaimRun(view, baseQueuedRun, now, 5), true);

    // ⑦ agentProfile.maxActive (workerB maxActive = 1) blocks second workerB run
    const runB2 = {
      id: 11,
      rule: "daily-brief",
      agent: "workerB",
      grp: "daily-brief",
      lane: "",
      status: "queued",
      not_before: iso(now),
    };
    assert.equal(canClaimRun(view, runB2, now, 5), false);
    view.set("runs", 10, null);

    // ④ Same (rule, lane) already claimed blocks claim
    view.set("runs", 20, {
      id: 20,
      rule: "pr-review",
      agent: "workerA",
      grp: "repo-main",
      lane: "pr-1",
      status: "claimed",
    });
    assert.equal(canClaimRun(view, baseQueuedRun, now, 5), false);

    // Different lane in same group (parallel = 2) is allowed
    const runPr2 = { ...baseQueuedRun, id: 2, lane: "pr-2" };
    assert.equal(canClaimRun(view, runPr2, now, 5), true);

    // ⑤ Rule without parallel in same group (repo-sync: parallel ?? 1 = 1) is blocked when group already has 1 claimed
    const runRepoSync = {
      id: 3,
      rule: "repo-sync",
      agent: "workerA",
      grp: "repo-main",
      lane: "",
      status: "queued",
      not_before: iso(now),
    };
    assert.equal(canClaimRun(view, runRepoSync, now, 5), false);

    // ⑤ & ⑥ Second claimed run in repo-main hits parallel=2 and rule.maxActive=2, blocking a 3rd lane
    view.set("runs", 21, {
      id: 21,
      rule: "pr-review",
      agent: "workerA",
      grp: "repo-main",
      lane: "pr-2",
      status: "claimed",
    });
    const runPr3 = { ...baseQueuedRun, id: 4, lane: "pr-3" };
    assert.equal(canClaimRun(view, runPr3, now, 5), false);

    // Rule maxActive = 1 blocks even when group parallel is higher
    const cfgStrictRule = makeRulesConfig({
      rules: [
        {
          name: "pr-review",
          when: { source: "github", types: ["pr.*"] },
          to: "workerA",
          cwd: "/repo",
          group: "repo-main",
          parallel: 4,
          maxActive: 1,
        },
      ],
    });
    seedRules(view, cfgStrictRule, 2, 2);
    view.set("runs", 21, null);
    assert.equal(canClaimRun(view, runPr2, now, 5), false);
  });

  it("filters openInScope by grp, source (including null), status, and beforeIso cutoff", () => {
    const view = createMemoryView();
    view.set("cards", 1, {
      id: 1,
      grp: "g1",
      source: "github",
      status: "open",
      created_at: iso(1000),
    });
    view.set("cards", 2, {
      id: 2,
      grp: "g1",
      source: "github",
      status: "open",
      created_at: iso(2000),
    });
    view.set("cards", 3, {
      id: 3,
      grp: "g1",
      source: "github",
      status: "open",
      created_at: iso(3000),
    });
    view.set("cards", 4, {
      id: 4,
      grp: "g1",
      source: null,
      status: "open",
      created_at: iso(1500),
    });
    view.set("cards", 5, {
      id: 5,
      grp: "g2",
      source: "github",
      status: "open",
      created_at: iso(1500),
    });
    view.set("cards", 6, {
      id: 6,
      grp: "g1",
      source: "github",
      status: "closed",
      created_at: iso(1500),
    });

    assert.deepEqual(
      openInScope(view, "g1", "github", iso(2000)).map((c) => c.id),
      [1, 2],
    );
    assert.deepEqual(
      openInScope(view, "g1", null, iso(2000)).map((c) => c.id),
      [4],
    );
    assert.deepEqual(
      openInScope(view, "g1", "github").map((c) => c.id),
      [1, 2, 3],
    );
  });

  it("transforms CardView and RunSummary cleanly and assembles full Job and WhyReport", () => {
    const view = createMemoryView();
    seedRules(view, makeRulesConfig());

    // Triggering event, answer event, timer event
    view.set("events", 1, {
      id: 1,
      source: "github",
      key: "gh-pr-42",
      type: "pr.opened",
      subject: "PR#42",
      summary: "Untrusted summary",
      detail: "Untrusted detail",
      link: "https://example.com/pr/42",
      hops: 1,
      routed: ["pr-review"],
      paused: [],
      received_at: iso(1000),
    });
    view.set("events", 2, {
      id: 2,
      source: "github",
      key: "ans-card-10",
      type: "card.answered",
      subject: "PR#42",
      summary: "",
      detail: "",
      link: "",
      hops: 1,
      routed: ["pr-review"],
      paused: [],
      received_at: iso(2000),
    });
    view.set("events", 3, {
      id: 3,
      source: "github",
      key: "tmr-5",
      type: "timer.due",
      subject: "PR#42",
      summary: "",
      detail: "",
      link: "",
      hops: 1,
      routed: ["pr-review"],
      paused: [],
      received_at: iso(3000),
    });

    // Run 7 (claimed at 4000, done at 5000)
    view.set("runs", 7, {
      id: 7,
      rule: "pr-review",
      rules_version: 1,
      agent: "workerA",
      grp: "repo-main",
      lane: "PR#42",
      status: "done",
      attempts: 1,
      claim: "w-1",
      token: "tok-7",
      last_result: {
        outcome: "done",
        summary: "Reviewed and asked",
        resolve: [
          { card: 11, reason: "already fixed" },
          { card: 99, reason: "out of scope" },
        ],
        events: [{ id: "em-1", type: "pr.reviewed", subject: "PR#42" }],
      },
      last_response: {
        rejectedResolves: [
          { card: 99, reason: "out of scope", error: "NOT_IN_SCOPE" },
        ],
        rejectedEvents: [],
      },
      cancel_at: null,
      resume: "sess-prev",
      session: "sess-7",
      summary: "Reviewed and asked",
      error: null,
      usage: { input: 100, output: 50, cached: 20, cost: 0.01 },
      manual: false,
      created_at: iso(3500),
      not_before: iso(3500),
      claimed_at: iso(4000),
      started_at: iso(4100),
      heartbeat_at: iso(4500),
      ended_at: iso(5000),
      timeline: [
        { at: iso(3500), kind: "queued", detail: "queued by event" },
        { at: iso(5000), kind: "done", detail: "completed" },
      ],
    });

    view.set("run_events", "7:1", { run_id: 7, event_id: 1 });
    view.set("run_events", "7:2", { run_id: 7, event_id: 2 });
    view.set("run_events", "7:3", { run_id: 7, event_id: 3 });

    // Card 10: answered ask card that woke run 7
    view.set("cards", 10, {
      id: 10,
      key: "ask-merge",
      kind: "ask",
      status: "decided",
      rule: "pr-review",
      lane: "PR#42",
      grp: "repo-main",
      source: "github",
      agent: "workerA",
      session: "sess-prev",
      run_id: 6,
      title: "Merge PR?",
      text: "Please confirm",
      options: ["Yes", "No"],
      recommend: 0,
      about: "Approval",
      fyi: false,
      choice: 0,
      chosen: "Yes",
      answer_text: null,
      resolved_reason: null,
      answer_event: 2,
      version: 1,
      created_at: iso(1500),
      decided_at: iso(2000),
      closed_at: null,
    });

    // Card 11: open card before claimed_at (4000)
    view.set("cards", 11, {
      id: 11,
      key: "open-before",
      kind: "notice",
      status: "open",
      rule: "repo-sync",
      lane: "",
      grp: "repo-main",
      source: "github",
      agent: "workerA",
      session: null,
      run_id: 5,
      title: "Sync warning",
      text: "Check conflict",
      options: [],
      about: "",
      fyi: false,
      choice: null,
      chosen: null,
      answer_text: null,
      resolved_reason: null,
      answer_event: null,
      version: 1,
      created_at: iso(2500),
      decided_at: null,
      closed_at: null,
    });

    // Card 12: created BY run 7 (after claimed_at 4000)
    view.set("cards", 12, {
      id: 12,
      key: "fyi-done",
      kind: "notice",
      status: "closed",
      rule: "pr-review",
      lane: "PR#42",
      grp: "repo-main",
      source: "github",
      agent: "workerA",
      session: "sess-7",
      run_id: 7,
      title: "Done FYI",
      text: "All good",
      options: [],
      about: "",
      fyi: true,
      choice: null,
      chosen: null,
      answer_text: null,
      resolved_reason: null,
      answer_event: null,
      version: 1,
      created_at: iso(5000),
      decided_at: null,
      closed_at: iso(5000),
    });

    // Timer 5 (fired, linked to event 3) & Timer 6 (waiting)
    view.set("timers", 5, {
      id: 5,
      rule: "pr-review",
      lane: "PR#42",
      key: "recheck",
      source: "github",
      agent: "workerA",
      session: "sess-prev",
      about: "Check CI",
      at: iso(3000),
      event_id: 3,
      created_at: iso(1200),
    });
    view.set("timers", 6, {
      id: 6,
      rule: "pr-review",
      lane: "PR#42",
      key: "followup",
      source: "github",
      agent: "workerA",
      session: "sess-7",
      about: "Check merge",
      at: iso(9000),
      event_id: null,
      created_at: iso(4200),
    });

    const cv10 = cardViewOf(view.get("cards", 10)!);
    assert.equal(cv10.card, 10);
    assert.equal(cv10.chosen, "Yes");
    assert.equal(cv10.answerText, undefined);
    assert.equal(cv10.run, 6);

    const cv12 = cardViewOf(view.get("cards", 12)!);
    assert.equal(cv12.fyi, true);
    assert.equal(cv12.options, undefined);

    const summary = runSummaryOf(view, view.get("runs", 7)!);
    assert.equal(summary.run, 7);
    assert.equal(summary.runner, "agy-print");
    assert.equal(summary.model, "model-alpha");
    assert.equal(summary.attempt, 1);
    assert.equal(summary.usage?.cached, 20);

    const job = jobOf(view, 7, "tok-7");
    assert.equal(job.run, 7);
    assert.equal(job.token, "tok-7");
    assert.equal(job.attempt, 1);
    assert.equal(job.agent.id, "workerA");
    assert.deepEqual(job.askFirst, ["deploy", "rm -rf"]);
    assert.equal(job.context.events.length, 3);
    assert.equal(job.context.events[0]?.id, "gh-pr-42");
    assert.equal(job.context.events[0]?.sourceName, "GitHub");
    assert.equal(job.context.events[1]?.summary, undefined);
    assert.equal(job.context.answers.length, 1);
    assert.equal(job.context.answers[0]?.card, 10);
    assert.equal(job.context.timers.length, 1);
    assert.equal(job.context.timers[0]?.key, "recheck");
    assert.equal(job.context.waiting.length, 1);
    assert.equal(job.context.waiting[0]?.key, "followup");
    assert.deepEqual(
      job.context.open.map((c) => c.card),
      [11],
    );
    assert.deepEqual(
      job.context.decided.map((c) => c.card),
      [10],
    );

    const why = whyOf(view, 7);
    assert.equal(why.run.run, 7);
    assert.equal(why.ruleVersion, 1);
    assert.equal(why.ruleSpec?.parallel, 2);
    assert.equal(why.events[0]?.seq, 1);
    assert.equal(why.events[0]?.id, "gh-pr-42");
    assert.equal(why.answers[0]?.card, 10);
    assert.equal(why.timers[0]?.key, "recheck");
    assert.equal(why.receipt?.rejectedResolves?.length, 1);
    assert.deepEqual(
      why.cardsCreated.map((c) => c.card),
      [12],
    );
    assert.deepEqual(why.cardsResolved, [11]);
    assert.equal(why.eventsEmitted.length, 1);
    assert.equal(why.eventsEmitted[0]?.source, "github");
    assert.equal(why.eventsEmitted[0]?.hops, 2);
    assert.equal(why.timeline.length, 2);

    assert.throws(() => whyOf(view, 999), NotFoundError);
    assert.throws(() => jobOf(view, 999, "tok"), NotFoundError);
  });

  it("handles fallback runner, free-text card answers, and synthesized why timelines", () => {
    const view = createMemoryView();
    seedRules(view, makeRulesConfig());

    view.set("cards", 1, {
      id: 1,
      key: "free-text",
      kind: "ask",
      status: "decided",
      rule: "pr-review",
      lane: "",
      grp: "repo-main",
      source: "github",
      agent: "workerA",
      session: null,
      run_id: 1,
      title: "Custom input?",
      text: "Type answer",
      options: ["A", "B"],
      about: "Need input",
      fyi: false,
      choice: null,
      chosen: "custom response",
      answer_text: "custom response",
      resolved_reason: null,
      answer_event: null,
      version: 1,
      created_at: iso(1000),
      decided_at: iso(2000),
      closed_at: null,
    });

    const cv = cardViewOf(view.get("cards", 1)!);
    assert.equal(cv.choice, null);
    assert.equal(cv.answerText, "custom response");
    assert.equal(cv.chosen, "custom response");

    view.set("runs", 1, {
      id: 1,
      rule: "pr-review",
      rules_version: 1,
      agent: "removed-agent",
      grp: "repo-main",
      lane: "",
      status: "cancelled",
      attempts: 1,
      session: "sess-1",
      error: "stopped by user",
      created_at: iso(1000),
      not_before: iso(1000),
      claimed_at: iso(1100),
      started_at: iso(1200),
      cancel_at: iso(1300),
      ended_at: iso(1400),
    });

    const summary = runSummaryOf(view, view.get("runs", 1)!);
    assert.equal(summary.runner, "command");
    assert.equal(summary.model, undefined);

    const why = whyOf(view, 1);
    assert.deepEqual(
      why.timeline.map((t) => t.kind),
      ["queued", "claimed", "started", "cancel_requested", "cancelled"],
    );
  });
});
