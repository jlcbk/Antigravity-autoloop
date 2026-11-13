#!/usr/bin/env node
/**
 * Deterministic fake `agentapi` CLI stub for layer-2/4 testing.
 * Supports `new-conversation` and `send-message` and writes transcript.jsonl steps.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

function parseCli(argv) {
  const subcommand = argv[0] ?? "";
  const rest = argv.slice(1);
  const flags = {
    model: null,
    title: null,
  };
  const positionals = [];

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith("--model=")) {
      flags.model = arg.slice("--model=".length);
    } else if (arg === "--model" && i + 1 < rest.length) {
      flags.model = rest[++i];
    } else if (arg.startsWith("--title=")) {
      flags.title = arg.slice("--title=".length);
    } else if (arg === "--title" && i + 1 < rest.length) {
      flags.title = rest[++i];
    } else if (arg.startsWith("--")) {
      // Ignore unrecognized option flags gracefully
    } else {
      positionals.push(arg);
    }
  }

  return { subcommand, flags, positionals };
}

function recordInvocation(argv, parsed) {
  const recordFile = process.env.FAKE_AGENTAPI_RECORD_FILE;
  if (!recordFile) return;

  mkdirSync(path.dirname(recordFile), { recursive: true });
  const entry = {
    argv,
    parsed,
    env: { ...process.env },
    cwd: process.cwd(),
    pid: process.pid,
    at: new Date().toISOString(),
  };

  if (recordFile.endsWith(".jsonl")) {
    appendFileSync(recordFile, `${JSON.stringify(entry)}\n`, "utf8");
  } else {
    writeFileSync(recordFile, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
  }
}

function getAppDataDir() {
  return (
    process.env.FAKE_APPDATA_DIR ??
    process.env.ANTIGRAVITY_APPDATA_DIR ??
    path.join(os.homedir(), ".gemini", "antigravity")
  );
}

function getTranscriptPath(appDataDir, session) {
  return path.join(
    appDataDir,
    "brain",
    session,
    ".system_generated",
    "logs",
    "transcript.jsonl",
  );
}

function countExistingLines(filePath) {
  if (!existsSync(filePath)) return 0;
  const raw = readFileSync(filePath, "utf8");
  if (!raw) return 0;
  return raw.split("\n").filter((line) => line.trim().length > 0).length;
}

function resolveContextFile(prompt) {
  if (process.env.AUTOLOOP_CONTEXT) {
    return process.env.AUTOLOOP_CONTEXT;
  }
  const match = /请先只读查看上下文文件：([^\r\n]+)/.exec(prompt);
  return match ? match[1].trim() : null;
}

function readContextAnswers(prompt) {
  const filePath = resolveContextFile(prompt);
  if (!filePath || !existsSync(filePath)) {
    return [];
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    if (Array.isArray(parsed?.context?.answers)) {
      return parsed.context.answers;
    }
    if (Array.isArray(parsed?.answers)) {
      return parsed.answers;
    }
  } catch {
    return [];
  }
  return [];
}

function isRepairPrompt(prompt) {
  return (
    prompt.includes("回执格式存在问题") ||
    prompt.includes("仅重新输出你的最后一条完整消息")
  );
}

function buildReplyContent(scenario, subcommand, prompt) {
  if (scenario === "error_step") {
    return {
      status: "ERROR",
      content: "没跑成：agentapi 模拟步骤异常中断",
    };
  }

  if (scenario === "ask_then_resume") {
    if (subcommand === "new-conversation") {
      return {
        status: "DONE",
        content: [
          "需要用户在工作台批示后再继续。",
          "",
          "```agent-autoloop",
          JSON.stringify({
            ask: [
              {
                key: "agentapi-confirm",
                title: "UI 会话确认",
                text: "请选择下一步动作",
                options: ["继续执行", "暂缓处理"],
                recommend: 0,
                about: "fake_agentapi_ask",
              },
            ],
          }),
          "```",
        ].join("\n"),
      };
    }

    const answers = readContextAnswers(prompt);
    const chosen =
      typeof answers[0]?.chosen === "string" && answers[0].chosen.length > 0
        ? answers[0].chosen
        : "默认确认";
    return {
      status: "DONE",
      content: [
        `UI 会话已收到批复「${chosen}」并执行完成。`,
        "",
        "```agent-autoloop",
        JSON.stringify({
          notice: [
            {
              key: "agentapi-resumed",
              title: "UI 续办完成",
              text: `已按「${chosen}」执行`,
              fyi: true,
            },
          ],
        }),
        "```",
      ].join("\n"),
    };
  }

  if (scenario === "bad_receipt_then_repair") {
    if (!isRepairPrompt(prompt)) {
      return {
        status: "DONE",
        content: [
          "UI 会话执行完毕。",
          "",
          "```json",
          '{"notice":[{"title":"误写为json","text":"需要修复","fyi":true}]}',
          "```",
        ].join("\n"),
      };
    }
    return {
      status: "DONE",
      content: [
        "UI 会话已重写合法回执。",
        "",
        "```agent-autoloop",
        JSON.stringify({
          notice: [
            {
              key: "agentapi-repaired",
              title: "回执已修复",
              text: "格式已符合 agent-autoloop 协议",
              fyi: true,
            },
          ],
        }),
        "```",
      ].join("\n"),
    };
  }

  let receipt = {
    notice: [
      {
        key: "agentapi-done",
        title: "UI 会话完成",
        text: "agentapi 模拟回合已完成",
        fyi: true,
      },
    ],
  };
  if (process.env.FAKE_AGENTAPI_RECEIPT) {
    try {
      receipt = JSON.parse(process.env.FAKE_AGENTAPI_RECEIPT);
    } catch {
      // Keep default receipt
    }
  }

  return {
    status: "DONE",
    content: [
      "已完成 UI 会话任务。",
      "",
      "```agent-autoloop",
      JSON.stringify(receipt),
      "```",
    ].join("\n"),
  };
}

function appendTurnToTranscript(appDataDir, session, prompt, reply) {
  const transcriptPath = getTranscriptPath(appDataDir, session);
  mkdirSync(path.dirname(transcriptPath), { recursive: true });

  const startIndex = countExistingLines(transcriptPath);
  const nowIso = new Date().toISOString();

  const userStep = {
    step_index: startIndex,
    source: "USER_EXPLICIT",
    type: "USER_INPUT",
    status: "DONE",
    created_at: nowIso,
    content: prompt,
  };
  const plannerStep = {
    step_index: startIndex + 1,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    status: reply.status,
    created_at: nowIso,
    content: reply.content,
  };

  appendFileSync(
    transcriptPath,
    `${JSON.stringify(userStep)}\n${JSON.stringify(plannerStep)}\n`,
    "utf8",
  );
  return transcriptPath;
}

function main() {
  const rawArgv = process.argv.slice(2);
  const parsed = parseCli(rawArgv);
  recordInvocation(rawArgv, parsed);

  const scenario = process.env.FAKE_AGENTAPI_SCENARIO ?? "normal_done";
  const appDataDir = getAppDataDir();

  if (parsed.subcommand === "new-conversation") {
    if (scenario === "fail_new") {
      process.stderr.write("agentapi error: failed to create conversation\n");
      process.exit(1);
    }

    const session =
      process.env.FAKE_AGENTAPI_SESSION ?? `session-fake-${process.pid}`;
    const prompt = parsed.positionals.join("\n");
    const reply = buildReplyContent(scenario, "new-conversation", prompt);
    const delayMs = Number(process.env.FAKE_AGENTAPI_DELAY_MS ?? 0);

    if (delayMs > 0) {
      setTimeout(() => {
        appendTurnToTranscript(appDataDir, session, prompt, reply);
      }, delayMs);
    } else {
      appendTurnToTranscript(appDataDir, session, prompt, reply);
    }

    if (process.env.FAKE_AGENTAPI_OUTPUT === "text") {
      process.stdout.write(`${session}\n`);
    } else {
      process.stdout.write(
        `${JSON.stringify({ conversationId: session, model: parsed.flags.model, title: parsed.flags.title })}\n`,
      );
    }
    return;
  }

  if (parsed.subcommand === "send-message") {
    if (scenario === "session_not_found" || scenario === "fail_send") {
      process.stderr.write(
        `agentapi error: session not found (${parsed.positionals[0] ?? ""})\n`,
      );
      process.exit(1);
    }

    const session = parsed.positionals[0];
    const prompt = parsed.positionals.slice(1).join("\n");
    if (!session) {
      process.stderr.write("agentapi error: missing <session> argument\n");
      process.exit(1);
    }

    const reply = buildReplyContent(scenario, "send-message", prompt);
    const delayMs = Number(process.env.FAKE_AGENTAPI_DELAY_MS ?? 0);

    if (delayMs > 0) {
      setTimeout(() => {
        appendTurnToTranscript(appDataDir, session, prompt, reply);
      }, delayMs);
    } else {
      appendTurnToTranscript(appDataDir, session, prompt, reply);
    }

    process.stdout.write(
      `${JSON.stringify({ conversationId: session, ok: true })}\n`,
    );
    return;
  }

  process.stderr.write(
    `agentapi error: unsupported subcommand "${parsed.subcommand}"\n`,
  );
  process.exit(1);
}

main();
