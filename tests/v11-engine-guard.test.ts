/**
 * WP-B V1.1 Engine, Receipt Fallback & Security Guard Regression Tests.
 *
 * 防止的真实故障与安全越界：
 * 1. 首轮业务已完成（exitCode=0 且结论为 done/nothing），仅末尾 agent-autoloop 回执损坏且修复耗尽（或无会话不可修复）时，
 *    误判为 failed 导致有副作用的业务被内核重跑 10 次（应执行 discardReceipt 降级结案并推告警 notice 卡）；
 * 2. resume 历史会话已损坏或丢失（!started && !cancelled && !timedOut && exitCode !== 0）时死锁失败，
 *    或降级新开会话仍未启动时向内核误报空/假/旧会话；
 * 3. `agy --print --output-format stream-json` 已输出非错误最终 `result` 事件，但后台残留孙进程持有 stdout/stderr 管道不放，
 *    导致白挂满 60 分钟变假超时失败重跑（应在 postResultGraceMs 到期后回收进程组并按成功结算）；
 * 4. 子代理通过读写工具或命令偷读 `<AUTOLOOP_HOME>/owner.token` / `master.key` / `guard.json` 自授权限或自批卡片，
 *    篡改 `hub.db` / `rules.json`，或利用 `env -i -u`、`sudo -n -u`、`sh -c`、`node -e`、`python3 -c` 绕过只读与 askFirst 门禁；
 * 5. 用户自由文本批复含否定/暂缓语义（如“不要删，先看日志”、“算了”、“don't”）被 `isApprovedChoice` 误判为已授权 `approvedKeys`；
 * 6. `agentapi-runner` / `command-runner` 遗漏剥离 `AUTOLOOP_*_{TOKEN,SECRET,KEY}` / `ANTIGRAVITY_SIDECAR*` 敏感环境变量，
 *    或异常探针无限刷屏打爆 Sidecar 进程内存。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { runAgentApiUi } from "../engine/agentapi-runner.ts";
import { runAgyPrint } from "../engine/agy-runner.ts";
import { runCommandProbe } from "../engine/command-runner.ts";
import { writeRunFiles } from "../engine/context-file.ts";
import {
  createSupervisor,
  type SupervisorBackend,
} from "../engine/supervisor.ts";
import { decide, type DecideEnv, type KernelInput } from "../kernel/decide.ts";
import {
  createTokenSigner,
  openStore,
  safeTokenEquals,
} from "../kernel/store.ts";
import type { Job, RulesConfig } from "../protocol/types.ts";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const FAKE_AGY_BIN = path.join(REPO_ROOT, "tests", "fakes", "fake-agy.mjs");
const PRE_TOOL_HOOK = path.join(REPO_ROOT, "hooks", "pre-tool-guard.mjs");

const MASTER_KEY_HEX =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const tempDirs: string[] = [];

function makeTempDir(prefix = "autoloop-v11-b-"): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeExecutableScript(dir: string, name: string, code: string): string {
  const filePath = path.join(dir, name);
  writeFileSync(filePath, `#!/usr/bin/env node\n${code}`, "utf8");
  chmodSync(filePath, 0o755);
  return filePath;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 8_000,
  stepMs = 20,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

function createKernelHarness(dbPath: string, initialNowMs = 1_700_000_000_000) {
  const store = openStore(dbPath);
  const signToken = createTokenSigner(MASTER_KEY_HEX);
  const env: DecideEnv = { signToken, safeTokenEquals };
  let nowMs = initialNowMs;

  function exec<T = unknown>(input: KernelInput): T {
    const res = decide(store.view, input, nowMs, env);
    if (res.facts.length > 0) {
      store.commit(res.facts);
    }
    return res.value as T;
  }

  const backend: SupervisorBackend = {
    claimWork(input) {
      return exec({ type: "claimWork", ...input });
    },
    markStarted(input) {
      return exec({ type: "markStarted", ...input });
    },
    submitResult(input) {
      return exec({ type: "submitResult", ...input });
    },
  };

  return {
    store,
    backend,
    exec,
    advanceNow(ms: number) {
      nowMs += ms;
    },
  };
}

function makeRulesConfig(
  cwd: string,
  overrides: Partial<RulesConfig> = {},
): RulesConfig {
  return {
    timezone: "UTC",
    askFirst: ["rm -rf", "git push --force", "git reset --hard"],
    sources: {
      inbox: { name: "Inbox" },
    },
    agents: {
      coder: {
        name: "Coder",
        runner: "agy-print",
        model: "gemini-4-hydrogen-high",
        effort: "high",
        access: "edit",
        timeoutMinutes: 1,
      },
    },
    rules: [
      {
        name: "triage",
        when: { source: "inbox", types: ["issue.opened"] },
        to: "coder",
        cwd,
        parallel: 2,
        resume: true,
      },
    ],
    ...overrides,
  };
}

function makeJob(overrides: Partial<Job> = {}): Job {
  const base: Job = {
    run: 1,
    token: "hmac-token-1",
    attempt: 1,
    rule: {
      name: "triage",
      cwd: os.tmpdir(),
    },
    agent: {
      id: "coder",
      name: "Coder",
      runner: "agy-print",
      model: "gemini-4-hydrogen-high",
      access: "edit",
      timeoutMinutes: 1,
    },
    session: null,
    askFirst: ["rm -rf", "git push --force"],
    context: {
      events: [
        {
          id: "evt-1",
          type: "issue.opened",
          subject: "lane-1",
          source: "inbox",
          sourceName: "Inbox",
          receivedAt: "2026-11-19T00:00:00Z",
        },
      ],
      answers: [],
      timers: [],
      waiting: [],
      open: [],
      decided: [],
    },
  };
  return {
    ...base,
    ...overrides,
    rule: { ...base.rule, ...(overrides.rule ?? {}) },
    agent: { ...base.agent, ...(overrides.agent ?? {}) },
    context: { ...base.context, ...(overrides.context ?? {}) },
  };
}

function runPreToolHook(
  stdinPayload: unknown,
  envOverrides: Record<string, string | undefined> = {},
): Record<string, unknown> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.AUTOLOOP_GUARD_FILE;
  delete env.AUTOLOOP_HOME;
  delete env.PLUGIN_DATA;
  delete env.AUTOLOOP_RUN_ID;
  delete env.AUTOLOOP_CONTEXT;
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) {
      delete env[k];
    } else {
      env[k] = v;
    }
  }

  const res = spawnSync(process.execPath, [PRE_TOOL_HOOK], {
    input: JSON.stringify(stdinPayload),
    env,
    encoding: "utf8",
  });
  assert.equal(
    res.status,
    0,
    `Hook exited with ${res.status}, stderr=${res.stderr}`,
  );
  return JSON.parse(res.stdout.trim()) as Record<string, unknown>;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
});

describe("WP-B 1: supervisor discardReceipt fallback & dead-session auto-downgrade", () => {
  it("settles done run via discardReceipt with warning notice card instead of failed retry when 2 receipt repairs fail", async () => {
    const tmpDir = makeTempDir();
    const autoloopHome = path.join(tmpDir, "autoloop_home");
    const workCwd = path.join(tmpDir, "workspace");
    mkdirSync(workCwd, { recursive: true });
    const recordFile = path.join(tmpDir, "records.jsonl");
    const stateFile = path.join(tmpDir, "state.json");

    const badTurn = {
      conversationId: "conv-discard-1",
      text: '已完成数据库迁移与清理。\n\n```agent-autoloop\n{"events":[{"id":"broken"\n```',
      usage: { input: 40, output: 15, cached: 5, cost: 0.001 },
      exitCode: 0,
    };
    writeFileSync(
      stateFile,
      JSON.stringify({
        turn: 0,
        conversationId: "conv-discard-1",
        turns: [badTurn, badTurn, badTurn, badTurn],
      }),
      "utf8",
    );

    const harness = createKernelHarness(path.join(tmpDir, "hub.db"));
    harness.exec({
      type: "configureRules",
      config: makeRulesConfig(workCwd),
    });
    harness.exec({
      type: "ingestEvent",
      source: "inbox",
      event: { id: "e-discard-done", type: "issue.opened", subject: "db-mig" },
    });

    const supervisor = createSupervisor({
      autoloopHome,
      backend: harness.backend,
      pollIntervalMs: 0,
      heartbeatIntervalMs: 0,
      agyBin: FAKE_AGY_BIN,
      baseEnv: {
        ...process.env,
        FAKE_AGY_STATE_FILE: stateFile,
        FAKE_AGY_RECORD_FILE: recordFile,
      },
    });

    try {
      await supervisor.kick();
      await waitFor(
        () => harness.store.view.get("runs", "1")?.status === "done",
      );

      const run1 = harness.store.view.get("runs", "1");
      assert.equal(run1?.status, "done");
      assert.equal(run1?.attempts, 1);
      assert.equal(run1?.summary, "已完成数据库迁移与清理。");
      assert.equal(run1?.session, "conv-discard-1");
      assert.equal(run1?.error, null);
      assert.deepEqual(run1?.usage, {
        input: 120,
        output: 45,
        cached: 15,
        cost: 0.003,
      });

      const records = readFileSync(recordFile, "utf8").trim().split("\n");
      assert.equal(records.length, 3);

      const cards = Array.from(harness.store.view.all("cards"));
      assert.equal(cards.length, 1);
      assert.equal(cards[0]?.kind, "notice");
      assert.equal(cards[0]?.status, "open");
      assert.equal(cards[0]?.title, "回执格式损坏已忽略");
      assert.match(
        String(cards[0]?.text),
        /本轮业务已完成，但末尾 agent-autoloop 回执连续修复未通过已丢弃，请人工核查结果：/,
      );
      assert.match(String(cards[0]?.text), /JSON 语法解析失败/);
    } finally {
      await supervisor.stop();
      harness.store.close();
    }
  });

  it("settles nothing run via discardReceipt without alert notice when session is null and receipt is malformed", async () => {
    const tmpDir = makeTempDir();
    const autoloopHome = path.join(tmpDir, "autoloop_home");
    const workCwd = path.join(tmpDir, "workspace");
    mkdirSync(workCwd, { recursive: true });

    const noSessionBadReceiptBin = makeExecutableScript(
      tmpDir,
      "no-session-nothing.mjs",
      `
      console.log(JSON.stringify({
        type: "result",
        result: "没事可做：无需改动\\n\\n\`\`\`agent-autoloop\\n{bad json\\n\`\`\`"
      }));
      `,
    );

    const harness = createKernelHarness(path.join(tmpDir, "hub.db"));
    harness.exec({
      type: "configureRules",
      config: makeRulesConfig(workCwd),
    });
    harness.exec({
      type: "ingestEvent",
      source: "inbox",
      event: { id: "e-nothing", type: "issue.opened", subject: "sweep" },
    });

    const supervisor = createSupervisor({
      autoloopHome,
      backend: harness.backend,
      pollIntervalMs: 0,
      heartbeatIntervalMs: 0,
      agyBin: noSessionBadReceiptBin,
    });

    try {
      await supervisor.kick();
      await waitFor(
        () => harness.store.view.get("runs", "1")?.status === "nothing",
      );

      const run1 = harness.store.view.get("runs", "1");
      assert.equal(run1?.status, "nothing");
      assert.equal(run1?.summary, "无需改动");
      const cards = Array.from(harness.store.view.all("cards"));
      assert.equal(cards.length, 0);
    } finally {
      await supervisor.stop();
      harness.store.close();
    }
  });

  it("keeps explicit FAILED first-line outcome as failed even when receipt block is malformed", async () => {
    const tmpDir = makeTempDir();
    const autoloopHome = path.join(tmpDir, "autoloop_home");
    const workCwd = path.join(tmpDir, "workspace");
    mkdirSync(workCwd, { recursive: true });

    const explicitFailBin = makeExecutableScript(
      tmpDir,
      "explicit-fail.mjs",
      `
      console.log(JSON.stringify({ type: "init", conversationId: "conv-fail-1" }));
      console.log(JSON.stringify({
        type: "result",
        result: "没跑成：数据库连接超时\\n\\n\`\`\`agent-autoloop\\n{bad\\n\`\`\`"
      }));
      `,
    );

    const harness = createKernelHarness(path.join(tmpDir, "hub.db"));
    harness.exec({
      type: "configureRules",
      config: makeRulesConfig(workCwd),
    });
    harness.exec({
      type: "ingestEvent",
      source: "inbox",
      event: { id: "e-exp-fail", type: "issue.opened", subject: "db-down" },
    });

    const supervisor = createSupervisor({
      autoloopHome,
      backend: harness.backend,
      pollIntervalMs: 0,
      heartbeatIntervalMs: 0,
      agyBin: explicitFailBin,
    });

    try {
      await supervisor.kick();
      await waitFor(
        () => harness.store.view.get("runs", "1")?.status === "queued",
      );
      const run1 = harness.store.view.get("runs", "1");
      assert.equal(run1?.status, "queued");
      assert.equal(run1?.attempts, 1);
    } finally {
      await supervisor.stop();
      harness.store.close();
    }
  });

  it("auto-downgrades dead resume session to fresh session once and never reports fake/empty session if fresh start also fails", async () => {
    const tmpDir = makeTempDir();
    const autoloopHome = path.join(tmpDir, "autoloop_home");
    const workCwd = path.join(tmpDir, "workspace");
    mkdirSync(workCwd, { recursive: true });
    const callsLog = path.join(tmpDir, "calls.jsonl");

    // Script:
    // - If --conversation is "conv-stale-1", exits 1 before starting (broken session).
    // - If modeFile says "fail_all", also exits 1 before starting on fresh session.
    // - Otherwise starts fresh session "conv-fresh-2" and succeeds.
    const modeFile = path.join(tmpDir, "mode.txt");
    writeFileSync(modeFile, "recover_fresh", "utf8");

    const resumeTestBin = makeExecutableScript(
      tmpDir,
      "resume-test-agy.mjs",
      `
      import { appendFileSync, readFileSync } from "node:fs";
      const args = process.argv.slice(2);
      const convIdx = args.indexOf("--conversation");
      const conv = convIdx !== -1 ? args[convIdx + 1] : null;
      appendFileSync(${JSON.stringify(callsLog)}, JSON.stringify({ conv }) + "\\n");

      const mode = readFileSync(${JSON.stringify(modeFile)}, "utf8").trim();
      if (conv === "conv-stale-1" || mode === "fail_all") {
        console.error("conversation missing or corrupt");
        process.exit(1);
      }
      const nextSession = mode === "seed" ? "conv-stale-1" : "conv-fresh-2";
      console.log(JSON.stringify({ type: "init", conversationId: nextSession }));
      console.log(JSON.stringify({ type: "result", result: "正常完成任务" }));
      `,
    );

    const harness = createKernelHarness(path.join(tmpDir, "hub.db"));
    harness.exec({
      type: "configureRules",
      config: makeRulesConfig(workCwd),
    });

    // Seed run #1 so lane "lane-resume" records completed session "conv-stale-1"
    writeFileSync(modeFile, "seed", "utf8");
    harness.exec({
      type: "ingestEvent",
      source: "inbox",
      event: { id: "e-seed", type: "issue.opened", subject: "lane-resume" },
    });

    const supervisor = createSupervisor({
      autoloopHome,
      backend: harness.backend,
      pollIntervalMs: 0,
      heartbeatIntervalMs: 0,
      agyBin: resumeTestBin,
    });

    try {
      await supervisor.kick();
      await waitFor(
        () => harness.store.view.get("runs", "1")?.status === "done",
      );
      assert.equal(
        harness.store.view.get("runs", "1")?.session,
        "conv-stale-1",
      );

      // Run #2 resumes "conv-stale-1" -> fails pre-start -> auto-downgrades to fresh session "conv-fresh-2"
      writeFileSync(modeFile, "recover_fresh", "utf8");
      harness.exec({
        type: "ingestEvent",
        source: "inbox",
        event: {
          id: "e-resume-2",
          type: "issue.opened",
          subject: "lane-resume",
        },
      });
      await supervisor.kick();
      await waitFor(
        () => harness.store.view.get("runs", "2")?.status === "done",
      );

      const run2 = harness.store.view.get("runs", "2");
      assert.equal(run2?.status, "done");
      assert.equal(run2?.attempts, 1);
      assert.equal(run2?.session, "conv-fresh-2");

      // Now make "conv-fresh-2" ALSO fail AND fresh fallback ALSO fail pre-start ("fail_all")
      writeFileSync(modeFile, "fail_all", "utf8");
      const markStartedCalls: unknown[] = [];
      const submittedResults: unknown[] = [];
      const trackedBackend: SupervisorBackend = {
        claimWork: harness.backend.claimWork,
        markStarted(input) {
          markStartedCalls.push(input);
          return harness.backend.markStarted(input);
        },
        submitResult(input) {
          submittedResults.push(input.result);
          return harness.backend.submitResult(input);
        },
      };

      const supFailAll = createSupervisor({
        autoloopHome,
        backend: trackedBackend,
        pollIntervalMs: 0,
        heartbeatIntervalMs: 0,
        agyBin: resumeTestBin,
      });

      try {
        // Make resumeTestBin also treat conv-fresh-2 as pre-start failure via fail_all
        harness.exec({
          type: "ingestEvent",
          source: "inbox",
          event: {
            id: "e-resume-3",
            type: "issue.opened",
            subject: "lane-resume",
          },
        });
        await supFailAll.kick();
        await waitFor(
          () => harness.store.view.get("runs", "3")?.status === "queued",
        );

        assert.equal(markStartedCalls.length, 0);
        assert.equal(submittedResults.length, 1);
        const subRes = submittedResults[0] as Record<string, unknown>;
        assert.equal("session" in subRes, false);
        assert.equal(harness.store.view.get("runs", "3")?.session, null);
      } finally {
        await supFailAll.stop();
      }

      const calls = readFileSync(callsLog, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { conv: string | null });
      // Seed: [null]
      // Run 2: ["conv-stale-1", null]
      // Run 3: ["conv-fresh-2", null]
      assert.deepEqual(calls, [
        { conv: null },
        { conv: "conv-stale-1" },
        { conv: null },
        { conv: "conv-fresh-2" },
        { conv: null },
      ]);
    } finally {
      await supervisor.stop();
      harness.store.close();
    }
  });
});

describe("WP-B 2: agy-runner postResultGraceMs exit grace period", () => {
  it("reaps lingering grandchild holding stdout/stderr after final result event and resolves exitCode=0 without timeout", async () => {
    const dir = makeTempDir();
    const pidFile = path.join(dir, "grandchild.pid");

    const lingeringAgy = makeExecutableScript(
      dir,
      "lingering-agy.mjs",
      `
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";

      // Spawn a background child inheriting stdout/stderr and ignoring SIGTERM
      const leak = spawn(process.execPath, [
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"
      ], { stdio: "inherit" });
      writeFileSync(${JSON.stringify(pidFile)}, String(leak.pid));

      console.log(JSON.stringify({ type: "init", conversationId: "conv-grace-99" }));
      console.log(JSON.stringify({
        type: "result",
        conversationId: "conv-grace-99",
        result: "流式结果已送达\\n\\n\`\`\`agent-autoloop\\n{\\"notice\\":[{\\"title\\":\\"宽限期完成\\",\\"text\\":\\"未假超时\\",\\"fyi\\":true}]}\\n\`\`\`",
        usage: { input_tokens: 90, output_tokens: 30, cache_read_input_tokens: 20, total_cost_usd: 0.0025 }
      }));
      // Parent exits 0, but leak child keeps stdout/stderr open indefinitely!
      process.exit(0);
      `,
    );

    const startedAt = Date.now();
    const res = await runAgyPrint({
      job: makeJob(),
      contextFile: path.join(dir, "context.json"),
      guardFile: path.join(dir, "guard.json"),
      agyBin: lingeringAgy,
      postResultGraceMs: 100,
      killGraceMs: 60,
      timeoutMs: 15_000,
    });
    const elapsedMs = Date.now() - startedAt;

    assert.ok(
      elapsedMs < 8_000,
      `Expected fast grace settlement, took ${elapsedMs}ms`,
    );
    assert.equal(res.outcome, "done");
    assert.equal(res.exitCode, 0);
    assert.equal(res.timedOut, false);
    assert.equal(res.error, undefined);
    assert.equal(res.started, true);
    assert.equal(res.session, "conv-grace-99");
    assert.equal(res.summary, "流式结果已送达");
    assert.equal(res.parsed.problem, null);
    assert.equal(res.parsed.receipt?.notice?.[0]?.title, "宽限期完成");
    assert.deepEqual(res.usage, {
      input: 90,
      output: 30,
      cached: 20,
      cost: 0.0025,
    });

    const leakedPid = Number(readFileSync(pidFile, "utf8").trim());
    assert.ok(leakedPid > 0);
    await waitFor(() => !isPidAlive(leakedPid), 2_000);
  });
});

describe("WP-B 3: pre-tool-guard self-protection, command unwrapping & sub-shell/interpreter scanning", () => {
  it("protects <AUTOLOOP_HOME> secrets/DB/rules and guard.json from tampering or token theft while allowing context.json reads", () => {
    const tmpDir = makeTempDir();
    const autoloopHome = path.join(tmpDir, "autoloop_home");
    const runDir = path.join(autoloopHome, "runs", "7-1");
    const workCwd = path.join(tmpDir, "workspace");
    mkdirSync(runDir, { recursive: true });
    mkdirSync(workCwd, { recursive: true });

    const guardFile = path.join(runDir, "guard.json");
    const contextFile = path.join(runDir, "context.json");
    writeFileSync(contextFile, '{"events":[]}', "utf8");
    writeFileSync(path.join(autoloopHome, "owner.token"), "secret-tok", "utf8");
    writeFileSync(path.join(autoloopHome, "master.key"), "secret-key", "utf8");
    writeFileSync(path.join(autoloopHome, "hub.db"), "sqlite", "utf8");
    writeFileSync(path.join(autoloopHome, "rules.json"), "{}", "utf8");
    writeFileSync(
      guardFile,
      JSON.stringify({
        run: 7,
        attempt: 1,
        rule: "sec-test",
        cwd: workCwd,
        access: "full",
        askFirst: [],
        approvedKeys: ["rm-rf", "git-push-force"],
      }),
      "utf8",
    );

    // 1. Reading context.json MUST remain allowed
    assert.deepEqual(
      runPreToolHook(
        { toolCall: { name: "read_file", args: { Path: contextFile } } },
        { AUTOLOOP_GUARD_FILE: guardFile },
      ),
      { decision: "allow" },
    );
    assert.deepEqual(
      runPreToolHook(
        {
          toolCall: {
            name: "run_command",
            args: { CommandLine: `cat ${contextFile}` },
          },
        },
        { AUTOLOOP_GUARD_FILE: guardFile },
      ),
      { decision: "allow" },
    );

    // 2. Reading or writing owner.token / master.key / ingest.token / ipc.json / guard.json MUST be denied
    for (const secretRel of [
      "owner.token",
      "ingest.token",
      "master.key",
      "ipc.json",
    ]) {
      const target = path.join(autoloopHome, secretRel);
      assert.equal(
        runPreToolHook(
          { toolCall: { name: "read_file", args: { Path: target } } },
          { AUTOLOOP_GUARD_FILE: guardFile },
        ).decision,
        "deny",
        `Expected read_file deny on ${secretRel}`,
      );
      assert.equal(
        runPreToolHook(
          {
            toolCall: {
              name: "run_command",
              args: { CommandLine: `cat ${target}` },
            },
          },
          { AUTOLOOP_GUARD_FILE: guardFile },
        ).decision,
        "deny",
        `Expected cat deny on ${secretRel}`,
      );
    }

    // Touching guard.json via tool, direct path, relative path, or $AUTOLOOP_GUARD_FILE
    assert.equal(
      runPreToolHook(
        {
          toolCall: {
            name: "write_file",
            args: { Path: guardFile, Content: '{"access":"full"}' },
          },
        },
        { AUTOLOOP_GUARD_FILE: guardFile },
      ).decision,
      "deny",
    );
    assert.equal(
      runPreToolHook(
        {
          toolCall: {
            name: "read_file",
            args: { Path: "../autoloop_home/owner.token" },
          },
        },
        { AUTOLOOP_GUARD_FILE: guardFile },
      ).decision,
      "deny",
    );
    assert.equal(
      runPreToolHook(
        {
          toolCall: {
            name: "run_command",
            args: { CommandLine: 'cat "$AUTOLOOP_GUARD_FILE"' },
          },
        },
        { AUTOLOOP_GUARD_FILE: guardFile },
      ).decision,
      "deny",
    );

    // 3. Writing / mutating hub.db, hub.db-wal, hub.db-shm, rules.json MUST be denied
    for (const dbRel of ["hub.db", "hub.db-wal", "hub.db-shm", "rules.json"]) {
      const target = path.join(autoloopHome, dbRel);
      assert.equal(
        runPreToolHook(
          {
            toolCall: {
              name: "edit_file",
              args: { Path: target },
            },
          },
          { AUTOLOOP_GUARD_FILE: guardFile },
        ).decision,
        "deny",
        `Expected edit_file deny on ${dbRel}`,
      );
      assert.equal(
        runPreToolHook(
          {
            toolCall: {
              name: "run_command",
              args: { CommandLine: `echo '{}' > ${target}` },
            },
          },
          { AUTOLOOP_GUARD_FILE: guardFile },
        ).decision,
        "deny",
        `Expected shell write deny on ${dbRel}`,
      );
    }

    // Default ~/.gemini/antigravity/autoloop_data/owner.token protection
    assert.equal(
      runPreToolHook(
        {
          toolCall: {
            name: "read_file",
            args: { Path: "~/.gemini/antigravity/autoloop_data/owner.token" },
          },
        },
        { AUTOLOOP_GUARD_FILE: guardFile },
      ).decision,
      "deny",
    );
  });

  it("unwraps env/sudo flags and blocks sub-shell (-c) & interpreter (-e/-c) bypasses in read and askFirst modes", () => {
    const tmpDir = makeTempDir();
    const workCwd = path.join(tmpDir, "repo");
    mkdirSync(workCwd, { recursive: true });
    const guardFile = path.join(tmpDir, "runs", "1-1", "guard.json");
    mkdirSync(path.dirname(guardFile), { recursive: true });

    // Mode 1: access = "read"
    writeFileSync(
      guardFile,
      JSON.stringify({
        run: 1,
        attempt: 1,
        rule: "ro-rule",
        cwd: workCwd,
        access: "read",
        askFirst: ["rm -rf", "git push --force"],
        approvedKeys: [],
      }),
      "utf8",
    );

    for (const blockedReadCmd of [
      "env -i -u FOO BAR=1 touch secret.txt",
      "sudo -n -E -u root mkdir pwned",
      'sh -c "touch pwned.txt"',
      'bash -lc "echo hacked > pwned.txt"',
      'zsh -c "git commit -m bypass"',
      'dash -c "rm -f a.txt"',
      'node -e "require(\\"fs\\").writeFileSync(\\"a\\", \\"1\\")"',
      'python -c "open(\\"a\\", \\"w\\").write(\\"1\\")"',
      'python3 -c "import os; os.remove(\\"a\\")"',
    ]) {
      const res = runPreToolHook(
        {
          toolCall: {
            name: "run_command",
            args: { CommandLine: blockedReadCmd },
          },
        },
        { AUTOLOOP_GUARD_FILE: guardFile },
      );
      assert.equal(
        res.decision,
        "deny",
        `Expected deny under access=read for: ${blockedReadCmd}`,
      );
    }

    // Passive sub-shell read command remains allowed
    assert.deepEqual(
      runPreToolHook(
        {
          toolCall: {
            name: "run_command",
            args: { CommandLine: 'env -u GIT_DIR sh -c "git status"' },
          },
        },
        { AUTOLOOP_GUARD_FILE: guardFile },
      ),
      { decision: "allow" },
    );

    // Mode 2: access = "edit" with unapproved askFirst
    writeFileSync(
      guardFile,
      JSON.stringify({
        run: 2,
        attempt: 1,
        rule: "edit-rule",
        cwd: workCwd,
        access: "edit",
        askFirst: ["rm -rf", "git push --force", "git reset --hard"],
        approvedKeys: [],
      }),
      "utf8",
    );

    for (const bypassCmd of [
      "env -i -u HOME FOO=bar rm -rf ./dist",
      "sudo -n -E -u deploy git push --force origin main",
      'sh -c "rm -rf ./dist"',
      'bash -lc "git push -f origin main"',
      'zsh -c "git reset --hard HEAD~1"',
      'node -e "require(\\"fs\\").rmSync(\\"./dist\\", { recursive: true, force: true })"',
      'python3 -c "import shutil; shutil.rmtree(\\"./dist\\")"',
    ]) {
      const res = runPreToolHook(
        {
          toolCall: {
            name: "run_command",
            args: { CommandLine: bypassCmd },
          },
        },
        { AUTOLOOP_GUARD_FILE: guardFile },
      );
      assert.equal(
        res.decision,
        "deny",
        `Expected askFirst deny for wrapped/embedded command: ${bypassCmd}`,
      );
    }
  });
});

describe("WP-B 4: context-file isApprovedChoice free-text negative semantics", () => {
  it("rejects free-text negative/hold phrases while keeping affirmative phrases like 不错 / 没问题 approved", () => {
    const tmpDir = makeTempDir();

    const negativeReplies = [
      "不要删，先看日志",
      "先别动，我检查一下",
      "请勿执行删除操作",
      "禁止强制推送",
      "算了吧",
      "暂停执行",
      "先看一下详情",
      "再等等",
      "拒绝此方案",
      "取消任务",
      "方案不错，但不要删缓存",
      "Please don't delete yet, check logs first",
      "Do not push to main",
      "stop right now",
      "cancel this deployment",
      "wait for traffic to drop",
      "hold on",
    ];

    const affirmativeReplies = [
      "同意",
      "批准执行",
      "方案不错，继续执行",
      "没问题，按计划推进",
      "特别好，立即执行",
      "No problem, go ahead",
    ];

    const job = makeJob({
      context: {
        events: [],
        answers: [
          ...negativeReplies.map((text, idx) => ({
            card: idx + 1,
            key: `neg-key-${idx}`,
            title: "请示",
            options: ["同意", "拒绝"],
            choice: null,
            chosen: text,
            about: "test",
            at: "2026-11-19T00:00:00Z",
          })),
          ...affirmativeReplies.map((text, idx) => ({
            card: 100 + idx,
            key: `pos-key-${idx}`,
            title: "请示",
            options: ["同意", "拒绝"],
            choice: null,
            chosen: text,
            about: "test",
            at: "2026-11-19T00:00:00Z",
          })),
        ],
        timers: [],
        waiting: [],
        open: [],
        decided: [],
      },
    });

    const files = writeRunFiles(tmpDir, job);
    assert.deepEqual(
      files.guard.approvedKeys,
      affirmativeReplies.map((_, idx) => `pos-key-${idx}`),
    );
  });
});

describe("WP-B 5: unified runner env sanitization & command-runner bounded output buffer", () => {
  it("strips all AUTOLOOP_*_{TOKEN,SECRET,KEY}, AUTOLOOP_MASTER_KEY, and ANTIGRAVITY_SIDECAR* in command-runner and agentapi-runner", async () => {
    const dir = makeTempDir();
    const cmdEnvOut = path.join(dir, "cmd-env.json");
    const uiEnvOut = path.join(dir, "ui-env.json");
    const appDataDir = path.join(dir, "appdata");
    const sessionId = "conv-env-ui-1";

    const probeScript = makeExecutableScript(
      dir,
      "probe-sec.mjs",
      `
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(cmdEnvOut)}, JSON.stringify(process.env));
      `,
    );

    const fakeAgentApi = makeExecutableScript(
      dir,
      "agentapi-sec.mjs",
      `
      import { mkdirSync, writeFileSync } from "node:fs";
      import path from "node:path";
      writeFileSync(${JSON.stringify(uiEnvOut)}, JSON.stringify(process.env));
      process.stdout.write(JSON.stringify({ conversationId: ${JSON.stringify(sessionId)} }) + "\\n");
      const logsDir = path.join(${JSON.stringify(appDataDir)}, "brain", ${JSON.stringify(sessionId)}, ".system_generated", "logs");
      mkdirSync(logsDir, { recursive: true });
      writeFileSync(
        path.join(logsDir, "transcript.jsonl"),
        JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", content: "完成" }) + "\\n"
      );
      `,
    );

    const pollutedEnv: NodeJS.ProcessEnv = {
      ...process.env,
      AUTOLOOP_OWNER_TOKEN: "sec-1",
      AUTOLOOP_INGEST_TOKEN: "sec-2",
      AUTOLOOP_IPC_TOKEN: "sec-3",
      AUTOLOOP_MASTER_KEY: "sec-4",
      AUTOLOOP_WEBHOOK_SECRET: "sec-5",
      autoloop_custom_key: "sec-6",
      ANTIGRAVITY_SIDECAR_UI_TOKEN: "sec-7",
      ANTIGRAVITY_SIDECAR_TOKEN: "sec-8",
      ANTIGRAVITY_SIDECAR_WEB_PORT: "9999",
      ANTIGRAVITY_CSRF_TOKEN: "sec-9",
      NORMAL_USER_VAR: "keep-me",
    };

    await runCommandProbe({
      job: makeJob({
        agent: {
          id: "probe",
          name: "Probe",
          runner: "command",
          command: [process.execPath, probeScript],
        },
      }),
      contextFile: path.join(dir, "c.json"),
      guardFile: path.join(dir, "g.json"),
      baseEnv: pollutedEnv,
    });

    await runAgentApiUi({
      job: makeJob({
        agent: {
          id: "ui",
          name: "UI",
          runner: "agentapi-ui",
        },
      }),
      contextFile: path.join(dir, "c.json"),
      guardFile: path.join(dir, "g.json"),
      agentApiBin: fakeAgentApi,
      appDataDir,
      pollIntervalMs: 15,
      baseEnv: pollutedEnv,
    });

    for (const file of [cmdEnvOut, uiEnvOut]) {
      const captured = JSON.parse(readFileSync(file, "utf8")) as Record<
        string,
        string | undefined
      >;
      assert.equal(captured.AUTOLOOP_OWNER_TOKEN, undefined);
      assert.equal(captured.AUTOLOOP_INGEST_TOKEN, undefined);
      assert.equal(captured.AUTOLOOP_IPC_TOKEN, undefined);
      assert.equal(captured.AUTOLOOP_MASTER_KEY, undefined);
      assert.equal(captured.AUTOLOOP_WEBHOOK_SECRET, undefined);
      assert.equal(captured.autoloop_custom_key, undefined);
      assert.equal(captured.ANTIGRAVITY_SIDECAR_UI_TOKEN, undefined);
      assert.equal(captured.ANTIGRAVITY_SIDECAR_TOKEN, undefined);
      assert.equal(captured.ANTIGRAVITY_SIDECAR_WEB_PORT, undefined);
      assert.equal(captured.ANTIGRAVITY_CSRF_TOKEN, undefined);
      assert.equal(captured.NORMAL_USER_VAR, "keep-me");
    }
  });

  it("caps runaway stdout/stderr in command-runner while preserving first-line summary and trailing receipt", async () => {
    const dir = makeTempDir();
    const spamScript = makeExecutableScript(
      dir,
      "spam-probe.mjs",
      `
      process.stdout.write("探针巡检完成但日志极长\\n");
      const chunk = "X".repeat(65536) + "\\n";
      for (let i = 0; i < 32; i++) {
        process.stdout.write(chunk);
        process.stderr.write(chunk);
      }
      process.stdout.write("\\n\`\`\`agent-autoloop\\n" + JSON.stringify({
        events: [{ id: "spam-evt-1", type: "probe.ok", subject: "svc-1" }]
      }) + "\\n\`\`\`\\n");
      `,
    );

    const res = await runCommandProbe({
      job: makeJob({
        agent: {
          id: "spam",
          name: "Spam",
          runner: "command",
          command: [process.execPath, spamScript],
        },
      }),
      contextFile: path.join(dir, "c.json"),
      guardFile: path.join(dir, "g.json"),
    });

    // 32 * 64KB = 2MB written, rawText must be strictly capped well below 1MB
    assert.ok(
      res.rawText.length < 1_000_000,
      `Expected capped stdout (<1MB), got ${res.rawText.length} chars`,
    );
    assert.equal(res.outcome, "done");
    assert.equal(res.summary, "探针巡检完成但日志极长");
    assert.equal(res.parsed.problem, null);
    assert.equal(res.parsed.receipt?.events?.[0]?.id, "spam-evt-1");
  });
});

describe("WP-B Verifier Round-1 Must-Fixes (2, 3, 4)", () => {
  it("Must-Fix 2: unlocks DROP TABLE when askFirst default '删除数据库' is in approvedKeys", () => {
    const tmpDir = makeTempDir();
    const workCwd = path.join(tmpDir, "repo");
    mkdirSync(workCwd, { recursive: true });
    const guardFile = path.join(tmpDir, "runs", "1-1", "guard.json");
    mkdirSync(path.dirname(guardFile), { recursive: true });

    // Unapproved -> denied
    writeFileSync(
      guardFile,
      JSON.stringify({
        run: 1,
        attempt: 1,
        rule: "db-cleanup",
        cwd: workCwd,
        access: "edit",
        askFirst: [
          "rm -rf",
          "git push --force",
          "git reset --hard",
          "删除数据库",
        ],
        approvedKeys: [],
      }),
      "utf8",
    );
    assert.equal(
      runPreToolHook(
        {
          toolCall: {
            name: "run_command",
            args: { CommandLine: 'sqlite3 app.db "DROP TABLE old_cache"' },
          },
        },
        { AUTOLOOP_GUARD_FILE: guardFile },
      ).decision,
      "deny",
    );

    // Approved with default Chinese key "删除数据库" -> allowed
    writeFileSync(
      guardFile,
      JSON.stringify({
        run: 1,
        attempt: 2,
        rule: "db-cleanup",
        cwd: workCwd,
        access: "edit",
        askFirst: [
          "rm -rf",
          "git push --force",
          "git reset --hard",
          "删除数据库",
        ],
        approvedKeys: ["删除数据库"],
      }),
      "utf8",
    );
    assert.deepEqual(
      runPreToolHook(
        {
          toolCall: {
            name: "run_command",
            args: { CommandLine: 'sqlite3 app.db "DROP TABLE old_cache"' },
          },
        },
        { AUTOLOOP_GUARD_FILE: guardFile },
      ),
      { decision: "allow" },
    );
  });

  it("Must-Fix 3: allows rich read-only commands on AUTOLOOP_CONTEXT / diff.patch / rules.json while blocking inline or shell writes to context.json & hub.db", () => {
    const tmpDir = makeTempDir();
    const autoloopHome = path.join(tmpDir, "autoloop_home");
    const runDir = path.join(autoloopHome, "runs", "8-1");
    const snapDir = path.join(tmpDir, "snap");
    const workCwd = path.join(tmpDir, "repo");
    mkdirSync(runDir, { recursive: true });
    mkdirSync(snapDir, { recursive: true });
    mkdirSync(workCwd, { recursive: true });

    const guardFile = path.join(runDir, "guard.json");
    const contextFile = path.join(runDir, "context.json");
    const diffPatchFile = path.join(snapDir, "diff.patch");
    const rulesFile = path.join(autoloopHome, "rules.json");
    const hubDbFile = path.join(autoloopHome, "hub.db");

    writeFileSync(contextFile, '{"events":[]}\n', "utf8");
    writeFileSync(diffPatchFile, "--- a/x\n+++ b/x\n", "utf8");
    writeFileSync(rulesFile, "{}\n", "utf8");
    writeFileSync(hubDbFile, "sqlite3", "utf8");

    // 1. Read-only mode (like delivery heterogeneous reviewer reading diff.patch or subagent inspecting context.json / rules.json)
    writeFileSync(
      guardFile,
      JSON.stringify({
        run: 8,
        attempt: 1,
        rule: "delivery-review",
        cwd: workCwd,
        access: "read",
        askFirst: [],
        approvedKeys: [],
      }),
      "utf8",
    );

    for (const [cmd, ctxEnv] of [
      [`sed -n '80,160p' "$AUTOLOOP_CONTEXT"`, contextFile],
      [`nl -ba ${diffPatchFile}`, diffPatchFile],
      [`awk 'NR<=20 {print}' "$AUTOLOOP_CONTEXT"`, contextFile],
      [`git apply --stat ${diffPatchFile}`, diffPatchFile],
      [`git apply --check ${diffPatchFile}`, diffPatchFile],
      [`python3 -m json.tool "$AUTOLOOP_CONTEXT"`, contextFile],
      [`autoloop check ${rulesFile}`, contextFile],
      [`autoloop explain ${rulesFile}`, contextFile],
    ] as const) {
      const res = runPreToolHook(
        { toolCall: { name: "run_command", args: { CommandLine: cmd } } },
        {
          AUTOLOOP_GUARD_FILE: guardFile,
          AUTOLOOP_CONTEXT: ctxEnv,
          AUTOLOOP_HOME: autoloopHome,
        },
      );
      assert.deepEqual(
        res,
        { decision: "allow" },
        `Expected read-only inspection command to be allowed: ${cmd}`,
      );
    }

    // 2. Edit mode: inline readFileSync on AUTOLOOP_CONTEXT must be allowed, while writeFileSync / sed -i / sqlite3 hub.db must be denied!
    writeFileSync(
      guardFile,
      JSON.stringify({
        run: 8,
        attempt: 1,
        rule: "edit-worker",
        cwd: workCwd,
        access: "edit",
        askFirst: [],
        approvedKeys: [],
      }),
      "utf8",
    );

    assert.deepEqual(
      runPreToolHook(
        {
          toolCall: {
            name: "run_command",
            args: {
              CommandLine:
                "node -e \"console.log(JSON.parse(require('fs').readFileSync(process.env.AUTOLOOP_CONTEXT,'utf8')))\"",
            },
          },
        },
        {
          AUTOLOOP_GUARD_FILE: guardFile,
          AUTOLOOP_CONTEXT: contextFile,
          AUTOLOOP_HOME: autoloopHome,
        },
      ),
      { decision: "allow" },
    );

    for (const badWriteCmd of [
      `node -e 'require("fs").writeFileSync(${JSON.stringify(contextFile)}, "{}")'`,
      `node -e "require('fs').writeFileSync(process.env.AUTOLOOP_CONTEXT, '{}')"`,
      `python3 -c 'open(${JSON.stringify(contextFile)}, "w").write("{}")'`,
      `python3 -c 'from pathlib import Path; Path(${JSON.stringify(rulesFile)}).write_text("{}")'`,
      `sed -i '' 's/events/pwn/' "$AUTOLOOP_CONTEXT"`,
      `tee ${rulesFile}`,
      `rm -f ${contextFile}`,
      `sqlite3 ${hubDbFile} "SELECT * FROM runs"`,
    ]) {
      const res = runPreToolHook(
        {
          toolCall: {
            name: "run_command",
            args: { CommandLine: badWriteCmd },
          },
        },
        {
          AUTOLOOP_GUARD_FILE: guardFile,
          AUTOLOOP_CONTEXT: contextFile,
          AUTOLOOP_HOME: autoloopHome,
        },
      );
      assert.equal(
        res.decision,
        "deny",
        `Expected deny for protected write/DB access: ${badWriteCmd}`,
      );
    }
  });

  it("Must-Fix 4: emits deferred non-null session to markStarted after sessionless first event on downgraded run, and clears stale session with null when fresh run never emits a session", async () => {
    const tmpDir = makeTempDir();
    const autoloopHome = path.join(tmpDir, "autoloop_home");
    const workCwd = path.join(tmpDir, "workspace");
    mkdirSync(workCwd, { recursive: true });
    const scenarioFile = path.join(tmpDir, "scenario.txt");

    // Subtest A: dead session -> downgraded fresh run -> line 1 has NO session (`{type:"init"}`),
    // line 2 has `conversationId: "conv-delayed-fresh"`, then mid-turn crash `exit(2)`!
    // Must call markStarted with "conv-delayed-fresh" so retry preserves "conv-delayed-fresh"!
    const delayedAgyBin = makeExecutableScript(
      tmpDir,
      "delayed-session-agy.mjs",
      `
      import { readFileSync } from "node:fs";
      const args = process.argv.slice(2);
      const convIdx = args.indexOf("--conversation");
      const conv = convIdx !== -1 ? args[convIdx + 1] : null;
      const mode = readFileSync(${JSON.stringify(scenarioFile)}, "utf8").trim();

      if (conv === "conv-dead-old") {
        console.error("stale session missing");
        process.exit(1);
      }

      if (mode === "delayed_crash") {
        console.log(JSON.stringify({ type: "init" }));
        console.log(JSON.stringify({ type: "assistant", conversationId: "conv-delayed-fresh", text: "已执行一半副作用..." }));
        console.error("mid-turn network drop");
        process.exit(2);
      }

      if (mode === "sessionless_done") {
        console.log(JSON.stringify({ type: "init" }));
        console.log(JSON.stringify({ type: "result", result: "无会话号完成任务" }));
        process.exit(0);
      }
      `,
    );

    const markStartedCalls: Array<{
      run: number;
      session?: string | null;
    }> = [];
    const submitResultCalls: Array<{
      run: number;
      result: Record<string, unknown>;
    }> = [];

    // Mock backend for precise verification of markStarted & submitResult payloads
    let nextJob: Job | null = makeJob({
      run: 10,
      token: "tok-10",
      session: "conv-dead-old",
      rule: { name: "triage", cwd: workCwd },
    });

    const spyBackend: SupervisorBackend = {
      claimWork() {
        const jobs = nextJob ? [nextJob] : [];
        nextJob = null;
        return { jobs, cancel: [] };
      },
      markStarted(input) {
        markStartedCalls.push({ run: input.run, session: input.session });
        return {};
      },
      submitResult(input) {
        submitResultCalls.push({
          run: input.run,
          result: { ...(input.result as unknown as Record<string, unknown>) },
        });
        return {};
      },
    };

    const supervisor = createSupervisor({
      autoloopHome,
      backend: spyBackend,
      pollIntervalMs: 0,
      heartbeatIntervalMs: 0,
      agyBin: delayedAgyBin,
    });

    try {
      // Case A: delayed session + mid-turn crash after dead-session downgrade
      writeFileSync(scenarioFile, "delayed_crash", "utf8");
      await supervisor.kick();
      await waitFor(() => submitResultCalls.length === 1);

      assert.equal(markStartedCalls.length, 1);
      assert.equal(markStartedCalls[0]?.session, "conv-delayed-fresh");
      assert.equal(submitResultCalls[0]?.result.outcome, "failed");
      assert.equal(submitResultCalls[0]?.result.session, "conv-delayed-fresh");

      // Case B: dead-session downgrade -> fresh run succeeds with session === null throughout
      // Must call markStarted({ session: null }) AND submitResult({ ..., session: null })!
      markStartedCalls.length = 0;
      submitResultCalls.length = 0;
      writeFileSync(scenarioFile, "sessionless_done", "utf8");
      nextJob = makeJob({
        run: 11,
        token: "tok-11",
        session: "conv-dead-old",
        rule: { name: "triage", cwd: workCwd },
      });

      await supervisor.kick();
      await waitFor(() => submitResultCalls.length === 1);

      assert.equal(markStartedCalls.length, 1);
      assert.equal(markStartedCalls[0]?.session, null);
      assert.equal(submitResultCalls[0]?.result.outcome, "done");
      assert.equal("session" in submitResultCalls[0]!.result, true);
      assert.equal(submitResultCalls[0]?.result.session, null);
    } finally {
      await supervisor.stop();
    }
  });

  it("supports Claude Code PreToolUse JSON schema and blocks plain rm when askFirst contains Chinese '删除文件'", () => {
    const tmpDir = makeTempDir();
    const autoloopHome = path.join(tmpDir, "autoloop_home");
    const runDir = path.join(autoloopHome, "runs", "12-1");
    const workCwd = path.join(tmpDir, "repo");
    mkdirSync(runDir, { recursive: true });
    mkdirSync(workCwd, { recursive: true });

    const guardFile = path.join(runDir, "guard.json");
    writeFileSync(path.join(autoloopHome, "owner.token"), "secret", "utf8");
    writeFileSync(
      guardFile,
      JSON.stringify({
        run: 12,
        attempt: 1,
        rule: "claude-clean",
        cwd: workCwd,
        access: "edit",
        askFirst: ["删除文件"],
        approvedKeys: [],
      }),
      "utf8",
    );

    // 1. Safe test command via Claude Code PreToolUse format -> permissionDecision: "allow"
    const allowRes = runPreToolHook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "node --test sum.test.mjs" },
      },
      { AUTOLOOP_GUARD_FILE: guardFile },
    ) as Record<string, unknown>;
    assert.deepEqual(allowRes, {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
      },
    });

    // 2. Plain `rm keep-me.txt` under Chinese askFirst `["删除文件"]` -> permissionDecision: "deny" + decision: "block"
    const denyRmRes = runPreToolHook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "rm keep-me.txt" },
      },
      { AUTOLOOP_GUARD_FILE: guardFile },
    ) as {
      decision?: string;
      hookSpecificOutput?: { permissionDecision?: string };
    };
    assert.equal(denyRmRes.decision, "block");
    assert.equal(denyRmRes.hookSpecificOutput?.permissionDecision, "deny");

    // 3. Reading control-plane secret `owner.token` via Claude `Read` (`file_path`) -> deny
    const denySecretRes = runPreToolHook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: path.join(autoloopHome, "owner.token") },
      },
      { AUTOLOOP_GUARD_FILE: guardFile },
    ) as {
      decision?: string;
      hookSpecificOutput?: { permissionDecision?: string };
    };
    assert.equal(denySecretRes.decision, "block");
    assert.equal(denySecretRes.hookSpecificOutput?.permissionDecision, "deny");
  });
});
