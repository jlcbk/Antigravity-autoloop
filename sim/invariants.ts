/**
 * Global state-machine invariant checker (`INV-01` through `INV-12`) for both
 * SQLite-backed `Store` instances and pure in-memory `View` snapshots.
 *
 * Used by unit tests, the 200k-step deterministic simulator (`sim/random.ts`),
 * and the SIGKILL crash-recovery harness (`sim/crash.ts`).
 */

import type { RulesConfig } from "../protocol/types.ts";
import { MAX_HOPS } from "../kernel/decide.ts";
import { deadlines, type DueKind } from "../kernel/due.ts";
import { InputError } from "../kernel/errors.ts";
import {
  applyFact,
  createMemoryView,
  iso,
  type Fact,
  type Row,
  type Table,
  type View,
} from "../kernel/evolve.ts";
import { groupOf, rulesOf } from "../kernel/query.ts";
import type { Store } from "../kernel/store.ts";

export type InvariantCode =
  | "INV-01"
  | "INV-02"
  | "INV-03"
  | "INV-04"
  | "INV-05"
  | "INV-06"
  | "INV-07"
  | "INV-08"
  | "INV-09"
  | "INV-10"
  | "INV-11"
  | "INV-12";

export interface AssertInvariantsOptions {
  nowMs?: number;
  workerCapacity?: number;
}

/**
 * Thrown whenever any of the 12 core state-machine or persistence invariants is violated.
 */
export class InvariantViolationError extends Error {
  readonly code: InvariantCode;
  readonly context?: Record<string, unknown>;

  constructor(
    code: InvariantCode,
    message: string,
    context?: Record<string, unknown>,
  ) {
    super(`[${code}] ${message}`);
    this.name = "InvariantViolationError";
    this.code = code;
    if (context !== undefined) {
      this.context = context;
    }
  }
}

interface StoreHistory {
  configByVersion: Map<number, RulesConfig>;
  everCreatedRunIds: Set<number>;
  externalEventIds: Set<number>;
}

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

const ALL_TABLES_SET = new Set<string>(ALL_TABLES);
const VALID_RUN_STATUSES = new Set<string>([
  "queued",
  "claimed",
  "unknown",
  "done",
  "nothing",
  "failed",
  "cancelled",
]);
const TERMINAL_RUN_STATUSES = new Set<string>([
  "done",
  "nothing",
  "failed",
  "cancelled",
]);
const VALID_CARD_KINDS = new Set<string>(["ask", "notice"]);
const VALID_CARD_STATUSES = new Set<string>([
  "open",
  "decided",
  "done",
  "closed",
]);
const VALID_DUE_KINDS = new Set<DueKind>([
  "cron",
  "timer",
  "retry",
  "lease",
  "unpause",
]);
const ANS_CARD_KEY_RE = /^ans-card-\d+$/;
const TIMER_KEY_RE = /^timer:\d+:/;

function isStore(storeOrView: Store | View): storeOrView is Store {
  const candidate = storeOrView as Partial<Store>;
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    "view" in candidate &&
    typeof candidate.readFacts === "function" &&
    typeof candidate.queryAll === "function"
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPositiveSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function fail(
  code: InvariantCode,
  message: string,
  context?: Record<string, unknown>,
): never {
  throw new InvariantViolationError(code, message, context);
}

function deepEqualStrict(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") {
    if (Number.isNaN(a) && Number.isNaN(b)) {
      return true;
    }
    return a === b;
  }
  if (Object.is(a, b)) {
    return true;
  }
  if (
    typeof a !== "object" ||
    a === null ||
    typeof b !== "object" ||
    b === null
  ) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      if (!deepEqualStrict(a[i], b[i])) {
        return false;
      }
    }
    return true;
  }

  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA).filter((k) => objA[k] !== undefined);
  const keysB = Object.keys(objB).filter((k) => objB[k] !== undefined);
  if (keysA.length !== keysB.length) {
    return false;
  }
  for (const key of keysA) {
    if (
      !Object.prototype.hasOwnProperty.call(objB, key) ||
      !deepEqualStrict(objA[key], objB[key])
    ) {
      return false;
    }
  }
  return true;
}

