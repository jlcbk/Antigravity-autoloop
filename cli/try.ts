/**
 * One-click closed-loop Autoloop trial wizard (`cli/try.ts`).
 *
 * Demonstrates the core "zero-cost suspend + original-session resume" lifecycle:
 * 1. Configures a trial rule in an isolated or specified `AUTOLOOP_HOME`.
 * 2. Emits a trial event that wakes `agy` (or `fake-agy.mjs` / built-in fallback demo)
 *    to produce an `open` `ask` card ("挑一个你喜欢的主题色") with a recommendation.
 * 3. Explicitly verifies `activeRuns.length === 0` (zero resident process / zero token wait).
 * 4. Answers the card (automatically via `--auto` / `autoAnswerChoice` or interactively)
 *    and verifies the exact same `conversationId` resumes to complete the run and mark
 *    the card `done`.
 */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { expandHomePath } from "../engine/context-file.ts";
import { cardViewOf, rulesOf } from "../kernel/query.ts";
import { parseRulesConfig } from "../protocol/rules-schema.ts";
import type { CardView, RulesConfig } from "../protocol/types.ts";
import {
  atomicWritePrivateFile,
  HubRuntime,
  resolveAutoloopHome,
} from "../sidecars/hub/ipc-server.ts";

export interface TryWizardOptions {
  autoloopHome?: string;
  cwd?: string;
  agyBin?: string;
  baseEnv?: NodeJS.ProcessEnv;
  env?: NodeJS.ProcessEnv;
  auto?: boolean;
  autoAnswerChoice?: number;
  autoAnswerText?: string;
  useRealAgy?: boolean;
  forceDemo?: boolean;
  stdout?: (chunk: string) => void;
  stderr?: (chunk: string) => void;
  stdin?: NodeJS.ReadableStream;
  pollIntervalMs?: number;
  timeoutMs?: number;
  cleanupTempHome?: boolean;
  json?: boolean;
}

export interface TryWizardResult {
  ok: boolean;
  mode: "auto" | "interactive";
  autoloopHome: string;
  usedFallbackDemoAgy: boolean;
  ruleName: string;
  eventId: string;
  firstRunId: number;
  secondRunId: number;
  cardId: number;
  cardKey: string;
  options: string[];
  recommend?: number;
  chosenChoice: number | null;
  chosenText: string;
  zeroActiveRunsBeforeAnswer: boolean;
  activeRunsBeforeAnswer: number[];
  firstSession: string | null;
  secondSession: string | null;
  sameSessionResumed: boolean;
  finalCardStatus: string;
  finalRunStatus: string;
  summary: string;
}

