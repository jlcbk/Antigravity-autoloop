/**
 * Deterministic in-memory projection state (`View`) and fact-application helpers.
 * Pure domain module: zero IO, zero ambient clocks, and zero external dependencies.
 */

import { InputError } from "./errors.ts";

export type Table =
  | "config"
  | "events"
  | "runs"
  | "run_events"
  | "cards"
  | "timers"
  | "schedules"
  | "pauses"
  | "skipped"
  | "seen"
  | "due";

export type Row = Record<string, any>;

export interface Change {
  table: Table;
  key: string;
  row: Row | null;
}

export interface Fact {
  version: 1;
  seq: number;
  at: number;
  type: string;
  changes: Change[];
}

export interface View {
  readonly seq: number;
  readonly next: Partial<Record<Table, number>>;
  get(table: Table, key: string | number): Row | undefined;
  set(table: Table, key: string | number, row: Row | null): void;
  all(table: Table): Row[];
  fork(): View;
}

interface TableBucket {
  map: Map<string, Row>;
  shared: boolean;
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

const NON_NEG_INT_RE = /^(0|[1-9]\d*)$/;

function parseSafeNonNegativeInt(key: string): number | null {
  if (!NON_NEG_INT_RE.test(key)) {
    return null;
  }
  const n = Number(key);
  return Number.isSafeInteger(n) ? n : null;
}

function compareKeys(a: string, b: string): number {
  const na = parseSafeNonNegativeInt(a);
  const nb = parseSafeNonNegativeInt(b);
  if (na !== null && nb !== null) {
    return na - nb;
  }
  if (na !== null) {
    return -1;
  }
  if (nb !== null) {
    return 1;
  }
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

function createViewFromState(
  initialSeq: number,
  next: Partial<Record<Table, number>>,
  buckets: Record<Table, TableBucket>,
): View {
  const view: View = {
    seq: initialSeq,
    next,
    get(table, key) {
      return buckets[table].map.get(String(key));
    },
    set(table, key, row) {
      let bucket = buckets[table];
      // Copy-on-write on first mutation after fork() so forks stay isolated at low cost.
      if (bucket.shared) {
        bucket = { map: new Map(bucket.map), shared: false };
        buckets[table] = bucket;
      }
      const k = String(key);
      if (row === null) {
        bucket.map.delete(k);
        return;
      }
      bucket.map.set(k, row);
      if (typeof row.id === "number" && Number.isFinite(row.id)) {
        const prev = next[table] ?? 0;
        if (row.id > prev) {
          next[table] = row.id;
        }
      }
    },
    all(table) {
      const entries = Array.from(buckets[table].map.entries());
      entries.sort((a, b) => compareKeys(a[0], b[0]));
      return entries.map((entry) => entry[1]);
    },
    fork() {
      const forkedBuckets = {} as Record<Table, TableBucket>;
      for (const table of ALL_TABLES) {
        buckets[table].shared = true;
        forkedBuckets[table] = {
          map: buckets[table].map,
          shared: true,
        };
      }
      return createViewFromState(view.seq, { ...next }, forkedBuckets);
    },
  };
  return view;
}

/**
 * Create an empty deterministic in-memory projection view.
 */
export function createMemoryView(): View {
  const buckets = {} as Record<Table, TableBucket>;
  for (const table of ALL_TABLES) {
    buckets[table] = { map: new Map<string, Row>(), shared: false };
  }
  return createViewFromState(0, {}, buckets);
}

/**
 * Apply a single fact's changes sequentially to `view` and advance `view.seq`.
 */
export function applyFact(view: View, fact: Fact): void {
  for (const change of fact.changes) {
    view.set(change.table, change.key, change.row);
  }
  (view as { seq: number }).seq = fact.seq;
}

/**
 * Convert an explicit epoch-millisecond timestamp into a UTC ISO-8601 string.
 */
export function iso(ms: number): string {
  if (!Number.isFinite(ms)) {
    throw new InputError(`无效时间戳: ${String(ms)}`);
  }
  return new Date(ms).toISOString();
}

function matchesFilter(row: Row, filter: Record<string, unknown>): boolean {
  for (const [key, expected] of Object.entries(filter)) {
    const actual = row[key];
    if (Array.isArray(expected)) {
      if (!expected.includes(actual)) {
        return false;
      }
    } else if (actual !== expected) {
      return false;
    }
  }
  return true;
}

/**
 * Query rows from `table` ordered by primary key, with optional filter, limit, and reverse.
 */
export function rows(
  view: View,
  table: Table,
  filter?: Record<string, unknown>,
  limit?: number,
  reverse?: boolean,
): Row[] {
  const allRows = view.all(table);
  const cap = limit === undefined ? Infinity : Math.max(0, limit);
  if (cap === 0 || allRows.length === 0) {
    return [];
  }

  const out: Row[] = [];
  if (reverse) {
    for (let i = allRows.length - 1; i >= 0; i--) {
      const row = allRows[i]!;
      if (filter && !matchesFilter(row, filter)) {
        continue;
      }
      out.push(row);
      if (out.length >= cap) {
        break;
      }
    }
    return out;
  }

  for (let i = 0; i < allRows.length; i++) {
    const row = allRows[i]!;
    if (filter && !matchesFilter(row, filter)) {
      continue;
    }
    out.push(row);
    if (out.length >= cap) {
      break;
    }
  }
  return out;
}