function verifyStoreFactsAndProjections(store: Store): StoreHistory {
  const view = store.view;
  if (!Number.isSafeInteger(view.seq) || view.seq < 0) {
    fail(
      "INV-01",
      `store.view.seq 必须是非负安全整数，实际为 ${String(view.seq)}`,
      {
        viewSeq: view.seq,
      },
    );
  }

  // INV-01: Strictly contiguous `facts.seq` from 1 to `view.seq` without gaps or holes.
  const seqRows = store.queryAll<{ seq: number }>(
    "SELECT seq FROM facts ORDER BY seq ASC",
  );
  if (seqRows.length !== view.seq) {
    fail(
      "INV-01",
      `facts 行数 (${seqRows.length}) 与 store.view.seq (${view.seq}) 不一致`,
      { factCount: seqRows.length, viewSeq: view.seq },
    );
  }
  for (let i = 0; i < seqRows.length; i++) {
    const expectedSeq = i + 1;
    const actualSeq = seqRows[i]!.seq;
    if (actualSeq !== expectedSeq) {
      fail(
        "INV-01",
        `facts 序号出现空洞或错位：下标 ${i} 期望 seq=${expectedSeq}，实际 seq=${String(actualSeq)}`,
        { index: i, expectedSeq, actualSeq, viewSeq: view.seq },
      );
    }
  }

  // INV-02: Full replay of `store.readFacts()` must match `store.view` and SQLite `projections`.
  const facts: Fact[] = store.readFacts();
  if (facts.length !== view.seq) {
    fail(
      "INV-02",
      `readFacts() 返回数量 (${facts.length}) 与 store.view.seq (${view.seq}) 不一致`,
      { readCount: facts.length, viewSeq: view.seq },
    );
  }

  const replayed = createMemoryView();
  const replayedMap = new Map<Table, Map<string, Row>>();
  for (const table of ALL_TABLES) {
    replayedMap.set(table, new Map<string, Row>());
  }

  const configByVersion = new Map<number, RulesConfig>();
  const everCreatedRunIds = new Set<number>();
  const externalEventIds = new Set<number>();

  // Historical transition trackers over the fact stream
  const cancelledSessions = new Set<string>();
  const prevRuns = new Map<number, Row>();
  const runLifecycle = new Map<
    number,
    { status: string; hadCancelAt: boolean }
  >();
  const cardHistory = new Map<
    number,
    { everAnswered: boolean; everResolved: boolean }
  >();
  const replayedSkipped = new Map<
    string,
    { replayedAt: string; replayRunId: number }
  >();

  for (let i = 0; i < facts.length; i++) {
    const fact = facts[i]!;
    if (fact.seq !== i + 1) {
      fail(
        "INV-01",
        `readFacts() 序号不连续：期望 ${i + 1}，实际 ${fact.seq}`,
        { expectedSeq: i + 1, actualSeq: fact.seq },
      );
    }

    const isIngestFact =
      fact.type === "event.ingested" ||
      fact.type === "event.breaker_tripped" ||
      fact.type === "run.submitted";

    for (const change of fact.changes) {
      if (!ALL_TABLES_SET.has(change.table)) {
        fail(
          "INV-02",
          `Fact #${fact.seq} 包含未知投影表 "${String(change.table)}"`,
          {
            seq: fact.seq,
            table: change.table,
          },
        );
      }
      if (typeof change.key !== "string") {
        fail("INV-02", `Fact #${fact.seq} 包含非字符串主键`, {
          seq: fact.seq,
          table: change.table,
          key: change.key,
        });
      }

      const tableMap = replayedMap.get(change.table)!;
      if (change.row === null) {
        tableMap.delete(change.key);
        if (change.table === "runs") {
          const idNum = Number(change.key);
          if (Number.isSafeInteger(idNum)) {
            prevRuns.delete(idNum);
          }
        }
        if (change.table === "skipped" && replayedSkipped.has(change.key)) {
          fail(
            "INV-11",
            `Fact #${fact.seq} 删除了已补跑过的 skipped 记录 ${change.key}`,
            { seq: fact.seq, key: change.key },
          );
        }
        continue;
      }

      const row = change.row;
      tableMap.set(change.key, row);

      if (
        change.table === "config" &&
        change.key === "rules" &&
        typeof row.version === "number" &&
        row.value
      ) {
        configByVersion.set(row.version, row.value as RulesConfig);
      }

      if (
        change.table === "events" &&
        isIngestFact &&
        isPositiveSafeInt(row.id)
      ) {
        externalEventIds.add(row.id);
      }

      if (change.table === "runs") {
        const runId = Number(row.id);
        if (isPositiveSafeInt(runId)) {
          everCreatedRunIds.add(runId);

          const prevRun = prevRuns.get(runId);
          if (
            isNonEmptyString(row.session) &&
            cancelledSessions.has(row.session) &&
            prevRun?.session !== row.session &&
            row.status !== "cancelled" &&
            row.cancel_at == null
          ) {
            fail(
              "INV-06",
              `轮次 #${runId} 在 Fact #${fact.seq} 中继承了已取消轮次的会话 "${row.session}"`,
              { seq: fact.seq, runId, session: row.session },
            );
          }
          if (
            (row.status === "cancelled" || row.cancel_at != null) &&
            isNonEmptyString(row.session)
          ) {
            cancelledSessions.add(row.session);
          }
          prevRuns.set(runId, row);

          const prevLife = runLifecycle.get(runId);
          const nextStatus = String(row.status);
          if (prevLife) {
            if (prevLife.hadCancelAt && nextStatus === "queued") {
              fail(
                "INV-10",
                `轮次 #${runId} 在 Fact #${fact.seq} 中带有 cancel_at 却回流到 queued`,
                { seq: fact.seq, runId },
              );
            }
            if (
              prevLife.hadCancelAt &&
              (nextStatus === "done" ||
                nextStatus === "nothing" ||
                nextStatus === "failed")
            ) {
              fail(
                "INV-10",
                `轮次 #${runId} 在 Fact #${fact.seq} 中带有 cancel_at 却进入非取消终态 "${nextStatus}"`,
                { seq: fact.seq, runId, status: nextStatus },
              );
            }
            if (
              TERMINAL_RUN_STATUSES.has(prevLife.status) &&
              nextStatus !== prevLife.status
            ) {
              fail(
                "INV-10",
                `轮次 #${runId} 在 Fact #${fact.seq} 中从终态 "${prevLife.status}" 非法变更为 "${nextStatus}"`,
                {
                  seq: fact.seq,
                  runId,
                  prevStatus: prevLife.status,
                  nextStatus,
                },
              );
            }
          }
          runLifecycle.set(runId, {
            status: nextStatus,
            hadCancelAt: Boolean(
              prevLife?.hadCancelAt || row.cancel_at != null,
            ),
          });
        }
      }

      if (change.table === "cards" && isPositiveSafeInt(row.id)) {
        const cardId = row.id;
        const entry = cardHistory.get(cardId) ?? {
          everAnswered: false,
          everResolved: false,
        };
        if (
          row.decided_at != null ||
          row.answer_event != null ||
          row.status === "decided" ||
          row.status === "done"
        ) {
          entry.everAnswered = true;
        }
        if (row.resolved_reason != null) {
          entry.everResolved = true;
        }
        if (entry.everAnswered && entry.everResolved) {
          fail(
            "INV-09",
            `卡片 #${cardId} 在 Fact #${fact.seq} 中同时出现 answer 与 resolve 状态`,
            { seq: fact.seq, cardId },
          );
        }
        cardHistory.set(cardId, entry);
      }

      if (change.table === "skipped") {
        const prevReplay = replayedSkipped.get(change.key);
        if (row.replayed_at != null) {
          const replayRunId = Number(row.replay_run_id);
          if (
            prevReplay &&
            (prevReplay.replayedAt !== row.replayed_at ||
              prevReplay.replayRunId !== replayRunId)
          ) {
            fail(
              "INV-11",
              `skipped 记录 ${change.key} 在 Fact #${fact.seq} 中被重复补跑覆盖`,
              {
                seq: fact.seq,
                key: change.key,
                prevReplay,
                nextReplay: {
                  replayedAt: row.replayed_at,
                  replayRunId: row.replay_run_id,
                },
              },
            );
          }
          if (!prevReplay) {
            replayedSkipped.set(change.key, {
              replayedAt: String(row.replayed_at),
              replayRunId,
            });
          }
        } else if (prevReplay) {
          fail(
            "INV-11",
            `skipped 记录 ${change.key} 在 Fact #${fact.seq} 中丢失了已有的 replayed_at 标记`,
            { seq: fact.seq, key: change.key },
          );
        }
      }
    }

    applyFact(replayed, fact);
  }

  if (replayed.seq !== view.seq) {
    fail(
      "INV-02",
      `重放 seq (${replayed.seq}) 与 store.view.seq (${view.seq}) 不一致`,
      { replayedSeq: replayed.seq, viewSeq: view.seq },
    );
  }

  for (const table of ALL_TABLES) {
    const replayedNext = replayed.next[table] ?? 0;
    const viewNext = view.next[table] ?? 0;
    if (replayedNext !== viewNext) {
      fail(
        "INV-02",
        `表 "${table}" 自增高水位 view.next (${viewNext}) 与 facts 重放 (${replayedNext}) 不一致`,
        { table, viewNext, replayedNext },
      );
    }
  }

  // Compare replayed projections against SQLite `projections` table byte-for-byte.
  const projRows = store.queryAll<{
    collection: string;
    key: string;
    data: string;
  }>(
    "SELECT collection, key, data FROM projections ORDER BY collection ASC, key ASC",
  );

  let expectedTotalRows = 0;
  for (const tableMap of replayedMap.values()) {
    expectedTotalRows += tableMap.size;
  }

  if (projRows.length !== expectedTotalRows) {
    fail(
      "INV-02",
      `SQLite projections 行数 (${projRows.length}) 与 facts 重放行数 (${expectedTotalRows}) 不一致`,
      { sqlCount: projRows.length, replayedCount: expectedTotalRows },
    );
  }

  for (const proj of projRows) {
    if (!ALL_TABLES_SET.has(proj.collection)) {
      fail(
        "INV-02",
        `SQLite projections 出现未知集合 "${proj.collection}" (key=${proj.key})`,
        { collection: proj.collection, key: proj.key },
      );
    }
    const table = proj.collection as Table;
    const expectedRow = replayedMap.get(table)?.get(proj.key);
    if (expectedRow === undefined) {
      fail(
        "INV-02",
        `SQLite projections 存在多余记录 ${table}[${proj.key}]，无法由 facts 重放产生`,
        { table, key: proj.key },
      );
    }
    const expectedJson = JSON.stringify(expectedRow);
    if (proj.data !== expectedJson) {
      fail(
        "INV-02",
        `SQLite projections.${table}[${proj.key}] 与 facts 重放结果逐字节不一致`,
        {
          table,
          key: proj.key,
          expectedJson,
          actualJson: proj.data,
        },
      );
    }
  }

  // Compare replayed projections against in-memory `store.view`.
  for (const table of ALL_TABLES) {
    const expectedTableMap = replayedMap.get(table)!;
    const actualAll = view.all(table);
    if (actualAll.length !== expectedTableMap.size) {
      fail(
        "INV-02",
        `内存 view.${table} 行数 (${actualAll.length}) 与 facts 重放 (${expectedTableMap.size}) 不一致`,
        {
          table,
          viewCount: actualAll.length,
          replayedCount: expectedTableMap.size,
        },
      );
    }
    for (const [key, expectedRow] of expectedTableMap) {
      const actualRow = view.get(table, key);
      if (actualRow === undefined) {
        fail(
          "INV-02",
          `内存 view.${table}[${key}] 缺失（facts 重放应存在该记录）`,
          { table, key },
        );
      }
      if (
        !deepEqualStrict(actualRow, expectedRow) ||
        JSON.stringify(actualRow) !== JSON.stringify(expectedRow)
      ) {
        fail("INV-02", `内存 view.${table}[${key}] 与 facts 重放结果不一致`, {
          table,
          key,
          expectedJson: JSON.stringify(expectedRow),
          actualJson: JSON.stringify(actualRow),
        });
      }
    }
  }

  return { configByVersion, everCreatedRunIds, externalEventIds };
}

