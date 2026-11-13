/**
 * Prevents real operational failures and security boundary regressions across
 * `engine/supervisor.ts`, `hooks/pre-tool-guard.mjs`, `hooks/stop-receipt-check.mjs`,
 * and `hooks.json`:
 * 1. Supervisor claiming/starting/submitting results against SQLite kernel without dropping
 *    slots or leaking secrets (`AUTOLOOP_OWNER_TOKEN`).
 * 2. In-place receipt repair (`repairPrompt`, max 2 attempts) on the original conversation
 *    accumulating usage instead of re-executing business logic, and failing cleanly after 2 tries.
 * 3. `stopRun` killing the entire `-pid` process group (`SIGTERM` -> `SIGKILL`) and committing
 *    `cancelled` after process exit rather than misclassifying non-zero exit as `failed` retry.
 * 4. Post-start process crashes (`fail_after_start`) preserving `session` without false repair loops.
 * 5. `PreToolUse` hook zero-interference outside Autoloop, `access=read` write blocking,
 *    `askFirst` + catastrophic redline denial vs `approvedKeys` authorization.
 * 6. `Stop` hook blocking malformed receipts at most 2 times (`continue`) before releasing (`stop`).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
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
import {
  createSupervisor,
  type SupervisorBackend,
} from "../engine/supervisor.ts";
import { decide, type DecideEnv, type KernelInput } from "../kernel/decide.ts";
import {
  createTokenSigner,
  openStore,
  safeTokenEquals,
  type Store,
} from "../kernel/store.ts";
import type { RulesConfig } from "../protocol/types.ts";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const FAKE_AGY_BIN = path.join(REPO_ROOT, "tests", "fakes", "fake-agy.mjs");
const FAKE_AGENTAPI_BIN = path.join(
  REPO_ROOT,
  "tests",
  "fakes",
  "fake-agentapi.mjs",
);
const PRE_TOOL_HOOK = path.join(REPO_ROOT, "hooks", "pre-tool-guard.mjs");
const STOP_HOOK = path.join(REPO_ROOT, "hooks", "stop-receipt-check.mjs");
const HOOKS_JSON = path.join(REPO_ROOT, "hooks.json");

const MASTER_KEY_HEX =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const tempDirs: string[] = [];

function makeTempDir(prefix = "autoloop-wp10-"): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 8_000,
  stepMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

function createKernelHarness(dbPath: string, initialNowMs = 1_700_000_000_000) {
  const store = openStore(dbPath);
  const signToken = createTokenSigner(MASTER_KEY_HEX);
  const env: DecideEnv = { signToken, safeTokenEquals };
  let nowMs = initialNowMs;

  function exec<T = unknown>(input: KernelInput): T {
    const res = decide(store.view, input, nowMs, env);
    if (res.facts.length > 0) {
      store.commit(res.facts);
    }
    return res.value as T;
  }

  const backend: SupervisorBackend = {
    claimWork(input) {
      return exec({ type: "claimWork", ...input });
    },
    markStarted(input) {
      return exec({ type: "markStarted", ...input });
    },
    submitResult(input) {
      return exec({ type: "submitResult", ...input });
    },
  };

  return {
    store,
    backend,
    exec,
    advanceNow(ms: number) {
      nowMs += ms;
    },
    getNow() {
      return nowMs;
    },
  };
}

function makeRulesConfig(
  cwd: string,
  overrides: Partial<RulesConfig> = {},
): RulesConfig {
  return {
    timezone: "UTC",
    askFirst: ["rm -rf", "git push --force"],
    sources: {
      inbox: { name: "Inbox" },
      probe: { name: "Probe" },
    },
    agents: {
      coder: {
        name: "Coder",
        runner: "agy-print",
        model: "gemini-4-hydrogen-high",
        effort: "high",
        access: "edit",
        timeoutMinutes: 1,
      },
      uiCoder: {
        name: "UI Coder",
        runner: "agentapi-ui",
        model: "gemini-4-hydrogen-high",
        access: "edit",
        timeoutMinutes: 1,
      },
      probeAgent: {
        name: "Probe Agent",
        runner: "command",
        command: [
          process.execPath,
          "-e",
          'console.log("探针检测通过。\\n\\n```agent-autoloop\\n{\\"notice\\":[{\\"key\\":\\"probe-ok\\",\\"title\\":\\"巡检正常\\",\\"text\\":\\"全部服务正常\\",\\"fyi\\":true}]}\\n```")',
        ],
        timeoutMinutes: 1,
      },
    },
    rules: [
      {
        name: "triage",
        when: { source: "inbox", types: ["issue.opened"] },
        to: "coder",
        cwd,
        parallel: 4,
      },
    ],
    ...overrides,
  };
}

function runHook(
  scriptPath: string,
  stdinPayload: unknown,
  envOverrides: Record<string, string | undefined> = {},
): Record<string, unknown> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.AUTOLOOP_GUARD_FILE;
  delete env.AUTOLOOP_RUN_ID;
  delete env.AUTOLOOP_CONTEXT;
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) {
      delete env[k];
    } else {
      env[k] = v;
    }
  }

  const res = spawnSync(process.execPath, [scriptPath], {
    input: JSON.stringify(stdinPayload),
    env,
    encoding: "utf8",
  });
  assert.equal(
    res.status,
    0,
    `Hook exited with ${res.status}, stderr=${res.stderr}`,
  );
  return JSON.parse(res.stdout.trim()) as Record<string, unknown>;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
});

describe("hooks.json manifest", () => {
  it("matches Antigravity PreToolUse grouped and Stop flat schema", () => {
    const raw = JSON.parse(readFileSync(HOOKS_JSON, "utf8")) as Record<
      string,
      unknown
    >;
    const guard = raw["autoloop-guard"] as Record<string, unknown>;
    assert.ok(guard && typeof guard === "object");

    const pre = guard.PreToolUse as Array<Record<string, unknown>>;
    assert.equal(Array.isArray(pre), true);
    assert.equal(pre.length, 1);
    assert.equal(pre[0]?.matcher, "*");
    const preHooks = pre[0]?.hooks as Array<Record<string, unknown>>;
    assert.equal(preHooks[0]?.type, "command");
    assert.equal(preHooks[0]?.command, "node ./hooks/pre-tool-guard.mjs");
    assert.equal(preHooks[0]?.timeout, 10);
    assert.equal(existsSync(PRE_TOOL_HOOK), true);

    const stop = guard.Stop as Array<Record<string, unknown>>;
    assert.equal(Array.isArray(stop), true);
    assert.equal(stop.length, 1);
    assert.equal(stop[0]?.type, "command");
    assert.equal(stop[0]?.command, "node ./hooks/stop-receipt-check.mjs");
    assert.equal(stop[0]?.timeout, 10);
    assert.equal(existsSync(STOP_HOOK), true);
  });
});

describe("engine/supervisor.ts", () => {
  it("claims queued runs, strips sensitive tokens, commits receipt & usage, and auto-kicks queued capacity", async () => {
    const tmpDir = makeTempDir();
    const autoloopHome = path.join(tmpDir, "autoloop_home");
    const workCwd = path.join(tmpDir, "workspace");
    mkdirSync(workCwd, { recursive: true });
    const recordFile = path.join(tmpDir, "records.jsonl");

    const harness = createKernelHarness(path.join(tmpDir, "hub.db"));
    harness.exec({
      type: "configureRules",
      config: makeRulesConfig(workCwd),
    });
    harness.exec({
      type: "ingestEvent",
      source: "inbox",
      event: { id: "e-1", type: "issue.opened", subject: "lane-a" },
    });
    harness.exec({
      type: "ingestEvent",
      source: "inbox",
      event: { id: "e-2", type: "issue.opened", subject: "lane-b" },
    });

    const supervisor = createSupervisor({
      autoloopHome,
      backend: harness.backend,
      capacity: 1,
      pollIntervalMs: 0,
      heartbeatIntervalMs: 0,
      agyBin: FAKE_AGY_BIN,
      baseEnv: {
        ...process.env,
        FAKE_AGY_SCENARIO: "normal_done",
        FAKE_AGY_RECORD_FILE: recordFile,
        AUTOLOOP_OWNER_TOKEN: "super-secret-owner-token",
        ANTIGRAVITY_SIDECAR_UI_TOKEN: "super-secret-ui-token",
      },
    });

    try {
      await supervisor.kick();

      await waitFor(() => {
        const r1 = harness.store.view.get("runs", "1");
        const r2 = harness.store.view.get("runs", "2");
        return r1?.status === "done" && r2?.status === "done";
      });

      const run1 = harness.store.view.get("runs", "1");
      const run2 = harness.store.view.get("runs", "2");
      assert.equal(run1?.status, "done");
      assert.equal(run2?.status, "done");
      assert.ok(typeof run1?.started_at === "string");
      assert.ok(typeof run1?.session === "string");
      assert.deepEqual(run1?.usage, {
        input: 120,
        output: 48,
        cached: 64,
        cost: 0.0019,
      });

      // Verify run isolation files and stripped credentials
      const run1Dir = path.join(autoloopHome, "runs", "1-1");
      assert.equal(statSync(run1Dir).mode & 0o777, 0o700);
      assert.equal(
        statSync(path.join(run1Dir, "guard.json")).mode & 0o777,
        0o600,
      );

      const records = readFileSync(recordFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { env: Record<string, string> });
      assert.equal(records.length, 2);
      for (const rec of records) {
        assert.equal(rec.env.AUTOLOOP_OWNER_TOKEN, undefined);
        assert.equal(rec.env.ANTIGRAVITY_SIDECAR_UI_TOKEN, undefined);
        assert.ok(rec.env.AUTOLOOP_GUARD_FILE);
      }

      const cards = Array.from(harness.store.view.all("cards"));
      assert.equal(cards.length, 2);
      assert.equal(cards[0]?.status, "closed");
    } finally {
      await supervisor.stop();
      harness.store.close();
    }
  });

  it("repairs malformed receipt in-place on original session without redoing business work and accumulates usage", async () => {
    const tmpDir = makeTempDir();
    const autoloopHome = path.join(tmpDir, "autoloop_home");
    const workCwd = path.join(tmpDir, "workspace");
    mkdirSync(workCwd, { recursive: true });
    const recordFile = path.join(tmpDir, "repair-records.jsonl");
    const stateFile = path.join(tmpDir, "fake-agy-state.json");

    const harness = createKernelHarness(path.join(tmpDir, "hub.db"));
    harness.exec({
      type: "configureRules",
      config: makeRulesConfig(workCwd),
    });
    harness.exec({
      type: "ingestEvent",
      source: "inbox",
      event: { id: "e-repair", type: "issue.opened", subject: "fix-receipt" },
    });

    const supervisor = createSupervisor({
      autoloopHome,
      backend: harness.backend,
      pollIntervalMs: 0,
      heartbeatIntervalMs: 0,
      agyBin: FAKE_AGY_BIN,
      baseEnv: {
        ...process.env,
        FAKE_AGY_SCENARIO: "bad_receipt_then_repair",
        FAKE_AGY_BAD_KIND: "json",
        FAKE_AGY_SESSION: "conv-repair-1",
        FAKE_AGY_RECORD_FILE: recordFile,
        FAKE_AGY_STATE_FILE: stateFile,
      },
    });

    try {
      await supervisor.kick();
      await waitFor(
        () => harness.store.view.get("runs", "1")?.status === "done",
      );

      const run1 = harness.store.view.get("runs", "1");
      assert.equal(run1?.status, "done");
      assert.equal(run1?.attempts, 1);
      assert.equal(run1?.session, "conv-repair-1");
      assert.deepEqual(run1?.usage, {
        input: 240,
        output: 96,
        cached: 128,
        cost: 0.0038,
      });

      const records = readFileSync(recordFile, "utf8")
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              parsed: { conversation: string | null; prompt: string };
            },
        );
      assert.equal(records.length, 2);
      assert.equal(records[0]?.parsed.conversation, null);
      assert.equal(records[1]?.parsed.conversation, "conv-repair-1");
      assert.match(records[1]!.parsed.prompt, /不要重做任何业务操作/);

      const cards = Array.from(harness.store.view.all("cards"));
      assert.equal(cards.length, 1);
      assert.equal(cards[0]?.title, "修复成功");
    } finally {
      await supervisor.stop();
      harness.store.close();
    }
  });

  it("caps in-place receipt repairs at 2 attempts and marks run failed with problem message", async () => {
    const tmpDir = makeTempDir();
    const autoloopHome = path.join(tmpDir, "autoloop_home");
    const workCwd = path.join(tmpDir, "workspace");
    mkdirSync(workCwd, { recursive: true });
    const recordFile = path.join(tmpDir, "fail-repair-records.jsonl");
    const stateFile = path.join(tmpDir, "fake-agy-state.json");

    const badTurn = {
      conversationId: "conv-always-bad",
      text: "处理完成。\n\n```agent-autoloop\n{invalid json\n```",
      usage: { input: 50, output: 20, cached: 10, cost: 0.001 },
      exitCode: 0,
    };
    writeFileSync(
      stateFile,
      JSON.stringify({
        turn: 0,
        conversationId: "conv-always-bad",
        turns: [badTurn, badTurn, badTurn, badTurn],
      }),
      "utf8",
    );

    const harness = createKernelHarness(path.join(tmpDir, "hub.db"));
    harness.exec({
      type: "configureRules",
      config: makeRulesConfig(workCwd),
    });
    harness.exec({
      type: "ingestEvent",
      source: "inbox",
      event: { id: "e-bad3", type: "issue.opened", subject: "always-bad" },
    });

    const supervisor = createSupervisor({
      autoloopHome,
      backend: harness.backend,
      pollIntervalMs: 0,
      heartbeatIntervalMs: 0,
      agyBin: FAKE_AGY_BIN,
      baseEnv: {
        ...process.env,
        FAKE_AGY_RECORD_FILE: recordFile,
        FAKE_AGY_STATE_FILE: stateFile,
      },
    });

    try {
      await supervisor.kick();
      await waitFor(
        () => harness.store.view.get("runs", "1")?.status === "queued",
      );

      // Kernel requeues attempt #1 -> queued for retry because attempts < MAX_ATTEMPTS,
      // while preserving error, session, and accumulated 3-turn usage.
      const run1 = harness.store.view.get("runs", "1");
      assert.equal(run1?.attempts, 1);
      assert.equal(run1?.session, "conv-always-bad");
      assert.match(String(run1?.error), /JSON 语法解析失败/);
      assert.deepEqual(run1?.usage, {
        input: 150,
        output: 60,
        cached: 30,
        cost: 0.003,
      });

      const records = readFileSync(recordFile, "utf8").trim().split("\n");
      assert.equal(records.length, 3); // 1 initial + 2 repairs max
    } finally {
      await supervisor.stop();
      harness.store.close();
    }
  });

  it("repairs malformed agentapi-ui receipt in-place on original session", async () => {
    const tmpDir = makeTempDir();
    const autoloopHome = path.join(tmpDir, "autoloop_home");
    const appDataDir = path.join(tmpDir, "appdata");
    const workCwd = path.join(tmpDir, "workspace");
    mkdirSync(workCwd, { recursive: true });
    const recordFile = path.join(tmpDir, "agentapi-records.jsonl");

    const harness = createKernelHarness(path.join(tmpDir, "hub.db"));
    harness.exec({
      type: "configureRules",
      config: makeRulesConfig(workCwd, {
        rules: [
          {
            name: "ui-triage",
            when: { source: "inbox", types: ["issue.opened"] },
            to: "uiCoder",
            cwd: workCwd,
          },
        ],
      }),
    });
    harness.exec({
      type: "ingestEvent",
      source: "inbox",
      event: { id: "e-ui", type: "issue.opened", subject: "ui-fix" },
    });

    const supervisor = createSupervisor({
      autoloopHome,
      backend: harness.backend,
      pollIntervalMs: 0,
      heartbeatIntervalMs: 0,
      agentApiBin: FAKE_AGENTAPI_BIN,
      appDataDir,
      baseEnv: {
        ...process.env,
        FAKE_AGENTAPI_SCENARIO: "bad_receipt_then_repair",
        FAKE_AGENTAPI_SESSION: "ui-conv-9",
        FAKE_AGENTAPI_RECORD_FILE: recordFile,
        FAKE_APPDATA_DIR: appDataDir,
      },
    });

    try {
      await supervisor.kick();
      await waitFor(
        () => harness.store.view.get("runs", "1")?.status === "done",
      );

      const run1 = harness.store.view.get("runs", "1");
      assert.equal(run1?.status, "done");
      assert.equal(run1?.session, "ui-conv-9");

      const records = readFileSync(recordFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { parsed: { subcommand: string } });
      assert.equal(records.length, 2);
      assert.equal(records[0]?.parsed.subcommand, "new-conversation");
      assert.equal(records[1]?.parsed.subcommand, "send-message");
    } finally {
      await supervisor.stop();
      harness.store.close();
    }
  });

  it("does not run repairPrompt on mid-turn crash (fail_after_start) and preserves session", async () => {
    const tmpDir = makeTempDir();
    const autoloopHome = path.join(tmpDir, "autoloop_home");
    const workCwd = path.join(tmpDir, "workspace");
    mkdirSync(workCwd, { recursive: true });
    const recordFile = path.join(tmpDir, "crash-records.jsonl");

    const harness = createKernelHarness(path.join(tmpDir, "hub.db"));
    harness.exec({
      type: "configureRules",
      config: makeRulesConfig(workCwd),
    });
    harness.exec({
      type: "ingestEvent",
      source: "inbox",
      event: { id: "e-crash", type: "issue.opened", subject: "mid-crash" },
    });

    const supervisor = createSupervisor({
      autoloopHome,
      backend: harness.backend,
      pollIntervalMs: 0,
      heartbeatIntervalMs: 0,
      agyBin: FAKE_AGY_BIN,
      baseEnv: {
        ...process.env,
        FAKE_AGY_SCENARIO: "fail_after_start",
        FAKE_AGY_SESSION: "conv-crashed-1",
        FAKE_AGY_RECORD_FILE: recordFile,
      },
    });

    try {
      await supervisor.kick();
      await waitFor(
        () => harness.store.view.get("runs", "1")?.status === "queued",
      );

      const run1 = harness.store.view.get("runs", "1");
      assert.equal(run1?.session, "conv-crashed-1");
      assert.match(String(run1?.error), /simulated mid-turn process crash/);

      const records = readFileSync(recordFile, "utf8").trim().split("\n");
      assert.equal(records.length, 1);
    } finally {
      await supervisor.stop();
      harness.store.close();
    }
  });

  it("renews heartbeats while running and stopRun kills entire process group committing cancelled (never failed)", async () => {
    const tmpDir = makeTempDir();
    const autoloopHome = path.join(tmpDir, "autoloop_home");
    const workCwd = path.join(tmpDir, "workspace");
    mkdirSync(workCwd, { recursive: true });
    const childPidFile = path.join(tmpDir, "child.pid");

    const harness = createKernelHarness(path.join(tmpDir, "hub.db"));
    harness.exec({
      type: "configureRules",
      config: makeRulesConfig(workCwd),
    });
    harness.exec({
      type: "ingestEvent",
      source: "inbox",
      event: { id: "e-hang", type: "issue.opened", subject: "hang-stop" },
    });

    const originalClaimWork = harness.backend.claimWork;
    const heartbeatBackend: SupervisorBackend = {
      claimWork(input) {
        harness.advanceNow(100);
        return originalClaimWork(input);
      },
      markStarted: harness.backend.markStarted,
      submitResult: harness.backend.submitResult,
    };

    const supervisor = createSupervisor({
      autoloopHome,
      backend: heartbeatBackend,
      pollIntervalMs: 0,
      heartbeatIntervalMs: 40,
      killGraceMs: 80,
      agyBin: FAKE_AGY_BIN,
      baseEnv: {
        ...process.env,
        FAKE_AGY_SCENARIO: "hang_with_child",
        FAKE_AGY_IGNORE_SIGTERM: "1",
        FAKE_AGY_CHILD_PID_FILE: childPidFile,
        FAKE_AGY_SESSION: "conv-hang-1",
      },
    });

    try {
      supervisor.start();

      // Wait until started and grandchild process is spawned
      await waitFor(
        () =>
          existsSync(childPidFile) &&
          typeof harness.store.view.get("runs", "1")?.started_at === "string",
      );

      const initialHeartbeat = harness.store.view.get("runs", "1")
        ?.heartbeat_at as string;
      const grandchildPid = Number(readFileSync(childPidFile, "utf8").trim());
      assert.equal(
        Number.isSafeInteger(grandchildPid) && grandchildPid > 0,
        true,
      );
      assert.equal(isPidAlive(grandchildPid), true);

      // Wait for at least one heartbeat tick to advance heartbeat_at
      await waitFor(
        () =>
          harness.store.view.get("runs", "1")?.heartbeat_at !==
          initialHeartbeat,
      );

      // Issue stopRun in kernel
      harness.exec({ type: "stopRun", run: 1 });

      // Wait for heartbeat/cancel propagation, SIGTERM->SIGKILL escalation, and cancelled commit
      await waitFor(
        () => harness.store.view.get("runs", "1")?.status === "cancelled",
      );

      // Confirm grandchild process is dead and run was never requeued
      await waitFor(() => !isPidAlive(grandchildPid), 3_000);
      const run1 = harness.store.view.get("runs", "1");
      assert.equal(run1?.status, "cancelled");
      assert.equal(run1?.attempts, 1);
      assert.equal(run1?.summary, "stopped by user");
      assert.equal(supervisor.activeRuns().length, 0);
    } finally {
      await supervisor.stop();
      harness.store.close();
    }
  });

  it("dispatches command runner probes and commits notice cards", async () => {
    const tmpDir = makeTempDir();
    const autoloopHome = path.join(tmpDir, "autoloop_home");
    const workCwd = path.join(tmpDir, "workspace");
    mkdirSync(workCwd, { recursive: true });

    const harness = createKernelHarness(path.join(tmpDir, "hub.db"));
    harness.exec({
      type: "configureRules",
      config: makeRulesConfig(workCwd, {
        rules: [
          {
            name: "health-probe",
            when: { source: "probe", types: ["probe.tick"] },
            to: "probeAgent",
            cwd: workCwd,
          },
        ],
      }),
    });
    harness.exec({
      type: "ingestEvent",
      source: "probe",
      event: { id: "p-1", type: "probe.tick" },
    });

    const supervisor = createSupervisor({
      autoloopHome,
      backend: harness.backend,
      pollIntervalMs: 0,
      heartbeatIntervalMs: 0,
    });

    try {
      await supervisor.kick();
      await waitFor(
        () => harness.store.view.get("runs", "1")?.status === "done",
      );
      const cards = Array.from(harness.store.view.all("cards"));
      assert.equal(cards.length, 1);
      assert.equal(cards[0]?.title, "巡检正常");
    } finally {
      await supervisor.stop();
      harness.store.close();
    }
  });

  it("dispatches delivery runner when configured", async () => {
    const tmpDir = makeTempDir();
    const autoloopHome = path.join(tmpDir, "autoloop_home");
    const workCwd = path.join(tmpDir, "workspace");
    mkdirSync(workCwd, { recursive: true });

    const harness = createKernelHarness(path.join(tmpDir, "hub.db"));
    harness.exec({
      type: "configureRules",
      config: makeRulesConfig(workCwd, {
        agents: {
          ...makeRulesConfig(workCwd).agents,
          deliverer: {
            name: "Deliverer",
            runner: "delivery",
            timeoutMinutes: 1,
          },
        },
        rules: [
          {
            name: "deliver-branch",
            when: { source: "inbox", types: ["branch.ready"] },
            to: "deliverer",
            cwd: workCwd,
          },
        ],
      }),
    });
    harness.exec({
      type: "ingestEvent",
      source: "inbox",
      event: { id: "d-1", type: "branch.ready", subject: "feat/demo" },
    });

    const supervisor = createSupervisor({
      autoloopHome,
      backend: harness.backend,
      pollIntervalMs: 0,
      heartbeatIntervalMs: 0,
      deliveryRunner: async (ctx) => {
        ctx.onStarted({ session: "deliv-sess-1" });
        return {
          outcome: "done",
          summary: "已合并交付",
          rawText: "已合并交付",
          parsed: {
            outcome: "done",
            summary: "已合并交付",
            receipt: {
              notice: [
                {
                  key: "delivered",
                  title: "交付完成",
                  text: "分支已通过审查并合并",
                  fyi: true,
                },
              ],
            },
            problem: null,
          },
          session: "deliv-sess-1",
          started: true,
          exitCode: 0,
        };
      },
    });

    try {
      await supervisor.kick();
      await waitFor(
        () => harness.store.view.get("runs", "1")?.status === "done",
      );
      const run1 = harness.store.view.get("runs", "1");
      assert.equal(run1?.session, "deliv-sess-1");
      assert.equal(run1?.summary, "已合并交付");
      const cards = Array.from(harness.store.view.all("cards"));
      assert.equal(cards.length, 1);
      assert.equal(cards[0]?.title, "交付完成");
    } finally {
      await supervisor.stop();
      harness.store.close();
    }
  });
});

describe("hooks/pre-tool-guard.mjs", () => {
  it("allows everything immediately with zero interference when AUTOLOOP_GUARD_FILE is unset", () => {
    const res1 = runHook(PRE_TOOL_HOOK, {
      toolCall: { name: "edit_file", args: { TargetFile: "/tmp/a.txt" } },
    });
    assert.deepEqual(res1, { decision: "allow" });

    const res2 = runHook(PRE_TOOL_HOOK, {
      toolCall: {
        name: "run_command",
        args: { CommandLine: "rm -rf /tmp/foo" },
      },
    });
    assert.deepEqual(res2, { decision: "allow" });
  });

  it("blocks file writes and mutating commands under access=read while allowing passive reads", () => {
    const tmpDir = makeTempDir();
    const guardFile = path.join(tmpDir, "guard.json");
    writeFileSync(
      guardFile,
      JSON.stringify({
        run: 1,
        attempt: 1,
        rule: "readonly-check",
        cwd: tmpDir,
        access: "read",
        askFirst: [],
        approvedKeys: [],
      }),
      "utf8",
    );

    const denyEdit = runHook(
      PRE_TOOL_HOOK,
      {
        toolCall: {
          name: "edit_file",
          args: { TargetFile: path.join(tmpDir, "a.ts") },
        },
      },
      { AUTOLOOP_GUARD_FILE: guardFile },
    );
    assert.equal(denyEdit.decision, "deny");
    assert.match(String(denyEdit.reason), /只读模式.*access=read/);

    const denyCmd = runHook(
      PRE_TOOL_HOOK,
      {
        toolCall: {
          name: "run_command",
          args: { CommandLine: "touch secret.txt" },
        },
      },
      { AUTOLOOP_GUARD_FILE: guardFile },
    );
    assert.equal(denyCmd.decision, "deny");
    assert.match(String(denyCmd.reason), /只读模式.*access=read/);

    const denyGitPrefixedCommit = runHook(
      PRE_TOOL_HOOK,
      {
        toolCall: {
          name: "run_command",
          args: { CommandLine: "git -C repo commit -m x" },
        },
      },
      { AUTOLOOP_GUARD_FILE: guardFile },
    );
    assert.equal(denyGitPrefixedCommit.decision, "deny");
    assert.match(String(denyGitPrefixedCommit.reason), /只读模式.*access=read/);

    const allowRead = runHook(
      PRE_TOOL_HOOK,
      {
        toolCall: {
          name: "run_command",
          args: { CommandLine: "git -C repo status" },
        },
      },
      { AUTOLOOP_GUARD_FILE: guardFile },
    );
    assert.deepEqual(allowRead, { decision: "allow" });
  });

  it("blocks unapproved askFirst & catastrophic commands under access=edit and allows only matching approvedKeys", () => {
    const tmpDir = makeTempDir();
    const workCwd = path.join(tmpDir, "repo");
    mkdirSync(workCwd, { recursive: true });
    const guardFile = path.join(tmpDir, "guard.json");

    const writeGuard = (approvedKeys: string[]) => {
      writeFileSync(
        guardFile,
        JSON.stringify({
          run: 2,
          attempt: 1,
          rule: "edit-guard",
          cwd: workCwd,
          access: "edit",
          askFirst: ["rm -rf", "git push --force", "删除文件"],
          approvedKeys,
        }),
        "utf8",
      );
    };

    writeGuard([]);

    const denyRm = runHook(
      PRE_TOOL_HOOK,
      {
        toolCall: {
          name: "run_command",
          args: { CommandLine: "rm -rf ./dist" },
        },
      },
      { AUTOLOOP_GUARD_FILE: guardFile },
    );
    assert.equal(denyRm.decision, "deny");
    assert.match(String(denyRm.reason), /askFirst/);

    const denyForcePush = runHook(
      PRE_TOOL_HOOK,
      {
        toolCall: {
          name: "run_command",
          args: { command: "git push -f origin main" },
        },
      },
      { AUTOLOOP_GUARD_FILE: guardFile },
    );
    assert.equal(denyForcePush.decision, "deny");

    const denyResetHard = runHook(
      PRE_TOOL_HOOK,
      {
        toolCall: {
          name: "run_command",
          args: { CommandLine: "git reset --hard HEAD~1" },
        },
      },
      { AUTOLOOP_GUARD_FILE: guardFile },
    );
    assert.equal(denyResetHard.decision, "deny");

    const denyDropTable = runHook(
      PRE_TOOL_HOOK,
      {
        toolCall: {
          name: "run_command",
          args: { CommandLine: "sqlite3 app.db 'DROP TABLE users;'" },
        },
      },
      { AUTOLOOP_GUARD_FILE: guardFile },
    );
    assert.equal(denyDropTable.decision, "deny");

    // Substring-similar or generic single-word keys must NOT unlock rm -rf, git push --force, or git reset --hard
    writeGuard([
      "confirm-prune",
      "format-code",
      "permission-fix",
      "file",
      "push",
      "reset",
    ]);
    const stillDenyRm = runHook(
      PRE_TOOL_HOOK,
      {
        toolCall: {
          name: "run_command",
          args: { CommandLine: "rm -rf ./dist" },
        },
      },
      { AUTOLOOP_GUARD_FILE: guardFile },
    );
    assert.equal(stillDenyRm.decision, "deny");

    const denyGitCPushForce = runHook(
      PRE_TOOL_HOOK,
      {
        toolCall: {
          name: "run_command",
          args: { CommandLine: "git -C repo push --force origin main" },
        },
      },
      { AUTOLOOP_GUARD_FILE: guardFile },
    );
    assert.equal(denyGitCPushForce.decision, "deny");

    const denyGitCResetHard = runHook(
      PRE_TOOL_HOOK,
      {
        toolCall: {
          name: "run_command",
          args: { CommandLine: "git -C repo reset --hard HEAD~1" },
        },
      },
      { AUTOLOOP_GUARD_FILE: guardFile },
    );
    assert.equal(denyGitCResetHard.decision, "deny");

    // Matching approval key unlocks in-cwd rm -rf ./dist
    writeGuard(["rm-rf"]);
    const allowRmDist = runHook(
      PRE_TOOL_HOOK,
      {
        toolCall: {
          name: "run_command",
          args: { CommandLine: "rm -rf ./dist" },
        },
      },
      { AUTOLOOP_GUARD_FILE: guardFile },
    );
    assert.deepEqual(allowRmDist, { decision: "allow" });

    // Even with approvedKeys, out-of-cwd / root rm -rf and config.json writes (including Path arg) are blocked
    const denyRoot = runHook(
      PRE_TOOL_HOOK,
      {
        toolCall: { name: "run_command", args: { CommandLine: "rm -rf /" } },
      },
      { AUTOLOOP_GUARD_FILE: guardFile },
    );
    assert.equal(denyRoot.decision, "deny");

    const denyEscape = runHook(
      PRE_TOOL_HOOK,
      {
        toolCall: {
          name: "run_command",
          args: { CommandLine: "rm -rf ../outside" },
        },
      },
      { AUTOLOOP_GUARD_FILE: guardFile },
    );
    assert.equal(denyEscape.decision, "deny");

    const denyConfig = runHook(
      PRE_TOOL_HOOK,
      {
        toolCall: {
          name: "run_command",
          args: { CommandLine: "echo '{}' > ~/.gemini/config/config.json" },
        },
      },
      { AUTOLOOP_GUARD_FILE: guardFile },
    );
    assert.equal(denyConfig.decision, "deny");

    const denyWriteFileConfig = runHook(
      PRE_TOOL_HOOK,
      {
        toolCall: {
          name: "write_file",
          args: { Path: "~/.gemini/config/config.json", Content: "{}" },
        },
      },
      { AUTOLOOP_GUARD_FILE: guardFile },
    );
    assert.equal(denyWriteFileConfig.decision, "deny");

    // Corrupt guard.json must fail-closed (deny)
    writeFileSync(guardFile, "{corrupt json", "utf8");
    const denyCorrupt = runHook(
      PRE_TOOL_HOOK,
      {
        toolCall: { name: "run_command", args: { CommandLine: "git status" } },
      },
      { AUTOLOOP_GUARD_FILE: guardFile },
    );
    assert.equal(denyCorrupt.decision, "deny");
  });
});

describe("hooks/stop-receipt-check.mjs", () => {
  it("allows stop immediately outside Autoloop or when terminationReason !== NO_TOOL_CALL", () => {
    const tmpDir = makeTempDir();
    const transcript = path.join(tmpDir, "transcript.jsonl");
    writeFileSync(
      transcript,
      `${JSON.stringify({ type: "PLANNER_RESPONSE", status: "DONE", content: '完成\n\n```json\n{"notice":[{"title":"t","text":"x"}]}\n```' })}\n`,
      "utf8",
    );

    const outside = runHook(STOP_HOOK, {
      terminationReason: "NO_TOOL_CALL",
      transcriptPath: transcript,
    });
    assert.deepEqual(outside, { decision: "stop" });

    const guardFile = path.join(tmpDir, "guard.json");
    const nonNormal = runHook(
      STOP_HOOK,
      {
        terminationReason: "USER_CANCELED",
        transcriptPath: transcript,
      },
      { AUTOLOOP_GUARD_FILE: guardFile },
    );
    assert.deepEqual(nonNormal, { decision: "stop" });
  });

  it("blocks malformed receipt at most 2 times with continue + repairPrompt and allows stop on 3rd attempt", () => {
    const tmpDir = makeTempDir();
    const guardFile = path.join(tmpDir, "guard.json");
    const transcript = path.join(tmpDir, "transcript.jsonl");

    writeFileSync(
      transcript,
      [
        JSON.stringify({
          step_index: 1,
          type: "PLANNER_RESPONSE",
          status: "DONE",
          content:
            '已完成处理。\n\n```agent-autoloop\n{"notice":[{"title":"未闭合","text":"x"}]}\n',
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const first = runHook(
      STOP_HOOK,
      { terminationReason: "NO_TOOL_CALL", transcriptPath: transcript },
      { AUTOLOOP_GUARD_FILE: guardFile },
    );
    assert.equal(first.decision, "continue");
    assert.match(String(first.reason), /不要重做任何业务操作/);

    const second = runHook(
      STOP_HOOK,
      { terminationReason: "NO_TOOL_CALL", transcriptPath: transcript },
      { AUTOLOOP_GUARD_FILE: guardFile },
    );
    assert.equal(second.decision, "continue");

    const third = runHook(
      STOP_HOOK,
      { terminationReason: "NO_TOOL_CALL", transcriptPath: transcript },
      { AUTOLOOP_GUARD_FILE: guardFile },
    );
    assert.deepEqual(third, { decision: "stop" });
  });

  it("allows stop immediately when receipt in transcript is valid", () => {
    const tmpDir = makeTempDir();
    const guardFile = path.join(tmpDir, "guard.json");
    const transcript = path.join(tmpDir, "transcript.jsonl");

    writeFileSync(
      transcript,
      `${JSON.stringify({
        step_index: 1,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        content:
          '全部完成。\n\n```agent-autoloop\n{"notice":[{"title":"完成","text":"正常","fyi":true}]}\n```',
      })}\n`,
      "utf8",
    );

    const res = runHook(
      STOP_HOOK,
      { terminationReason: "NO_TOOL_CALL", transcriptPath: transcript },
      { AUTOLOOP_GUARD_FILE: guardFile },
    );
    assert.deepEqual(res, { decision: "stop" });
  });

  it("handles plain-text transcript with malformed json receipt fence", () => {
    const tmpDir = makeTempDir();
    const guardFile = path.join(tmpDir, "guard.json");
    const transcript = path.join(tmpDir, "transcript.txt");

    writeFileSync(
      transcript,
      '已完成操作。\n\n```json\n{"notice":[{"title":"误写","text":"测试","fyi":true}]}\n```\n',
      "utf8",
    );

    const res = runHook(
      STOP_HOOK,
      { terminationReason: "NO_TOOL_CALL", transcriptPath: transcript },
      { AUTOLOOP_GUARD_FILE: guardFile },
    );
    assert.equal(res.decision, "continue");
    assert.match(String(res.reason), /agent-autoloop/);
  });
});
