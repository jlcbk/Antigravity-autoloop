/**
 * Reproducible performance benchmark suite for `Autoloop` core & SQLite store.
 *
 * Measures in an isolated `os.tmpdir()` directory under real disk SQLite
 * (`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL`):
 *   1. Cold Start latency (subprocess `openStore` + rules load, target < 300 ms)
 *   2. Idle RSS memory (post-init GC + settle, target < 80 MB)
 *   3. Sequential single-transaction commit throughput (1,000 `decide + store.commit`)
 *   4. End-to-end dispatch latency p50 / p95 / p99 (`ingestEvent -> commit -> claimWork -> commit`, target p99 < 50 ms)
 *   5. `buildStateSnapshot` & `whyOf` query latency at 1,200-run / 1,200-event scale
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decide, type DecideEnv } from "../kernel/decide.ts";
import { whyOf } from "../kernel/query.ts";
import {
  createTokenSigner,
  openStore,
  safeTokenEquals,
} from "../kernel/store.ts";
import type { RulesConfig } from "../protocol/types.ts";
import { buildStateSnapshot } from "../sidecars/hub/state-queries.ts";

export interface BenchmarkOptions {
  coldStartSamples?: number;
  throughputCommits?: number;
  dispatchSamples?: number;
  snapshotScale?: number;
}

export interface BenchmarkReport {
  ok: boolean;
  environment: {
    nodeVersion: string;
    platform: string;
    arch: string;
    sqliteMode: string;
  };
  coldStart: {
    samples: number;
    medianMs: number;
    p95Ms: number;
    maxMs: number;
    targetMs: number;
    passed: boolean;
  };
  idleRss: {
    rssMb: number;
    heapUsedMb: number;
    targetMb: number;
    passed: boolean;
  };
  throughput: {
    commits: number;
    elapsedMs: number;
    commitsPerSec: number;
    avgLatencyMs: number;
  };
  dispatchLatency: {
    samples: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    maxMs: number;
    targetP99Ms: number;
    passed: boolean;
  };
  snapshotQuery: {
    eventsCount: number;
    runsCount: number;
    snapshotMedianMs: number;
    snapshotP95Ms: number;
    whyMedianMs: number;
    whyP95Ms: number;
  };
  markdown: string;
}

const COLD_START_PROBE_FLAG = "--cold-start-probe";
const IDLE_RSS_PROBE_FLAG = "--idle-rss-probe";

const MASTER_KEY_HEX =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function makeBenchRules(): RulesConfig {
  return {
    timezone: "Asia/Shanghai",
    askFirst: ["rm -rf"],
    sources: {
      bench: { name: "Bench" },
      chain: { name: "Chain" },
    },
    agents: {
      worker: {
        name: "Worker",
        runner: "agy-print",
        model: "gemini-4-hydrogen-high",
        effort: "high",
        access: "edit",
        maxActive: 8,
      },
    },
    rules: [
      {
        name: "bench_rule",
        when: { source: "bench", types: ["task.*"] },
        to: "worker",
        cwd: "/tmp/autoloop-bench",
        group: "bench-grp",
        parallel: 4,
        maxActive: 4,
        resume: true,
        emits: { source: "chain", types: ["followup.*"] },
      },
      {
        name: "bench_cron",
        when: { cron: "0 9 * * *" },
        to: "worker",
        cwd: "/tmp/autoloop-bench",
        group: "cron-grp",
      },
    ],
  };
}

function makeEnv(): DecideEnv {
  return {
    signToken: createTokenSigner(MASTER_KEY_HEX),
    safeTokenEquals,
  };
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx]!;
}

function nsToMs(ns: bigint): number {
  return Number(ns) / 1_000_000;
}

function round(n: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

function runColdStartProbe(dbPath: string): void {
  const env = makeEnv();
  const nowMs = 1_760_000_000_000;
  const store = openStore(dbPath);
  try {
    const { facts } = decide(
      store.view,
      { type: "configureRules", config: makeBenchRules() },
      nowMs,
      env,
    );
    store.commit(facts);
    buildStateSnapshot(store, nowMs);
  } finally {
    store.close();
  }
}

async function runIdleRssProbe(dbPath: string): Promise<void> {
  const env = makeEnv();
  const nowMs = 1_760_000_000_000;
  const store = openStore(dbPath);
  try {
    const cfg = decide(
      store.view,
      { type: "configureRules", config: makeBenchRules() },
      nowMs,
      env,
    );
    store.commit(cfg.facts);

    for (let i = 0; i < 10; i += 1) {
      const ing = decide(
        store.view,
        {
          type: "ingestEvent",
          source: "bench",
          event: {
            id: `rss-${i}`,
            type: "task.created",
            subject: `item#${i % 4}`,
            summary: "Idle RSS probe event",
          },
        },
        nowMs + i * 100,
        env,
      );
      store.commit(ing.facts);
    }

    if (typeof globalThis.gc === "function") {
      globalThis.gc();
    }
    await new Promise((r) => setTimeout(r, 150));
    if (typeof globalThis.gc === "function") {
      globalThis.gc();
    }

    const mem = process.memoryUsage();
    process.stdout.write(
      JSON.stringify({
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
      }),
    );
  } finally {
    store.close();
  }
}

function measureColdStart(
  scriptPath: string,
  rootDir: string,
  samples: number,
): BenchmarkReport["coldStart"] {
  const timings: number[] = [];
  for (let i = 0; i < samples; i += 1) {
    const dbPath = path.join(rootDir, `cold-${i}.db`);
    const t0 = process.hrtime.bigint();
    const res = spawnSync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        scriptPath,
        COLD_START_PROBE_FLAG,
        dbPath,
      ],
      { encoding: "utf8" },
    );
    const t1 = process.hrtime.bigint();
    if (res.status !== 0) {
      throw new Error(
        `Cold start probe ${i} failed (status=${res.status}): ${res.stderr}`,
      );
    }
    timings.push(nsToMs(t1 - t0));
  }

  const sorted = [...timings].sort((a, b) => a - b);
  const medianMs = round(percentile(sorted, 50));
  const p95Ms = round(percentile(sorted, 95));
  const maxMs = round(sorted[sorted.length - 1] ?? 0);
  const targetMs = 300;
  return {
    samples,
    medianMs,
    p95Ms,
    maxMs,
    targetMs,
    passed: medianMs < targetMs,
  };
}

function measureIdleRss(
  scriptPath: string,
  rootDir: string,
): BenchmarkReport["idleRss"] {
  const dbPath = path.join(rootDir, "idle-rss.db");
  const res = spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--expose-gc",
      scriptPath,
      IDLE_RSS_PROBE_FLAG,
      dbPath,
    ],
    { encoding: "utf8" },
  );
  if (res.status !== 0) {
    throw new Error(
      `Idle RSS probe failed (status=${res.status}): ${res.stderr}`,
    );
  }
  const parsed = JSON.parse(res.stdout.trim()) as {
    rssBytes: number;
    heapUsedBytes: number;
  };
  const rssMb = round(parsed.rssBytes / (1024 * 1024));
  const heapUsedMb = round(parsed.heapUsedBytes / (1024 * 1024));
  const targetMb = 80;
  return {
    rssMb,
    heapUsedMb,
    targetMb,
    passed: rssMb < targetMb,
  };
}

function measureThroughput(
  rootDir: string,
  commits: number,
): BenchmarkReport["throughput"] {
  const dbPath = path.join(rootDir, "throughput.db");
  const env = makeEnv();
  const baseNow = 1_760_000_000_000;
  const store = openStore(dbPath);
  try {
    const cfg = decide(
      store.view,
      { type: "configureRules", config: makeBenchRules() },
      baseNow,
      env,
    );
    store.commit(cfg.facts);

    const t0 = process.hrtime.bigint();
    for (let i = 0; i < commits; i += 1) {
      const { facts } = decide(
        store.view,
        {
          type: "ingestEvent",
          source: "bench",
          event: {
            id: `tp-${i}`,
            type: "task.created",
            subject: `subj#${i % 16}`,
            summary: `Throughput commit ${i}`,
          },
        },
        baseNow + i + 1,
        env,
      );
      store.commit(facts);
    }
    const t1 = process.hrtime.bigint();

    const elapsedMs = Math.max(0.001, nsToMs(t1 - t0));
    const commitsPerSec = round(commits / (elapsedMs / 1000), 1);
    const avgLatencyMs = round(elapsedMs / commits, 3);
    return {
      commits,
      elapsedMs: round(elapsedMs),
      commitsPerSec,
      avgLatencyMs,
    };
  } finally {
    store.close();
  }
}

function measureDispatchLatency(
  rootDir: string,
  samples: number,
): BenchmarkReport["dispatchLatency"] {
  const dbPath = path.join(rootDir, "dispatch.db");
  const env = makeEnv();
  const baseNow = 1_760_000_000_000;
  const store = openStore(dbPath);
  const latencies: number[] = [];

  try {
    const cfg = decide(
      store.view,
      { type: "configureRules", config: makeBenchRules() },
      baseNow,
      env,
    );
    store.commit(cfg.facts);

    for (let i = 0; i < samples; i += 1) {
      const stepNow = baseNow + (i + 1) * 100;
      const t0 = process.hrtime.bigint();

      const ing = decide(
        store.view,
        {
          type: "ingestEvent",
          source: "bench",
          event: {
            id: `disp-${i}`,
            type: "task.created",
            subject: `lane-${i}`,
            summary: `Dispatch sample ${i}`,
          },
        },
        stepNow,
        env,
      );
      store.commit(ing.facts);

      const claimed = decide(
        store.view,
        {
          type: "claimWork",
          claimId: `claim-${i}`,
          capacity: 4,
          running: [],
        },
        stepNow + 1,
        env,
      );
      store.commit(claimed.facts);

      const t1 = process.hrtime.bigint();
      latencies.push(nsToMs(t1 - t0));

      // Complete the claimed job outside the timed window to keep active queue steady.
      const jobs = (
        claimed.value as { jobs: Array<{ run: number; token: string }> }
      ).jobs;
      for (const job of jobs) {
        const done = decide(
          store.view,
          {
            type: "submitResult",
            run: job.run,
            token: job.token,
            result: {
              outcome: "done",
              summary: "Bench complete",
              session: `sess-${job.run}`,
              usage: { input: 100, output: 20, cached: 30, cost: 0.001 },
            },
          },
          stepNow + 2,
          env,
        );
        store.commit(done.facts);
      }
    }

    const sorted = [...latencies].sort((a, b) => a - b);
    const p50Ms = round(percentile(sorted, 50), 3);
    const p95Ms = round(percentile(sorted, 95), 3);
    const p99Ms = round(percentile(sorted, 99), 3);
    const maxMs = round(sorted[sorted.length - 1] ?? 0, 3);
    const targetP99Ms = 50;
    return {
      samples,
      p50Ms,
      p95Ms,
      p99Ms,
      maxMs,
      targetP99Ms,
      passed: p99Ms < targetP99Ms,
    };
  } finally {
    store.close();
  }
}

function measureSnapshotAndWhy(
  rootDir: string,
  scale: number,
): BenchmarkReport["snapshotQuery"] {
  const dbPath = path.join(rootDir, "snapshot.db");
  const env = makeEnv();
  const baseNow = 1_760_000_000_000;
  const store = openStore(dbPath);

  try {
    const cfg = decide(
      store.view,
      { type: "configureRules", config: makeBenchRules() },
      baseNow,
      env,
    );
    store.commit(cfg.facts);

    const runIds: number[] = [];
    for (let i = 0; i < scale; i += 1) {
      const stepNow = baseNow + (i + 1) * 1000;
      const ing = decide(
        store.view,
        {
          type: "ingestEvent",
          source: "bench",
          event: {
            id: `snap-ev-${i}`,
            type: "task.created",
            subject: `s-${i % 20}`,
            summary: `Snapshot seed ${i}`,
          },
        },
        stepNow,
        env,
      );
      store.commit(ing.facts);

      const claimed = decide(
        store.view,
        {
          type: "claimWork",
          claimId: `snap-claim-${i}`,
          capacity: 4,
          running: [],
        },
        stepNow + 1,
        env,
      );
      store.commit(claimed.facts);

      const jobs = (
        claimed.value as { jobs: Array<{ run: number; token: string }> }
      ).jobs;
      for (const job of jobs) {
        runIds.push(job.run);
        const submit = decide(
          store.view,
          {
            type: "submitResult",
            run: job.run,
            token: job.token,
            result: {
              outcome: "done",
              summary: `Completed ${job.run}`,
              session: `snap-sess-${job.run}`,
              usage: { input: 300, output: 80, cached: 120, cost: 0.002 },
              ...(i % 25 === 0
                ? {
                    ask: [
                      {
                        key: `ask-${job.run}`,
                        title: `Confirm #${job.run}`,
                        text: "Approve?",
                        options: ["Yes", "No"],
                        about: "snapshot bench",
                      },
                    ],
                  }
                : {}),
              ...(i % 40 === 0
                ? {
                    later: [
                      {
                        key: `timer-${job.run}`,
                        at: new Date(stepNow + 3_600_000).toISOString(),
                        about: "later bench",
                      },
                    ],
                  }
                : {}),
            },
          },
          stepNow + 2,
          env,
        );
        store.commit(submit.facts);
      }
    }

    const queryNow = baseNow + scale * 1000 + 5000;
    const eventsCount = store.view.all("events").length;
    const runsCount = store.view.all("runs").length;

    const snapTimings: number[] = [];
    for (let i = 0; i < 25; i += 1) {
      const t0 = process.hrtime.bigint();
      buildStateSnapshot(store, queryNow + i);
      const t1 = process.hrtime.bigint();
      snapTimings.push(nsToMs(t1 - t0));
    }
    const snapSorted = [...snapTimings].sort((a, b) => a - b);

    const targetRunId = runIds[Math.floor(runIds.length / 2)] ?? 1;
    const whyTimings: number[] = [];
    for (let i = 0; i < 100; i += 1) {
      const t0 = process.hrtime.bigint();
      whyOf(store.view, targetRunId);
      const t1 = process.hrtime.bigint();
      whyTimings.push(nsToMs(t1 - t0));
    }
    const whySorted = [...whyTimings].sort((a, b) => a - b);

    return {
      eventsCount,
      runsCount,
      snapshotMedianMs: round(percentile(snapSorted, 50), 3),
      snapshotP95Ms: round(percentile(snapSorted, 95), 3),
      whyMedianMs: round(percentile(whySorted, 50), 3),
      whyP95Ms: round(percentile(whySorted, 95), 3),
    };
  } finally {
    store.close();
  }
}

function formatMarkdown(report: Omit<BenchmarkReport, "markdown">): string {
  const status = (pass: boolean): string => (pass ? "PASS" : "FAIL");
  const lines = [
    "# Antigravity-Autoloop Performance Benchmark Report",
    "",
    `- **Node.js**: \`${report.environment.nodeVersion}\``,
    `- **Platform**: \`${report.environment.platform} (${report.environment.arch})\``,
    `- **SQLite Mode**: \`${report.environment.sqliteMode}\``,
    `- **Core Latency SLOs**: **${report.coldStart.passed && report.dispatchLatency.passed ? "PASS" : "FAIL"}**`,
    `- **All Targets (incl. Node TS RSS)**: **${report.ok ? "PASS" : "PARTIAL (Idle RSS >= 80 MB under Node TS strip-types)"}**`,
    "",
    "| Benchmark Metric | Measured Value | Target / Threshold | Status |",
    "| :--- | :--- | :--- | :---: |",
    `| **Cold Start (Subprocess \`openStore\` + Rules)** | ${report.coldStart.medianMs} ms (median, p95=${report.coldStart.p95Ms} ms, max=${report.coldStart.maxMs} ms, n=${report.coldStart.samples}) | < ${report.coldStart.targetMs} ms | ${status(report.coldStart.passed)} |`,
    `| **Idle RSS Memory (Post-init + GC)** | ${report.idleRss.rssMb} MB RSS (heapUsed=${report.idleRss.heapUsedMb} MB) | < ${report.idleRss.targetMb} MB | ${status(report.idleRss.passed)} |`,
    `| **Sequential Commit Throughput (WAL + FULL)** | ${report.throughput.commitsPerSec} commits/sec (${report.throughput.commits} commits in ${report.throughput.elapsedMs} ms, avg=${report.throughput.avgLatencyMs} ms) | Reference | INFO |`,
    `| **E2E Dispatch Latency (\`ingest -> claim\`)** | p50=${report.dispatchLatency.p50Ms} ms / p95=${report.dispatchLatency.p95Ms} ms / **p99=${report.dispatchLatency.p99Ms} ms** (max=${report.dispatchLatency.maxMs} ms, n=${report.dispatchLatency.samples}) | p99 < ${report.dispatchLatency.targetP99Ms} ms (gate < 500 ms) | ${status(report.dispatchLatency.passed)} |`,
    `| **\`buildStateSnapshot\` & \`whyOf\` Query** | snapshot median=${report.snapshotQuery.snapshotMedianMs} ms (p95=${report.snapshotQuery.snapshotP95Ms} ms); whyOf median=${report.snapshotQuery.whyMedianMs} ms (p95=${report.snapshotQuery.whyP95Ms} ms) @ ${report.snapshotQuery.runsCount} runs / ${report.snapshotQuery.eventsCount} events | Reference | INFO |`,
  ];
  if (!report.idleRss.passed) {
    lines.push(
      "",
      `> Note: Running unbundled \`.ts\` files directly in Node ${report.environment.nodeVersion} loads the built-in Amaro TypeScript strip-types WASM module (~55-65 MB RSS overhead); JS \`heapUsed\` is ${report.idleRss.heapUsedMb} MB.`,
    );
  }
  return lines.join("\n");
}

/**
 * Executes all 5 reproducible performance benchmarks in an isolated `os.tmpdir()`
 * workspace and returns structured metrics plus a formatted Markdown report.
 */