function checkConcurrencyLimits(
  view: View,
  runs: readonly Row[],
  options: AssertInvariantsOptions | undefined,
  storeHistory: StoreHistory | undefined,
): void {
  const claimedRuns: Row[] = [];
  for (const run of runs) {
    if (run.status === "claimed") {
      claimedRuns.push(run);
    }
  }

  if (options?.workerCapacity !== undefined) {
    if (
      typeof options.workerCapacity !== "number" ||
      !Number.isSafeInteger(options.workerCapacity) ||
      options.workerCapacity < 0
    ) {
      throw new InputError(
        `options.workerCapacity 必须是非负安全整数，实际为 ${String(options.workerCapacity)}`,
      );
    }
    if (claimedRuns.length > options.workerCapacity) {
      fail(
        "INV-03",
        `全局活跃 claimed 轮次数 (${claimedRuns.length}) 超过 workerCapacity (${options.workerCapacity})`,
        {
          claimedCount: claimedRuns.length,
          workerCapacity: options.workerCapacity,
        },
      );
    }
  }

  if (claimedRuns.length === 0) {
    return;
  }

  const currentRules = rulesOf(view);
  const claimedByGroup = new Map<string, number>();
  const claimedByRule = new Map<string, number>();
  const claimedByAgent = new Map<string, number>();

  for (const run of claimedRuns) {
    const grp = String(run.grp ?? "");
    const rule = String(run.rule ?? "");
    const agent = String(run.agent ?? "");
    claimedByGroup.set(grp, (claimedByGroup.get(grp) ?? 0) + 1);
    claimedByRule.set(rule, (claimedByRule.get(rule) ?? 0) + 1);
    claimedByAgent.set(agent, (claimedByAgent.get(agent) ?? 0) + 1);
  }

  if (currentRules) {
    const ruleByName = new Map(
      currentRules.config.rules.map((r) => [r.name, r]),
    );

    for (const run of claimedRuns) {
      const runVersion =
        typeof run.rules_version === "number"
          ? run.rules_version
          : currentRules.version;
      if (runVersion !== currentRules.version) {
        continue;
      }

      const ruleName = String(run.rule ?? "");
      const ruleSpec = ruleByName.get(ruleName);
      if (ruleSpec) {
        const expectedGrp = groupOf(ruleSpec);
        const actualGrp = String(run.grp ?? "");
        if (actualGrp !== expectedGrp) {
          fail(
            "INV-03",
            `轮次 #${String(run.id)} 并发组 "${actualGrp}" 与当前规则 "${ruleName}" 所属组 "${expectedGrp}" 不一致`,
            { runId: run.id, rule: ruleName, actualGrp, expectedGrp },
          );
        }

        const groupLimit = ruleSpec.parallel ?? 1;
        const groupActive = claimedByGroup.get(actualGrp) ?? 0;
        if (groupActive > groupLimit) {
          fail(
            "INV-03",
            `并发组 "${actualGrp}" 活跃 claimed 轮次数 (${groupActive}) 超过规则 "${ruleName}" 的 parallel 上限 (${groupLimit})`,
            {
              group: actualGrp,
              rule: ruleName,
              groupActive,
              groupLimit,
            },
          );
        }

        if (ruleSpec.maxActive !== undefined) {
          const ruleActive = claimedByRule.get(ruleName) ?? 0;
          if (ruleActive > ruleSpec.maxActive) {
            fail(
              "INV-04",
              `规则 "${ruleName}" 活跃 claimed 轮次数 (${ruleActive}) 超过 rule.maxActive (${ruleSpec.maxActive})`,
              {
                rule: ruleName,
                ruleActive,
                maxActive: ruleSpec.maxActive,
              },
            );
          }
        }
      }

      const agentId = String(run.agent ?? "");
      const agentProfile = currentRules.config.agents[agentId];
      if (agentProfile && agentProfile.maxActive !== undefined) {
        const agentActive = claimedByAgent.get(agentId) ?? 0;
        if (agentActive > agentProfile.maxActive) {
          fail(
            "INV-04",
            `执行器 "${agentId}" 活跃 claimed 轮次数 (${agentActive}) 超过 agent.maxActive (${agentProfile.maxActive})`,
            {
              agent: agentId,
              agentActive,
              maxActive: agentProfile.maxActive,
            },
          );
        }
      }
    }
  }

  // When full Store history is available, also verify runs claimed under prior rule versions
  // against the exact config version active when they were claimed.
  if (storeHistory && storeHistory.configByVersion.size > 0) {
    const versionsToCheck = new Set<number>();
    for (const run of claimedRuns) {
      if (typeof run.rules_version === "number") {
        versionsToCheck.add(run.rules_version);
      }
    }

    for (const version of versionsToCheck) {
      const cfg = storeHistory.configByVersion.get(version);
      if (!cfg) {
        continue;
      }
      const ruleByName = new Map(cfg.rules.map((r) => [r.name, r]));
      const upToGroup = new Map<string, number>();
      const upToRule = new Map<string, number>();
      const upToAgent = new Map<string, number>();

      for (const run of claimedRuns) {
        const rv =
          typeof run.rules_version === "number" ? run.rules_version : version;
        if (rv > version) {
          continue;
        }
        const g = String(run.grp ?? "");
        const rName = String(run.rule ?? "");
        const aId = String(run.agent ?? "");
        upToGroup.set(g, (upToGroup.get(g) ?? 0) + 1);
        upToRule.set(rName, (upToRule.get(rName) ?? 0) + 1);
        upToAgent.set(aId, (upToAgent.get(aId) ?? 0) + 1);
      }

      for (const run of claimedRuns) {
        if (run.rules_version !== version) {
          continue;
        }
        const ruleName = String(run.rule ?? "");
        const ruleSpec = ruleByName.get(ruleName);
        if (ruleSpec) {
          const actualGrp = String(run.grp ?? "");
          const groupLimit = ruleSpec.parallel ?? 1;
          const groupActive = upToGroup.get(actualGrp) ?? 0;
          if (groupActive > groupLimit) {
            fail(
              "INV-03",
              `规则版本 v${version} 下并发组 "${actualGrp}" 活跃 claimed 轮次数 (${groupActive}) 超过 parallel (${groupLimit})`,
              {
                rulesVersion: version,
                group: actualGrp,
                rule: ruleName,
                groupActive,
                groupLimit,
              },
            );
          }

          if (ruleSpec.maxActive !== undefined) {
            const ruleActive = upToRule.get(ruleName) ?? 0;
            if (ruleActive > ruleSpec.maxActive) {
              fail(
                "INV-04",
                `规则版本 v${version} 下规则 "${ruleName}" 活跃 claimed 轮次数 (${ruleActive}) 超过 rule.maxActive (${ruleSpec.maxActive})`,
                {
                  rulesVersion: version,
                  rule: ruleName,
                  ruleActive,
                  maxActive: ruleSpec.maxActive,
                },
              );
            }
          }
        }

        const agentId = String(run.agent ?? "");
        const agentProfile = cfg.agents[agentId];
        if (agentProfile && agentProfile.maxActive !== undefined) {
          const agentActive = upToAgent.get(agentId) ?? 0;
          if (agentActive > agentProfile.maxActive) {
            fail(
              "INV-04",
              `规则版本 v${version} 下执行器 "${agentId}" 活跃 claimed 轮次数 (${agentActive}) 超过 agent.maxActive (${agentProfile.maxActive})`,
              {
                rulesVersion: version,
                agent: agentId,
                agentActive,
                maxActive: agentProfile.maxActive,
              },
            );
          }
        }
      }
    }
  }
}