interface ParsedTryArgs {
  auto: boolean;
  choice?: number;
  text?: string;
  autoloopHome?: string;
  cwd?: string;
  agyBin?: string;
  useRealAgy: boolean;
  forceDemo: boolean;
  json: boolean;
  help: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 25;
const TRY_RULE_NAME = "try-theme-demo";
const TRY_AGENT_ID = "try-hydrogen";
const TRY_EVENT_TYPE = "try.start";

const FALLBACK_DEMO_AGY_SCRIPT = `#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";

function parseArgs(argv) {
  let conversation = null;
  let model = "gemini-4-hydrogen-high";
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--conversation" && i + 1 < argv.length) {
      conversation = argv[++i];
    } else if (a.startsWith("--conversation=")) {
      conversation = a.slice("--conversation=".length);
    } else if (a === "--model" && i + 1 < argv.length) {
      model = argv[++i];
    } else if (a.startsWith("--model=")) {
      model = a.slice("--model=".length);
    } else if (a === "--output-format" || a === "--effort" || a === "--mode") {
      i += 1;
    } else if (!a.startsWith("-")) {
      pos.push(a);
    }
  }
  return { conversation, model, prompt: pos.join("\\n") };
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

function readChosenFromContext(prompt) {
  let ctxFile = process.env.AUTOLOOP_CONTEXT || "";
  if (!ctxFile) {
    const m = /请先只读查看上下文文件：([^\\r\\n]+)/.exec(prompt);
    if (m) ctxFile = m[1].trim();
  }
  if (!ctxFile || !existsSync(ctxFile)) return "默认主题";
  try {
    const parsed = JSON.parse(readFileSync(ctxFile, "utf8"));
    const answers = parsed?.context?.answers ?? parsed?.answers ?? [];
    if (Array.isArray(answers) && answers.length > 0 && typeof answers[0]?.chosen === "string") {
      return answers[0].chosen;
    }
  } catch {
    // fallback
  }
  return "默认主题";
}

const parsed = parseArgs(process.argv.slice(2));
const convId = parsed.conversation || ("conv-try-" + process.pid + "-" + Date.now());

emit({ type: "init", conversationId: convId, model: parsed.model });
emit({ type: "progress", conversationId: convId, stage: parsed.conversation ? "resuming" : "asking" });

if (!parsed.conversation) {
  const receipt = {
    ask: [
      {
        key: "try-theme-color",
        title: "挑一个你喜欢的主题色",
        text: "Autoloop「挂起零消耗 + 批奏折原会话唤醒」体验卡：请挑选一个主题色，提交后将自动唤醒原会话完成收尾。",
        options: [
          "琥珀金（温暖高对比，推荐）",
          "松石青（清爽护眼）",
          "曜石黑（沉稳极简）"
        ],
        recommend: 0,
        about: "autoloop try 主题色偏好体验"
      }
    ]
  };
  emit({
    type: "assistant",
    conversationId: convId,
    text: "已生成主题色票拟奏折卡，挂起等待人工批复（零驻留进程消耗）。\\n\\n\`\`\`agent-autoloop\\n" + JSON.stringify(receipt) + "\\n\`\`\`"
  });
  emit({ type: "usage", conversationId: convId, usage: { input: 90, output: 64, cached: 0, cost: 0.0012 } });
} else {
  const chosen = readChosenFromContext(parsed.prompt);
  const receipt = {
    notice: [
      {
        key: "try-theme-done",
        title: "Try 闭环演示完成",
        text: "已根据批复「" + chosen + "」唤醒原会话完成主题应用与结案。",
        fyi: true
      }
    ]
  };
  emit({
    type: "assistant",
    conversationId: convId,
    text: "已收到批复「" + chosen + "」，续接原会话完成收尾。\\n\\n\`\`\`agent-autoloop\\n" + JSON.stringify(receipt) + "\\n\`\`\`"
  });
  emit({ type: "usage", conversationId: convId, usage: { input: 98, output: 52, cached: 64, cost: 0.0009 } });
}

emit({ type: "result", conversationId: convId, status: "completed" });
process.exit(0);
`;

function parseTryArgs(argv: readonly string[]): ParsedTryArgs {
  const out: ParsedTryArgs = {
    auto: false,
    useRealAgy: false,
    forceDemo: false,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--auto") {
      out.auto = true;
    } else if (arg === "--real-agy") {
      out.useRealAgy = true;
    } else if (arg === "--demo") {
      out.forceDemo = true;
    } else if (arg === "--json") {
      out.json = true;
    } else if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else if (arg === "--choice" && i + 1 < argv.length) {
      const n = Number(argv[++i]);
      if (!Number.isSafeInteger(n) || n < 0) {
        throw new Error(`--choice 必须是非负整数，收到: ${argv[i]}`);
      }
      out.choice = n;
      out.auto = true;
    } else if (arg.startsWith("--choice=")) {
      const raw = arg.slice("--choice=".length);
      const n = Number(raw);
      if (!Number.isSafeInteger(n) || n < 0) {
        throw new Error(`--choice 必须是非负整数，收到: ${raw}`);
      }
      out.choice = n;
      out.auto = true;
    } else if (arg === "--text" && i + 1 < argv.length) {
      out.text = argv[++i]!;
      out.auto = true;
    } else if (arg.startsWith("--text=")) {
      out.text = arg.slice("--text=".length);
      out.auto = true;
    } else if (arg === "--home" && i + 1 < argv.length) {
      out.autoloopHome = argv[++i]!;
    } else if (arg.startsWith("--home=")) {
      out.autoloopHome = arg.slice("--home=".length);
    } else if (arg === "--cwd" && i + 1 < argv.length) {
      out.cwd = argv[++i]!;
    } else if (arg.startsWith("--cwd=")) {
      out.cwd = arg.slice("--cwd=".length);
    } else if (arg === "--agy-bin" && i + 1 < argv.length) {
      out.agyBin = argv[++i]!;
    } else if (arg.startsWith("--agy-bin=")) {
      out.agyBin = arg.slice("--agy-bin=".length);
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }

  return out;
}

function isCommandOnPath(cmd: string, env: NodeJS.ProcessEnv): boolean {
  if (path.isAbsolute(cmd) || cmd.includes(path.sep)) {
    return existsSync(cmd);
  }
  const pathEnv = env.PATH ?? "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, cmd);
    if (existsSync(candidate)) {
      return true;
    }
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(
  fn: () => T | null | undefined,
  timeoutMs: number,
  label: string,
  pollMs = 25,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const val = fn();
    if (val !== null && val !== undefined) {
      return val;
    }
    await sleep(pollMs);
  }
  throw new Error(`等待超时（${timeoutMs}ms）：${label}`);
}

function buildTrialRulesConfig(
  autoloopHome: string,
  cwd: string,
): { config: RulesConfig; sourceKey: string } {
  const rulesPath = path.join(autoloopHome, "rules.json");
  let existing: RulesConfig | null = null;
  if (existsSync(rulesPath)) {
    try {
      const parsed = JSON.parse(readFileSync(rulesPath, "utf8"));
      existing = parseRulesConfig(parsed);
    } catch {
      existing = null;
    }
  }

  const sources: Record<string, { name: string }> = existing
    ? { ...existing.sources }
    : {};
  let sourceKey = "manual";
  if (!sources[sourceKey]) {
    const takenNames = new Set(Object.values(sources).map((s) => s.name));
    const displayName = takenNames.has("Manual Emit")
      ? "Try Wizard Emit"
      : "Manual Emit";
    sources[sourceKey] = { name: displayName };
  }

  const agents: Record<string, RulesConfig["agents"][string]> = existing
    ? { ...existing.agents }
    : {};
  let agentName = "Try Hydrogen Assistant";
  const takenAgentNames = new Set(
    Object.entries(agents)
      .filter(([id]) => id !== TRY_AGENT_ID)
      .map(([, a]) => a.name),
  );
  if (takenAgentNames.has(agentName)) {
    agentName = `Try Hydrogen Assistant (${TRY_AGENT_ID})`;
  }
  agents[TRY_AGENT_ID] = {
    name: agentName,
    runner: "agy-print",
    model: "gemini-4-hydrogen-high",
    effort: "medium",
    access: "read",
    maxActive: 1,
    timeoutMinutes: 5,
  };

  const trialRule: RulesConfig["rules"][number] = {
    name: TRY_RULE_NAME,
    when: { source: sourceKey, types: [TRY_EVENT_TYPE] },
    to: TRY_AGENT_ID,
    cwd,
    title: "try-{subject}",
    group: "try-demo",
    parallel: 1,
    resume: true,
    tell: "needed",
  };

  const priorRules = (existing?.rules ?? []).filter(
    (r) => r.name !== TRY_RULE_NAME,
  );
  const draft: RulesConfig = {
    timezone: existing?.timezone ?? "Asia/Shanghai",
    askFirst: existing?.askFirst ?? [
      "rm -rf",
      "git push --force",
      "git reset --hard",
    ],
    sources,
    agents,
    rules: [...priorRules, trialRule],
  };

  const validated = parseRulesConfig(draft);
  atomicWritePrivateFile(rulesPath, `${JSON.stringify(validated, null, 2)}\n`);
  return { config: validated, sourceKey };
}

function promptInteractiveAnswer(
  card: CardView,
  stdin: NodeJS.ReadableStream,
  writeOut: (s: string) => void,
): Promise<{ choice?: number; text?: string }> {
  const options = card.options ?? [];
  const defaultIdx =
    typeof card.recommend === "number" &&
    card.recommend >= 0 &&
    card.recommend < options.length
      ? card.recommend
      : 0;

  return new Promise((resolve) => {
    const rl = createInterface({
      input: stdin,
      terminal: false,
    });

    let settled = false;
    const finish = (ans: { choice?: number; text?: string }) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(ans);
    };

    rl.once("line", (line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        finish({ choice: defaultIdx });
        return;
      }
      if (/^\d+$/.test(trimmed)) {
        const idx = Number(trimmed);
        if (idx >= 0 && idx < options.length) {
          finish({ choice: idx });
          return;
        }
      }
      finish({ text: trimmed });
    });

    rl.once("close", () => {
      finish({ choice: defaultIdx });
    });

    writeOut(
      `\n请输入选项序号 [0-${Math.max(0, options.length - 1)}]（直接回车选推荐项 ${defaultIdx}，或输入自定义批注）：`,
    );
  });
}

