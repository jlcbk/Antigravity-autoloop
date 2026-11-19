/**
 * Two-Tier Incremental Delivery Review & Anti-Ping-Pong Escalation Tests (WP-C / v1.1).
 *
 * Prevents regressions in:
 * 1. Token explosion & review ping-pong in Round 2+: when `prevSha` is a valid ancestor of
 *    `headSha` with code changes, Round 2+ must extract `prevSha..headSha` into an isolated
 *    `0o600` `incremental-diff.patch`, attach Round 1's `blockingFindings` (`file`, `line`,
 *    `title`, `detail`), and forbid hunting for new nitpicks in untouched historical code.
 * 2. Unsafe incremental blind spots: rebased/rewritten branches (`--is-ancestor` false) or
 *    markdown-only (`*.md`) commits responding to code blocking issues (#345) must safely fall
 *    back to the full branch `diff.patch` so authors cannot bypass code defects via README edits.
 * 3. Reviewer false positives & security gate weakening: `blocking` findings require concrete
 *    trigger paths (`detail` / `how`), `warning`/`info` findings do not block merge, similar
 *    issues must be grouped, and ordinary `tests/*.test.ts` files are marked light-read while
 *    excluding gate tests (`tests/purity.test.ts`, `tests/security-isolation.test.ts`).
 * 4. Timeout hangs, endless rounds & duplicate reviews on branch rename (#311/#312/#342):
 *    default review timeout is 30 minutes (`30 * 60_000`), default `maxReviewRounds` is `2`
 *    (escalating to human `ask` card after 2 unresolved rounds), and ledger SHA cache matches
 *    `(headSha, mergeBaseSha, reviewerModel)` decoupled from branch names.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  reviewEscalationCardKey,
  runDeliveryPipeline,
} from "../delivery/pipeline.ts";
import {
  buildReviewPrompt,
  classifyChangedFilesForReview,
  DEFAULT_MAX_REVIEW_ROUNDS,
  DEFAULT_REVIEW_TIMEOUT_MS,
  parseReviewerOutput,
  readReviewLedger,
  reviewBranchSnapshot,
} from "../delivery/reviewer.ts";
import { extractBranchSnapshot } from "../delivery/snapshot.ts";

const FAKE_AGY_BIN = fileURLToPath(
  new URL("./fakes/fake-agy.mjs", import.meta.url),
);

const tempDirs: string[] = [];

function makeTempDir(prefix = "autoloop-v11-deliv-"): string {
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
  const repoDir = makeTempDir("autoloop-v11-repo-");
  git(repoDir, ["init", "-b", defaultBranch]);
  git(repoDir, ["config", "user.name", "Autoloop V11 Test"]);
  git(repoDir, ["config", "user.email", "v11-test@example.invalid"]);

  for (const [relPath, content] of Object.entries(filesOnMain)) {
    writeRepoFile(repoDir, relPath, content);
  }
  git(repoDir, ["add", "."]);
  git(repoDir, ["commit", "-m", "chore: initial main baseline"]);
  return repoDir;
}

function readJsonlRecords(recordFile: string): Array<{
  argv: string[];
  parsed: {
    print: boolean;
    outputFormat: string | null;
    model: string | null;
    conversation: string | null;
    mode: string | null;
    sandbox: boolean;
    prompt: string;
  };
  env: Record<string, string | undefined>;
  cwd: string;
}> {
  if (!existsSync(recordFile)) {
    return [];
  }
  const text = readFileSync(recordFile, "utf8").trim();
  if (!text) {
    return [];
  }
  return text.split("\n").map((line) => JSON.parse(line));
}

function writeTurnScript(
  stateFile: string,
  turns: Array<{ text?: string; exitCode?: number; stderr?: string }>,
): void {
  mkdirSync(path.dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ turn: 0, turns }, null, 2));
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("v1.1 incremental snapshot extraction & fallbacks", () => {
  it("extracts prevSha..headSha incremental diff when prevSha is an ancestor, and falls back on rebase or *.md-only commits", async () => {
    const repoDir = createTempRepo({
      "src/history.ts": "export const base = 0;\n",
      "src/buggy.ts": "export function compute(x: number) { return 100 / x; }\n",
      "README.md": "# Service\n",
    });

    // Round 1 commit: large historical file + buggy file
    git(repoDir, ["checkout", "-b", "feat/inc-test"]);
    const largeHistoricalBody = Array.from(
      { length: 120 },
      (_, idx) => `export const HISTORICAL_LINE_${idx} = ${idx};`,
    ).join("\n");
    writeRepoFile(repoDir, "src/history.ts", `${largeHistoricalBody}\n`);
    writeRepoFile(
      repoDir,
      "src/buggy.ts",
      "export function compute(x: number) { return 100 / (x - 1); }\n",
    );
    git(repoDir, ["add", "."]);
    git(repoDir, ["commit", "-m", "feat: round 1 large feature"]);
    const round1Sha = git(repoDir, ["rev-parse", "HEAD"]);

    // Round 2 commit: small targeted fix only in src/buggy.ts
    writeRepoFile(
      repoDir,
      "src/buggy.ts",
      "export function compute(x: number) { if (x === 1) return 0; return 100 / (x - 1); }\n",
    );
    git(repoDir, ["add", "src/buggy.ts"]);
    git(repoDir, ["commit", "-m", "fix: guard x === 1"]);
    const round2Sha = git(repoDir, ["rev-parse", "HEAD"]);
    git(repoDir, ["checkout", "main"]);

    const outCodeFix = makeTempDir("snap-inc-code-");
    const snapCodeFix = await extractBranchSnapshot({
      repoDir,
      targetRef: "feat/inc-test",
      baseBranch: "main",
      outputDir: outCodeFix,
      previousReviewedSha: round1Sha,
    });

    assert.equal(snapCodeFix.headSha, round2Sha);
    assert.equal(snapCodeFix.incrementalBaseSha, round1Sha);
    assert.deepEqual(snapCodeFix.incrementalChangedFiles, ["src/buggy.ts"]);
    assert.ok(snapCodeFix.incrementalDiffFile);
    assert.equal(statSync(snapCodeFix.incrementalDiffFile).mode & 0o777, 0o600);
    assert.ok(snapCodeFix.incrementalDiffPatch);
    assert.match(snapCodeFix.incrementalDiffPatch, /if \(x === 1\) return 0/);
    assert.doesNotMatch(snapCodeFix.incrementalDiffPatch, /HISTORICAL_LINE_50/);

    // Pure *.md commit (#345): must fall back to full branch diff
    git(repoDir, ["checkout", "feat/inc-test"]);
    writeRepoFile(
      repoDir,
      "README.md",
      "# Service\n\nx is guaranteed != 1 by caller.\n",
    );
    git(repoDir, ["add", "README.md"]);
    git(repoDir, ["commit", "-m", "docs: claim caller never passes 1"]);
    git(repoDir, ["checkout", "main"]);

    const outDocsOnly = makeTempDir("snap-inc-docs-");
    const snapDocsOnly = await extractBranchSnapshot({
      repoDir,
      targetRef: "feat/inc-test",
      baseBranch: "main",
      outputDir: outDocsOnly,
      previousReviewedSha: round2Sha,
    });

    assert.equal(snapDocsOnly.incrementalDiffPatch, undefined);
    assert.equal(snapDocsOnly.incrementalDiffFile, undefined);
    assert.equal(snapDocsOnly.incrementalFallbackReason, "docs_only");

    // Rebased / rewritten history: prevSha is no longer an ancestor -> must fall back to full diff
    git(repoDir, ["checkout", "-b", "feat/rebased", "main"]);
    writeRepoFile(
      repoDir,
      "src/buggy.ts",
      "export function compute(x: number) { return x * 2; }\n",
    );
    git(repoDir, ["add", "src/buggy.ts"]);
    git(repoDir, ["commit", "-m", "feat: rewritten branch"]);
    git(repoDir, ["checkout", "main"]);

    const outRebased = makeTempDir("snap-inc-rebased-");
    const snapRebased = await extractBranchSnapshot({
      repoDir,
      targetRef: "feat/rebased",
      baseBranch: "main",
      outputDir: outRebased,
      previousReviewedSha: round1Sha,
    });

    assert.equal(snapRebased.incrementalDiffPatch, undefined);
    assert.equal(snapRebased.incrementalDiffFile, undefined);
    assert.equal(snapRebased.incrementalFallbackReason, "not_ancestor");
  });
});

describe("v1.1 round 2 targeted incremental review & #345 docs-only fallback", () => {
  it("persists blockingFindings in review-ledger.json and feeds incremental diff + prior blocking items on round 2", async () => {
    const repoDir = createTempRepo({
      "src/old-large.ts": "export const oldVal = 1;\n",
      "src/auth.ts": "export function verify(tok?: string) { return tok!.length > 0; }\n",
    });

    git(repoDir, ["checkout", "-b", "feat/auth-fix"]);
    writeRepoFile(
      repoDir,
      "src/old-large.ts",
      "// UNCHANGED_ROUND1_MARKER\nexport const oldVal = 2;\n",
    );
    writeRepoFile(
      repoDir,
      "src/auth.ts",
      "// CANARY_SECRET_IN_DIFF\nexport function verify(tok?: string) { return tok!.trim().length > 3; }\n",
    );
    git(repoDir, ["add", "."]);
    git(repoDir, ["commit", "-m", "feat: round 1"]);
    git(repoDir, ["checkout", "main"]);

    const workDir = makeTempDir("v11-round2-inc-");
    const stateFile = path.join(workDir, "state.json");
    const recordFile = path.join(workDir, "records.jsonl");
    const ledgerFile = path.join(workDir, "review-ledger.json");

    writeTurnScript(stateFile, [
      {
        text: JSON.stringify({
          findings: [
            {
              file: "src/auth.ts",
              line: 2,
              title: "空 token 解引用崩溃",
              detail: "当调用方 verify(undefined) 不传参时 tok!.trim() 抛出 TypeError",
              how: "匿名请求未携带 Authorization 头时直接传入 undefined",
              severity: "blocking",
            },
          ],
        }),
      },
      {
        text: JSON.stringify({
          findings: [
            {
              title: "src/auth.ts:2 可选优化",
              detail: "极端并发下日志顺序不确定",
              severity: "warning",
            },
          ],
        }),
      },
    ]);

    const baseEnv: NodeJS.ProcessEnv = {
      ...process.env,
      FAKE_AGY_STATE_FILE: stateFile,
      FAKE_AGY_RECORD_FILE: recordFile,
    };

    const snap1 = await extractBranchSnapshot({
      repoDir,
      targetRef: "feat/auth-fix",
      baseBranch: "main",
      outputDir: path.join(workDir, "s1"),
    });
    const r1 = await reviewBranchSnapshot({
      snapshot: snap1,
      ledgerFile,
      authorModel: "gemini-4-hydrogen-high",
      agyBin: FAKE_AGY_BIN,
      baseEnv,
    });
    assert.equal(r1.status, "changes_requested");
    assert.equal(r1.round, 1);

    const ledgerAfterR1 = readReviewLedger(ledgerFile);
    assert.equal(ledgerAfterR1.entries.length, 1);
    assert.equal(ledgerAfterR1.entries[0]!.blockingFindings?.length, 1);
    assert.deepEqual(ledgerAfterR1.entries[0]!.blockingFindings![0], {
      file: "src/auth.ts",
      line: 2,
      title: "空 token 解引用崩溃",
      detail: "当调用方 verify(undefined) 不传参时 tok!.trim() 抛出 TypeError",
      how: "匿名请求未携带 Authorization 头时直接传入 undefined",
    });

    // Author commits targeted code fix in Round 2 (without touching src/old-large.ts)
    git(repoDir, ["checkout", "feat/auth-fix"]);
    writeRepoFile(
      repoDir,
      "src/auth.ts",
      "// CANARY_SECRET_IN_DIFF\nexport function verify(tok?: string) { return typeof tok === 'string' && tok.trim().length > 3; }\n",
    );
    git(repoDir, ["add", "src/auth.ts"]);
    git(repoDir, ["commit", "-m", "fix: handle undefined token"]);
    git(repoDir, ["checkout", "main"]);

    // Even when caller calls extractBranchSnapshot without previousReviewedSha, reviewBranchSnapshot resolves incremental diff from ledger
    const snap2 = await extractBranchSnapshot({
      repoDir,
      targetRef: "feat/auth-fix",
      baseBranch: "main",
      outputDir: path.join(workDir, "s2"),
    });
    const r2 = await reviewBranchSnapshot({
      snapshot: snap2,
      ledgerFile,
      authorModel: "gemini-4-hydrogen-high",
      agyBin: FAKE_AGY_BIN,
      baseEnv,
    });

    // `warning` severity is non-blocking -> approved!
    assert.equal(r2.status, "approved");
    assert.equal(r2.round, 2);
    assert.equal(r2.incremental, true);
    assert.equal(r2.incrementalFromSha, snap1.headSha);

    const records = readJsonlRecords(recordFile);
    assert.equal(records.length, 2);
    const round2Inv = records[1]!;
    const expectedIncDiffPath = path.join(workDir, "s2", "incremental-diff.patch");
    assert.equal(round2Inv.env.AUTOLOOP_CONTEXT, expectedIncDiffPath);
    assert.ok(round2Inv.parsed.prompt.includes(expectedIncDiffPath));
    assert.equal(round2Inv.parsed.prompt.includes(snap2.diffFile), false);

    // Incremental diff file omits Round 1's unchanged src/old-large.ts
    const incPatchContent = readFileSync(expectedIncDiffPath, "utf8");
    assert.doesNotMatch(incPatchContent, /UNCHANGED_ROUND1_MARKER/);
    assert.match(incPatchContent, /typeof tok === 'string'/);

    // Instruction-data separation preserved: diff code is never pasted into prompt
    assert.equal(
      round2Inv.parsed.prompt.includes("CANARY_SECRET_IN_DIFF"),
      false,
    );

    // Round 2 prompt includes prior blocking finding details & 3 discipline rules
    assert.match(round2Inv.parsed.prompt, /src\/auth\.ts/);
    assert.match(round2Inv.parsed.prompt, /2/);
    assert.match(round2Inv.parsed.prompt, /空 token 解引用崩溃/);
    assert.match(round2Inv.parsed.prompt, /逐条核对上一轮阻塞问题是否真正修复/);
    assert.match(round2Inv.parsed.prompt, /是否引入新的阻塞级缺陷/);
    assert.match(round2Inv.parsed.prompt, /严禁在未改动的历史代码中翻找/);
  });

  it("falls back to full branch diff on round 2 when author only edits *.md after a code blocking finding (#345)", async () => {
    const repoDir = createTempRepo({
      "src/calc.ts": "export const run = (n: number) => 10 / n;\n",
      "README.md": "# Calc\n",
    });

    git(repoDir, ["checkout", "-b", "feat/docs-dodge"]);
    writeRepoFile(
      repoDir,
      "src/calc.ts",
      "export const run = (n: number) => 10 / (n - 5);\n",
    );
    git(repoDir, ["add", "src/calc.ts"]);
    git(repoDir, ["commit", "-m", "feat: calc offset"]);
    git(repoDir, ["checkout", "main"]);

    const workDir = makeTempDir("v11-docs-dodge-");
    const stateFile = path.join(workDir, "state.json");
    const recordFile = path.join(workDir, "records.jsonl");
    const ledgerFile = path.join(workDir, "ledger.json");

    writeTurnScript(stateFile, [
      {
        text: JSON.stringify({
          findings: [
            {
              title: "src/calc.ts:1 n=5 除零",
              text: "调用 run(5) 时返回 Infinity",
            },
          ],
        }),
      },
      {
        text: JSON.stringify({
          findings: [
            {
              title: "src/calc.ts:1 仍未修复 n=5 除零",
              detail: "仅修改 README 并未在代码入口拦截 n=5",
            },
          ],
        }),
      },
    ]);

    const baseEnv: NodeJS.ProcessEnv = {
      ...process.env,
      FAKE_AGY_STATE_FILE: stateFile,
      FAKE_AGY_RECORD_FILE: recordFile,
    };

    const snap1 = await extractBranchSnapshot({
      repoDir,
      targetRef: "feat/docs-dodge",
      baseBranch: "main",
      outputDir: path.join(workDir, "s1"),
    });
    await reviewBranchSnapshot({
      snapshot: snap1,
      ledgerFile,
      agyBin: FAKE_AGY_BIN,
      baseEnv,
    });

    // Author tries to dodge code fix by only editing README.md
    git(repoDir, ["checkout", "feat/docs-dodge"]);
    writeRepoFile(repoDir, "README.md", "# Calc\nCaller must not pass 5.\n");
    git(repoDir, ["add", "README.md"]);
    git(repoDir, ["commit", "-m", "docs: document n != 5"]);
    git(repoDir, ["checkout", "main"]);

    const snap2 = await extractBranchSnapshot({
      repoDir,
      targetRef: "feat/docs-dodge",
      baseBranch: "main",
      outputDir: path.join(workDir, "s2"),
    });
    const r2 = await reviewBranchSnapshot({
      snapshot: snap2,
      ledgerFile,
      agyBin: FAKE_AGY_BIN,
      baseEnv,
    });

    // Default maxReviewRounds is 2, so unresolved blocking issue on round 2 escalates to human
    assert.equal(r2.status, "escalated_to_human");
    assert.equal(r2.incremental, false);

    const records = readJsonlRecords(recordFile);
    const round2Inv = records[1]!;
    // Must feed FULL branch diff.patch, NOT incremental-diff.patch!
    assert.equal(round2Inv.env.AUTOLOOP_CONTEXT, snap2.diffFile);
    assert.ok(round2Inv.parsed.prompt.includes(snap2.diffFile));
    assert.match(round2Inv.parsed.prompt, /README|Markdown|\*\.md/);
    assert.match(round2Inv.parsed.prompt, /src\/calc\.ts:1 n=5 除零/);
  });
});

describe("v1.1 two-tier review prompt, light-read test classification & finding parser", () => {
  it("marks ordinary tests/*.test.ts as light-read while keeping purity/security gate tests strict, and parses detail/how/warning", () => {
    const changedFiles = [
      "delivery/reviewer.ts",
      "tests/delivery-reviewer.test.ts",
      "tests/decide-routing.test.ts",
      "tests/purity.test.ts",
      "tests/security-isolation.test.ts",
      "tests/ui-dom-safety.test.ts",
    ];

    const classified = classifyChangedFilesForReview(changedFiles);
    assert.deepEqual(classified.lightReadTestFiles, [
      "tests/delivery-reviewer.test.ts",
      "tests/decide-routing.test.ts",
    ]);
    assert.deepEqual(classified.gateTestFiles, [
      "tests/purity.test.ts",
      "tests/security-isolation.test.ts",
      "tests/ui-dom-safety.test.ts",
    ]);

    const prompt = buildReviewPrompt(
      {
        repoDir: "/tmp/repo",
        baseBranch: "main",
        targetRef: "feat/two-tier",
        baseSha: "1111111111111111111111111111111111111111",
        headSha: "2222222222222222222222222222222222222222",
        mergeBaseSha: "1111111111111111111111111111111111111111",
        changedFiles,
        diffFile: "/tmp/snap/diff.patch",
        diffStat: "6 files changed",
        reviewNotes: "",
        config: { baseBranch: "main" },
      },
      1,
      2,
    );

    // Must require concrete trigger path, grouping similar issues, and non-blocking info/warning
    assert.match(prompt, /具体触发路径/);
    assert.match(prompt, /同类问题归并成一条/);
    assert.match(prompt, /warning/);
    assert.match(prompt, /测试代码分节轻读/);
    assert.match(prompt, /tests\/delivery-reviewer\.test\.ts/);
    assert.match(prompt, /tests\/decide-routing\.test\.ts/);

    // Security/purity gate tests must NOT appear inside the light-read list as light-read items
    const lightSection = prompt.split("## 测试代码分节轻读")[1] ?? "";
    const beforeNextHeading = lightSection.split("\n## ")[0] ?? "";
    assert.doesNotMatch(beforeNextHeading, /^- tests\/purity\.test\.ts$/m);
    assert.doesNotMatch(
      beforeNextHeading,
      /^- tests\/security-isolation\.test\.ts$/m,
    );
    assert.match(prompt, /tests\/purity\.test\.ts/);
    assert.match(prompt, /tests\/security-isolation\.test\.ts/);

    const parsed = parseReviewerOutput(
      JSON.stringify({
        findings: [
          {
            file: "delivery/reviewer.ts",
            line: 88,
            title: "缓存键误命中",
            detail: "不同审查模型共享同一条目会导致跳过异构复核",
            how: "当 reviewerModelOverride 切换模型重新调用 reviewBranchSnapshot 时触发",
            severity: "blocking",
          },
          {
            title: "理论极端竞态",
            detail: "需时钟回拨与磁盘满同时发生",
            severity: "warning",
          },
        ],
      }),
    );
    assert.equal(parsed.findings.length, 2);
    assert.equal(parsed.findings[0]!.file, "delivery/reviewer.ts");
    assert.equal(parsed.findings[0]!.line, 88);
    assert.equal(parsed.findings[0]!.how?.includes("reviewerModelOverride"), true);
    assert.equal(parsed.findings[1]!.severity, "warning");
  });
});

describe("v1.1 30-min default timeout, 2-round default cap & branch-decoupled SHA cache", () => {
  it("sets default timeout to 30 minutes and default maxReviewRounds to 2, escalating to ask card on round 2", async () => {
    assert.equal(DEFAULT_REVIEW_TIMEOUT_MS, 30 * 60_000);
    assert.equal(DEFAULT_MAX_REVIEW_ROUNDS, 2);

    const repoDir = createTempRepo({
      ".autoloop/delivery.json": JSON.stringify({
        baseBranch: "main",
        mergeStrategy: "merge",
      }),
      "src/item.ts": "export const v = 0;\n",
    });

    const workDir = makeTempDir("v11-cap2-");
    const stateFile = path.join(workDir, "state.json");
    const recordFile = path.join(workDir, "records.jsonl");
    writeTurnScript(stateFile, [
      {
        text: JSON.stringify({
          findings: [{ title: "src/item.ts:1 bug1", detail: "trigger 1" }],
        }),
      },
      {
        text: JSON.stringify({
          findings: [{ title: "src/item.ts:1 bug2", detail: "trigger 2" }],
        }),
      },
    ]);
    const baseEnv = {
      ...process.env,
      FAKE_AGY_STATE_FILE: stateFile,
      FAKE_AGY_RECORD_FILE: recordFile,
    };

    git(repoDir, ["checkout", "-b", "feat/two-rounds"]);
    writeRepoFile(repoDir, "src/item.ts", "export const v = 1;\n");
    git(repoDir, ["add", "src/item.ts"]);
    git(repoDir, ["commit", "-m", "round 1"]);
    git(repoDir, ["checkout", "main"]);

    const r1 = await runDeliveryPipeline({
      repoDir,
      targetRef: "feat/two-rounds",
      workDir,
      agyBin: FAKE_AGY_BIN,
      baseEnv,
    });
    assert.equal(r1.status, "changes_requested");
    assert.equal(r1.review?.round, 1);

    git(repoDir, ["checkout", "feat/two-rounds"]);
    writeRepoFile(repoDir, "src/item.ts", "export const v = 2;\n");
    git(repoDir, ["add", "src/item.ts"]);
    git(repoDir, ["commit", "-m", "round 2"]);
    const sha2 = git(repoDir, ["rev-parse", "HEAD"]);
    git(repoDir, ["checkout", "main"]);

    const r2 = await runDeliveryPipeline({
      repoDir,
      targetRef: "feat/two-rounds",
      workDir,
      agyBin: FAKE_AGY_BIN,
      baseEnv,
    });
    assert.equal(r2.status, "awaiting_approval");
    assert.equal(r2.step, "review");
    assert.equal(r2.merged, false);
    assert.equal(r2.review?.round, 2);
    assert.equal(r2.review?.status, "escalated_to_human");
    assert.equal(r2.review?.incremental, true);
    assert.equal(r2.snapshot?.incrementalBaseSha, r1.snapshot?.headSha);
    assert.equal(
      r2.receipt.ask?.[0]?.key,
      reviewEscalationCardKey("feat/two-rounds", sha2),
    );
  });

  it("matches ledger SHA cache by (headSha, mergeBaseSha, reviewerModel) across branch renames while separating distinct reviewer models (#311)", async () => {
    const repoDir = createTempRepo({
      "src/core.ts": "export const c = 1;\n",
    });

    git(repoDir, ["checkout", "-b", "feat/old-branch-name"]);
    writeRepoFile(repoDir, "src/core.ts", "export const c = 2;\n");
    git(repoDir, ["add", "src/core.ts"]);
    git(repoDir, ["commit", "-m", "feat: core v2"]);
    // Create a renamed branch pointing to the exact same commit
    git(repoDir, ["branch", "feat/new-branch-name", "feat/old-branch-name"]);
    git(repoDir, ["checkout", "main"]);

    const workDir = makeTempDir("v11-branch-rename-");
    const stateFile = path.join(workDir, "state.json");
    const recordFile = path.join(workDir, "records.jsonl");
    const ledgerFile = path.join(workDir, "review-ledger.json");

    writeTurnScript(stateFile, [
      { text: JSON.stringify({ findings: [] }) },
      { text: JSON.stringify({ findings: [] }) },
    ]);
    const baseEnv = {
      ...process.env,
      FAKE_AGY_STATE_FILE: stateFile,
      FAKE_AGY_RECORD_FILE: recordFile,
    };

    const snapOld = await extractBranchSnapshot({
      repoDir,
      targetRef: "feat/old-branch-name",
      baseBranch: "main",
      outputDir: path.join(workDir, "snap-old"),
    });
    const outOld = await reviewBranchSnapshot({
      snapshot: snapOld,
      ledgerFile,
      authorModel: "gemini-4-hydrogen-high",
      agyBin: FAKE_AGY_BIN,
      baseEnv,
    });
    assert.equal(outOld.status, "approved");
    assert.equal(outOld.cached, false);
    assert.equal(outOld.reviewerModel, "gemini-4-carbon-high");
    assert.equal(readJsonlRecords(recordFile).length, 1);

    // Renamed branch with same (headSha, mergeBaseSha, reviewerModel) -> cache HIT, 0 new agy calls!
    const snapNew = await extractBranchSnapshot({
      repoDir,
      targetRef: "feat/new-branch-name",
      baseBranch: "main",
      outputDir: path.join(workDir, "snap-new"),
    });
    const outRenamed = await reviewBranchSnapshot({
      snapshot: snapNew,
      ledgerFile,
      authorModel: "gemini-4-hydrogen-high",
      agyBin: FAKE_AGY_BIN,
      baseEnv,
    });
    assert.equal(outRenamed.status, "approved");
    assert.equal(outRenamed.cached, true);
    assert.equal(outRenamed.headSha, snapOld.headSha);
    assert.equal(readJsonlRecords(recordFile).length, 1);

    // Different reviewerModel on the same commit -> cache MISS, invokes new reviewer model!
    const outDifferentModel = await reviewBranchSnapshot({
      snapshot: snapNew,
      ledgerFile,
      reviewerModelOverride: "claude-opus-5-5-high",
      agyBin: FAKE_AGY_BIN,
      baseEnv,
    });
    assert.equal(outDifferentModel.status, "approved");
    assert.equal(outDifferentModel.cached, false);
    assert.equal(outDifferentModel.reviewerModel, "claude-opus-5-5-high");
    assert.equal(readJsonlRecords(recordFile).length, 2);

    // Legacy ledger compatibility: entry without blockingFindings still loads and hits cache
    const legacyLedgerFile = path.join(workDir, "legacy-ledger.json");
    writeFileSync(
      legacyLedgerFile,
      JSON.stringify(
        {
          version: 1,
          entries: [
            {
              targetRef: "feat/legacy-branch",
              baseBranch: "main",
              headSha: snapNew.headSha,
              mergeBaseSha: snapNew.mergeBaseSha,
              round: 1,
              status: "approved",
              reviewerModel: "gemini-4-carbon-high",
              findings: [],
              summary: "legacy approved",
              reviewedAt: "2026-11-01T00:00:00.000Z",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
    const outLegacy = await reviewBranchSnapshot({
      snapshot: snapNew,
      ledgerFile: legacyLedgerFile,
      authorModel: "gemini-4-hydrogen-high",
      agyBin: FAKE_AGY_BIN,
      baseEnv,
    });
    assert.equal(outLegacy.cached, true);
    assert.equal(outLegacy.summary, "legacy approved");
    assert.equal(readJsonlRecords(recordFile).length, 2);
  });
});
