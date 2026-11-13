#!/usr/bin/env node
/**
 * Deterministic fake `agy` CLI stub for layer-2/4 testing.
 * Simulates `agy --print --output-format stream-json` without external dependencies.
 */

import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const parsed = {
    print: false,
    outputFormat: null,
    model: null,
    effort: null,
    conversation: null,
    mode: null,
    sandbox: false,
    prompt: "",
    extraFlags: [],
  };
  const positionals = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--print" || arg === "-p") {
      parsed.print = true;
    } else if (arg === "--sandbox") {
      parsed.sandbox = true;
    } else if (arg.startsWith("--output-format=")) {
      parsed.outputFormat = arg.slice("--output-format=".length);
    } else if (arg === "--output-format" && i + 1 < argv.length) {
      parsed.outputFormat = argv[++i];
    } else if (arg.startsWith("--model=")) {
      parsed.model = arg.slice("--model=".length);
    } else if (arg === "--model" && i + 1 < argv.length) {
      parsed.model = argv[++i];
    } else if (arg.startsWith("--effort=")) {
      parsed.effort = arg.slice("--effort=".length);
    } else if (arg === "--effort" && i + 1 < argv.length) {
      parsed.effort = argv[++i];
    } else if (arg.startsWith("--conversation=")) {
      parsed.conversation = arg.slice("--conversation=".length);
    } else if (arg === "--conversation" && i + 1 < argv.length) {
      parsed.conversation = argv[++i];
    } else if (arg.startsWith("--mode=")) {
      parsed.mode = arg.slice("--mode=".length);
    } else if (arg === "--mode" && i + 1 < argv.length) {
      parsed.mode = argv[++i];
    } else if (arg.startsWith("--")) {
      parsed.extraFlags.push(arg);
    } else {
      positionals.push(arg);
    }
  }

  parsed.prompt = positionals.join("\n");
  return parsed;
}

