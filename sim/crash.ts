/**
 * Real OS subprocess `SIGKILL` (-9) crash-recovery harness for `kernel/store.ts`.
 *
 * Spawns worker subprocesses against a real on-disk SQLite WAL database
 * (`PRAGMA synchronous = FULL`), drives random state transitions via `decide()`,
 * emits newline-delimited `ACK:<seq>:<factType>` records ONLY after `store.commit()`
 * returns synchronously, and hard-kills workers with `SIGKILL` at arbitrary moments.
 *
 * After every crash, the parent reopens `hub.db`, verifies zero acknowledged fact loss
 * (`store.view.seq >= maxAckedSeq` and `store.view.seq <= maxAckedSeq + 1`), validates
 * all 12 state-machine & persistence invariants (`assertInvariants`), and periodically
 * forces a `fingerprint`-triggered full streaming rebuild from `facts`.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decide, type DecideEnv, type KernelInput } from "../kernel/decide.ts";
import { iso, type Fact, type Table, type View } from "../kernel/evolve.ts";
import { rulesOf } from "../kernel/query.ts";
import {
  SCHEMA_FINGERPRINT,
  createTokenSigner,
  openStore,
  safeTokenEquals,
  type Store,
} from "../kernel/store.ts";
import type { RulesConfig, RunResult } from "../protocol/types.ts";
import { assertInvariants } from "./invariants.ts";

export interface CrashCampaignOptions {
  iterations?: number;
  dbDir?: string;
  seed?: number;
  maxRunMs?: number;
}

export interface CrashCampaignReport {
  ok: boolean;
  seed: number;
  iterationsRequested: number;
  iterationsCompleted: number;
  totalAckedCommits: number;
  finalSeq: number;
  maxUnackedAhead: number;
  fingerprintRebuildChecks: number;
  durationMs: number;
  dbPath: string;
}

const DEFAULT_ITERATIONS = 500;
const DEFAULT_SEED = 12_648_430;
const WORKER_FLAG = "--worker";
const WORKER_ACK_TIMEOUT_MS = 10_000;
const WORKER_EXIT_TIMEOUT_MS = 5_000;
const MASTER_KEY_HEX =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const ALL_TABLES: readonly Table[] = [
  "config",
  "events",
  "runs",
  "run_events",
  "cards",
  "timers",
  "schedules",
  "pauses",
  "skipped",
  "seen",
  "due",
];

function createPrng(seed: number): () => number {
  let state = seed | 0 || 1;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function randInt(rng: () => number, min: number, maxInclusive: number): number {
  return min + Math.floor(rng() * (maxInclusive - min + 1));
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

function writeAllSync(fd: number, text: string): void {
  const buf = Buffer.from(text, "utf8");
  let offset = 0;
  while (offset < buf.length) {
    try {
      const written = writeSync(fd, buf, offset, buf.length - offset);
      if (written <= 0) {
        throw new Error("writeSync wrote 0 bytes");
      }
      offset += written;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EAGAIN" || code === "EINTR") {
        continue;
      }
      throw err;
    }
  }
}

function makeCrashRulesConfig(variant: number): RulesConfig {
  const parallelTriage = variant % 2 === 0 ? 2 : 3;
  return {
    timezone: "Asia/Shanghai",
    askFirst: ["rm -rf", "git push --force"],
    sources: {
      github: { name: "GitHub" },
      ci: { name: "CI" },
      chain: { name: "Chain" },
      manual: { name: "Manual" },
    },
    agents: {
      workerA: {
        name: "Worker A",
        runner: "agy-print",
        model: "gemini-4-hydrogen-high",
        effort: "high",
        access: "edit",
        maxActive: 4,
      },
      workerB: {
        name: "Worker B",
        runner: "agy-print",
        model: "gemini-4-carbon-high",
        effort: "medium",
        access: "read",
        maxActive: 2,
      },
    },
    rules: [
      {
        name: "triage",
        when: { source: "github", types: ["issue.*", "pr.opened"] },
        to: "workerA",
        cwd: "/tmp/autoloop-crash-repo",
        group: "triage-grp",
        parallel: parallelTriage,
        maxActive: 3,
        resume: true,
        emits: { source: "chain", types: ["followup.*"] },
      },
      {
        name: "ci_watch",
        when: { source: "ci", types: ["build.failed", "test.*"] },
        to: "workerB",
        cwd: "/tmp/autoloop-crash-repo",
        group: "ci-grp",
        parallel: 1,
        maxActive: 1,
        emits: { source: "chain", types: ["followup.*"] },
      },
      {
        name: "followup",
        when: { source: "chain", types: ["followup.*"] },
        to: "workerA",
        cwd: "/tmp/autoloop-crash-repo",
        group: "followup-grp",
        parallel: 2,
        maxActive: 2,
        resume: true,
        emits: { source: "chain", types: ["followup.*"] },
      },
      {
        name: "periodic",
        when: { cron: "*/5 * * * *" },
        to: "workerB",
        cwd: "/tmp/autoloop-crash-repo",
        group: "cron-grp",
      },
    ],
  };
}