function printTryHelp(writeOut: (s: string) => void): void {
  writeOut(
    [
      "用法: autoloop try [选项]",
      "",
      "一站式验证「挂起零消耗 + 批奏折原会话唤醒」闭环体验：",
      "  --auto              全自动非交互演练模式（使用隔离临时目录并自动批复推荐项）",
      "  --choice <index>    指定自动批复的选项下标（隐含 --auto）",
      "  --text <message>    指定自动批复的自由文本（隐含 --auto）",
      "  --home <dir>        指定 AUTOLOOP_HOME 目录",
      "  --cwd <dir>         指定规则执行工作目录",
      "  --agy-bin <path>    指定自定义 agy 可执行文件（如 tests/fakes/fake-agy.mjs）",
      "  --demo              强制使用内置安全演示桩（不调用真实 agy）",
      "  --real-agy          强制调用 PATH 中的真实 agy CLI",
      "  --json              以 JSON 格式输出试跑结果",
      "  -h, --help          显示帮助信息",
      "",
    ].join("\n"),
  );
}

/**
 * Run the end-to-end `autoloop try` wizard.
 */
export async function runTryWizard(
  argv: string[] = [],
  options: TryWizardOptions = {},
): Promise<TryWizardResult> {
  const parsed = parseTryArgs(argv);
  const env = options.env ?? process.env;
  const writeOut = options.stdout ?? ((s: string) => process.stdout.write(s));
  const writeErr = options.stderr ?? ((s: string) => process.stderr.write(s));
  const wantJson = options.json === true || parsed.json;

  if (parsed.help) {
    printTryHelp(writeOut);
    return {
      ok: true,
      mode: "auto",
      autoloopHome: "",
      usedFallbackDemoAgy: true,
      ruleName: TRY_RULE_NAME,
      eventId: "",
      firstRunId: 0,
      secondRunId: 0,
      cardId: 0,
      cardKey: "",
      options: [],
      chosenChoice: null,
      chosenText: "",
      zeroActiveRunsBeforeAnswer: true,
      activeRunsBeforeAnswer: [],
      firstSession: null,
      secondSession: null,
      sameSessionResumed: true,
      finalCardStatus: "done",
      finalRunStatus: "done",
      summary: "help",
    };
  }

  const isAuto =
    options.auto === true ||
    parsed.auto ||
    options.autoAnswerChoice !== undefined ||
    options.autoAnswerText !== undefined;
  const mode: "auto" | "interactive" = isAuto ? "auto" : "interactive";

  const explicitHome =
    options.autoloopHome ??
    parsed.autoloopHome ??
    env.AUTOLOOP_HOME?.trim() ??
    env.PLUGIN_DATA?.trim();

  let createdTempHome = false;
  let autoloopHome: string;
  if (explicitHome) {
    autoloopHome = expandHomePath(explicitHome);
    mkdirSync(autoloopHome, { recursive: true, mode: 0o700 });
  } else if (isAuto) {
    autoloopHome = mkdtempSync(path.join(os.tmpdir(), "autoloop-try-"));
    chmodSync(autoloopHome, 0o700);
    createdTempHome = true;
  } else {
    autoloopHome = resolveAutoloopHome(env);
    mkdirSync(autoloopHome, { recursive: true, mode: 0o700 });
  }

  const shouldCleanup =
    options.cleanupTempHome !== undefined
      ? options.cleanupTempHome
      : createdTempHome;

  const cwd = path.resolve(
    expandHomePath(options.cwd ?? parsed.cwd ?? process.cwd()),
  );
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const explicitAgyBin =
    options.agyBin ??
    parsed.agyBin ??
    env.AUTOLOOP_TRY_AGY_BIN?.trim() ??
    env.AUTOLOOP_AGY_BIN?.trim();

  const wantRealAgy = options.useRealAgy === true || parsed.useRealAgy;
  const forceDemo = options.forceDemo === true || parsed.forceDemo;

  let agyBin: string;
  let usedFallbackDemoAgy = false;

  if (explicitAgyBin) {
    agyBin = explicitAgyBin;
  } else if (wantRealAgy) {
    agyBin = "agy";
  } else if (forceDemo || isAuto || !isCommandOnPath("agy", env)) {
    const demoScriptPath = path.join(autoloopHome, "try-demo-agy.mjs");
    atomicWritePrivateFile(demoScriptPath, FALLBACK_DEMO_AGY_SCRIPT);
    chmodSync(demoScriptPath, 0o700);
    agyBin = demoScriptPath;
    usedFallbackDemoAgy = true;
  } else {
    agyBin = "agy";
  }

  const effectiveBaseEnv: NodeJS.ProcessEnv = {
    ...(options.baseEnv ?? env),
  };
  if (path.basename(agyBin) === "fake-agy.mjs") {
    effectiveBaseEnv.FAKE_AGY_SCENARIO ??= "ask_then_resume";
    effectiveBaseEnv.FAKE_AGY_STATE_FILE ??= path.join(
      autoloopHome,
      "fake-agy-state.json",
    );
  }

  let runtime: HubRuntime | null = null;

  try {
    const { config, sourceKey } = buildTrialRulesConfig(autoloopHome, cwd);

    runtime = new HubRuntime({
      autoloopHome,
      env,
      enableSupervisor: true,
      pollIntervalMs,
      agyBin,
      baseEnv: effectiveBaseEnv,
      notifierOptions: { silent: true },
      onError: (err) => {
        if (!wantJson) {
          writeErr(
            `[try] 运行时提示: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      },
    });

    runtime.configureRules(config);
    runtime.start();

    if (!wantJson) {
      writeOut(
        `[1/4] 已配置试跑规则 "${TRY_RULE_NAME}"（工作区: ${cwd}，数据目录: ${autoloopHome}）\n`,
      );
      if (usedFallbackDemoAgy) {
        writeOut(
          `[try] 使用内置安全演示执行桩（如需指定自定义/真实 agy，可传 --agy-bin 或 --real-agy）\n`,
        );
      }
    }

    const eventId = `try-${Date.now()}-${randomBytes(3).toString("hex")}`;
    const ingestRes = runtime.ingestEvent(sourceKey, {
      id: eventId,
      type: TRY_EVENT_TYPE,
      subject: "theme-color",
      summary:
        "Autoloop try wizard: ask user to pick a favorite theme color and resume same session.",
    });

    const dispatched = Array.isArray(ingestRes.dispatched)
      ? (ingestRes.dispatched as Array<{ rule: string; run: number }>)
      : [];
    let firstRunId = dispatched.find((d) => d.rule === TRY_RULE_NAME)?.run ?? 0;

    if (firstRunId <= 0) {
      const found = await waitFor(
        () => {
          const runs = runtime!.store.view
            .all("runs")
            .filter((r) => String(r.rule) === TRY_RULE_NAME);
          return runs.length > 0 ? Number(runs[runs.length - 1]!.id) : null;
        },
        timeoutMs,
        "试跑首轮任务入队",
        pollIntervalMs,
      );
      firstRunId = found;
    }

    if (!wantJson) {
      writeOut(
        `[2/4] 已派发首轮任务 Run #${firstRunId}，等待生成票拟卡片...\n`,
      );
    }

    const firstPhase = await waitFor(
      () => {
        const runRow = runtime!.store.view.get("runs", String(firstRunId));
        if (!runRow) return null;
        if (runRow.status === "failed" || runRow.status === "cancelled") {
          throw new Error(
            `试跑首轮 Run #${firstRunId} 异常结束 (${String(runRow.status)}): ${String(runRow.error ?? runRow.summary ?? "")}`,
          );
        }
        if (runRow.status !== "done") return null;

        const openCards = runtime!.store.view
          .all("cards")
          .filter(
            (c) =>
              c.kind === "ask" &&
              c.status === "open" &&
              String(c.rule) === TRY_RULE_NAME,
          );
        if (openCards.length === 0) return null;

        const activeRuns = runtime!.supervisor?.activeRuns() ?? [];
        if (activeRuns.length > 0) return null;

        const latestCard = openCards[openCards.length - 1]!;
        return {
          runRow,
          card: cardViewOf(latestCard),
          activeRuns,
        };
      },
      timeoutMs,
      "首轮生成 ask 提问卡且活跃进程归零",
      pollIntervalMs,
    );

    const activeRunsBeforeAnswer = firstPhase.activeRuns;
    const zeroActiveRunsBeforeAnswer = activeRunsBeforeAnswer.length === 0;
    const askCard = firstPhase.card;
    const firstSession =
      typeof firstPhase.runRow.session === "string" &&
      firstPhase.runRow.session.length > 0
        ? firstPhase.runRow.session
        : null;

    const cardOptions = askCard.options ?? [];
    if (!wantJson) {
      writeOut(
        `\n[3/4] 卡片 #${askCard.card} 已就绪，当前活跃进程数: ${activeRunsBeforeAnswer.length}（挂起零消耗！）\n`,
      );
      writeOut(`标题: ${askCard.title}\n`);
      if (askCard.text) {
        writeOut(`说明: ${askCard.text}\n`);
      }
      cardOptions.forEach((opt, idx) => {
        const mark = askCard.recommend === idx ? "  ★ 票拟推荐" : "";
        writeOut(`  [${idx}] ${opt}${mark}\n`);
      });
      writeOut(`工作台链接: [Autoloop 工作台](sidecar://autoloop/hub/)\n`);
    }

    let answerPayload: { choice?: number; text?: string };
    if (isAuto) {
      if (options.autoAnswerText !== undefined) {
        answerPayload = { text: options.autoAnswerText };
      } else if (parsed.text !== undefined) {
        answerPayload = { text: parsed.text };
      } else {
        const chosenIdx =
          options.autoAnswerChoice ??
          parsed.choice ??
          (typeof askCard.recommend === "number" &&
          askCard.recommend >= 0 &&
          askCard.recommend < cardOptions.length
            ? askCard.recommend
            : 0);
        answerPayload = { choice: chosenIdx };
      }
    } else {
      answerPayload = await promptInteractiveAnswer(
        askCard,
        options.stdin ?? process.stdin,
        writeOut,
      );
    }

    const answerRes = runtime.answerCard({
      card: askCard.card,
      ...answerPayload,
    }) as { card: CardView; eventId: number; run: number | null };

    const chosenChoice =
      typeof answerRes.card.choice === "number" ? answerRes.card.choice : null;
    const chosenText =
      answerRes.card.chosen ??
      answerRes.card.answerText ??
      answerPayload.text ??
      "";

    if (!wantJson) {
      writeOut(
        `\n[4/4] 已批复卡片 #${askCard.card}（选择: ${chosenText}），正在以原会话 ${firstSession ?? "(none)"} 唤醒续办...\n`,
      );
    }

    const secondPhase = await waitFor(
      () => {
        const runsAfter = runtime!.store.view
          .all("runs")
          .filter(
            (r) =>
              String(r.rule) === TRY_RULE_NAME && Number(r.id) > firstRunId,
          );
        if (runsAfter.length === 0) return null;

        const secondRunRow = runsAfter[runsAfter.length - 1]!;
        if (
          secondRunRow.status === "failed" ||
          secondRunRow.status === "cancelled"
        ) {
          throw new Error(
            `续办轮次 Run #${String(secondRunRow.id)} 异常结束 (${String(secondRunRow.status)}): ${String(secondRunRow.error ?? secondRunRow.summary ?? "")}`,
          );
        }
        if (secondRunRow.status !== "done") return null;

        const updatedCardRow = runtime!.store.view.get(
          "cards",
          String(askCard.card),
        );
        if (!updatedCardRow || updatedCardRow.status !== "done") return null;

        const activeNow = runtime!.supervisor?.activeRuns() ?? [];
        if (activeNow.length > 0) return null;

        return {
          secondRunRow,
          updatedCard: cardViewOf(updatedCardRow),
        };
      },
      timeoutMs,
      "原会话唤醒续办完成且卡片转为 done",
      pollIntervalMs,
    );

    const secondRunId = Number(secondPhase.secondRunRow.id);
    const secondSession =
      typeof secondPhase.secondRunRow.session === "string" &&
      secondPhase.secondRunRow.session.length > 0
        ? secondPhase.secondRunRow.session
        : null;
    const sameSessionResumed =
      firstSession !== null &&
      secondSession !== null &&
      firstSession === secondSession;
    const finalCardStatus = secondPhase.updatedCard.status;
    const finalRunStatus = String(secondPhase.secondRunRow.status);
    const summary = String(
      secondPhase.secondRunRow.summary ?? "Try 闭环试跑完成",
    );

    const result: TryWizardResult = {
      ok:
        zeroActiveRunsBeforeAnswer &&
        finalCardStatus === "done" &&
        finalRunStatus === "done" &&
        (firstSession === null || sameSessionResumed),
      mode,
      autoloopHome,
      usedFallbackDemoAgy,
      ruleName: TRY_RULE_NAME,
      eventId,
      firstRunId,
      secondRunId,
      cardId: askCard.card,
      cardKey: askCard.key,
      options: cardOptions,
      ...(askCard.recommend !== undefined
        ? { recommend: askCard.recommend }
        : {}),
      chosenChoice,
      chosenText,
      zeroActiveRunsBeforeAnswer,
      activeRunsBeforeAnswer,
      firstSession,
      secondSession,
      sameSessionResumed,
      finalCardStatus,
      finalRunStatus,
      summary,
    };

    if (wantJson) {
      writeOut(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      writeOut(
        [
          "",
          "试跑闭环验证成功！",
          `  • 首轮 Run #${firstRunId} 会话: ${firstSession ?? "(none)"}`,
          `  • 挂起期活跃进程: ${activeRunsBeforeAnswer.length}（零消耗挂起校验通过）`,
          `  • 批红选择: ${chosenText}`,
          `  • 续办 Run #${secondRunId} 会话: ${secondSession ?? "(none)"}（原会话续接: ${sameSessionResumed ? "是" : "否"}）`,
          `  • 卡片 #${askCard.card} 终态: ${finalCardStatus}`,
          `  • 总结: ${summary}`,
          "",
        ].join("\n"),
      );
    }

    return result;
  } finally {
    if (runtime) {
      await runtime.close().catch(() => {});
    }
    if (shouldCleanup && existsSync(autoloopHome)) {
      try {
        rmSync(autoloopHome, { recursive: true, force: true });
      } catch {
        // Best-effort temp cleanup
      }
    }
  }
}

const isEntrypoint =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  runTryWizard(process.argv.slice(2)).then(
    (res) => {
      process.exit(res.ok ? 0 : 1);
    },
    (err) => {
      process.stderr.write(
        `[autoloop try] 执行失败: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    },
  );
}