function checkRunLanesSessionsAndStopState(runs: readonly Row[]): {
  runsById: Map<number, Row>;
} {
  const runsById = new Map<number, Row>();
  const claimedByGroupLane = new Map<string, number[]>();
  const claimedByRuleLane = new Map<string, number[]>();
  const queuedByLane = new Map<string, number[]>();
  const activeSessions = new Map<string, number>();
  const cancelledBySession = new Map<string, Row[]>();
  const runsWithSession: Row[] = [];

  for (const run of runs) {
    const runId = run.id as number;
    if (isPositiveSafeInt(runId)) {
      runsById.set(runId, run);
    }

    const status = String(run.status ?? "");
    if (!VALID_RUN_STATUSES.has(status)) {
      fail("INV-10", `轮次 #${String(run.id)} 存在非法状态 "${status}"`, {
        runId: run.id,
        status,
      });
    }

    // INV-10: Stop state irreversibility & no `cancel_at != null && status === "queued"`
    if (run.cancel_at != null) {
      if (status === "queued") {
        fail(
          "INV-10",
          `轮次 #${String(run.id)} 已设置 cancel_at (${String(run.cancel_at)})，绝不能处于 queued 状态`,
          { runId: run.id, status, cancelAt: run.cancel_at },
        );
      }
      if (
        status !== "claimed" &&
        status !== "unknown" &&
        status !== "cancelled"
      ) {
        fail(
          "INV-10",
          `轮次 #${String(run.id)} 带有 cancel_at (${String(run.cancel_at)})，终态不能为 "${status}"`,
          { runId: run.id, status, cancelAt: run.cancel_at },
        );
      }
    }
    if (status === "cancelled") {
      if (!isNonEmptyString(run.cancel_at) || !isNonEmptyString(run.ended_at)) {
        fail(
          "INV-10",
          `已取消轮次 #${String(run.id)} 必须包含非空 cancel_at 与 ended_at`,
          { runId: run.id, cancelAt: run.cancel_at, endedAt: run.ended_at },
        );
      }
    }

    const ruleLaneKey = `${String(run.rule ?? "")}\0${String(run.lane ?? "")}`;
    const grpName = String(run.grp || run.rule || "");
    const grpLaneKey = `${grpName}\0${String(run.lane ?? "")}`;

    // INV-05: Per-(grp, lane) single claimed across rules in same group & per-(rule, lane) single non-cancelled queued
    if (status === "claimed") {
      const grpList = claimedByGroupLane.get(grpLaneKey) ?? [];
      grpList.push(runId);
      if (grpList.length >= 2) {
        fail(
          "INV-05",
          `并发组事项 (${grpName}, ${String(run.lane ?? "")}) 同时存在 ${grpList.length} 个 claimed 轮次: [${grpList.join(", ")}]`,
          { grp: grpName, rule: run.rule, lane: run.lane ?? "", runs: grpList },
        );
      }
      claimedByGroupLane.set(grpLaneKey, grpList);

      const ruleList = claimedByRuleLane.get(ruleLaneKey) ?? [];
      ruleList.push(runId);
      if (ruleList.length >= 2) {
        fail(
          "INV-05",
          `事项 (${String(run.rule)}, ${String(run.lane ?? "")}) 同时存在 ${ruleList.length} 个 claimed 轮次: [${ruleList.join(", ")}]`,
          { rule: run.rule, lane: run.lane ?? "", runs: ruleList },
        );
      }
      claimedByRuleLane.set(ruleLaneKey, ruleList);
    } else if (status === "queued" && run.cancel_at == null) {
      const list = queuedByLane.get(ruleLaneKey) ?? [];
      list.push(runId);
      if (list.length >= 2) {
        fail(
          "INV-05",
          `事项 (${String(run.rule)}, ${String(run.lane ?? "")}) 同时存在 ${list.length} 个未取消 queued 轮次: [${list.join(", ")}]`,
          { rule: run.rule, lane: run.lane ?? "", runs: list },
        );
      }
      queuedByLane.set(ruleLaneKey, list);
    }

    // INV-06: Active session exclusive lock + cancelled session non-inheritance
    if (isNonEmptyString(run.session)) {
      runsWithSession.push(run);
      if (status === "claimed" || status === "unknown") {
        const owner = activeSessions.get(run.session);
        if (owner !== undefined && owner !== runId) {
          fail(
            "INV-06",
            `活跃轮次 #${owner} 与 #${runId} 同时持有相同会话 "${run.session}"`,
            { session: run.session, runA: owner, runB: runId },
          );
        }
        activeSessions.set(run.session, runId);
      }
      if (status === "cancelled" || run.cancel_at != null) {
        const list = cancelledBySession.get(run.session) ?? [];
        list.push(run);
        cancelledBySession.set(run.session, list);
      }
    }
  }

  for (const rOther of runsWithSession) {
    const session = String(rOther.session);
    const cancelledList = cancelledBySession.get(session);
    if (!cancelledList) {
      continue;
    }

    const otherStatus = String(rOther.status);
    const otherClaimMs =
      typeof rOther.claimed_at === "string"
        ? Date.parse(rOther.claimed_at)
        : Number.NaN;

    for (const rCancelled of cancelledList) {
      if (rOther.id === rCancelled.id) {
        continue;
      }

      if (
        (otherStatus === "claimed" || otherStatus === "unknown") &&
        rCancelled.status === "cancelled"
      ) {
        fail(
          "INV-06",
          `活跃轮次 #${String(rOther.id)} (${otherStatus}) 持有已取消轮次 #${String(rCancelled.id)} 的会话 "${session}"`,
          {
            session,
            activeRunId: rOther.id,
            cancelledRunId: rCancelled.id,
          },
        );
      }

      const cancelIso = rCancelled.cancel_at ?? rCancelled.ended_at;
      const cancelMs =
        typeof cancelIso === "string" ? Date.parse(cancelIso) : Number.NaN;
      if (
        Number.isFinite(otherClaimMs) &&
        Number.isFinite(cancelMs) &&
        (otherClaimMs > cancelMs ||
          (otherClaimMs === cancelMs &&
            Number(rOther.id) > Number(rCancelled.id)))
      ) {
        fail(
          "INV-06",
          `轮次 #${String(rOther.id)} 在轮次 #${String(rCancelled.id)} 取消后错误继承了其会话 "${session}"`,
          {
            session,
            laterRunId: rOther.id,
            cancelledRunId: rCancelled.id,
            claimedAt: rOther.claimed_at,
            cancelAt: cancelIso,
          },
        );
      }
    }
  }

  return { runsById };
}