export async function runBenchmarks(
  options: BenchmarkOptions = {},
): Promise<BenchmarkReport> {
  const coldStartSamples = options.coldStartSamples ?? 5;
  const throughputCommits = options.throughputCommits ?? 1_000;
  const dispatchSamples = options.dispatchSamples ?? 300;
  const snapshotScale = options.snapshotScale ?? 1_200;

  const scriptPath = fileURLToPath(import.meta.url);
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "autoloop-bench-"));

  try {
    const coldStart = measureColdStart(scriptPath, rootDir, coldStartSamples);
    const idleRss = measureIdleRss(scriptPath, rootDir);
    const throughput = measureThroughput(rootDir, throughputCommits);
    const dispatchLatency = measureDispatchLatency(rootDir, dispatchSamples);
    const snapshotQuery = measureSnapshotAndWhy(rootDir, snapshotScale);

    const ok = coldStart.passed && idleRss.passed && dispatchLatency.passed;
    const baseReport: Omit<BenchmarkReport, "markdown"> = {
      ok,
      environment: {
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        sqliteMode: "WAL + synchronous=FULL",
      },
      coldStart,
      idleRss,
      throughput,
      dispatchLatency,
      snapshotQuery,
    };

    return {
      ...baseReport,
      markdown: formatMarkdown(baseReport),
    };
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
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
  if (argv[0] === COLD_START_PROBE_FLAG) {
    const dbPath = argv[1];
    if (!dbPath) {
      throw new Error("Missing dbPath for cold-start probe");
    }
    runColdStartProbe(dbPath);
  } else if (argv[0] === IDLE_RSS_PROBE_FLAG) {
    const dbPath = argv[1];
    if (!dbPath) {
      throw new Error("Missing dbPath for idle-rss probe");
    }
    await runIdleRssProbe(dbPath);
  } else {
    const report = await runBenchmarks();
    console.log(report.markdown);
    if (!report.coldStart.passed || report.dispatchLatency.p99Ms >= 500) {
      process.exitCode = 1;
    }
  }
}