function sessionForRun(runRow: Record<string, unknown>, iter: number): string {
  if (typeof runRow.session === "string" && runRow.session.length > 0) {
    return runRow.session;
  }
  const runId = Number(runRow.id);
  const attempts = Number(runRow.attempts ?? 1);
  return `sess-${iter}-${runId}-${attempts}`;
}

function buildRandomInput(
  view: View,
  rng: () => number,
  nowMs: number,
  iter: number,
  step: number,
): KernelInput {
  const runs = view.all("runs");
  const queuedRuns = runs.filter(
    (r) =>
      r.status === "queued" &&
      r.cancel_at == null &&
      Date.parse(String(r.not_before ?? "")) <= nowMs,
  );
  const claimedRuns = runs.filter((r) => r.status === "claimed");
  const unstartedClaimed = claimedRuns.filter(
    (r) => r.started_at == null && r.cancel_at == null,
  );
  const cards = view.all("cards");
  const openAskCards = cards.filter(
    (c) => c.kind === "ask" && c.status === "open",
  );
  const openAnyCards = cards.filter((c) => c.status === "open");
  const pauses = view.all("pauses");
  const pausedRuleNames = new Set(pauses.map((p) => String(p.rule)));
  const skippedUnreplayed = view
    .all("skipped")
    .filter((s) => s.replayed_at == null);

  const candidates: Array<() => KernelInput> = [];

  // Always allow ingesting a new event so the worker never stalls on empty queue.
  candidates.push(() => {
    const useGithub = rng() < 0.65;
    const source = useGithub ? "github" : "ci";
    const type = useGithub
      ? pick(rng, ["issue.opened", "issue.updated", "pr.opened"])
      : pick(rng, ["build.failed", "test.flaky"]);
    const subject = pick(rng, ["issue#1", "issue#2", "issue#3", "svc/api"]);
    return {
      type: "ingestEvent",
      source,
      event: {
        id: `crash-${iter}-${step}-${randInt(rng, 1, 999_999)}`,
        type,
        subject,
        summary: `Crash test event ${iter}.${step}`,
        detail: `Synthetic payload at ${nowMs}`,
        link: "https://example.com/item/1",
        hops: 0,
      },
    };
  });

  if (queuedRuns.length > 0) {
    candidates.push(() => ({
      type: "claimWork",
      claimId: `worker-${iter}-${step}`,
      capacity: 4,
      running: claimedRuns.map((r) => Number(r.id)),
    }));
  }

  if (unstartedClaimed.length > 0) {
    candidates.push(() => {
      const r = pick(rng, unstartedClaimed);
      return {
        type: "markStarted",
        run: Number(r.id),
        token: String(r.token),
        session: sessionForRun(r, iter),
      };
    });
  }

  if (claimedRuns.length > 0) {
    candidates.push(() => {
      const r = pick(rng, claimedRuns);
      const runId = Number(r.id);
      const attempts = Number(r.attempts ?? 1);
      const runSession = sessionForRun(r, iter);
      const roll = rng();

      let result: RunResult;
      if (roll < 0.12) {
        result = {
          outcome: "failed",
          error: `transient error #${step}`,
          session: runSession,
          usage: { input: 120, output: 30, cached: 40, cost: 0.001 },
        };
      } else if (roll < 0.22) {
        result = {
          outcome: "nothing",
          summary: "No actionable changes",
          session: runSession,
          usage: { input: 90, output: 15, cached: 50, cost: 0.0005 },
        };
      } else {
        result = {
          outcome: "done",
          summary: `Processed run ${runId} step ${step}`,
          session: runSession,
          usage: { input: 240, output: 85, cached: 100, cost: 0.002 },
        };

        if (rng() < 0.35) {
          result.ask = [
            {
              key: `ask-${runId}-${attempts}-${step}`,
              title: `Approve action for run ${runId}`,
              text: "Choose next step",
              options: ["Proceed", "Skip"],
              recommend: 0,
              about: "crash-test approval",
            },
          ];
        } else if (rng() < 0.25) {
          result.notice = [
            {
              key: `fyi-${runId}-${step}`,
              title: `FYI run ${runId}`,
              text: "Completed check",
              fyi: rng() < 0.6,
            },
          ];
        }

        if (rng() < 0.3) {
          result.later = [
            {
              key: `recheck-${runId}`,
              at: iso(nowMs + 45_000),
              about: "follow-up check",
            },
          ];
        }

        if (rng() < 0.25 && String(r.rule) !== "periodic") {
          result.events = [
            {
              id: `drv-${iter}-${runId}-${attempts}-${step}`,
              type: "followup.check",
              subject:
                typeof r.lane === "string" && r.lane.length > 0
                  ? r.lane
                  : "issue#1",
              summary: "Derived followup",
            },
          ];
        }

        if (openAnyCards.length > 0 && rng() < 0.2) {
          const c = pick(rng, openAnyCards);
          result.resolve = [
            {
              card: Number(c.id),
              reason: `Resolved by run ${runId}`,
            },
          ];
        }
      }

      return {
        type: "submitResult",
        run: runId,
        token: String(r.token),
        result,
      };
    });
  }

  if (openAskCards.length > 0) {
    candidates.push(() => {
      const card = pick(rng, openAskCards);
      const opts = Array.isArray(card.options) ? card.options : ["A", "B"];
      return {
        type: "answerCard",
        card: Number(card.id),
        choice: randInt(rng, 0, Math.max(0, opts.length - 1)),
      };
    });
  } else if (openAnyCards.length > 0 && rng() < 0.3) {
    candidates.push(() => {
      const card = pick(rng, openAnyCards);
      return {
        type: "resolveCard",
        card: Number(card.id),
        reason: "Reviewed by operator",
      };
    });
  }

  if (rng() < 0.12) {
    const targetRule = pick(rng, ["triage", "ci_watch"]);
    if (!pausedRuleNames.has(targetRule)) {
      candidates.push(() => ({
        type: "pauseRule",
        rule: targetRule,
        reason: "chaos pause",
        until: rng() < 0.5 ? iso(nowMs + 120_000) : null,
      }));
    } else {
      candidates.push(() =>
        skippedUnreplayed.some((s) => String(s.rule) === targetRule) &&
        rng() < 0.5
          ? { type: "replayRule", rule: targetRule }
          : { type: "resumeRule", rule: targetRule },
      );
    }
  }

  if ((queuedRuns.length > 0 || claimedRuns.length > 0) && rng() < 0.08) {
    const active = [...queuedRuns, ...claimedRuns];
    candidates.push(() => ({
      type: "stopRun",
      run: Number(pick(rng, active).id),
    }));
  }

  if (rng() < 0.08) {
    candidates.push(() => ({
      type: "runRule",
      rule: "periodic",
    }));
  }

  if (rng() < 0.03) {
    candidates.push(() => ({
      type: "configureRules",
      config: makeCrashRulesConfig(step),
    }));
  }

  // Periodic tick to trigger timers, crons, unpauses, and lease timeouts
  if (rng() < 0.18) {
    candidates.push(() => ({ type: "tick" }));
  }

  // Bias slightly toward claiming/completing so queues stay lively
  const chosen = pick(rng, candidates);
  return chosen();
}