function checkHopsAndEvents(
  view: View,
  events: readonly Row[],
  runEvents: readonly Row[],
  seenRows: readonly Row[],
  answeredEventIds: ReadonlySet<number>,
  firedTimerEventIds: ReadonlySet<number>,
  storeHistory: StoreHistory | undefined,
): {
  eventById: Map<number, Row>;
  runEventsByEventId: Map<number, number[]>;
} {
  const eventById = new Map<number, Row>();
  const runEventsByEventId = new Map<number, number[]>();
  const seenSourceKeys = new Map<string, number>();

  for (const link of runEvents) {
    const eventId = Number(link.event_id);
    const runId = Number(link.run_id);
    const list = runEventsByEventId.get(eventId) ?? [];
    list.push(runId);
    runEventsByEventId.set(eventId, list);
  }

  for (const ev of events) {
    const evId = Number(ev.id);
    if (isPositiveSafeInt(evId)) {
      eventById.set(evId, ev);
    }

    // INV-07: Any event with hops > MAX_HOPS (> 8) must have 0 linked runs in `run_events`.
    if (typeof ev.hops === "number" && ev.hops > MAX_HOPS) {
      const linkedRuns = runEventsByEventId.get(evId) ?? [];
      if (linkedRuns.length > 0) {
        fail(
          "INV-07",
          `超跳数事件 #${evId} (hops=${ev.hops} > ${MAX_HOPS}) 在 run_events 中关联了 ${linkedRuns.length} 个轮次: [${linkedRuns.join(", ")}]`,
          { eventId: evId, hops: ev.hops, maxHops: MAX_HOPS, linkedRuns },
        );
      }
    }

    // INV-08: Global uniqueness of `(source, key)` in `events`.
    if (!isNonEmptyString(ev.source) || !isNonEmptyString(ev.key)) {
      fail("INV-08", `事件 #${String(ev.id)} 缺少合法的非空 source 或 key`, {
        eventId: ev.id,
        source: ev.source,
        key: ev.key,
      });
    }
    const composite = `${ev.source}\0${ev.key}`;
    const existingId = seenSourceKeys.get(composite);
    if (existingId !== undefined && existingId !== evId) {
      fail(
        "INV-08",
        `events 表存在重复 (source="${ev.source}", key="${ev.key}"): 事件 #${existingId} 与 #${evId}`,
        {
          source: ev.source,
          key: ev.key,
          eventIdA: existingId,
          eventIdB: evId,
        },
      );
    }
    seenSourceKeys.set(composite, evId);
  }

  // Catch orphaned run_events links pointing to a >MAX_HOPS event if id lookup missed
  for (const [eventId, linkedRuns] of runEventsByEventId) {
    const ev = eventById.get(eventId);
    if (
      ev &&
      typeof ev.hops === "number" &&
      ev.hops > MAX_HOPS &&
      linkedRuns.length > 0
    ) {
      fail(
        "INV-07",
        `超跳数事件 #${eventId} (hops=${ev.hops}) 存在 run_events 关联轮次`,
        { eventId, hops: ev.hops, linkedRuns },
      );
    }
  }

  // INV-08: Validate `seen` table consistency and uniqueness for external events.
  const seenEventIds = new Set<number>();
  const seenEventNames = new Set<string>();

  for (const seenRow of seenRows) {
    if (seenRow.kind !== "event") {
      continue;
    }
    if (!isPositiveSafeInt(seenRow.event_id)) {
      fail(
        "INV-08",
        `seen 事件索引 "${String(seenRow.name)}" 缺少合法的 event_id: ${String(seenRow.event_id)}`,
        { seenRow },
      );
    }
    const ev = eventById.get(seenRow.event_id);
    if (!ev) {
      fail(
        "INV-08",
        `seen 事件索引 "${String(seenRow.name)}" 指向不存在的事件 #${seenRow.event_id}`,
        { seenName: seenRow.name, eventId: seenRow.event_id },
      );
    }
    const expectedName = `${String(ev.source)}:${String(ev.key)}`;
    if (seenRow.name !== expectedName) {
      fail(
        "INV-08",
        `seen 事件索引 name ("${String(seenRow.name)}") 与事件 #${ev.id} 的 (${expectedName}) 不匹配`,
        { seenName: seenRow.name, expectedName, eventId: ev.id },
      );
    }
    if (seenEventIds.has(seenRow.event_id)) {
      fail("INV-08", `事件 #${seenRow.event_id} 在 seen 表中存在多条重复索引`, {
        eventId: seenRow.event_id,
      });
    }
    if (seenEventNames.has(expectedName)) {
      fail("INV-08", `事件键 (${expectedName}) 在 seen 表中存在多条重复索引`, {
        name: expectedName,
      });
    }
    if (view.get("seen", `event:${expectedName}`) !== seenRow) {
      fail("INV-08", `seen 表主键与 event:${expectedName} 不匹配`, {
        expectedKey: `event:${expectedName}`,
        eventId: ev.id,
      });
    }
    seenEventIds.add(seenRow.event_id);
    seenEventNames.add(expectedName);
  }

  for (const ev of events) {
    const evId = Number(ev.id);
    const isInternal = storeHistory
      ? !storeHistory.externalEventIds.has(evId) &&
        isInternalSystemEvent(ev, answeredEventIds, firedTimerEventIds)
      : isInternalSystemEvent(ev, answeredEventIds, firedTimerEventIds);

    if (isInternal) {
      continue;
    }

    const expectedKey = `event:${String(ev.source)}:${String(ev.key)}`;
    const seenRow = view.get("seen", expectedKey);
    if (!seenRow || seenRow.kind !== "event" || seenRow.event_id !== ev.id) {
      fail(
        "INV-08",
        `外部/衍生事件 #${String(ev.id)} (${String(ev.source)}:${String(ev.key)}) 在 seen 表中缺少唯一索引 "${expectedKey}"`,
        { eventId: ev.id, source: ev.source, key: ev.key, expectedKey },
      );
    }
  }

  return { eventById, runEventsByEventId };
}

