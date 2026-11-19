/**
 * WP-5 V1.2 Multi-Engine Supervisor Wiring & Cross-Vendor Delivery Integration Tests.
 *
 * 防止的真实故障与安全越界：
 * 1. `engine/supervisor.ts` 或 `HubRuntime` 漏接 `codex` / `claude` / `acp` / `herdr` 四大新执行通道，
 *    或 `default` 分支缺失 `never` 穷尽检查导致新增 `RunnerKind` 在运行期抛异常。
 * 2. 新通道输出 `ask` 奏折卡后子进程驻留空耗（违反「挂起零消耗」红线），或人工 `answerCard` 批红后丢失原会话 ID
 *    （`thread_id` / `session_id` / `acpSessionId` / `herdr:w1:p1`）重开新会话丢失上下文，或漏传 `approvedKeys`。
 * 3. 新会话型执行器首轮业务已完成但末尾 `agent-autoloop` 回执 JSON 写错时，未在原会话触发最多 2 次 `repairPrompt` 原地修复，
 *    或连续 2 次未修好时误标为 `failed` 触发整轮有副作用操作重跑（必须走 `discardReceipt` 保结论降级并推告警通知卡）。
 * 4. `delivery/reviewer.ts` 跨厂商盲审（`reviewerRunner: "codex" | "claude" | "acp"`）强塞 Antigravity 内部模型名 `gemini-4-*`、
 *    漏锁死只读沙箱（`-s read-only` / `--permission-mode plan` / ACP `access: "read"` 协议层拒写）、
 *    切换 `reviewerRunner` 时误命中旧审查器 SHA 缓存跳过独立盲审，或第 2 轮漏喂 `prevSha..headSha` 增量补丁。
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  createDeliveryRunner,
  runDeliveryPipeline,
} from "../delivery/pipeline.ts";
import {
  readReviewLedger,
  reviewBranchSnapshot,
} from "../delivery/reviewer.ts";
import { extractBranchSnapshot } from "../delivery/snapshot.ts";
import type { RulesConfig } from "../protocol/types.ts";
import { HubRuntime } from "../sidecars/hub/ipc-server.ts";
import { assertInvariants } from "../sim/invariants.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix = "autoloop-v12-wp5-"): string {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

function makeExecutableScript(dir: string, name: string, body: string): string {
  const scriptPath = path.join(dir, name);
  writeFileSync(scriptPath, `#!/usr/bin/env node\n${body}`, "utf8");
  chmodSync(scriptPath, 0o755);
  return scriptPath;
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

async function waitUntil<T>(
  label: string,
  fn: () => T | null | undefined | false,
  timeoutMs = 8_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = fn();
    if (val) {
      return val;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

function readJsonl<T = Record<string, unknown>>(filePath: string): T[] {
  if (!existsSync(filePath)) {
    return [];
  }
  const raw = readFileSync(filePath, "utf8").trim();
  if (!raw) {
    return [];
  }
  return raw.split("\n").map((line) => JSON.parse(line) as T);
}

function git(repoDir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
    },
  }).trim();
}

function writeRepoFile(
  repoDir: string,
  relPath: string,
  content: string,
): void {
  const fullPath = path.join(repoDir, relPath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, "utf8");
}

function createTempGitRepo(
  filesOnMain: Record<string, string>,
  defaultBranch = "main",
): string {
  const repoDir = makeTempDir("autoloop-v12-repo-");
  git(repoDir, ["init", "-b", defaultBranch]);
  git(repoDir, ["config", "user.name", "Autoloop V12 Test"]);
  git(repoDir, ["config", "user.email", "v12-wp5@example.invalid"]);
  for (const [relPath, content] of Object.entries(filesOnMain)) {
    writeRepoFile(repoDir, relPath, content);
  }
  git(repoDir, ["add", "."]);
  git(repoDir, ["commit", "-m", "chore: initial main baseline"]);
  return repoDir;
}

/**
 * Scripted fake `codex` CLI supporting sequential turns, recording argv/stdin/pid/guard,
 * and handling both fresh `codex exec` and `codex exec ... resume <threadId> -`.
 */
function createScriptedCodex(
  dir: string,
  turnsFile: string,
  recordsFile: string,
): string {
  return makeExecutableScript(
    dir,
    "fake-codex-v12.mjs",
    `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const stdinText = readFileSync(0, "utf8");
const state = JSON.parse(readFileSync(${JSON.stringify(turnsFile)}, "utf8"));
const idx = state.turn ?? 0;
state.turn = idx + 1;
writeFileSync(${JSON.stringify(turnsFile)}, JSON.stringify(state, null, 2), "utf8");

const turn = state.turns[idx] ?? state.turns[state.turns.length - 1];
const resumeIdx = argv.indexOf("resume");
let resumedThread = null;
if (resumeIdx !== -1) {
  // Format: exec ... resume [--json] [-o file] [-m model] [-c ...] <session> -
  resumedThread = argv[argv.length - 2] ?? null;
}

const guardPath = process.env.AUTOLOOP_GUARD_FILE || "";
const contextPath = process.env.AUTOLOOP_CONTEXT || "";
const guardJson = guardPath && existsSync(guardPath)
  ? JSON.parse(readFileSync(guardPath, "utf8"))
  : null;
const contextContent = contextPath && existsSync(contextPath)
  ? readFileSync(contextPath, "utf8")
  : null;

appendFileSync(${JSON.stringify(recordsFile)}, JSON.stringify({
  turn: idx,
  pid: process.pid,
  argv,
  resumedThread,
  stdinText,
  guardJson,
  contextPath,
  contextPreview: contextContent ? contextContent.slice(0, 600) : null,
  ownerToken: process.env.AUTOLOOP_OWNER_TOKEN ?? null,
}) + "\\n", "utf8");

const outIdx = argv.indexOf("-o");
const lastMsgFile = outIdx !== -1 ? argv[outIdx + 1] : null;
if (lastMsgFile && typeof turn.text === "string") {
  writeFileSync(lastMsgFile, turn.text, "utf8");
}

if (turn.failBeforeStart) {
  process.stderr.write((turn.stderr || "stale thread not found") + "\\n");
  process.exit(turn.exitCode ?? 1);
}

const threadId = turn.threadId ?? resumedThread ?? "codex-thread-default";
console.log(JSON.stringify({ type: "thread.started", thread_id: threadId }));
console.log(JSON.stringify({ type: "turn.started" }));
console.log(JSON.stringify({
  type: "item.completed",
  item: { id: "msg_" + idx, type: "agent_message", text: turn.text }
}));
console.log(JSON.stringify({
  type: "turn.completed",
  usage: turn.usage ?? { input_tokens: 200, cached_input_tokens: 50, output_tokens: 40 }
}));
`,
  );
}

/**
 * Scripted fake `zcode` / `claude` stream-json CLI supporting `-p --verbose --output-format stream-json`
 * and `--resume <session_id>`.
 */
function createScriptedClaude(
  dir: string,
  name: string,
  turnsFile: string,
  recordsFile: string,
): string {
  return makeExecutableScript(
    dir,
    name,
    `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const stdinText = readFileSync(0, "utf8");
const state = JSON.parse(readFileSync(${JSON.stringify(turnsFile)}, "utf8"));
const idx = state.turn ?? 0;
state.turn = idx + 1;
writeFileSync(${JSON.stringify(turnsFile)}, JSON.stringify(state, null, 2), "utf8");

const turn = state.turns[idx] ?? state.turns[state.turns.length - 1];
const resumeIdx = argv.indexOf("--resume");
const resumedSession = resumeIdx !== -1 ? (argv[resumeIdx + 1] ?? null) : null;
const permIdx = argv.indexOf("--permission-mode");
const permissionMode = permIdx !== -1 ? (argv[permIdx + 1] ?? null) : null;

const guardPath = process.env.AUTOLOOP_GUARD_FILE || "";
const contextPath = process.env.AUTOLOOP_CONTEXT || "";
const guardJson = guardPath && existsSync(guardPath)
  ? JSON.parse(readFileSync(guardPath, "utf8"))
  : null;

appendFileSync(${JSON.stringify(recordsFile)}, JSON.stringify({
  turn: idx,
  pid: process.pid,
  argv,
  resumedSession,
  permissionMode,
  stdinText,
  guardJson,
  contextPath,
  ownerToken: process.env.AUTOLOOP_OWNER_TOKEN ?? null,
}) + "\\n", "utf8");

const sessionId = turn.sessionId ?? resumedSession ?? "zcode-sess-default";
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }));
console.log(JSON.stringify({
  type: "assistant",
  session_id: sessionId,
  message: {
    role: "assistant",
    content: [{ type: "text", text: turn.text }],
    usage: { input_tokens: 60, cache_read_input_tokens: 140, cache_creation_input_tokens: 0, output_tokens: 35 }
  }
}));
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  session_id: sessionId,
  result: turn.text,
  total_cost_usd: 0.005,
  usage: { input_tokens: 60, cache_read_input_tokens: 140, cache_creation_input_tokens: 0, output_tokens: 35 }
}));
`,
  );
}

