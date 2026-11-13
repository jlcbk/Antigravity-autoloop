/**
 * Sidecar Web UI DOM Safety & Behavior Guard (WP-12).
 *
 * Prevents XSS injection, unauthenticated POST regressions, external CDN
 * leakage in restricted Webviews, and API contract drift between
 * `sidecars/hub/web/*` and `StateSnapshot` / `WhyReport` contracts.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import type { StateSnapshot, WhyReport } from "../protocol/types.ts";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const WEB_DIR = path.join(REPO_ROOT, "sidecars", "hub", "web");

class VTextNode {
  nodeType = 3;
  data: string;
  parentNode: VElement | null = null;

  constructor(text: string) {
    this.data = text;
  }

  get textContent(): string {
    return this.data;
  }

  set textContent(val: string) {
    this.data = String(val);
  }
}

class VElement {
  nodeType = 1;
  tagName: string;
  attributes = new Map<string, string>();
  children: Array<VElement | VTextNode> = [];
  parentNode: VElement | null = null;
  listeners = new Map<string, Array<(ev: unknown) => void>>();
  disabled = false;
  open = false;
  private _value = "";

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  get id(): string {
    return this.attributes.get("id") ?? "";
  }

  set id(v: string) {
    this.attributes.set("id", v);
  }

  get className(): string {
    return this.attributes.get("class") ?? "";
  }

  set className(v: string) {
    this.attributes.set("class", v);
  }

  get value(): string {
    return this._value;
  }

  set value(v: string) {
    this._value = String(v);
  }

  get firstChild(): VElement | VTextNode | null {
    return this.children[0] ?? null;
  }

  get textContent(): string {
    return this.children.map((c) => c.textContent).join("");
  }

  set textContent(val: string) {
    this.children = [];
    if (val !== undefined && val !== null && String(val).length > 0) {
      const t = new VTextNode(String(val));
      t.parentNode = this;
      this.children.push(t);
    }
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  appendChild(child: VElement | VTextNode): VElement | VTextNode {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child: VElement | VTextNode): VElement | VTextNode {
    const idx = this.children.indexOf(child);
    if (idx >= 0) {
      this.children.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }

  replaceChildren(...nodes: Array<VElement | VTextNode>): void {
    for (const c of this.children) {
      c.parentNode = null;
    }
    this.children = [];
    for (const n of nodes) {
      this.appendChild(n);
    }
  }

  addEventListener(type: string, fn: (ev: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  dispatchEvent(type: string, extra: Record<string, unknown> = {}): void {
    const ev = {
      type,
      target: this,
      currentTarget: this,
      stopPropagation() {
        /* handled */
      },
      preventDefault() {
        /* handled */
      },
      ...extra,
    };
    const list = this.listeners.get(type) ?? [];
    for (const fn of list) {
      fn(ev);
    }
  }

  click(): void {
    if (this.disabled) return;
    this.dispatchEvent("click");
  }
}

function collectElements(
  root: VElement,
  predicate: (el: VElement) => boolean,
  out: VElement[] = [],
): VElement[] {
  if (predicate(root)) {
    out.push(root);
  }
  for (const child of root.children) {
    if (child instanceof VElement) {
      collectElements(child, predicate, out);
    }
  }
  return out;
}

function createVirtualDomFromIndexHtml(html: string) {
  const root = new VElement("BODY");
  const byId = new Map<string, VElement>();

  // Register every element ID declared in index.html so app.js mounts match real markup.
  const idRe = /<([a-zA-Z0-9-]+)\b[^>]*\bid="([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = idRe.exec(html)) !== null) {
    const tag = match[1]!;
    const id = match[2]!;
    const el = new VElement(tag);
    el.id = id;
    byId.set(id, el);
    root.appendChild(el);
  }

  const document = {
    readyState: "complete",
    body: root,
    getElementById(id: string): VElement | null {
      return byId.get(id) ?? null;
    },
    createElement(tag: string): VElement {
      return new VElement(tag);
    },
    createElementNS(_ns: string, tag: string): VElement {
      return new VElement(tag);
    },
    createTextNode(text: string): VTextNode {
      return new VTextNode(text);
    },
    addEventListener(_type: string, _fn: () => void): void {
      // readyState is already "complete"
    },
  };

  return { root, byId, document };
}

