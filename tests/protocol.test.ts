/**
 * 防止的真实故障与安全越界：
 * 1. 外部事件夹带 cwd/agent/to/access/model/runner/command 等特权字段篡改执行环境；
 * 2. 恶意 subject（以 - 或 / 开头、含空白换行）与非 ASCII/伪协议 link 导致命令参数注入或提示词污染；
 * 3. 回执卡片与定时复查字段畸形（options < 2、recommend 越界、无时区时间、cancel 与 at 冲突）破坏内核状态机；
 * 4. rules.json 悬空引用、重名规则、非法 IANA 时区或非法并发上限在运行期才暴露。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseRulesConfig } from "../protocol/rules-schema.ts";
import {
  ProtocolInputError,
  parseInboundEvent,
  parseReceipt,
  parseRunResult,
} from "../protocol/validate.ts";

describe("parseInboundEvent", () => {
  it("accepts valid events including #subject and hops > 8 for circuit breaker", () => {
    const ev = parseInboundEvent({
      id: "gh-issue-42",
      type: "github.issue.opened",
      subject: "#42",
      summary: "Fix crash on startup",
      detail: "Stack trace...",
      link: "https://github.com/org/repo/issues/42",
      hops: 9,
    });
    assert.equal(ev.id, "gh-issue-42");
    assert.equal(ev.subject, "#42");
    assert.equal(ev.hops, 9);

    const httpLinkEv = parseInboundEvent({
      id: "local:1",
      type: "file.changed",
      subject: "org/repo:feat_1.0@v2",
      link: "http://127.0.0.1:8080/README.md",
      hops: 0,
    });
    assert.equal(httpLinkEv.link, "http://127.0.0.1:8080/README.md");

    assert.throws(
      () =>
        parseInboundEvent({
          id: "local:file-rejected",
          type: "file.changed",
          link: "file:///Users/demo/project/README.md",
        }),
      ProtocolInputError,
    );
  });

  it("normalizes empty string subject to omitted", () => {
    const ev = parseInboundEvent({ id: "evt-1", type: "ping", subject: "" });
    assert.equal("subject" in ev, false);
  });

  it("rejects privileged override and unknown fields with ProtocolInputError (400)", () => {
    const forbiddenFields = [
      "cwd",
      "agent",
      "to",
      "access",
      "model",
      "runner",
      "command",
      "skill",
      "prompt",
      "extra",
    ];
    for (const key of forbiddenFields) {
      assert.throws(
        () => parseInboundEvent({ id: "1", type: "t", [key]: "evil" }),
        (err: unknown) =>
          err instanceof ProtocolInputError && err.statusCode === 400,
        `expected ${key} to be rejected`,
      );
    }
  });

  it("rejects invalid id, type, subject, summary, detail, link, and hops", () => {
    assert.throws(
      () => parseInboundEvent({ id: "", type: "t" }),
      ProtocolInputError,
    );
    assert.throws(
      () => parseInboundEvent({ id: "   ", type: "t" }),
      ProtocolInputError,
    );
    assert.throws(
      () => parseInboundEvent({ id: "a\nb", type: "t" }),
      ProtocolInputError,
    );
    assert.throws(
      () => parseInboundEvent({ id: "a".repeat(201), type: "t" }),
      ProtocolInputError,
    );

    assert.throws(
      () => parseInboundEvent({ id: "1", type: "" }),
      ProtocolInputError,
    );
    assert.throws(
      () => parseInboundEvent({ id: "1", type: "bad type" }),
      ProtocolInputError,
    );
    assert.throws(
      () => parseInboundEvent({ id: "1", type: "a".repeat(65) }),
      ProtocolInputError,
    );

    assert.throws(
      () => parseInboundEvent({ id: "1", type: "t", subject: "-rf" }),
      ProtocolInputError,
    );
    assert.throws(
      () => parseInboundEvent({ id: "1", type: "t", subject: "/etc/passwd" }),
      ProtocolInputError,
    );
    assert.throws(
      () => parseInboundEvent({ id: "1", type: "t", subject: "bad subject" }),
      ProtocolInputError,
    );
    assert.throws(
      () => parseInboundEvent({ id: "1", type: "t", subject: "line1\nline2" }),
      ProtocolInputError,
    );
    assert.throws(
      () => parseInboundEvent({ id: "1", type: "t", subject: "a".repeat(101) }),
      ProtocolInputError,
    );

    assert.throws(
      () => parseInboundEvent({ id: "1", type: "t", summary: "s".repeat(201) }),
      ProtocolInputError,
    );
    assert.throws(
      () => parseInboundEvent({ id: "1", type: "t", detail: "d".repeat(8001) }),
      ProtocolInputError,
    );

    assert.throws(
      () =>
        parseInboundEvent({ id: "1", type: "t", link: "javascript:alert(1)" }),
      ProtocolInputError,
    );
    assert.throws(
      () =>
        parseInboundEvent({
          id: "1",
          type: "t",
          link: "https://example.com/中文",
        }),
      ProtocolInputError,
    );
    assert.throws(
      () =>
        parseInboundEvent({ id: "1", type: "t", link: " https://example.com" }),
      ProtocolInputError,
    );
    assert.throws(
      () =>
        parseInboundEvent({
          id: "1",
          type: "t",
          link: "https://example.com/" + "a".repeat(500),
        }),
      ProtocolInputError,
    );

    assert.throws(
      () => parseInboundEvent({ id: "1", type: "t", hops: -1 }),
      ProtocolInputError,
    );
    assert.throws(
      () => parseInboundEvent({ id: "1", type: "t", hops: 1.5 }),
      ProtocolInputError,
    );
  });
});

describe("parseReceipt & parseRunResult", () => {
  it("accepts complete valid Receipt and RunResult", () => {
    const receipt = parseReceipt({
      ask: [
        {
          key: "deploy-prod",
          title: "是否发布生产",
          text: "测试全部通过",
          options: ["发布", "暂缓"],
          recommend: 0,
          about: "版本 v1.2",
        },
      ],
      notice: [{ key: "done", title: "已构建", text: "产物就绪", fyi: true }],
      resolve: [{ card: 12, reason: "问题已自动修复" }],
      later: [
        { key: "recheck", at: "2026-11-14T09:30:00+08:00", about: "次日复查" },
        { key: "old-timer", cancel: true },
      ],
      events: [{ id: "e-2", type: "delivery.ready", subject: "feat-1" }],
    });
    assert.equal(receipt.ask?.length, 1);
    assert.equal(receipt.later?.length, 2);

    const runResult = parseRunResult({
      outcome: "done",
      summary: "已完成",
      session: "conv-abc",
      usage: { input: 100, output: 50, cached: 80, cost: 0.01 },
      notice: [{ title: "通知", text: "一切正常" }],
    });
    assert.equal(runResult.outcome, "done");
    assert.equal(runResult.usage?.cached, 80);
  });

  it("rejects malformed ask, resolve, later, derivative events, and usage", () => {
    assert.throws(
      () =>
        parseReceipt({
          ask: [
            {
              key: "k",
              title: "t",
              text: "body",
              options: ["唯一选项"],
              about: "a",
            },
          ],
        }),
      ProtocolInputError,
    );

    assert.throws(
      () =>
        parseReceipt({
          ask: [
            {
              key: "k",
              title: "t",
              text: "body",
              options: ["A", "B"],
              recommend: 2,
              about: "a",
            },
          ],
        }),
      ProtocolInputError,
    );

    assert.throws(
      () =>
        parseReceipt({
          ask: [
            {
              key: "",
              title: "t",
              text: "body",
              options: ["A", "B"],
              about: "a",
            },
          ],
        }),
      ProtocolInputError,
    );

    assert.throws(
      () => parseReceipt({ resolve: [{ card: 0, reason: "x" }] }),
      ProtocolInputError,
    );

    assert.throws(
      () =>
        parseReceipt({
          later: [{ key: "r", at: "2026-11-14T09:30:00", about: "no tz" }],
        }),
      ProtocolInputError,
    );

    assert.throws(
      () =>
        parseReceipt({
          later: [{ key: "r", at: "2026-02-30T09:30:00Z", about: "bad date" }],
        }),
      ProtocolInputError,
    );

    assert.throws(
      () =>
        parseReceipt({
          later: [
            {
              key: "r",
              cancel: true,
              at: "2026-11-14T09:30:00Z",
              about: "conflict",
            },
          ],
        }),
      ProtocolInputError,
    );

    assert.throws(
      () =>
        parseReceipt({
          events: [{ id: "e-1", type: "x", cwd: "/tmp" }],
        }),
      ProtocolInputError,
    );

    assert.throws(
      () => parseRunResult({ outcome: "unknown_status" }),
      ProtocolInputError,
    );

    assert.throws(
      () => parseRunResult({ outcome: "done", usage: { input: -1 } }),
      ProtocolInputError,
    );
  });
});

describe("parseRulesConfig", () => {
  const validConfig = {
    timezone: "Asia/Shanghai",
    askFirst: ["删除文件"],
    sources: {
      github: { name: "GitHub" },
      internal: { name: "内部流转" },
    },
    agents: {
      worker: { name: "主力角色", runner: "agy-print" },
      probe: {
        name: "探针角色",
        runner: "command",
        command: ["node", "./probe.mjs"],
      },
    },
    rules: [
      {
        name: "issue-triage",
        when: { source: "github", types: ["issue.*"] },
        to: "worker",
        cwd: "~/Projects/demo",
        title: "triage-{subject}-{id}",
        parallel: 2,
        maxActive: 4,
        emits: { source: "internal", types: ["triage.done"] },
      },
      {
        name: "morning-brief",
        when: { cron: "0 9 * * 1-5" },
        to: "probe",
        cwd: "/tmp/workspace",
      },
    ],
  };

  it("validates and fills defaults on valid RulesConfig", () => {
    const parsed = parseRulesConfig(validConfig);
    assert.equal(parsed.timezone, "Asia/Shanghai");
    assert.equal(parsed.agents.worker.access, "edit");
    assert.equal(parsed.agents.worker.timeoutMinutes, 60);
    assert.equal(parsed.rules[0].group, "issue-triage");
    assert.equal(parsed.rules[0].tell, "needed");
    assert.equal(parsed.rules[0].resume, false);
  });

  it("rejects invalid timezone, duplicate names, dangling references, and invalid limits", () => {
    assert.throws(
      () => parseRulesConfig({ ...validConfig, timezone: "Mars/Phobos" }),
      ProtocolInputError,
    );

    assert.throws(
      () =>
        parseRulesConfig({
          ...validConfig,
          rules: [validConfig.rules[0], { ...validConfig.rules[0] }],
        }),
      ProtocolInputError,
    );

    assert.throws(
      () =>
        parseRulesConfig({
          ...validConfig,
          rules: [{ ...validConfig.rules[0], to: "non-existent" }],
        }),
      ProtocolInputError,
    );

    assert.throws(
      () =>
        parseRulesConfig({
          ...validConfig,
          rules: [
            {
              ...validConfig.rules[0],
              when: { source: "missing-src", types: ["a"] },
            },
          ],
        }),
      ProtocolInputError,
    );

    assert.throws(
      () =>
        parseRulesConfig({
          ...validConfig,
          rules: [
            {
              ...validConfig.rules[0],
              emits: { source: "missing-src", types: ["a"] },
            },
          ],
        }),
      ProtocolInputError,
    );

    assert.throws(
      () =>
        parseRulesConfig({
          ...validConfig,
          rules: [{ ...validConfig.rules[0], parallel: 0 }],
        }),
      ProtocolInputError,
    );

    assert.throws(
      () =>
        parseRulesConfig({
          ...validConfig,
          rules: [{ ...validConfig.rules[0], maxActive: 1.2 }],
        }),
      ProtocolInputError,
    );

    assert.throws(
      () =>
        parseRulesConfig({
          ...validConfig,
          rules: [{ ...validConfig.rules[0], title: "bad title" }],
        }),
      ProtocolInputError,
    );

    assert.throws(
      () =>
        parseRulesConfig({
          ...validConfig,
          rules: [{ ...validConfig.rules[0], title: "{subject}-first" }],
        }),
      ProtocolInputError,
    );

    assert.throws(
      () =>
        parseRulesConfig({
          ...validConfig,
          rules: [{ ...validConfig.rules[0], cwd: "./relative" }],
        }),
      ProtocolInputError,
    );
  });
});