function commitAndAck(
  store: Store,
  env: DecideEnv,
  input: KernelInput,
  nowMs: number,
): boolean {
  const { facts } = decide(store.view, input, nowMs, env);
  if (facts.length === 0) {
    return false;
  }
  store.commit(facts);
  const lastFact: Fact = facts[facts.length - 1]!;
  // Strictly after store.commit() returns synchronously (WAL + synchronous = FULL).
  writeAllSync(1, `ACK:${lastFact.seq}:${lastFact.type}\n`);
  return true;
}

function runWorkerProcess(args: string[]): void {
  const argMap = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i];
    const v = args[i + 1];
    if (k && v !== undefined) {
      argMap.set(k, v);
    }
  }

  const dbPath = argMap.get("--db");
  const seed = Number(argMap.get("--seed") ?? DEFAULT_SEED);
  const iter = Number(argMap.get("--iter") ?? 0);
  let nowMs = Number(argMap.get("--now") ?? 1_760_000_000_000);

  if (!dbPath) {
    throw new Error("--db is required in --worker mode");
  }

  const rng = createPrng(seed ^ ((iter + 1) * 0x9e3779b1));
  const signer = createTokenSigner(MASTER_KEY_HEX);
  const env: DecideEnv = { signToken: signer, safeTokenEquals };

  const store = openStore(dbPath);
  if (!rulesOf(store.view)) {
    commitAndAck(
      store,
      env,
      { type: "configureRules", config: makeCrashRulesConfig(0) },
      nowMs,
    );
  }

  let step = 0;
  while (true) {
    step += 1;
    nowMs += randInt(rng, 500, 30_000);
    const input = buildRandomInput(store.view, rng, nowMs, iter, step);
    try {
      commitAndAck(store, env, input, nowMs);
    } catch {
      // Fallback to guaranteed event ingestion if a randomly selected state changed
      commitAndAck(
        store,
        env,
        {
          type: "ingestEvent",
          source: "github",
          event: {
            id: `fallback-${iter}-${step}-${randInt(rng, 1, 999_999)}`,
            type: "issue.opened",
            subject: "issue#1",
          },
        },
        nowMs,
      );
    }

    if (step % 25 === 0) {
      store.queryAll("PRAGMA wal_checkpoint(PASSIVE)");
    }
  }
}

