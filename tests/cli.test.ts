/**
 * CLI & Antigravity Native Plugin Package Tests (Layer 2).
 *
 * Prevents:
 * 1. Broken IPC-to-SQLite seamless fallback when Sidecar is offline or `ipc.json`
 *    points to a stale port, or broken `ingest.token` support for `emit`.
 * 2. Regressions across all diagnostic & control subcommands (`check`, `explain`,
 *    `emit --dry-run`, `emit`, `status`, `why`, `answer`, `resolve`, `pause`,
 *    `resume`, `replay`, `run`, `stop`) and `--json` output contracts.
 * 3. Antigravity plugin manifest / asset / rule regressions: unknown top-level
 *    fields in `plugin.json`, frontmatter or `>= 2KB` bloat in `rules/AGENTS.md`,
 *    or invalid `assets/logo.svg` geometry.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  accessSync,
  constants,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runCli } from "../cli/main.ts";
import { openStore } from "../kernel/store.ts";
import type { RulesConfig } from "../protocol/types.ts";
import {
  HubRuntime,
  startIpcServer,
  type IpcServerHandle,
} from "../sidecars/hub/ipc-server.ts";

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const tempDirs: string[] = [];
const runtimes: HubRuntime[] = [];
const servers: IpcServerHandle[] = [];

function makeTempHome(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "autoloop-cli-test-"));
  tempDirs.push(dir);
  return dir;
}

function makeSampleConfig(cwd = "/tmp/autoloop-cli-repo"): RulesConfig {
  return {
    timezone: "Asia/Shanghai",
    askFirst: ["rm -rf", "git push --force"],
    sources: {
      cli: { name: "CLI Trigger" },
      inbox: { name: "Local Inbox" },
    },
    agents: {
      worker: {
        name: "Hydrogen Worker",
        runner: "agy-print",
        model: "gemini-4-hydrogen-high",
        access: "edit",
      },
    },
    rules: [
      {
        name: "triage",
        when: { source: "inbox", types: ["issue.*"] },
        to: "worker",
        cwd,
        group: "triage-grp",
        parallel: 2,
      },
      {
        name: "cli-ops",
        when: { source: "cli", types: ["deploy.*", "ping"] },
        to: "worker",
        cwd,
        resume: true,
      },
      {
        name: "morning-brief",
        when: { cron: "0 9 * * *" },
        to: "worker",
        cwd,
      },
    ],
  };
}

async function invokeCli(
  argv: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const code = await runCli(argv, {
    stdout: (s) => outChunks.push(s),
    stderr: (s) => errChunks.push(s),
    env,
  });
  return {
    code,
    stdout: outChunks.join(""),
    stderr: errChunks.join(""),
  };
}

afterEach(async () => {
  for (const s of servers.splice(0)) {
    await s.close();
  }
  for (const rt of runtimes.splice(0)) {
    await rt.close();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Autoloop CLI (Local SQLite Fallback & IPC Modes)", () => {
  it("check and explain validate rules.json and reject invalid configs", async () => {
    const home = makeTempHome();
    const env = { ...process.env, AUTOLOOP_HOME: home };
    const rulesPath = path.join(home, "rules.json");
    writeFileSync(
      rulesPath,
      `${JSON.stringify(makeSampleConfig(), null, 2)}\n`,
      "utf8",
    );

    const checkRes = await invokeCli(["check", "--json"], env);
    assert.equal(checkRes.code, 0, checkRes.stderr);
    const checkJson = JSON.parse(checkRes.stdout) as Record<string, unknown>;
    assert.equal(checkJson.valid, true);
    assert.equal(checkJson.rulesCount, 3);
    assert.equal(checkJson.timezone, "Asia/Shanghai");

    const explainRes = await invokeCli(["explain", "--json"], env);
    assert.equal(explainRes.code, 0, explainRes.stderr);
    const explainJson = JSON.parse(explainRes.stdout) as {
      valid: boolean;
      mode: string;
      rules: Array<{
        name: string;
        triggerKind: string;
        nextRunAt: string | null;
      }>;
    };
    assert.equal(explainJson.valid, true);
    assert.equal(explainJson.mode, "local-fallback");
    assert.equal(explainJson.rules.length, 3);
    const cronRule = explainJson.rules.find((r) => r.name === "morning-brief");
    assert.equal(cronRule?.triggerKind, "cron");
    assert.ok(typeof cronRule?.nextRunAt === "string");

    // Draft file with invalid cron expression should fail check
    const badDraft = path.join(home, "bad-draft.json");
    const badCfg = makeSampleConfig();
    badCfg.rules[2] = {
      name: "bad-cron",
      when: { cron: "99 99 * * *" },
      to: "worker",
      cwd: "/tmp/autoloop-cli-repo",
    };
    writeFileSync(badDraft, JSON.stringify(badCfg), "utf8");
    const badCheck = await invokeCli(["check", badDraft, "--json"], env);
    assert.equal(badCheck.code, 1);
    const badErr = JSON.parse(badCheck.stderr) as { error: string };
    assert.ok(badErr.error.length > 0);
  });

  it("emit --dry-run does not persist, whereas formal emit persists and deduplicates in local SQLite fallback", async () => {
    const home = makeTempHome();
    const env = { ...process.env, AUTOLOOP_HOME: home };
    writeFileSync(
      path.join(home, "rules.json"),
      JSON.stringify(makeSampleConfig()),
      "utf8",
    );

    const dryRes = await invokeCli(
      [
        "emit",
        "issue.opened",
        "--source",
        "inbox",
        "--id",
        "ev-dry-1",
        "--subject",
        "issue#101",
        "--summary",
        "dry run summary",
        "--dry-run",
        "--json",
      ],
      env,
    );
    assert.equal(dryRes.code, 0, dryRes.stderr);
    const dryJson = JSON.parse(dryRes.stdout) as {
      dryRun: boolean;
      mode: string;
      routed: string[];
      runs: number[];
    };
    assert.equal(dryJson.dryRun, true);
    assert.equal(dryJson.mode, "local-fallback");
    assert.deepEqual(dryJson.routed, ["triage"]);
    assert.equal(dryJson.runs.length, 1);

    // Status should still have 0 runs because dry-run didn't commit
    const statusBefore = await invokeCli(["status", "--json"], env);
    assert.equal(statusBefore.code, 0, statusBefore.stderr);
    const beforeSnap = JSON.parse(statusBefore.stdout) as { runs: unknown[] };
    assert.equal(beforeSnap.runs.length, 0);

    // Formal emit persists
    const emitRes = await invokeCli(
      [
        "emit",
        "issue.opened",
        "--source",
        "inbox",
        "--id",
        "ev-real-1",
        "--subject",
        "issue#102",
        "--summary",
        "real summary",
        "--detail",
        "detailed payload",
        "--link",
        "https://example.com/issues/102",
        "--json",
      ],
      env,
    );
    assert.equal(emitRes.code, 0, emitRes.stderr);
    const emitJson = JSON.parse(emitRes.stdout) as {
      dryRun: boolean;
      duplicate: boolean;
      routed: string[];
      runs: number[];
    };
    assert.equal(emitJson.dryRun, false);
    assert.equal(emitJson.duplicate, false);
    assert.deepEqual(emitJson.routed, ["triage"]);
    assert.equal(emitJson.runs.length, 1);

    // Duplicate event id under same source must deduplicate
    const dupRes = await invokeCli(
      [
        "emit",
        "issue.opened",
        "--source",
        "inbox",
        "--id",
        "ev-real-1",
        "--json",
      ],
      env,
    );
    assert.equal(dupRes.code, 0, dupRes.stderr);
    const dupJson = JSON.parse(dupRes.stdout) as { duplicate: boolean };
    assert.equal(dupJson.duplicate, true);

    const statusAfter = await invokeCli(["status", "--json"], env);
    assert.equal(statusAfter.code, 0, statusAfter.stderr);
    const afterSnap = JSON.parse(statusAfter.stdout) as {
      runs: Array<{ run: number; status: string }>;
      lines: Array<{ rule: string }>;
    };
    assert.equal(afterSnap.runs.length, 1);
    assert.equal(afterSnap.runs[0]?.status, "queued");
    assert.equal(afterSnap.lines.length, 3);
  });

  it("supports answer, resolve, why, pause, resume, replay, run, and stop in local fallback mode", async () => {
    const home = makeTempHome();
    const env = { ...process.env, AUTOLOOP_HOME: home };
    writeFileSync(
      path.join(home, "rules.json"),
      JSON.stringify(makeSampleConfig()),
      "utf8",
    );

    // Seed an initial event via CLI
    const emit1 = await invokeCli(
      [
        "emit",
        "deploy.req",
        "--source",
        "cli",
        "--id",
        "d-1",
        "--subject",
        "prod",
        "--json",
      ],
      env,
    );
    assert.equal(emit1.code, 0, emit1.stderr);
    const firstRunId = (JSON.parse(emit1.stdout) as { runs: number[] })
      .runs[0]!;

    // Simulate worker claiming and submitting an ask + notice receipt directly via store/decide
    const rt = new HubRuntime({
      autoloopHome: home,
      enableSupervisor: false,
      now: () => Date.now(),
    });
    const claim = rt.dispatch<{
      jobs: Array<{ run: number; token: string }>;
    }>({
      type: "claimWork",
      claimId: "test-worker",
      capacity: 2,
      running: [],
    });
    assert.equal(claim.jobs.length, 1);
    const job = claim.jobs[0]!;
    rt.dispatch({
      type: "markStarted",
      run: job.run,
      token: job.token,
      session: "conv-session-123",
    });
    rt.dispatch({
      type: "submitResult",
      run: job.run,
      token: job.token,
      result: {
        outcome: "done",
        summary: "请批复部署环境",
        session: "conv-session-123",
        usage: { input: 100, output: 40, cached: 20, cost: 0.01 },
        ask: [
          {
            key: "confirm-deploy",
            title: "是否继续发布到生产环境？",
            text: "请选择下一步操作",
            options: ["批准发布", "暂缓发布"],
            recommend: 0,
            about: "prod deploy",
          },
        ],
        notice: [
          {
            key: "precheck-ok",
            title: "预检已通过",
            text: "需要人工知悉",
            fyi: false,
          },
        ],
      },
    });
    await rt.close();

    // Status should list both open cards and spending
    const statusRes = await invokeCli(["status", "--json"], env);
    assert.equal(statusRes.code, 0, statusRes.stderr);
    const snap = JSON.parse(statusRes.stdout) as {
      cards: Array<{ card: number; kind: string; status: string }>;
      spending: { today: { input: number; output: number } };
    };
    const askCard = snap.cards.find((c) => c.kind === "ask");
    const noticeCard = snap.cards.find((c) => c.kind === "notice");
    assert.ok(askCard);
    assert.ok(noticeCard);
    assert.equal(snap.spending.today.input, 100);
    assert.equal(snap.spending.today.output, 40);

    // Answer the ask card with --choice 0
    const ansRes = await invokeCli(
      ["answer", String(askCard.card), "--choice", "0", "--json"],
      env,
    );
    assert.equal(ansRes.code, 0, ansRes.stderr);
    const ansJson = JSON.parse(ansRes.stdout) as {
      card: { status: string; chosen: string };
      run: number;
    };
    assert.equal(ansJson.card.status, "decided");
    assert.equal(ansJson.card.chosen, "批准发布");
    assert.ok(ansJson.run > firstRunId);

    // Answering same card twice must fail
    const ansAgain = await invokeCli(
      ["answer", String(askCard.card), "--choice", "1", "--json"],
      env,
    );
    assert.equal(ansAgain.code, 1);

    // Resolve the notice card
    const resolveRes = await invokeCli(
      ["resolve", String(noticeCard.card), "--reason", "已阅知悉", "--json"],
      env,
    );
    assert.equal(resolveRes.code, 0, resolveRes.stderr);
    const resolveJson = JSON.parse(resolveRes.stdout) as {
      card: { status: string; resolvedReason: string };
    };
    assert.equal(resolveJson.card.status, "closed");
    assert.equal(resolveJson.card.resolvedReason, "已阅知悉");

    // `why` on firstRunId should show receipt & created cards
    const whyRes = await invokeCli(["why", String(firstRunId), "--json"], env);
    assert.equal(whyRes.code, 0, whyRes.stderr);
    const whyJson = JSON.parse(whyRes.stdout) as {
      run: { run: number; status: string; session: string };
      cardsCreated: unknown[];
      events: unknown[];
    };
    assert.equal(whyJson.run.run, firstRunId);
    assert.equal(whyJson.run.status, "done");
    assert.equal(whyJson.run.session, "conv-session-123");
    assert.equal(whyJson.cardsCreated.length, 2);
    assert.equal(whyJson.events.length, 1);

    // Pause -> emit skipped event -> resume -> replay -> stop
    const pauseRes = await invokeCli(
      ["pause", "triage", "--reason", "维护窗口", "--json"],
      env,
    );
    assert.equal(pauseRes.code, 0, pauseRes.stderr);

    const skippedEmit = await invokeCli(
      [
        "emit",
        "issue.opened",
        "--source",
        "inbox",
        "--id",
        "paused-ev-1",
        "--subject",
        "issue#200",
        "--json",
      ],
      env,
    );
    assert.equal(skippedEmit.code, 0, skippedEmit.stderr);
    const skippedJson = JSON.parse(skippedEmit.stdout) as {
      paused: string[];
      runs: number[];
    };
    assert.deepEqual(skippedJson.paused, ["triage"]);
    assert.equal(skippedJson.runs.length, 0);

    const resumeRes = await invokeCli(["resume", "triage", "--json"], env);
    assert.equal(resumeRes.code, 0, resumeRes.stderr);
    const resumeJson = JSON.parse(resumeRes.stdout) as {
      wasPaused: boolean;
      skipped: Array<{ eventId: string }>;
    };
    assert.equal(resumeJson.wasPaused, true);
    assert.equal(resumeJson.skipped.length, 1);
    assert.equal(resumeJson.skipped[0]?.eventId, "paused-ev-1");

    const replayRes = await invokeCli(
      ["replay", "triage", "--since", "0", "--json"],
      env,
    );
    assert.equal(replayRes.code, 0, replayRes.stderr);
    const replayJson = JSON.parse(replayRes.stdout) as {
      replayedCount: number;
      runs: number[];
    };
    assert.equal(replayJson.replayedCount, 1);
    assert.equal(replayJson.runs.length, 1);

    // Second replay must not duplicate
    const replay2Res = await invokeCli(["replay", "triage", "--json"], env);
    assert.equal(replay2Res.code, 0, replay2Res.stderr);
    assert.equal(
      (JSON.parse(replay2Res.stdout) as { replayedCount: number })
        .replayedCount,
      0,
    );

    // Manual `run` then `stop`
    const runRes = await invokeCli(
      ["run", "triage", "--subject", "issue#300", "--json"],
      env,
    );
    assert.equal(runRes.code, 0, runRes.stderr);
    const manualRunId = (JSON.parse(runRes.stdout) as { run: number }).run;

    const stopRes = await invokeCli(
      ["stop", String(manualRunId), "--json"],
      env,
    );
    assert.equal(stopRes.code, 0, stopRes.stderr);
    const stopJson = JSON.parse(stopRes.stdout) as {
      changed: boolean;
      run: { status: string };
    };
    assert.equal(stopJson.changed, true);
    assert.equal(stopJson.run.status, "cancelled");
  });

  it("prefers Sidecar IPC when running and supports ingest.token for emit, falling back when IPC is unreachable", async () => {
    const home = makeTempHome();
    const rulesPath = path.join(home, "rules.json");
    writeFileSync(rulesPath, JSON.stringify(makeSampleConfig()), "utf8");

    const rt = new HubRuntime({
      autoloopHome: home,
      enableSupervisor: false,
    });
    runtimes.push(rt);
    rt.configureRules(makeSampleConfig());

    const server = await startIpcServer({
      runtime: rt,
      autoloopHome: home,
      rulesFilePath: rulesPath,
    });
    servers.push(server);

    const ownerEnv = { ...process.env, AUTOLOOP_HOME: home };

    // 1. IPC mode `emit` via owner.token
    const ipcEmit = await invokeCli(
      [
        "emit",
        "issue.opened",
        "--source",
        "inbox",
        "--id",
        "ipc-ev-1",
        "--subject",
        "issue#500",
        "--json",
      ],
      ownerEnv,
    );
    assert.equal(ipcEmit.code, 0, ipcEmit.stderr);
    const ipcEmitJson = JSON.parse(ipcEmit.stdout) as {
      mode: string;
      runs: number[];
    };
    assert.equal(ipcEmitJson.mode, "ipc");
    assert.equal(ipcEmitJson.runs.length, 1);
    const runId = ipcEmitJson.runs[0]!;

    // 2. Subagent context (`AUTOLOOP_RUN_ID`) uses ingest.token for `emit` over IPC
    const subagentEnv = {
      ...process.env,
      AUTOLOOP_HOME: home,
      AUTOLOOP_RUN_ID: "99",
    };
    const subEmit = await invokeCli(
      [
        "emit",
        "issue.opened",
        "--source",
        "inbox",
        "--id",
        "ipc-ev-2",
        "--subject",
        "issue#501",
        "--json",
      ],
      subagentEnv,
    );
    assert.equal(subEmit.code, 0, subEmit.stderr);
    assert.equal((JSON.parse(subEmit.stdout) as { mode: string }).mode, "ipc");

    // 3. IPC mode `status` (including --before/--limit & human-readable output), `explain`, `why`, `pause`, `resume`, `stop`
    const ipcStatus = await invokeCli(
      ["status", "--json", "--limit", "1", "--before", String(runId + 1)],
      ownerEnv,
    );
    assert.equal(ipcStatus.code, 0, ipcStatus.stderr);
    const ipcStatusJson = JSON.parse(ipcStatus.stdout) as {
      mode: string;
      runs: Array<{ run: number }>;
    };
    assert.equal(ipcStatusJson.mode, "ipc");
    assert.equal(ipcStatusJson.runs.length, 1);

    const humanStatus = await invokeCli(["status"], ownerEnv);
    assert.equal(humanStatus.code, 0, humanStatus.stderr);
    assert.ok(humanStatus.stdout.includes("Sidecar IPC"));
    assert.ok(humanStatus.stdout.includes("待批奏折卡片"));
    assert.ok(humanStatus.stdout.includes("流水线状态矩阵"));
    assert.ok(humanStatus.stdout.includes("Token 消耗统计"));

    const ipcWhy = await invokeCli(["why", String(runId), "--json"], ownerEnv);
    assert.equal(ipcWhy.code, 0, ipcWhy.stderr);
    assert.equal((JSON.parse(ipcWhy.stdout) as { mode: string }).mode, "ipc");

    const humanWhy = await invokeCli(["why", String(runId)], ownerEnv);
    assert.equal(humanWhy.code, 0, humanWhy.stderr);
    assert.ok(humanWhy.stdout.includes(`轮次 #${runId} 因果追溯报告`));

    const ipcExplain = await invokeCli(["explain", "--json"], ownerEnv);
    assert.equal(ipcExplain.code, 0, ipcExplain.stderr);
    assert.equal(
      (JSON.parse(ipcExplain.stdout) as { mode: string }).mode,
      "ipc",
    );

    const futureIso = new Date(Date.now() + 3600_000).toISOString();
    const ipcPause = await invokeCli(
      ["pause", "triage", "--reason", "timed", "--until", futureIso, "--json"],
      ownerEnv,
    );
    assert.equal(ipcPause.code, 0, ipcPause.stderr);
    const pauseJson = JSON.parse(ipcPause.stdout) as {
      mode: string;
      until: string | null;
    };
    assert.equal(pauseJson.mode, "ipc");
    assert.ok(pauseJson.until);

    const ipcResume = await invokeCli(["resume", "triage", "--json"], ownerEnv);
    assert.equal(ipcResume.code, 0, ipcResume.stderr);
    assert.equal(
      (JSON.parse(ipcResume.stdout) as { mode: string }).mode,
      "ipc",
    );

    const ipcStop = await invokeCli(
      ["stop", String(runId), "--json"],
      ownerEnv,
    );
    assert.equal(ipcStop.code, 0, ipcStop.stderr);
    assert.equal((JSON.parse(ipcStop.stdout) as { mode: string }).mode, "ipc");

    // 3b. When only ingest.token is present (owner.token deleted), `emit` still succeeds over IPC
    rmSync(path.join(home, "owner.token"), { force: true });
    const ingestOnlyEmit = await invokeCli(
      [
        "emit",
        "issue.opened",
        "--source",
        "inbox",
        "--id",
        "ipc-ev-ingest-only",
        "--json",
      ],
      ownerEnv,
    );
    assert.equal(ingestOnlyEmit.code, 0, ingestOnlyEmit.stderr);
    assert.equal(
      (JSON.parse(ingestOnlyEmit.stdout) as { mode: string }).mode,
      "ipc",
    );

    // 4. Close IPC server leaving stale ipc.json -> CLI should seamlessly fall back to SQLite
    await server.close();
    await rt.close();
    // Write a stale ipc.json pointing to the closed port to simulate crashed sidecar
    writeFileSync(
      path.join(home, "ipc.json"),
      JSON.stringify({ host: server.host, port: server.port, pid: 999999 }),
      "utf8",
    );

    const fallbackStatus = await invokeCli(["status", "--json"], ownerEnv);
    assert.equal(fallbackStatus.code, 0, fallbackStatus.stderr);
    const fbJson = JSON.parse(fallbackStatus.stdout) as {
      mode: string;
      runs: Array<{ run: number; status: string }>;
    };
    assert.equal(fbJson.mode, "local-fallback");
    const stoppedRun = fbJson.runs.find((r) => r.run === runId);
    assert.equal(stoppedRun?.status, "cancelled");

    // Ensure `openStore` closes cleanly even if DB was initialized by HubRuntime
    const dbVerify = openStore(path.join(home, "hub.db"));
    dbVerify.close();
  });

  it("bin/autoloop.mjs is executable and runs check via subprocess", async () => {
    const binPath = path.join(REPO_ROOT, "bin", "autoloop.mjs");
    accessSync(binPath, constants.X_OK);
    const firstLine = readFileSync(binPath, "utf8").split("\n")[0];
    assert.equal(
      firstLine,
      "#!/usr/bin/env -S node --disable-warning=ExperimentalWarning",
    );

    const home = makeTempHome();
    const rulesPath = path.join(home, "rules.json");
    writeFileSync(rulesPath, JSON.stringify(makeSampleConfig()), "utf8");

    const { stdout } = await execFileAsync(binPath, ["check", "--json"], {
      env: { ...process.env, AUTOLOOP_HOME: home },
    });
    const parsed = JSON.parse(stdout) as { valid: boolean; rulesCount: number };
    assert.equal(parsed.valid, true);
    assert.equal(parsed.rulesCount, 3);
  });

  it("blocks owner admin commands under subagent context (both IPC and local fallback) while allowing read/emit", async () => {
    const home = makeTempHome();
    const rulesPath = path.join(home, "rules.json");
    writeFileSync(rulesPath, JSON.stringify(makeSampleConfig()), "utf8");

    // Seed an open ask card in hub.db
    const rt = new HubRuntime({
      autoloopHome: home,
      enableSupervisor: false,
      now: () => Date.now(),
    });
    runtimes.push(rt);
    rt.configureRules(makeSampleConfig());
    rt.ingestEvent("inbox", {
      id: "subagent-seed-1",
      type: "issue.opened",
      subject: "issue#900",
    });
    const claim = rt.dispatch<{
      jobs: Array<{ run: number; token: string }>;
    }>({
      type: "claimWork",
      claimId: "worker-sub",
      capacity: 2,
      running: [],
    });
    const job = claim.jobs[0]!;
    rt.dispatch({
      type: "markStarted",
      run: job.run,
      token: job.token,
      session: "conv-sub-1",
    });
    rt.dispatch({
      type: "submitResult",
      run: job.run,
      token: job.token,
      result: {
        outcome: "done",
        summary: "waiting for user",
        session: "conv-sub-1",
        ask: [
          {
            key: "sub-ask",
            title: "需要人工批复",
            text: "请选择",
            options: ["同意", "拒绝"],
            recommend: 0,
            about: "subagent isolation",
          },
        ],
      },
    });
    const cardId = rt.getState().cards[0]!.card;

    const server = await startIpcServer({
      runtime: rt,
      autoloopHome: home,
      rulesFilePath: rulesPath,
    });
    servers.push(server);

    const subagentRunEnv = {
      ...process.env,
      AUTOLOOP_HOME: home,
      AUTOLOOP_RUN_ID: String(job.run),
    };
    const subagentGuardEnv = {
      ...process.env,
      AUTOLOOP_HOME: home,
      AUTOLOOP_GUARD_FILE: path.join(home, "guard.json"),
    };

    // 1. IPC mode: subagent context must reject `answer` and other owner admin commands
    for (const badEnv of [subagentRunEnv, subagentGuardEnv]) {
      const ansDeny = await invokeCli(
        ["answer", String(cardId), "--choice", "0", "--json"],
        badEnv,
      );
      assert.equal(ansDeny.code, 1);
      const errObj = JSON.parse(ansDeny.stderr) as { code: string };
      assert.equal(errObj.code, "FORBIDDEN_SUBAGENT_ADMIN");
    }
    for (const blockedCmd of [
      ["resolve", String(cardId), "--reason", "self", "--json"],
      ["pause", "triage", "--json"],
      ["resume", "triage", "--json"],
      ["replay", "triage", "--json"],
      ["run", "triage", "--json"],
      ["stop", String(job.run), "--json"],
      ["try", "--auto", "--json"],
    ]) {
      const res = await invokeCli(blockedCmd, subagentRunEnv);
      assert.equal(res.code, 1, `expected ${blockedCmd[0]} to be blocked`);
      assert.equal(
        (JSON.parse(res.stderr) as { code: string }).code,
        "FORBIDDEN_SUBAGENT_ADMIN",
      );
    }

    // Read-only & controlled emit remain allowed over IPC using ingest.token
    const ipcStatus = await invokeCli(["status", "--json"], subagentRunEnv);
    assert.equal(ipcStatus.code, 0, ipcStatus.stderr);
    assert.equal(
      (JSON.parse(ipcStatus.stdout) as { mode: string }).mode,
      "ipc",
    );
    const ipcEmit = await invokeCli(
      [
        "emit",
        "issue.updated",
        "--source",
        "inbox",
        "--id",
        "sub-ev-1",
        "--json",
      ],
      subagentRunEnv,
    );
    assert.equal(ipcEmit.code, 0, ipcEmit.stderr);

    // 2. Local SQLite fallback mode: subagent context must still reject `answer`
    await server.close();
    await rt.close();
    rmSync(path.join(home, "ipc.json"), { force: true });

    const fallbackDeny = await invokeCli(
      ["answer", String(cardId), "--choice", "0", "--json"],
      subagentRunEnv,
    );
    assert.equal(fallbackDeny.code, 1);
    assert.equal(
      (JSON.parse(fallbackDeny.stderr) as { code: string }).code,
      "FORBIDDEN_SUBAGENT_ADMIN",
    );

    // Card must remain open after blocked attempts
    const checkSnap = await invokeCli(["status", "--json"], {
      ...process.env,
      AUTOLOOP_HOME: home,
    });
    assert.equal(checkSnap.code, 0, checkSnap.stderr);
    const openCards = (
      JSON.parse(checkSnap.stdout) as {
        cards: Array<{ card: number; status: string }>;
      }
    ).cards;
    assert.equal(openCards.find((c) => c.card === cardId)?.status, "open");
  });

  it("runCli dispatches `try --auto --json` and maps TryWizardResult.ok to exit code", async () => {
    const home = makeTempHome();
    const env = { ...process.env, AUTOLOOP_HOME: home };
    const tryRes = await invokeCli(["try", "--auto", "--demo", "--json"], env);
    assert.equal(tryRes.code, 0, tryRes.stderr);
    const parsed = JSON.parse(tryRes.stdout) as {
      ok: boolean;
      zeroActiveRunsBeforeAnswer: boolean;
      sameSessionResumed: boolean;
      finalCardStatus: string;
    };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.zeroActiveRunsBeforeAnswer, true);
    assert.equal(parsed.sameSessionResumed, true);
    assert.equal(parsed.finalCardStatus, "done");

    // Non-zero exit when TryWizardResult.ok is false (e.g. session mismatch -> sameSessionResumed=false)
    const failHome = makeTempHome();
    const failEnv = { ...process.env, AUTOLOOP_HOME: failHome };
    const mismatchAgy = path.join(failHome, "mismatch-agy.mjs");
    writeFileSync(
      mismatchAgy,
      [
        "#!/usr/bin/env node",
        "const args = process.argv.slice(2);",
        "const isResume = args.includes('--conversation');",
        "const conv = isResume ? 'conv-different-2' : 'conv-initial-1';",
        "const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
        "emit({ type: 'init', conversationId: conv, model: 'gemini-4-hydrogen-high' });",
        "if (!isResume) {",
        "  const r = { ask: [{ key: 'k1', title: 't', text: 'x', options: ['a', 'b'], recommend: 0, about: 'a' }] };",
        "  emit({ type: 'assistant', conversationId: conv, text: '等待选择\\n\\n```agent-autoloop\\n' + JSON.stringify(r) + '\\n```' });",
        "} else {",
        "  emit({ type: 'assistant', conversationId: conv, text: '完成\\n\\n```agent-autoloop\\n{}\\n```' });",
        "}",
        "emit({ type: 'result', conversationId: conv, status: 'completed', usage: { input: 10, output: 5 } });",
      ].join("\n"),
      { encoding: "utf8", mode: 0o755 },
    );

    const failRes = await invokeCli(
      ["try", "--auto", "--agy-bin", mismatchAgy, "--json"],
      failEnv,
    );
    assert.equal(failRes.code, 1, failRes.stderr);
    const failJson = JSON.parse(failRes.stdout) as {
      ok: boolean;
      sameSessionResumed: boolean;
    };
    assert.equal(failJson.ok, false);
    assert.equal(failJson.sameSessionResumed, false);
  });
});

describe("Antigravity Plugin Manifest, Rules, and SVG Logo", () => {
  it("plugin.json contains only valid Antigravity top-level fields and 3 suggestedPrompts", () => {
    const allowedTopLevel = new Set([
      "name",
      "displayName",
      "description",
      "version",
      "logo",
      "suggestedPrompts",
      "author",
      "homepage",
      "repository",
      "disabled",
    ]);

    const manifestPath = path.join(REPO_ROOT, "plugin.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;

    for (const key of Object.keys(manifest)) {
      assert.ok(
        allowedTopLevel.has(key),
        `plugin.json contains unknown top-level field: ${key}`,
      );
    }

    assert.equal(manifest.name, "autoloop");
    assert.equal(typeof manifest.displayName, "string");
    assert.ok((manifest.displayName as string).length > 0);
    assert.equal(typeof manifest.description, "string");
    assert.ok((manifest.description as string).length > 0);
    const pkg = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
    ) as { version: string };
    assert.match(String(manifest.version), /^\d+\.\d+\.\d+$/);
    assert.equal(manifest.version, pkg.version);
    assert.equal(manifest.logo, "assets/logo.svg");
    assert.ok(Array.isArray(manifest.suggestedPrompts));
    assert.equal((manifest.suggestedPrompts as unknown[]).length, 3);
    for (const prompt of manifest.suggestedPrompts as unknown[]) {
      assert.equal(typeof prompt, "string");
      assert.ok((prompt as string).trim().length > 0);
    }

    const logoPath = path.join(REPO_ROOT, manifest.logo as string);
    assert.ok(statSync(logoPath).isFile());
  });

  it("rules/AGENTS.md is plain Markdown under 2KB without YAML frontmatter", () => {
    const agentsPath = path.join(REPO_ROOT, "rules", "AGENTS.md");
    const raw = readFileSync(agentsPath, "utf8");
    const byteLen = Buffer.byteLength(raw, "utf8");
    assert.ok(
      byteLen > 0 && byteLen < 2048,
      `rules/AGENTS.md must be < 2048 bytes, got ${byteLen}`,
    );
    assert.equal(
      raw.trimStart().startsWith("---"),
      false,
      "rules/AGENTS.md must not contain YAML frontmatter",
    );
    assert.ok(
      raw.includes("autoloop_"),
      "should reference autoloop_* MCP tools",
    );
    assert.ok(
      raw.includes("sidecar://autoloop/hub/"),
      "should reference [Autoloop 工作台](sidecar://autoloop/hub/) capsule",
    );
    assert.ok(
      raw.includes("autoloop-admin"),
      "should mention autoloop-admin skill",
    );
    assert.ok(
      raw.includes("recipe-idea-to-sop"),
      "should mention recipe-idea-to-sop skill",
    );
  });

  it("assets/logo.svg is a square 128x128 transparent SVG with valid structure", () => {
    const svgPath = path.join(REPO_ROOT, "assets", "logo.svg");
    const svg = readFileSync(svgPath, "utf8");
    assert.ok(svg.includes("<svg"), "must have <svg root element");
    assert.ok(svg.includes("</svg>"), "must close </svg>");
    assert.ok(
      svg.includes('viewBox="0 0 128 128"'),
      "must declare square viewBox 0 0 128 128",
    );
    // Must not contain full-bleed opaque background rect
    assert.equal(
      /<rect[^>]*width="128"[^>]*height="128"/i.test(svg),
      false,
      "must keep transparent background without full-bleed 128x128 rect",
    );
  });
});