function makeMaliciousSnapshot(): StateSnapshot {
  return {
    etag: "v12-1000-2000",
    now: "2026-11-13T16:20:00Z",
    spending: {
      today: { runs: 4, input: 12500, output: 3400, cached: 8000, cost: 0.12 },
      last7Days: {
        runs: 28,
        input: 98000,
        output: 21500,
        cached: 64000,
        cost: 1.05,
      },
    },
    cards: [
      {
        card: 101,
        kind: "ask",
        status: "open",
        rule: "db-cleanup",
        lane: "prod-db",
        key: "confirm-prune",
        title: "<img src=x onerror=alert(1)>清理归档确认",
        text: "<script>window.__xss=1</script>即将归档 30 天前日志。\n<svg onload=alert(2)>",
        about: '"><img src=x onerror=alert(3)>影响生产归档库',
        options: [
          "立即归档并删除旧表",
          '<a href="javascript:alert(4)">先备份再归档</a>',
        ],
        recommend: 1,
        run: 10,
        createdAt: "2026-11-13T16:10:00Z",
      },
      {
        card: 100,
        kind: "ask",
        status: "decided",
        rule: "pr-delivery",
        lane: "feat/ui",
        key: "merge-confirm",
        title: "确认合入主干",
        text: "审查已通过",
        options: ["立即合并", "暂缓"],
        choice: 0,
        chosen: "立即合并",
        createdAt: "2026-11-13T15:50:00Z",
        decidedAt: "2026-11-13T16:05:00Z",
      },
      {
        card: 102,
        kind: "notice",
        status: "open",
        rule: "health-watch",
        lane: "",
        key: "disk-warn",
        title: "磁盘水位提醒",
        text: "工作区磁盘使用率达 82%",
        fyi: false,
        createdAt: "2026-11-13T16:12:00Z",
      },
    ],
    recentCards: [
      {
        card: 99,
        kind: "notice",
        status: "closed",
        rule: "morning-brief",
        lane: "",
        key: "brief-1",
        title: "今日早报已生成",
        text: "汇总 12 条提交",
        fyi: true,
        createdAt: "2026-11-13T09:00:00Z",
        closedAt: "2026-11-13T09:00:00Z",
      },
    ],
    lines: [
      {
        rule: "db-cleanup",
        group: "ops",
        to: "hydrogen-high",
        cwd: "/workspace/app",
        status: "running",
        activeRuns: 1,
        queuedRuns: 0,
        doneToday: 2,
        lastRunAt: "2026-11-13T16:10:00Z",
        nextRunAt: "2026-11-14T02:00:00Z",
        skippedCount: 0,
      },
      {
        rule: "issue-triage",
        group: "triage",
        to: "hydrogen-medium",
        cwd: "/workspace/app",
        status: "paused",
        activeRuns: 0,
        queuedRuns: 0,
        doneToday: 1,
        lastRunAt: "2026-11-13T14:00:00Z",
        nextRunAt: null,
        pauseReason: "维护窗口暂停",
        pausedUntil: "2026-11-13T18:00:00Z",
        skippedCount: 2,
      },
    ],
    runs: [
      {
        run: 10,
        rule: "db-cleanup",
        lane: "prod-db",
        group: "ops",
        agent: "hydrogen-high",
        runner: "agy-print",
        model: "gemini-4-hydrogen-high",
        status: "claimed",
        attempt: 1,
        session: "conv-abc-10",
        summary: "<img src=x onerror=alert(6)>等待批奏折确认",
        usage: { input: 2000, output: 500, cached: 1200 },
        createdAt: "2026-11-13T16:09:50Z",
        claimedAt: "2026-11-13T16:09:52Z",
        startedAt: "2026-11-13T16:09:55Z",
      },
      {
        run: 9,
        rule: "morning-brief",
        lane: "",
        group: "morning-brief",
        agent: "hydrogen-medium",
        runner: "agy-print",
        model: "gemini-4-hydrogen-medium",
        status: "done",
        attempt: 1,
        session: "conv-abc-9",
        summary: "已输出研发早报",
        usage: { input: 1500, output: 600, cached: 900 },
        createdAt: "2026-11-13T09:00:00Z",
        claimedAt: "2026-11-13T09:00:01Z",
        startedAt: "2026-11-13T09:00:02Z",
        endedAt: "2026-11-13T09:00:40Z",
      },
    ],
    hasMoreRuns: true,
    timers: [
      {
        key: "recheck-backup",
        rule: "db-cleanup",
        lane: "prod-db",
        about: "复查备份镜像校验状态",
        at: "2026-11-13T17:00:00Z",
        session: "conv-abc-10",
      },
    ],
    pauses: [
      {
        rule: "issue-triage",
        reason: "维护窗口暂停",
        pausedAt: "2026-11-13T15:00:00Z",
        until: "2026-11-13T18:00:00Z",
      },
    ],
    skipped: [
      {
        seq: 51,
        rule: "issue-triage",
        source: "github",
        sourceName: "GitHub",
        eventId: "issue-51",
        type: "issue.opened",
        subject: "bug-51",
        summary: "恶意链接测试",
        link: "javascript:alert(5)",
        receivedAt: "2026-11-13T15:10:00Z",
        replayedAt: null,
      },
      {
        seq: 52,
        rule: "issue-triage",
        source: "github",
        sourceName: "GitHub",
        eventId: "issue-52",
        type: "issue.opened",
        subject: "bug-52",
        summary: "正常外部链接测试",
        link: "https://example.com/issues/52",
        receivedAt: "2026-11-13T15:20:00Z",
        replayedAt: null,
      },
    ],
  };
}

