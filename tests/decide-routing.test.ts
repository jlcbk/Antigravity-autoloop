/**
 * Guards against routing, deduplication, pause/replay, concurrency, and session-resume bugs:
 * 1. Duplicate `${source}:${id}` events double-triggering runs instead of returning cached results cleanly.
 * 2. Wildcard `{ source, types }` or `{ watch }` triggers matching wrong sources or omitting default `["*"]`.
 * 3. Paused rules still queuing runs, or `replayRule` re-executing already-replayed skipped events.
 * 4. Removed rules leaving orphan `queued` runs or stale `schedules` without notifying the user.
 * 5. Queued events failing to merge on `(rule, lane)`, or `claimWork` exceeding `capacity` / `group` parallel / `rule.maxActive` / `agent.maxActive`.
 * 6. `settleSession` reusing a `cancelled` session, double-opening a session busy in `claimed`/`unknown`, or resuming across model/runner changes.
 * 7. `decide()` mutating the caller's `view` during normal execution or on validation errors.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decide, type DecideEnv, type KernelInput } from "../kernel/decide.ts";
import {
  applyFact,
  createMemoryView,
  rows,
  type View,
} from "../kernel/evolve.ts";
import { InputError, NotFoundError } from "../kernel/errors.ts";
import { jobOf, rulesOf, whyOf } from "../kernel/query.ts";
import {
  createTokenSigner,
  openStore,
  safeTokenEquals,
} from "../kernel/store.ts";
import type { RulesConfig } from "../protocol/types.ts";

const MASTER_KEY = "0123456789abcdef".repeat(4);
const signer = createTokenSigner(MASTER_KEY);
const TEST_ENV: DecideEnv = {
  signToken: signer,
  safeTokenEquals,
};

const T0 = Date.parse("2026-11-10T10:00:00.000Z");

function commit<T = any>(
  view: View,
  input: KernelInput,
  nowMs = T0,
  env: DecideEnv = TEST_ENV,
): { facts: ReturnType<typeof decide>["facts"]; value: T } {
  const beforeSeq = view.seq;
  const beforeRunsJson = JSON.stringify(rows(view, "runs"));
  const result = decide<T>(view, input, nowMs, env);
  assert.equal(view.seq, beforeSeq, "decide() must not mutate input view.seq");
  assert.equal(
    JSON.stringify(rows(view, "runs")),
    beforeRunsJson,
    "decide() must not mutate input view tables",
  );
  for (const fact of result.facts) {
    applyFact(view, fact);
  }
  return result;
}

function makeBaseConfig(overrides: Partial<RulesConfig> = {}): RulesConfig {
  return {
    timezone: "UTC",
    askFirst: [],
    sources: {
      github: { name: "GitHub" },
      watch: { name: "Watch" },
      ci: { name: "CI" },
    },
    agents: {
      coder: {
        name: "Coder",
        runner: "agy-print",
        model: "model-alpha",
        access: "edit",
        timeoutMinutes: 30,
        maxActive: 4,
      },
      reviewer: {
        name: "Reviewer",
        runner: "command",
        command: ["node", "-e", "process.exit(0)"],
        access: "read",
        timeoutMinutes: 15,
        maxActive: 1,
      },
    },
    rules: [
      {
        name: "triage",
        when: { source: "github", types: ["issue.opened", "pr.*"] },
        to: "coder",
        cwd: "/tmp/repo",
        prompt: "Triage incoming work.",
        group: "eng",
        parallel: 2,
        resume: true,
      },
    ],
    ...overrides,
  };
}

describe("WP-05 decide routing, dedup, pause/replay, concurrency, and session safety", () => {
  it("deduplicates events by ${source}:${id} and routes {source, types} + {watch} cleanly", () => {
    const view = createMemoryView();
    commit(
      view,
      {
        type: "configureRules",
        config: makeBaseConfig({
          rules: [
            {
              name: "ghPr",
              when: { source: "github", types: ["pr.*"] },
              to: "coder",
              cwd: "/tmp/repo",
              prompt: "Review PR.",
            },
            {
              name: "fileWatch",
              when: { watch: { paths: ["/tmp/repo/docs"] } },
              to: "coder",
              cwd: "/tmp/repo",
              prompt: "Check docs change.",
            },
          ],
        }),
      },
      T0,
    );

    const ev1 = {
      id: "evt-100",
      type: "pr.opened",
      subject: "PR#42",
      summary: "Untrusted summary",
    };

    const first = commit(
      view,
      { type: "ingestEvent", source: "github", event: ev1 },
      T0 + 1000,
    );
    assert.equal(first.value.duplicate, false);
    assert.deepEqual(first.value.routed, ["ghPr"]);
    assert.equal(first.value.runs.length, 1);

    // Repeating exact ${source}:${id} must return duplicate: true with zero facts.
    const dup = commit(
      view,
      { type: "ingestEvent", source: "github", event: ev1 },
      T0 + 2000,
    );
    assert.equal(dup.value.duplicate, true);
    assert.equal(dup.value.eventId, first.value.eventId);
    assert.equal(dup.facts.length, 0);
    assert.equal(rows(view, "runs").length, 1);

    // Same id under a different source is distinct and not deduplicated.
    const otherSource = commit(
      view,
      {
        type: "ingestEvent",
        source: "watch",
        event: {
          id: "evt-100",
          type: "file.changed",
          subject: "docs/a.md",
        },
      },
      T0 + 3000,
    );
    assert.equal(otherSource.value.duplicate, false);
    assert.deepEqual(otherSource.value.routed, ["fileWatch"]);
    assert.equal(rows(view, "runs").length, 2);

    // Non-watch source with "file.changed" must NOT trigger { watch } rule.
    const wrongSource = commit(
      view,
      {
        type: "ingestEvent",
        source: "github",
        event: { id: "evt-101", type: "file.changed" },
      },
      T0 + 4000,
    );
    assert.deepEqual(wrongSource.value.routed, []);
    assert.equal(rows(view, "runs").length, 2);

    // Invalid event payload throws InputError and never mutates view.
    assert.throws(
      () =>
        commit(
          view,
          {
            type: "ingestEvent",
            source: "github",
            event: { id: "", type: "x" },
          },
          T0,
        ),
      InputError,
    );
  });

  it("configureRules validates cron, bumps version, preserves unchanged schedules, and cancels removed rules", () => {
    const view = createMemoryView();

    // Reject bad cron without side effects.
    assert.throws(
      () =>
        commit(
          view,
          {
            type: "configureRules",
            config: makeBaseConfig({
              rules: [
                {
                  name: "badCron",
                  when: { cron: "not a cron" },
                  to: "coder",
                  cwd: "/tmp/repo",
                  prompt: "Never",
                },
              ],
            }),
          },
          T0,
        ),
      InputError,
    );
    assert.equal(view.seq, 0);

    const c1 = commit(
      view,
      {
        type: "configureRules",
        config: makeBaseConfig({
          rules: [
            {
              name: "nightly",
              when: { cron: "0 2 * * *" },
              to: "coder",
              cwd: "/tmp/repo",
              prompt: "Nightly audit.",
            },
            {
              name: "temporary",
              when: { source: "github", types: ["issue.opened"] },
              to: "coder",
              cwd: "/tmp/repo",
              prompt: "Temp rule.",
            },
          ],
        }),
      },
      T0,
    );
    assert.equal(c1.value.version, 1);
    const sched1 = view.get("schedules", "nightly");
    assert.ok(sched1);

    // Queue a run for `temporary` before removing the rule.
    commit(
      view,
      {
        type: "ingestEvent",
        source: "github",
        event: { id: "e-temp", type: "issue.opened" },
      },
      T0 + 500,
    );
    const queuedTemp = rows(view, "runs", { rule: "temporary" });
    assert.equal(queuedTemp.length, 1);
    assert.equal(queuedTemp[0].status, "queued");

    // Reconfigure without `temporary`, keeping `nightly` unchanged.
    const c2 = commit(
      view,
      {
        type: "configureRules",
        config: makeBaseConfig({
          rules: [
            {
              name: "nightly",
              when: { cron: "0 2 * * *" },
              to: "coder",
              cwd: "/tmp/repo",
              prompt: "Nightly audit.",
            },
          ],
        }),
      },
      T0 + 10_000,
    );
    assert.equal(c2.value.version, 2);
    assert.deepEqual(c2.value.removedRules, ["temporary"]);
    assert.deepEqual(c2.value.cancelledRuns, [queuedTemp[0].id]);

    const sched2 = view.get("schedules", "nightly");
    assert.equal(
      sched2?.next_at,
      sched1.next_at,
      "unchanged cron keeps original next_at",
    );

    const updatedTemp = view.get("runs", String(queuedTemp[0].id));
    assert.equal(updatedTemp?.status, "cancelled");
    assert.ok(updatedTemp?.cancel_at);

    const notices = rows(view, "cards", { kind: "notice", status: "open" });
    assert.equal(notices.length, 1);
    assert.match(String(notices[0].title), /temporary/);
  });

  it("pauses rules into skipped, skips cron without backlog, and replays skipped events at most once", () => {
    const view = createMemoryView();
    commit(
      view,
      {
        type: "configureRules",
        config: makeBaseConfig({
          rules: [
            {
              name: "triage",
              when: { source: "github", types: ["issue.opened"] },
              to: "coder",
              cwd: "/tmp/repo",
              prompt: "Triage",
              group: "eng",
              parallel: 2,
            },
          ],
        }),
      },
      T0,
    );

    assert.throws(
      () => commit(view, { type: "pauseRule", rule: "missing" }, T0),
      NotFoundError,
    );

    commit(
      view,
      { type: "pauseRule", rule: "triage", reason: "Deploy window" },
      T0 + 1000,
    );

    commit(
      view,
      {
        type: "ingestEvent",
        source: "github",
        event: { id: "s1", type: "issue.opened", subject: "A" },
      },
      T0 + 2000,
    );
    commit(
      view,
      {
        type: "ingestEvent",
        source: "github",
        event: { id: "s2", type: "issue.opened", subject: "B" },
      },
      T0 + 3000,
    );
    commit(
      view,
      {
        type: "ingestEvent",
        source: "github",
        event: { id: "s3", type: "issue.opened", subject: "C" },
      },
      T0 + 4000,
    );

    assert.equal(
      rows(view, "runs").length,
      0,
      "paused rule must not queue runs",
    );
    assert.equal(rows(view, "skipped").length, 3);

    const resumed = commit(
      view,
      { type: "resumeRule", rule: "triage" },
      T0 + 5000,
    );
    assert.equal(resumed.value.wasPaused, true);
    assert.equal(resumed.value.skipped.length, 3);

    // Replay only >= T0 + 3000 -> s2 and s3.
    const r1 = commit(
      view,
      {
        type: "replayRule",
        rule: "triage",
        since: new Date(T0 + 3000).toISOString(),
      },
      T0 + 6000,
    );
    assert.equal(r1.value.replayedCount, 2);
    assert.equal(r1.value.runs.length, 2);

    // Replay since T0 -> only s1 remains un-replayed!
    const r2 = commit(
      view,
      { type: "replayRule", rule: "triage", since: T0 },
      T0 + 7000,
    );
    assert.equal(r2.value.replayedCount, 1);
    assert.equal(r2.value.runs.length, 1);

    // Repeating replayRule must be a no-op (single replay invariant).
    const r3 = commit(
      view,
      { type: "replayRule", rule: "triage", since: T0 },
      T0 + 8000,
    );
    assert.equal(r3.value.replayedCount, 0);
    assert.equal(r3.value.runs.length, 0);
  });

  it("merges queued events per (rule, lane) and enforces capacity, group parallel, rule.maxActive, and agent.maxActive", () => {
    const view = createMemoryView();
    commit(
      view,
      {
        type: "configureRules",
        config: {
          timezone: "UTC",
          askFirst: [],
          sources: {
            github: { name: "GitHub" },
            ci: { name: "CI" },
          },
          agents: {
            shared: {
              name: "Shared",
              runner: "agy-print",
              model: "m1",
              access: "edit",
              timeoutMinutes: 30,
              maxActive: 4,
            },
            solo: {
              name: "Solo",
              runner: "command",
              command: ["echo", "ok"],
              access: "read",
              timeoutMinutes: 30,
              maxActive: 1,
            },
          },
          rules: [
            {
              name: "serialRule",
              when: { source: "github", types: ["push"] },
              to: "shared",
              cwd: "/tmp/repo",
              prompt: "Handle push",
              group: "g1",
            },
            {
              name: "parallelRule",
              when: { source: "github", types: ["pr.sync"] },
              to: "shared",
              cwd: "/tmp/repo",
              prompt: "Handle PR",
              group: "g2",
              parallel: 3,
              maxActive: 1,
            },
            {
              name: "soloA",
              when: { source: "ci", types: ["build"] },
              to: "solo",
              cwd: "/tmp/repo",
              prompt: "Solo A",
              group: "g3",
            },
            {
              name: "soloB",
              when: { source: "ci", types: ["lint"] },
              to: "solo",
              cwd: "/tmp/repo",
              prompt: "Solo B",
              group: "g4",
            },
          ],
        },
      },
      T0,
    );

    // Two push events with DIFFERENT subjects still merge on lane "" for a serial rule!
    commit(
      view,
      {
        type: "ingestEvent",
        source: "github",
        event: { id: "p1", type: "push", subject: "main" },
      },
      T0 + 100,
    );
    commit(
      view,
      {
        type: "ingestEvent",
        source: "github",
        event: { id: "p2", type: "push", subject: "dev" },
      },
      T0 + 200,
    );
    const serialRuns = rows(view, "runs", { rule: "serialRule" });
    assert.equal(serialRuns.length, 1);
    assert.equal(serialRuns[0].lane, "");
    assert.equal(
      rows(view, "run_events", { run_id: serialRuns[0].id }).length,
      2,
    );

    // Two PR subjects for parallelRule create 2 distinct lanes, but rule.maxActive=1 blocks the second.
    commit(
      view,
      {
        type: "ingestEvent",
        source: "github",
        event: { id: "pr1", type: "pr.sync", subject: "PR-1" },
      },
      T0 + 300,
    );
    commit(
      view,
      {
        type: "ingestEvent",
        source: "github",
        event: { id: "pr2", type: "pr.sync", subject: "PR-2" },
      },
      T0 + 400,
    );

    // Two solo rules on different groups share `solo` agent (maxActive=1).
    commit(
      view,
      { type: "ingestEvent", source: "ci", event: { id: "c1", type: "build" } },
      T0 + 500,
    );
    commit(
      view,
      { type: "ingestEvent", source: "ci", event: { id: "c2", type: "lint" } },
      T0 + 600,
    );

    // capacity = 2 claims serialRule + parallelRule(PR-1) only.
    const claim1 = commit(
      view,
      { type: "claimWork", claimId: "claim-1", capacity: 2 },
      T0 + 700,
    );
    assert.equal(claim1.value.jobs.length, 2);
    assert.deepEqual(
      claim1.value.jobs.map((j: any) => j.rule.name),
      ["serialRule", "parallelRule"],
    );

    // Next claim with plenty of capacity: parallelRule(PR-2) is blocked by rule.maxActive=1,
    // soloA claims, and soloB is blocked by agent.maxActive=1!
    const claim2 = commit(
      view,
      { type: "claimWork", claimId: "claim-2", capacity: 10 },
      T0 + 800,
    );
    assert.equal(claim2.value.jobs.length, 1);
    assert.equal(claim2.value.jobs[0].rule.name, "soloA");

    const pr2Run = rows(view, "runs", {
      rule: "parallelRule",
      lane: "PR-2",
    })[0];
    const soloBRun = rows(view, "runs", { rule: "soloB" })[0];
    const whyPr2 = whyOf(view, Number(pr2Run.id));
    const whySoloB = whyOf(view, Number(soloBRun.id));
    assert.equal(
      whyPr2.run.status,
      "queued",
      "parallelRule PR-2 must remain queued due to rule.maxActive=1",
    );
    assert.equal(
      whySoloB.run.status,
      "queued",
      "soloB must remain queued due to agent.maxActive=1",
    );
    assert.equal(whyPr2.ruleSpec?.maxActive, 1);

    // Finish parallelRule(PR-1) -> now PR-2 can claim; also enqueue serialRule run blocked by group g1 concurrency.
    const pr1Job = claim1.value.jobs[1];
    commit(
      view,
      {
        type: "submitResult",
        run: pr1Job.run,
        token: pr1Job.token,
        result: { outcome: "done" },
      },
      T0 + 850,
    );
    commit(
      view,
      {
        type: "ingestEvent",
        source: "github",
        event: { id: "p3", type: "push", subject: "feat" },
      },
      T0 + 860,
    );
    // serialRule already has 1 claimed in group g1 (parallel default = 1), so p3 stays queued while PR-2 claims!
    const claim3 = commit(
      view,
      { type: "claimWork", claimId: "claim-3", capacity: 10 },
      T0 + 900,
    );
    assert.deepEqual(
      claim3.value.jobs.map((j: any) => j.rule.name),
      ["parallelRule"],
    );
    assert.equal(
      rows(view, "runs", { rule: "serialRule", status: "queued" }).length,
      1,
      "serialRule p3 must wait on group g1 parallel=1 while earlier serialRule run is active",
    );
  });

  it("settleSession resumes done/nothing per lane, excludes cancelled and busy sessions, and invalidates on agent/model changes", () => {
    const view = createMemoryView();
    commit(view, { type: "configureRules", config: makeBaseConfig() }, T0);

    // 1. PR#1 completes done with sess-pr1.
    commit(
      view,
      {
        type: "ingestEvent",
        source: "github",
        event: { id: "g1", type: "issue.opened", subject: "PR#1" },
      },
      T0 + 100,
    );
    const c1 = commit(
      view,
      { type: "claimWork", claimId: "c1", capacity: 1 },
      T0 + 200,
    );
    const job1 = c1.value.jobs[0];
    assert.equal(job1.session, null);
    commit(
      view,
      {
        type: "markStarted",
        run: job1.run,
        token: job1.token,
        session: "sess-pr1",
      },
      T0 + 300,
    );
    commit(
      view,
      {
        type: "submitResult",
        run: job1.run,
        token: job1.token,
        result: { outcome: "done", session: "sess-pr1", summary: "OK" },
      },
      T0 + 400,
    );

    // 2. Next run on PR#1 resumes sess-pr1, starts with sess-cancelled, and is cancelled!
    commit(
      view,
      {
        type: "ingestEvent",
        source: "github",
        event: { id: "g2", type: "issue.opened", subject: "PR#1" },
      },
      T0 + 500,
    );
    const c2 = commit(
      view,
      { type: "claimWork", claimId: "c2", capacity: 1 },
      T0 + 600,
    );
    assert.equal(c2.value.jobs[0].session, "sess-pr1");

    commit(
      view,
      {
        type: "markStarted",
        run: c2.value.jobs[0].run,
        token: c2.value.jobs[0].token,
        session: "sess-cancelled",
      },
      T0 + 650,
    );
    commit(view, { type: "stopRun", run: c2.value.jobs[0].run }, T0 + 700);
    commit(
      view,
      {
        type: "submitResult",
        run: c2.value.jobs[0].run,
        token: c2.value.jobs[0].token,
        result: { outcome: "cancelled", session: "sess-cancelled" },
      },
      T0 + 750,
    );

    // 3. Run 3 on PR#1 must NOT resume `sess-cancelled` (cancelled lane resets to null),
    // and completing Run 3 with `nothing` establishes `sess-pr1-b` for resume.
    commit(
      view,
      {
        type: "ingestEvent",
        source: "github",
        event: { id: "g3", type: "issue.opened", subject: "PR#1" },
      },
      T0 + 800,
    );
    const c3 = commit(
      view,
      { type: "claimWork", claimId: "c3", capacity: 1 },
      T0 + 900,
    );
    assert.equal(
      c3.value.jobs[0].session,
      null,
      "must never resume a cancelled run's session",
    );

    commit(
      view,
      {
        type: "markStarted",
        run: c3.value.jobs[0].run,
        token: c3.value.jobs[0].token,
        session: "sess-pr1-b",
      },
      T0 + 910,
    );

    // 4. Run 3 goes `unknown` after lease timeout, freeing group concurrency while keeping sess-pr1-b locked.
    commit(view, { type: "tick" }, T0 + 910 + 6 * 60_000);
    assert.equal(
      view.get("runs", String(c3.value.jobs[0].run))?.status,
      "unknown",
    );

    // Note: Run 3 is `unknown` (non-terminal), so settleSession skips non-terminal runs when scanning history,
    // OR even if an earlier terminal run held sess-pr1, let's verify active-session collision directly on `sess-pr1`!
    // Complete Run 3 (`nothing`, session `sess-pr1-b`) first, start Run 4 resuming `sess-pr1-b`,
    // timeout Run 4 to `unknown`, then Run 5 on the same lane must get null while Run 4 holds `sess-pr1-b`!
    commit(
      view,
      {
        type: "submitResult",
        run: c3.value.jobs[0].run,
        token: c3.value.jobs[0].token,
        result: { outcome: "nothing", session: "sess-pr1-b" },
      },
      T0 + 910 + 6 * 60_000 + 50,
    );

    commit(
      view,
      {
        type: "ingestEvent",
        source: "github",
        event: { id: "g3b", type: "issue.opened", subject: "PR#1" },
      },
      T0 + 910 + 6 * 60_000 + 80,
    );
    const c3b = commit(
      view,
      { type: "claimWork", claimId: "c3b", capacity: 1 },
      T0 + 910 + 6 * 60_000 + 90,
    );
    assert.equal(
      c3b.value.jobs[0].session,
      "sess-pr1-b",
      "nothing outcome is resumable",
    );
    commit(view, { type: "tick" }, T0 + 910 + 12 * 60_000);
    assert.equal(
      view.get("runs", String(c3b.value.jobs[0].run))?.status,
      "unknown",
    );

    commit(
      view,
      {
        type: "ingestEvent",
        source: "github",
        event: {
          id: "g4",
          type: "issue.opened",
          subject: "PR#1",
        },
      },
      T0 + 910 + 12 * 60_000 + 100,
    );
    const c4 = commit(
      view,
      { type: "claimWork", claimId: "c4", capacity: 2 },
      T0 + 910 + 12 * 60_000 + 200,
    );
    assert.equal(c4.value.jobs.length, 1);
    assert.equal(
      c4.value.jobs[0].session,
      null,
      "must downgrade to null when sess-pr1-b is occupied by an unknown run",
    );

    // Complete unknown run c3b first, then run c4 with sess-fresh.
    commit(
      view,
      {
        type: "submitResult",
        run: c3b.value.jobs[0].run,
        token: c3b.value.jobs[0].token,
        result: { outcome: "done", session: "sess-pr1-b" },
      },
      T0 + 910 + 12 * 60_000 + 300,
    );
    commit(
      view,
      {
        type: "submitResult",
        run: c4.value.jobs[0].run,
        token: c4.value.jobs[0].token,
        result: { outcome: "done", session: "sess-fresh" },
      },
      T0 + 910 + 12 * 60_000 + 400,
    );

    // 5. Changing model invalidates resuming `sess-fresh`.
    const baseCfg = makeBaseConfig();
    commit(
      view,
      {
        type: "configureRules",
        config: makeBaseConfig({
          agents: {
            ...baseCfg.agents,
            coder: { ...baseCfg.agents.coder, model: "model-upgraded" },
          },
        }),
      },
      T0 + 900 + 7 * 60_000,
    );
    commit(
      view,
      {
        type: "runRule",
        rule: "triage",
        subject: "PR#1",
      },
      T0 + 900 + 7 * 60_000 + 100,
    );
    const c5 = commit(
      view,
      { type: "claimWork", claimId: "c5", capacity: 1 },
      T0 + 900 + 7 * 60_000 + 200,
    );
    assert.equal(
      c5.value.jobs[0].session,
      null,
      "changed model must force session = null",
    );
  });

  it("persists facts through openStore SQLite transaction and keeps jobOf/rulesOf consistent", () => {
    const store = openStore(":memory:");
    try {
      const cfg = commitToStore(
        store,
        { type: "configureRules", config: makeBaseConfig() },
        T0,
      );
      assert.equal(cfg.rulesCount, 1);
      assert.ok(rulesOf(store.view));

      const manual = commitToStore(
        store,
        { type: "runRule", rule: "triage", subject: "manual-1" },
        T0 + 100,
      );
      assert.equal(manual.merged, false);

      const claimed = commitToStore(
        store,
        { type: "claimWork", claimId: "store-c1", capacity: 1 },
        T0 + 200,
      );
      assert.equal(claimed.jobs.length, 1);
      const job = jobOf(store.view, claimed.jobs[0].run, claimed.jobs[0].token);
      assert.equal(job.rule.name, "triage");
      assert.equal(job.context.events[0].subject, "manual-1");
    } finally {
      store.close();
    }
  });
});

function commitToStore<T = any>(
  store: ReturnType<typeof openStore>,
  input: KernelInput,
  nowMs: number,
): T {
  const { facts, value } = decide<T>(store.view, input, nowMs, TEST_ENV);
  store.commit(facts);
  return value;
}
