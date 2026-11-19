/**
 * Universal Standard ACP (`Agent Client Protocol`) Runner Behavior & Security Gate Tests (WP-2).
 *
 * Prevents real operational failures and security boundary violations in `engine/acp-runner.ts`:
 * 1. End-to-end stdio JSON-RPC 2.0 lifecycle (`initialize` -> `session/new` -> best-effort `session/set_model`
 *    -> `session/prompt` + streaming `session/update` chunks & `Content-Length` UTF-8 framing), receipt parsing,
 *    environment secret stripping + `PATH` head supplementation, and automatic process-group reaping of resident
 *    `xxx acp` daemons after `session/prompt` resolves (zero orphan processes).
 * 2. Session continuity (`session/load` with `{}` or `{ sessionId }`, isolating any replayed history chunks) vs
 *    graceful pre-prompt abort (`started: false, exitCode: 1, session: null`) when `session/load` returns an error
 *    so `supervisor.ts` can seamlessly downgrade stale sessions to `session: null`.
 * 3. Protocol-level `session/request_permission` hard security gate: `clientCapabilities.terminal === false` &
 *    unconditional `terminal/*` reverse-RPC rejection, fail-closed `guard.json`, strict `access: "read"` allowlist
 *    (blocking `switch_mode`, `other` / MCP write tools, and mutating commands), unauthorized `askFirst` & catastrophic
 *    command rejection (`reject_once` / `cancelled`), explicit `approvedKeys` allowance (`allow_once`), and
 *    unconditional directory/subpath confinement of `<AUTOLOOP_HOME>` & `<guardDir>` (`external_directory`, `search`,
 *    secret/DB files) while preserving exact read access to `context.json`, `rules.json`, and workspace `.autoloop/`.
 * 4. Reverse `fs/read_text_file` (with `line`/`limit`) and `fs/write_text_file` RPC callbacks enforcing `access`
 *    and blocking reads/writes inside protected control-plane directories except exact read-only text files, plus
 *    Anthropic-style cache token normalization (`cached <= input`).
 * 5. `AbortSignal` cancellation emitting `session/cancel` notification before process-group `SIGTERM` -> `SIGKILL`
 *    termination with zero surviving child or grandchild processes.
 */

import assert from "node:assert/strict";
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
import { runAcpAgent } from "../engine/acp-runner.ts";
import { writeRunFiles } from "../engine/context-file.ts";
import type { Job } from "../protocol/types.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "autoloop-v12-acp-"));
  tempDirs.push(dir);
  return dir;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForProcessDead(
  pid: number,
  timeoutMs = 3_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return !isProcessAlive(pid);
}