function snapshotTables(view: View): Record<Table, unknown[]> {
  const snap = {} as Record<Table, unknown[]>;
  for (const table of ALL_TABLES) {
    snap[table] = view.all(table);
  }
  return snap;
}

function snapshotHighWaterMarks(view: View): Record<Table, number> {
  const out = {} as Record<Table, number>;
  for (const table of ALL_TABLES) {
    out[table] = view.next[table] ?? 0;
  }
  return out;
}

function getLatestFactAt(store: Store): number | undefined {
  const rows = store.queryAll<{ at: number }>(
    "SELECT at FROM facts ORDER BY seq DESC LIMIT 1",
  );
  return rows.length > 0 ? Number(rows[0]!.at) : undefined;
}

function verifyFingerprintRebuild(
  dbPath: string,
  nowMs: number | undefined,
): void {
  const beforeStore = openStore(dbPath);
  let beforeJson = "";
  let beforeSeq = 0;
  let beforeNext = "";
  try {
    assertInvariants(beforeStore, nowMs !== undefined ? { nowMs } : undefined);
    beforeSeq = beforeStore.view.seq;
    beforeNext = JSON.stringify(snapshotHighWaterMarks(beforeStore.view));
    beforeJson = JSON.stringify(snapshotTables(beforeStore.view));
  } finally {
    beforeStore.close();
  }

  // Force fingerprint mismatch to trigger full streaming rebuild from `facts`.
  const rebuiltStore = openStore(dbPath, {
    fingerprint: "crash-rebuild-probe-v1",
  });
  try {
    assertInvariants(rebuiltStore, nowMs !== undefined ? { nowMs } : undefined);
    if (rebuiltStore.view.seq !== beforeSeq) {
      throw new Error(
        `Rebuild seq mismatch: expected ${beforeSeq}, got ${rebuiltStore.view.seq}`,
      );
    }
    const rebuiltNext = JSON.stringify(
      snapshotHighWaterMarks(rebuiltStore.view),
    );
    if (rebuiltNext !== beforeNext) {
      throw new Error(
        `Rebuild high-water marks mismatch: before=${beforeNext}, rebuilt=${rebuiltNext}`,
      );
    }
    const rebuiltJson = JSON.stringify(snapshotTables(rebuiltStore.view));
    if (rebuiltJson !== beforeJson) {
      throw new Error(
        "Rebuilt projection snapshot differs from pre-rebuild state",
      );
    }
  } finally {
    rebuiltStore.close();
  }

  // Restore default fingerprint so subsequent workers hydrate cleanly.
  const restoredStore = openStore(dbPath, { fingerprint: SCHEMA_FINGERPRINT });
  try {
    assertInvariants(
      restoredStore,
      nowMs !== undefined ? { nowMs } : undefined,
    );
    if (JSON.stringify(snapshotTables(restoredStore.view)) !== beforeJson) {
      throw new Error("Restored default-fingerprint projection differs");
    }
  } finally {
    restoredStore.close();
  }
}

