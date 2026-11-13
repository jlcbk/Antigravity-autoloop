/**
 * Headless `agy-runner` Behavior & Security Boundary Tests.
 *
 * Prevents regressions in:
 * 1. CLI argument construction without shell interpolation (`shell: false`) and 3-tier access mapping.
 * 2. Stripping privileged control-plane tokens (`AUTOLOOP_OWNER_TOKEN`, `ANTIGRAVITY_SIDECAR_UI_TOKEN`, etc.)
 *    from the child process environment while injecting `AUTOLOOP_RUN_ID`, `AUTOLOOP_CONTEXT`, `AUTOLOOP_GUARD_FILE`.
 * 3. Streaming NDJSON tolerance against non-JSON noise, `conversationId`/`sessionId` extraction, `onStarted`,
 *    and incremental/final `usage` aggregation without double-counting.
 * 4. Exact distinction between pre-start disconnect (`started: false`, `session: null`) and post-start failure
 *    (`started: true`, preserving captured `session` so side-effecting sessions are never lost).
 * 5. Process-group termination (`SIGTERM` -> `SIGKILL` escalation on `-pid`) via `AbortSignal` and `timeoutMs`
 *    leaving zero orphan grandchild processes.
 */

import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  buildAgyArgs,
  runAgyPrint,
  sanitizeRunnerEnv,
} from "../engine/agy-runner.ts";
import type { Job } from "../protocol/types.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "autoloop-agy-runner-"));
  tempDirs.push(dir);
  return dir;
}

function makeExecutableScript(dir: string, name: string, code: string): string {
  const filePath = path.join(dir, name);
  writeFileSync(filePath, `#!/usr/bin/env node\n${code}`, "utf8");
  chmodSync(filePath, 0o755);
  return filePath;
}

