/**
 * V1.1 Kernel, Protocol, Cross-Process Store & Notification Loop Tests (WP-A).
 *
 * 防止的真实故障与安全越界：
 * 1. CLI / MCP 离线回退直接写 hub.db 后，常驻 HubRuntime 内存 seq 落后导致 UNIQUE constraint failed: facts.seq 永久瘫痪，
 *    或 openStore 无事务 DROP VIEW 引发跨连接锁竞争；
 * 2. 模型首行输出加粗/标题/列表前缀（如 **没跑成：**、### NOTHING:）被误判为 done，正文中未闭合代码块吞掉末尾合法
 *    agent-autoloop 回执，或外部 file:// 链接拼入提示词、同 group 不同 parallel 引发并发配额歧义、省略 askFirst 失去默认红线；
 * 3. 同一并发组跨规则在同一事项（grp + lane）上并发双跑踩踏工作区，或卡片转 done 后丢失跨轮复查已决记忆与 approvedKeys；
 * 4. 瞬时故障秒级重试打爆配额、连续 3 次失败静默无预警、多行堆栈撑爆卡片或截断 UTF-16 代理对，以及恢复后预警卡悬空不关；
 * 5. tell: "always" 规则静默完成无简报无通知、通知缺少 [<rule>] 来源标识，或已触发 timers 在唤醒轮次终态后永久残留内存。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { writeRunFiles } from "../engine/context-file.ts";
import {
  decide,
  MAX_ATTEMPTS,
  type DecideEnv,
  type KernelInput,
} from "../kernel/decide.ts";
import { applyFact, createMemoryView, iso, rows, type View } from "../kernel/evolve.ts";
import { canClaimRun, jobOf, whyOf } from "../kernel/query.ts";
import {
  createTokenSigner,
  openStore,
  safeTokenEquals,
} from "../kernel/store.ts";
import { promptFor, readMessage } from "../protocol/receipt.ts";
import { parseRulesConfig } from "../protocol/rules-schema.ts";
import type { Job, RulesConfig } from "../protocol/types.ts";
import { ProtocolInputError, parseInboundEvent } from "../protocol/validate.ts";
import { HubRuntime } from "../sidecars/hub/ipc-server.ts";
import { createNotifier, shouldNotifyCard } from "../sidecars/hub/notifier.ts";
import {
  assertInvariants,
  InvariantViolationError,
} from "../sim/invariants.ts";

const MASTER_KEY = "a1b2c3d4e5f60718".repeat(4);
const SIGNER = createTokenSigner(MASTER_KEY);
const BASE_ENV: DecideEnv = {
  signToken: SIGNER,
  safeTokenEquals,
};
const T0 = Date.parse("2026-11-19T02:00:00.000Z");

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(path.join(os.tmpdir(), "autoloop-v11-a-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withTempDirAsync<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "autoloop-v11-a-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function stepView<T = any>(
  view: View,
  input: KernelInput,
  nowMs: number,
  env: DecideEnv = BASE_ENV,
): T {
  const res = decide<T>(view, input, nowMs, env);
  for (const fact of res.facts) {
    applyFact(view, fact);
  }
  return res.value;
}

function makeBaseConfig(overrides: Partial<RulesConfig> = {}): RulesConfig {
  return {
    timezone: "UTC",
    askFirst: ["rm -rf"],
    sources: {
      github: { name: "GitHub" },
      ci: { name: "CI" },
    },
    agents: {
      worker: {
        name: "Worker",
        runner: "agy-print",
        model: "m-alpha",
        access: "edit",
        maxActive: 4,
      },
    },
    rules: [
      {
        name: "triage",
        when: { source: "github", types: ["issue.*", "pr.*"] },
        to: "worker",
        cwd: "/tmp/repo",
        skill: "recipe-issue-triage",
        group: "eng",
        parallel: 2,
        resume: true,
      },
    ],
    ...overrides,
  };
}

describe("P0: Cross-process SQLite commitLatest & HubRuntime catch-up", () => {
  it("incrementally catches up external facts inside BEGIN IMMEDIATE without UNIQUE seq collisions", async () => {
    await withTempDirAsync(async (home) => {
      let nowMs = T0;
      const runtime = new HubRuntime({
        autoloopHome: home,
        enableSupervisor: false,
        now: () => nowMs,
        notifierOptions: { silent: true },
      });

      try {
        runtime.configureRules(makeBaseConfig());
        assert.equal(runtime.store.view.seq, 1);

        // Simulate external CLI/MCP process opening hub.db directly and appending 2 facts
        const dbPath = path.join(home, "hub.db");
        const extStore = openStore(dbPath);
        try {
          assert.equal(extStore.view.seq, 1);
          nowMs += 1_000;
          const r1 = decide(
            extStore.view,
            {
              type: "ingestEvent",
              source: "github",
              event: { id: "ext-1", type: "issue.opened", subject: "PR-1" },
            },
            nowMs,
            BASE_ENV,
          );
          extStore.commit(r1.facts);

          nowMs += 1_000;
          const r2 = decide(
            extStore.view,
            {
              type: "pauseRule",
              rule: "triage",
              reason: "external CLI pause",
            },
            nowMs,
            BASE_ENV,
          );
          extStore.commit(r2.facts);
          assert.equal(extStore.view.seq, 3);
        } finally {
          extStore.close();
        }

        // HubRuntime's in-memory seq is still 1 before dispatch; next dispatch must catch up seq 2..3
        // inside BEGIN IMMEDIATE, observe that `triage` was externally paused, and write seq 4 cleanly!
        assert.equal(runtime.store.view.seq, 1);
        nowMs += 1_000;
        const emitRes = runtime.ingestEvent("github", {
          id: "hub-after-ext",
          type: "issue.opened",
          subject: "PR-2",
        });

        assert.deepEqual(emitRes.paused, ["triage"]);
        assert.equal(runtime.store.view.seq, 4);
        assertInvariants(runtime.store, { nowMs, workerCapacity: 4 });
      } finally {
        await runtime.close();
      }
    });
  });

  it("supports commitLatest returning null while still catching up external facts and avoids DROP VIEW on hydrated openStore", () => {
    withTempDir((dir) => {
      const dbPath = path.join(dir, "hub.db");
      const storeA = openStore(dbPath);
      const storeB = openStore(dbPath);
      try {
        const cfgRes = decide(
          storeA.view,
          { type: "configureRules", config: makeBaseConfig() },
          T0,
          BASE_ENV,
        );
        storeA.commit(cfgRes.facts);
        assert.equal(storeA.view.seq, 1);
        assert.equal(storeB.view.seq, 0);

        // storeB calls commitLatest returning null -> catches up seq 1 without inserting a new fact
        const nullFact = storeB.commitLatest((latestView) => {
          assert.equal(latestView.seq, 1);
          return null;
        });
        assert.equal(nullFact, null);
        assert.equal(storeB.view.seq, 1);
        assertInvariants(storeB, { nowMs: T0, workerCapacity: 4 });
      } finally {
        storeA.close();
        storeB.close();
      }
    });
  });
});

describe("P0: Protocol, receipt parsing, prompt anti-error hints & rules schema", () => {
  it("strips Markdown decorators from first-line outcome prefixes without misclassifying as done", () => {
    const cases: Array<{
      input: string;
      outcome: "failed" | "nothing" | "done";
      summary: string;
    }> = [
      {
        input: "**没跑成：** 数据库连接超时",
        outcome: "failed",
        summary: "数据库连接超时",
      },
      {
        input: "**没跑成**：镜像拉取失败",
        outcome: "failed",
        summary: "镜像拉取失败",
      },
      {
        input: "**FAILED:** upstream returned 502",
        outcome: "failed",
        summary: "upstream returned 502",
      },
      {
        input: "- 没事可做：没有待清理死代码",
        outcome: "nothing",
        summary: "没有待清理死代码",
      },
      {
        input: "### NOTHING: all checks green",
        outcome: "nothing",
        summary: "all checks green",
      },
      {
        input: "> *failed*: sandbox denied network",
        outcome: "failed",
        summary: "sandbox denied network",
      },
      {
        input: "正常完成代码清理。",
        outcome: "done",
        summary: "正常完成代码清理。",
      },
    ];

    for (const c of cases) {
      const parsed = readMessage(c.input);
      assert.equal(parsed.outcome, c.outcome, `input: ${c.input}`);
      assert.equal(parsed.summary, c.summary, `input: ${c.input}`);
      assert.equal(parsed.problem, null);
    }
  });

  it("extracts trailing closed agent-autoloop receipt even when earlier prose has an unclosed code fence", () => {
    const withUnclosedLangFence = [
      "已完成排查并提交请示。",
      "",
      "日志中截断的报错片段如下：",
      "```ts",
      "export function broken() {",
      "  const x = 1;",
      "",
      "```agent-autoloop",
      '{"notice":[{"key":"ok","title":"完成","text":"已输出回执","fyi":true}]}',
      "```",
    ].join("\n");

    const parsed1 = readMessage(withUnclosedLangFence);
    assert.equal(parsed1.outcome, "done");
    assert.equal(parsed1.problem, null);
    assert.equal(parsed1.receipt?.notice?.[0]?.key, "ok");

    const withUnclosedBareFence = [
      "没事可做：无需改动",
      "```",
      "unclosed bare fence in explanation",
      "```agent-autoloop",
      '{"later":[{"key":"t1","cancel":true}]}',
      "```",
    ].join("\n");

    const parsed2 = readMessage(withUnclosedBareFence);
    assert.equal(parsed2.outcome, "nothing");
    assert.equal(parsed2.problem, null);
    assert.deepEqual(parsed2.receipt?.later, [{ key: "t1", cancel: true }]);

    // Still catches a genuinely unclosed agent-autoloop fence at the end
    const genuinelyUnclosed = [
      "已完成分析",
      "```agent-autoloop",
      '{"notice":[{"title":"t","text":"x"}]}',
    ].join("\n");
    const parsed3 = readMessage(genuinelyUnclosed);
    assert.equal(parsed3.receipt, null);
    assert.match(parsed3.problem ?? "", /未闭合/);
  });

  it("includes 3 high-frequency anti-error hints and resumed-session Skill re-read reminder in promptFor", () => {
    const baseJob: Job = {
      run: 5,
      token: "tok-5",
      attempt: 1,
      rule: {
        name: "triage",
        cwd: "/tmp/repo",
        skill: "recipe-issue-triage",
      },
      agent: {
        id: "worker",
        name: "Worker",
        runner: "agy-print",
        access: "edit",
      },
      session: "conv-existing-99",
      askFirst: ["对外发送消息"],
      context: {
        events: [],
        answers: [],
        timers: [],
        waiting: [],
        open: [],
        decided: [],
      },
    };

    const promptResumed = promptFor(baseJob, "/tmp/ctx.json");
    assert.match(promptResumed, /200/);
    assert.match(promptResumed, /http:\/\/.*https:\/\/|https?:\/\//);
    assert.match(promptResumed, /cancel.*true/);
    assert.match(promptResumed, /at.*about|about.*at/);
    assert.match(promptResumed, /重新阅读.*Skill|最新 Skill/);

    const promptFresh = promptFor({ ...baseJob, session: null }, "/tmp/ctx.json");
    assert.equal(promptFresh.includes("续接会话："), false);
  });

  it("applies 7 default askFirst redlines when omitted, preserves explicit [], and rejects conflicting group parallel", () => {
    const omittedAskFirst = parseRulesConfig({
      sources: { github: { name: "GitHub" } },
      agents: { worker: { name: "Worker", runner: "agy-print" } },
      rules: [
        {
          name: "r1",
          when: { source: "github", types: ["*"] },
          to: "worker",
          cwd: "/tmp/repo",
        },
      ],
    });
    assert.deepEqual(omittedAskFirst.askFirst, [
      "rm -rf",
      "git push --force",
      "git reset --hard",
      "删除数据库",
      "对外发送消息",
      "修改密钥或权限",
      "产生实质费用",
    ]);

    const explicitEmpty = parseRulesConfig({
      askFirst: [],
      sources: { github: { name: "GitHub" } },
      agents: { worker: { name: "Worker", runner: "agy-print" } },
      rules: [
        {
          name: "r1",
          when: { source: "github", types: ["*"] },
          to: "worker",
          cwd: "/tmp/repo",
        },
      ],
    });
    assert.deepEqual(explicitEmpty.askFirst, []);

    assert.throws(
      () =>
        parseRulesConfig({
          askFirst: [],
          sources: { github: { name: "GitHub" } },
          agents: { worker: { name: "Worker", runner: "agy-print" } },
          rules: [
            {
              name: "r1",
              when: { source: "github", types: ["issue.*"] },
              to: "worker",
              cwd: "/tmp/repo",
              group: "shared-grp",
              parallel: 2,
            },
            {
              name: "r2",
              when: { source: "github", types: ["pr.*"] },
              to: "worker",
              cwd: "/tmp/repo",
              group: "shared-grp",
              parallel: 3,
            },
          ],
        }),
      ProtocolInputError,
    );
  });

  it("restricts InboundEvent.link strictly to http:// or https://", () => {
    const okHttp = parseInboundEvent({
      id: "e-http",
      type: "ping",
      link: "http://127.0.0.1:8080/health",
    });
    assert.equal(okHttp.link, "http://127.0.0.1:8080/health");

    const okHttps = parseInboundEvent({
      id: "e-https",
      type: "ping",
      link: "https://github.com/org/repo/pull/1",
    });
    assert.equal(okHttps.link, "https://github.com/org/repo/pull/1");

    for (const badLink of [
      "file:///etc/passwd",
      "file:///Users/demo/README.md",
      "javascript:alert(1)",
      "data:text/html,evil",
    ]) {
      assert.throws(
        () => parseInboundEvent({ id: "e-bad", type: "ping", link: badLink }),
        ProtocolInputError,
        `expected ${badLink} to be rejected`,
      );
    }
  });
});

describe("P1: Kernel state-machine & notification loop closures", () => {
  it("enforces cross-rule mutual exclusion on the same (grp, lane) in canClaimRun and INV-05", () => {
    const view = createMemoryView();
    const cfg = makeBaseConfig({
      rules: [
        {
          name: "rule-a",
          when: { source: "github", types: ["issue.*"] },
          to: "worker",
          cwd: "/tmp/repo",
          group: "eng",
          parallel: 2,
        },
        {
          name: "rule-b",
          when: { source: "ci", types: ["build.*"] },
          to: "worker",
          cwd: "/tmp/repo",
          group: "eng",
          parallel: 2,
        },
      ],
    });
    stepView(view, { type: "configureRules", config: cfg }, T0);
    stepView(
      view,
      {
        type: "ingestEvent",
        source: "github",
        event: { id: "a1", type: "issue.opened", subject: "PR-1" },
      },
      T0 + 10,
    );
    stepView(
      view,
      {
        type: "ingestEvent",
        source: "ci",
        event: { id: "b1", type: "build.failed", subject: "PR-1" },
      },
      T0 + 20,
    );
    stepView(
      view,
      {
        type: "ingestEvent",
        source: "ci",
        event: { id: "b2", type: "build.failed", subject: "PR-2" },
      },
      T0 + 30,
    );

    const claimed = stepView<{ jobs: Job[] }>(
      view,
      { type: "claimWork", claimId: "c-1", capacity: 4 },
      T0 + 40,
    );
    // group "eng" has parallel=2: rule-a(PR-1) claims, rule-b(PR-1) MUST wait due to same (grp, lane),
    // while rule-b(PR-2) claims the second slot!
    assert.equal(claimed.jobs.length, 2);
    assert.deepEqual(
      claimed.jobs.map((j) => [j.rule.name, j.context.events[0]?.subject]),
      [
        ["rule-a", "PR-1"],
        ["rule-b", "PR-2"],
      ],
    );
    const queuedRuleBPr1 = rows(view, "runs", {
      rule: "rule-b",
      lane: "PR-1",
    })[0]!;
    assert.equal(canClaimRun(view, queuedRuleBPr1, T0 + 40, 4), false);
    assertInvariants(view, { nowMs: T0 + 40, workerCapacity: 4 });

    // Corrupting state so rule-b(PR-1) is also claimed must violate INV-05
    const corrupted = view.fork();
    corrupted.set("runs", String(queuedRuleBPr1.id), {
      ...queuedRuleBPr1,
      status: "claimed",
      claimed_at: iso(T0 + 40),
    });
    // Raise parallel to 3 in corrupted view so INV-03 doesn't fire before INV-05
    corrupted.set("config", "rules", {
      id: "rules",
      version: 1,
      value: {
        ...cfg,
        rules: cfg.rules.map((r) => ({ ...r, parallel: 3 })),
      },
      updated_at: iso(T0),
    });
    assert.throws(
      () => assertInvariants(corrupted),
      (err: unknown) =>
        err instanceof InvariantViolationError && err.code === "INV-05",
    );
  });

  it("includes done cards in context.decided while excluding current-run context.answers cards", () => {
    withTempDir((home) => {
      const view = createMemoryView();
      stepView(view, { type: "configureRules", config: makeBaseConfig() }, T0);

      // Round 1: ask card "rm -rf"
      stepView(
        view,
        {
          type: "ingestEvent",
          source: "github",
          event: { id: "e1", type: "issue.opened", subject: "L1" },
        },
        T0 + 10,
      );
      const c1 = stepView<{ jobs: Job[] }>(
        view,
        { type: "claimWork", claimId: "c1", capacity: 1 },
        T0 + 20,
      );
      const s1 = stepView<{ cardsCreated: Array<{ card: number }> }>(
        view,
        {
          type: "submitResult",
          run: c1.jobs[0]!.run,
          token: c1.jobs[0]!.token,
          result: {
            outcome: "done",
            session: "s-1",
            ask: [
              {
                key: "rm -rf",
                title: "Allow cleanup?",
                text: "Need rm -rf build",
                options: ["同意", "拒绝"],
                recommend: 0,
                about: "cleanup",
              },
            ],
          },
        },
        T0 + 30,
      );
      const card1Id = s1.cardsCreated[0]!.card;

      // User approves card1 -> wakes Run 2
      stepView(
        view,
        { type: "answerCard", card: card1Id, choice: 0 },
        T0 + 40,
      );
      const c2 = stepView<{ jobs: Job[] }>(
        view,
        { type: "claimWork", claimId: "c2", capacity: 1 },
        T0 + 50,
      );
      const job2 = c2.jobs[0]!;
      // In Run 2, card1 is in context.answers and MUST NOT be duplicated in context.decided
      assert.deepEqual(
        job2.context.answers.map((a) => a.card),
        [card1Id],
      );
      assert.deepEqual(job2.context.decided, []);

      // Run 2 finishes `done` (card1 -> status "done") and schedules a `later` timer
      const timerAt = T0 + 60_000;
      stepView(
        view,
        {
          type: "submitResult",
          run: job2.run,
          token: job2.token,
          result: {
            outcome: "done",
            session: "s-1",
            later: [{ key: "verify", at: iso(timerAt), about: "recheck" }],
          },
        },
        T0 + 60,
      );
      assert.equal(view.get("cards", String(card1Id))?.status, "done");

      // Timer fires -> Run 3 claims: card1 (status === "done") MUST now appear in context.decided & approvedKeys!
      stepView(view, { type: "tick" }, timerAt + 100);
      const c3 = stepView<{ jobs: Job[] }>(
        view,
        { type: "claimWork", claimId: "c3", capacity: 1 },
        timerAt + 200,
      );
      const job3 = jobOf(view, c3.jobs[0]!.run, c3.jobs[0]!.token);
      assert.equal(job3.context.answers.length, 0);
      assert.equal(job3.context.decided.length, 1);
      assert.equal(job3.context.decided[0]?.card, card1Id);
      assert.equal(job3.context.decided[0]?.choice, "同意");

      const prepared = writeRunFiles(home, job3);
      assert.deepEqual(prepared.guard.approvedKeys, ["rm -rf"]);
    });
  });

  it("uses 60s exponential backoff by default, emits 3rd-failure warning card with 120-cp last-line summary, and auto-closes on recovery", () => {
    const view = createMemoryView();
    stepView(view, { type: "configureRules", config: makeBaseConfig() }, T0);
    stepView(
      view,
      {
        type: "ingestEvent",
        source: "github",
        event: { id: "f-1", type: "issue.opened", subject: "PR-9" },
      },
      T0 + 100,
    );

    let now = T0 + 200;
    // Attempt 1 fails -> default backoff = 60_000ms (1 min), no warning card yet
    const c1 = stepView<{ jobs: Job[] }>(
      view,
      { type: "claimWork", claimId: "cf-1", capacity: 1 },
      now,
    );
    const f1 = stepView<{
      requeued: boolean;
      notBefore: string;
      cardsCreated: unknown[];
    }>(
      view,
      {
        type: "submitResult",
        run: c1.jobs[0]!.run,
        token: c1.jobs[0]!.token,
        result: { outcome: "failed", error: "err 1" },
      },
      now + 100,
    );
    assert.equal(f1.requeued, true);
    assert.equal(f1.notBefore, iso(now + 100 + 60_000));
    assert.equal(f1.cardsCreated.length, 0);

    // Attempt 2 fails -> default backoff = 120_000ms (2 min), no warning card yet
    now = Date.parse(f1.notBefore);
    const c2 = stepView<{ jobs: Job[] }>(
      view,
      { type: "claimWork", claimId: "cf-2", capacity: 1 },
      now,
    );
    const f2 = stepView<{
      requeued: boolean;
      notBefore: string;
      cardsCreated: unknown[];
    }>(
      view,
      {
        type: "submitResult",
        run: c2.jobs[0]!.run,
        token: c2.jobs[0]!.token,
        result: { outcome: "failed", error: "err 2" },
      },
      now + 100,
    );
    assert.equal(f2.notBefore, iso(now + 100 + 120_000));
    assert.equal(f2.cardsCreated.length, 0);

    // Attempt 3 fails with multiline stack + emoji > 120 code points -> backoff = 240_000ms (4 min) + warning notice card!
    now = Date.parse(f2.notBefore);
    const c3 = stepView<{ jobs: Job[] }>(
      view,
      { type: "claimWork", claimId: "cf-3", capacity: 1 },
      now,
    );
    const longLastLine = `FinalRootCause: ${"🔥".repeat(130)}`;
    const multilineErr = `Error: wrapper\n  at step1 (a.ts:1)\n${longLastLine}\n   \n`;
    const f3 = stepView<{
      requeued: boolean;
      notBefore: string;
      cardsCreated: Array<{ card: number; kind: string; status: string; text: string }>;
    }>(
      view,
      {
        type: "submitResult",
        run: c3.jobs[0]!.run,
        token: c3.jobs[0]!.token,
        result: { outcome: "failed", error: multilineErr },
      },
      now + 100,
    );
    assert.equal(f3.notBefore, iso(now + 100 + 240_000));
    assert.equal(f3.cardsCreated.length, 1);
    const warnCard = f3.cardsCreated[0]!;
    assert.equal(warnCard.kind, "notice");
    assert.equal(warnCard.status, "open");
    assert.equal(warnCard.text.includes("Error: wrapper"), false);
    assert.equal(warnCard.text.includes("FinalRootCause:"), true);
    // Ensure no lone UTF-16 surrogate from splitting emoji
    assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(warnCard.text), false);

    // Attempt 4 succeeds (`done`) -> warning card is automatically closed!
    now = Date.parse(f3.notBefore);
    const c4 = stepView<{ jobs: Job[] }>(
      view,
      { type: "claimWork", claimId: "cf-4", capacity: 1 },
      now,
    );
    stepView(
      view,
      {
        type: "submitResult",
        run: c4.jobs[0]!.run,
        token: c4.jobs[0]!.token,
        result: { outcome: "done", summary: "Recovered cleanly" },
      },
      now + 100,
    );
    assert.equal(view.get("cards", String(warnCard.card))?.status, "closed");
    assertInvariants(view, { nowMs: now + 100, workerCapacity: 4 });
  });

  it("auto-generates fyi card for tell=always on silent done, notifies fyi only for tell=always, and prefixes [<rule>]", async () => {
    await withTempDirAsync(async (home) => {
      const sentNotifications: Array<{ title: string; body: string }> = [];
      const notifier = createNotifier({
        platform: "darwin",
        silent: false,
        execFileFn: (_file, args, _opts, cb) => {
          sentNotifications.push({
            title: args[6] ?? "",
            body: args[7] ?? "",
          });
          cb(null, "", "");
        },
      });

      let nowMs = T0;
      const runtime = new HubRuntime({
        autoloopHome: home,
        enableSupervisor: false,
        now: () => nowMs,
        notifier,
      });

      try {
        const cfg = makeBaseConfig({
          rules: [
            {
              name: "morning-brief",
              when: { source: "github", types: ["brief.*"] },
              to: "worker",
              cwd: "/tmp/repo",
              tell: "always",
            },
            {
              name: "quiet-needed",
              when: { source: "github", types: ["quiet.*"] },
              to: "worker",
              cwd: "/tmp/repo",
              tell: "needed",
            },
          ],
        });
        runtime.configureRules(cfg);

        // 1. tell="always" finishes `done` with no explicit ask/notice -> auto-creates fyi card AND pushes notification with [morning-brief]
        nowMs += 100;
        runtime.ingestEvent("github", { id: "b-1", type: "brief.run" });
        const claim1 = await runtime.supervisorBackend.claimWork({
          claimId: "c-brief",
          capacity: 2,
          running: [],
        });
        assert.equal(claim1.jobs.length, 1);
        nowMs += 100;
        const sub1 = (await runtime.supervisorBackend.submitResult({
          run: claim1.jobs[0]!.run,
          token: claim1.jobs[0]!.token,
          result: { outcome: "done", summary: "今日一切平稳，共合并 3 个 PR" },
        })) as { cardsCreated: Array<{ card: number; fyi?: boolean; status: string }> };

        assert.equal(sub1.cardsCreated.length, 1);
        assert.equal(sub1.cardsCreated[0]?.fyi, true);
        assert.equal(sub1.cardsCreated[0]?.status, "closed");
        assert.equal(
          shouldNotifyCard(sub1.cardsCreated[0] as any, cfg),
          true,
        );

        // Wait microtask for async notifier
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(sentNotifications.length, 1);
        assert.match(sentNotifications[0]!.title, /\[morning-brief\]/);
        assert.match(sentNotifications[0]!.body, /今日一切平稳/);

        // 2. tell="needed" with explicit fyi: true does NOT push desktop notification
        nowMs += 100;
        runtime.ingestEvent("github", { id: "q-1", type: "quiet.run" });
        const claim2 = await runtime.supervisorBackend.claimWork({
          claimId: "c-quiet",
          capacity: 2,
          running: [],
        });
        nowMs += 100;
        await runtime.supervisorBackend.submitResult({
          run: claim2.jobs[0]!.run,
          token: claim2.jobs[0]!.token,
          result: {
            outcome: "done",
            notice: [{ title: "Quiet FYI", text: "No alert", fyi: true }],
          },
        });
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(sentNotifications.length, 1);
        assertInvariants(runtime.store, { nowMs, workerCapacity: 2 });
      } finally {
        await runtime.close();
      }
    });
  });

  it("cleans up fired timers projection rows when wakeup runs enter any terminal state (done/nothing/cancelled/failed)", () => {
    const view = createMemoryView();
    const fastEnv: DecideEnv = { ...BASE_ENV, retryBaseMs: 1_000 };
    stepView(
      view,
      { type: "configureRules", config: makeBaseConfig() },
      T0,
      fastEnv,
    );

    // Schedule 3 timers on 3 lanes to test done, cancelled, and exhausted failed terminal cleanups
    for (const [idx, lane] of ["L-done", "L-cancel", "L-fail"].entries()) {
      const base = T0 + idx * 100;
      stepView(
        view,
        {
          type: "ingestEvent",
          source: "github",
          event: { id: `init-${lane}`, type: "issue.opened", subject: lane },
        },
        base + 10,
        fastEnv,
      );
      const cl = stepView<{ jobs: Job[] }>(
        view,
        { type: "claimWork", claimId: `cl-${lane}`, capacity: 4 },
        base + 20,
        fastEnv,
      );
      stepView(
        view,
        {
          type: "submitResult",
          run: cl.jobs[0]!.run,
          token: cl.jobs[0]!.token,
          result: {
            outcome: "done",
            session: `sess-${lane}`,
            later: [
              {
                key: `tmr-${lane}`,
                at: iso(T0 + 10_000),
                about: `Check ${lane}`,
              },
            ],
          },
        },
        base + 30,
        fastEnv,
      );
    }
    assert.equal(view.all("timers").length, 3);

    // Fire all 3 timers via tick
    let now = T0 + 15_000;
    const tk = stepView<{
      timersFired: Array<{ timer: number; lane: string; run: number }>;
    }>(view, { type: "tick" }, now, fastEnv);
    assert.equal(tk.timersFired.length, 3);
    assert.equal(view.all("timers").length, 3);
    for (const fired of tk.timersFired) {
      assert.equal(
        view.get("timers", String(fired.timer))?.fired_run,
        fired.run,
      );
    }

    const doneRunId = tk.timersFired.find((t) => t.lane === "L-done")!.run;
    const cancelRunId = tk.timersFired.find((t) => t.lane === "L-cancel")!.run;
    const failRunId = tk.timersFired.find((t) => t.lane === "L-fail")!.run;

    // 1. Stop L-cancel while queued -> immediately cancelled -> timer cleaned up!
    now += 100;
    stepView(view, { type: "stopRun", run: cancelRunId }, now, fastEnv);
    assert.equal(view.all("timers").length, 2);

    // 2. Claim L-done and finish done -> timer cleaned up, and whyOf still preserves timers provenance!
    now += 100;
    const cWake = stepView<{ jobs: Job[] }>(
      view,
      { type: "claimWork", claimId: "c-wake-1", capacity: 4 },
      now,
      fastEnv,
    );
    const doneJob = cWake.jobs.find((j) => j.run === doneRunId)!;
    let failJob = cWake.jobs.find((j) => j.run === failRunId)!;

    now += 100;
    stepView(
      view,
      {
        type: "submitResult",
        run: doneJob.run,
        token: doneJob.token,
        result: { outcome: "done", summary: "Recheck passed" },
      },
      now,
      fastEnv,
    );
    assert.equal(view.all("timers").length, 1);
    const whyDone = whyOf(view, doneRunId);
    assert.equal(whyDone.timers.length, 1);
    assert.equal(whyDone.timers[0]?.key, "tmr-L-done");

    // 3. Exhaust MAX_ATTEMPTS on L-fail -> terminal failed -> last timer cleaned up!
    for (let att = 1; att <= MAX_ATTEMPTS; att++) {
      now += 100;
      const sub = stepView<{ requeued: boolean; notBefore?: string }>(
        view,
        {
          type: "submitResult",
          run: failRunId,
          token: failJob.token,
          result: { outcome: "failed", error: `boom #${att}` },
        },
        now,
        fastEnv,
      );
      if (att < MAX_ATTEMPTS) {
        assert.equal(sub.requeued, true);
        assert.equal(
          view.all("timers").length,
          1,
          "timer must stay until wakeup run reaches terminal state",
        );
        now = Date.parse(sub.notBefore!) + 10;
        const nextClaim = stepView<{ jobs: Job[] }>(
          view,
          { type: "claimWork", claimId: `c-fail-${att + 1}`, capacity: 4 },
          now,
          fastEnv,
        );
        failJob = nextClaim.jobs[0]!;
      } else {
        assert.equal(sub.requeued, false);
      }
    }

    assert.equal(view.all("timers").length, 0);
    assertInvariants(view, { nowMs: now, workerCapacity: 4 });
  });
});