function makeFakeAcpServer(dir: string, scenarioBody: string): string {
  const scriptPath = path.join(dir, "fake-acp-server.mjs");
  const code = `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const useContentLength = process.env.FAKE_ACP_CONTENT_LENGTH === "1";
const logFile = process.env.FAKE_ACP_LOG_FILE || "";

function logEvent(entry) {
  if (logFile) {
    appendFileSync(logFile, JSON.stringify(entry) + "\\n", "utf8");
  }
}

function send(msg) {
  const json = JSON.stringify(msg);
  if (useContentLength) {
    const byteLen = Buffer.byteLength(json, "utf8");
    process.stdout.write(\`Content-Length: \${byteLen}\\r\\n\\r\\n\${json}\`);
  } else {
    process.stdout.write(json + "\\n");
  }
}

let nextServerReqId = 1000;
const pendingClientResponses = new Map();

function requestClient(method, params) {
  const id = nextServerReqId++;
  return new Promise((resolve, reject) => {
    pendingClientResponses.set(String(id), { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

${scenarioBody}

let stdinBuf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinBuf += chunk;
  let idx = stdinBuf.indexOf("\\n");
  while (idx !== -1) {
    const line = stdinBuf.slice(0, idx).trim();
    stdinBuf = stdinBuf.slice(idx + 1);
    if (line.length > 0) {
      const msg = JSON.parse(line);
      logEvent(msg);
      if (msg.method === undefined && msg.id !== undefined) {
        const pending = pendingClientResponses.get(String(msg.id));
        if (pending) {
          pendingClientResponses.delete(String(msg.id));
          if (msg.error) {
            pending.reject(msg.error);
          } else {
            pending.resolve(msg.result);
          }
        }
      } else {
        Promise.resolve(onMessage(msg)).catch((err) => {
          if (msg.id !== undefined) {
            send({
              jsonrpc: "2.0",
              id: msg.id,
              error: { code: -32603, message: String(err?.message || err) },
            });
          }
        });
      }
    }
    idx = stdinBuf.indexOf("\\n");
  }
});
`;
  writeFileSync(scriptPath, code, "utf8");
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function makeJob(
  cwd: string,
  command: string[],
  overrides: Partial<Job> = {},
): Job {
  const base: Job = {
    run: 101,
    token: "hmac-run-token",
    attempt: 1,
    rule: {
      name: "acp-triage",
      cwd,
      skill: "recipe-issue-triage",
      prompt: "Inspect context and reply.",
    },
    agent: {
      id: "opencode-acp",
      name: "opencode-acp",
      runner: "acp",
      command,
      model: "qwen3-coder-plus",
      access: "edit",
      timeoutMinutes: 5,
    },
    session: null,
    askFirst: ["rm -rf", "git push --force", "git reset --hard", "deploy-prod"],
    context: {
      events: [
        {
          id: "evt-acp-1",
          type: "issue.opened",
          subject: "issue#42",
          summary: "UNTRUSTED_SUMMARY_DO_NOT_INTERPOLATE",
          detail: "UNTRUSTED_DETAIL_DO_NOT_INTERPOLATE",
          source: "github",
          sourceName: "GitHub",
          receivedAt: "2026-11-19T12:00:00Z",
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

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("v12 ACP Runner (`runAcpAgent`)", () => {
  it("completes initialize -> session/new -> set_model -> streaming session/update -> prompt, parses receipt, strips secrets, supplements PATH, and reaps resident ACP process group", async () => {
    const dir = makeTempDir();
    const autoloopHome = path.join(dir, "autoloop_home");
    const fakeHome = path.join(dir, "fake_home");
    const logFile = path.join(dir, "rpc.jsonl");
    const envSnapshotFile = path.join(dir, "env.json");
    const grandchildPidFile = path.join(dir, "grandchild.pid");

    const serverScript = makeFakeAcpServer(
      dir,
      `
      // Spawn a resident grandchild process in the same process group and keep event loop alive
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      writeFileSync(${JSON.stringify(grandchildPidFile)}, String(child.pid), "utf8");
      setInterval(() => {}, 1000);

      writeFileSync(${JSON.stringify(envSnapshotFile)}, JSON.stringify({
        PATH: process.env.PATH,
        AUTOLOOP_OWNER_TOKEN: process.env.AUTOLOOP_OWNER_TOKEN ?? null,
        ANTIGRAVITY_SIDECAR_UI_TOKEN: process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN ?? null,
        AUTOLOOP_CONTEXT: process.env.AUTOLOOP_CONTEXT,
        AUTOLOOP_GUARD_FILE: process.env.AUTOLOOP_GUARD_FILE,
        AUTOLOOP_RUN_ID: process.env.AUTOLOOP_RUN_ID,
      }), "utf8");

      // Emit a non-JSON banner line on stdout to verify diagnostic noise tolerance
      process.stdout.write("Warning: experimental ACP mode enabled\\n");

      async function onMessage(msg) {
        if (msg.method === "initialize") {
          send({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              protocolVersion: 1,
              agentCapabilities: { loadSession: true },
            },
          });
          return;
        }
        if (msg.method === "session/new") {
          send({
            jsonrpc: "2.0",
            id: msg.id,
            result: { sessionId: "acp-sess-new-001" },
          });
          return;
        }
        if (msg.method === "session/set_model") {
          // Simulate an ACP server that does not implement session/set_model (-32601)
          send({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32601, message: "Method not found: session/set_model" },
          });
          return;
        }
        if (msg.method === "session/prompt") {
          send({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: msg.params.sessionId,
              update: {
                sessionUpdate: "agent_thought_chunk",
                content: { type: "text", text: "Internal thinking must not pollute output" },
              },
            },
          });
          send({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: msg.params.sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "已完成：定位并整理完 #42 根因\\n\\n" },
              },
            },
          });
          send({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: msg.params.sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: {
                  type: "text",
                  text: "\`\`\`agent-autoloop\\n{\\"notice\\":[{\\"title\\":\\"排查完成\\",\\"text\\":\\"详见报告\\",\\"fyi\\":true}]}\\n\`\`\`\\n",
                },
              },
              usage: { inputTokens: 120, outputTokens: 45, costUsd: 0.0025 },
            },
          });
          send({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              stopReason: "end_turn",
              usage: { inputTokens: 120, outputTokens: 45, cachedInputTokens: 30 },
            },
          });
          // Intentionally DO NOT exit! Resident ACP daemon stays alive until runner reaps it.
        }
      }
      `,
    );

    const job = makeJob(dir, [process.execPath, serverScript]);
    const files = writeRunFiles(autoloopHome, job);
    const startedCalls: Array<{ session: string | null; pid?: number }> = [];

    const exec = await runAcpAgent({
      job,
      contextFile: files.contextFile,
      guardFile: files.guardFile,
      postResultGraceMs: 120,
      killGraceMs: 100,
      baseEnv: {
        ...process.env,
        HOME: fakeHome,
        PATH: "/usr/bin:/bin",
        FAKE_ACP_LOG_FILE: logFile,
        FAKE_ACP_CONTENT_LENGTH: "1",
        AUTOLOOP_OWNER_TOKEN: "top-secret-owner",
        ANTIGRAVITY_SIDECAR_UI_TOKEN: "top-secret-ui",
      },
      onStarted: (info) => startedCalls.push(info),
    });

    assert.equal(exec.started, true);
    assert.equal(exec.exitCode, 0);
    assert.equal(exec.timedOut, false);
    assert.equal(exec.cancelled, false);
    assert.equal(exec.session, "acp-sess-new-001");
    assert.equal(exec.outcome, "done");
    assert.equal(exec.summary, "已完成：定位并整理完 #42 根因");
    assert.equal(exec.parsed.problem, null);
    assert.deepEqual(exec.parsed.receipt, {
      notice: [{ title: "排查完成", text: "详见报告", fyi: true }],
    });
    assert.deepEqual(exec.usage, {
      input: 120,
      output: 45,
      cached: 30,
      cost: 0.0025,
    });

    assert.equal(startedCalls.length, 1);
    assert.equal(startedCalls[0]!.session, "acp-sess-new-001");
    assert.ok((startedCalls[0]!.pid ?? 0) > 0);

    // Verify resident ACP server and grandchild were reaped cleanly
    const serverPid = startedCalls[0]!.pid!;
    const grandchildPid = Number(
      readFileSync(grandchildPidFile, "utf8").trim(),
    );
    assert.equal(await waitForProcessDead(serverPid), true);
    assert.equal(await waitForProcessDead(grandchildPid), true);

    // Verify environment sanitization and PATH head supplementation
    const envSnap = JSON.parse(readFileSync(envSnapshotFile, "utf8")) as Record<
      string,
      string | null
    >;
    assert.equal(envSnap.AUTOLOOP_OWNER_TOKEN, null);
    assert.equal(envSnap.ANTIGRAVITY_SIDECAR_UI_TOKEN, null);
    assert.equal(envSnap.AUTOLOOP_CONTEXT, files.contextFile);
    assert.equal(envSnap.AUTOLOOP_GUARD_FILE, files.guardFile);
    assert.equal(envSnap.AUTOLOOP_RUN_ID, "101");
    const expectedPrefix = [
      path.join(fakeHome, ".opencode", "bin"),
      path.join(fakeHome, ".local", "bin"),
      path.join(fakeHome, ".local", "lib", "node-v24.19.0-darwin-arm64", "bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ].join(":");
    assert.ok(
      envSnap.PATH?.startsWith(expectedPrefix),
      `Expected PATH to start with ${expectedPrefix}, got ${envSnap.PATH}`,
    );

    // Verify protocol requests & instruction-data separation
    const logged = readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const initMsg = logged.find((m) => m.method === "initialize");
    assert.deepEqual(initMsg.params, {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
      },
      clientInfo: { name: "antigravity-autoloop", version: "1.2.0" },
    });
    const promptMsg = logged.find((m) => m.method === "session/prompt");
    assert.equal(promptMsg.params.sessionId, "acp-sess-new-001");
    const sentPromptText = String(promptMsg.params.prompt[0].text);
    assert.equal(
      sentPromptText.includes("UNTRUSTED_SUMMARY_DO_NOT_INTERPOLATE"),
      false,
    );
    assert.equal(
      sentPromptText.includes("UNTRUSTED_DETAIL_DO_NOT_INTERPOLATE"),
      false,
    );
    assert.equal(sentPromptText.includes(files.contextFile), true);
  });

  it("resumes via session/load when job.session is set, and returns started: false before session/prompt when session/load errors", async () => {
    const dir = makeTempDir();
    const autoloopHome = path.join(dir, "autoloop_home");
    const logSuccess = path.join(dir, "load-ok.jsonl");
    const logFail = path.join(dir, "load-fail.jsonl");

    const serverScript = makeFakeAcpServer(
      dir,
      `
      const failLoad = process.env.FAKE_FAIL_LOAD === "1";
      setInterval(() => {}, 1000);

      async function onMessage(msg) {
        if (msg.method === "initialize") {
          send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
          return;
        }
        if (msg.method === "session/load") {
          if (failLoad) {
            send({
              jsonrpc: "2.0",
              id: msg.id,
              error: { code: -32002, message: "Session stale-sess-999 not found" },
            });
            return;
          }
          // Replay old turn history during session/load (must NOT pollute new prompt output)
          send({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: msg.params.sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "没跑成：这是上一轮重放的历史消息\\n" },
              },
            },
          });
          // Return empty {} object as allowed by ACP spec
          send({ jsonrpc: "2.0", id: msg.id, result: {} });
          return;
        }
        if (msg.method === "session/set_model") {
          send({ jsonrpc: "2.0", id: msg.id, result: {} });
          return;
        }
        if (msg.method === "session/prompt") {
          send({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: msg.params.sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "没事可做：续接核查无新增变更\\n" },
              },
            },
          });
          send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
        }
      }
      `,
    );

    // 1. Successful session/load
    const resumeJob = makeJob(dir, [process.execPath, serverScript], {
      session: "existing-sess-77",
    });
    const resumeFiles = writeRunFiles(autoloopHome, resumeJob);
    const resumeStarted: Array<{ session: string | null; pid?: number }> = [];

    const okExec = await runAcpAgent({
      job: resumeJob,
      contextFile: resumeFiles.contextFile,
      guardFile: resumeFiles.guardFile,
      postResultGraceMs: 80,
      killGraceMs: 80,
      baseEnv: { ...process.env, FAKE_ACP_LOG_FILE: logSuccess },
      onStarted: (info) => resumeStarted.push(info),
    });

    assert.equal(okExec.started, true);
    assert.equal(okExec.exitCode, 0);
    assert.equal(okExec.session, "existing-sess-77");
    assert.equal(okExec.outcome, "nothing");
    assert.equal(okExec.summary, "续接核查无新增变更");
    assert.equal(resumeStarted.length, 1);
    assert.equal(resumeStarted[0]!.session, "existing-sess-77");
    const okMethods = readFileSync(logSuccess, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).method);
    assert.equal(okMethods.includes("session/load"), true);
    assert.equal(okMethods.includes("session/new"), false);

    // 2. Failing session/load -> started: false, exitCode: 1, session/prompt NEVER sent
    const staleJob = makeJob(dir, [process.execPath, serverScript], {
      run: 102,
      session: "stale-sess-999",
    });
    const staleFiles = writeRunFiles(autoloopHome, staleJob);
    let staleStartedCalled = false;

    const failExec = await runAcpAgent({
      job: staleJob,
      contextFile: staleFiles.contextFile,
      guardFile: staleFiles.guardFile,
      postResultGraceMs: 80,
      killGraceMs: 80,
      baseEnv: {
        ...process.env,
        FAKE_ACP_LOG_FILE: logFail,
        FAKE_FAIL_LOAD: "1",
      },
      onStarted: () => {
        staleStartedCalled = true;
      },
    });

    assert.equal(staleStartedCalled, false);
    assert.equal(failExec.started, false);
    assert.equal(failExec.exitCode, 1);
    assert.equal(failExec.timedOut, false);
    assert.equal(failExec.cancelled, false);
    assert.equal(failExec.session, null);
    assert.equal(failExec.outcome, "failed");
    assert.match(
      failExec.summary,
      /^ACP session\/load failed:.*stale-sess-999/,
    );
    assert.equal(failExec.parsed.receipt, null);
    assert.equal(failExec.parsed.problem, null);

    const failMethods = readFileSync(logFail, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).method);
    assert.deepEqual(failMethods, ["initialize", "session/load"]);
  });

  it("enforces session/request_permission hard security gates for access=read, askFirst, approvedKeys, control-plane files, and corrupt guard.json", async () => {
    const dir = makeTempDir();
    const autoloopHome = path.join(dir, "autoloop_home");
    const ownerTokenPath = path.join(autoloopHome, "owner.token");
    const rulesJsonPath = path.join(autoloopHome, "rules.json");
    const initCapsFile = path.join(dir, "init-caps.json");
    const decisionsFile = path.join(dir, "decisions.json");

    const stdOptions = [
      { optionId: "opt-allow-once", name: "Allow once", kind: "allow_once" },
      {
        optionId: "opt-allow-always",
        name: "Allow always",
        kind: "allow_always",
      },
      { optionId: "opt-reject-once", name: "Reject once", kind: "reject_once" },
      {
        optionId: "opt-reject-always",
        name: "Reject always",
        kind: "reject_always",
      },
    ];

    const serverScript = makeFakeAcpServer(
      dir,
      `
      const mode = process.env.PERM_TEST_MODE;
      const guardPath = process.env.AUTOLOOP_GUARD_FILE;
      const ownerPath = process.env.TEST_OWNER_TOKEN_PATH;
      const rulesPath = process.env.TEST_RULES_JSON_PATH;
      const stdOptions = ${JSON.stringify(stdOptions)};

      async function onMessage(msg) {
        if (msg.method === "initialize") {
          writeFileSync(${JSON.stringify(initCapsFile)}, JSON.stringify(msg.params.clientCapabilities), "utf8");
          send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
          return;
        }
        if (msg.method === "session/new") {
          send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-perm" } });
          return;
        }
        if (msg.method === "session/set_model") {
          send({ jsonrpc: "2.0", id: msg.id, result: {} });
          return;
        }
        if (msg.method === "session/prompt") {
          const results = {};
          if (mode === "read-tier") {
            results.editTool = await requestClient("session/request_permission", {
              sessionId: "sess-perm",
              toolCall: {
                toolCallId: "tc-1",
                kind: "edit",
                title: "Edit src/app.ts",
                locations: [{ path: "src/app.ts" }],
              },
              options: stdOptions,
            });
            results.writeCmd = await requestClient("session/request_permission", {
              sessionId: "sess-perm",
              toolCall: {
                toolCallId: "tc-2",
                kind: "execute",
                title: "Remove temp",
                rawInput: { command: "bash -c 'touch hacked.txt'" },
              },
              options: stdOptions,
            });
            results.readSafe = await requestClient("session/request_permission", {
              sessionId: "sess-perm",
              toolCall: {
                toolCallId: "tc-3",
                kind: "read",
                title: "Read README.md",
                locations: [{ path: "README.md" }],
              },
              options: stdOptions,
            });
          } else if (mode === "edit-policy") {
            results.safeEdit = await requestClient("session/request_permission", {
              sessionId: "sess-perm",
              toolCall: {
                toolCallId: "tc-10",
                kind: "edit",
                title: "Edit src/index.ts",
                locations: [{ path: "src/index.ts" }],
              },
              options: stdOptions,
            });
            results.unapprovedForcePush = await requestClient("session/request_permission", {
              sessionId: "sess-perm",
              toolCall: {
                toolCallId: "tc-11",
                kind: "execute",
                title: "Force push",
                rawInput: { command: "git push --force origin main" },
              },
              options: stdOptions,
            });
            results.noRejectOptionFallback = await requestClient("session/request_permission", {
              sessionId: "sess-perm",
              toolCall: {
                toolCallId: "tc-12",
                kind: "execute",
                title: "Drop table",
                rawInput: { command: "sqlite3 app.db 'DROP TABLE users;'" },
              },
              options: [{ optionId: "only-allow", name: "Allow", kind: "allow_once" }],
            });
            results.approvedDeploy = await requestClient("session/request_permission", {
              sessionId: "sess-perm",
              toolCall: {
                toolCallId: "tc-13",
                kind: "execute",
                title: "Deploy prod",
                rawInput: { command: "npm run deploy-prod" },
              },
              options: stdOptions,
            });
            results.tamperGuard = await requestClient("session/request_permission", {
              sessionId: "sess-perm",
              toolCall: {
                toolCallId: "tc-14",
                kind: "read",
                title: "Read guard.json",
                locations: [{ path: guardPath }],
              },
              options: stdOptions,
            });
            results.tamperOwner = await requestClient("session/request_permission", {
              sessionId: "sess-perm",
              toolCall: {
                toolCallId: "tc-15",
                kind: "execute",
                title: "Cat owner token",
                rawInput: { command: "cat " + ownerPath },
              },
              options: stdOptions,
            });
            results.overwriteRules = await requestClient("session/request_permission", {
              sessionId: "sess-perm",
              toolCall: {
                toolCallId: "tc-16",
                kind: "edit",
                title: "Overwrite rules.json",
                locations: [{ path: rulesPath }],
              },
              options: stdOptions,
            });
          } else if (mode === "corrupt-guard") {
            results.corruptCheck = await requestClient("session/request_permission", {
              sessionId: "sess-perm",
              toolCall: {
                toolCallId: "tc-20",
                kind: "read",
                title: "Read normal file",
                locations: [{ path: "README.md" }],
              },
              options: stdOptions,
            });
          }
          writeFileSync(${JSON.stringify(decisionsFile)}, JSON.stringify(results), "utf8");
          send({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "sess-perm",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "权限门禁核验完成\\n" },
              },
            },
          });
          send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
          process.exit(0);
        }
      }
      `,
    );

    // Sub-case A: access === "read"
    const readJob = makeJob(dir, [process.execPath, serverScript], {
      run: 201,
      agent: {
        id: "reader-acp",
        name: "reader-acp",
        runner: "acp",
        command: [process.execPath, serverScript],
        access: "read",
      },
    });
    const readFiles = writeRunFiles(autoloopHome, readJob);
    writeFileSync(ownerTokenPath, "secret-owner-token", "utf8");
    writeFileSync(rulesJsonPath, "{}", "utf8");

    const readExec = await runAcpAgent({
      job: readJob,
      contextFile: readFiles.contextFile,
      guardFile: readFiles.guardFile,
      baseEnv: {
        ...process.env,
        PERM_TEST_MODE: "read-tier",
        TEST_OWNER_TOKEN_PATH: ownerTokenPath,
        TEST_RULES_JSON_PATH: rulesJsonPath,
      },
    });
    assert.equal(readExec.outcome, "done");
    const readCaps = JSON.parse(readFileSync(initCapsFile, "utf8"));
    assert.deepEqual(readCaps, {
      fs: { readTextFile: true, writeTextFile: false },
      terminal: false,
    });
    const readDecisions = JSON.parse(readFileSync(decisionsFile, "utf8"));
    assert.deepEqual(readDecisions.editTool, {
      outcome: { outcome: "selected", optionId: "opt-reject-once" },
    });
    assert.deepEqual(readDecisions.writeCmd, {
      outcome: { outcome: "selected", optionId: "opt-reject-once" },
    });
    assert.deepEqual(readDecisions.readSafe, {
      outcome: { outcome: "selected", optionId: "opt-allow-once" },
    });

    // Sub-case B: access === "edit", unapproved askFirst vs approvedKeys vs control-plane tampering
    const editJob = makeJob(dir, [process.execPath, serverScript], {
      run: 202,
      context: {
        events: [],
        answers: [
          {
            card: 1,
            key: "deploy-prod",
            title: "Allow deploy?",
            options: ["同意执行", "拒绝"],
            choice: 0,
            chosen: "同意执行",
            about: "deploy",
            at: "2026-11-19T12:05:00Z",
          },
        ],
        timers: [],
        waiting: [],
        open: [],
        decided: [],
      },
    });
    const editFiles = writeRunFiles(autoloopHome, editJob);

    const editExec = await runAcpAgent({
      job: editJob,
      contextFile: editFiles.contextFile,
      guardFile: editFiles.guardFile,
      baseEnv: {
        ...process.env,
        PERM_TEST_MODE: "edit-policy",
        TEST_OWNER_TOKEN_PATH: ownerTokenPath,
        TEST_RULES_JSON_PATH: rulesJsonPath,
      },
    });
    assert.equal(editExec.outcome, "done");
    const editDecisions = JSON.parse(readFileSync(decisionsFile, "utf8"));
    assert.deepEqual(editDecisions.safeEdit, {
      outcome: { outcome: "selected", optionId: "opt-allow-once" },
    });
    assert.deepEqual(editDecisions.unapprovedForcePush, {
      outcome: { outcome: "selected", optionId: "opt-reject-once" },
    });
    assert.deepEqual(editDecisions.noRejectOptionFallback, {
      outcome: { outcome: "cancelled" },
    });
    assert.deepEqual(editDecisions.approvedDeploy, {
      outcome: { outcome: "selected", optionId: "opt-allow-once" },
    });
    assert.deepEqual(editDecisions.tamperGuard, {
      outcome: { outcome: "selected", optionId: "opt-reject-once" },
    });
    assert.deepEqual(editDecisions.tamperOwner, {
      outcome: { outcome: "selected", optionId: "opt-reject-once" },
    });
    assert.deepEqual(editDecisions.overwriteRules, {
      outcome: { outcome: "selected", optionId: "opt-reject-once" },
    });

    // Sub-case C: Corrupt guard.json fails closed
    const corruptJob = makeJob(dir, [process.execPath, serverScript], {
      run: 203,
    });
    const corruptFiles = writeRunFiles(autoloopHome, corruptJob);
    writeFileSync(corruptFiles.guardFile, "{bad json", "utf8");

    await runAcpAgent({
      job: corruptJob,
      contextFile: corruptFiles.contextFile,
      guardFile: corruptFiles.guardFile,
      baseEnv: { ...process.env, PERM_TEST_MODE: "corrupt-guard" },
    });
    const corruptDecisions = JSON.parse(readFileSync(decisionsFile, "utf8"));
    assert.deepEqual(corruptDecisions.corruptCheck, {
      outcome: { outcome: "selected", optionId: "opt-reject-once" },
    });
  });

  it("handles fs/read_text_file and fs/write_text_file while blocking secret reads, read-only writes, and control-plane mutations", async () => {
    const dir = makeTempDir();
    const autoloopHome = path.join(dir, "autoloop_home");
    const sampleFile = path.join(dir, "notes.txt");
    const outputFile = path.join(dir, "sub", "written.txt");
    const fsReportFile = path.join(dir, "fs-report.json");

    writeFileSync(sampleFile, "line-1\nline-2\nline-3\nline-4", "utf8");

    const serverScript = makeFakeAcpServer(
      dir,
      `
      async function callSafe(method, params) {
        try {
          const res = await requestClient(method, params);
          return { ok: true, res };
        } catch (err) {
          return { ok: false, err };
        }
      }

      async function onMessage(msg) {
        if (msg.method === "initialize") {
          send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
          return;
        }
        if (msg.method === "session/new") {
          send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-fs" } });
          return;
        }
        if (msg.method === "session/set_model") {
          send({ jsonrpc: "2.0", id: msg.id, result: {} });
          return;
        }
        if (msg.method === "session/prompt") {
          const report = {};
          report.readFull = await callSafe("fs/read_text_file", {
            sessionId: "sess-fs",
            path: ${JSON.stringify(sampleFile)},
          });
          report.readSlice = await callSafe("fs/read_text_file", {
            sessionId: "sess-fs",
            path: ${JSON.stringify(sampleFile)},
            line: 2,
            limit: 2,
          });
          report.readContext = await callSafe("fs/read_text_file", {
            sessionId: "sess-fs",
            path: process.env.AUTOLOOP_CONTEXT,
          });
          report.readGuardSecret = await callSafe("fs/read_text_file", {
            sessionId: "sess-fs",
            path: process.env.AUTOLOOP_GUARD_FILE,
          });
          report.readMasterKey = await callSafe("fs/read_text_file", {
            sessionId: "sess-fs",
            path: process.env.TEST_MASTER_KEY,
          });
          report.writeWorkspace = await callSafe("fs/write_text_file", {
            sessionId: "sess-fs",
            path: ${JSON.stringify(outputFile)},
            content: "hello from acp",
          });
          report.writeContextDenied = await callSafe("fs/write_text_file", {
            sessionId: "sess-fs",
            path: process.env.AUTOLOOP_CONTEXT,
            content: "tampered",
          });
          report.writeHubDbDenied = await callSafe("fs/write_text_file", {
            sessionId: "sess-fs",
            path: process.env.TEST_HUB_DB,
            content: "corrupt",
          });

          writeFileSync(${JSON.stringify(fsReportFile)}, JSON.stringify(report), "utf8");
          send({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "sess-fs",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "文件回调校验完成\\n" },
              },
            },
          });
          send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
          process.exit(0);
        }
      }
      `,
    );

    const editJob = makeJob(dir, [process.execPath, serverScript], {
      run: 301,
    });
    const editFiles = writeRunFiles(autoloopHome, editJob);
    const masterKeyPath = path.join(autoloopHome, "master.key");
    const hubDbPath = path.join(autoloopHome, "hub.db");
    writeFileSync(masterKeyPath, "super-secret-master-key", "utf8");
    writeFileSync(hubDbPath, "sqlite-bytes", "utf8");

    const editExec = await runAcpAgent({
      job: editJob,
      contextFile: editFiles.contextFile,
      guardFile: editFiles.guardFile,
      baseEnv: {
        ...process.env,
        TEST_MASTER_KEY: masterKeyPath,
        TEST_HUB_DB: hubDbPath,
      },
    });
    assert.equal(editExec.outcome, "done");

    const report = JSON.parse(readFileSync(fsReportFile, "utf8"));
    assert.equal(report.readFull.ok, true);
    assert.equal(report.readFull.res.content, "line-1\nline-2\nline-3\nline-4");
    assert.equal(report.readSlice.ok, true);
    assert.equal(report.readSlice.res.content, "line-2\nline-3");
    assert.equal(report.readContext.ok, true);
    assert.equal(report.readGuardSecret.ok, false);
    assert.equal(report.readMasterKey.ok, false);
    assert.equal(report.writeWorkspace.ok, true);
    assert.equal(readFileSync(outputFile, "utf8"), "hello from acp");
    assert.equal(report.writeContextDenied.ok, false);
    assert.equal(report.writeHubDbDenied.ok, false);
    assert.equal(readFileSync(hubDbPath, "utf8"), "sqlite-bytes");

    // Verify fs/write_text_file is rejected under access === "read"
    rmSync(outputFile, { force: true });
    const readOnlyJob = makeJob(dir, [process.execPath, serverScript], {
      run: 302,
      agent: {
        id: "ro-acp",
        name: "ro-acp",
        runner: "acp",
        command: [process.execPath, serverScript],
        access: "read",
      },
    });
    const roFiles = writeRunFiles(autoloopHome, readOnlyJob);
    await runAcpAgent({
      job: readOnlyJob,
      contextFile: roFiles.contextFile,
      guardFile: roFiles.guardFile,
      baseEnv: {
        ...process.env,
        TEST_MASTER_KEY: masterKeyPath,
        TEST_HUB_DB: hubDbPath,
      },
    });
    const roReport = JSON.parse(readFileSync(fsReportFile, "utf8"));
    assert.equal(roReport.writeWorkspace.ok, false);
    assert.equal(existsSync(outputFile), false);
  });

  it("sends session/cancel on AbortSignal and forcefully kills stubborn process groups", async () => {
    const dir = makeTempDir();
    const autoloopHome = path.join(dir, "autoloop_home");
    const logFile = path.join(dir, "cancel-rpc.jsonl");
    const grandchildPidFile = path.join(dir, "cancel-grandchild.pid");
    const promptEnteredFile = path.join(dir, "prompt-entered.flag");

    const serverScript = makeFakeAcpServer(
      dir,
      `
      // Ignore SIGTERM in both server and grandchild to verify SIGKILL escalation on -pid
      process.on("SIGTERM", () => {});
      const child = spawn(
        process.execPath,
        ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
        { stdio: "ignore" },
      );
      writeFileSync(${JSON.stringify(grandchildPidFile)}, String(child.pid), "utf8");
      setInterval(() => {}, 1000);

      async function onMessage(msg) {
        if (msg.method === "initialize") {
          send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
          return;
        }
        if (msg.method === "session/new") {
          send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-cancel-77" } });
          return;
        }
        if (msg.method === "session/set_model") {
          send({ jsonrpc: "2.0", id: msg.id, result: {} });
          return;
        }
        if (msg.method === "session/prompt") {
          writeFileSync(${JSON.stringify(promptEnteredFile)}, "1", "utf8");
          // Hang indefinitely until cancelled
        }
      }
      `,
    );

    const job = makeJob(dir, [process.execPath, serverScript], { run: 401 });
    const files = writeRunFiles(autoloopHome, job);
    const ac = new AbortController();
    let serverPid = 0;

    const runPromise = runAcpAgent({
      job,
      contextFile: files.contextFile,
      guardFile: files.guardFile,
      killGraceMs: 80,
      signal: ac.signal,
      baseEnv: { ...process.env, FAKE_ACP_LOG_FILE: logFile },
      onStarted: (info) => {
        serverPid = info.pid ?? 0;
      },
    });

    const waitDeadline = Date.now() + 3_000;
    while (!existsSync(promptEnteredFile) && Date.now() < waitDeadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(existsSync(promptEnteredFile), true);

    ac.abort();
    const exec = await runPromise;

    assert.equal(exec.cancelled, true);
    assert.equal(exec.timedOut, false);
    assert.equal(exec.outcome, "cancelled");
    assert.equal(exec.started, true);
    assert.equal(exec.session, "sess-cancel-77");

    const grandchildPid = Number(
      readFileSync(grandchildPidFile, "utf8").trim(),
    );
    assert.ok(serverPid > 0);
    assert.ok(grandchildPid > 0);
    assert.equal(await waitForProcessDead(serverPid), true);
    assert.equal(await waitForProcessDead(grandchildPid), true);

    const logged = readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const cancelMsg = logged.find((m) => m.method === "session/cancel");
    assert.ok(
      cancelMsg,
      "Expected session/cancel notification to be sent before kill",
    );
    assert.equal(cancelMsg.params.sessionId, "sess-cancel-77");
  });

  it("validates command array, handles pre-aborted signal, preserves session on mid-prompt crash, enforces timeout, and blocks inline-script / negative-answer bypasses", async () => {
    const dir = makeTempDir();
    const autoloopHome = path.join(dir, "autoloop_home");

    // 1. Empty command throws InputError
    const badJob = makeJob(dir, []);
    const badFiles = writeRunFiles(autoloopHome, badJob);
    await assert.rejects(
      () =>
        runAcpAgent({
          job: badJob,
          contextFile: badFiles.contextFile,
          guardFile: badFiles.guardFile,
        }),
      /command/i,
    );

    // 2. Pre-aborted signal returns cancelled without spawning
    const preAc = new AbortController();
    preAc.abort();
    const preExec = await runAcpAgent({
      job: makeJob(dir, [process.execPath, "-e", "process.exit(0)"], {
        run: 501,
      }),
      contextFile: badFiles.contextFile,
      guardFile: badFiles.guardFile,
      signal: preAc.signal,
    });
    assert.equal(preExec.cancelled, true);
    assert.equal(preExec.started, false);
    assert.equal(preExec.session, null);
    assert.equal(preExec.outcome, "cancelled");

    // 3. Mid-prompt crash preserves started: true & session so side-effecting sessions are not reopened
    const crashScript = makeFakeAcpServer(
      dir,
      `
      async function onMessage(msg) {
        if (msg.method === "initialize") {
          send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
          return;
        }
        if (msg.method === "session/new") {
          send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-crash-mid" } });
          return;
        }
        if (msg.method === "session/set_model") {
          send({ jsonrpc: "2.0", id: msg.id, result: {} });
          return;
        }
        if (msg.method === "session/prompt") {
          process.stderr.write("fatal upstream network error\\n");
          process.exit(2);
        }
      }
      `,
    );
    const crashJob = makeJob(dir, [process.execPath, crashScript], {
      run: 502,
    });
    const crashFiles = writeRunFiles(autoloopHome, crashJob);
    const crashExec = await runAcpAgent({
      job: crashJob,
      contextFile: crashFiles.contextFile,
      guardFile: crashFiles.guardFile,
    });
    assert.equal(crashExec.started, true);
    assert.equal(crashExec.session, "sess-crash-mid");
    assert.equal(crashExec.outcome, "failed");
    assert.equal(crashExec.exitCode, 2);

    // 4. Timeout reaps hanging process and marks timedOut: true
    const hangDecisions = path.join(dir, "bypass-decisions.json");
    const bypassAndHangScript = makeFakeAcpServer(
      dir,
      `
      setInterval(() => {}, 1000);
      async function onMessage(msg) {
        if (msg.method === "initialize") {
          send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
          return;
        }
        if (msg.method === "session/new") {
          send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-timeout-9" } });
          return;
        }
        if (msg.method === "session/set_model") {
          send({ jsonrpc: "2.0", id: msg.id, result: {} });
          return;
        }
        if (msg.method === "session/prompt") {
          const opts = [
            { optionId: "allow_1", kind: "allow_once" },
            { optionId: "reject_1", kind: "reject_once" },
          ];
          const inlineRm = await requestClient("session/request_permission", {
            sessionId: "sess-timeout-9",
            toolCall: {
              toolCallId: "b1",
              kind: "execute",
              title: "Inline node rm",
              rawInput: { command: "node -e \\"require('fs').rmSync('target', { recursive: true })\\"" },
            },
            options: opts,
          });
          const negativeDeploy = await requestClient("session/request_permission", {
            sessionId: "sess-timeout-9",
            toolCall: {
              toolCallId: "b2",
              kind: "execute",
              title: "Deploy prod",
              rawInput: { command: "npm run deploy-prod" },
            },
            options: opts,
          });
          const outOfCwdRm = await requestClient("session/request_permission", {
            sessionId: "sess-timeout-9",
            toolCall: {
              toolCallId: "b3",
              kind: "execute",
              title: "Root rm",
              rawInput: { command: "rm -rf /" },
            },
            options: opts,
          });
          writeFileSync(${JSON.stringify(hangDecisions)}, JSON.stringify({ inlineRm, negativeDeploy, outOfCwdRm }), "utf8");
          // Now hang past timeoutMs
        }
      }
      `,
    );

    const negJob = makeJob(dir, [process.execPath, bypassAndHangScript], {
      run: 503,
      context: {
        events: [],
        answers: [
          {
            card: 9,
            key: "deploy-prod",
            title: "Allow deploy?",
            options: ["同意", "不同意，先暂缓"],
            choice: 1,
            chosen: "不同意，先暂缓",
            about: "deploy",
            at: "2026-11-19T12:10:00Z",
          },
        ],
        timers: [],
        waiting: [],
        open: [],
        decided: [],
      },
    });
    const negFiles = writeRunFiles(autoloopHome, negJob);
    let timedOutPid = 0;
    const timeoutExec = await runAcpAgent({
      job: negJob,
      contextFile: negFiles.contextFile,
      guardFile: negFiles.guardFile,
      timeoutMs: 250,
      killGraceMs: 60,
      onStarted: (info) => {
        timedOutPid = info.pid ?? 0;
      },
    });
    assert.equal(timeoutExec.timedOut, true);
    assert.equal(timeoutExec.cancelled, false);
    assert.equal(timeoutExec.outcome, "failed");
    assert.equal(timeoutExec.started, true);
    assert.equal(timeoutExec.session, "sess-timeout-9");
    assert.equal(await waitForProcessDead(timedOutPid), true);

    const bypassRes = JSON.parse(readFileSync(hangDecisions, "utf8"));
    assert.deepEqual(bypassRes.inlineRm, {
      outcome: { outcome: "selected", optionId: "reject_1" },
    });
    assert.deepEqual(bypassRes.negativeDeploy, {
      outcome: { outcome: "selected", optionId: "reject_1" },
    });
    assert.deepEqual(bypassRes.outOfCwdRm, {
      outcome: { outcome: "selected", optionId: "reject_1" },
    });
  });

  it("advertises clientCapabilities.terminal === false even for edit/full access and rejects all terminal/* reverse RPCs with -32000", async () => {
    const dir = makeTempDir();
    const autoloopHome = path.join(dir, "autoloop_home");
    const reportFile = path.join(dir, "terminal-report.json");

    const serverScript = makeFakeAcpServer(
      dir,
      `
      let initCaps = null;
      async function callSafe(method, params) {
        try {
          const res = await requestClient(method, params);
          return { ok: true, res };
        } catch (err) {
          return { ok: false, err };
        }
      }

      async function onMessage(msg) {
        if (msg.method === "initialize") {
          initCaps = msg.params.clientCapabilities;
          send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
          return;
        }
        if (msg.method === "session/new") {
          send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-term-0" } });
          return;
        }
        if (msg.method === "session/set_model") {
          send({ jsonrpc: "2.0", id: msg.id, result: {} });
          return;
        }
        if (msg.method === "session/prompt") {
          const createRes = await callSafe("terminal/create", {
            sessionId: "sess-term-0",
            command: "echo",
            args: ["hello"],
          });
          const outputRes = await callSafe("terminal/output", {
            sessionId: "sess-term-0",
            terminalId: "term-1",
          });
          writeFileSync(
            ${JSON.stringify(reportFile)},
            JSON.stringify({ initCaps, createRes, outputRes }),
            "utf8",
          );
          send({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "sess-term-0",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "终端能力禁用校验完成\\n" },
              },
            },
          });
          send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
          process.exit(0);
        }
      }
      `,
    );

    for (const [idx, access] of (["edit", "full"] as const).entries()) {
      const job = makeJob(dir, [process.execPath, serverScript], {
        run: 600 + idx,
        agent: {
          id: `acp-${access}`,
          name: `acp-${access}`,
          runner: "acp",
          command: [process.execPath, serverScript],
          access,
        },
      });
      const files = writeRunFiles(autoloopHome, job);
      const exec = await runAcpAgent({
        job,
        contextFile: files.contextFile,
        guardFile: files.guardFile,
      });
      assert.equal(exec.outcome, "done");

      const report = JSON.parse(readFileSync(reportFile, "utf8"));
      assert.deepEqual(report.initCaps, {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
      });
      assert.equal(report.createRes.ok, false);
      assert.notEqual(report.createRes.err.code, -32601);
      assert.equal(report.createRes.err.code, -32000);
      assert.match(report.createRes.err.message, /terminal/i);
      assert.equal(report.outputRes.ok, false);
      assert.equal(report.outputRes.err.code, -32000);
    }
  });

  it("blocks OpenCode external_directory and subpath searches on <AUTOLOOP_HOME> and <guardDir> while allowing exact context.json, rules.json, and workspace .autoloop/", async () => {
    const dir = makeTempDir();
    const autoloopHome = path.join(dir, "autoloop_home");
    const wsAutoloopDir = path.join(dir, ".autoloop");
    mkdirSync(wsAutoloopDir, { recursive: true });
    const wsDecisionsFile = path.join(wsAutoloopDir, "decisions.md");
    writeFileSync(wsDecisionsFile, "# Workspace decisions\n", "utf8");

    const job = makeJob(dir, [process.execPath, "placeholder.mjs"], {
      run: 610,
    });
    const files = writeRunFiles(autoloopHome, job);
    const guardDir = path.dirname(files.guardFile);
    const runsDir = path.dirname(guardDir);
    const rulesJsonPath = path.join(autoloopHome, "rules.json");
    const ownerTokenPath = path.join(autoloopHome, "owner.token");
    const masterKeyPath = path.join(autoloopHome, "master.key");
    const hubDbPath = path.join(autoloopHome, "hub.db");
    const extraControlFile = path.join(autoloopHome, "internal-notes.txt");
    writeFileSync(rulesJsonPath, '{"rules":[]}', "utf8");
    writeFileSync(ownerTokenPath, "secret-owner", "utf8");
    writeFileSync(masterKeyPath, "secret-master", "utf8");
    writeFileSync(hubDbPath, "sqlite", "utf8");
    writeFileSync(extraControlFile, "internal-control-state", "utf8");

    const reportFile = path.join(dir, "cp-confinement-report.json");
    const stdOptions = [
      { optionId: "opt-allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "opt-reject-once", name: "Reject once", kind: "reject_once" },
    ];

    const serverScript = makeFakeAcpServer(
      dir,
      `
      const opts = ${JSON.stringify(stdOptions)};
      async function callSafe(method, params) {
        try {
          const res = await requestClient(method, params);
          return { ok: true, res };
        } catch (err) {
          return { ok: false, err };
        }
      }

      async function onMessage(msg) {
        if (msg.method === "initialize") {
          send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
          return;
        }
        if (msg.method === "session/new") {
          send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-cp" } });
          return;
        }
        if (msg.method === "session/set_model") {
          send({ jsonrpc: "2.0", id: msg.id, result: {} });
          return;
        }
        if (msg.method === "session/prompt") {
          const r = {};
          // OpenCode external_directory (kind: "other", locations: [autoloopHome], no name/rawInput)
          r.extDirHome = await requestClient("session/request_permission", {
            sessionId: "sess-cp",
            toolCall: {
              toolCallId: "cp-1",
              kind: "other",
              title: "External directory access",
              locations: [{ path: ${JSON.stringify(autoloopHome)} }],
            },
            options: opts,
          });
          r.extDirGuardRun = await requestClient("session/request_permission", {
            sessionId: "sess-cp",
            toolCall: {
              toolCallId: "cp-2",
              kind: "other",
              locations: [{ path: ${JSON.stringify(guardDir)} }],
            },
            options: [{ optionId: "allow-only", kind: "allow_once" }],
          });
          r.readHomeDir = await requestClient("session/request_permission", {
            sessionId: "sess-cp",
            toolCall: {
              toolCallId: "cp-3",
              kind: "read",
              locations: [{ path: ${JSON.stringify(autoloopHome)} }],
            },
            options: opts,
          });
          r.searchRunsDir = await requestClient("session/request_permission", {
            sessionId: "sess-cp",
            toolCall: {
              toolCallId: "cp-4",
              kind: "search",
              locations: [{ path: ${JSON.stringify(runsDir)} }],
            },
            options: opts,
          });
          r.searchGuardDir = await requestClient("session/request_permission", {
            sessionId: "sess-cp",
            toolCall: {
              toolCallId: "cp-5",
              kind: "search",
              locations: [{ path: ${JSON.stringify(guardDir)} }],
            },
            options: opts,
          });
          r.readOwnerToken = await requestClient("session/request_permission", {
            sessionId: "sess-cp",
            toolCall: {
              toolCallId: "cp-6",
              kind: "read",
              locations: [{ path: ${JSON.stringify(ownerTokenPath)} }],
            },
            options: opts,
          });
          r.readMasterKey = await requestClient("session/request_permission", {
            sessionId: "sess-cp",
            toolCall: {
              toolCallId: "cp-7",
              kind: "read",
              locations: [{ path: ${JSON.stringify(masterKeyPath)} }],
            },
            options: opts,
          });
          r.readHubDb = await requestClient("session/request_permission", {
            sessionId: "sess-cp",
            toolCall: {
              toolCallId: "cp-8",
              kind: "read",
              locations: [{ path: ${JSON.stringify(hubDbPath)} }],
            },
            options: opts,
          });
          r.otherOnContext = await requestClient("session/request_permission", {
            sessionId: "sess-cp",
            toolCall: {
              toolCallId: "cp-9",
              kind: "other",
              locations: [{ path: ${JSON.stringify(files.contextFile)} }],
            },
            options: opts,
          });
          r.readExactContext = await requestClient("session/request_permission", {
            sessionId: "sess-cp",
            toolCall: {
              toolCallId: "cp-10",
              kind: "read",
              locations: [{ path: ${JSON.stringify(files.contextFile)} }],
            },
            options: opts,
          });
          r.readExactRules = await requestClient("session/request_permission", {
            sessionId: "sess-cp",
            toolCall: {
              toolCallId: "cp-11",
              kind: "read",
              locations: [{ path: ${JSON.stringify(rulesJsonPath)} }],
            },
            options: opts,
          });
          r.wsAutoloopSearch = await requestClient("session/request_permission", {
            sessionId: "sess-cp",
            toolCall: {
              toolCallId: "cp-12",
              kind: "search",
              locations: [{ path: ${JSON.stringify(wsAutoloopDir)} }],
            },
            options: opts,
          });
          r.wsDecisionsEdit = await requestClient("session/request_permission", {
            sessionId: "sess-cp",
            toolCall: {
              toolCallId: "cp-13",
              kind: "edit",
              locations: [{ path: ${JSON.stringify(wsDecisionsFile)} }],
            },
            options: opts,
          });
          r.fsReadRules = await callSafe("fs/read_text_file", {
            sessionId: "sess-cp",
            path: ${JSON.stringify(rulesJsonPath)},
          });
          r.fsReadExtraControl = await callSafe("fs/read_text_file", {
            sessionId: "sess-cp",
            path: ${JSON.stringify(extraControlFile)},
          });
          r.fsWriteExtraControl = await callSafe("fs/write_text_file", {
            sessionId: "sess-cp",
            path: ${JSON.stringify(path.join(autoloopHome, "injected.txt"))},
            content: "nope",
          });

          writeFileSync(${JSON.stringify(reportFile)}, JSON.stringify(r), "utf8");
          send({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "sess-cp",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "控制面目录隔离校验完成\\n" },
              },
            },
          });
          send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
          process.exit(0);
        }
      }
      `,
    );

    job.agent.command = [process.execPath, serverScript];
    const exec = await runAcpAgent({
      job,
      contextFile: files.contextFile,
      guardFile: files.guardFile,
    });
    assert.equal(exec.outcome, "done");

    const r = JSON.parse(readFileSync(reportFile, "utf8"));
    const rejected = {
      outcome: { outcome: "selected", optionId: "opt-reject-once" },
    };
    const allowed = {
      outcome: { outcome: "selected", optionId: "opt-allow-once" },
    };

    assert.deepEqual(r.extDirHome, rejected);
    assert.deepEqual(r.extDirGuardRun, { outcome: { outcome: "cancelled" } });
    assert.deepEqual(r.readHomeDir, rejected);
    assert.deepEqual(r.searchRunsDir, rejected);
    assert.deepEqual(r.searchGuardDir, rejected);
    assert.deepEqual(r.readOwnerToken, rejected);
    assert.deepEqual(r.readMasterKey, rejected);
    assert.deepEqual(r.readHubDb, rejected);
    assert.deepEqual(r.otherOnContext, rejected);

    assert.deepEqual(r.readExactContext, allowed);
    assert.deepEqual(r.readExactRules, allowed);
    assert.deepEqual(r.wsAutoloopSearch, allowed);
    assert.deepEqual(r.wsDecisionsEdit, allowed);

    assert.equal(r.fsReadRules.ok, true);
    assert.equal(r.fsReadRules.res.content, '{"rules":[]}');
    assert.equal(r.fsReadExtraControl.ok, false);
    assert.equal(r.fsWriteExtraControl.ok, false);
  });

  it("enforces strict read-only tool allowlist under access=read (rejecting switch_mode, other/MCP tools, and unknown kinds) and normalizes Anthropic cached <= input usage", async () => {
    const dir = makeTempDir();
    const autoloopHome = path.join(dir, "autoloop_home");
    const reportFile = path.join(dir, "ro-allowlist-report.json");
    const stdOptions = [
      { optionId: "opt-allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "opt-reject-once", name: "Reject once", kind: "reject_once" },
    ];

    const serverScript = makeFakeAcpServer(
      dir,
      `
      const opts = ${JSON.stringify(stdOptions)};
      const usageVariant = process.env.TEST_USAGE_VARIANT || "uncached-separate";

      async function onMessage(msg) {
        if (msg.method === "initialize") {
          send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
          return;
        }
        if (msg.method === "session/new") {
          send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-ro-strict" } });
          return;
        }
        if (msg.method === "session/set_model") {
          send({ jsonrpc: "2.0", id: msg.id, result: {} });
          return;
        }
        if (msg.method === "session/prompt") {
          const r = {};
          r.switchMode = await requestClient("session/request_permission", {
            sessionId: "sess-ro-strict",
            toolCall: {
              toolCallId: "ro-1",
              kind: "switch_mode",
              title: "Exit plan mode to build mode",
            },
            options: opts,
          });
          r.mcpGithubWrite = await requestClient("session/request_permission", {
            sessionId: "sess-ro-strict",
            toolCall: {
              toolCallId: "ro-2",
              kind: "other",
              name: "mcp__github__create_issue",
              title: "Create GitHub Issue",
              rawInput: { title: "unauthorized issue" },
            },
            options: opts,
          });
          r.fetchTool = await requestClient("session/request_permission", {
            sessionId: "sess-ro-strict",
            toolCall: {
              toolCallId: "ro-3",
              kind: "fetch",
              title: "POST webhook",
            },
            options: opts,
          });
          r.missingKind = await requestClient("session/request_permission", {
            sessionId: "sess-ro-strict",
            toolCall: {
              toolCallId: "ro-4",
              title: "Mystery custom tool",
            },
            options: opts,
          });
          r.spoofedReadWriteName = await requestClient("session/request_permission", {
            sessionId: "sess-ro-strict",
            toolCall: {
              toolCallId: "ro-5",
              kind: "read",
              name: "write_file",
              locations: [{ path: "README.md" }],
            },
            options: opts,
          });
          r.execArbitraryNodeScript = await requestClient("session/request_permission", {
            sessionId: "sess-ro-strict",
            toolCall: {
              toolCallId: "ro-6",
              kind: "execute",
              rawInput: { command: "node mutate.js" },
            },
            options: opts,
          });
          r.execReadOnlyGit = await requestClient("session/request_permission", {
            sessionId: "sess-ro-strict",
            toolCall: {
              toolCallId: "ro-7",
              kind: "execute",
              rawInput: { command: "git status --short" },
            },
            options: opts,
          });
          r.readWorkspace = await requestClient("session/request_permission", {
            sessionId: "sess-ro-strict",
            toolCall: {
              toolCallId: "ro-8",
              kind: "read",
              title: "Read src/write-helper.ts",
              locations: [{ path: "src/write-helper.ts" }],
            },
            options: opts,
          });
          r.searchWorkspace = await requestClient("session/request_permission", {
            sessionId: "sess-ro-strict",
            toolCall: {
              toolCallId: "ro-9",
              kind: "search",
              title: "Grep workspace",
              locations: [{ path: "src" }],
            },
            options: opts,
          });
          r.thinkTool = await requestClient("session/request_permission", {
            sessionId: "sess-ro-strict",
            toolCall: {
              toolCallId: "ro-10",
              kind: "think",
              title: "Analyze findings",
            },
            options: opts,
          });

          writeFileSync(${JSON.stringify(reportFile)}, JSON.stringify(r), "utf8");
          send({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "sess-ro-strict",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "只读白名单与用量归一化校验完成\\n" },
              },
            },
          });

          const usage =
            usageVariant === "pre-summed"
              ? {
                  input_tokens: 550,
                  cache_read_input_tokens: 400,
                  cache_creation_input_tokens: 100,
                  output_tokens: 80,
                  total_tokens: 630,
                }
              : {
                  input_tokens: 50,
                  cache_read_input_tokens: 400,
                  cache_creation_input_tokens: 100,
                  output_tokens: 80,
                };

          send({
            jsonrpc: "2.0",
            id: msg.id,
            result: { stopReason: "end_turn", usage },
          });
          process.exit(0);
        }
      }
      `,
    );

    const job = makeJob(dir, [process.execPath, serverScript], {
      run: 620,
      agent: {
        id: "claude-acp-ro",
        name: "claude-acp-ro",
        runner: "acp",
        command: [process.execPath, serverScript],
        access: "read",
      },
    });
    const files = writeRunFiles(autoloopHome, job);

    const exec = await runAcpAgent({
      job,
      contextFile: files.contextFile,
      guardFile: files.guardFile,
    });
    assert.equal(exec.outcome, "done");

    const r = JSON.parse(readFileSync(reportFile, "utf8"));
    const rejected = {
      outcome: { outcome: "selected", optionId: "opt-reject-once" },
    };
    const allowed = {
      outcome: { outcome: "selected", optionId: "opt-allow-once" },
    };

    assert.deepEqual(r.switchMode, rejected);
    assert.deepEqual(r.mcpGithubWrite, rejected);
    assert.deepEqual(r.fetchTool, rejected);
    assert.deepEqual(r.missingKind, rejected);
    assert.deepEqual(r.spoofedReadWriteName, rejected);
    assert.deepEqual(r.execArbitraryNodeScript, rejected);

    assert.deepEqual(r.execReadOnlyGit, allowed);
    assert.deepEqual(r.readWorkspace, allowed);
    assert.deepEqual(r.searchWorkspace, allowed);
    assert.deepEqual(r.thinkTool, allowed);

    assert.deepEqual(exec.usage, {
      input: 550,
      output: 80,
      cached: 500,
    });
    assert.ok((exec.usage?.input ?? 0) >= (exec.usage?.cached ?? 0));

    // Also verify pre-summed total_tokens payload does not double-count cached tokens
    const job2 = makeJob(dir, [process.execPath, serverScript], {
      run: 621,
      agent: {
        id: "claude-acp-ro",
        name: "claude-acp-ro",
        runner: "acp",
        command: [process.execPath, serverScript],
        access: "read",
      },
    });
    const files2 = writeRunFiles(autoloopHome, job2);
    const exec2 = await runAcpAgent({
      job: job2,
      contextFile: files2.contextFile,
      guardFile: files2.guardFile,
      baseEnv: { ...process.env, TEST_USAGE_VARIANT: "pre-summed" },
    });
    assert.deepEqual(exec2.usage, {
      input: 550,
      output: 80,
      cached: 500,
    });
  });
});