/**
 * Scripted fake `opencode acp` stdio JSON-RPC 2.0 daemon (intentionally stays resident until
 * `runAcpAgent` reaps its process group so zero-consumption teardown is verified).
 */
function createScriptedAcpServer(
  dir: string,
  turnsFile: string,
  recordsFile: string,
): string {
  return makeExecutableScript(
    dir,
    "fake-opencode-acp.mjs",
    `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

setInterval(() => {}, 1000);

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\\n");
}

let nextReqId = 500;
const pending = new Map();
function callClient(method, params) {
  const id = nextReqId++;
  return new Promise((resolve, reject) => {
    pending.set(String(id), { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

let activeSessionId = null;
let loadedSessionId = null;

async function handleRpc(msg) {
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
    });
    return;
  }
  if (msg.method === "session/new") {
    const state = JSON.parse(readFileSync(${JSON.stringify(turnsFile)}, "utf8"));
    const turn = state.turns[state.turn ?? 0] ?? state.turns[state.turns.length - 1];
    activeSessionId = turn.sessionId ?? "acp-sess-v12-1";
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: activeSessionId } });
    return;
  }
  if (msg.method === "session/load") {
    loadedSessionId = msg.params?.sessionId ?? null;
    activeSessionId = loadedSessionId;
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }
  if (msg.method === "session/set_model") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }
  if (msg.method === "session/prompt") {
    const state = JSON.parse(readFileSync(${JSON.stringify(turnsFile)}, "utf8"));
    const idx = state.turn ?? 0;
    state.turn = idx + 1;
    writeFileSync(${JSON.stringify(turnsFile)}, JSON.stringify(state, null, 2), "utf8");
    const turn = state.turns[idx] ?? state.turns[state.turns.length - 1];

    const promptText = String(msg.params?.prompt?.[0]?.text ?? "");
    const guardPath = process.env.AUTOLOOP_GUARD_FILE || "";
    const contextPath = process.env.AUTOLOOP_CONTEXT || "";
    const guardJson = guardPath && existsSync(guardPath)
      ? JSON.parse(readFileSync(guardPath, "utf8"))
      : null;

    let writePermissionOutcome = null;
    if (turn.probeWriteFile) {
      try {
        const permRes = await callClient("session/request_permission", {
          sessionId: activeSessionId,
          toolCall: {
            toolCallId: "tc-write-probe",
            title: "write_file",
            kind: "edit",
            rawInput: { path: turn.probeWriteFile },
          },
          options: [
            { optionId: "allow", kind: "allow_once", name: "Allow" },
            { optionId: "deny", kind: "reject_once", name: "Deny" },
          ],
        });
        writePermissionOutcome = permRes?.outcome ?? permRes;
      } catch (err) {
        writePermissionOutcome = { error: String(err?.message || err) };
      }
    }

    appendFileSync(${JSON.stringify(recordsFile)}, JSON.stringify({
      turn: idx,
      pid: process.pid,
      sessionId: activeSessionId,
      loadedSessionId,
      promptText,
      guardJson,
      contextPath,
      writePermissionOutcome,
      ownerToken: process.env.AUTOLOOP_OWNER_TOKEN ?? null,
    }) + "\\n", "utf8");

    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: activeSessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: turn.text },
        },
      },
    });
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        stopReason: "end_turn",
        usage: turn.usage ?? { inputTokens: 150, outputTokens: 45, cachedInputTokens: 50 },
      },
    });
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl = buf.indexOf("\\n");
  while (nl !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line.length > 0) {
      const msg = JSON.parse(line);
      if (msg.method === undefined && msg.id !== undefined) {
        const p = pending.get(String(msg.id));
        if (p) {
          pending.delete(String(msg.id));
          if (msg.error) p.reject(msg.error);
          else p.resolve(msg.result);
        }
      } else {
        void handleRpc(msg);
      }
    }
    nl = buf.indexOf("\\n");
  }
});
`,
  );
}

/**
 * Scripted fake `herdr` CLI exposing an idle `codex` agent on `w1:p1` in `workspaceDir`,
 * recording `agent prompt` calls and writing lossless `handoffFile` responses per turn.
 */