function isInternalSystemEvent(
  ev: Row,
  answeredEventIds: ReadonlySet<number>,
  firedTimerEventIds: ReadonlySet<number>,
): boolean {
  const evId = Number(ev.id);
  const key = String(ev.key ?? "");
  const source = String(ev.source ?? "");
  const type = String(ev.type ?? "");

  if (
    type === "card.answered" &&
    ANS_CARD_KEY_RE.test(key) &&
    answeredEventIds.has(evId)
  ) {
    return true;
  }
  if (
    type === "timer.due" &&
    TIMER_KEY_RE.test(key) &&
    (firedTimerEventIds.has(evId) || typeof ev.timer_key === "string")
  ) {
    return true;
  }
  if (
    source === "manual" &&
    type === "manual.run" &&
    key.startsWith("manual:")
  ) {
    return true;
  }
  if (source === "cron" && type === "cron.due" && key.startsWith("cron:")) {
    return true;
  }
  return false;
}

function checkCards(cards: readonly Row[]): Set<number> {
  const openCardKeys = new Set<string>();
  const answeredEventIds = new Set<number>();

  for (const card of cards) {
    const cardId = card.id;
    const kind = String(card.kind ?? "");
    const status = String(card.status ?? "");

    if (!VALID_CARD_KINDS.has(kind)) {
      fail("INV-09", `卡片 #${String(cardId)} 类型非法: "${kind}"`, {
        cardId,
        kind,
      });
    }
    if (!VALID_CARD_STATUSES.has(status)) {
      fail("INV-09", `卡片 #${String(cardId)} 状态非法: "${status}"`, {
        cardId,
        status,
      });
    }

    if (
      typeof card.answer_event === "number" &&
      isPositiveSafeInt(card.answer_event)
    ) {
      answeredEventIds.add(card.answer_event);
    }

    // Mutual exclusion: a card cannot bear both answer metadata and resolve metadata.
    if (
      (card.decided_at != null || card.answer_event != null) &&
      card.resolved_reason != null
    ) {
      fail(
        "INV-09",
        `卡片 #${String(cardId)} 同时存在 answer (decided_at/answer_event) 与 resolved_reason`,
        {
          cardId,
          decidedAt: card.decided_at,
          answerEvent: card.answer_event,
          resolvedReason: card.resolved_reason,
        },
      );
    }

    if (card.fyi === true) {
      if (
        kind !== "notice" ||
        status !== "closed" ||
        !isNonEmptyString(card.closed_at)
      ) {
        fail(
          "INV-09",
          `fyi 通知卡 #${String(cardId)} 必须为 kind="notice", status="closed" 且包含非空 closed_at`,
          {
            cardId,
            kind,
            status,
            fyi: card.fyi,
            closedAt: card.closed_at,
          },
        );
      }
    }

    if (kind === "notice") {
      if (status !== "open" && status !== "closed") {
        fail(
          "INV-09",
          `notice 卡片 #${String(cardId)} 状态不能为 "${status}"`,
          { cardId, status },
        );
      }
      if (card.decided_at != null || card.answer_event != null) {
        fail(
          "INV-09",
          `notice 卡片 #${String(cardId)} 不应包含 decided_at 或 answer_event`,
          {
            cardId,
            decidedAt: card.decided_at,
            answerEvent: card.answer_event,
          },
        );
      }
    }

    if (status === "open") {
      if (
        card.decided_at != null ||
        card.closed_at != null ||
        card.resolved_reason != null ||
        card.answer_event != null
      ) {
        fail(
          "INV-09",
          `open 卡片 #${String(cardId)} 不应包含 decided/closed/resolved 字段`,
          {
            cardId,
            decidedAt: card.decided_at,
            closedAt: card.closed_at,
            resolvedReason: card.resolved_reason,
            answerEvent: card.answer_event,
          },
        );
      }

      const dedupeKey = `${kind}\0${String(card.rule ?? "")}\0${String(card.lane ?? "")}\0${String(card.key ?? "")}`;
      if (openCardKeys.has(dedupeKey)) {
        fail(
          "INV-09",
          `同一事项与类型下存在重复 open 卡片: (${kind}, rule="${String(card.rule)}", lane="${String(card.lane ?? "")}", key="${String(card.key)}")`,
          {
            cardId,
            kind,
            rule: card.rule,
            lane: card.lane ?? "",
            key: card.key,
          },
        );
      }
      openCardKeys.add(dedupeKey);
    } else if (kind === "ask" && (status === "decided" || status === "done")) {
      if (!isNonEmptyString(card.decided_at)) {
        fail(
          "INV-09",
          `${status} 状态的 ask 卡片 #${String(cardId)} 缺少非空 decided_at`,
          { cardId, status },
        );
      }
      if (!isPositiveSafeInt(card.answer_event)) {
        fail(
          "INV-09",
          `${status} 状态的 ask 卡片 #${String(cardId)} 缺少合法 answer_event`,
          { cardId, status, answerEvent: card.answer_event },
        );
      }
      if (status === "done" && !isNonEmptyString(card.closed_at)) {
        fail(
          "INV-09",
          `done 状态的 ask 卡片 #${String(cardId)} 缺少非空 closed_at`,
          { cardId },
        );
      }
    } else if (status === "closed") {
      if (!isNonEmptyString(card.closed_at)) {
        fail(
          "INV-09",
          `closed 状态的卡片 #${String(cardId)} 缺少非空 closed_at`,
          { cardId, kind },
        );
      }
      if (card.decided_at != null || card.answer_event != null) {
        fail(
          "INV-09",
          `closed 状态的卡片 #${String(cardId)} 不应包含 decided_at 或 answer_event`,
          {
            cardId,
            decidedAt: card.decided_at,
            answerEvent: card.answer_event,
          },
        );
      }
    }
  }

  return answeredEventIds;
}