async function runSingleCrashIteration(
  scriptPath: string,
  dbPath: string,
  seed: number,
  iter: number,
  nowMs: number,
  rng: () => number,
): Promise<{ maxAckedSeq: number; ackCount: number }> {
  const targetAcks = randInt(rng, 1, 8);
  const postAckDelayMs = rng() < 0.4 ? 0 : randInt(rng, 1, 6);

  return await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        scriptPath,
        WORKER_FLAG,
        "--db",
        dbPath,
        "--seed",
        String(seed),
        "--iter",
        String(iter),
        "--now",
        String(nowMs),
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let maxAckedSeq = 0;
    let ackCount = 0;
    let stdoutBuf = "";
    let stderrBuf = "";
    let killScheduled = false;
    let killSent = false;
    let settled = false;
    let delayTimer: ReturnType<typeof setTimeout> | undefined;

    const ackTimeout = setTimeout(() => {
      if (!killSent && child.pid) {
        killSent = true;
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          // ignore
        }
      }
      if (!settled) {
        settled = true;
        reject(
          new Error(
            `Worker iteration ${iter} timed out waiting for ACKs (ackCount=${ackCount}, stderr=${stderrBuf})`,
          ),
        );
      }
    }, WORKER_ACK_TIMEOUT_MS);

    let exitTimeout: ReturnType<typeof setTimeout> | undefined;

    const triggerKill = (): void => {
      if (killSent || !child.pid) {
        return;
      }
      killSent = true;
      clearTimeout(ackTimeout);
      try {
        process.kill(child.pid, "SIGKILL");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
          settled = true;
          reject(err);
          return;
        }
      }
      exitTimeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(
            new Error(`Worker iteration ${iter} did not exit after SIGKILL`),
          );
        }
      }, WORKER_EXIT_TIMEOUT_MS);
    };

    const processLines = (chunk: string): void => {
      stdoutBuf += chunk;
      let nlIdx = stdoutBuf.indexOf("\n");
      while (nlIdx !== -1) {
        const line = stdoutBuf.slice(0, nlIdx).trim();
        stdoutBuf = stdoutBuf.slice(nlIdx + 1);
        if (line.startsWith("ACK:")) {
          const parts = line.split(":");
          const seq = Number(parts[1]);
          if (Number.isSafeInteger(seq) && seq > maxAckedSeq) {
            maxAckedSeq = seq;
          }
          ackCount += 1;
          if (!killScheduled && ackCount >= targetAcks) {
            killScheduled = true;
            if (postAckDelayMs === 0) {
              triggerKill();
            } else {
              delayTimer = setTimeout(triggerKill, postAckDelayMs);
            }
          }
        }
        nlIdx = stdoutBuf.indexOf("\n");
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", processLines);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrBuf += chunk;
    });

    child.on("error", (err) => {
      clearTimeout(ackTimeout);
      if (delayTimer) clearTimeout(delayTimer);
      if (exitTimeout) clearTimeout(exitTimeout);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    child.on("close", (code, signal) => {
      clearTimeout(ackTimeout);
      if (delayTimer) clearTimeout(delayTimer);
      if (exitTimeout) clearTimeout(exitTimeout);
      if (settled) {
        return;
      }
      settled = true;

      if (!killSent) {
        reject(
          new Error(
            `Worker iteration ${iter} exited unexpectedly before SIGKILL (code=${String(code)}, signal=${String(signal)}, stderr=${stderrBuf})`,
          ),
        );
        return;
      }

      if (signal !== "SIGKILL" && code === 0) {
        reject(
          new Error(
            `Worker iteration ${iter} exited cleanly instead of SIGKILL`,
          ),
        );
        return;
      }

      resolve({ maxAckedSeq, ackCount });
    });
  });
}