function makeMaliciousWhyReport(): WhyReport {
  return {
    run: {
      run: 10,
      rule: "db-cleanup",
      lane: "prod-db",
      group: "ops",
      agent: "hydrogen-high",
      runner: "agy-print",
      model: "gemini-4-hydrogen-high",
      status: "claimed",
      attempt: 1,
      session: "conv-abc-10",
      summary: "等待批奏折确认",
      usage: { input: 2000, output: 500, cached: 1200 },
      createdAt: "2026-11-13T16:09:50Z",
      claimedAt: "2026-11-13T16:09:52Z",
      startedAt: "2026-11-13T16:09:55Z",
    },
    ruleVersion: 3,
    ruleSpec: {
      name: "db-cleanup",
      to: "hydrogen-high",
      cwd: "/workspace/app",
      skill: "recipe-code-sweep",
      group: "ops",
      parallel: 2,
      maxActive: 1,
    },
    events: [
      {
        seq: 88,
        id: "ev-88",
        source: "probe",
        sourceName: "本地巡检",
        type: "db.bloated",
        subject: "prod-db",
        summary: "<img src=x onerror=alert(7)>归档表膨胀",
        detail: "<script>alert(8)</script>超过 50GB 阈值",
        link: "javascript:alert(7)",
        hops: 1,
        receivedAt: "2026-11-13T16:09:49Z",
      },
      {
        seq: 89,
        id: "ev-89",
        source: "github",
        sourceName: "GitHub",
        type: "pr.comment",
        subject: "prod-db",
        summary: "安全工单参考",
        link: "https://github.com/org/repo/pull/1",
        hops: 0,
        receivedAt: "2026-11-13T16:09:49Z",
      },
    ],
    answers: [],
    timers: [],
    receipt: {
      rejectedEvents: [{ type: "forbidden.ev", error: "不在 emits 白名单" }],
      rejectedResolves: [
        { card: 77, reason: "越权关闭", error: "跨组卡片禁止关闭" },
      ],
    },
    cardsCreated: [],
    cardsResolved: [],
    eventsEmitted: [],
    timeline: [
      {
        at: "2026-11-13T16:09:50Z",
        kind: "queued",
        detail: "run queued",
      },
      {
        at: "2026-11-13T16:09:55Z",
        kind: "started",
        detail: "session conv-abc-10",
      },
    ],
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 16; i++) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("WP-12 Sidecar Web UI DOM & XSS Safety", () => {
  it("passes static security scan: zero CDN urls, preload.js ordered, zero dangerous HTML/eval sinks", () => {
    const html = readFileSync(path.join(WEB_DIR, "index.html"), "utf8");
    const css = readFileSync(path.join(WEB_DIR, "styles.css"), "utf8");
    const js = readFileSync(path.join(WEB_DIR, "app.js"), "utf8");

    // 1. preload.js must be loaded before app.js
    const preloadIdx = html.indexOf('<script src="/preload.js"></script>');
    const appIdx = html.indexOf('<script src="/app.js" defer></script>');
    assert.ok(preloadIdx >= 0, "index.html must load /preload.js");
    assert.ok(
      appIdx > preloadIdx,
      "index.html must load /app.js after /preload.js",
    );

    // 2. Zero external CDN/network references in HTML or CSS
    assert.doesNotMatch(
      html,
      /(?:src|href)\s*=\s*["']\s*(?:https?:)?\/\//i,
      "index.html must not reference external CDN scripts/styles",
    );
    assert.doesNotMatch(
      css,
      /@import\b|url\(\s*["']?\s*(?:https?:)?\/\//i,
      "styles.css must not import external fonts or resources",
    );

    // 3. Required Antigravity semantic CSS variables present
    for (const cssVar of [
      "--background",
      "--foreground",
      "--card",
      "--card-foreground",
      "--muted",
      "--muted-foreground",
      "--primary",
      "--border",
      "--destructive",
    ]) {
      assert.ok(css.includes(cssVar), `styles.css must define/use ${cssVar}`);
    }

    // 4. Zero dangerous DOM/eval sinks across all web assets
    const combined = `${html}\n${js}`;
    for (const forbidden of [
      /\binnerHTML\b/,
      /\bouterHTML\b/,
      /\binsertAdjacentHTML\b/,
      /\bdocument\.write(?:ln)?\b/,
      /\beval\s*\(/,
      /\bnew\s+Function\s*\(/,
      /\bon(?:click|error|load|mouseover|input)\s*=/i,
    ]) {
      assert.doesNotMatch(
        combined,
        forbidden,
        `Forbidden sink detected: ${forbidden}`,
      );
    }
  });

  it("renders malicious payloads strictly as text, enforces URL allowlist, and dispatches exact API payloads", async () => {
    const html = readFileSync(path.join(WEB_DIR, "index.html"), "utf8");
    const js = readFileSync(path.join(WEB_DIR, "app.js"), "utf8");

    const { root, byId, document } = createVirtualDomFromIndexHtml(html);
    const snapshot = makeMaliciousSnapshot();
    const whyReport = makeMaliciousWhyReport();

    interface RecordedCall {
      url: string;
      method: string;
      headers: Record<string, string>;
      body: unknown;
    }
    const calls: RecordedCall[] = [];
    let stateCallCount = 0;

    const mockFetch = async (
      url: string,
      init: {
        method?: string;
        headers?: Record<string, string>;
        body?: string;
      } = {},
    ) => {
      const method = (init.method ?? "GET").toUpperCase();
      const headers = init.headers ?? {};
      const parsedBody =
        typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, headers, body: parsedBody });

      if (url.startsWith("/api/state")) {
        stateCallCount += 1;
        if (url.includes("before=9")) {
          const olderSnap: StateSnapshot = {
            ...snapshot,
            hasMoreRuns: false,
            runs: [
              {
                run: 8,
                rule: "morning-brief",
                lane: "",
                group: "morning-brief",
                agent: "hydrogen-medium",
                runner: "agy-print",
                status: "done",
                attempt: 1,
                session: "conv-8",
                summary: "前一日早报",
                createdAt: "2026-11-12T09:00:00Z",
                endedAt: "2026-11-12T09:00:30Z",
              },
            ],
          };
          return {
            ok: true,
            status: 200,
            json: async () => olderSnap,
          };
        }
        if (url.includes(`etag=${encodeURIComponent(snapshot.etag)}`)) {
          return {
            ok: true,
            status: 304,
            json: async () => ({}),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => snapshot,
        };
      }

      if (url === "/api/why?run=10") {
        return {
          ok: true,
          status: 200,
          json: async () => whyReport,
        };
      }

      if (method === "POST") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true }),
        };
      }

      return {
        ok: false,
        status: 404,
        json: async () => ({ error: "not found" }),
      };
    };

    const intervals: Array<{ id: number; fn: () => void }> = [];
    let nextTimerId = 1;

    const sandbox: Record<string, unknown> = {
      document,
      location: { search: "?token=test-ui-secret-token" },
      fetch: mockFetch,
      URL,
      URLSearchParams,
      navigator: { clipboard: { writeText: async () => {} } },
      setInterval: (fn: () => void) => {
        const id = nextTimerId++;
        intervals.push({ id, fn });
        return id;
      },
      clearInterval: (id: number) => {
        const idx = intervals.findIndex((t) => t.id === id);
        if (idx >= 0) intervals.splice(idx, 1);
      },
      Error,
      Map,
      Set,
      Array,
      Object,
      String,
      Number,
      Boolean,
      JSON,
      Date,
      Math,
      Promise,
      encodeURIComponent,
    };
    sandbox.globalThis = sandbox;
    sandbox.window = sandbox;

    vm.runInNewContext(js, sandbox, { filename: "sidecars/hub/web/app.js" });
    await flushMicrotasks();

    try {
      // 1. Initial GET /api/state sent token header & populated overview
      assert.ok(stateCallCount >= 1);
      assert.equal(
        calls[0]!.headers["x-sidecar-token"],
        "test-ui-secret-token",
      );
      assert.equal(byId.get("pending-badge")!.textContent, "2 待批");
      assert.equal(byId.get("stat-today-runs")!.textContent, "4");
      assert.equal(byId.get("stat-7d-runs")!.textContent, "28");
      assert.equal(byId.get("conn-text")!.textContent, "已连接 · 实时同步");

      // 2. Verify ETag 304 poll path preserves online status
      assert.equal(intervals.length, 1);
      intervals[0]!.fn();
      await flushMicrotasks();
      assert.ok(
        calls.some(
          (c) =>
            c.url === `/api/state?etag=${encodeURIComponent(snapshot.etag)}`,
        ),
        "Poll should send etag query param",
      );
      assert.equal(byId.get("conn-text")!.textContent, "已连接 · 实时同步");

      // 3. Verify zero script/img/iframe/svg injected from malicious card/run payloads
      const dangerousTags = collectElements(root, (node) =>
        ["SCRIPT", "IMG", "IFRAME", "SVG", "OBJECT", "EMBED"].includes(
          node.tagName,
        ),
      );
      assert.equal(
        dangerousTags.length,
        0,
        "No dynamic script/img/svg elements may be created from untrusted data",
      );

      // Verify malicious strings remain plain text
      const activeCardsEl = byId.get("active-cards")!;
      assert.ok(
        activeCardsEl.textContent.includes("<img src=x onerror=alert(1)>"),
      );
      assert.ok(
        activeCardsEl.textContent.includes("<script>window.__xss=1</script>"),
      );

      // Verify URL allowlist on skipped events: javascript: is NOT an <a>, https: IS an <a>
      const allAnchors = collectElements(root, (n) => n.tagName === "A");
      assert.ok(
        allAnchors.every((a) => {
          const href = a.getAttribute("href") ?? "";
          return href.startsWith("https://") || href.startsWith("http://");
        }),
        "Every rendered <a> must strictly use http:// or https://",
      );
      assert.ok(
        allAnchors.some(
          (a) => a.getAttribute("href") === "https://example.com/issues/52",
        ),
      );
      assert.ok(
        byId.get("skipped-list")!.textContent.includes("javascript:alert(5)"),
      );

      // 4. Verify recommendation badge on card #101 option 1 (not option 0)
      const choice0Btn = collectElements(
        activeCardsEl,
        (n) =>
          n.tagName === "BUTTON" &&
          n.getAttribute("data-action") === "answer-choice" &&
          n.getAttribute("data-card") === "101" &&
          n.getAttribute("data-choice") === "0",
      )[0]!;
      const choice1Btn = collectElements(
        activeCardsEl,
        (n) =>
          n.tagName === "BUTTON" &&
          n.getAttribute("data-action") === "answer-choice" &&
          n.getAttribute("data-card") === "101" &&
          n.getAttribute("data-choice") === "1",
      )[0]!;
      assert.ok(!choice0Btn.className.includes("is-recommended"));
      assert.ok(choice1Btn.className.includes("is-recommended"));
      assert.ok(choice1Btn.textContent.includes("票拟推荐"));

      // Verify decided card #100 & notice card #102
      assert.ok(activeCardsEl.textContent.includes("已批红・等待内阁续办中"));

      // 5. Trigger interactive actions and assert exact POST payloads + token header
      const assertLastPost = (expectedUrl: string, expectedBody: unknown) => {
        const postCalls = calls.filter((c) => c.method === "POST");
        const last = postCalls[postCalls.length - 1]!;
        assert.equal(last.url, expectedUrl);
        assert.equal(last.headers["x-sidecar-token"], "test-ui-secret-token");
        assert.deepEqual(last.body, expectedBody);
      };

      // Answer choice 1 on card #101
      choice1Btn.click();
      await flushMicrotasks();
      assertLastPost("/api/cards/answer", { card: 101, choice: 1 });

      // Answer custom free text on card #101
      const replyInput = collectElements(
        activeCardsEl,
        (n) => n.tagName === "INPUT",
      )[0]!;
      replyInput.value = "改为先备份再执行";
      replyInput.dispatchEvent("input");
      const textSubmitBtn = collectElements(
        activeCardsEl,
        (n) =>
          n.tagName === "BUTTON" &&
          n.getAttribute("data-action") === "answer-text" &&
          n.getAttribute("data-card") === "101",
      )[0]!;
      textSubmitBtn.click();
      await flushMicrotasks();
      assertLastPost("/api/cards/answer", {
        card: 101,
        text: "改为先备份再执行",
      });

      // Resolve ask card #101
      const resolveAskBtn = collectElements(
        activeCardsEl,
        (n) =>
          n.tagName === "BUTTON" &&
          n.getAttribute("data-action") === "resolve-card" &&
          n.getAttribute("data-card") === "101",
      )[0]!;
      resolveAskBtn.click();
      await flushMicrotasks();
      assertLastPost("/api/cards/resolve", {
        card: 101,
        reason: "无需决定，人工结案",
      });

      // Resolve notice card #102
      const resolveNoticeBtn = collectElements(
        activeCardsEl,
        (n) =>
          n.tagName === "BUTTON" &&
          n.getAttribute("data-action") === "resolve-notice" &&
          n.getAttribute("data-card") === "102",
      )[0]!;
      resolveNoticeBtn.click();
      await flushMicrotasks();
      assertLastPost("/api/cards/resolve", {
        card: 102,
        reason: "已阅结案",
      });

      // Pipeline actions: run, pause, resume, replay
      const pipelinesEl = byId.get("pipeline-lines")!;
      const runRuleBtn = collectElements(
        pipelinesEl,
        (n) =>
          n.tagName === "BUTTON" &&
          n.getAttribute("data-action") === "rule-run" &&
          n.getAttribute("data-rule") === "db-cleanup",
      )[0]!;
      runRuleBtn.click();
      await flushMicrotasks();
      assertLastPost("/api/rules/run", { rule: "db-cleanup" });

      const pauseRuleBtn = collectElements(
        pipelinesEl,
        (n) =>
          n.tagName === "BUTTON" &&
          n.getAttribute("data-action") === "rule-pause" &&
          n.getAttribute("data-rule") === "db-cleanup",
      )[0]!;
      pauseRuleBtn.click();
      await flushMicrotasks();
      assertLastPost("/api/rules/pause", {
        rule: "db-cleanup",
        reason: "面板手动暂停",
      });

      const resumeRuleBtn = collectElements(
        pipelinesEl,
        (n) =>
          n.tagName === "BUTTON" &&
          n.getAttribute("data-action") === "rule-resume" &&
          n.getAttribute("data-rule") === "issue-triage",
      )[0]!;
      resumeRuleBtn.click();
      await flushMicrotasks();
      assertLastPost("/api/rules/resume", { rule: "issue-triage" });

      const replayRuleBtn = collectElements(
        pipelinesEl,
        (n) =>
          n.tagName === "BUTTON" &&
          n.getAttribute("data-action") === "rule-replay" &&
          n.getAttribute("data-rule") === "issue-triage",
      )[0]!;
      replayRuleBtn.click();
      await flushMicrotasks();
      assertLastPost("/api/rules/replay", { rule: "issue-triage" });

      // Stop claimed run #10
      const runsEl = byId.get("runs-list")!;
      const stopRunBtn = collectElements(
        runsEl,
        (n) =>
          n.tagName === "BUTTON" &&
          n.getAttribute("data-action") === "run-stop" &&
          n.getAttribute("data-run") === "10",
      )[0]!;
      stopRunBtn.click();
      await flushMicrotasks();
      assertLastPost("/api/runs/stop", { run: 10 });

      // Load more runs pagination (before=9)
      const loadMoreBtn = byId.get("btn-load-more-runs")!;
      loadMoreBtn.click();
      await flushMicrotasks();
      assert.ok(calls.some((c) => c.url === "/api/state?before=9"));
      assert.ok(byId.get("runs-list")!.textContent.includes("#8"));

      // Open why causal drawer for run #10
      const runRow10 = collectElements(
        byId.get("runs-list")!,
        (n) => n.tagName === "DIV" && n.getAttribute("data-run") === "10",
      )[0]!;
      runRow10.click();
      await flushMicrotasks();

      const drawerBody = byId.get("why-drawer-body")!;
      assert.ok(drawerBody.textContent.includes("gemini-4-hydrogen-high"));
      assert.ok(drawerBody.textContent.includes("不在 emits 白名单"));
      assert.ok(drawerBody.textContent.includes("跨组卡片禁止关闭"));
      assert.ok(drawerBody.textContent.includes("session conv-abc-10"));

      // Ensure why drawer also respected URL allowlist and zero XSS tags
      const drawerDangerousTags = collectElements(drawerBody, (node) =>
        ["SCRIPT", "IMG", "IFRAME", "SVG"].includes(node.tagName),
      );
      assert.equal(drawerDangerousTags.length, 0);
      const drawerAnchors = collectElements(
        drawerBody,
        (n) => n.tagName === "A",
      );
      assert.equal(drawerAnchors.length, 1);
      assert.equal(
        drawerAnchors[0]!.getAttribute("href"),
        "https://github.com/org/repo/pull/1",
      );
    } finally {
      (sandbox.__autoloopApp as { destroy(): void } | undefined)?.destroy();
      assert.equal(intervals.length, 0, "Polling timer must be cleaned up");
    }
  });
});
