/**
 * WP-18 End-to-End & Recipe Validation Tests (`tests/try-flow.test.ts`).
 *
 * Prevents:
 * 1. Starter template `examples/rules.starter.json` drifting out of sync with
 *    `parseRulesConfig` or missing required sources/agents/recipes.
 * 2. Skill documentation (`recipe-pr-delivery`, `recipe-health-watch`) shipping
 *    invalid YAML frontmatter or broken JSON config snippets.
 * 3. `probe-url.mjs` burning LLM tokens on healthy 2xx / single transient blips,
 *    flooding duplicate `service.down` alerts while already down, or failing to
 *    emit `service.recovered` + `resolve` when the service comes back up.
 * 4. `cli/try.ts` failing to verify zero resident processes during human wait
 *    (`activeRuns === 0`) or breaking original `conversationId` resumption.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { runTryWizard } from "../cli/try.ts";
import { createMemoryView } from "../kernel/evolve.ts";
import { readMessage } from "../protocol/receipt.ts";
import { parseRulesConfig } from "../protocol/rules-schema.ts";
import { explainRules } from "../sidecars/hub/ipc-server.ts";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const FAKE_AGY_PATH = path.join(REPO_ROOT, "tests", "fakes", "fake-agy.mjs");
const PROBE_URL_SCRIPT = path.join(
  REPO_ROOT,
  "skills",
  "recipe-health-watch",
  "scripts",
  "probe-url.mjs",
);

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function parseFrontmatter(markdown: string): {
  name: string;
  description: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  assert.ok(match, "SKILL.md must start with YAML frontmatter");
  const body = match[1]!;
  const nameMatch = /^name:\s*(.+)$/m.exec(body);
  assert.ok(nameMatch, "YAML frontmatter must declare `name`");
  assert.match(
    body,
    /^description:/m,
    "YAML frontmatter must declare `description`",
  );

  // Extract single-line or folded/multiline YAML description
  const descLineMatch = /^description:\s*(.*)$/m.exec(body);
  assert.ok(descLineMatch);
  let description = descLineMatch[1]!.trim();
  if (description === ">-" || description === ">" || description === "|") {
    const lines = body.split(/\r?\n/);
    const idx = lines.findIndex((l) => /^description:/.test(l));
    const collected: string[] = [];
    for (let i = idx + 1; i < lines.length; i++) {
      if (/^\s+/.test(lines[i]!)) {
        collected.push(lines[i]!.trim());
      } else {
        break;
      }
    }
    description = collected.join(" ").trim();
  }
  assert.ok(description.length > 20, "description must be meaningful");
  return { name: nameMatch[1]!.trim(), description };
}

function extractJsonBlocks(markdown: string): unknown[] {
  const blocks: unknown[] = [];
  const re = /```json\r?\n([\s\S]*?)\r?\n```/g;
  for (const match of markdown.matchAll(re)) {
    blocks.push(JSON.parse(match[1]!));
  }
  return blocks;
}

function runProbe(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      PROBE_URL_SCRIPT,
      args,
      {
        cwd: REPO_ROOT,
        shell: false,
        encoding: "utf8",
        env: { ...process.env, ...env },
      },
      (err, stdout, stderr) => {
        if (err && typeof (err as { code?: unknown }).code !== "number") {
          reject(err);
          return;
        }
        const code = err ? ((err as unknown as { code: number }).code ?? 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

describe("WP-18 Starter Rules, Recipe Skills, Zero-Token Probe, and Try Flow", () => {
  it("validates examples/rules.starter.json with parseRulesConfig and explainRules", () => {
    const raw = readFileSync(
      path.join(REPO_ROOT, "examples", "rules.starter.json"),
      "utf8",
    );
    const parsedJson = JSON.parse(raw);
    const config = parseRulesConfig(parsedJson);

    assert.equal(config.timezone, "Asia/Shanghai");
    assert.ok(config.askFirst.length >= 5);

    for (const src of ["manual", "probe", "git", "idea", "watch"]) {
      assert.ok(config.sources[src], `missing starter source: ${src}`);
    }

    assert.equal(
      config.agents["hydrogen-fast"]?.model,
      "gemini-4-hydrogen-high",
    );
    assert.equal(
      config.agents["hydrogen-reviewer"]?.model,
      "gemini-4-hydrogen-xhigh",
    );
    assert.equal(config.agents["hydrogen-reviewer"]?.access, "read");
    assert.equal(
      config.agents["carbon-architect"]?.model,
      "gemini-4-carbon-high",
    );
    assert.equal(config.agents["local-delivery"]?.runner, "delivery");
    assert.equal(config.agents["health-probe"]?.runner, "command");

    const ruleNames = new Set(config.rules.map((r) => r.name));
    for (const expected of [
      "morning-brief",
      "issue-triage",
      "idea-to-sop",
      "pr-delivery",
      "health-probe",
      "health-watch-diagnosis",
    ]) {
      assert.ok(ruleNames.has(expected), `missing starter rule: ${expected}`);
    }

    const report = explainRules(
      config,
      createMemoryView(),
      Date.parse("2026-11-14T01:00:00Z"),
    );
    assert.equal(report.valid, true);
    assert.equal(report.rules.length, config.rules.length);
  });

  it("validates recipe-pr-delivery and recipe-health-watch SKILL.md frontmatter and embedded configs", () => {
    const prSkill = readFileSync(
      path.join(REPO_ROOT, "skills", "recipe-pr-delivery", "SKILL.md"),
      "utf8",
    );
    const prFm = parseFrontmatter(prSkill);
    assert.equal(prFm.name, "recipe-pr-delivery");
    const prJsonBlocks = extractJsonBlocks(prSkill);
    assert.equal(prJsonBlocks.length, 2);

    const deliveryCfg = prJsonBlocks[0] as Record<string, unknown>;
    assert.equal(deliveryCfg.baseBranch, "main");
    assert.ok(typeof deliveryCfg.checkCommand === "string");
    assert.ok(typeof deliveryCfg.smokeCommand === "string");
    assert.ok(Array.isArray(deliveryCfg.sensitivePaths));
    assert.equal(deliveryCfg.maxReviewRounds, 3);

    const prRulesSnippet = prJsonBlocks[1] as Record<string, unknown>;
    const parsedPrRules = parseRulesConfig({
      askFirst: ["rm -rf"],
      ...prRulesSnippet,
    });
    assert.equal(parsedPrRules.rules[0]?.skill, "recipe-pr-delivery");

    const healthSkill = readFileSync(
      path.join(REPO_ROOT, "skills", "recipe-health-watch", "SKILL.md"),
      "utf8",
    );
    const healthFm = parseFrontmatter(healthSkill);
    assert.equal(healthFm.name, "recipe-health-watch");
    const healthJsonBlocks = extractJsonBlocks(healthSkill);
    assert.equal(healthJsonBlocks.length, 1);

    const healthRulesSnippet = healthJsonBlocks[0] as Record<string, unknown>;
    const parsedHealthRules = parseRulesConfig({
      askFirst: ["rm -rf"],
      ...healthRulesSnippet,
    });
    assert.equal(parsedHealthRules.agents["health-probe"]?.runner, "command");
    assert.equal(
      parsedHealthRules.rules.some((r) => r.skill === "recipe-health-watch"),
      true,
    );
  });

  it("exercises probe-url.mjs against a real HTTP server: 200 silent -> 2x 500 service.down -> 200 service.recovered + resolve", async () => {
    const st = statSync(PROBE_URL_SCRIPT);
    assert.notEqual(st.mode & 0o111, 0, "probe-url.mjs must be executable");

    let statusCode = 200;
    let bodyText = '{"ok":true}';
    const server = createServer((_req, res) => {
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(bodyText);
    });

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const addr = server.address();
    assert.ok(addr && typeof addr === "object");
    const targetUrl = `http://127.0.0.1:${addr.port}/health`;

    const autoloopHome = makeTempDir("autoloop-probe-");

    try {
      // 1. Initial 200 OK -> empty stdout (nothing, 0 tokens) and default state saved under <AUTOLOOP_HOME>/probes/
      const ok1 = await runProbe(["--url", targetUrl, "--threshold", "2"], {
        AUTOLOOP_HOME: autoloopHome,
      });
      assert.equal(ok1.code, 0, ok1.stderr);
      assert.equal(ok1.stdout.trim(), "");

      const probesDir = path.join(autoloopHome, "probes");
      assert.equal(existsSync(probesDir), true);
      const stateFiles = readdirSync(probesDir).filter((f) =>
        f.endsWith(".json"),
      );
      assert.equal(stateFiles.length, 1);

      // 2. First 500 (below threshold=2) -> silent exit 0 (filters transient blip)
      statusCode = 500;
      bodyText = "upstream overloaded";
      const down1 = await runProbe(["--url", targetUrl, "--threshold", "2"], {
        AUTOLOOP_HOME: autoloopHome,
      });
      assert.equal(down1.code, 0, down1.stderr);
      assert.equal(down1.stdout.trim(), "");

      // 3. Second consecutive 500 -> emits valid `agent-autoloop` receipt with `service.down`
      const down2 = await runProbe(["--url", targetUrl, "--threshold", "2"], {
        AUTOLOOP_HOME: autoloopHome,
      });
      assert.equal(down2.code, 0, down2.stderr);
      const parsedDown = readMessage(down2.stdout);
      assert.equal(parsedDown.problem, null);
      assert.equal(parsedDown.outcome, "done");
      assert.equal(parsedDown.receipt?.events?.length, 1);
      assert.equal(parsedDown.receipt?.events?.[0]?.type, "service.down");
      assert.equal(parsedDown.receipt?.events?.[0]?.link, targetUrl);
      assert.ok(parsedDown.receipt?.events?.[0]?.subject);

      // 4. Third consecutive 500 while already alerting -> silent exit 0 (no alert storm)
      const down3 = await runProbe(["--url", targetUrl, "--threshold", "2"], {
        AUTOLOOP_HOME: autoloopHome,
      });
      assert.equal(down3.code, 0, down3.stderr);
      assert.equal(down3.stdout.trim(), "");

      // 5. Recovery to 200 OK with an open alert card in AUTOLOOP_CONTEXT -> emits `service.recovered` + `resolve`
      const subject = parsedDown.receipt!.events![0]!.subject!;
      const ctxFile = path.join(autoloopHome, "context.json");
      writeFileSync(
        ctxFile,
        JSON.stringify({
          context: {
            open: [
              {
                card: 42,
                key: `health-down-${subject}`,
                title: "Service Down",
                text: "Waiting for recovery",
                at: "2026-11-14T00:00:00.000Z",
              },
            ],
          },
        }),
        "utf8",
      );

      statusCode = 200;
      bodyText = '{"ok":true}';
      const rec = await runProbe(["--url", targetUrl, "--threshold", "2"], {
        AUTOLOOP_HOME: autoloopHome,
        AUTOLOOP_CONTEXT: ctxFile,
      });
      assert.equal(rec.code, 0, rec.stderr);
      const parsedRec = readMessage(rec.stdout);
      assert.equal(parsedRec.problem, null);
      assert.equal(parsedRec.outcome, "done");
      assert.equal(parsedRec.receipt?.events?.length, 1);
      assert.equal(parsedRec.receipt?.events?.[0]?.type, "service.recovered");
      assert.deepEqual(parsedRec.receipt?.resolve, [
        {
          card: 42,
          reason: `健康探针确认 ${targetUrl} 已恢复 HTTP 200`,
        },
      ]);

      // 6. Steady healthy 200 again -> silent exit 0
      const ok2 = await runProbe(["--url", targetUrl, "--threshold", "2"], {
        AUTOLOOP_HOME: autoloopHome,
      });
      assert.equal(ok2.code, 0, ok2.stderr);
      assert.equal(ok2.stdout.trim(), "");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("runs `runTryWizard` with fake-agy.mjs: zero active runs during wait, same conversationId resume, card becomes done", async () => {
    const autoloopHome = makeTempDir("autoloop-try-fake-");
    const recordFile = path.join(autoloopHome, "fake-agy-records.jsonl");
    const logs: string[] = [];

    const result = await runTryWizard(["--auto"], {
      autoloopHome,
      cwd: REPO_ROOT,
      agyBin: FAKE_AGY_PATH,
      baseEnv: {
        ...process.env,
        AUTOLOOP_OWNER_TOKEN: "should-be-stripped",
        ANTIGRAVITY_SIDECAR_UI_TOKEN: "should-be-stripped",
        FAKE_AGY_SCENARIO: "ask_then_resume",
        FAKE_AGY_RECORD_FILE: recordFile,
        FAKE_AGY_SESSION: "conv-try-exact-101",
      },
      stdout: (s) => logs.push(s),
      stderr: (s) => logs.push(s),
    });

    assert.equal(result.ok, true, logs.join(""));
    assert.equal(result.mode, "auto");
    assert.equal(result.usedFallbackDemoAgy, false);
    assert.equal(result.zeroActiveRunsBeforeAnswer, true);
    assert.deepEqual(result.activeRunsBeforeAnswer, []);
    assert.equal(result.firstSession, "conv-try-exact-101");
    assert.equal(result.secondSession, "conv-try-exact-101");
    assert.equal(result.sameSessionResumed, true);
    assert.equal(result.finalCardStatus, "done");
    assert.equal(result.finalRunStatus, "done");
    assert.equal(result.chosenChoice, 0);
    assert.equal(result.chosenText, "青翠绿");

    // Verify exact fake-agy invocation log: Turn 1 has no --conversation; Turn 2 passes exact --conversation
    const lines = readFileSync(recordFile, "utf8")
      .trim()
      .split("\n")
      .map(
        (l) =>
          JSON.parse(l) as {
            parsed: { conversation: string | null };
            env: Record<string, string | undefined>;
          },
      );
    assert.equal(lines.length, 2);
    assert.equal(lines[0]!.parsed.conversation, null);
    assert.equal(lines[1]!.parsed.conversation, "conv-try-exact-101");
    assert.equal(lines[0]!.env.AUTOLOOP_OWNER_TOKEN, undefined);
    assert.equal(lines[0]!.env.ANTIGRAVITY_SIDECAR_UI_TOKEN, undefined);
  });

  it("runs `runTryWizard` with built-in fallback demo script when no agyBin is provided", async () => {
    const logs: string[] = [];
    const result = await runTryWizard(["--auto", "--json"], {
      cwd: REPO_ROOT,
      forceDemo: true,
      stdout: (s) => logs.push(s),
      stderr: (s) => logs.push(s),
    });

    assert.equal(result.ok, true);
    assert.equal(result.usedFallbackDemoAgy, true);
    assert.equal(result.zeroActiveRunsBeforeAnswer, true);
    assert.equal(result.sameSessionResumed, true);
    assert.ok(
      result.firstSession && result.firstSession.startsWith("conv-try-"),
    );
    assert.equal(result.finalCardStatus, "done");
    assert.equal(result.recommend, 0);
    assert.equal(result.options.length, 3);
    assert.equal(
      existsSync(result.autoloopHome),
      false,
      "auto temp home should be cleaned up",
    );

    const parsedOut = JSON.parse(logs.join(""));
    assert.equal(parsedOut.cardId, result.cardId);
    assert.equal(parsedOut.finalCardStatus, "done");
  });

  it("supports interactive guidance mode via stdin and prints sidecar workbench link", async () => {
    const autoloopHome = makeTempDir("autoloop-try-interactive-");
    const stdin = new PassThrough();
    const outChunks: string[] = [];

    const wizardPromise = runTryWizard([], {
      autoloopHome,
      cwd: REPO_ROOT,
      agyBin: FAKE_AGY_PATH,
      baseEnv: {
        ...process.env,
        FAKE_AGY_SCENARIO: "ask_then_resume",
        FAKE_AGY_SESSION: "conv-interactive-202",
      },
      stdin,
      stdout: (chunk) => {
        outChunks.push(chunk);
        if (chunk.includes("请输入选项序号")) {
          stdin.end("1\n");
        }
      },
      stderr: (chunk) => outChunks.push(chunk),
    });

    const result = await wizardPromise;
    const output = outChunks.join("");

    assert.equal(result.ok, true, output);
    assert.equal(result.mode, "interactive");
    assert.equal(result.chosenChoice, 1);
    assert.equal(result.chosenText, "深海蓝");
    assert.equal(result.sameSessionResumed, true);
    assert.equal(result.finalCardStatus, "done");
    assert.match(output, /\[Autoloop 工作台\]\(sidecar:\/\/autoloop\/hub\/\)/);
    assert.match(output, /当前活跃进程数: 0/);
  });
});