/**
 * Runs a multi-iteration real `SIGKILL` crash-recovery campaign against an
 * on-disk SQLite WAL database (`hub.db`), verifying durability, zero torn
 * transactions, and all 12 state-machine invariants after every kill.
 */
export async function runCrashCampaign(
  options: CrashCampaignOptions = {},
): Promise<CrashCampaignReport> {
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const seed = options.seed ?? DEFAULT_SEED;
  const maxRunMs = options.maxRunMs;

  if (!Number.isSafeInteger(iterations) || iterations <= 0) {
    throw new Error(`iterations must be a positive integer, got ${iterations}`);
  }

  const ownsTempDir = !options.dbDir;
  const dbDir =
    options.dbDir ?? mkdtempSync(path.join(os.tmpdir(), "autoloop-crash-"));
  mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, "hub.db");
  const scriptPath = fileURLToPath(import.meta.url);

  const rng = createPrng(seed);
  const startedAt = Date.now();
  let totalAckedCommits = 0;
  let lastSeq = 0;
  let lastFactAt = 1_760_000_000_000;
  let maxUnackedAhead = 0;
  let fingerprintRebuildChecks = 0;
  let iterationsCompleted = 0;

  try {
    for (let iter = 0; iter < iterations; iter += 1) {
      if (
        maxRunMs !== undefined &&
        iter > 0 &&
        Date.now() - startedAt >= maxRunMs
      ) {
        break;
      }

      const iterNowMs = lastFactAt + 1_000;
      const { maxAckedSeq, ackCount } = await runSingleCrashIteration(
        scriptPath,
        dbPath,
        seed,
        iter,
        iterNowMs,
        rng,
      );

      totalAckedCommits += ackCount;

      let observedFactAt: number | undefined;
      const store = openStore(dbPath);
      try {
        // 1. Verify SQLite integrity
        const integrity = store.queryAll<{ integrity_check: string }>(
          "PRAGMA integrity_check",
        );
        if (integrity[0]?.integrity_check !== "ok") {
          throw new Error(
            `SQLite integrity_check failed after iter ${iter}: ${JSON.stringify(integrity)}`,
          );
        }

        // 2. Verify zero acknowledged fact loss & no torn partial writes
        if (store.view.seq < maxAckedSeq) {
          throw new Error(
            `DATA LOSS at iter ${iter}: store.view.seq=${store.view.seq} < maxAckedSeq=${maxAckedSeq}`,
          );
        }
        const ahead = store.view.seq - maxAckedSeq;
        if (ahead > maxUnackedAhead) {
          maxUnackedAhead = ahead;
        }
        if (ahead > 1) {
          throw new Error(
            `Unexpected unacked ahead gap at iter ${iter}: store.view.seq=${store.view.seq}, maxAckedSeq=${maxAckedSeq}`,
          );
        }

        // Verify maxAckedSeq exists in facts table
        if (maxAckedSeq > 0) {
          const factCheck = store.queryAll<{ seq: number }>(
            "SELECT seq FROM facts WHERE seq = ?",
            [maxAckedSeq],
          );
          if (factCheck.length !== 1) {
            throw new Error(
              `Acked seq ${maxAckedSeq} missing from facts table at iter ${iter}`,
            );
          }
        }

        observedFactAt = getLatestFactAt(store);
        if (observedFactAt !== undefined && observedFactAt > lastFactAt) {
          lastFactAt = observedFactAt;
        }

        // 3. Verify all 12 global invariants
        assertInvariants(
          store,
          observedFactAt !== undefined ? { nowMs: observedFactAt } : undefined,
        );
        lastSeq = store.view.seq;
      } finally {
        store.close();
      }

      // 4. Periodically force fingerprint-triggered full streaming rebuild
      const shouldCheckRebuild =
        iter === iterations - 1 ||
        iter % 10 === 0 ||
        (iterations <= 10 && iter === Math.floor(iterations / 2));
      if (shouldCheckRebuild) {
        verifyFingerprintRebuild(dbPath, observedFactAt);
        fingerprintRebuildChecks += 1;
      }

      iterationsCompleted = iter + 1;
    }

    return {
      ok: true,
      seed,
      iterationsRequested: iterations,
      iterationsCompleted,
      totalAckedCommits,
      finalSeq: lastSeq,
      maxUnackedAhead,
      fingerprintRebuildChecks,
      durationMs: Date.now() - startedAt,
      dbPath,
    };
  } finally {
    if (ownsTempDir) {
      rmSync(dbDir, { recursive: true, force: true });
    }
  }
}

function isMainEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
}

if (isMainEntry()) {
  const argv = process.argv.slice(2);
  if (argv[0] === WORKER_FLAG) {
    runWorkerProcess(argv.slice(1));
  } else {
    let iterations = DEFAULT_ITERATIONS;
    let seed = DEFAULT_SEED;
    let dbDir: string | undefined;
    let maxRunMs: number | undefined;

    const positional: string[] = [];
    for (let i = 0; i < argv.length; i += 1) {
      const a = argv[i]!;
      if (a === "--db-dir" && argv[i + 1]) {
        dbDir = argv[++i];
      } else if (a === "--seed" && argv[i + 1]) {
        seed = Number(argv[++i]);
      } else if (a === "--iterations" && argv[i + 1]) {
        iterations = Number(argv[++i]);
      } else if (a === "--max-run-ms" && argv[i + 1]) {
        maxRunMs = Number(argv[++i]);
      } else if (!a.startsWith("-")) {
        positional.push(a);
      }
    }

    if (positional[0] !== undefined) {
      iterations = Number(positional[0]);
    }
    if (positional[1] !== undefined) {
      seed = Number(positional[1]);
    }

    const report = await runCrashCampaign({
      iterations,
      seed,
      ...(dbDir ? { dbDir } : {}),
      ...(maxRunMs !== undefined ? { maxRunMs } : {}),
    });

    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) {
      process.exitCode = 1;
    }
  }
}
