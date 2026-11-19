/**
 * 防止的真实故障与安全越界：
 * 1. `command-runner` 误用 shell 拼接导致元字符/换行命令注入，或泄漏 `AUTOLOOP_OWNER_TOKEN` / `ANTIGRAVITY_SIDECAR_UI_TOKEN`；
 * 2. 探针静默退出（空 stdout）被误判为失败或畸形回执，或超时/取消后遗留孤儿孙进程（未使用 `-pid` 进程组清理）；
 * 3. `agentapi-runner` 在续接会话时未记录 `transcript.jsonl` 行高水位导致误读上一轮旧 `PLANNER_RESPONSE`，或把带 `tool_calls` 的中间步骤当成回合完结；
 * 4. `send-message` 因会话不存在投递失败时误报 `started: true`（导致上层不敢降级开新会话），或取消/超时等待时泄漏文件监听句柄。
 */

import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { runAgentApiUi } from "../engine/agentapi-runner.ts";
import { runCommandProbe } from "../engine/command-runner.ts";
import { InputError } from "../kernel/errors.ts";
import type { Job } from "../protocol/types.ts";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeScript(dir: string, filename: string, code: string): string {
  const fullPath = path.join(dir, filename);
  writeFileSync(fullPath, `#!/usr/bin/env node\n${code}`, "utf8");
  chmodSync(fullPath, 0o755);
  return fullPath;
}