function checkSkipped(
  view: View,
  skippedRows: readonly Row[],
  eventById: ReadonlyMap<number, Row>,
  runsById: ReadonlyMap<number, Row>,
  runEventsByEventId: ReadonlyMap<number, readonly number[]>,
  storeHistory: StoreHistory | undefined,
): void {
  const seenSkipIds = new Set<number>();
  const seenRuleEvents = new Set<string>();

  for (const skip of skippedRows) {
    if (!isPositiveSafeInt(skip.id)) {
      fail("INV-11", `skipped 记录缺少合法正整数 id: ${String(skip.id)}`, {
        skip,
      });
    }
    if (seenSkipIds.has(skip.id)) {
      fail("INV-11", `skipped 表出现重复 id=${skip.id}`, { id: skip.id });
    }
    seenSkipIds.add(skip.id);

    const ruleName = String(skip.rule ?? "");
    if (ruleName.length === 0) {
      fail("INV-11", `skipped 记录 #${skip.id} 缺少 rule 名称`, {
        skipId: skip.id,
      });
    }

    if (!isPositiveSafeInt(skip.event_id) || !eventById.has(skip.event_id)) {
      fail(
        "INV-11",
        `skipped 记录 #${skip.id} 引用了不存在的 event_id=${String(skip.event_id)}`,
        { skipId: skip.id, eventId: skip.event_id },
      );
    }

    const ruleEventKey = `${ruleName}\0${skip.event_id}`;
    if (seenRuleEvents.has(ruleEventKey)) {
      fail(
        "INV-11",
        `同一规则与事件 (${ruleName}, event=${skip.event_id}) 在 skipped 表中存在多条记录（禁止重复补跑标记）`,
        { rule: ruleName, eventId: skip.event_id },
      );
    }
    seenRuleEvents.add(ruleEventKey);

    if (skip.replayed_at != null) {
      if (!isNonEmptyString(skip.replayed_at)) {
        fail(
          "INV-11",
          `skipped 记录 #${skip.id} 的 replayed_at 必须是非空字符串`,
          { skipId: skip.id, replayedAt: skip.replayed_at },
        );
      }
      if (!isPositiveSafeInt(skip.replay_run_id)) {
        fail(
          "INV-11",
          `已补跑 skipped 记录 #${skip.id} 缺少合法正整数 replay_run_id: ${String(skip.replay_run_id)}`,
          { skipId: skip.id, replayRunId: skip.replay_run_id },
        );
      }

      const replayRun = runsById.get(skip.replay_run_id);
      if (replayRun) {
        if (String(replayRun.rule) !== ruleName) {
          fail(
            "INV-11",
            `skipped 记录 #${skip.id} (rule="${ruleName}") 关联的 replay_run_id=${skip.replay_run_id} 属于其他规则 "${String(replayRun.rule)}"`,
            {
              skipId: skip.id,
              rule: ruleName,
              replayRunId: skip.replay_run_id,
              runRule: replayRun.rule,
            },
          );
        }
      } else {
        // A replayed queued run may only disappear if a retrying run on the same rule absorbed it.
        const maxKnownRunId = view.next.runs;
        if (
          typeof maxKnownRunId === "number" &&
          skip.replay_run_id > maxKnownRunId
        ) {
          fail(
            "INV-11",
            `skipped 记录 #${skip.id} 关联的 replay_run_id=${skip.replay_run_id} 超过高水位 ${maxKnownRunId}`,
            {
              skipId: skip.id,
              replayRunId: skip.replay_run_id,
              maxKnownRunId,
            },
          );
        }
        if (
          storeHistory &&
          !storeHistory.everCreatedRunIds.has(skip.replay_run_id)
        ) {
          fail(
            "INV-11",
            `skipped 记录 #${skip.id} 关联的 replay_run_id=${skip.replay_run_id} 在历史 facts 中从未存在`,
            { skipId: skip.id, replayRunId: skip.replay_run_id },
          );
        }
        const linkedRunIds = runEventsByEventId.get(skip.event_id) ?? [];
        const hasSurvivingRuleRun = linkedRunIds.some((rid) => {
          const r = runsById.get(rid);
          return r !== undefined && String(r.rule) === ruleName;
        });
        if (!hasSurvivingRuleRun) {
          fail(
            "INV-11",
            `skipped 记录 #${skip.id} 关联的 replay_run_id=${skip.replay_run_id} 不存在，且该事件在规则 "${ruleName}" 下无合并承接轮次`,
            {
              skipId: skip.id,
              rule: ruleName,
              eventId: skip.event_id,
              replayRunId: skip.replay_run_id,
            },
          );
        }
      }
    } else if (skip.replay_run_id != null) {
      fail(
        "INV-11",
        `未补跑 skipped 记录 #${skip.id} 不应携带 replay_run_id=${String(skip.replay_run_id)}`,
        { skipId: skip.id, replayRunId: skip.replay_run_id },
      );
    }
  }
}

