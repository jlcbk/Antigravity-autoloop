/**
 * Single-transaction event-sourced storage engine backed by node:sqlite.
 * Maintains an append-only `facts` log, materialized `projections`,
 * read-only JSON-extract SQL views, and deterministic fingerprint-based rebuilds.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { ConflictError, InputError } from "./errors.ts";
import {
  applyFact,
  createMemoryView,
  type Fact,
  type Row,
  type Table,
  type View,
} from "./evolve.ts";

export const SCHEMA_FINGERPRINT = "autoloop-store-v1";

export interface OpenStoreOptions {
  fingerprint?: string;
}

export interface Store {
  readonly view: View;
  readonly fingerprint: string;
  commit(facts: readonly Fact[]): void;
  readFacts(afterSeq?: number, limit?: number): Fact[];
  queryAll<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
  close(): void;
}

const META_FINGERPRINT = "fingerprint";
const META_LAST_SEQ = "last_seq";
const META_HIGH_WATER_MARKS = "high_water_marks";
const META_PROJECTION_COUNT = "projection_count";

const HEX_RE = /^[0-9a-fA-F]+$/;
const HWM_MARKER_KEY = "__autoloop_hwm_restore__";

/**
 * Computes a lowercase hex SHA-256 digest of a UTF-8 string.
 */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Creates a deterministic per-run attempt HMAC-SHA256 token signer.
 * Requires a hex master key of at least 64 hex characters (32 bytes).
 */
export function createTokenSigner(
  masterKeyHex: string,
): (runId: number, attempt: number, claimId: string) => string {
  if (
    typeof masterKeyHex !== "string" ||
    masterKeyHex.length < 64 ||
    masterKeyHex.length % 2 !== 0 ||
    !HEX_RE.test(masterKeyHex)
  ) {
    throw new InputError(
      "masterKeyHex must be a valid even-length hex string of at least 64 characters (32 bytes)",
    );
  }
  const keyBytes = Buffer.from(masterKeyHex, "hex");
  if (keyBytes.length < 32) {
    throw new InputError("masterKeyHex must decode to at least 32 bytes");
  }

  return (runId: number, attempt: number, claimId: string): string => {
    if (!Number.isSafeInteger(runId) || !Number.isSafeInteger(attempt)) {
      throw new InputError("runId and attempt must be safe integers");
    }
    if (typeof claimId !== "string" || claimId.length === 0) {
      throw new InputError("claimId must be a non-empty string");
    }
    return createHmac("sha256", keyBytes)
      .update(`${runId}:${attempt}:${claimId}`, "utf8")
      .digest("hex");
  };
}

/**
 * Constant-time token comparison over fixed-length SHA-256 digests.
 */
export function safeTokenEquals(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }
  const digestA = createHash("sha256").update(a, "utf8").digest();
  const digestB = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(digestA, digestB);
}

function parseFactRow(row: Record<string, unknown>): Fact {
  const payload = JSON.parse(String(row.data)) as Record<string, unknown>;
  return {
    version: 1,
    seq: Number(row.seq),
    at: Number(row.at),
    type: String(row.type),
    changes: Array.isArray(payload.changes)
      ? (payload.changes as Fact["changes"])
      : [],
  };
}