function createScriptedHerdr(
  dir: string,
  workspaceDir: string,
  turnsFile: string,
  recordsFile: string,
): string {
  return makeExecutableScript(
    dir,
    "fake-herdr-v12.mjs",
    `
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const group = argv[0] ?? "";
const sub = argv[1] ?? "";
const cwd = ${JSON.stringify(workspaceDir)};

const panes = [{
  pane_id: "w1:p1",
  workspace_id: "w1",
  cwd,
  foreground_cwd: cwd,
  agent: "codex",
  agent_name: "codex-pane",
  agent_status: "idle",
}];
const agents = [{
  pane_id: "w1:p1",
  workspace_id: "w1",
  name: "codex-pane",
  agent: "codex",
  agent_status: "idle",
  cwd,
  foreground_cwd: cwd,
}];

if (group === "pane" && sub === "list") {
  process.stdout.write(JSON.stringify({ id: "cli:pane:list", type: "pane_list", result: { panes } }) + "\\n");
  process.exit(0);
}
if (group === "agent" && sub === "list") {
  process.stdout.write(JSON.stringify({ id: "cli:agent:list", type: "agent_list", result: { agents } }) + "\\n");
  process.exit(0);
}
if (group === "agent" && sub === "read") {
  process.stdout.write("codex idle prompt>\\n");
  process.exit(0);
}
if (group === "agent" && sub === "prompt") {
  const targetPane = argv[2] ?? "";
  const promptText = argv[3] ?? "";
  const state = JSON.parse(readFileSync(${JSON.stringify(turnsFile)}, "utf8"));
  const idx = state.turn ?? 0;
  state.turn = idx + 1;
  writeFileSync(${JSON.stringify(turnsFile)}, JSON.stringify(state, null, 2), "utf8");
  const turn = state.turns[idx] ?? state.turns[state.turns.length - 1];

  const pathMatch = /([^\\s\`"']+herdr-handoff-attempt-\\d+\\.md)/.exec(promptText);
  if (pathMatch && pathMatch[1]) {
    mkdirSync(path.dirname(pathMatch[1]), { recursive: true });
    writeFileSync(pathMatch[1], turn.text, "utf8");
  }

  appendFileSync(${JSON.stringify(recordsFile)}, JSON.stringify({
    turn: idx,
    pid: process.pid,
    targetPane,
    promptText,
    ownerToken: process.env.AUTOLOOP_OWNER_TOKEN ?? null,
  }) + "\\n", "utf8");

  process.stdout.write(JSON.stringify({
    id: "cli:agent:prompt",
    type: "agent_prompt",
    result: { agent: { pane_id: targetPane, agent_status: "idle" } },
  }) + "\\n");
  process.exit(0);
}

process.stderr.write("Unexpected fake-herdr command: " + argv.join(" ") + "\\n");
process.exit(2);
`,
  );
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("WP-5 V1.2 Multi-Engine Supervisor & Cross-Vendor Delivery Integration", () => {
  it("Test 1: routes all 4 new engines (codex, claude/zcode, acp, herdr) through ask-suspend zero-process idle -> answerCard same-session resume -> done", async () => {
    const root = makeTempDir("autoloop-wp5-t1-");
    const autoloopHome = path.join(root, "home");
    const workspaceDir = path.join(root, "workspace");
    mkdirSync(workspaceDir, { recursive: true });

    const codexTurns = path.join(root, "codex-turns.json");
    const codexRecords = path.join(root, "codex-records.jsonl");
    writeFileSync(
      codexTurns,
      JSON.stringify({
        turn: 0,
        turns: [
          {
            threadId: "thread_codex_v12_01",
            text: [
              "已定位数据库索引变更，请确认是否执行迁移",
              "",
              "```agent-autoloop",
              JSON.stringify({
                ask: [
                  {
                    key: "codex-db-migrate",
                    title: "Codex 索引迁移审批",
                    text: "是否为 orders 表创建并发索引？",
                    options: ["批准执行", "暂缓"],
                    recommend: 0,
                    about: "Codex 轮次请示",
                  },
                ],
              }),
              "```",
            ].join("\n"),
          },
          {
            threadId: "thread_codex_v12_01",
            text: [
              "已按批红在原 Codex 会话完成索引迁移",
              "",
              "```agent-autoloop",
              JSON.stringify({
                notice: [
                  {
                    key: "codex-done",
                    title: "Codex 迁移完成",
                    text: "索引已生效",
                    fyi: true,
                  },
                ],
              }),
              "```",
            ].join("\n"),
          },
        ],
      }),
      "utf8",
    );
    const fakeCodex = createScriptedCodex(root, codexTurns, codexRecords);

    const zcodeTurns = path.join(root, "zcode-turns.json");
    const zcodeRecords = path.join(root, "zcode-records.jsonl");
    writeFileSync(
      zcodeTurns,
      JSON.stringify({
        turn: 0,
        turns: [
          {
            sessionId: "sess_zcode_v12_02",
            text: [
              "ZCode 已准备好灰度发布方案，等待批示",
              "",
              "```agent-autoloop",
              JSON.stringify({
                ask: [
                  {
                    key: "zcode-canary",
                    title: "ZCode 灰度审批",
                    text: "是否切流 5% 到新节点？",
                    options: ["同意切流", "拒绝"],
                    recommend: 0,
                    about: "ZCode 灰度确认",
                  },
                ],
              }),
              "```",
            ].join("\n"),
          },
          {
            sessionId: "sess_zcode_v12_02",
            text: "已按批示在原 ZCode 会话完成 5% 灰度切流",
          },
        ],
      }),
      "utf8",
    );
    const fakeZcode = createScriptedClaude(
      root,
      "fake-zcode.mjs",
      zcodeTurns,
      zcodeRecords,
    );

    const acpTurns = path.join(root, "acp-turns.json");
    const acpRecords = path.join(root, "acp-records.jsonl");
    writeFileSync(
      acpTurns,
      JSON.stringify({
        turn: 0,
        turns: [
          {
            sessionId: "acp_sess_v12_03",
            text: [
              "OpenCode ACP 已完成补丁验证，请示是否推送分支",
              "",
              "```agent-autoloop",
              JSON.stringify({
                ask: [
                  {
                    key: "acp-push",
                    title: "ACP 推送审批",
                    text: "是否推送修复分支？",
                    options: ["批准推送", "取消"],
                    recommend: 0,
                    about: "ACP 请示",
                  },
                ],
              }),
              "```",
            ].join("\n"),
          },
          {
            sessionId: "acp_sess_v12_03",
            text: "已在原 ACP 会话通过 session/load 续接完成推送",
          },
        ],
      }),
      "utf8",
    );
    const fakeOpencodeAcp = createScriptedAcpServer(root, acpTurns, acpRecords);

    const herdrTurns = path.join(root, "herdr-turns.json");
    const herdrRecords = path.join(root, "herdr-records.jsonl");
    writeFileSync(
      herdrTurns,
      JSON.stringify({
        turn: 0,
        turns: [
          {
            text: [
              "Herdr 窗格已复现问题，请确认是否重启 worker",
              "",
              "```agent-autoloop",
              JSON.stringify({
                ask: [
                  {
                    key: "herdr-restart",
                    title: "Herdr 重启确认",
                    text: "是否重启目标队列消费者？",
                    options: ["确认重启", "跳过"],
                    recommend: 0,
                    about: "Herdr 窗格请示",
                  },
                ],
              }),
              "```",
            ].join("\n"),
          },
          {
            text: "已在原 Herdr 窗格 w1:p1 完成重启并验证恢复",
          },
        ],
      }),
      "utf8",
    );
    const fakeHerdr = createScriptedHerdr(
      root,
      workspaceDir,
      herdrTurns,
      herdrRecords,
    );

    const runtimeErrors: unknown[] = [];
    const runtime = new HubRuntime({
      autoloopHome,
      enableSupervisor: true,
      capacity: 4,
      pollIntervalMs: 30,
      killGraceMs: 80,
      postResultGraceMs: 80,
      codexBin: fakeCodex,
      herdrBin: fakeHerdr,
      baseEnv: {
        ...process.env,
        AUTOLOOP_OWNER_TOKEN: "top-secret-owner-token-must-strip",
        ANTIGRAVITY_SIDECAR_UI_TOKEN: "top-secret-ui-token-must-strip",
      },
      notifierOptions: { silent: true },
      onError: (err) => runtimeErrors.push(err),
    });

    try {
      const config: RulesConfig = {
        timezone: "UTC",
        askFirst: ["rm -rf", "codex-db-migrate", "zcode-canary", "acp-push"],
        sources: {
          ops: { name: "Ops Bus" },
        },
        agents: {
          "codex-eng": {
            name: "Codex Engineer",
            runner: "codex",
            model: "gpt-5.4",
            access: "edit",
          },
          "zcode-eng": {
            name: "ZCode Engineer",
            runner: "claude",
            command: [fakeZcode],
            model: "glm-5",
            access: "edit",
          },
          "acp-eng": {
            name: "OpenCode ACP",
            runner: "acp",
            command: [process.execPath, fakeOpencodeAcp],
            model: "qwen3-coder-plus",
            access: "edit",
          },
          "herdr-eng": {
            name: "Herdr Pane Codex",
            runner: "herdr",
            target: "kind:codex",
            access: "edit",
          },
        },
        rules: [
          {
            name: "rule-codex",
            when: { source: "ops", types: ["task.codex"] },
            to: "codex-eng",
            cwd: workspaceDir,
          },
          {
            name: "rule-claude",
            when: { source: "ops", types: ["task.claude"] },
            to: "zcode-eng",
            cwd: workspaceDir,
          },
          {
            name: "rule-acp",
            when: { source: "ops", types: ["task.acp"] },
            to: "acp-eng",
            cwd: workspaceDir,
          },
          {
            name: "rule-herdr",
            when: { source: "ops", types: ["task.herdr"] },
            to: "herdr-eng",
            cwd: workspaceDir,
          },
        ],
      };

      runtime.configureRules(config);
      runtime.start();

      for (const kind of ["codex", "claude", "acp", "herdr"] as const) {
        runtime.ingestEvent("ops", {
          id: `evt-${kind}-1`,
          type: `task.${kind}`,
          subject: `item-${kind}`,
          summary: `UNTRUSTED_SUMMARY_${kind.toUpperCase()}`,
          detail: `UNTRUSTED_DETAIL_${kind.toUpperCase()}`,
        });
      }

      // Wait for all 4 initial runs to finish with open ask cards and 0 active runs
      const round1State = await waitUntil(
        "4 open ask cards & 0 active runs",
        () => {
          const st = runtime.getState();
          const openAsks = st.cards.filter(
            (c) => c.kind === "ask" && c.status === "open",
          );
          const allDone =
            st.runs.length === 4 && st.runs.every((r) => r.status === "done");
          const zeroActive = runtime.supervisor!.activeRuns().length === 0;
          return openAsks.length === 4 && allDone && zeroActive ? st : null;
        },
      );

      // Verify exact session IDs persisted on Round 1 runs
      const runByRule = new Map(round1State.runs.map((r) => [r.rule, r]));
      assert.equal(runByRule.get("rule-codex")?.session, "thread_codex_v12_01");
      assert.equal(runByRule.get("rule-claude")?.session, "sess_zcode_v12_02");
      assert.equal(runByRule.get("rule-acp")?.session, "acp_sess_v12_03");
      assert.equal(runByRule.get("rule-herdr")?.session, "herdr:w1:p1");

      // Verify zero surviving child processes while suspended waiting for human decision
      const r1Codex = readJsonl<{
        pid: number;
        stdinText: string;
        ownerToken: string | null;
      }>(codexRecords);
      const r1Zcode = readJsonl<{
        pid: number;
        stdinText: string;
        ownerToken: string | null;
      }>(zcodeRecords);
      const r1Acp = readJsonl<{
        pid: number;
        promptText: string;
        ownerToken: string | null;
      }>(acpRecords);
      const r1Herdr = readJsonl<{
        pid: number;
        promptText: string;
        ownerToken: string | null;
      }>(herdrRecords);
      assert.equal(r1Codex.length, 1);
      assert.equal(r1Zcode.length, 1);
      assert.equal(r1Acp.length, 1);
      assert.equal(r1Herdr.length, 1);

      await waitUntil("all Round 1 child processes reaped", () =>
        !isProcessAlive(r1Codex[0]!.pid) &&
        !isProcessAlive(r1Zcode[0]!.pid) &&
        !isProcessAlive(r1Acp[0]!.pid) &&
        !isProcessAlive(r1Herdr[0]!.pid)
          ? true
          : null,
      );

      // Verify strict instruction-data separation & secret stripping across all 4 engines
      assert.equal(
        r1Codex[0]!.stdinText.includes("UNTRUSTED_SUMMARY_CODEX"),
        false,
      );
      assert.equal(
        r1Zcode[0]!.stdinText.includes("UNTRUSTED_DETAIL_CLAUDE"),
        false,
      );
      assert.equal(
        r1Acp[0]!.promptText.includes("UNTRUSTED_SUMMARY_ACP"),
        false,
      );
      assert.equal(
        r1Herdr[0]!.promptText.includes("UNTRUSTED_DETAIL_HERDR"),
        false,
      );
      assert.equal(r1Codex[0]!.ownerToken, null);
      assert.equal(r1Zcode[0]!.ownerToken, null);
      assert.equal(r1Acp[0]!.ownerToken, null);
      assert.equal(r1Herdr[0]!.ownerToken, null);

      // Human approves all 4 open ask cards -> must resume each original session!
      for (const card of round1State.cards) {
        if (card.kind === "ask" && card.status === "open") {
          runtime.answerCard({ card: card.card, choice: 0 });
        }
      }

      const round2State = await waitUntil(
        "all 8 runs done & 0 active runs",
        () => {
          const st = runtime.getState();
          const doneCount = st.runs.filter((r) => r.status === "done").length;
          const zeroActive = runtime.supervisor!.activeRuns().length === 0;
          return st.runs.length === 8 && doneCount === 8 && zeroActive
            ? st
            : null;
        },
      );

      // Verify Round 2 invoked each engine with its exact original session ID and approvedKeys
      const r2Codex = readJsonl<{
        resumedThread: string | null;
        guardJson: { approvedKeys: string[] };
      }>(codexRecords);
      const r2Zcode = readJsonl<{
        resumedSession: string | null;
        guardJson: { approvedKeys: string[] };
      }>(zcodeRecords);
      const r2Acp = readJsonl<{
        loadedSessionId: string | null;
        guardJson: { approvedKeys: string[] };
      }>(acpRecords);
      const r2Herdr = readJsonl<{ targetPane: string; promptText: string }>(
        herdrRecords,
      );

      assert.equal(r2Codex.length, 2);
      assert.equal(r2Codex[1]!.resumedThread, "thread_codex_v12_01");
      assert.deepEqual(r2Codex[1]!.guardJson.approvedKeys, [
        "codex-db-migrate",
      ]);

      assert.equal(r2Zcode.length, 2);
      assert.equal(r2Zcode[1]!.resumedSession, "sess_zcode_v12_02");
      assert.deepEqual(r2Zcode[1]!.guardJson.approvedKeys, ["zcode-canary"]);

      assert.equal(r2Acp.length, 2);
      assert.equal(r2Acp[1]!.loadedSessionId, "acp_sess_v12_03");
      assert.deepEqual(r2Acp[1]!.guardJson.approvedKeys, ["acp-push"]);

      assert.equal(r2Herdr.length, 2);
      assert.equal(r2Herdr[1]!.targetPane, "w1:p1");
      assert.match(r2Herdr[1]!.promptText, /续接会话：herdr:w1:p1/);

      // All 4 ask cards transitioned from open -> done after continuation run completed
      assert.equal(
        round2State.cards.filter((c) => c.kind === "ask" && c.status === "open")
          .length,
        0,
      );
      assertInvariants(runtime.store.view);
      assert.deepEqual(runtimeErrors, []);
    } finally {
      await runtime.close();
    }
  });

  it("Test 2: repairs malformed receipts in-place on original codex/acp sessions and degrades via discardReceipt after 2 failed repairs without re-running side effects", async () => {
    const root = makeTempDir("autoloop-wp5-t2-");
    const autoloopHome = path.join(root, "home");
    const workspaceDir = path.join(root, "workspace");
    mkdirSync(workspaceDir, { recursive: true });

    // 1) Codex: Turn 0 produces malformed JSON in agent-autoloop fence -> Turn 1 receives repairPrompt on same thread & fixes it!
    const codexTurns = path.join(root, "codex-repair-turns.json");
    const codexRecords = path.join(root, "codex-repair-records.jsonl");
    writeFileSync(
      codexTurns,
      JSON.stringify({
        turn: 0,
        turns: [
          {
            threadId: "codex-repair-thread-77",
            text: '已完成日志归档\n\n```agent-autoloop\n{"notice": [BROKEN_JSON}\n```',
            usage: {
              input_tokens: 100,
              cached_input_tokens: 20,
              output_tokens: 30,
            },
          },
          {
            threadId: "codex-repair-thread-77",
            text: [
              "已完成日志归档",
              "",
              "```agent-autoloop",
              JSON.stringify({
                notice: [
                  {
                    key: "archive-ok",
                    title: "日志归档完成",
                    text: "原地修复回执成功",
                    fyi: true,
                  },
                ],
              }),
              "```",
            ].join("\n"),
            usage: {
              input_tokens: 50,
              cached_input_tokens: 40,
              output_tokens: 20,
            },
          },
        ],
      }),
      "utf8",
    );
    const fakeCodex = createScriptedCodex(root, codexTurns, codexRecords);

    // 2) ACP: Turn 0 completes business ("已完成账单对账") with broken receipt, and Turns 1 & 2 STILL fail to repair -> must hit discardReceipt (outcome=done + warning notice, NOT failed!)
    const acpTurns = path.join(root, "acp-discard-turns.json");
    const acpRecords = path.join(root, "acp-discard-records.jsonl");
    writeFileSync(
      acpTurns,
      JSON.stringify({
        turn: 0,
        turns: [
          {
            sessionId: "acp-discard-sess-99",
            text: "已完成账单对账并发送回执\n\n```agent-autoloop\n{unclosed_broken_json\n```",
          },
          {
            sessionId: "acp-discard-sess-99",
            text: "重写尝试 1\n\n```agent-autoloop\n{still_broken_1\n```",
          },
          {
            sessionId: "acp-discard-sess-99",
            text: "重写尝试 2\n\n```agent-autoloop\n{still_broken_2\n```",
          },
        ],
      }),
      "utf8",
    );
    const fakeAcp = createScriptedAcpServer(root, acpTurns, acpRecords);

    const runtime = new HubRuntime({
      autoloopHome,
      enableSupervisor: true,
      capacity: 2,
      pollIntervalMs: 30,
      killGraceMs: 80,
      postResultGraceMs: 80,
      codexBin: fakeCodex,
      notifierOptions: { silent: true },
    });

    try {
      runtime.configureRules({
        timezone: "UTC",
        askFirst: [],
        sources: { ops: { name: "Ops" } },
        agents: {
          "codex-agent": {
            name: "Codex Repair",
            runner: "codex",
            access: "edit",
          },
          "acp-agent": {
            name: "ACP Discard",
            runner: "acp",
            command: [process.execPath, fakeAcp],
            access: "edit",
          },
        },
        rules: [
          {
            name: "codex-repair-rule",
            when: { source: "ops", types: ["codex.run"] },
            to: "codex-agent",
            cwd: workspaceDir,
          },
          {
            name: "acp-discard-rule",
            when: { source: "ops", types: ["acp.run"] },
            to: "acp-agent",
            cwd: workspaceDir,
          },
        ],
      });
      runtime.start();

      runtime.ingestEvent("ops", { id: "e-codex-rep", type: "codex.run" });
      runtime.ingestEvent("ops", { id: "e-acp-disc", type: "acp.run" });

      const finalState = await waitUntil("both runs settled as done", () => {
        const st = runtime.getState();
        const doneRuns = st.runs.filter((r) => r.status === "done");
        return st.runs.length === 2 &&
          doneRuns.length === 2 &&
          runtime.supervisor!.activeRuns().length === 0
          ? st
          : null;
      });

      // Verify Codex in-place repair: 2 invocations in single run attempt=1, second used `resume codex-repair-thread-77` + repairPrompt
      const codexRun = finalState.runs.find(
        (r) => r.rule === "codex-repair-rule",
      )!;
      assert.equal(codexRun.status, "done");
      assert.equal(codexRun.attempt, 1);
      assert.equal(codexRun.session, "codex-repair-thread-77");
      assert.deepEqual(codexRun.usage, {
        input: 150,
        cached: 60,
        output: 50,
      });

      const codexCalls = readJsonl<{
        resumedThread: string | null;
        stdinText: string;
      }>(codexRecords);
      assert.equal(codexCalls.length, 2);
      assert.equal(codexCalls[0]!.resumedThread, null);
      assert.equal(codexCalls[1]!.resumedThread, "codex-repair-thread-77");
      assert.match(
        codexCalls[1]!.stdinText,
        /你的上一条回复中的回执格式存在问题/,
      );

      const archiveNotice = [
        ...finalState.cards,
        ...finalState.recentCards,
      ].find((c) => c.title === "日志归档完成");
      assert.ok(archiveNotice, "Expected repaired Codex notice card");

      // Verify ACP discardReceipt safety net: 3 invocations (1 initial + 2 repairs on same session), attempt=1, preserved outcome="done" + warning notice card!
      const acpRun = finalState.runs.find(
        (r) => r.rule === "acp-discard-rule",
      )!;
      assert.equal(acpRun.status, "done");
      assert.equal(acpRun.attempt, 1);
      assert.equal(acpRun.session, "acp-discard-sess-99");
      assert.equal(acpRun.summary, "已完成账单对账并发送回执");

      const acpCalls = readJsonl<{
        loadedSessionId: string | null;
        promptText: string;
      }>(acpRecords);
      assert.equal(acpCalls.length, 3);
      assert.equal(acpCalls[0]!.loadedSessionId, null);
      assert.equal(acpCalls[1]!.loadedSessionId, "acp-discard-sess-99");
      assert.equal(acpCalls[2]!.loadedSessionId, "acp-discard-sess-99");
      assert.match(
        acpCalls[1]!.promptText,
        /你的上一条回复中的回执格式存在问题/,
      );

      const discardWarning = finalState.cards.find(
        (c) => c.title === "回执格式损坏已忽略",
      );
      assert.ok(
        discardWarning,
        "Expected discardReceipt warning notice card after 2 failed repairs",
      );
      assertInvariants(runtime.store.view);
    } finally {
      await runtime.close();
    }
  });

  it("Test 2b: repairs malformed receipts on claude & herdr sessions, and cleanly downgrades stale codex session before start", async () => {
    const root = makeTempDir("autoloop-wp5-t2b-");
    const autoloopHome = path.join(root, "home");
    const workspaceDir = path.join(root, "workspace");
    mkdirSync(workspaceDir, { recursive: true });

    // Claude: Turn 0 broken receipt -> Turn 1 repaired on same session
    const claudeTurns = path.join(root, "claude-rep-turns.json");
    const claudeRecords = path.join(root, "claude-rep-records.jsonl");
    writeFileSync(
      claudeTurns,
      JSON.stringify({
        turn: 0,
        turns: [
          {
            sessionId: "claude-rep-sess-1",
            text: '已完成配置审计\n\n```agent-autoloop\n{"notice": [INVALID\n```',
          },
          {
            sessionId: "claude-rep-sess-1",
            text: '已完成配置审计\n\n```agent-autoloop\n{"notice":[{"key":"claude-rep-ok","title":"Claude 修复完成","text":"OK","fyi":true}]}\n```',
          },
        ],
      }),
      "utf8",
    );
    const fakeClaude = createScriptedClaude(
      root,
      "fake-claude-rep.mjs",
      claudeTurns,
      claudeRecords,
    );

    // Herdr: Turn 0 broken receipt -> Turn 1 repaired on same herdr:w1:p1 session
    const herdrTurns = path.join(root, "herdr-rep-turns.json");
    const herdrRecords = path.join(root, "herdr-rep-records.jsonl");
    writeFileSync(
      herdrTurns,
      JSON.stringify({
        turn: 0,
        turns: [
          {
            text: "没事可做：窗格巡检正常\n\n```agent-autoloop\n{bad_herdr_json\n```",
          },
          {
            text: "没事可做：窗格巡检正常",
          },
        ],
      }),
      "utf8",
    );
    const fakeHerdr = createScriptedHerdr(
      root,
      workspaceDir,
      herdrTurns,
      herdrRecords,
    );

    // Codex stale session downgrade: Run 1 establishes session "codex-stale-old"; Run 2 (resume=true) fails before start on "codex-stale-old", downgrades to fresh session "codex-fresh-new"
    const codexTurns = path.join(root, "codex-stale-turns.json");
    const codexRecords = path.join(root, "codex-stale-records.jsonl");
    writeFileSync(
      codexTurns,
      JSON.stringify({
        turn: 0,
        turns: [
          { threadId: "codex-stale-old", text: "首轮巡检完成" },
          {
            failBeforeStart: true,
            exitCode: 1,
            stderr: "thread codex-stale-old expired",
          },
          { threadId: "codex-fresh-new", text: "降级新开会话巡检完成" },
        ],
      }),
      "utf8",
    );
    const fakeCodex = createScriptedCodex(root, codexTurns, codexRecords);

    const runtime = new HubRuntime({
      autoloopHome,
      enableSupervisor: true,
      capacity: 3,
      pollIntervalMs: 30,
      killGraceMs: 80,
      postResultGraceMs: 80,
      codexBin: fakeCodex,
      claudeBin: fakeClaude,
      herdrBin: fakeHerdr,
      notifierOptions: { silent: true },
    });

    try {
      runtime.configureRules({
        timezone: "UTC",
        askFirst: [],
        sources: { ops: { name: "Ops" } },
        agents: {
          "claude-a": { name: "Claude A", runner: "claude", access: "read" },
          "herdr-a": {
            name: "Herdr A",
            runner: "herdr",
            target: "w1:p1",
            access: "edit",
          },
          "codex-a": { name: "Codex A", runner: "codex", access: "edit" },
        },
        rules: [
          {
            name: "r-claude",
            when: { source: "ops", types: ["t.claude"] },
            to: "claude-a",
            cwd: workspaceDir,
          },
          {
            name: "r-herdr",
            when: { source: "ops", types: ["t.herdr"] },
            to: "herdr-a",
            cwd: workspaceDir,
          },
          {
            name: "r-codex-resume",
            when: { source: "ops", types: ["t.codex"] },
            to: "codex-a",
            cwd: workspaceDir,
            resume: true,
          },
        ],
      });
      runtime.start();

      runtime.ingestEvent("ops", { id: "c1", type: "t.claude" });
      runtime.ingestEvent("ops", { id: "h1", type: "t.herdr" });
      runtime.ingestEvent("ops", { id: "x1", type: "t.codex" });

      await waitUntil("first wave settled", () => {
        const st = runtime.getState();
        return st.runs.length === 3 &&
          st.runs.every((r) => r.status === "done" || r.status === "nothing") &&
          runtime.supervisor!.activeRuns().length === 0
          ? st
          : null;
      });

      // Trigger second event on r-codex-resume -> attempts resume "codex-stale-old" -> fails before start -> downgrades to fresh session!
      runtime.ingestEvent("ops", { id: "x2", type: "t.codex" });

      const finalSt = await waitUntil("downgraded codex run settled", () => {
        const st = runtime.getState();
        return st.runs.length === 4 &&
          st.runs.every((r) => r.status === "done" || r.status === "nothing") &&
          runtime.supervisor!.activeRuns().length === 0
          ? st
          : null;
      });

      const claudeCalls = readJsonl<{ resumedSession: string | null }>(
        claudeRecords,
      );
      assert.equal(claudeCalls.length, 2);
      assert.equal(claudeCalls[1]!.resumedSession, "claude-rep-sess-1");

      const herdrCalls = readJsonl<{ targetPane: string; promptText: string }>(
        herdrRecords,
      );
      assert.equal(herdrCalls.length, 2);
      assert.equal(herdrCalls[1]!.targetPane, "w1:p1");
      assert.match(
        herdrCalls[1]!.promptText,
        /你的上一条回复中的回执格式存在问题/,
      );

      const codexCalls = readJsonl<{ resumedThread: string | null }>(
        codexRecords,
      );
      assert.equal(codexCalls.length, 3);
      assert.equal(codexCalls[0]!.resumedThread, null);
      assert.equal(codexCalls[1]!.resumedThread, "codex-stale-old");
      assert.equal(codexCalls[2]!.resumedThread, null);

      const resumedRun = finalSt.runs.find(
        (r) => r.rule === "r-codex-resume" && r.session === "codex-fresh-new",
      );
      assert.ok(resumedRun, "Expected downgraded fresh codex session");
      assertInvariants(runtime.store.view);
    } finally {
      await runtime.close();
    }
  });

  it("Test 2c: Supervisor preserves 'herdr:w3:p1' on backoff retry when w3:p1 is temporarily working, and downgrades to idle pane when w3:p99 is closed", async () => {
    const root = makeTempDir("autoloop-wp5-t2c-");
    const autoloopHome = path.join(root, "home");
    const workspaceDir = path.join(root, "workspace");
    mkdirSync(workspaceDir, { recursive: true });

    const herdrStateFile = path.join(root, "herdr-busy-state.json");
    const herdrRecordsFile = path.join(root, "herdr-busy-records.jsonl");
    writeFileSync(
      herdrStateFile,
      JSON.stringify(
        {
          panes: [
            {
              pane_id: "w3:p1",
              workspace_id: "w3",
              cwd: workspaceDir,
              foreground_cwd: workspaceDir,
              agent: "claude",
              agent_name: "primary-claude",
              agent_status: "idle",
            },
            {
              pane_id: "w1:p1",
              workspace_id: "w1",
              cwd: "/other",
              foreground_cwd: "/other",
              agent: "claude",
              agent_name: "backup-claude",
              agent_status: "idle",
            },
          ],
          agents: [
            {
              pane_id: "w3:p1",
              workspace_id: "w3",
              name: "primary-claude",
              agent: "claude",
              agent_status: "idle",
              cwd: workspaceDir,
              foreground_cwd: workspaceDir,
            },
            {
              pane_id: "w1:p1",
              workspace_id: "w1",
              name: "backup-claude",
              agent: "claude",
              agent_status: "idle",
              cwd: "/other",
              foreground_cwd: "/other",
            },
          ],
          replyText: "已在目标窗格完成处理",
        },
        null,
        2,
      ),
      "utf8",
    );

    const fakeHerdr = makeExecutableScript(
      root,
      "fake-herdr-busy.mjs",
      `
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const group = argv[0] ?? "";
const sub = argv[1] ?? "";
const state = JSON.parse(readFileSync(${JSON.stringify(herdrStateFile)}, "utf8"));

if (group === "pane" && sub === "list") {
  process.stdout.write(JSON.stringify({ id: "cli:pane:list", type: "pane_list", result: { panes: state.panes } }) + "\\n");
  process.exit(0);
}
if (group === "agent" && sub === "list") {
  process.stdout.write(JSON.stringify({ id: "cli:agent:list", type: "agent_list", result: { agents: state.agents } }) + "\\n");
  process.exit(0);
}
if (group === "agent" && sub === "read") {
  process.stdout.write("claude> \\n");
  process.exit(0);
}
if (group === "agent" && sub === "prompt") {
  const targetPane = argv[2] ?? "";
  const promptText = argv[3] ?? "";
  const pathMatch = /([^\\s\`"']+herdr-handoff-attempt-\\d+\\.md)/.exec(promptText);
  if (pathMatch && pathMatch[1]) {
    mkdirSync(path.dirname(pathMatch[1]), { recursive: true });
    writeFileSync(pathMatch[1], state.replyText + " (" + targetPane + ")", "utf8");
  }
  appendFileSync(${JSON.stringify(herdrRecordsFile)}, JSON.stringify({ targetPane, promptText }) + "\\n", "utf8");
  process.stdout.write(JSON.stringify({
    id: "cli:agent:prompt",
    type: "agent_prompt",
    result: { agent: { pane_id: targetPane, agent_status: "idle" } },
  }) + "\\n");
  process.exit(0);
}
process.exit(2);
`,
    );

    let nowMs = Date.parse("2026-11-19T18:00:00.000Z");
    const runtime = new HubRuntime({
      autoloopHome,
      now: () => nowMs,
      enableSupervisor: true,
      capacity: 2,
      pollIntervalMs: 30,
      killGraceMs: 80,
      herdrBin: fakeHerdr,
      notifierOptions: { silent: true },
    });

    try {
      runtime.configureRules({
        timezone: "UTC",
        askFirst: [],
        sources: { ops: { name: "Ops" } },
        agents: {
          "herdr-claude": {
            name: "Herdr Claude",
            runner: "herdr",
            target: "kind:claude",
            access: "edit",
          },
        },
        rules: [
          {
            name: "r-herdr-session",
            when: { source: "ops", types: ["t.herdr.session"] },
            to: "herdr-claude",
            cwd: workspaceDir,
            resume: true,
          },
        ],
      });
      runtime.start();

      // Step 1: Establish session "herdr:w3:p1" on Run 1
      runtime.ingestEvent("ops", { id: "hb-1", type: "t.herdr.session" });
      await waitUntil("Run 1 done on herdr:w3:p1", () => {
        const st = runtime.getState();
        return st.runs.length === 1 &&
          st.runs[0]!.status === "done" &&
          st.runs[0]!.session === "herdr:w3:p1"
          ? st
          : null;
      });

      // Step 2: Mark w3:p1 as temporarily "working" while w1:p1 remains "idle"
      const busyState = JSON.parse(readFileSync(herdrStateFile, "utf8"));
      busyState.panes[0].agent_status = "working";
      busyState.agents[0].agent_status = "working";
      writeFileSync(herdrStateFile, JSON.stringify(busyState, null, 2), "utf8");

      nowMs += 1_000;
      runtime.ingestEvent("ops", { id: "hb-2", type: "t.herdr.session" });

      // Wait for Attempt 1 of Run 2 to settle into backoff retry ("queued" with attempt >= 1)
      const backoffState = await waitUntil(
        "Run 2 queued in backoff with herdr:w3:p1 preserved",
        () => {
          const st = runtime.getState();
          const run2 = st.runs.find((r) => r.run === 2);
          return run2 &&
            run2.status === "queued" &&
            run2.attempt >= 1 &&
            Boolean(run2.notBefore) &&
            runtime.supervisor!.activeRuns().length === 0
            ? run2
            : null;
        },
        10_000,
      );

      assert.equal(
        backoffState.session,
        "herdr:w3:p1",
        "Supervisor must preserve herdr:w3:p1 instead of wiping session: null when pane is temporarily working",
      );
      assert.equal(
        readJsonl(herdrRecordsFile).length,
        1,
        "must NOT switch to backup pane w1:p1 while w3:p1 still exists and is working",
      );

      // Step 3: w3:p1 finishes its other turn -> becomes "idle"; advance clock past backoff -> resumes w3:p1!
      busyState.panes[0].agent_status = "idle";
      busyState.agents[0].agent_status = "idle";
      writeFileSync(herdrStateFile, JSON.stringify(busyState, null, 2), "utf8");

      nowMs = Date.parse(backoffState.notBefore!) + 1_000;
      await runtime.supervisor!.kick();

      await waitUntil("Run 2 done on original pane w3:p1", () => {
        const st = runtime.getState();
        const run2 = st.runs.find((r) => r.run === 2);
        return run2 && run2.status === "done" ? run2 : null;
      });

      const callsAfterRetry = readJsonl<{ targetPane: string }>(
        herdrRecordsFile,
      );
      assert.equal(callsAfterRetry.length, 2);
      assert.equal(callsAfterRetry[1]!.targetPane, "w3:p1");

      // Step 4: User closes w3:p1 completely (simulating disappeared pane e.g. w3:p99) -> Run 3 downgrades to session: null and completes on idle w1:p1!
      busyState.panes = busyState.panes.filter(
        (p: { pane_id: string }) => p.pane_id !== "w3:p1",
      );
      busyState.agents = busyState.agents.filter(
        (a: { pane_id: string }) => a.pane_id !== "w3:p1",
      );
      writeFileSync(herdrStateFile, JSON.stringify(busyState, null, 2), "utf8");

      nowMs += 1_000;
      runtime.ingestEvent("ops", { id: "hb-3", type: "t.herdr.session" });

      const run3Done = await waitUntil(
        "Run 3 downgraded to idle pane w1:p1",
        () => {
          const st = runtime.getState();
          const run3 = st.runs.find((r) => r.run === 3);
          return run3 && run3.status === "done" ? run3 : null;
        },
      );
      assert.equal(run3Done.attempt, 1);
      assert.equal(run3Done.session, "herdr:w1:p1");

      assertInvariants(runtime.store.view);
    } finally {
      await runtime.close();
    }
  });

  it("Test 3a: cross-vendor delivery review with reviewerRunner='codex' blocks Round 1, reviews Round 2 incremental diff (prevSha..headSha) in read-only mode, checks in git worktree & merges", async () => {
    const root = makeTempDir("autoloop-wp5-t3-codex-");
    const codexTurns = path.join(root, "deliv-codex-turns.json");
    const codexRecords = path.join(root, "deliv-codex-records.jsonl");

    writeFileSync(
      codexTurns,
      JSON.stringify({
        turn: 0,
        turns: [
          {
            threadId: "codex-rev-r1",
            text: JSON.stringify({
              findings: [
                {
                  file: "src/math.ts",
                  line: 2,
                  title: "src/math.ts:2 未拦截除零导致返回 Infinity",
                  text: "当 b === 0 时 divide(a, 0) 直接返回 Infinity 污染下游结算账本",
                  how: "调用 divide(10, 0) 即可触发",
                  severity: "blocking",
                },
              ],
            }),
          },
          {
            threadId: "codex-rev-r2",
            text: JSON.stringify({ findings: [] }),
          },
        ],
      }),
      "utf8",
    );
    const fakeCodex = createScriptedCodex(root, codexTurns, codexRecords);

    const repoDir = createTempGitRepo({
      "AGENTS.md":
        "# Repo Guide\n\n## 审查必查清单\n- 严禁除零未校验直接入账。\n",
      ".autoloop/delivery.json": JSON.stringify(
        {
          baseBranch: "main",
          reviewerRunner: "codex",
          checkCommand:
            "node -e \"const fs = require('node:fs'); const s = fs.readFileSync('src/math.ts', 'utf8'); if (!s.includes('b === 0')) process.exit(1);\"",
          smokeCommand: 'node -e "process.exit(0)"',
          mergeStrategy: "merge",
        },
        null,
        2,
      ),
      "src/history.ts": "export const LEGACY_BASELINE = 1;\n",
      "src/math.ts":
        "export function divide(a: number, b: number) { return a / b; }\n",
    });

    // Create feature branch Round 1 (buggy divide + large historical file)
    git(repoDir, ["checkout", "-b", "feat/codex-review"]);
    writeRepoFile(
      repoDir,
      "src/history.ts",
      "export const LEGACY_BASELINE = 2;\nexport const EXTRA_UNTOUCHED = 'untouched-in-r2';\n",
    );
    writeRepoFile(
      repoDir,
      "src/math.ts",
      "export function divide(a: number, b: number): number {\n  return a / b;\n}\n",
    );
    git(repoDir, ["add", "."]);
    git(repoDir, ["commit", "-m", "feat: initial divide implementation"]);
    const round1Sha = git(repoDir, ["rev-parse", "HEAD"]);
    git(repoDir, ["checkout", "main"]);

    const workDir = path.join(root, "delivery-state");

    // Round 1: Codex reviewer flags blocking defect -> blocks merge!
    const r1 = await runDeliveryPipeline({
      repoDir,
      targetRef: "feat/codex-review",
      workDir,
      authorModel: "gemini-4-hydrogen-high",
      codexBin: fakeCodex,
      postResultGraceMs: 80,
    });

    assert.equal(r1.status, "changes_requested");
    assert.equal(r1.merged, false);
    assert.equal(r1.review?.round, 1);
    assert.equal(r1.review?.reviewerModel, "codex:default");
    assert.equal(r1.receipt.events?.[0]?.type, "git.review.changes_requested");

    const callsAfterR1 = readJsonl<{
      argv: string[];
      stdinText: string;
      guardJson: { access: string };
    }>(codexRecords);
    assert.equal(callsAfterR1.length, 1);
    // Must enforce -s read-only and NOT inject Antigravity internal model gemini-4-*!
    assert.equal(callsAfterR1[0]!.argv.includes("-s"), true);
    assert.equal(
      callsAfterR1[0]!.argv[callsAfterR1[0]!.argv.indexOf("-s") + 1],
      "read-only",
    );
    assert.equal(callsAfterR1[0]!.argv.includes("-m"), false);
    assert.equal(callsAfterR1[0]!.guardJson.access, "read");

    // Verify branch-decoupled SHA cache hit for same reviewerRunner, and cache MISS when switching reviewerRunner
    git(repoDir, ["branch", "feat/codex-renamed", round1Sha]);
    const ledgerFile = path.join(workDir, "review-ledger.json");
    const renamedSnap = await extractBranchSnapshot({
      repoDir,
      targetRef: "feat/codex-renamed",
      outputDir: path.join(root, "renamed-snap"),
    });
    const cachedOut = await reviewBranchSnapshot({
      snapshot: renamedSnap,
      ledgerFile,
      codexBin: fakeCodex,
    });
    assert.equal(cachedOut.cached, true);
    assert.equal(cachedOut.reviewerModel, "codex:default");
    assert.equal(readJsonl(codexRecords).length, 1);

    // Round 2: Author pushes fix commit on feat/codex-review -> incremental diff prevSha..headSha reviewed & merged!
    git(repoDir, ["checkout", "feat/codex-review"]);
    writeRepoFile(
      repoDir,
      "src/math.ts",
      "export function divide(a: number, b: number): number {\n  if (b === 0) throw new Error('division by zero');\n  return a / b;\n}\n",
    );
    git(repoDir, ["add", "src/math.ts"]);
    git(repoDir, ["commit", "-m", "fix: guard division by zero"]);
    const round2Sha = git(repoDir, ["rev-parse", "HEAD"]);
    git(repoDir, ["checkout", "main"]);

    const r2 = await runDeliveryPipeline({
      repoDir,
      targetRef: "feat/codex-review",
      workDir,
      authorModel: "gemini-4-hydrogen-high",
      codexBin: fakeCodex,
      postResultGraceMs: 80,
    });

    assert.equal(r2.status, "merged");
    assert.equal(r2.merged, true);
    assert.equal(r2.review?.round, 2);
    assert.equal(r2.review?.incremental, true);
    assert.equal(r2.review?.incrementalFromSha, round1Sha);
    assert.equal(r2.review?.reviewerModel, "codex:default");

    const callsAfterR2 = readJsonl<{
      argv: string[];
      stdinText: string;
      contextPath: string;
    }>(codexRecords);
    assert.equal(callsAfterR2.length, 2);
    assert.match(callsAfterR2[1]!.stdinText, /定向增量复审模式/);
    assert.match(callsAfterR2[1]!.stdinText, /incremental-diff\.patch/);
    assert.match(
      callsAfterR2[1]!.stdinText,
      new RegExp(`${round1Sha.slice(0, 12)}\\.\\.${round2Sha.slice(0, 12)}`),
    );
    assert.match(callsAfterR2[1]!.contextPath, /incremental-diff\.patch$/);

    // Main branch now contains the merged fix and worktrees were cleaned up
    const mainMath = readFileSync(path.join(repoDir, "src", "math.ts"), "utf8");
    assert.match(mainMath, /division by zero/);
    const worktreeList = git(repoDir, ["worktree", "list"]);
    assert.equal(worktreeList.split("\n").length, 1);

    const ledger = readReviewLedger(ledgerFile);
    assert.equal(ledger.entries.length, 2);
    assert.equal(ledger.entries[1]!.incrementalFromSha, round1Sha);
  });

  it("Test 3b: cross-vendor delivery review with reviewerRunner='acp' (and 'claude') enforces protocol-level read-only gate, Round 1 blocking -> Round 2 incremental approval & HubRuntime deliveryRunner integration", async () => {
    const root = makeTempDir("autoloop-wp5-t3-acp-");
    const acpTurns = path.join(root, "deliv-acp-turns.json");
    const acpRecords = path.join(root, "deliv-acp-records.jsonl");
    const fakeAcpReviewer = createScriptedAcpServer(root, acpTurns, acpRecords);

    const repoDir = createTempGitRepo({
      "AGENTS.md": "# Guide\n\n## 审查要点\n- 严禁空密码校验放行。\n",
      ".autoloop/delivery.json": JSON.stringify(
        {
          baseBranch: "main",
          reviewerRunner: "acp",
          reviewerCommand: [process.execPath, fakeAcpReviewer],
          reviewerModels: {
            default: "qwen3-coder-plus",
          },
          checkCommand:
            "node -e \"const fs = require('node:fs'); if (!fs.readFileSync('src/auth.ts', 'utf8').includes('token.length >= 16')) process.exit(1);\"",
          mergeStrategy: "merge",
        },
        null,
        2,
      ),
      "src/auth.ts":
        "export function verify(token: string) { return Boolean(token); }\n",
    });

    writeFileSync(
      acpTurns,
      JSON.stringify({
        turn: 0,
        turns: [
          {
            sessionId: "acp-rev-1",
            // Probe write permission during review -> must be rejected by ACP protocol read-only gate!
            probeWriteFile: path.join(repoDir, "src", "auth.ts"),
            text: [
              "```json",
              JSON.stringify({
                findings: [
                  {
                    file: "src/auth.ts",
                    line: 2,
                    title: "src/auth.ts:2 短口令未拦截",
                    text: "仅判断 token.length > 0 允许 1 字符弱口令通过鉴权",
                    how: "传入 verify('a') 即返回 true",
                    severity: "blocking",
                  },
                ],
              }),
              "```",
            ].join("\n"),
          },
          {
            sessionId: "acp-rev-2",
            text: '```json\n{"findings":[]}\n```',
          },
        ],
      }),
      "utf8",
    );

    // Branch commit 1 (weak check)
    git(repoDir, ["checkout", "-b", "feat/acp-auth"]);
    writeRepoFile(
      repoDir,
      "src/auth.ts",
      "export function verify(token: string): boolean {\n  return token.length > 0;\n}\n",
    );
    git(repoDir, ["add", "."]);
    git(repoDir, ["commit", "-m", "feat: basic token check"]);
    const sha1 = git(repoDir, ["rev-parse", "HEAD"]);
    git(repoDir, ["checkout", "main"]);

    const autoloopHome = path.join(root, "hub-home");
    const runtime = new HubRuntime({
      autoloopHome,
      enableSupervisor: true,
      pollIntervalMs: 30,
      deliveryRunner: createDeliveryRunner({
        repoDir,
        postResultGraceMs: 80,
      }),
      notifierOptions: { silent: true },
    });

    try {
      runtime.configureRules({
        timezone: "UTC",
        askFirst: [],
        sources: { git: { name: "Git Hook" } },
        agents: {
          "pr-deliverer": {
            name: "PR Deliverer",
            runner: "delivery",
            access: "edit",
          },
        },
        rules: [
          {
            name: "deliver-branch",
            when: { source: "git", types: ["git.branch.ready"] },
            to: "pr-deliverer",
            cwd: repoDir,
            emits: {
              source: "git",
              types: [
                "git.review.changes_requested",
                "git.delivery.check_failed",
                "git.delivery.conflict",
                "git.delivery.smoke_failed",
              ],
            },
          },
        ],
      });
      runtime.start();

      // Round 1 via HubRuntime + deliveryRunner
      runtime.ingestEvent("git", {
        id: "ready-1",
        type: "git.branch.ready",
        subject: "feat/acp-auth",
      });

      const afterR1 = await waitUntil("Round 1 delivery run done", () => {
        const st = runtime.getState();
        return st.runs.length === 1 &&
          st.runs[0]!.status === "done" &&
          runtime.supervisor!.activeRuns().length === 0
          ? st
          : null;
      });
      assert.match(afterR1.runs[0]!.summary ?? "", /acp:.*:qwen3-coder-plus/);

      const acpCallsR1 = readJsonl<{
        guardJson: { access: string };
        writePermissionOutcome: { outcome?: string; optionId?: string } | null;
      }>(acpRecords);
      assert.equal(acpCallsR1.length, 1);
      assert.equal(acpCallsR1[0]!.guardJson.access, "read");
      // Protocol-level read-only gate MUST reject write_file tool call with optionId "deny"!
      assert.deepEqual(acpCallsR1[0]!.writePermissionOutcome, {
        outcome: "selected",
        optionId: "deny",
      });

      // Push Round 2 fix on feat/acp-auth -> emit ready-2 -> incremental review approves & merges!
      git(repoDir, ["checkout", "feat/acp-auth"]);
      writeRepoFile(
        repoDir,
        "src/auth.ts",
        "export function verify(token: string): boolean {\n  return token.length >= 16;\n}\n",
      );
      git(repoDir, ["add", "src/auth.ts"]);
      git(repoDir, ["commit", "-m", "fix: enforce >=16 char token"]);
      const sha2 = git(repoDir, ["rev-parse", "HEAD"]);
      git(repoDir, ["checkout", "main"]);

      runtime.ingestEvent("git", {
        id: "ready-2",
        type: "git.branch.ready",
        subject: "feat/acp-auth",
      });

      const afterR2 = await waitUntil("Round 2 delivery run merged", () => {
        const st = runtime.getState();
        return st.runs.length === 2 &&
          st.runs.every((r) => r.status === "done") &&
          runtime.supervisor!.activeRuns().length === 0
          ? st
          : null;
      });

      const r2Summary = afterR2.runs.find((r) => r.run === 2)?.summary ?? "";
      assert.match(r2Summary, /交付完成：feat\/acp-auth/);

      const acpCallsR2 = readJsonl<{ promptText: string }>(acpRecords);
      assert.equal(acpCallsR2.length, 2);
      assert.match(acpCallsR2[1]!.promptText, /定向增量复审模式/);
      assert.match(
        acpCallsR2[1]!.promptText,
        new RegExp(`${sha1.slice(0, 12)}\\.\\.${sha2.slice(0, 12)}`),
      );

      // Verify switching reviewerCommand from opencode ACP -> kimi ACP with the SAME reviewerModels.default ("qwen3-coder-plus") invalidates ledger cache!
      const kimiAcpTurns = path.join(root, "deliv-kimi-acp-turns.json");
      const kimiAcpRecords = path.join(root, "deliv-kimi-acp-records.jsonl");
      writeFileSync(
        kimiAcpTurns,
        JSON.stringify({
          turn: 0,
          turns: [{ sessionId: "kimi-acp-rev-1", text: '{"findings":[]}' }],
        }),
        "utf8",
      );
      const fakeKimiAcp = createScriptedAcpServer(
        root,
        kimiAcpTurns,
        kimiAcpRecords,
      );

      const kimiAcpSnap = await extractBranchSnapshot({
        repoDir,
        targetRef: "feat/acp-auth",
        outputDir: path.join(root, "kimi-acp-snap"),
      });
      kimiAcpSnap.config.reviewerRunner = "acp";
      kimiAcpSnap.config.reviewerCommand = [
        process.execPath,
        fakeKimiAcp,
        "kimi",
        "acp",
      ];
      kimiAcpSnap.config.reviewerModels = {
        default: "qwen3-coder-plus",
      };

      const kimiAcpReview = await reviewBranchSnapshot({
        snapshot: kimiAcpSnap,
        ledgerFile: path.join(autoloopHome, "delivery", "review-ledger.json"),
        postResultGraceMs: 80,
      });
      assert.equal(
        kimiAcpReview.cached,
        false,
        "switching reviewerCommand with identical reviewerModels.default must miss cache and run fresh review",
      );
      assert.equal(kimiAcpReview.status, "approved");
      assert.match(
        kimiAcpReview.reviewerModel,
        /^acp:.*kimi acp:qwen3-coder-plus$/,
      );
      assert.equal(readJsonl(kimiAcpRecords).length, 1);

      // Re-running with identical reviewerCommand + reviewerModels.default hits cache!
      const kimiAcpCached = await reviewBranchSnapshot({
        snapshot: kimiAcpSnap,
        ledgerFile: path.join(autoloopHome, "delivery", "review-ledger.json"),
        postResultGraceMs: 80,
      });
      assert.equal(kimiAcpCached.cached, true);
      assert.equal(readJsonl(kimiAcpRecords).length, 1);

      // Also verify reviewerRunner='claude' passes `--permission-mode plan` and caches under `claude:default`
      const claudeTurns = path.join(root, "deliv-claude-turns.json");
      const claudeRecords = path.join(root, "deliv-claude-records.jsonl");
      writeFileSync(
        claudeTurns,
        JSON.stringify({
          turn: 0,
          turns: [{ sessionId: "claude-rev-1", text: '{"findings":[]}' }],
        }),
        "utf8",
      );
      const fakeClaude = createScriptedClaude(
        root,
        "fake-claude-rev.mjs",
        claudeTurns,
        claudeRecords,
      );

      const claudeSnap = await extractBranchSnapshot({
        repoDir,
        targetRef: "feat/acp-auth",
        outputDir: path.join(root, "claude-snap"),
      });
      claudeSnap.config.reviewerRunner = "claude";
      delete claudeSnap.config.reviewerCommand;
      delete claudeSnap.config.reviewerModels;

      const claudeReview = await reviewBranchSnapshot({
        snapshot: claudeSnap,
        ledgerFile: path.join(autoloopHome, "delivery", "review-ledger.json"),
        claudeBin: fakeClaude,
        postResultGraceMs: 80,
      });
      // Switching from acp:qwen3-coder-plus -> claude:default on same sha2 MUST miss cache & invoke Claude in plan mode!
      assert.equal(claudeReview.cached, false);
      assert.equal(claudeReview.status, "approved");
      assert.equal(claudeReview.reviewerModel, "claude:default");

      const claudeCalls = readJsonl<{
        argv: string[];
        permissionMode: string | null;
      }>(claudeRecords);
      assert.equal(claudeCalls.length, 1);
      assert.equal(claudeCalls[0]!.permissionMode, "plan");
      assert.equal(claudeCalls[0]!.argv.includes("--model"), false);

      assertInvariants(runtime.store.view);
    } finally {
      await runtime.close();
    }
  });
});