function recordInvocation(argv, parsed) {
  const recordFile = process.env.FAKE_AGY_RECORD_FILE;
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

function loadAndAdvanceState(parsed) {
  const stateFile = process.env.FAKE_AGY_STATE_FILE;
  let state = {
    turn: 0,
    conversationId:
      parsed.conversation ??
      process.env.FAKE_AGY_SESSION ??
      `conv-fake-${process.pid}`,
  };

  if (stateFile && existsSync(stateFile)) {
    try {
      const existing = JSON.parse(readFileSync(stateFile, "utf8"));
      if (existing && typeof existing === "object") {
        state = {
          ...state,
          ...existing,
          turn: typeof existing.turn === "number" ? existing.turn : 0,
          conversationId:
            parsed.conversation ??
            existing.conversationId ??
            state.conversationId,
        };
      }
    } catch {
      // Ignore corrupt state file and reinitialize
    }
  }

  const currentTurn = state.turn;
  if (stateFile) {
    mkdirSync(path.dirname(stateFile), { recursive: true });
    writeFileSync(
      stateFile,
      `${JSON.stringify({ ...state, turn: currentTurn + 1 }, null, 2)}\n`,
      "utf8",
    );
  }

  return { state, currentTurn };
}

function emitLine(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
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

function getUsage() {
  if (process.env.FAKE_AGY_USAGE) {
    try {
      return JSON.parse(process.env.FAKE_AGY_USAGE);
    } catch {
      // Fallback to default deterministic usage
    }
  }
  return {
    input: 120,
    output: 48,
    cached: 64,
    cost: 0.0019,
  };
}

function isRepairPrompt(prompt) {
  return (
    prompt.includes("回执格式存在问题") ||
    prompt.includes("仅重新输出你的最后一条完整消息")
  );
}

function emitAssistantDone(convId, text, parsed) {
  emitLine({
    type: "init",
    conversationId: convId,
    model: parsed.model ?? "gemini-4-hydrogen-high",
  });
  emitLine({
    type: "progress",
    conversationId: convId,
    stage: "generating",
  });
  emitLine({
    type: "assistant",
    conversationId: convId,
    text,
  });
  emitLine({
    type: "usage",
    conversationId: convId,
    usage: getUsage(),
  });
  emitLine({
    type: "result",
    conversationId: convId,
    status: "completed",
  });
}

function main() {
  const rawArgv = process.argv.slice(2);
  const parsed = parseArgs(rawArgv);
  recordInvocation(rawArgv, parsed);

  const { state, currentTurn } = loadAndAdvanceState(parsed);
  const scenario = process.env.FAKE_AGY_SCENARIO ?? "normal_done";
  const convId = state.conversationId;

  // Support explicit turn script in state file if configured
  if (Array.isArray(state.turns) && state.turns[currentTurn]) {
    const step = state.turns[currentTurn];
    if (step.emitInit !== false) {
      emitLine({
        type: "init",
        conversationId: step.conversationId ?? convId,
        model: parsed.model ?? "gemini-4-hydrogen-high",
      });
    }
    if (typeof step.stderr === "string" && step.stderr.length > 0) {
      process.stderr.write(`${step.stderr}\n`);
    }
    if (typeof step.text === "string") {
      emitLine({
        type: "assistant",
        conversationId: step.conversationId ?? convId,
        text: step.text,
      });
      emitLine({
        type: "usage",
        conversationId: step.conversationId ?? convId,
        usage: step.usage ?? getUsage(),
      });
      emitLine({
        type: "result",
        conversationId: step.conversationId ?? convId,
        status: "completed",
      });
    }
    process.exit(typeof step.exitCode === "number" ? step.exitCode : 0);
  }

  switch (scenario) {
    case "fail_before_start": {
      process.stderr.write(
        "agy error: failed to initialize session before start\n",
      );
      process.exit(Number(process.env.FAKE_AGY_EXIT_CODE ?? 1));
      break;
    }

    case "fail_after_start": {
      emitLine({
        type: "init",
        conversationId: convId,
        model: parsed.model ?? "gemini-4-hydrogen-high",
      });
      emitLine({
        type: "progress",
        conversationId: convId,
        stage: "running",
      });
      process.stderr.write("agy error: simulated mid-turn process crash\n");
      process.exit(Number(process.env.FAKE_AGY_EXIT_CODE ?? 1));
      break;
    }

    case "hang_with_child": {
      emitLine({
        type: "init",
        conversationId: convId,
        model: parsed.model ?? "gemini-4-hydrogen-high",
      });

      if (process.env.FAKE_AGY_IGNORE_SIGTERM === "1") {
        process.on("SIGTERM", () => {
          // Intentionally ignore SIGTERM to exercise SIGKILL escalation
        });
      }

      const child = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        {
          stdio: "ignore",
        },
      );

      const pidFile = process.env.FAKE_AGY_CHILD_PID_FILE;
      if (pidFile && typeof child.pid === "number") {
        mkdirSync(path.dirname(pidFile), { recursive: true });
        writeFileSync(pidFile, `${child.pid}\n`, "utf8");
      }

      setInterval(() => {}, 1000);
      return;
    }

    case "normal_nothing": {
      emitAssistantDone(convId, "没事可做：当前规则无待处理变更。", parsed);
      process.exit(0);
      break;
    }

    case "ask_then_resume": {
      const isResume = Boolean(parsed.conversation) || currentTurn > 0;
      if (!isResume) {
        const text = [
          "需要用户批示后再继续执行。",
          "",
          "```agent-autoloop",
          JSON.stringify({
            ask: [
              {
                key: "confirm-color",
                title: "请选择目标颜色",
                text: "请在两个方案中选择一项",
                options: ["青翠绿", "深海蓝"],
                recommend: 0,
                about: "ask_then_resume_check",
              },
            ],
          }),
          "```",
        ].join("\n");
        emitAssistantDone(convId, text, parsed);
      } else {
        const answers = readContextAnswers(parsed.prompt);
        const first = answers[0];
        const chosen =
          typeof first?.chosen === "string" && first.chosen.length > 0
            ? first.chosen
            : "未知选项";
        const text = [
          `已收到批复「${chosen}」，续办完成。`,
          "",
          "```agent-autoloop",
          JSON.stringify({
            notice: [
              {
                key: "resume-complete",
                title: "续办结果",
                text: `用户选择：${chosen}`,
                fyi: true,
              },
            ],
          }),
          "```",
        ].join("\n");
        emitAssistantDone(convId, text, parsed);
      }
      process.exit(0);
      break;
    }

    case "bad_receipt_then_repair": {
      const shouldRepair = isRepairPrompt(parsed.prompt) || currentTurn > 0;
      if (!shouldRepair) {
        const badKind = process.env.FAKE_AGY_BAD_KIND ?? "json";
        const badText =
          badKind === "unclosed"
            ? [
                "已完成初步处理，等待记录回执。",
                "",
                "```agent-autoloop",
                '{"notice":[{"title":"未闭合","text":"测试","fyi":true}]}',
              ].join("\n")
            : [
                "已完成初步处理，等待记录回执。",
                "",
                "```json",
                '{"notice":[{"title":"误标语言","text":"测试","fyi":true}]}',
                "```",
              ].join("\n");
        emitAssistantDone(convId, badText, parsed);
      } else {
        const fixedText = [
          "已完成初步处理，现按规范重写回执。",
          "",
          "```agent-autoloop",
          JSON.stringify({
            notice: [
              {
                key: "repaired-notice",
                title: "修复成功",
                text: "已原地重写为合法 agent-autoloop 回执",
                fyi: true,
              },
            ],
          }),
          "```",
        ].join("\n");
        emitAssistantDone(convId, fixedText, parsed);
      }
      process.exit(0);
      break;
    }

    case "normal_done":
    default: {
      let receiptPayload = {
        notice: [
          {
            key: "done-notice",
            title: "执行完成",
            text: "任务已按安全隔离规范完成",
            fyi: true,
          },
        ],
      };
      if (process.env.FAKE_AGY_RECEIPT) {
        try {
          receiptPayload = JSON.parse(process.env.FAKE_AGY_RECEIPT);
        } catch {
          // Ignore invalid override and keep default
        }
      }
      const text = [
        "已完成指定任务。",
        "",
        "```agent-autoloop",
        JSON.stringify(receiptPayload),
        "```",
      ].join("\n");
      emitAssistantDone(convId, text, parsed);
      process.exit(0);
    }
  }
}

main();