function checkDueIndex(
  view: View,
  dueRows: readonly Row[],
  nowMs: number | undefined,
): void {
  const seenDueKeys = new Set<string>();

  for (const row of dueRows) {
    if (
      typeof row.kind !== "string" ||
      !VALID_DUE_KINDS.has(row.kind as DueKind)
    ) {
      fail("INV-12", `due 行包含非法 kind: "${String(row.kind)}"`, { row });
    }
    if (!isNonEmptyString(row.target)) {
      fail("INV-12", `due 行缺少非空 target`, { row });
    }
    if (typeof row.at !== "number" || !Number.isFinite(row.at)) {
      fail(
        "INV-12",
        `due 行 (${row.kind}:${row.target}) 的 at 必须是有限数字`,
        {
          row,
        },
      );
    }
    let expectedIso: string;
    try {
      expectedIso = iso(row.at);
    } catch {
      fail(
        "INV-12",
        `due 行 (${row.kind}:${row.target}) 的 at 超出合法日期范围: ${row.at}`,
        {
          row,
        },
      );
    }
    if (!isNonEmptyString(row.iso_at) || row.iso_at !== expectedIso) {
      fail(
        "INV-12",
        `due 行 (${row.kind}:${row.target}) 的 iso_at ("${String(row.iso_at)}") 与 at (${row.at} -> "${expectedIso}") 不匹配`,
        { row, expectedIso },
      );
    }

    const key = `${row.kind}:${row.target}`;
    if (seenDueKeys.has(key)) {
      fail("INV-12", `due 表存在重复键值 "${key}"`, { key });
    }
    if (view.get("due", key) !== row) {
      fail("INV-12", `due 表索引键与行字段 "${key}" 不匹配`, { key, row });
    }
    seenDueKeys.add(key);
  }

  if (nowMs === undefined) {
    return;
  }

  if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) {
    throw new InputError(
      `options.nowMs 必须是有限时间戳，实际为 ${String(nowMs)}`,
    );
  }

  const expected = deadlines(view, nowMs);
  const expectedKeys = Object.keys(expected);

  if (dueRows.length !== expectedKeys.length) {
    fail(
      "INV-12",
      `due 表条目数 (${dueRows.length}) 与 deadlines(view, ${nowMs}) 结果数 (${expectedKeys.length}) 不一致`,
      {
        nowMs,
        actualKeys: Array.from(seenDueKeys).sort(),
        expectedKeys: [...expectedKeys].sort(),
      },
    );
  }

  for (const key of expectedKeys) {
    const expectedRow = expected[key]!;
    const actualRow = view.get("due", key);
    if (
      !actualRow ||
      actualRow.kind !== expectedRow.kind ||
      actualRow.target !== expectedRow.target ||
      actualRow.at !== expectedRow.at ||
      actualRow.iso_at !== expectedRow.iso_at
    ) {
      fail(
        "INV-12",
        `due["${key}"] 与 deadlines(view, ${nowMs}) 计算结果不一致`,
        { key, nowMs, actualRow, expectedRow },
      );
    }
  }
}

/**
 * Verifies all applicable state-machine and persistence invariants on a `Store`
 * (`INV-01`..`INV-12`) or pure in-memory `View` (`INV-03`..`INV-12`).
 * Throws `InvariantViolationError` with diagnostic context on the first violation.
 */
export function assertInvariants(
  storeOrView: Store | View,
  options?: AssertInvariantsOptions,
): void {
  if (typeof storeOrView !== "object" || storeOrView === null) {
    throw new InputError("storeOrView 必须是 Store 或 View 实例");
  }

  let view: View;
  let storeHistory: StoreHistory | undefined;

  if (isStore(storeOrView)) {
    storeHistory = verifyStoreFactsAndProjections(storeOrView);
    view = storeOrView.view;
  } else {
    view = storeOrView;
  }

  const runs = view.all("runs");
  const events = view.all("events");
  const runEvents = view.all("run_events");
  const cards = view.all("cards");
  const timers = view.all("timers");
  const skippedRows = view.all("skipped");
  const seenRows = view.all("seen");
  const dueRows = view.all("due");

  checkConcurrencyLimits(view, runs, options, storeHistory);
  const { runsById } = checkRunLanesSessionsAndStopState(runs);

  const answeredEventIds = checkCards(cards);
  const firedTimerEventIds = new Set<number>();
  for (const timer of timers) {
    if (isPositiveSafeInt(timer.event_id)) {
      firedTimerEventIds.add(timer.event_id);
    }
  }

  const { eventById, runEventsByEventId } = checkHopsAndEvents(
    view,
    events,
    runEvents,
    seenRows,
    answeredEventIds,
    firedTimerEventIds,
    storeHistory,
  );

  checkSkipped(
    view,
    skippedRows,
    eventById,
    runsById,
    runEventsByEventId,
    storeHistory,
  );

  checkDueIndex(view, dueRows, options?.nowMs);
}