function createReadViews(db: DatabaseSync): void {
  db.exec(`
    DROP VIEW IF EXISTS v_events;
    CREATE VIEW v_events AS
    SELECT
      key AS proj_key,
      json_extract(data, '$.id') AS id,
      json_extract(data, '$.source') AS source,
      json_extract(data, '$.key') AS event_key,
      json_extract(data, '$.type') AS type,
      json_extract(data, '$.subject') AS subject,
      json_extract(data, '$.summary') AS summary,
      json_extract(data, '$.link') AS link,
      json_extract(data, '$.hops') AS hops,
      json_extract(data, '$.received_at') AS received_at,
      data
    FROM projections
    WHERE collection = 'events';

    DROP VIEW IF EXISTS v_runs;
    CREATE VIEW v_runs AS
    SELECT
      key AS proj_key,
      json_extract(data, '$.id') AS id,
      json_extract(data, '$.rule') AS rule,
      json_extract(data, '$.rules_version') AS rules_version,
      json_extract(data, '$.agent') AS agent,
      json_extract(data, '$.grp') AS grp,
      json_extract(data, '$.lane') AS lane,
      json_extract(data, '$.status') AS status,
      json_extract(data, '$.attempts') AS attempts,
      json_extract(data, '$.session') AS session,
      json_extract(data, '$.summary') AS summary,
      json_extract(data, '$.error') AS error,
      json_extract(data, '$.usage') AS usage,
      json_extract(data, '$.usage.input') AS usage_input,
      json_extract(data, '$.usage.output') AS usage_output,
      json_extract(data, '$.usage.cached') AS usage_cached,
      json_extract(data, '$.usage.cost') AS usage_cost,
      json_extract(data, '$.created_at') AS created_at,
      json_extract(data, '$.not_before') AS not_before,
      json_extract(data, '$.claimed_at') AS claimed_at,
      json_extract(data, '$.started_at') AS started_at,
      json_extract(data, '$.heartbeat_at') AS heartbeat_at,
      json_extract(data, '$.ended_at') AS ended_at,
      data
    FROM projections
    WHERE collection = 'runs';

    DROP VIEW IF EXISTS v_cards;
    CREATE VIEW v_cards AS
    SELECT
      key AS proj_key,
      json_extract(data, '$.id') AS id,
      json_extract(data, '$.key') AS card_key,
      json_extract(data, '$.kind') AS kind,
      json_extract(data, '$.status') AS status,
      json_extract(data, '$.rule') AS rule,
      json_extract(data, '$.lane') AS lane,
      json_extract(data, '$.grp') AS grp,
      json_extract(data, '$.run_id') AS run_id,
      json_extract(data, '$.title') AS title,
      json_extract(data, '$.choice') AS choice,
      json_extract(data, '$.chosen') AS chosen,
      json_extract(data, '$.created_at') AS created_at,
      json_extract(data, '$.decided_at') AS decided_at,
      json_extract(data, '$.closed_at') AS closed_at,
      data
    FROM projections
    WHERE collection = 'cards';

    DROP VIEW IF EXISTS v_timers;
    CREATE VIEW v_timers AS
    SELECT
      key AS proj_key,
      json_extract(data, '$.id') AS id,
      json_extract(data, '$.rule') AS rule,
      json_extract(data, '$.lane') AS lane,
      json_extract(data, '$.key') AS timer_key,
      json_extract(data, '$.about') AS about,
      json_extract(data, '$.at') AS at,
      json_extract(data, '$.event_id') AS event_id,
      json_extract(data, '$.created_at') AS created_at,
      data
    FROM projections
    WHERE collection = 'timers';

    DROP VIEW IF EXISTS v_schedules;
    CREATE VIEW v_schedules AS
    SELECT
      key AS proj_key,
      json_extract(data, '$.rule') AS rule,
      json_extract(data, '$.cron') AS cron,
      json_extract(data, '$.timezone') AS timezone,
      json_extract(data, '$.next_at') AS next_at,
      json_extract(data, '$.last_run_at') AS last_run_at,
      json_extract(data, '$.skipped_at') AS skipped_at,
      data
    FROM projections
    WHERE collection = 'schedules';

    DROP VIEW IF EXISTS v_pauses;
    CREATE VIEW v_pauses AS
    SELECT
      key AS proj_key,
      json_extract(data, '$.rule') AS rule,
      json_extract(data, '$.reason') AS reason,
      json_extract(data, '$.paused_at') AS paused_at,
      json_extract(data, '$.until') AS until,
      data
    FROM projections
    WHERE collection = 'pauses';

    DROP VIEW IF EXISTS v_skipped;
    CREATE VIEW v_skipped AS
    SELECT
      key AS proj_key,
      json_extract(data, '$.id') AS id,
      json_extract(data, '$.rule') AS rule,
      json_extract(data, '$.event_id') AS event_id,
      json_extract(data, '$.source') AS source,
      json_extract(data, '$.source_name') AS source_name,
      json_extract(data, '$.type') AS type,
      json_extract(data, '$.subject') AS subject,
      json_extract(data, '$.received_at') AS received_at,
      json_extract(data, '$.replayed_at') AS replayed_at,
      json_extract(data, '$.replay_run_id') AS replay_run_id,
      data
    FROM projections
    WHERE collection = 'skipped';
  `);
}