function makeJob(overrides: Partial<Job> = {}): Job {
  const base: Job = {
    run: 42,
    token: "run-secret-token",
    attempt: 1,
    rule: {
      name: "triage",
      cwd: os.tmpdir(),
      skill: "recipe-issue-triage",
      prompt: "Inspect issue context.",
    },
    agent: {
      id: "coder",
      name: "coder",
      runner: "agy-print",
      model: "gemini-4-hydrogen-high",
      effort: "high",
      access: "edit",
      timeoutMinutes: 10,
    },
    session: null,
    askFirst: ["delete files"],
    context: {
      events: [
        {
          id: "evt-1",
          type: "issue.opened",
          subject: "issue#7",
          source: "inbox",
          sourceName: "Inbox",
          receivedAt: "2026-01-01T00:00:00Z",
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
    rule: { ...base.rule, ...overrides.rule },
    agent: { ...base.agent, ...overrides.agent },
    context: { ...base.context, ...overrides.context },
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("buildAgyArgs", () => {
  it("maps read, edit, default, and full access tiers with optional flags", () => {
    const readJob = makeJob({
      session: "conv-existing",
      agent: {
        id: "reader",
        name: "reader",
        runner: "agy-print",
        model: "gemini-4-hydrogen-xhigh",
        effort: "xhigh",
        access: "read",
      },
    });

    assert.deepEqual(buildAgyArgs(readJob, "hello prompt"), [
      "--print",
      "--output-format",
      "stream-json",
      "--model",
      "gemini-4-hydrogen-xhigh",
      "--effort",
      "xhigh",
      "--conversation",
      "conv-existing",
      "--mode",
      "plan",
      "--sandbox",
      "hello prompt",
    ]);

    const editDefaultJob = makeJob({
      session: null,
      agent: {
        id: "editor",
        name: "editor",
        runner: "agy-print",
        model: undefined,
        effort: undefined,
        access: undefined,
      },
    });

    assert.deepEqual(buildAgyArgs(editDefaultJob, "edit prompt"), [
      "--print",
      "--output-format",
      "stream-json",
      "--mode",
      "accept-edits",
      "--sandbox",
      "edit prompt",
    ]);

    const fullJob = makeJob({
      agent: {
        id: "full",
        name: "full",
        runner: "agy-print",
        model: undefined,
        effort: undefined,
        access: "full",
      },
    });

    assert.deepEqual(buildAgyArgs(fullJob, "full prompt"), [
      "--print",
      "--output-format",
      "stream-json",
      "--mode",
      "auto",
      "full prompt",
    ]);
  });
});

describe("sanitizeRunnerEnv", () => {
  it("strips control-plane secrets (case-insensitively) and injects per-run guard variables", () => {
    const job = makeJob({ run: 909 });
    const baseEnv: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      HOME: "/tmp/home",
      AUTOLOOP_OWNER_TOKEN: "owner-secret",
      ANTIGRAVITY_SIDECAR_UI_TOKEN: "sidecar-secret",
      autoloop_owner_token: "lower-owner",
      Antigravity_Sidecar_Ui_Token: "mixed-sidecar",
      AUTOLOOP_IPC_TOKEN: "ipc-secret",
      AUTOLOOP_MASTER_KEY: "master-secret",
      SAFE_KEEP_VAR: "ok",
    };

    const clean = sanitizeRunnerEnv(
      baseEnv,
      job,
      "/tmp/run/context.json",
      "/tmp/run/guard.json",
    );

    assert.equal(clean.AUTOLOOP_OWNER_TOKEN, undefined);
    assert.equal(clean.ANTIGRAVITY_SIDECAR_UI_TOKEN, undefined);
    assert.equal(clean.autoloop_owner_token, undefined);
    assert.equal(clean.Antigravity_Sidecar_Ui_Token, undefined);
    assert.equal(clean.AUTOLOOP_IPC_TOKEN, undefined);
    assert.equal(clean.AUTOLOOP_MASTER_KEY, undefined);
    assert.equal(clean.SAFE_KEEP_VAR, "ok");
    assert.equal(clean.AUTOLOOP_RUN_ID, "909");
    assert.equal(clean.AUTOLOOP_CONTEXT, "/tmp/run/context.json");
    assert.equal(clean.AUTOLOOP_GUARD_FILE, "/tmp/run/guard.json");
  });
});

describe("runAgyPrint", () => {
  it("passes args and sanitized env without shell interpretation", async () => {
    const dir = makeTempDir();
    const capturePath = path.join(dir, "captured.json");
    const canaryPath = path.join(dir, "pwned");
    const dangerousPrompt = `Check $(touch ${canaryPath}); echo bad && true | cat`;

    const fakeAgy = makeExecutableScript(
      dir,
      "fake-agy.mjs",
      `
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
        argv: process.argv.slice(2),
        env: {
          owner: process.env.AUTOLOOP_OWNER_TOKEN ?? null,
          ui: process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN ?? null,
          runId: process.env.AUTOLOOP_RUN_ID ?? null,
          context: process.env.AUTOLOOP_CONTEXT ?? null,
          guard: process.env.AUTOLOOP_GUARD_FILE ?? null,
          safe: process.env.SAFE_TEST_VAR ?? null,
        }
      }));
      console.log(JSON.stringify({ type: "init", conversationId: "conv-env-1" }));
      console.log(JSON.stringify({ type: "result", result: "已完成安全隔离检查" }));
      `,
    );

    const job = makeJob({ run: 77 });
    const res = await runAgyPrint({
      job,
      contextFile: path.join(dir, "context.json"),
      guardFile: path.join(dir, "guard.json"),
      promptOverride: dangerousPrompt,
      agyBin: fakeAgy,
      baseEnv: {
        ...process.env,
        AUTOLOOP_OWNER_TOKEN: "must-strip",
        ANTIGRAVITY_SIDECAR_UI_TOKEN: "must-strip-too",
        SAFE_TEST_VAR: "present",
      },
    });

    assert.equal(res.outcome, "done");
    assert.equal(existsSync(canaryPath), false);

    const captured = JSON.parse(readFileSync(capturePath, "utf8")) as {
      argv: string[];
      env: Record<string, string | null>;
    };
    assert.equal(captured.argv[captured.argv.length - 1], dangerousPrompt);
    assert.equal(captured.env.owner, null);
    assert.equal(captured.env.ui, null);
    assert.equal(captured.env.runId, "77");
    assert.equal(captured.env.context, path.join(dir, "context.json"));
    assert.equal(captured.env.guard, path.join(dir, "guard.json"));
    assert.equal(captured.env.safe, "present");
  });

  it("parses stream-json with non-JSON noise, fires onStarted once, and parses receipt", async () => {
    const dir = makeTempDir();
    const fakeAgy = makeExecutableScript(
      dir,
      "fake-agy.mjs",
      `
      console.log("[debug] noisy non-json banner");
      console.log("{broken json line");
      console.log(JSON.stringify({ type: "system", subtype: "init", sessionId: "conv-stream-100" }));
      console.log(JSON.stringify({
        type: "assistant",
        conversationId: "conv-stream-100",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "internal chain" },
            {
              type: "text",
              text: "请示用户确认删除操作\\n\`\`\`agent-autoloop\\n{\\"ask\\":[{\\"key\\":\\"confirm-del\\",\\"title\\":\\"确认\\",\\"text\\":\\"是否继续\\",\\"options\\":[\\"是\\",\\"否\\"],\\"about\\":\\"清理\\"}]}\\n\`\`\`"
            }
          ]
        }
      }));
      process.stdout.write(JSON.stringify({ type: "usage", input_tokens: 120, output_tokens: 30 }));
      `,
    );

    const startedEvents: Array<{ session: string | null; pid: number }> = [];
    let observedPid = 0;

    const res = await runAgyPrint({
      job: makeJob(),
      contextFile: path.join(dir, "context.json"),
      guardFile: path.join(dir, "guard.json"),
      agyBin: fakeAgy,
      onProcess: (proc) => {
        observedPid = proc.pid ?? 0;
      },
      onStarted: (info) => {
        startedEvents.push(info);
      },
    });

    assert.equal(startedEvents.length, 1);
    assert.equal(startedEvents[0].session, "conv-stream-100");
    assert.equal(startedEvents[0].pid, observedPid);
    assert.ok(observedPid > 0);

    assert.equal(res.outcome, "done");
    assert.equal(res.started, true);
    assert.equal(res.session, "conv-stream-100");
    assert.equal(res.exitCode, 0);
    assert.equal(res.summary, "请示用户确认删除操作");
    assert.equal(res.parsed.problem, null);
    assert.equal(res.parsed.receipt?.ask?.[0]?.key, "confirm-del");
    assert.deepEqual(res.usage, { input: 120, output: 30 });
  });

  it("collects incremental usage and avoids double-counting when result provides final totals", async () => {
    const dir = makeTempDir();
    const incrementalOnlyBin = makeExecutableScript(
      dir,
      "fake-inc.mjs",
      `
      console.log(JSON.stringify({ type: "init", conversation_id: "conv-u1" }));
      console.log(JSON.stringify({ type: "text_delta", text: "没事可做：一切正常" }));
      console.log(JSON.stringify({ type: "usage", input_tokens: 100, output_tokens: 15, cache_read_input_tokens: 40, cost_usd: 0.002 }));
      console.log(JSON.stringify({ type: "usage", input: 50, output: 10, cached: 10, cost: 0.001 }));
      `,
    );

    const resInc = await runAgyPrint({
      job: makeJob(),
      contextFile: path.join(dir, "context.json"),
      guardFile: path.join(dir, "guard.json"),
      agyBin: incrementalOnlyBin,
    });

    assert.equal(resInc.outcome, "nothing");
    assert.equal(resInc.summary, "一切正常");
    assert.equal(resInc.usage?.input, 150);
    assert.equal(resInc.usage?.output, 25);
    assert.equal(resInc.usage?.cached, 50);
    assert.ok(Math.abs((resInc.usage?.cost ?? 0) - 0.003) < 1e-9);

    const finalResultBin = makeExecutableScript(
      dir,
      "fake-final.mjs",
      `
      console.log(JSON.stringify({ type: "init", conversationId: "conv-u2" }));
      console.log(JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: "处理完成", usage: { input_tokens: 200, output_tokens: 40 } }
      }));
      console.log(JSON.stringify({
        type: "result",
        response: "处理完成",
        usage: { input_tokens: 200, output_tokens: 40, cache_read_input_tokens: 80 },
        total_cost_usd: 0.012
      }));
      `,
    );

    const resFinal = await runAgyPrint({
      job: makeJob(),
      contextFile: path.join(dir, "context.json"),
      guardFile: path.join(dir, "guard.json"),
      agyBin: finalResultBin,
    });

    assert.equal(resFinal.outcome, "done");
    assert.deepEqual(resFinal.usage, {
      input: 200,
      output: 40,
      cached: 80,
      cost: 0.012,
    });
  });

  it("distinguishes pre-start failure (started: false, session: null) from post-start failure (started: true, preserves session)", async () => {
    const dir = makeTempDir();

    const preStartFailBin = makeExecutableScript(
      dir,
      "fake-pre-fail.mjs",
      `
      console.log(JSON.stringify({ type: "error", message: "conversation not found" }));
      console.error("fatal: unknown conversation");
      process.exit(1);
      `,
    );

    let preStartedCalled = false;
    const preFail = await runAgyPrint({
      job: makeJob({ session: "broken-session-id" }),
      contextFile: path.join(dir, "context.json"),
      guardFile: path.join(dir, "guard.json"),
      agyBin: preStartFailBin,
      onStarted: () => {
        preStartedCalled = true;
      },
    });

    assert.equal(preStartedCalled, false);
    assert.equal(preFail.outcome, "failed");
    assert.equal(preFail.started, false);
    assert.equal(preFail.session, null);
    assert.equal(preFail.exitCode, 1);
    assert.match(preFail.error ?? "", /conversation not found/);

    const postStartFailBin = makeExecutableScript(
      dir,
      "fake-post-fail.mjs",
      `
      console.log(JSON.stringify({ type: "init", conversationId: "conv-live-99" }));
      console.log(JSON.stringify({ type: "text_delta", text: "已经修改了一半文件..." }));
      console.error("upstream connection dropped");
      process.exit(2);
      `,
    );

    let postStartedSession: string | null = null;
    const postFail = await runAgyPrint({
      job: makeJob({ session: null }),
      contextFile: path.join(dir, "context.json"),
      guardFile: path.join(dir, "guard.json"),
      agyBin: postStartFailBin,
      onStarted: (info) => {
        postStartedSession = info.session;
      },
    });

    assert.equal(postStartedSession, "conv-live-99");
    assert.equal(postFail.outcome, "failed");
    assert.equal(postFail.started, true);
    assert.equal(postFail.session, "conv-live-99");
    assert.equal(postFail.exitCode, 2);
    assert.match(postFail.error ?? "", /upstream connection dropped/);
  });

  it("kills the entire process group with SIGTERM -> SIGKILL on AbortSignal leaving zero orphans", async () => {
    const dir = makeTempDir();
    const pidsFile = path.join(dir, "pids.json");

    const stubbornBin = makeExecutableScript(
      dir,
      "fake-stubborn.mjs",
      `
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";

      // Ignore SIGTERM to verify SIGKILL escalation on the entire process group.
      process.on("SIGTERM", () => {});

      const grandchild = spawn(process.execPath, [
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"
      ], { stdio: "inherit" });

      writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify({
        parentPid: process.pid,
        grandchildPid: grandchild.pid
      }));

      console.log(JSON.stringify({ type: "init", conversationId: "conv-abort-1" }));
      setInterval(() => {}, 1000);
      `,
    );

    const controller = new AbortController();
    let startedSeen = false;

    const runPromise = runAgyPrint({
      job: makeJob(),
      contextFile: path.join(dir, "context.json"),
      guardFile: path.join(dir, "guard.json"),
      agyBin: stubbornBin,
      signal: controller.signal,
      killGraceMs: 80,
      onStarted: () => {
        startedSeen = true;
        // Wait briefly until pidsFile is guaranteed on disk, then abort.
        const poll = setInterval(() => {
          if (existsSync(pidsFile)) {
            clearInterval(poll);
            controller.abort();
          }
        }, 10);
      },
    });

    const res = await runPromise;

    assert.equal(startedSeen, true);
    assert.equal(res.outcome, "cancelled");
    assert.equal(res.started, true);
    assert.equal(res.session, "conv-abort-1");

    const { parentPid, grandchildPid } = JSON.parse(
      readFileSync(pidsFile, "utf8"),
    ) as { parentPid: number; grandchildPid: number };

    assert.equal(isProcessAlive(parentPid), false);
    assert.equal(isProcessAlive(grandchildPid), false);
  });

  it("handles pre-aborted AbortSignal and timeoutMs expiration", async () => {
    const dir = makeTempDir();

    const preAborted = new AbortController();
    preAborted.abort();
    const resPre = await runAgyPrint({
      job: makeJob(),
      contextFile: path.join(dir, "context.json"),
      guardFile: path.join(dir, "guard.json"),
      agyBin: path.join(dir, "nonexistent"),
      signal: preAborted.signal,
    });
    assert.equal(resPre.outcome, "cancelled");
    assert.equal(resPre.started, false);
    assert.equal(resPre.exitCode, null);

    const hangBin = makeExecutableScript(
      dir,
      "fake-hang.mjs",
      `
      process.stdout.write(JSON.stringify({ type: "init", conversationId: "conv-timeout-1" }) + "\\n");
      setInterval(() => {}, 1000);
      `,
    );

    let timeoutStarted = false;
    const resTimeout = await runAgyPrint({
      job: makeJob(),
      contextFile: path.join(dir, "context.json"),
      guardFile: path.join(dir, "guard.json"),
      agyBin: hangBin,
      timeoutMs: 1500,
      killGraceMs: 50,
      onStarted: () => {
        timeoutStarted = true;
      },
    });

    assert.equal(timeoutStarted, true);
    assert.equal(resTimeout.outcome, "failed");
    assert.equal(resTimeout.started, true);
    assert.equal(resTimeout.session, "conv-timeout-1");
    assert.match(resTimeout.error ?? "", /timed out/i);
  });

  it("handles spawn ENOENT, malformed receipt problem passthrough, and ~/ cwd expansion", async () => {
    const dir = makeTempDir();

    const missing = await runAgyPrint({
      job: makeJob(),
      contextFile: path.join(dir, "context.json"),
      guardFile: path.join(dir, "guard.json"),
      agyBin: path.join(dir, "does-not-exist-agy"),
    });
    assert.equal(missing.outcome, "failed");
    assert.equal(missing.started, false);
    assert.equal(missing.session, null);
    assert.equal(missing.exitCode, null);
    assert.ok((missing.error ?? "").length > 0);

    const badReceiptBin = makeExecutableScript(
      dir,
      "fake-bad-receipt.mjs",
      `
      console.log(JSON.stringify({ type: "init", conversationId: "conv-bad-receipt" }));
      console.log(JSON.stringify({
        type: "assistant",
        text: "已完成任务\\n\`\`\`json\\n{\\"notice\\":[{\\"title\\":\\"ok\\",\\"text\\":\\"done\\",\\"fyi\\":true}]}\\n\`\`\`"
      }));
      `,
    );

    const resBadReceipt = await runAgyPrint({
      job: makeJob({ rule: { name: "triage", cwd: "~" } }),
      contextFile: path.join(dir, "context.json"),
      guardFile: path.join(dir, "guard.json"),
      agyBin: badReceiptBin,
    });

    assert.equal(resBadReceipt.exitCode, 0);
    assert.equal(resBadReceipt.started, true);
    assert.equal(resBadReceipt.session, "conv-bad-receipt");
    assert.equal(resBadReceipt.outcome, "done");
    assert.ok(resBadReceipt.parsed.problem !== null);
  });
});
