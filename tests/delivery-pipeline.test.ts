/**
 * Isolated Worktree Checks & Five-Step Local Branch Delivery Pipeline Tests (WP-16).
 *
 * Prevents regressions in:
 * 1. Step 1 review blocking & 3-round human escalation: blocking findings prevent merge and emit
 *    `git.review.changes_requested`; exceeding 3 rounds generates an `ask` card with recommended
 *    options and allows resuming past escalation only when an explicit human approval matches the
 *    target branch + headSha (or rejects cleanly without looping on decline).
 * 2. Step 2 isolated temporary `git worktree` check gate: runs `checkCommand` in a detached
 *    temporary worktree with sanitized env (no leaked tokens/guard vars), blocks merge on failure,
 *    and guarantees 0 residual worktrees in `git worktree list` via `finally` cleanup.
 * 3. Step 3 base-branch drift/conflict detection & `sensitivePaths` gate: detects merge conflicts
 *    and `ff-only` non-fast-forward drift without mutating the working tree, and gates changes to
 *    sensitive paths behind an `ask` approval card before merging.
 * 4. Step 4 & 5 safe merge & smoke verification: supports `ff-only`, `merge` (`--no-ff`),
 *    `squash`, and `gh-pr` while preserving dirty uncommitted edits in the main working tree, runs
 *    `smokeCommand`, and emits `outcome: "done"` + `fyi: true` closure notice (or alert on smoke fail).
 * 5. Full `createDeliveryRunner` + `Supervisor` + SQLite kernel integration: reads `contextFile`
 *    events/answers/decided, drives the pipeline end-to-end, and supports `ask` -> `answerCard`
 *    -> wakeup merge closure.
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
import { fileURLToPath } from "node:url";
import {
  createDeliveryRunner,
  matchesSensitivePath,
  reviewEscalationCardKey,
  runDeliveryPipeline,
  sensitivePathsCardKey,
} from "../delivery/pipeline.ts";
import {
  createSupervisor,
  type SupervisorBackend,
} from "../engine/supervisor.ts";
import { decide, type DecideEnv, type KernelInput } from "../kernel/decide.ts";
import {
  createTokenSigner,
  openStore,
  safeTokenEquals,
} from "../kernel/store.ts";
import type { RulesConfig } from "../protocol/types.ts";

const FAKE_AGY_BIN = fileURLToPath(
  new URL("./fakes/fake-agy.mjs", import.meta.url),
);

const MASTER_KEY_HEX =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const tempDirs: string[] = [];

function makeTempDir(prefix = "autoloop-wp16-"): string {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
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

function listWorktrees(repoDir: string): string[] {
  const out = git(repoDir, ["worktree", "list", "--porcelain"]);
  const paths: string[] = [];
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      paths.push(realpathSync(line.slice("worktree ".length).trim()));
    }
  }
  return paths;
}

function writeRepoFile(
  repoDir: string,
  relPath: string,
  content: string,
): void {
  const full = path.join(repoDir, relPath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
}

function createTempRepo(
  filesOnMain: Record<string, string>,
  defaultBranch = "main",
): string {
  const repoDir = makeTempDir("autoloop-pipeline-repo-");
  git(repoDir, ["init", "-b", defaultBranch]);
  git(repoDir, ["config", "user.name", "Autoloop Pipeline Test"]);
  git(repoDir, ["config", "user.email", "pipeline-test@example.invalid"]);

  for (const [relPath, content] of Object.entries(filesOnMain)) {
    writeRepoFile(repoDir, relPath, content);
  }
  git(repoDir, ["add", "."]);
  git(repoDir, ["commit", "-m", "chore: initial main baseline"]);
  return repoDir;
}

function writeTurnScript(
  stateFile: string,
  turns: Array<{ text?: string; exitCode?: number; stderr?: string }>,
): void {
  mkdirSync(path.dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ turn: 0, turns }, null, 2));
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
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
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("matchesSensitivePath", () => {
  it("matches directory prefixes, exact files, and globs accurately", () => {
    assert.equal(matchesSensitivePath("kernel/decide.ts", "kernel/"), true);
    assert.equal(matchesSensitivePath("kernel/decide.ts", "kernel"), true);
    assert.equal(
      matchesSensitivePath("hooks/pre-tool-guard.mjs", "hooks"),
      true,
    );
    assert.equal(matchesSensitivePath("package.json", "package.json"), true);
    assert.equal(
      matchesSensitivePath("examples/package.json", "package.json"),
      false,
    );
    assert.equal(
      matchesSensitivePath("protocol/types.ts", "protocol/*.ts"),
      true,
    );
    assert.equal(matchesSensitivePath("src/app.ts", "kernel/"), false);
  });
});

describe("runDeliveryPipeline", () => {
  it("(a) blocks merge and emits git.review.changes_requested when heterogeneous review finds blocking issues", async () => {
    const repoDir = createTempRepo({
      ".autoloop/delivery.json": JSON.stringify({
        baseBranch: "main",
        mergeStrategy: "merge",
      }),
      "src/calc.ts": "export const div = (a: number, b: number) => a / b;\n",
    });
    const mainShaBefore = git(repoDir, ["rev-parse", "main"]);

    git(repoDir, ["checkout", "-b", "feat/buggy-div"]);
    writeRepoFile(
      repoDir,
      "src/calc.ts",
      "export const div = (a: number, b: number) => a / (b - 1);\n",
    );
    git(repoDir, ["add", "src/calc.ts"]);
    git(repoDir, ["commit", "-m", "feat: buggy offset"]);
    git(repoDir, ["checkout", "main"]);

    const workDir = makeTempDir("autoloop-deliv-a-");
    const stateFile = path.join(workDir, "fake-agy-state.json");
    writeTurnScript(stateFile, [
      {
        text: JSON.stringify({
          findings: [
            {
              title: "src/calc.ts:1 除零缺陷",
              text: "b === 1 时分母为 0",
              severity: "blocking",
            },
          ],
        }),
      },
    ]);

    const res = await runDeliveryPipeline({
      repoDir,
      targetRef: "feat/buggy-div",
      workDir,
      authorModel: "gemini-4-hydrogen-high",
      agyBin: FAKE_AGY_BIN,
      baseEnv: { ...process.env, FAKE_AGY_STATE_FILE: stateFile },
    });

    assert.equal(res.status, "changes_requested");
    assert.equal(res.step, "review");
    assert.equal(res.merged, false);
    assert.equal(res.outcome, "done");
    assert.equal(res.review?.reviewerModel, "gemini-4-carbon-high");
    assert.equal(res.receipt.events?.length, 1);
    assert.equal(res.receipt.events?.[0]?.type, "git.review.changes_requested");
    assert.equal(res.receipt.events?.[0]?.subject, "feat/buggy-div");
    assert.match(res.receipt.events?.[0]?.detail ?? "", /除零缺陷/);
    assert.equal(res.receipt.notice?.[0]?.fyi, true);

    // Main branch must not advance
    assert.equal(git(repoDir, ["rev-parse", "main"]), mainShaBefore);
    assert.deepEqual(listWorktrees(repoDir), [repoDir]);
  });

  it("(b) escalates to human ask card after 3 review rounds and proceeds on matching approved answers (or holds on rejection)", async () => {
    const repoDir = createTempRepo({
      ".autoloop/delivery.json": JSON.stringify({
        baseBranch: "main",
        mergeStrategy: "merge",
        maxReviewRounds: 3,
      }),
      "src/worker.ts": "export const step = 0;\n",
    });

    const workDir = makeTempDir("autoloop-deliv-b-");
    const stateFile = path.join(workDir, "fake-agy-state.json");
    writeTurnScript(stateFile, [
      {
        text: JSON.stringify({
          findings: [{ title: "src/worker.ts:1 r1", text: "issue 1" }],
        }),
      },
      {
        text: JSON.stringify({
          findings: [{ title: "src/worker.ts:1 r2", text: "issue 2" }],
        }),
      },
      {
        text: JSON.stringify({
          findings: [{ title: "src/worker.ts:1 r3", text: "issue 3" }],
        }),
      },
    ]);
    const baseEnv = { ...process.env, FAKE_AGY_STATE_FILE: stateFile };

    const pushAttempt = (n: number) => {
      if (n === 1) {
        git(repoDir, ["checkout", "-b", "feat/escalate"]);
      } else {
        git(repoDir, ["checkout", "feat/escalate"]);
      }
      writeRepoFile(repoDir, "src/worker.ts", `export const step = ${n};\n`);
      git(repoDir, ["add", "src/worker.ts"]);
      git(repoDir, ["commit", "-m", `attempt ${n}`]);
      git(repoDir, ["checkout", "main"]);
    };

    pushAttempt(1);
    const r1 = await runDeliveryPipeline({
      repoDir,
      targetRef: "feat/escalate",
      workDir,
      agyBin: FAKE_AGY_BIN,
      baseEnv,
    });
    assert.equal(r1.status, "changes_requested");
    assert.equal(r1.merged, false);

    pushAttempt(2);
    const r2 = await runDeliveryPipeline({
      repoDir,
      targetRef: "feat/escalate",
      workDir,
      agyBin: FAKE_AGY_BIN,
      baseEnv,
    });
    assert.equal(r2.status, "changes_requested");
    assert.equal(r2.merged, false);

    // Round 3 -> escalated_to_human ask card
    pushAttempt(3);
    const sha3 = git(repoDir, ["rev-parse", "feat/escalate"]);
    const r3 = await runDeliveryPipeline({
      repoDir,
      targetRef: "feat/escalate",
      workDir,
      agyBin: FAKE_AGY_BIN,
      baseEnv,
    });
    assert.equal(r3.status, "awaiting_approval");
    assert.equal(r3.step, "review");
    assert.equal(r3.merged, false);
    assert.equal(r3.receipt.ask?.length, 1);

    const askCard = r3.receipt.ask![0]!;
    assert.equal(askCard.key, reviewEscalationCardKey("feat/escalate", sha3));
    assert.deepEqual(askCard.options, ["人工放行继续合并", "退回并搁置分支"]);
    assert.equal(typeof askCard.recommend, "number");

    // If human chooses rejection ("退回并搁置分支"), stays unmerged and emits no repeat ask card
    const rejectedRun = await runDeliveryPipeline({
      repoDir,
      targetRef: "feat/escalate",
      workDir,
      agyBin: FAKE_AGY_BIN,
      baseEnv,
      answers: [
        {
          card: 1,
          key: askCard.key,
          title: askCard.title,
          options: askCard.options,
          choice: 1,
          chosen: "退回并搁置分支",
          about: askCard.about,
          at: "2026-11-14T00:00:00Z",
        },
      ],
    });
    assert.equal(rejectedRun.status, "rejected");
    assert.equal(rejectedRun.merged, false);
    assert.equal(rejectedRun.receipt.ask, undefined);
    assert.equal(
      rejectedRun.receipt.events?.[0]?.type,
      "git.review.changes_requested",
    );

    // Re-running with explicit human approval overrides escalation and completes merge
    const approvedRun = await runDeliveryPipeline({
      repoDir,
      targetRef: "feat/escalate",
      workDir,
      agyBin: FAKE_AGY_BIN,
      baseEnv,
      answers: [
        {
          card: 2,
          key: askCard.key,
          title: askCard.title,
          options: askCard.options,
          choice: 0,
          chosen: "人工放行继续合并",
          about: askCard.about,
          at: "2026-11-14T00:01:00Z",
        },
      ],
    });
    assert.equal(approvedRun.status, "merged");
    assert.equal(approvedRun.merged, true);
    assert.equal(approvedRun.outcome, "done");
    assert.equal(approvedRun.receipt.notice?.[0]?.fyi, true);
    assert.match(git(repoDir, ["show", "main:src/worker.ts"]), /step = 3/);
    assert.deepEqual(listWorktrees(repoDir), [repoDir]);
  });

  it("(c) blocks merge on isolated worktree checkCommand failure, sanitizes env, and leaves zero residual worktrees", async () => {
    const checkScript = [
      "const fs = require('node:fs');",
      "if (process.env.AUTOLOOP_OWNER_TOKEN || process.env.AUTOLOOP_GUARD_FILE || process.env.GIT_DIR) {",
      "  console.error('LEAKED_ENV');",
      "  process.exit(2);",
      "}",
      "const content = fs.readFileSync('src/feature.ts', 'utf8');",
      "if (content.includes('FAIL_CHECK')) { console.error('UNIT_TEST_FAILED'); process.exit(1); }",
    ].join(" ");

    const repoDir = createTempRepo({
      ".autoloop/delivery.json": JSON.stringify({
        baseBranch: "main",
        checkCommand: `node -e "${checkScript}"`,
        mergeStrategy: "ff-only",
      }),
      "src/feature.ts": "export const ok = true;\n",
    });
    const mainShaBefore = git(repoDir, ["rev-parse", "main"]);

    git(repoDir, ["checkout", "-b", "feat/broken-check"]);
    writeRepoFile(
      repoDir,
      "src/feature.ts",
      "export const ok = 'FAIL_CHECK';\n",
    );
    git(repoDir, ["add", "src/feature.ts"]);
    git(repoDir, ["commit", "-m", "feat: fail check"]);
    git(repoDir, ["checkout", "main"]);

    const workDir = makeTempDir("autoloop-deliv-c-");
    const stateFile = path.join(workDir, "fake-agy-state.json");
    writeTurnScript(stateFile, [{ text: JSON.stringify({ findings: [] }) }]);

    const res = await runDeliveryPipeline({
      repoDir,
      targetRef: "feat/broken-check",
      workDir,
      agyBin: FAKE_AGY_BIN,
      baseEnv: {
        ...process.env,
        FAKE_AGY_STATE_FILE: stateFile,
        AUTOLOOP_OWNER_TOKEN: "secret-owner",
        AUTOLOOP_GUARD_FILE: "/tmp/fake-guard.json",
        GIT_DIR: "/tmp/should-not-leak",
      },
    });

    assert.equal(res.status, "check_failed");
    assert.equal(res.step, "check");
    assert.equal(res.merged, false);
    assert.equal(res.outcome, "done");
    assert.match(res.checkOutput ?? "", /UNIT_TEST_FAILED/);
    assert.doesNotMatch(res.checkOutput ?? "", /LEAKED_ENV/);
    assert.equal(res.receipt.events?.[0]?.type, "git.delivery.check_failed");
    assert.equal(git(repoDir, ["rev-parse", "main"]), mainShaBefore);

    // Must leave 0 leftover worktrees
    assert.deepEqual(listWorktrees(repoDir), [repoDir]);
  });

  it("(d) gates sensitivePaths behind an ask card and completes merge + smokeCommand after approval", async () => {
    const repoDir = createTempRepo({
      ".autoloop/delivery.json": JSON.stringify({
        baseBranch: "main",
        checkCommand: `node -e "const fs=require('node:fs'); if (!fs.existsSync('kernel/guard.ts')) process.exit(1);"`,
        smokeCommand: `node -e "const fs=require('node:fs'); if (!fs.readFileSync('kernel/guard.ts','utf8').includes('SAFE_GUARD')) process.exit(1); console.log('SMOKE_OK');"`,
        mergeStrategy: "merge",
        sensitivePaths: ["kernel/", "package.json"],
      }),
      "kernel/guard.ts": "export const guard = 'V1';\n",
      "src/helper.ts": "export const h = 1;\n",
    });

    git(repoDir, ["checkout", "-b", "feat/sensitive-kernel"]);
    writeRepoFile(
      repoDir,
      "kernel/guard.ts",
      "export const guard = 'SAFE_GUARD';\n",
    );
    writeRepoFile(repoDir, "src/helper.ts", "export const h = 2;\n");
    git(repoDir, ["add", "."]);
    git(repoDir, ["commit", "-m", "feat: update kernel guard"]);
    git(repoDir, ["checkout", "main"]);

    const headSha = git(repoDir, ["rev-parse", "feat/sensitive-kernel"]);
    const workDir = makeTempDir("autoloop-deliv-d-");
    const stateFile = path.join(workDir, "fake-agy-state.json");
    writeTurnScript(stateFile, [{ text: JSON.stringify({ findings: [] }) }]);
    const baseEnv = { ...process.env, FAKE_AGY_STATE_FILE: stateFile };

    const first = await runDeliveryPipeline({
      repoDir,
      targetRef: "feat/sensitive-kernel",
      workDir,
      agyBin: FAKE_AGY_BIN,
      baseEnv,
    });

    assert.equal(first.status, "awaiting_approval");
    assert.equal(first.step, "gate");
    assert.equal(first.merged, false);
    assert.deepEqual(first.matchedSensitiveFiles, ["kernel/guard.ts"]);
    assert.equal(first.receipt.ask?.length, 1);

    const sensCard = first.receipt.ask![0]!;
    assert.equal(
      sensCard.key,
      sensitivePathsCardKey("feat/sensitive-kernel", headSha),
    );
    assert.match(sensCard.text, /kernel\/guard\.ts/);
    assert.match(sensCard.text, /src\/helper\.ts/);

    const second = await runDeliveryPipeline({
      repoDir,
      targetRef: "feat/sensitive-kernel",
      workDir,
      agyBin: FAKE_AGY_BIN,
      baseEnv,
      approvedKeys: [sensCard.key],
    });

    assert.equal(second.status, "merged");
    assert.equal(second.step, "smoke");
    assert.equal(second.merged, true);
    assert.equal(second.outcome, "done");
    assert.match(second.smokeOutput ?? "", /SMOKE_OK/);
    assert.equal(second.receipt.notice?.[0]?.fyi, true);
    assert.match(git(repoDir, ["show", "main:kernel/guard.ts"]), /SAFE_GUARD/);
    assert.deepEqual(listWorktrees(repoDir), [repoDir]);
  });

  it("detects base branch conflicts and ff-only drift without disturbing dirty main working tree", async () => {
    const repoDir = createTempRepo({
      ".autoloop/delivery.json": JSON.stringify({
        baseBranch: "main",
        mergeStrategy: "merge",
      }),
      "src/shared.ts": "export const val = 'base';\n",
      "notes.txt": "original\n",
    });

    git(repoDir, ["checkout", "-b", "feat/conflict"]);
    writeRepoFile(repoDir, "src/shared.ts", "export const val = 'branch';\n");
    git(repoDir, ["add", "src/shared.ts"]);
    git(repoDir, ["commit", "-m", "feat: branch edit"]);

    git(repoDir, ["checkout", "main"]);
    writeRepoFile(
      repoDir,
      "src/shared.ts",
      "export const val = 'main-moved';\n",
    );
    git(repoDir, ["add", "src/shared.ts"]);
    git(repoDir, ["commit", "-m", "main: conflicting move"]);

    // Add uncommitted dirty edit on main that must never be touched
    writeRepoFile(repoDir, "notes.txt", "USER_DIRTY_UNCOMMITTED\n");

    const workDir = makeTempDir("autoloop-deliv-conflict-");
    const stateFile = path.join(workDir, "fake-agy-state.json");
    writeTurnScript(stateFile, [{ text: JSON.stringify({ findings: [] }) }]);

    const res = await runDeliveryPipeline({
      repoDir,
      targetRef: "feat/conflict",
      workDir,
      agyBin: FAKE_AGY_BIN,
      baseEnv: { ...process.env, FAKE_AGY_STATE_FILE: stateFile },
    });

    assert.equal(res.status, "conflict");
    assert.equal(res.step, "gate");
    assert.equal(res.merged, false);
    assert.equal(res.receipt.events?.[0]?.type, "git.delivery.conflict");
    assert.equal(
      readFileSync(path.join(repoDir, "notes.txt"), "utf8"),
      "USER_DIRTY_UNCOMMITTED\n",
    );
    assert.deepEqual(listWorktrees(repoDir), [repoDir]);
  });

  it("supports squash and gh-pr strategies and preserves dirty main working tree during non-conflicting merge", async () => {
    // 1. Dirty main worktree + squash merge into main via isolated worktree update-ref
    const repoDir = createTempRepo({
      ".autoloop/delivery.json": JSON.stringify({
        baseBranch: "main",
        mergeStrategy: "squash",
        smokeCommand: `node -e "const fs=require('node:fs'); if (!fs.readFileSync('src/new.ts','utf8').includes('SQUASHED')) process.exit(1);"`,
      }),
      "README.md": "# Repo\n",
    });

    git(repoDir, ["checkout", "-b", "feat/squash-me"]);
    writeRepoFile(repoDir, "src/new.ts", "export const s1 = 1;\n");
    git(repoDir, ["add", "src/new.ts"]);
    git(repoDir, ["commit", "-m", "wip 1"]);
    writeRepoFile(repoDir, "src/new.ts", "export const s1 = 'SQUASHED';\n");
    git(repoDir, ["add", "src/new.ts"]);
    git(repoDir, ["commit", "-m", "wip 2"]);
    git(repoDir, ["checkout", "main"]);

    // Dirty uncommitted tracked + untracked edits in main working tree
    writeRepoFile(repoDir, "README.md", "# Dirty User Edits\n");
    writeRepoFile(repoDir, "scratch.tmp", "keep me intact\n");

    const workDir = makeTempDir("autoloop-deliv-squash-");
    const stateFile = path.join(workDir, "fake-agy-state.json");
    writeTurnScript(stateFile, [{ text: JSON.stringify({ findings: [] }) }]);

    const squashRes = await runDeliveryPipeline({
      repoDir,
      targetRef: "feat/squash-me",
      workDir,
      agyBin: FAKE_AGY_BIN,
      baseEnv: { ...process.env, FAKE_AGY_STATE_FILE: stateFile },
    });

    assert.equal(squashRes.status, "merged");
    assert.equal(squashRes.merged, true);
    assert.equal(squashRes.mergeStrategy, "squash");
    assert.match(git(repoDir, ["show", "main:src/new.ts"]), /SQUASHED/);
    assert.ok(squashRes.workingTreeNotice);
    // Dirty files untouched
    assert.equal(
      readFileSync(path.join(repoDir, "README.md"), "utf8"),
      "# Dirty User Edits\n",
    );
    assert.equal(
      readFileSync(path.join(repoDir, "scratch.tmp"), "utf8"),
      "keep me intact\n",
    );
    assert.deepEqual(listWorktrees(repoDir), [repoDir]);

    // 2. gh-pr strategy invoking fake gh binary via execFile
    const ghRepo = createTempRepo({
      ".autoloop/delivery.json": JSON.stringify({
        baseBranch: "main",
        mergeStrategy: "gh-pr",
      }),
      "src/a.ts": "export const a = 1;\n",
    });
    git(ghRepo, ["checkout", "-b", "feat/pr-1"]);
    writeRepoFile(ghRepo, "src/a.ts", "export const a = 2;\n");
    git(ghRepo, ["add", "src/a.ts"]);
    git(ghRepo, ["commit", "-m", "feat: pr 1"]);
    git(ghRepo, ["checkout", "main"]);

    const ghWork = makeTempDir("autoloop-deliv-gh-");
    const ghState = path.join(ghWork, "agy-state.json");
    writeTurnScript(ghState, [{ text: JSON.stringify({ findings: [] }) }]);
    const ghLog = path.join(ghWork, "gh-args.txt");
    const fakeGh = path.join(ghWork, "fake-gh.mjs");
    writeFileSync(
      fakeGh,
      [
        "#!/usr/bin/env node",
        "import fs from 'node:fs';",
        `fs.writeFileSync(${JSON.stringify(ghLog)}, JSON.stringify(process.argv.slice(2)));`,
      ].join("\n"),
      { mode: 0o755 },
    );
    chmodSync(fakeGh, 0o755);

    const ghRes = await runDeliveryPipeline({
      repoDir: ghRepo,
      targetRef: "feat/pr-1",
      workDir: ghWork,
      agyBin: FAKE_AGY_BIN,
      ghBin: fakeGh,
      baseEnv: { ...process.env, FAKE_AGY_STATE_FILE: ghState },
    });

    assert.equal(ghRes.status, "merged");
    assert.equal(ghRes.mergeStrategy, "gh-pr");
    assert.deepEqual(JSON.parse(readFileSync(ghLog, "utf8")), [
      "pr",
      "merge",
      "feat/pr-1",
      "--merge",
    ]);
  });
});

describe("createDeliveryRunner + Supervisor integration", () => {
  it("runs full Supervisor ask -> answerCard -> wakeup merge loop and handles smokeCommand failure alert", async () => {
    const repoDir = createTempRepo({
      ".autoloop/delivery.json": JSON.stringify({
        baseBranch: "main",
        checkCommand: `node -e "process.exit(0)"`,
        smokeCommand: `node -e "const fs=require('node:fs'); if (!fs.readFileSync('kernel/ok.ts','utf8').includes('READY')) process.exit(1);"`,
        mergeStrategy: "merge",
        sensitivePaths: ["kernel/"],
      }),
      "kernel/ok.ts": "export const ready = false;\n",
    });

    git(repoDir, ["checkout", "-b", "feat/sup-full"]);
    writeRepoFile(repoDir, "kernel/ok.ts", "export const ready = 'READY';\n");
    git(repoDir, ["add", "kernel/ok.ts"]);
    git(repoDir, ["commit", "-m", "feat: ready"]);
    git(repoDir, ["checkout", "main"]);

    const autoloopHome = makeTempDir("autoloop-sup-home-");
    const agyState = path.join(autoloopHome, "fake-agy-state.json");
    writeTurnScript(agyState, [
      { text: JSON.stringify({ findings: [] }) },
      { text: JSON.stringify({ findings: [] }) },
    ]);

    const dbPath = path.join(autoloopHome, "hub.db");
    const harness = createKernelHarness(dbPath);
    const rulesConfig: RulesConfig = {
      timezone: "UTC",
      askFirst: [],
      sources: {
        inbox: { name: "Inbox" },
        delivery: { name: "Delivery" },
      },
      agents: {
        deliverer: {
          name: "Deliverer",
          runner: "delivery",
          timeoutMinutes: 2,
        },
      },
      rules: [
        {
          name: "deliver-branches",
          when: { source: "inbox", types: ["git.branch.ready"] },
          to: "deliverer",
          cwd: repoDir,
          emits: {
            source: "delivery",
            types: [
              "git.review.changes_requested",
              "git.delivery.check_failed",
              "git.delivery.conflict",
              "git.delivery.smoke_failed",
            ],
          },
        },
      ],
    };

    harness.exec({ type: "configureRules", config: rulesConfig });
    harness.exec({
      type: "ingestEvent",
      source: "inbox",
      event: {
        id: "branch-evt-1",
        type: "git.branch.ready",
        subject: "feat/sup-full",
        detail: JSON.stringify({ authorModel: "gemini-4-hydrogen-high" }),
      },
    });

    const supervisor = createSupervisor({
      autoloopHome,
      backend: harness.backend,
      pollIntervalMs: 0,
      heartbeatIntervalMs: 0,
      baseEnv: { ...process.env, FAKE_AGY_STATE_FILE: agyState },
      onError: (err) => {
        console.error("SUPERVISOR_ERROR:", err);
      },
      deliveryRunner: createDeliveryRunner({
        agyBin: FAKE_AGY_BIN,
      }),
    });

    try {
      await supervisor.kick();
      await waitFor(() => {
        const r = harness.store.view.get("runs", "1");
        if (r?.status === "failed") {
          throw new Error(`Run 1 failed: ${String(r.error ?? r.summary)}`);
        }
        return r?.status === "done";
      }, 5_000).catch((err) => {
        console.error("RUN1_STATE:", harness.store.view.get("runs", "1"));
        console.error("CARDS:", Array.from(harness.store.view.all("cards")));
        throw err;
      });

      // Run 1 must pause on sensitivePaths ask card without merging
      const cardsAfterRun1 = Array.from(harness.store.view.all("cards"));
      assert.equal(cardsAfterRun1.length, 1);
      const askCard = cardsAfterRun1[0]!;
      assert.equal(askCard.kind, "ask");
      assert.equal(askCard.status, "open");
      assert.match(String(askCard.title), /敏感路径终审/);

      // User approves the ask card in SQLite kernel -> queues Run 2
      harness.advanceNow(1000);
      harness.exec({
        type: "answerCard",
        card: askCard.id as number,
        choice: 0,
      });

      await supervisor.kick();
      await waitFor(
        () => harness.store.view.get("runs", "2")?.status === "done",
      );

      // Run 2 completed merge + smokeCommand + emitted fyi: true closure notice
      assert.match(git(repoDir, ["show", "main:kernel/ok.ts"]), /READY/);
      const cardsAfterRun2 = Array.from(harness.store.view.all("cards"));
      assert.equal(cardsAfterRun2.length, 2);
      const closedAsk = harness.store.view.get("cards", String(askCard.id));
      assert.equal(closedAsk?.status, "done");
      const closureNotice = cardsAfterRun2.find((c) => c.kind === "notice");
      assert.equal(closureNotice?.status, "closed");
      assert.equal(closureNotice?.fyi, true);

      // Also verify smokeCommand failure emits non-fyi alert notice + git.delivery.smoke_failed
      git(repoDir, ["checkout", "-b", "feat/bad-smoke"]);
      writeRepoFile(
        repoDir,
        "kernel/ok.ts",
        "export const ready = 'BROKEN_SMOKE';\n",
      );
      git(repoDir, ["add", "kernel/ok.ts"]);
      git(repoDir, ["commit", "-m", "feat: break smoke"]);
      git(repoDir, ["checkout", "main"]);

      // Approve sensitivePaths directly via runDeliveryPipeline for fast smoke-fail check
      const headBadSmoke = git(repoDir, ["rev-parse", "feat/bad-smoke"]);
      const smokeFailRes = await runDeliveryPipeline({
        repoDir,
        targetRef: "feat/bad-smoke",
        workDir: path.join(autoloopHome, "smoke-check"),
        agyBin: FAKE_AGY_BIN,
        baseEnv: { ...process.env, FAKE_AGY_STATE_FILE: agyState },
        approvedKeys: [sensitivePathsCardKey("feat/bad-smoke", headBadSmoke)],
      });
      assert.equal(smokeFailRes.status, "smoke_failed");
      assert.equal(smokeFailRes.merged, true);
      assert.equal(smokeFailRes.outcome, "done");
      assert.equal(smokeFailRes.receipt.notice?.[0]?.fyi, false);
      assert.equal(
        smokeFailRes.receipt.events?.[0]?.type,
        "git.delivery.smoke_failed",
      );
      assert.deepEqual(listWorktrees(repoDir), [repoDir]);
    } finally {
      await supervisor.stop();
      harness.store.close();
    }
  });
});