function hydrateViewFromProjections(
  db: DatabaseSync,
  maxSeq: number,
  hwmJson: string | undefined,
): View {
  const view = createMemoryView();
  const stmt = db.prepare(
    "SELECT collection, key, data FROM projections ORDER BY collection ASC, key ASC",
  );
  for (const row of stmt.iterate()) {
    const table = String(row.collection) as Table;
    const key = String(row.key);
    const parsed = JSON.parse(String(row.data)) as Row;
    view.set(table, key, parsed);
  }

  if (hwmJson) {
    const savedNext = JSON.parse(hwmJson) as Record<string, unknown>;
    for (const [tableName, value] of Object.entries(savedNext)) {
      const table = tableName as Table;
      if (
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value > (view.next[table] ?? 0)
      ) {
        if (view.get(table, HWM_MARKER_KEY) === undefined) {
          view.set(table, HWM_MARKER_KEY, { id: value });
          view.set(table, HWM_MARKER_KEY, null);
        }
      }
    }
  }

  if (maxSeq > 0) {
    applyFact(view, {
      version: 1,
      seq: maxSeq,
      at: 0,
      type: "store.hydrate",
      changes: [],
    });
  }

  return view;
}

function rebuildFromFacts(db: DatabaseSync, fingerprint: string): View {
  const view = createMemoryView();
  const projectionMap = new Map<string, Map<string, Row>>();

  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DELETE FROM projections");

    const selectStmt = db.prepare(
      "SELECT seq, at, type, data FROM facts ORDER BY seq ASC",
    );
    for (const row of selectStmt.iterate()) {
      const fact = parseFactRow(row);
      applyFact(view, fact);
      for (const change of fact.changes) {
        let colMap = projectionMap.get(change.table);
        if (!colMap) {
          colMap = new Map<string, Row>();
          projectionMap.set(change.table, colMap);
        }
        if (change.row === null) {
          colMap.delete(change.key);
        } else {
          colMap.set(change.key, change.row);
        }
      }
    }

    const insertProjStmt = db.prepare(
      "INSERT INTO projections (collection, key, data) VALUES (?, ?, ?)",
    );
    let projCount = 0;
    for (const [collection, colMap] of projectionMap) {
      for (const [key, rowData] of colMap) {
        insertProjStmt.run(collection, key, JSON.stringify(rowData));
        projCount += 1;
      }
    }

    const upsertMetaStmt = db.prepare(
      "INSERT INTO store_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    upsertMetaStmt.run(META_FINGERPRINT, fingerprint);
    upsertMetaStmt.run(META_LAST_SEQ, String(view.seq));
    upsertMetaStmt.run(META_HIGH_WATER_MARKS, JSON.stringify(view.next));
    upsertMetaStmt.run(META_PROJECTION_COUNT, String(projCount));

    db.exec("COMMIT");
  } catch (err) {
    if (db.isTransaction) {
      db.exec("ROLLBACK");
    }
    throw err;
  }

  return view;
}

/**
 * Opens or initializes the SQLite event-sourced store at `dbPath`.
 * Rebuilds `projections` deterministically from `facts` whenever the schema
 * fingerprint, sequence watermark, or projection row count does not match.
 */
