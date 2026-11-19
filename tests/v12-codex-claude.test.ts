/**
 * WP-1 V1.2 Native `codex` & `claude`/`zcode`/`dsh` Stream Runner Regression Tests.
 *
 * 防止的真实故障与安全越界：
 * 1. `codex exec` 在新开会话与 `resume` 续接模式下参数顺序错位（`-C`、`-s` 必须在 `resume` 前，
 *    `--json`、`-o`、`-m`、`-c` 必须在 `resume` 后），或 `effort: "max"` 未映射为 Codex 支持的 `"xhigh"` 导致 CLI 报错退出；
 * 2. 提示词通过命令行参数拼接引发超长上下文 `E2BIG` 或 `shell: true` 命令注入，或外部不可信 `summary`/`detail` 混入 stdin 提示词；
 * 3. 控制面高权凭据（`AUTOLOOP_OWNER_TOKEN`、`AUTOLOOP_INGEST_TOKEN`、`ANTIGRAVITY_SIDECAR_UI_TOKEN`、`AUTOLOOP_MASTER_KEY` 等）
 *    泄漏进 `codex`/`claude`/`zcode` 子进程环境，或 Sidecar 精简 `PATH` 下找不到 `~/.local/bin` / Homebrew 中的 CLI 可执行文件；
 * 4. Claude 系（`claude`/`zcode`/`dsh`）`usage.input_tokens` 不含缓存 Token，若直接赋值会导致 `cached > input` 严重倒挂与成本统计失真（#271），
 *    或 Codex 不同模型返回口径差异触发 `cached > input` 倒挂；
 * 5. Codex 流式输出遗漏正文时未能通过 `-o <lastMsgFile>` 无损兜底恢复回执，或临时 `codex-last-msg-*.txt` 结算后泄漏残留磁盘；
 * 6. 会话 ID 在首个启动事件之后才延迟出现时漏调第二次 `onStarted` 导致内核丢失真实 `session`；
 * 7. 流式回合已完成（`turn.completed` / `result`）但子代理派生的后台孙进程持有管道不退出导致假超时，或 `AbortSignal` 取消时未按 `-pid` 强杀整个进程组留下孤儿进程。
 */