function makeJob(overrides: Partial<Job> = {}): Job {
  const base: Job = {
    run: 42,
    token: "hmac-token-42",
    attempt: 1,
    rule: {
      name: "aux-rule",
      cwd: os.tmpdir(),
      title: "task-{subject}-{id}",
      emits: { source: "probe", types: ["probe.alert", "probe.ok"] },
    },
    agent: {
      id: "probe-agent",
      name: "Probe Agent",
      runner: "command",
      command: [process.execPath, "-e", "process.exit(0)"],
      timeoutMinutes: 1,
    },
    session: null,
    askFirst: [],
    context: {
      events: [
        {
          id: "evt 1\nbad",
          type: "cron.due",
          subject: "svc-api",
          source: "cron",
          sourceName: "Cron",
          receivedAt: "2026-11-13T10:00:00.000Z",
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

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors on already-removed dirs.
    }
  }
});

describe("command-runner (zero-token local probe)", () => {
  it("validates non-empty command array and rejects missing or empty command", async () => {
    const dir = createTempDir("autoloop-cmd-invalid-");
    const jobEmpty = makeJob({
      agent: { id: "bad", name: "Bad", runner: "command", command: [] },
    });
    await assert.rejects(
      () =>
        runCommandProbe({
          job: jobEmpty,
          contextFile: path.join(dir, "context.json"),
          guardFile: path.join(dir, "guard.json"),
        }),
      InputError,
    );

    const jobBlank = makeJob({
      agent: { id: "bad2", name: "Bad2", runner: "command", command: ["   "] },
    });
    await assert.rejects(
      () =>
        runCommandProbe({
          job: jobBlank,
          contextFile: path.join(dir, "context.json"),
          guardFile: path.join(dir, "guard.json"),
        }),
      InputError,
    );
  });

  it("executes command args without shell interpretation, strips secrets, and injects run env", async () => {
    const dir = createTempDir("autoloop-cmd-env-");
    const homeDir = path.join(dir, "home");
    const workDir = path.join(homeDir, "repo");
    mkdirSync(workDir, { recursive: true });

    const outJsonPath = path.join(dir, "captured.json");
    const script = makeScript(
      dir,
      "probe-env.mjs",
      `
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(outJsonPath)}, JSON.stringify({
        argv: process.argv.slice(2),
        cwd: process.cwd(),
        ownerToken: process.env.AUTOLOOP_OWNER_TOKEN ?? null,
        uiToken: process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN ?? null,
        runId: process.env.AUTOLOOP_RUN_ID ?? null,
        context: process.env.AUTOLOOP_CONTEXT ?? null,
        guard: process.env.AUTOLOOP_GUARD_FILE ?? null,
        safe: process.env.SAFE_VAR ?? null,
      }));
      process.stdout.write("探针发现异常\\n\\n\`\`\`agent-autoloop\\n" + JSON.stringify({
        events: [{ id: "probe-1", type: "probe.alert", subject: "svc-api" }],
        notice: [{ title: "告警", text: "延迟升高", fyi: true }],
      }) + "\\n\`\`\`\\n");
      `,
    );

    const contextFile = path.join(dir, "context.json");
    const guardFile = path.join(dir, "guard.json");
    const dangerousArgs = [
      "--url",
      "https://example.com/?a=1&b=2;rm -rf /",
      "$(touch should-not-run)",
      "line1\nline2",
    ];

    const job = makeJob({
      rule: { name: "probe-env", cwd: "~/repo" },
      agent: {
        id: "probe",
        name: "Probe",
        runner: "command",
        command: [process.execPath, script, ...dangerousArgs],
      },
    });

    const result = await runCommandProbe({
      job,
      contextFile,
      guardFile,
      baseEnv: {
        ...process.env,
        HOME: homeDir,
        AUTOLOOP_OWNER_TOKEN: "top-secret-owner",
        ANTIGRAVITY_SIDECAR_UI_TOKEN: "top-secret-ui",
        SAFE_VAR: "preserved",
      },
    });

    assert.equal(result.outcome, "done");
    assert.equal(result.summary, "探针发现异常");
    assert.equal(result.started, true);
    assert.equal(result.session, null);
    assert.equal(result.usage, undefined);
    assert.equal(result.exitCode, 0);
    assert.equal(result.parsed.problem, null);
    assert.equal(result.parsed.receipt?.events?.[0]?.id, "probe-1");
    assert.equal(result.parsed.receipt?.notice?.[0]?.fyi, true);

    const captured = JSON.parse(
      await (await import("node:fs/promises")).readFile(outJsonPath, "utf8"),
    ) as {
      argv: string[];
      cwd: string;
      ownerToken: string | null;
      uiToken: string | null;
      runId: string | null;
      context: string | null;
      guard: string | null;
      safe: string | null;
    };

    assert.deepEqual(captured.argv, dangerousArgs);
    assert.equal(
      captured.cwd,
      await (await import("node:fs/promises")).realpath(workDir),
    );
    assert.equal(captured.ownerToken, null);
    assert.equal(captured.uiToken, null);
    assert.equal(captured.runId, "42");
    assert.equal(captured.context, contextFile);
    assert.equal(captured.guard, guardFile);
    assert.equal(captured.safe, "preserved");
  });

  it("maps empty exit-0 stdout to nothing and handles non-zero exit codes as failed", async () => {
    const dir = createTempDir("autoloop-cmd-outcomes-");
    const silentScript = makeScript(dir, "silent.mjs", "process.exit(0);");
    const failScript = makeScript(
      dir,
      "fail.mjs",
      'process.stderr.write("connection refused\\n"); process.exit(3);',
    );
    const badReceiptScript = makeScript(
      dir,
      "bad-receipt.mjs",
      'process.stdout.write("完成\\n\\n```agent-autoloop\\n{bad json\\n```\\n");',
    );

    const silentRes = await runCommandProbe({
      job: makeJob({
        agent: {
          id: "silent",
          name: "Silent",
          runner: "command",
          command: [process.execPath, silentScript],
        },
      }),
      contextFile: path.join(dir, "c.json"),
      guardFile: path.join(dir, "g.json"),
    });
    assert.equal(silentRes.outcome, "nothing");
    assert.equal(silentRes.summary, "");
    assert.equal(silentRes.exitCode, 0);
    assert.equal(silentRes.parsed.receipt, null);

    const failRes = await runCommandProbe({
      job: makeJob({
        agent: {
          id: "fail",
          name: "Fail",
          runner: "command",
          command: [process.execPath, failScript],
        },
      }),
      contextFile: path.join(dir, "c.json"),
      guardFile: path.join(dir, "g.json"),
    });
    assert.equal(failRes.outcome, "failed");
    assert.equal(failRes.exitCode, 3);
    assert.equal(failRes.started, true);
    assert.match(failRes.error ?? "", /connection refused/);

    const badReceiptRes = await runCommandProbe({
      job: makeJob({
        agent: {
          id: "bad-receipt",
          name: "BadReceipt",
          runner: "command",
          command: [process.execPath, badReceiptScript],
        },
      }),
      contextFile: path.join(dir, "c.json"),
      guardFile: path.join(dir, "g.json"),
    });
    assert.equal(badReceiptRes.outcome, "failed");
    assert.ok(badReceiptRes.parsed.problem);
    assert.equal(badReceiptRes.error, badReceiptRes.parsed.problem);
  });

  it("terminates entire process group on timeout and AbortSignal (SIGTERM -> SIGKILL)", async () => {
    const dir = createTempDir("autoloop-cmd-kill-");
    const pidsFile = path.join(dir, "pids.json");
    const stubbornScript = makeScript(
      dir,
      "stubborn.mjs",
      `
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      process.on("SIGTERM", () => {});
      const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], {
        stdio: "ignore",
      });
      writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify({ parent: process.pid, child: child.pid }));
      setInterval(() => {}, 1000);
      `,
    );

    const timeoutRes = await runCommandProbe({
      job: makeJob({
        agent: {
          id: "stubborn",
          name: "Stubborn",
          runner: "command",
          command: [process.execPath, stubbornScript],
        },
      }),
      contextFile: path.join(dir, "c.json"),
      guardFile: path.join(dir, "g.json"),
      timeoutMs: 900,
      killGraceMs: 60,
    });

    assert.equal(timeoutRes.outcome, "failed");
    assert.match(timeoutRes.error ?? "", /超时/);
    const pids = JSON.parse(
      await (await import("node:fs/promises")).readFile(pidsFile, "utf8"),
    ) as { parent: number; child: number };
    assert.equal(isPidAlive(pids.parent), false);
    assert.equal(isPidAlive(pids.child), false);

    // AbortSignal cancellation test
    const ac = new AbortController();
    const waitScript = makeScript(
      dir,
      "wait.mjs",
      "setInterval(() => {}, 1000);",
    );
    const cancelPromise = runCommandProbe({
      job: makeJob({
        agent: {
          id: "wait",
          name: "Wait",
          runner: "command",
          command: [process.execPath, waitScript],
        },
      }),
      contextFile: path.join(dir, "c.json"),
      guardFile: path.join(dir, "g.json"),
      signal: ac.signal,
      killGraceMs: 50,
      onProcess: () => {
        setTimeout(() => ac.abort(), 40);
      },
    });
    const cancelRes = await cancelPromise;
    assert.equal(cancelRes.outcome, "cancelled");
  });
});

describe("agentapi-runner (interactive UI session wake & transcript watch)", () => {
  it("resolves binary via options/env, sanitizes title & env, starts new-conversation, ignores tool_calls steps, and parses final transcript turn", async () => {
    const dir = createTempDir("autoloop-agentapi-new-");
    const appDataDir = path.join(dir, "appdata");
    const argsLog = path.join(dir, "agentapi-calls.json");
    const sessionId = "11111111-2222-3333-4444-555555555555";

    const fakeAgentApi = makeScript(
      dir,
      "fake-agentapi.mjs",
      `
      import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
      import path from "node:path";
      const args = process.argv.slice(2);
      writeFileSync(${JSON.stringify(argsLog)}, JSON.stringify({
        args,
        ownerToken: process.env.AUTOLOOP_OWNER_TOKEN ?? null,
        uiToken: process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN ?? null,
        runId: process.env.AUTOLOOP_RUN_ID ?? null,
        context: process.env.AUTOLOOP_CONTEXT ?? null,
        guard: process.env.AUTOLOOP_GUARD_FILE ?? null,
      }));
      process.stdout.write(JSON.stringify({ conversationId: ${JSON.stringify(sessionId)} }) + "\\n");

      // Simulate agent writing transcript asynchronously after CLI returns.
      const logsDir = path.join(${JSON.stringify(appDataDir)}, "brain", ${JSON.stringify(sessionId)}, ".system_generated", "logs");
      mkdirSync(logsDir, { recursive: true });
      const tPath = path.join(logsDir, "transcript.jsonl");
      appendFileSync(tPath, JSON.stringify({ step_index: 0, type: "USER_INPUT", status: "DONE", content: "prompt" }) + "\\n");
      setTimeout(() => {
        appendFileSync(tPath, JSON.stringify({
          step_index: 1,
          type: "PLANNER_RESPONSE",
          status: "DONE",
          input_tokens: 100,
          output_tokens: 20,
          cache_read_tokens: 50,
          tool_calls: [{ name: "read_file", args: {} }],
          content: "intermediate text",
        }) + "\\n");
      }, 30);
      setTimeout(() => {
        appendFileSync(tPath, JSON.stringify({
          step_index: 2,
          type: "PLANNER_RESPONSE",
          status: "DONE",
          input_tokens: 120,
          output_tokens: 45,
          cache_read_tokens: 80,
          tool_calls: [],
          content: "交互巡检完成\\n\\n\`\`\`agent-autoloop\\n" + JSON.stringify({
            notice: [{ title: "巡检日报", text: "一切正常", fyi: true }],
          }) + "\\n\`\`\`",
        }) + "\\n");
      }, 70);
      `,
    );

    const startedEvents: Array<{ session: string | null; pid?: number }> = [];
    const job = makeJob({
      agent: {
        id: "ui-agent",
        name: "UI Agent",
        runner: "agentapi-ui",
        model: "gemini-4-hydrogen-high",
      },
      session: null,
    });

    const result = await runAgentApiUi({
      job,
      contextFile: path.join(dir, "context.json"),
      guardFile: path.join(dir, "guard.json"),
      appDataDir,
      pollIntervalMs: 15,
      baseEnv: {
        ...process.env,
        ANTIGRAVITY_AGENTAPI_EXE: fakeAgentApi,
        AUTOLOOP_OWNER_TOKEN: "secret-owner",
        ANTIGRAVITY_SIDECAR_UI_TOKEN: "secret-ui",
      },
      onStarted: (info) => startedEvents.push(info),
    });

    assert.equal(result.outcome, "done");
    assert.equal(result.summary, "交互巡检完成");
    assert.equal(result.session, sessionId);
    assert.equal(result.started, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.parsed.receipt?.notice?.[0]?.title, "巡检日报");
    assert.deepEqual(result.usage, { input: 220, output: 65, cached: 130 });
    assert.equal(startedEvents.length, 1);
    assert.equal(startedEvents[0]?.session, sessionId);

    const recorded = JSON.parse(
      await (await import("node:fs/promises")).readFile(argsLog, "utf8"),
    ) as {
      args: string[];
      ownerToken: string | null;
      uiToken: string | null;
      runId: string | null;
      context: string | null;
      guard: string | null;
    };

    assert.equal(recorded.args[0], "new-conversation");
    assert.equal(recorded.args[1], "--model=gemini-4-hydrogen-high");
    assert.equal(recorded.args[2], "--title=task-svc-api-evt-1-bad");
    assert.match(recorded.args[3] ?? "", /Autoloop 执行任务/);
    assert.equal(recorded.ownerToken, null);
    assert.equal(recorded.uiToken, null);
    assert.equal(recorded.runId, "42");
  });

  it("records transcript high-water mark before send-message so old turns are never re-read", async () => {
    const dir = createTempDir("autoloop-agentapi-resume-");
    const appDataDir = path.join(dir, "appdata");
    const sessionId = "conv-resume-99";
    const logsDir = path.join(
      appDataDir,
      "brain",
      sessionId,
      ".system_generated",
      "logs",
    );
    await mkdir(logsDir, { recursive: true });
    const tPath = path.join(logsDir, "transcript.jsonl");

    // Pre-existing completed turn that must be skipped via high-water mark.
    await writeFile(
      tPath,
      [
        JSON.stringify({
          step_index: 0,
          type: "USER_INPUT",
          status: "DONE",
          content: "old prompt",
        }),
        JSON.stringify({
          step_index: 1,
          type: "PLANNER_RESPONSE",
          status: "DONE",
          content: "旧回合结论",
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const argsLog = path.join(dir, "send-args.json");
    const fakeAgentApi = makeScript(
      dir,
      "fake-send.mjs",
      `
      import { appendFileSync, writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(argsLog)}, JSON.stringify(process.argv.slice(2)));
      setTimeout(() => {
        appendFileSync(${JSON.stringify(tPath)}, JSON.stringify({
          step_index: 2,
          type: "USER_INPUT",
          status: "DONE",
          content: "repair prompt",
        }) + "\\n");
        appendFileSync(${JSON.stringify(tPath)}, JSON.stringify({
          step_index: 3,
          type: "PLANNER_RESPONSE",
          status: "DONE",
          content: "续接新结论\\n\\n\`\`\`agent-autoloop\\n" + JSON.stringify({
            resolve: [{ card: 7, reason: "已确认" }],
          }) + "\\n\`\`\`",
        }) + "\\n");
      }, 40);
      `,
    );

    const job = makeJob({
      agent: {
        id: "ui-agent",
        name: "UI Agent",
        runner: "agentapi-ui",
      },
      session: sessionId,
    });

    const result = await runAgentApiUi({
      job,
      contextFile: path.join(dir, "context.json"),
      guardFile: path.join(dir, "guard.json"),
      promptOverride: "仅重写最后一条消息",
      agentApiBin: fakeAgentApi,
      appDataDir,
      pollIntervalMs: 15,
    });

    assert.equal(result.outcome, "done");
    assert.equal(result.summary, "续接新结论");
    assert.equal(result.session, sessionId);
    assert.equal(result.started, true);
    assert.equal(result.parsed.receipt?.resolve?.[0]?.card, 7);

    const sendArgs = JSON.parse(
      await (await import("node:fs/promises")).readFile(argsLog, "utf8"),
    ) as string[];
    assert.deepEqual(sendArgs, [
      "send-message",
      sessionId,
      "仅重写最后一条消息",
    ]);
  });

  it("supports truncated_fields content lookup in transcript_full.jsonl and PLANNER_RESPONSE ERROR steps", async () => {
    const dir = createTempDir("autoloop-agentapi-full-");
    const appDataDir = path.join(dir, "appdata");
    const sessionId = "conv-full-1";
    const logsDir = path.join(
      appDataDir,
      "brain",
      sessionId,
      ".system_generated",
      "logs",
    );
    await mkdir(logsDir, { recursive: true });
    const tPath = path.join(logsDir, "transcript.jsonl");
    const fullPath = path.join(logsDir, "transcript_full.jsonl");

    const fakeAgentApi = makeScript(
      dir,
      "fake-ok.mjs",
      `
      import { appendFileSync } from "node:fs";
      const target = process.argv[4];
      if (target && target.includes("truncated")) {
        appendFileSync(${JSON.stringify(tPath)}, JSON.stringify({
          step_index: 0,
          type: "PLANNER_RESPONSE",
          status: "DONE",
          truncated_fields: ["content"],
          content: "截断内容...",
        }) + "\\n");
      }
      process.stdout.write("ok\\n");
      `,
    );

    const fullContent =
      "完整正文结论\n\n```agent-autoloop\n" +
      JSON.stringify({
        later: [
          {
            key: "recheck",
            at: "2026-11-14T09:00:00Z",
            about: "复查",
          },
        ],
      }) +
      "\n```";

    await writeFile(
      fullPath,
      JSON.stringify({
        step_index: 0,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        content: fullContent,
      }) + "\n",
      "utf8",
    );

    const resFull = await runAgentApiUi({
      job: makeJob({
        agent: { id: "ui", name: "UI", runner: "agentapi-ui" },
        session: sessionId,
      }),
      contextFile: path.join(dir, "c.json"),
      guardFile: path.join(dir, "g.json"),
      promptOverride: "trigger truncated check",
      agentApiBin: fakeAgentApi,
      appDataDir,
      pollIntervalMs: 15,
    });
    assert.equal(resFull.outcome, "done");
    assert.equal(resFull.summary, "完整正文结论");
    assert.equal(resFull.parsed.receipt?.later?.[0]?.key, "recheck");

    // Append an ERROR step and verify failure handling.
    const resErrPromise = runAgentApiUi({
      job: makeJob({
        agent: { id: "ui", name: "UI", runner: "agentapi-ui" },
        session: sessionId,
      }),
      contextFile: path.join(dir, "c.json"),
      guardFile: path.join(dir, "g.json"),
      agentApiBin: fakeAgentApi,
      appDataDir,
      pollIntervalMs: 15,
    });
    setTimeout(() => {
      void appendFile(
        tPath,
        JSON.stringify({
          step_index: 1,
          type: "PLANNER_RESPONSE",
          status: "ERROR",
          error: "model quota exceeded",
        }) + "\n",
      );
    }, 30);

    const resErr = await resErrPromise;
    assert.equal(resErr.outcome, "failed");
    assert.equal(resErr.started, true);
    assert.match(resErr.error ?? "", /model quota exceeded/);
  });

  it("returns started: false when send-message fails before delivery (missing session)", async () => {
    const dir = createTempDir("autoloop-agentapi-missing-");
    const fakeAgentApi = makeScript(
      dir,
      "fake-missing.mjs",
      'process.stderr.write("conversation not found\\n"); process.exit(1);',
    );

    let onStartedCalled = false;
    const res = await runAgentApiUi({
      job: makeJob({
        agent: { id: "ui", name: "UI", runner: "agentapi-ui" },
        session: "nonexistent-conv",
      }),
      contextFile: path.join(dir, "c.json"),
      guardFile: path.join(dir, "g.json"),
      agentApiBin: fakeAgentApi,
      appDataDir: path.join(dir, "appdata"),
      onStarted: () => {
        onStartedCalled = true;
      },
    });

    assert.equal(res.outcome, "failed");
    assert.equal(res.started, false);
    assert.equal(res.session, "nonexistent-conv");
    assert.equal(res.exitCode, 1);
    assert.equal(onStartedCalled, false);
    assert.match(res.error ?? "", /conversation not found/);
  });

  it("handles AbortSignal and timeout cleanly while waiting on transcript.jsonl", async () => {
    const dir = createTempDir("autoloop-agentapi-abort-");
    const appDataDir = path.join(dir, "appdata");
    const fakeAgentApi = makeScript(
      dir,
      "fake-start.mjs",
      'process.stdout.write("conv-wait-1\\n");',
    );

    const ac = new AbortController();
    const cancelPromise = runAgentApiUi({
      job: makeJob({
        agent: { id: "ui", name: "UI", runner: "agentapi-ui" },
        session: null,
      }),
      contextFile: path.join(dir, "c.json"),
      guardFile: path.join(dir, "g.json"),
      agentApiBin: fakeAgentApi,
      appDataDir,
      pollIntervalMs: 20,
      signal: ac.signal,
      onStarted: () => {
        setTimeout(() => ac.abort(), 50);
      },
    });
    const cancelRes = await cancelPromise;
    assert.equal(cancelRes.outcome, "cancelled");
    assert.equal(cancelRes.started, true);
    assert.equal(cancelRes.session, "conv-wait-1");

    const timeoutRes = await runAgentApiUi({
      job: makeJob({
        agent: { id: "ui", name: "UI", runner: "agentapi-ui" },
        session: null,
      }),
      contextFile: path.join(dir, "c.json"),
      guardFile: path.join(dir, "g.json"),
      agentApiBin: fakeAgentApi,
      appDataDir,
      pollIntervalMs: 20,
      killGraceMs: 50,
      timeoutMs: 1200,
    });
    assert.equal(timeoutRes.outcome, "failed");
    assert.equal(timeoutRes.started, true);
    assert.equal(timeoutRes.session, "conv-wait-1");
    assert.match(timeoutRes.error ?? "", /超时/);

    // Explicit pre-delivery CLI timeout -> started: false
    const fakeHangCli = makeScript(
      dir,
      "fake-hang-cli.mjs",
      "setInterval(() => {}, 1000);",
    );
    const cliTimeoutRes = await runAgentApiUi({
      job: makeJob({
        agent: { id: "ui", name: "UI", runner: "agentapi-ui" },
        session: null,
      }),
      contextFile: path.join(dir, "c.json"),
      guardFile: path.join(dir, "g.json"),
      agentApiBin: fakeHangCli,
      appDataDir,
      pollIntervalMs: 20,
      killGraceMs: 50,
      timeoutMs: 120,
    });
    assert.equal(cliTimeoutRes.outcome, "failed");
    assert.equal(cliTimeoutRes.started, false);
    assert.equal(cliTimeoutRes.session, null);
    assert.match(cliTimeoutRes.error ?? "", /超时/);
  });

  it("prepends 'agentapi' subcommand when ANTIGRAVITY_AGENTAPI_EXE points to language_server", async () => {
    const dir = createTempDir("autoloop-ls-bin-");
    const appDataDir = path.join(dir, "appdata");
    const argvLog = path.join(dir, "argv.json");

    const fakeLs = makeScript(
      dir,
      "language_server",
      `
      import { writeFileSync, mkdirSync } from "node:fs";
      import path from "node:path";
      writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)), "utf8");
      if (process.argv[2] !== "agentapi" || process.argv[3] !== "new-conversation") {
        process.stderr.write("Language server failed - Failed to read initial metadata from stdin\\n");
        process.exit(2);
      }
      const session = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      const logDir = path.join(${JSON.stringify(appDataDir)}, "brain", session, ".system_generated", "logs");
      mkdirSync(logDir, { recursive: true });
      const step = JSON.stringify({
        step_index: 1,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        content: "已完成 language_server agentapi 子命令测试。"
      }) + "\\n";
      writeFileSync(path.join(logDir, "transcript.jsonl"), step, "utf8");
      writeFileSync(path.join(logDir, "transcript_full.jsonl"), step, "utf8");
      process.stdout.write(session + "\\n");
      `,
    );

    const res = await runAgentApiUi({
      job: makeJob({
        agent: { id: "ui", name: "UI", runner: "agentapi-ui", model: "gemini-4-hydrogen-low" },
        session: null,
      }),
      contextFile: path.join(dir, "c.json"),
      guardFile: path.join(dir, "g.json"),
      baseEnv: { ...process.env, ANTIGRAVITY_AGENTAPI_EXE: fakeLs },
      appDataDir,
      pollIntervalMs: 20,
      timeoutMs: 3000,
    });

    assert.equal(res.outcome, "done");
    assert.equal(res.session, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  });
});
