/**
 * End-to-end tests for the Sidecar Host, Local IPC Server, File Watcher, and Desktop Notifier (WP-11).
 *
 * Prevents:
 * 1. Privilege escalation where `ingest.token` calls owner-only card/rule/run control endpoints (must return 403).
 * 2. AppleScript command injection via untrusted card titles or bodies in `osascript` notifications.
 * 3. Daemon crash on malformed `rules.json` during hot-reload, or duplicate/flooded `watch` events.
 * 4. Broken Web UI ETag 304 caching, `x-sidecar-token` UI gating, or `ask_then_resume` conversation continuation.
 * 5. Leaked `ipc.json` or `0o600` permission regressions on tokens/discovery files after graceful shutdown.
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CardView, RulesConfig } from "../protocol/types.ts";
import { createFileWatcher } from "../sidecars/hub/file-watcher.ts";
import {
  ensureHubTokens,
  HubRuntime,
  type HubTokens,
  resolveAutoloopHome,
} from "../sidecars/hub/ipc-server.ts";
import {
  buildOsascriptArgs,
  createNotifier,
  type Notifier,
  type NotifierOptions,
  shouldNotifyCard,
} from "../sidecars/hub/notifier.ts";

interface HubHostHandle {
  host: string;
  webPort: number;
  webUrl: string;
  ipcHost: string;
  ipcPort: number;
  ipcUrl: string;
  ipcFilePath: string;
  autoloopHome: string;
  tokens: HubTokens;
  runtime: HubRuntime;
  close(): Promise<void>;
}

const MAIN_MJS_URL = pathToFileURL(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "sidecars",
    "hub",
    "main.mjs",
  ),
).href;

async function startHubHost(options: {
  autoloopHome?: string;
  standalone?: boolean;
  uiToken?: string;
  agyBin?: string;
  pollIntervalMs?: number;
  baseEnv?: NodeJS.ProcessEnv;
  notifier?: Notifier;
  notifierOptions?: NotifierOptions;
  enableSupervisor?: boolean;
  silentNotify?: boolean;
}): Promise<HubHostHandle> {
  const mod = (await import(MAIN_MJS_URL)) as {
    startHubHost: (opts: unknown) => Promise<HubHostHandle>;
  };
  return mod.startHubHost(options);
}

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const FAKE_AGY = path.join(REPO_ROOT, "tests", "fakes", "fake-agy.mjs");

function makeTempDir(prefix: string): string {
  return path.join(
    os.tmpdir(),
    `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
}

function makeRulesConfig(
  cwd: string,
  overrides: Partial<RulesConfig> = {},
): RulesConfig {
  return {
    timezone: "UTC",
    askFirst: ["git push --force", "rm -rf"],
    sources: {
      manual: { name: "手动触发" },
      inbox: { name: "收件箱" },
      watch: { name: "文件监听" },
    },
    agents: {
      worker: {
        name: "Hydrogen Worker",
        runner: "agy-print",
        model: "gemini-4-hydrogen-high",
        access: "edit",
      },
    },
    rules: [
      {
        name: "triage",
        when: { source: "inbox", types: ["issue.opened"] },
        to: "worker",
        cwd,
        parallel: 2,
        resume: true,
        tell: "needed",
      },
    ],
    ...overrides,
  };
}

async function waitFor<T>(
  predicate: () =>
    Promise<T | null | undefined | false> | T | null | undefined | false,
  timeoutMs = 8_000,
  intervalMs = 40,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) {
        return value;
      }
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  if (lastErr) {
    throw lastErr;
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe("WP-11 Sidecar Host, IPC, Watcher, and Notifier", () => {
  it("validates sidecar.json manifest and resolves AUTOLOOP_HOME / 0600 tokens idempotently", () => {
    const manifestPath = path.join(
      REPO_ROOT,
      "sidecars",
      "hub",
      "sidecar.json",
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<
      string,
      any
    >;
    assert.equal(manifest.command, "node");
    assert.deepEqual(manifest.args, [
      "--disable-warning=ExperimentalWarning",
      "main.mjs",
    ]);
    assert.equal(manifest.restart_policy, "always");
    assert.equal(manifest.display_name, "Autoloop 工作台");
    assert.equal(manifest.has_web_ui, true);
    assert.deepEqual(manifest.agent_permissions, {
      allows_user_interactions: false,
    });
    assert.equal(
      manifest.ui_config?.views?.[0]?.entrypoint,
      "SIDECAR_UI_ENTRYPOINT_AUX_PANE",
    );

    assert.equal(
      resolveAutoloopHome({
        AUTOLOOP_HOME: "/tmp/custom-auto",
        PLUGIN_DATA: "/tmp/pd",
      }),
      path.resolve("/tmp/custom-auto"),
    );
    assert.equal(
      resolveAutoloopHome({ PLUGIN_DATA: "/tmp/pd" }),
      path.resolve("/tmp/pd"),
    );
    assert.equal(resolveAutoloopHome({}), path.join(os.homedir(), ".autoloop"));

    const home = makeTempDir("autoloop-tokens");
    mkdirSync(home, { recursive: true });
    try {
      const first = ensureHubTokens(home);
      const second = ensureHubTokens(home);
      assert.deepEqual(first, second);
      assert.match(first.ownerToken, /^[0-9a-f]{64}$/);
      assert.match(first.ingestToken, /^[0-9a-f]{64}$/);
      assert.match(first.masterKey, /^[0-9a-f]{64}$/);
      assert.notEqual(first.ownerToken, first.ingestToken);

      for (const file of ["owner.token", "ingest.token", "master.key"]) {
        const mode = statSync(path.join(home, file)).mode & 0o777;
        assert.equal(mode, 0o600, `${file} must be 0o600`);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("isolates AppleScript arguments in notifier to prevent command injection and respects tell/fyi policies", async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const notifier = createNotifier({
      platform: "darwin",
      silent: false,
      execFileFn: (file, args, opts, cb) => {
        assert.equal(opts.shell, false);
        calls.push({ file, args: [...args] });
        cb(null, "", "");
      },
    });

    const evilTitle = 'evil" & (do shell script "touch /tmp/pwned") & "';
    const evilBody = 'line1\n" & do shell script "whoami"';
    const directArgs = buildOsascriptArgs(evilTitle, evilBody);
    assert.equal(directArgs[0], "-e");
    assert.equal(directArgs[1], "on run argv");
    assert.equal(
      directArgs[3],
      "display notification (item 2 of argv) with title (item 1 of argv)",
    );
    assert.equal(directArgs[6], evilTitle);
    assert.equal(directArgs[7], evilBody);

    const config = makeRulesConfig("/tmp", {
      rules: [
        {
          name: "loud-rule",
          when: { source: "inbox", types: ["a"] },
          to: "worker",
          cwd: "/tmp",
          tell: "needed",
        },
        {
          name: "muted-rule",
          when: { source: "inbox", types: ["b"] },
          to: "worker",
          cwd: "/tmp",
          tell: "never",
        },
      ],
    });

    const askCard: CardView = {
      card: 1,
      kind: "ask",
      status: "open",
      rule: "loud-rule",
      lane: "",
      key: "k1",
      title: evilTitle,
      text: evilBody,
      options: ["A", "B"],
      createdAt: "2026-11-14T00:00:00.000Z",
    };
    const fyiNotice: CardView = {
      card: 2,
      kind: "notice",
      status: "closed",
      fyi: true,
      rule: "loud-rule",
      lane: "",
      key: "k2",
      title: "FYI",
      text: "skip me",
      createdAt: "2026-11-14T00:00:00.000Z",
    };
    const mutedAsk: CardView = {
      card: 3,
      kind: "ask",
      status: "open",
      rule: "muted-rule",
      lane: "",
      key: "k3",
      title: "Muted",
      text: "do not notify",
      options: ["A", "B"],
      createdAt: "2026-11-14T00:00:00.000Z",
    };
    const openNotice: CardView = {
      card: 4,
      kind: "notice",
      status: "open",
      fyi: false,
      rule: "loud-rule",
      lane: "",
      key: "k4",
      title: "Action Required",
      text: "check this",
      createdAt: "2026-11-14T00:00:00.000Z",
    };

    assert.equal(shouldNotifyCard(askCard, config), true);
    assert.equal(shouldNotifyCard(fyiNotice, config), false);
    assert.equal(shouldNotifyCard(mutedAsk, config), false);
    assert.equal(shouldNotifyCard(openNotice, config), true);

    const firstSent = await notifier.notifyCards(
      [askCard, fyiNotice, mutedAsk, openNotice],
      config,
    );
    assert.deepEqual(firstSent, [1, 4]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.file, "osascript");
    assert.ok(calls[0]!.args[6]!.includes(evilTitle));
    // Script code arguments remain immutable literals
    assert.equal(
      calls[0]!.args[3],
      "display notification (item 2 of argv) with title (item 1 of argv)",
    );

    // Repeating same cards never double-notifies
    const secondSent = await notifier.notifyCards(
      [askCard, openNotice],
      config,
    );
    assert.deepEqual(secondSent, []);
    assert.equal(calls.length, 2);

    // Non-darwin skips safely
    const linuxCalls: unknown[] = [];
    const linuxNotifier = createNotifier({
      platform: "linux",
      execFileFn: (...args) => {
        linuxCalls.push(args);
      },
    });
    const linuxRes = await linuxNotifier.notify("hi", "there");
    assert.deepEqual(linuxRes, { sent: false, reason: "unsupported-platform" });
    assert.equal(linuxCalls.length, 0);
  });

  it("enforces dual-token IPC permissions (401/403/400/404/409), dryRun emit, and Web ETag 304 + ask_then_resume E2E with fake-agy", async () => {
    const home = makeTempDir("autoloop-e2e");
    const workspace = makeTempDir("autoloop-ws");
    const agyStateFile = path.join(home, "fake-agy-state.json");
    const agyRecordFile = path.join(home, "fake-agy-records.jsonl");
    mkdirSync(home, { recursive: true });
    mkdirSync(workspace, { recursive: true });

    const rules = makeRulesConfig(workspace);
    writeFileSync(
      path.join(home, "rules.json"),
      JSON.stringify(rules, null, 2),
      "utf8",
    );

    const notifiedCards: number[] = [];
    const host = await startHubHost({
      autoloopHome: home,
      standalone: true,
      uiToken: "ui-secret-123",
      agyBin: FAKE_AGY,
      pollIntervalMs: 40,
      baseEnv: {
        ...process.env,
        FAKE_AGY_SCENARIO: "ask_then_resume",
        FAKE_AGY_STATE_FILE: agyStateFile,
        FAKE_AGY_RECORD_FILE: agyRecordFile,
      },
      notifier: createNotifier({
        platform: "darwin",
        execFileFn: (_file, args, _opts, cb) => {
          notifiedCards.push(args.length);
          cb(null, "", "");
        },
      }),
    });

    try {
      // 1. Verify ipc.json created with 0o600
      assert.equal(existsSync(host.ipcFilePath), true);
      assert.equal(statSync(host.ipcFilePath).mode & 0o777, 0o600);
      const ipcMeta = JSON.parse(readFileSync(host.ipcFilePath, "utf8")) as {
        host: string;
        port: number;
        pid: number;
      };
      assert.equal(ipcMeta.host, "127.0.0.1");
      assert.equal(ipcMeta.port, host.ipcPort);
      assert.equal(ipcMeta.pid, process.pid);

      // 2. Verify Web static assets
      const htmlRes = await fetch(`${host.webUrl}/`);
      assert.equal(htmlRes.status, 200);
      assert.match(htmlRes.headers.get("content-type") ?? "", /text\/html/);
      assert.match(await htmlRes.text(), /批奏折工作台/);

      const cssRes = await fetch(`${host.webUrl}/styles.css`);
      assert.equal(cssRes.status, 200);
      assert.match(cssRes.headers.get("content-type") ?? "", /text\/css/);

      const jsRes = await fetch(`${host.webUrl}/app.js`);
      assert.equal(jsRes.status, 200);
      assert.match(
        jsRes.headers.get("content-type") ?? "",
        /application\/javascript/,
      );

      // 3. Verify IPC health & auth failures
      const healthRes = await fetch(`${host.ipcUrl}/ipc/health`);
      assert.equal(healthRes.status, 200);
      const healthJson = (await healthRes.json()) as {
        ok: boolean;
        pid: number;
        seq: number;
      };
      assert.equal(healthJson.ok, true);
      assert.equal(healthJson.pid, process.pid);

      const unauthRes = await fetch(`${host.ipcUrl}/ipc/state`);
      assert.equal(unauthRes.status, 401);

      const badTokRes = await fetch(`${host.ipcUrl}/ipc/state`, {
        headers: { Authorization: "Bearer wrong-token" },
      });
      assert.equal(badTokRes.status, 401);

      // 4. Verify ingest.token is blocked (403 ForbiddenError) on ALL owner routes
      const ownerOnlyRoutes: Array<{ path: string; body: unknown }> = [
        { path: "/ipc/cards/answer", body: { card: 1, choice: 0 } },
        { path: "/ipc/cards/resolve", body: { card: 1, reason: "x" } },
        { path: "/ipc/runs/stop", body: { run: 1 } },
        { path: "/ipc/rules/pause", body: { rule: "triage" } },
        { path: "/ipc/rules/resume", body: { rule: "triage" } },
        { path: "/ipc/rules/replay", body: { rule: "triage" } },
        { path: "/ipc/rules/run", body: { rule: "triage" } },
        { path: "/ipc/rules/reload", body: {} },
      ];
      for (const route of ownerOnlyRoutes) {
        const res = await fetch(`${host.ipcUrl}${route.path}`, {
          method: "POST",
          headers: {
            "x-autoloop-token": host.tokens.ingestToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(route.body),
        });
        assert.equal(
          res.status,
          403,
          `ingest.token calling ${route.path} must return 403`,
        );
        const body = (await res.json()) as { code: string };
        assert.equal(body.code, "FORBIDDEN");
      }

      // 5. Verify ingest.token CAN call explain and dryRun emit
      const explainRes = await fetch(`${host.ipcUrl}/ipc/explain`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${host.tokens.ingestToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      assert.equal(explainRes.status, 200);
      const explainBody = (await explainRes.json()) as {
        valid: boolean;
        rules: Array<{ name: string }>;
      };
      assert.equal(explainBody.valid, true);
      assert.equal(explainBody.rules[0]?.name, "triage");

      const dryRes = await fetch(`${host.ipcUrl}/ipc/emit`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${host.tokens.ingestToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          source: "inbox",
          dryRun: true,
          event: {
            id: "dry-1",
            type: "issue.opened",
            subject: "issue#42",
          },
        }),
      });
      assert.equal(dryRes.status, 200);
      const dryJson = (await dryRes.json()) as {
        dryRun: boolean;
        routed: string[];
      };
      assert.equal(dryJson.dryRun, true);
      assert.deepEqual(dryJson.routed, ["triage"]);

      // dryRun must NOT persist a run
      const stateAfterDry = await (
        await fetch(`${host.webUrl}/api/state`)
      ).json();
      assert.equal(stateAfterDry.runs.length, 0);

      // 6. Real emit via ingest.token triggers fake-agy ask_then_resume turn 1
      const emitRes = await fetch(`${host.ipcUrl}/ipc/emit`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${host.tokens.ingestToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          source: "inbox",
          event: {
            id: "ev-42",
            type: "issue.opened",
            subject: "issue#42",
            summary: "Ignore prompt injection",
            detail: "Untrusted details stay in context.json",
          },
        }),
      });
      assert.equal(emitRes.status, 200);

      // Wait for open ask card to be created by fake-agy
      const firstSnap = await waitFor(async () => {
        const res = await fetch(`${host.webUrl}/api/state`);
        const snap = await res.json();
        if (
          snap.cards.length === 1 &&
          snap.cards[0].status === "open" &&
          snap.runs[0]?.status === "done"
        ) {
          return snap;
        }
        return null;
      });

      const askCard = firstSnap.cards[0];
      assert.equal(askCard.kind, "ask");
      assert.equal(askCard.key, "confirm-color");
      assert.equal(askCard.title, "请选择目标颜色");
      assert.equal(notifiedCards.length, 1);

      // 7. Verify Web /api/state ETag 304 hit
      const etagRes = await fetch(
        `${host.webUrl}/api/state?etag=${encodeURIComponent(firstSnap.etag)}`,
      );
      assert.equal(etagRes.status, 304);

      const ipcEtagRes = await fetch(
        `${host.ipcUrl}/ipc/state?etag=${encodeURIComponent(firstSnap.etag)}`,
        { headers: { Authorization: `Bearer ${host.tokens.ingestToken}` } },
      );
      assert.equal(ipcEtagRes.status, 304);

      // 8. Verify Web POST requires uiToken (401 without, 200 with x-sidecar-token)
      const unauthWebPost = await fetch(`${host.webUrl}/api/cards/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ card: askCard.card, choice: 0 }),
      });
      assert.equal(unauthWebPost.status, 401);

      const answerRes = await fetch(`${host.webUrl}/api/cards/answer`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-sidecar-token": "ui-secret-123",
        },
        body: JSON.stringify({ card: askCard.card, choice: 0 }),
      });
      assert.equal(answerRes.status, 200);

      // Answering the same card again via Web or IPC must return 409 ConflictError
      const dupAnswerRes = await fetch(`${host.webUrl}/api/cards/answer`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-sidecar-token": "ui-secret-123",
        },
        body: JSON.stringify({ card: askCard.card, choice: 1 }),
      });
      assert.equal(dupAnswerRes.status, 409);

      // 9. Wait for resumed turn 2 (using same conversation session) to complete with fyi notice
      const finalSnap = await waitFor(async () => {
        const res = await fetch(`${host.webUrl}/api/state`);
        const snap = await res.json();
        const fyi = snap.recentCards.find(
          (c: CardView) => c.key === "resume-complete",
        );
        const doneCard = snap.recentCards.find(
          (c: CardView) => c.card === askCard.card && c.status === "done",
        );
        if (fyi && doneCard && snap.runs.length === 2) {
          return snap;
        }
        return null;
      });

      const fyiCard = finalSnap.recentCards.find(
        (c: CardView) => c.key === "resume-complete",
      );
      assert.match(fyiCard.text, /青翠绿/);
      // fyi notice + done card should not trigger extra desktop notifications
      assert.equal(notifiedCards.length, 1);

      // Verify fake-agy turn 2 received --conversation matching turn 1's session
      const records = readFileSync(agyRecordFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(records.length, 2);
      assert.equal(records[0].parsed.conversation, null);
      assert.ok(records[1].parsed.conversation);

      // 10. Verify /api/why & /api/state?before= pagination & 400/404 handling
      const newestRun = finalSnap.runs[0];
      const whyRes = await fetch(`${host.webUrl}/api/why?run=${newestRun.run}`);
      assert.equal(whyRes.status, 200);
      const whyJson = await whyRes.json();
      assert.equal(whyJson.run.run, newestRun.run);
      assert.equal(whyJson.answers[0]?.chosen, "青翠绿");

      const pageRes = await fetch(
        `${host.webUrl}/api/state?before=${newestRun.run}&limit=1`,
      );
      assert.equal(pageRes.status, 200);
      const pageJson = await pageRes.json();
      assert.equal(pageJson.runs.length, 1);
      assert.ok(pageJson.runs[0].run < newestRun.run);

      const badWhyRes = await fetch(`${host.webUrl}/api/why?run=abc`);
      assert.equal(badWhyRes.status, 400);
      const missingWhyRes = await fetch(`${host.webUrl}/api/why?run=9999`);
      assert.equal(missingWhyRes.status, 404);
      const badJsonIpc = await fetch(`${host.ipcUrl}/ipc/emit`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${host.tokens.ownerToken}`,
          "Content-Type": "application/json",
        },
        body: "{bad-json",
      });
      assert.equal(badJsonIpc.status, 400);
    } finally {
      await host.close();
      assert.equal(
        existsSync(host.ipcFilePath),
        false,
        "ipc.json must be cleaned up on close()",
      );
      rmSync(home, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("hot-reloads rules.json safely (surviving syntax errors) and debounces watch directory events", async () => {
    const home = makeTempDir("autoloop-watch-home");
    const watchDir = makeTempDir("autoloop-watch-dir");
    mkdirSync(home, { recursive: true });
    mkdirSync(watchDir, { recursive: true });

    const initialConfig = makeRulesConfig(watchDir, {
      rules: [
        {
          name: "base-rule",
          when: { source: "inbox", types: ["ping"] },
          to: "worker",
          cwd: watchDir,
        },
      ],
    });
    const rulesFile = path.join(home, "rules.json");
    writeFileSync(rulesFile, JSON.stringify(initialConfig, null, 2), "utf8");

    const warnings: string[] = [];
    const runtime = new HubRuntime({
      autoloopHome: home,
      enableSupervisor: false,
      notifierOptions: { silent: true },
    });
    const watcher = createFileWatcher({
      runtime,
      rulesFilePath: rulesFile,
      rulesDebounceMs: 30,
      defaultWatchDebounceMs: 60,
      onWarning: (msg) => warnings.push(msg),
    });

    try {
      watcher.start();
      assert.equal(runtime.explainRules().rules[0]?.name, "base-rule");

      // Write malformed JSON -> must log warning and keep old valid rules active
      writeFileSync(rulesFile, "{ invalid json !!!", "utf8");
      await waitFor(() => warnings.length >= 1);
      assert.equal(runtime.explainRules().rules[0]?.name, "base-rule");

      // Write valid updated config with { watch } trigger
      const updatedConfig = makeRulesConfig(watchDir, {
        rules: [
          {
            name: "watch-docs",
            when: {
              watch: {
                paths: [watchDir],
                debounceMs: 80,
                types: ["doc.updated"],
              },
            },
            to: "worker",
            cwd: watchDir,
            parallel: 4,
          },
        ],
      });
      writeFileSync(rulesFile, JSON.stringify(updatedConfig, null, 2), "utf8");

      await waitFor(() =>
        watcher.watchedPaths().includes(path.resolve(watchDir)),
      );
      assert.equal(runtime.explainRules().rules[0]?.name, "watch-docs");

      // Rapidly write same file 4 times within debounce window -> collapsed into 1 run
      const targetFile = path.join(watchDir, "report (draft)!.md");
      for (let i = 1; i <= 4; i++) {
        writeFileSync(targetFile, `draft version ${i}\n`, "utf8");
        await new Promise((r) => setTimeout(r, 15));
      }

      const snap = await waitFor(() => {
        const s = runtime.getState();
        return s.runs.length > 0 ? s : null;
      });

      assert.equal(snap.runs.length, 1);
      assert.equal(snap.runs[0]!.rule, "watch-docs");
      assert.equal(snap.runs[0]!.lane, "report-draft-.md");

      const why = runtime.getWhy(snap.runs[0]!.run);
      assert.equal(why.events.length, 1);
      assert.equal(why.events[0]!.source, "watch");
      assert.equal(why.events[0]!.type, "doc.updated");
      assert.match(why.events[0]!.id, /^watch-[0-9a-f]{16}-/);
      assert.match(why.events[0]!.detail ?? "", /report \(draft\)!\.md/);
    } finally {
      watcher.close();
      await runtime.close();
      rmSync(home, { recursive: true, force: true });
      rmSync(watchDir, { recursive: true, force: true });
    }
  });

  it("supports Web rule controls (pause/resume/replay/run/stop/resolve) and fires precision earliestDueMs timers", async () => {
    const home = makeTempDir("autoloop-ctrl");
    const workspace = makeTempDir("autoloop-ctrl-ws");
    mkdirSync(home, { recursive: true });
    mkdirSync(workspace, { recursive: true });

    const rules = makeRulesConfig(workspace);
    writeFileSync(
      path.join(home, "rules.json"),
      JSON.stringify(rules, null, 2),
      "utf8",
    );

    const host = await startHubHost({
      autoloopHome: home,
      standalone: true,
      enableSupervisor: false,
      silentNotify: true,
    });

    try {
      // Pause rule -> ingest skipped event -> resume -> replay
      const pauseRes = await fetch(`${host.webUrl}/api/rules/pause`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rule: "triage", reason: "maintenance" }),
      });
      assert.equal(pauseRes.status, 200);

      await fetch(`${host.ipcUrl}/ipc/emit`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${host.tokens.ownerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          source: "inbox",
          event: { id: "skip-1", type: "issue.opened", subject: "issue#9" },
        }),
      });

      const resumeRes = await fetch(`${host.webUrl}/api/rules/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rule: "triage" }),
      });
      assert.equal(resumeRes.status, 200);
      const resumeJson = await resumeRes.json();
      assert.equal(resumeJson.skipped.length, 1);

      const replayRes = await fetch(`${host.webUrl}/api/rules/replay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rule: "triage" }),
      });
      assert.equal(replayRes.status, 200);
      const replayJson = await replayRes.json();
      assert.equal(replayJson.replayedCount, 1);

      // Manual run + stop queued run via Web API
      const runRes = await fetch(`${host.webUrl}/api/rules/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rule: "triage", subject: "manual-check" }),
      });
      assert.equal(runRes.status, 200);
      const runJson = await runRes.json();

      const stopRes = await fetch(`${host.webUrl}/api/runs/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run: runJson.run }),
      });
      assert.equal(stopRes.status, 200);
      const stopJson = await stopRes.json();
      assert.equal(stopJson.run.status, "cancelled");

      // Precision earliestDueMs timer triggers `later` wakeup automatically
      const claimed = host.runtime.supervisorBackend.claimWork({
        claimId: "manual-claim",
        capacity: 4,
        running: [],
      }) as { jobs: Array<{ run: number; token: string }> };
      assert.equal(claimed.jobs.length, 1);
      const job = claimed.jobs[0]!;
      const wakeAt = new Date(Date.now() + 90).toISOString();
      host.runtime.supervisorBackend.submitResult({
        run: job.run,
        token: job.token,
        result: {
          outcome: "done",
          summary: "scheduled follow-up",
          later: [{ key: "follow-up", at: wakeAt, about: "recheck soon" }],
          notice: [{ key: "open-n", title: "待阅", text: "请阅", fyi: false }],
        },
      });

      const snapBeforeResolve = host.runtime.getState();
      const openNotice = snapBeforeResolve.cards.find(
        (c) => c.key === "open-n",
      )!;
      const resolveRes = await fetch(`${host.webUrl}/api/cards/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ card: openNotice.card, reason: "已阅" }),
      });
      assert.equal(resolveRes.status, 200);

      // Wait for due timer to auto-fire tick() and enqueue follow-up run
      const snapAfterTimer = await waitFor(() => {
        const s = host.runtime.getState();
        return s.timers.length === 0 && s.runs.length >= 3 ? s : null;
      }, 3_000);
      assert.equal(snapAfterTimer.timers.length, 0);

      // Verify owner.token IPC reload (from disk and inline config) + owner IPC controls
      const ownerHeaders = {
        Authorization: `Bearer ${host.tokens.ownerToken}`,
        "Content-Type": "application/json",
      };
      const diskReloadRes = await fetch(`${host.ipcUrl}/ipc/rules/reload`, {
        method: "POST",
        headers: ownerHeaders,
        body: JSON.stringify({}),
      });
      assert.equal(diskReloadRes.status, 200);
      const diskReloadJson = (await diskReloadRes.json()) as {
        version: number;
      };
      assert.equal(diskReloadJson.version, 2);

      const ownerRunRes = await fetch(`${host.ipcUrl}/ipc/rules/run`, {
        method: "POST",
        headers: ownerHeaders,
        body: JSON.stringify({ rule: "triage", subject: "owner-ipc-run" }),
      });
      assert.equal(ownerRunRes.status, 200);
      const ownerRunJson = (await ownerRunRes.json()) as { run: number };

      const ownerStopRes = await fetch(`${host.ipcUrl}/ipc/runs/stop`, {
        method: "POST",
        headers: ownerHeaders,
        body: JSON.stringify({ run: ownerRunJson.run }),
      });
      assert.equal(ownerStopRes.status, 200);
      const ownerStopJson = (await ownerStopRes.json()) as {
        run: { status: string };
      };
      assert.equal(ownerStopJson.run.status, "cancelled");
    } finally {
      await host.close();
      rmSync(home, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