import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { buildClaudeArgs, runClaudePrint } from "../engine/claude-runner.ts";
import { buildCodexArgs, runCodexExec } from "../engine/codex-runner.ts";
import type { Job } from "../protocol/types.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix = "autoloop-v12-wp1-"): string {
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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function makeJob(overrides: Partial<Job> = {}): Job {
  const base: Job = {
    run: 101,
    token: "hmac-v12-token",
    attempt: 1,
    rule: {
      name: "code-fix",
      cwd: os.tmpdir(),
      skill: "recipe-issue-triage",
      prompt: "Fix the reported defect safely.",
    },
    agent: {
      id: "codex-worker",
      name: "Codex Worker",
      runner: "codex",
      model: "gpt-5.4",
      effort: "high",
      access: "edit",
      timeoutMinutes: 10,
    },
    session: null,
    askFirst: ["rm -rf", "git push --force"],
    context: {
      events: [
        {
          id: "evt-v12-1",
          type: "issue.opened",
          subject: "issue#271",
          summary: "UNTRUSTED_SUMMARY_DO_NOT_INLINE",
          detail: "UNTRUSTED_DETAIL_SECRET_INJECTION",
          source: "inbox",
          sourceName: "Inbox",
          receivedAt: "2026-11-19T17:00:00Z",
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

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("codex-runner: CLI args, stdin, env sanitization & JSONL lifecycle", () => {
  it("constructs exact codex exec args for new vs resume sessions, 3 access tiers, model/effort (max -> xhigh), and custom command prefix", () => {
    const newReadJob = makeJob({
      session: null,
      agent: {
        id: "codex-read",
        name: "Codex Read",
        runner: "codex",
        model: "gpt-5.4",
        effort: "max",
        access: "read",
        command: ["/custom/codex", "--oss"],
      },
    });

    assert.deepEqual(
      buildCodexArgs(
        newReadJob,
        ["--oss"],
        "/work/repo",
        "/tmp/run/codex-last-msg-abc.txt",
      ),
      [
        "--oss",
        "exec",
        "-C",
        "/work/repo",
        "--skip-git-repo-check",
        "--color",
        "never",
        "-s",
        "read-only",
        "--json",
        "-o",
        "/tmp/run/codex-last-msg-abc.txt",
        "-m",
        "gpt-5.4",
        "-c",
        'model_reasoning_effort="xhigh"',
        "-",
      ],
    );

    const resumeEditDefaultJob = makeJob({
      session: "019c1234-5678-7abc-def0-123456789abc",
      agent: {
        id: "codex-edit",
        name: "Codex Edit",
        runner: "codex",
        model: "gpt-5.4-mini",
        effort: "medium",
        access: undefined,
      },
    });

    assert.deepEqual(
      buildCodexArgs(
        resumeEditDefaultJob,
        [],
        "/work/repo",
        "/tmp/run/codex-last-msg-def.txt",
      ),
      [
        "exec",
        "-C",
        "/work/repo",
        "--skip-git-repo-check",
        "--color",
        "never",
        "-s",
        "workspace-write",
        "resume",
        "--json",
        "-o",
        "/tmp/run/codex-last-msg-def.txt",
        "-m",
        "gpt-5.4-mini",
        "-c",
        'model_reasoning_effort="medium"',
        "019c1234-5678-7abc-def0-123456789abc",
        "-",
      ],
    );

    const resumeFullJob = makeJob({
      session: "thread-full-9",
      agent: {
        id: "codex-full",
        name: "Codex Full",
        runner: "codex",
        model: undefined,
        effort: undefined,
        access: "full",
      },
    });

    assert.deepEqual(
      buildCodexArgs(
        resumeFullJob,
        [],
        "/work/repo",
        "/tmp/run/codex-last-msg-full.txt",
      ),
      [
        "exec",
        "-C",
        "/work/repo",
        "--skip-git-repo-check",
        "--color",
        "never",
        "--dangerously-bypass-approvals-and-sandbox",
        "resume",
        "--json",
        "-o",
        "/tmp/run/codex-last-msg-full.txt",
        "thread-full-9",
        "-",
      ],
    );
  });

  it("delivers prompt via stdin (shell: false), strips control-plane secrets, prepends standard PATH dirs, parses JSONL & cleans up lastMsgFile", async () => {
    const dir = makeTempDir();
    const runDir = path.join(dir, "run-files");
    mkdirSync(runDir, { recursive: true });
    const workDir = path.join(dir, "workspace");
    mkdirSync(workDir, { recursive: true });

    const captureFile = path.join(dir, "codex-capture.json");
    const canaryPath = path.join(dir, "shell-pwned");
    const fakeHome = path.join(dir, "fake-home");

    const fakeCodex = makeExecutableScript(
      dir,
      "fake-codex.mjs",
      `
      import { readFileSync, writeFileSync } from "node:fs";
      const stdinText = readFileSync(0, "utf8");
      const argv = process.argv.slice(2);
      const outIdx = argv.indexOf("-o");
      const lastMsgFile = outIdx !== -1 ? argv[outIdx + 1] : null;
      if (lastMsgFile) {
        writeFileSync(lastMsgFile, "备用落盘正文", "utf8");
      }
      writeFileSync(${JSON.stringify(captureFile)}, JSON.stringify({
        argv,
        cwd: process.cwd(),
        stdinText,
        lastMsgFile,
        env: {
          path: process.env.PATH ?? "",
          owner: process.env.AUTOLOOP_OWNER_TOKEN ?? null,
          ingest: process.env.AUTOLOOP_INGEST_TOKEN ?? null,
          sidecarUi: process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN ?? null,
          masterKey: process.env.AUTOLOOP_MASTER_KEY ?? null,
          runId: process.env.AUTOLOOP_RUN_ID ?? null,
          context: process.env.AUTOLOOP_CONTEXT ?? null,
          guard: process.env.AUTOLOOP_GUARD_FILE ?? null,
          keep: process.env.OPENAI_API_KEY ?? null,
        }
      }), "utf8");

      console.log(JSON.stringify({ type: "thread.started", thread_id: "019c9999-codex-thread" }));
      console.log(JSON.stringify({ type: "turn.started" }));
      console.log(JSON.stringify({
        type: "item.completed",
        item: { id: "item_0", type: "reasoning", text: "内部推理内容不应作为最终回复" }
      }));
      console.log(JSON.stringify({
        type: "item.completed",
        item: {
          id: "item_1",
          type: "agent_message",
          text: "已完成补丁验证 $(touch " + ${JSON.stringify(canaryPath)} + ")\\n\\n\`\`\`agent-autoloop\\n{\\"notice\\":[{\\"key\\":\\"codex-ok\\",\\"title\\":\\"Codex 完成\\",\\"text\\":\\"全部通过\\",\\"fyi\\":true}]}\\n\`\`\`"
        }
      }));
      console.log(JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 1800, cached_input_tokens: 1200, output_tokens: 95 }
      }));
      `,
    );

    const contextFile = path.join(runDir, "context.json");
    const guardFile = path.join(runDir, "guard.json");
    const startedCalls: Array<{ session: string | null; pid?: number }> = [];

    const job = makeJob({
      run: 202,
      rule: {
        name: "code-fix",
        cwd: workDir,
        prompt: `Inspect safely $(touch ${canaryPath})`,
      },
      agent: {
        id: "codex-custom",
        name: "Codex Custom",
        runner: "codex",
        command: [fakeCodex, "--profile", "ci"],
        model: "gpt-5.4",
        effort: "max",
        access: "edit",
      },
    });

    const exec = await runCodexExec({
      job,
      contextFile,
      guardFile,
      baseEnv: {
        ...process.env,
        HOME: fakeHome,
        AUTOLOOP_OWNER_TOKEN: "secret-owner",
        AUTOLOOP_INGEST_TOKEN: "secret-ingest",
        ANTIGRAVITY_SIDECAR_UI_TOKEN: "secret-ui",
        AUTOLOOP_MASTER_KEY: "secret-master",
        OPENAI_API_KEY: "sk-test-keep",
      },
      onStarted: (info) => startedCalls.push(info),
    });

    assert.equal(existsSync(canaryPath), false);
    assert.equal(exec.outcome, "done");
    assert.equal(exec.started, true);
    assert.equal(exec.session, "019c9999-codex-thread");
    assert.equal(exec.exitCode, 0);
    assert.match(exec.summary, /^已完成补丁验证/);
    assert.equal(exec.parsed.problem, null);
    assert.equal(exec.parsed.receipt?.notice?.[0]?.key, "codex-ok");
    assert.deepEqual(exec.usage, {
      input: 1800,
      cached: 1200,
      output: 95,
    });

    assert.equal(startedCalls.length, 1);
    assert.equal(startedCalls[0]?.session, "019c9999-codex-thread");
    assert.ok((startedCalls[0]?.pid ?? 0) > 0);

    const captured = JSON.parse(readFileSync(captureFile, "utf8")) as {
      argv: string[];
      stdinText: string;
      lastMsgFile: string;
      env: Record<string, string | null>;
    };

    assert.equal(captured.argv[0], "--profile");
    assert.equal(captured.argv[1], "ci");
    assert.equal(captured.argv[2], "exec");
    assert.equal(captured.argv.at(-1), "-");
    assert.match(captured.stdinText, /Autoloop 执行任务/);
    assert.equal(
      captured.stdinText.includes("UNTRUSTED_SUMMARY_DO_NOT_INLINE"),
      false,
    );
    assert.equal(
      captured.stdinText.includes("UNTRUSTED_DETAIL_SECRET_INJECTION"),
      false,
    );

    assert.equal(captured.env.owner, null);
    assert.equal(captured.env.ingest, null);
    assert.equal(captured.env.sidecarUi, null);
    assert.equal(captured.env.masterKey, null);
    assert.equal(captured.env.runId, "202");
    assert.equal(captured.env.context, contextFile);
    assert.equal(captured.env.guard, guardFile);
    assert.equal(captured.env.keep, "sk-test-keep");

    const expectedPrefix = [
      `${fakeHome}/.local/bin`,
      `${fakeHome}/.local/lib/node-v24.19.0-darwin-arm4/bin`,
      `${fakeHome}/.local/lib/node-v24.19.0-darwin-arm64/bin`,
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ].join(":");
    assert.ok(
      (captured.env.path ?? "").startsWith(expectedPrefix),
      `Expected PATH to start with ${expectedPrefix}, got ${captured.env.path}`,
    );

    // Temporary -o lastMsgFile must be cleaned up after settlement
    assert.equal(existsSync(captured.lastMsgFile), false);
    const leftoverFiles = readdirSync(runDir).filter((f) =>
      f.startsWith("codex-last-msg-"),
    );
    assert.deepEqual(leftoverFiles, []);
  });

  it("falls back to -o lastMsgFile when JSONL stream lacks agent_message, protects usage from cached > input inversion, and supports delayed session notification", async () => {
    const dir = makeTempDir();
    const fakeCodex = makeExecutableScript(
      dir,
      "fake-codex-fallback.mjs",
      `
      import { writeFileSync } from "node:fs";
      const argv = process.argv.slice(2);
      const outIdx = argv.indexOf("-o");
      const lastMsgFile = argv[outIdx + 1];

      // 1. Start without thread_id first -> triggers initial onStarted(null)
      console.log(JSON.stringify({ type: "turn.started" }));
      // 2. Reveal thread_id later -> triggers second onStarted("thread-delayed-77")
      console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-delayed-77" }));

      // Emit no item.completed agent_message on stdout, only write to -o lastMsgFile!
      writeFileSync(
        lastMsgFile,
        "没事可做：巡检全部绿灯\\n\\n\`\`\`agent-autoloop\\n{\\"resolve\\":[{\\"card\\":9,\\"reason\\":\\"已恢复\\"}]}\\n\`\`\`",
        "utf8"
      );

      // Emit cached_input_tokens > input_tokens to verify anti-inversion protection
      console.log(JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 250, cached_input_tokens: 1900, output_tokens: 45 }
      }));
      `,
    );

    const startedCalls: Array<{ session: string | null; pid?: number }> = [];
    const exec = await runCodexExec({
      job: makeJob({ session: null }),
      contextFile: path.join(dir, "context.json"),
      guardFile: path.join(dir, "guard.json"),
      codexBin: fakeCodex,
      onStarted: (info) => startedCalls.push(info),
    });

    assert.deepEqual(
      startedCalls.map((c) => c.session),
      [null, "thread-delayed-77"],
    );
    assert.equal(exec.outcome, "nothing");
    assert.equal(exec.summary, "巡检全部绿灯");
    assert.equal(exec.session, "thread-delayed-77");
    assert.equal(exec.parsed.receipt?.resolve?.[0]?.card, 9);
    assert.deepEqual(exec.usage, {
      input: 1900,
      cached: 1900,
      output: 45,
    });
  });

  it("reclaims lingering grandchild processes after turn.completed via postResultGraceMs and kills process group on AbortSignal", async () => {
    const dir = makeTempDir();
    const gracePidsFile = path.join(dir, "codex-grace-pids.json");

    const fakeHangingAfterTurn = makeExecutableScript(
      dir,
      "fake-codex-grace.mjs",
      `
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";

      const child = spawn(process.execPath, [
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"
      ], { stdio: "inherit" });

      writeFileSync(${JSON.stringify(gracePidsFile)}, JSON.stringify({
        parentPid: process.pid,
        childPid: child.pid
      }), "utf8");

      console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-grace-1" }));
      console.log(JSON.stringify({
        type: "item.completed",
        item: { id: "item_1", type: "agent_message", text: "已完成并等待回收" }
      }));
      console.log(JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10 }
      }));
      // Keep parent alive too until postResultGraceMs reclaims process group
      setInterval(() => {}, 1000);
      `,
    );

    const graceExec = await runCodexExec({
      job: makeJob(),
      contextFile: path.join(dir, "context.json"),
      guardFile: path.join(dir, "guard.json"),
      codexBin: fakeHangingAfterTurn,
      postResultGraceMs: 120,
      killGraceMs: 60,
    });

    assert.equal(graceExec.outcome, "done");
    assert.equal(graceExec.summary, "已完成并等待回收");
    assert.equal(graceExec.exitCode, 0);
    assert.equal(graceExec.timedOut, false);
    const gracePids = JSON.parse(readFileSync(gracePidsFile, "utf8")) as {
      parentPid: number;
      childPid: number;
    };
    assert.equal(isProcessAlive(gracePids.parentPid), false);
    assert.equal(isProcessAlive(gracePids.childPid), false);

    // AbortSignal mid-run group kill test
    const abortPidsFile = path.join(dir, "codex-abort-pids.json");
    const fakeStubborn = makeExecutableScript(
      dir,
      "fake-codex-abort.mjs",
      `
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      process.on("SIGTERM", () => {});
      const child = spawn(process.execPath, [
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"
      ], { stdio: "inherit" });
      writeFileSync(${JSON.stringify(abortPidsFile)}, JSON.stringify({
        parentPid: process.pid,
        childPid: child.pid
      }), "utf8");
      console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-abort-2" }));
      setInterval(() => {}, 1000);
      `,
    );

    const ac = new AbortController();
    const abortExec = await runCodexExec({
      job: makeJob(),
      contextFile: path.join(dir, "context.json"),
      guardFile: path.join(dir, "guard.json"),
      codexBin: fakeStubborn,
      signal: ac.signal,
      killGraceMs: 60,
      onStarted: () => {
        const poll = setInterval(() => {
          if (existsSync(abortPidsFile)) {
            clearInterval(poll);
            ac.abort();
          }
        }, 10);
      },
    });

    assert.equal(abortExec.outcome, "cancelled");
    assert.equal(abortExec.cancelled, true);
    assert.equal(abortExec.started, true);
    assert.equal(abortExec.session, "thread-abort-2");
    const abortPids = JSON.parse(readFileSync(abortPidsFile, "utf8")) as {
      parentPid: number;
      childPid: number;
    };
    assert.equal(isProcessAlive(abortPids.parentPid), false);
    assert.equal(isProcessAlive(abortPids.childPid), false);
  });

  it("supports AUTOLOOP_CODEX_BIN fallback, multi-message latest reply extraction, pre-start vs post-start failure distinction, and timeoutMinutes", async () => {
    const dir = makeTempDir();

    // Pre-start broken resume (must keep started=false & session=null for supervisor downgrade)
    const fakePreFail = makeExecutableScript(
      dir,
      "fake-codex-prefail.mjs",
      `
      console.log(JSON.stringify({ type: "error", message: "No rollout found for thread_id dead-thread" }));
      process.exit(1);
      `,
    );

    let preStarted = false;
    const preExec = await runCodexExec({
      job: makeJob({ session: "dead-thread" }),
      contextFile: path.join(dir, "context.json"),
      guardFile: path.join(dir, "guard.json"),
      baseEnv: { ...process.env, AUTOLOOP_CODEX_BIN: fakePreFail },
      onStarted: () => {
        preStarted = true;
      },
    });
    assert.equal(preStarted, false);
    assert.equal(preExec.outcome, "failed");
    assert.equal(preExec.started, false);
    assert.equal(preExec.session, null);
    assert.match(preExec.error ?? "", /No rollout found/);

    // Multi-item agent_message (commentary -> final conclusion) + turn.failed post-start check
    const fakeMultiMsg = makeExecutableScript(
      dir,
      "fake-codex-multi.mjs",
      `
      console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-multi-1" }));
      console.log(JSON.stringify({
        type: "item.completed",
        item: { id: "item_1", type: "agent_message", text: "先检查一下仓库状态……" }
      }));
      console.log(JSON.stringify({
        type: "item.completed",
        item: { id: "item_2", type: "agent_message", text: "没事可做：仓库已是最新状态" }
      }));
      console.log(JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 400, cached_input_tokens: 100, output_tokens: 30 }
      }));
      `,
    );

    const multiExec = await runCodexExec({
      job: makeJob(),
      contextFile: path.join(dir, "context.json"),
      guardFile: path.join(dir, "guard.json"),
      codexBin: fakeMultiMsg,
    });
    assert.equal(multiExec.outcome, "nothing");
    assert.equal(multiExec.summary, "仓库已是最新状态");
    assert.equal(multiExec.session, "thread-multi-1");

    // timeoutMinutes expiration
    const fakeHang = makeExecutableScript(
      dir,
      "fake-codex-hang.mjs",
      `
      console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-timeout-9" }));
      setInterval(() => {}, 1000);
      `,
    );
    const timeoutExec = await runCodexExec({
      job: makeJob({
        agent: {
          id: "codex-hang",
          name: "Codex Hang",
          runner: "codex",
          timeoutMinutes: 0.025, // 1500ms
        },
      }),
      contextFile: path.join(dir, "context.json"),
      guardFile: path.join(dir, "guard.json"),
      codexBin: fakeHang,
      killGraceMs: 50,
    });
    assert.equal(timeoutExec.outcome, "failed");
    assert.equal(timeoutExec.timedOut, true);
    assert.equal(timeoutExec.started, true);
    assert.equal(timeoutExec.session, "thread-timeout-9");
    assert.match(timeoutExec.error ?? "", /timed out/i);
  });
});

describe("claude-runner: claude/zcode/dsh args, #271 cache token accounting & NDJSON lifecycle", () => {
  it("constructs exact claude/zcode/dsh stream-json args across access tiers, model, effort, and --resume", () => {
    const readJob = makeJob({
      session: null,
      agent: {
        id: "claude-reviewer",
        name: "Claude Reviewer",
        runner: "claude",
        model: "claude-opus-4-6",
        effort: "max",
        access: "read",
      },
    });

    assert.deepEqual(buildClaudeArgs(readJob, []), [
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--model",
      "claude-opus-4-6",
      "--effort",
      "max",
      "--permission-mode",
      "plan",
    ]);

    const zcodeResumeEditJob = makeJob({
      session: "sess-zcode-88",
      agent: {
        id: "zcode-worker",
        name: "ZCode Worker",
        runner: "claude",
        command: ["zcode", "--profile", "team"],
        model: "glm-5",
        effort: "high",
        access: undefined,
      },
    });

    assert.deepEqual(
      buildClaudeArgs(zcodeResumeEditJob, ["--profile", "team"]),
      [
        "--profile",
        "team",
        "-p",
        "--verbose",
        "--output-format",
        "stream-json",
        "--model",
        "glm-5",
        "--effort",
        "high",
        "--permission-mode",
        "acceptEdits",
        "--resume",
        "sess-zcode-88",
      ],
    );

    const fullDshJob = makeJob({
      session: "sess-dsh-9",
      agent: {
        id: "dsh-worker",
        name: "DSH Worker",
        runner: "claude",
        command: ["dsh"],
        model: undefined,
        effort: undefined,
        access: "full",
      },
    });

    assert.deepEqual(buildClaudeArgs(fullDshJob, []), [
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--permission-mode",
      "bypassPermissions",
      "--allow-dangerously-skip-permissions",
      "--resume",
      "sess-dsh-9",
    ]);
  });

  it("executes custom command: ['zcode'] via PATH, passes prompt via stdin, strips secrets, and computes #271 cache tokens without cached > input inversion", async () => {
    const dir = makeTempDir();
    const binDir = path.join(dir, "custom-bin");
    mkdirSync(binDir, { recursive: true });
    const fakeHome = path.join(dir, "fake-home");
    const workSubdir = path.join(fakeHome, "proj");
    mkdirSync(workSubdir, { recursive: true });
    const captureFile = path.join(dir, "zcode-capture.json");

    makeExecutableScript(
      binDir,
      "zcode",
      `
      import { readFileSync, realpathSync, writeFileSync } from "node:fs";
      const stdinText = readFileSync(0, "utf8");
      writeFileSync(${JSON.stringify(captureFile)}, JSON.stringify({
        argv: process.argv.slice(2),
        cwd: realpathSync(process.cwd()),
        stdinText,
        env: {
          owner: process.env.AUTOLOOP_OWNER_TOKEN ?? null,
          sidecar: process.env.ANTIGRAVITY_SIDECAR_TOKEN ?? null,
          runId: process.env.AUTOLOOP_RUN_ID ?? null,
          context: process.env.AUTOLOOP_CONTEXT ?? null,
          guard: process.env.AUTOLOOP_GUARD_FILE ?? null,
        }
      }), "utf8");

      console.log(JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "zcode-sess-271"
      }));
      console.log(JSON.stringify({
        type: "assistant",
        session_id: "zcode-sess-271",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "analyzing cache accounting..." },
            {
              type: "text",
              text: "已完成 ZCode 审查\\n\\n\`\`\`agent-autoloop\\n{\\"ask\\":[{\\"key\\":\\"approve-merge\\",\\"title\\":\\"合并确认\\",\\"text\\":\\"是否合并补丁？\\",\\"options\\":[\\"合并\\",\\"暂缓\\"],\\"recommend\\":0,\\"about\\":\\"PR #271\\"}]}\\n\`\`\`"
            }
          ],
          usage: {
            input_tokens: 15,
            cache_read_input_tokens: 18000,
            cache_creation_input_tokens: 450,
            output_tokens: 120
          }
        }
      }));
      console.log(JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "zcode-sess-271",
        result: "已完成 ZCode 审查\\n\\n\`\`\`agent-autoloop\\n{\\"ask\\":[{\\"key\\":\\"approve-merge\\",\\"title\\":\\"合并确认\\",\\"text\\":\\"是否合并补丁？\\",\\"options\\":[\\"合并\\",\\"暂缓\\"],\\"recommend\\":0,\\"about\\":\\"PR #271\\"}]}\\n\`\`\`",
        total_cost_usd: 0.0425,
        usage: {
          input_tokens: 15,
          cache_read_input_tokens: 18000,
          cache_creation_input_tokens: 450,
          output_tokens: 120
        }
      }));
      `,
    );

    const startedCalls: Array<{ session: string | null; pid?: number }> = [];
    const contextFile = path.join(dir, "context.json");
    const guardFile = path.join(dir, "guard.json");

    const exec = await runClaudePrint({
      job: makeJob({
        run: 271,
        rule: {
          name: "zcode-review",
          cwd: "~/proj",
        },
        agent: {
          id: "zcode-agent",
          name: "ZCode Agent",
          runner: "claude",
          command: ["zcode"],
          model: "claude-sonnet-4-6",
          effort: "high",
          access: "edit",
        },
      }),
      contextFile,
      guardFile,
      promptOverride: "请审查补丁并输出回执",
      baseEnv: {
        ...process.env,
        HOME: fakeHome,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        AUTOLOOP_OWNER_TOKEN: "strip-me",
        ANTIGRAVITY_SIDECAR_TOKEN: "strip-sidecar",
      },
      onStarted: (info) => startedCalls.push(info),
    });

    assert.equal(exec.outcome, "done");
    assert.equal(exec.started, true);
    assert.equal(exec.session, "zcode-sess-271");
    assert.equal(exec.summary, "已完成 ZCode 审查");
    assert.equal(exec.parsed.problem, null);
    assert.equal(exec.parsed.receipt?.ask?.[0]?.key, "approve-merge");

    // #271 verification: input = 15 + 18000 + 450 = 18465, cached = 18000 (cached <= input, zero double-count!)
    assert.deepEqual(exec.usage, {
      input: 18465,
      cached: 18000,
      output: 120,
      cost: 0.0425,
    });
    assert.ok((exec.usage?.cached ?? 0) <= (exec.usage?.input ?? 0));

    assert.equal(startedCalls.length, 1);
    assert.equal(startedCalls[0]?.session, "zcode-sess-271");

    const captured = JSON.parse(readFileSync(captureFile, "utf8")) as {
      argv: string[];
      cwd: string;
      stdinText: string;
      env: Record<string, string | null>;
    };
    assert.equal(captured.stdinText, "请审查补丁并输出回执");
    assert.ok(captured.cwd.endsWith(path.join("fake-home", "proj")));
    assert.equal(captured.env.owner, null);
    assert.equal(captured.env.sidecar, null);
    assert.equal(captured.env.runId, "271");
    assert.equal(captured.env.context, contextFile);
    assert.equal(captured.env.guard, guardFile);
  });

  it("handles delayed session_id reporting, is_error=true failure results, postResultGraceMs orphan cleanup, and AbortSignal group kill", async () => {
    const dir = makeTempDir();

    // 1. Delayed session_id + postResultGraceMs orphan cleanup
    const gracePidsFile = path.join(dir, "claude-grace-pids.json");
    const fakeClaudeDelayed = makeExecutableScript(
      dir,
      "fake-claude-delayed.mjs",
      `
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";

      const child = spawn(process.execPath, [
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"
      ], { stdio: "inherit" });

      writeFileSync(${JSON.stringify(gracePidsFile)}, JSON.stringify({
        parentPid: process.pid,
        childPid: child.pid
      }), "utf8");

      // Assistant event arrives WITHOUT session_id first
      console.log(JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "延迟会话已完成" }] }
      }));
      // Final result reveals session_id
      console.log(JSON.stringify({
        type: "result",
        is_error: false,
        session_id: "claude-late-sess-9",
        result: "延迟会话已完成",
        total_cost_usd: 0.005,
        usage: { input_tokens: 50, cache_read_input_tokens: 300, cache_creation_input_tokens: 100, output_tokens: 25 }
      }));
      setInterval(() => {}, 1000);
      `,
    );

    const startedCalls: Array<{ session: string | null; pid?: number }> = [];
    const delayedExec = await runClaudePrint({
      job: makeJob({
        session: null,
        agent: { id: "c1", name: "C1", runner: "claude" },
      }),
      contextFile: path.join(dir, "context.json"),
      guardFile: path.join(dir, "guard.json"),
      claudeBin: fakeClaudeDelayed,
      postResultGraceMs: 120,
      killGraceMs: 60,
      onStarted: (info) => startedCalls.push(info),
    });

    assert.deepEqual(
      startedCalls.map((s) => s.session),
      [null, "claude-late-sess-9"],
    );
    assert.equal(delayedExec.outcome, "done");
    assert.equal(delayedExec.session, "claude-late-sess-9");
    assert.equal(delayedExec.exitCode, 0);
    assert.deepEqual(delayedExec.usage, {
      input: 450,
      cached: 300,
      output: 25,
      cost: 0.005,
    });
    const gracePids = JSON.parse(readFileSync(gracePidsFile, "utf8")) as {
      parentPid: number;
      childPid: number;
    };
    assert.equal(isProcessAlive(gracePids.parentPid), false);
    assert.equal(isProcessAlive(gracePids.childPid), false);

    // 2. Pre-start is_error=true (e.g. broken --resume session) must keep started=false & session=null
    const fakeClaudeBrokenResume = makeExecutableScript(
      dir,
      "fake-claude-err.mjs",
      `
      console.log(JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "No conversation found with session ID: dead-sess"
      }));
      process.exit(1);
      `,
    );

    let errStarted = false;
    const errExec = await runClaudePrint({
      job: makeJob({
        session: "dead-sess",
        agent: { id: "c2", name: "C2", runner: "claude" },
      }),
      contextFile: path.join(dir, "context.json"),
      guardFile: path.join(dir, "guard.json"),
      claudeBin: fakeClaudeBrokenResume,
      onStarted: () => {
        errStarted = true;
      },
    });

    assert.equal(errStarted, false);
    assert.equal(errExec.outcome, "failed");
    assert.equal(errExec.started, false);
    assert.equal(errExec.session, null);
    assert.match(errExec.error ?? "", /No conversation found/);

    // 3. AbortSignal kills entire process group
    const abortPidsFile = path.join(dir, "claude-abort-pids.json");
    const fakeClaudeAbort = makeExecutableScript(
      dir,
      "fake-claude-abort.mjs",
      `
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      process.on("SIGTERM", () => {});
      const child = spawn(process.execPath, [
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"
      ], { stdio: "inherit" });
      writeFileSync(${JSON.stringify(abortPidsFile)}, JSON.stringify({
        parentPid: process.pid,
        childPid: child.pid
      }), "utf8");
      console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "claude-abort-sess" }));
      setInterval(() => {}, 1000);
      `,
    );

    const ac = new AbortController();
    const abortExec = await runClaudePrint({
      job: makeJob({ agent: { id: "c3", name: "C3", runner: "claude" } }),
      contextFile: path.join(dir, "context.json"),
      guardFile: path.join(dir, "guard.json"),
      claudeBin: fakeClaudeAbort,
      signal: ac.signal,
      killGraceMs: 60,
      onStarted: () => {
        const poll = setInterval(() => {
          if (existsSync(abortPidsFile)) {
            clearInterval(poll);
            ac.abort();
          }
        }, 10);
      },
    });

    assert.equal(abortExec.outcome, "cancelled");
    assert.equal(abortExec.cancelled, true);
    assert.equal(abortExec.started, true);
    assert.equal(abortExec.session, "claude-abort-sess");
    const abortPids = JSON.parse(readFileSync(abortPidsFile, "utf8")) as {
      parentPid: number;
      childPid: number;
    };
    assert.equal(isProcessAlive(abortPids.parentPid), false);
    assert.equal(isProcessAlive(abortPids.childPid), false);
  });
});