export function openStore(dbPath: string, options?: OpenStoreOptions): Store {
  if (typeof dbPath !== "string" || dbPath.trim().length === 0) {
    throw new InputError("dbPath must be a non-empty string");
  }
  const fingerprint = options?.fingerprint ?? SCHEMA_FINGERPRINT;
  if (typeof fingerprint !== "string" || fingerprint.trim().length === 0) {
    throw new InputError("fingerprint must be a non-empty string");
  }

  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS facts (
        seq INTEGER PRIMARY KEY,
        at INTEGER NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projections (
        collection TEXT NOT NULL,
        key TEXT NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (collection, key)
      );

      CREATE TABLE IF NOT EXISTS store_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    const metaRows = db
      .prepare("SELECT key, value FROM store_meta")
      .all() as Array<{ key: string; value: string }>;
    const meta = new Map<string, string>();
    for (const r of metaRows) {
      meta.set(r.key, r.value);
    }

    const seqRow = db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS max_seq FROM facts")
      .get() as { max_seq: number };
    const maxSeq = Number(seqRow.max_seq);

    const projCountRow = db
      .prepare("SELECT COUNT(*) AS cnt FROM projections")
      .get() as { cnt: number };
    const actualProjCount = Number(projCountRow.cnt);

    const canHydrate =
      meta.get(META_FINGERPRINT) === fingerprint &&
      meta.get(META_LAST_SEQ) === String(maxSeq) &&
      meta.get(META_PROJECTION_COUNT) === String(actualProjCount);

    const view = canHydrate
      ? hydrateViewFromProjections(db, maxSeq, meta.get(META_HIGH_WATER_MARKS))
      : rebuildFromFacts(db, fingerprint);

    createReadViews(db);

    const insertFactStmt = db.prepare(
      "INSERT INTO facts (seq, at, type, data) VALUES (?, ?, ?, ?)",
    );
    const upsertProjStmt = db.prepare(
      "INSERT INTO projections (collection, key, data) VALUES (?, ?, ?) ON CONFLICT(collection, key) DO UPDATE SET data = excluded.data",
    );
    const deleteProjStmt = db.prepare(
      "DELETE FROM projections WHERE collection = ? AND key = ?",
    );
    const countProjStmt = db.prepare("SELECT COUNT(*) AS cnt FROM projections");
    const upsertMetaStmt = db.prepare(
      "INSERT INTO store_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );

    return {
      get view(): View {
        return view;
      },

      get fingerprint(): string {
        return fingerprint;
      },

      commit(facts: readonly Fact[]): void {
        if (facts.length === 0) {
          return;
        }

        let expectedPrevSeq = view.seq;
        const projectedNext: Partial<Record<Table, number>> = { ...view.next };

        for (const fact of facts) {
          if (!Number.isSafeInteger(fact.seq) || fact.seq <= 0) {
            throw new InputError(`Invalid fact seq: ${String(fact.seq)}`);
          }
          if (fact.seq <= expectedPrevSeq) {
            throw new ConflictError(
              `Fact seq ${fact.seq} must be strictly greater than ${expectedPrevSeq}`,
            );
          }
          expectedPrevSeq = fact.seq;

          for (const change of fact.changes) {
            if (change.row !== null && typeof change.row.id === "number") {
              const prev = projectedNext[change.table] ?? 0;
              if (change.row.id > prev) {
                projectedNext[change.table] = change.row.id;
              }
            }
          }
        }

        db.exec("BEGIN IMMEDIATE");
        try {
          let lastSeq = view.seq;
          for (const fact of facts) {
            insertFactStmt.run(
              fact.seq,
              fact.at,
              fact.type,
              JSON.stringify({ version: fact.version, changes: fact.changes }),
            );
            for (const change of fact.changes) {
              if (change.row === null) {
                deleteProjStmt.run(change.table, change.key);
              } else {
                upsertProjStmt.run(
                  change.table,
                  change.key,
                  JSON.stringify(change.row),
                );
              }
            }
            lastSeq = fact.seq;
          }

          const cntRow = countProjStmt.get() as { cnt: number };
          upsertMetaStmt.run(META_FINGERPRINT, fingerprint);
          upsertMetaStmt.run(META_LAST_SEQ, String(lastSeq));
          upsertMetaStmt.run(
            META_HIGH_WATER_MARKS,
            JSON.stringify(projectedNext),
          );
          upsertMetaStmt.run(META_PROJECTION_COUNT, String(cntRow.cnt));

          db.exec("COMMIT");
        } catch (err) {
          if (db.isTransaction) {
            db.exec("ROLLBACK");
          }
          throw err;
        }

        for (const fact of facts) {
          applyFact(view, fact);
        }
      },

      readFacts(afterSeq = 0, limit?: number): Fact[] {
        if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
          throw new InputError("afterSeq must be a non-negative safe integer");
        }
        if (limit !== undefined) {
          if (!Number.isSafeInteger(limit) || limit < 0) {
            throw new InputError("limit must be a non-negative safe integer");
          }
          const rows = db
            .prepare(
              "SELECT seq, at, type, data FROM facts WHERE seq > ? ORDER BY seq ASC LIMIT ?",
            )
            .all(afterSeq, limit) as Array<Record<string, unknown>>;
          return rows.map(parseFactRow);
        }
        const rows = db
          .prepare(
            "SELECT seq, at, type, data FROM facts WHERE seq > ? ORDER BY seq ASC",
          )
          .all(afterSeq) as Array<Record<string, unknown>>;
        return rows.map(parseFactRow);
      },

      queryAll<T = Record<string, unknown>>(
        sql: string,
        params: unknown[] = [],
      ): T[] {
        const stmt = db.prepare(sql);
        const rows = stmt.all(...(params as SQLInputValue[])) as Array<
          Record<string, unknown>
        >;
        return rows.map((row) => ({ ...row })) as T[];
      },

      close(): void {
        if (db.isOpen) {
          db.close();
        }
      },
    };
  } catch (err) {
    if (db.isOpen) {
      db.close();
    }
    throw err;
  }
}
