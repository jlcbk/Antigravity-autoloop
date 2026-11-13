/**
 * File watcher event source and `rules.json` hot-reloader.
 * Watches `<autoloopHome>/rules.json` for safe hot reload (never crashing on syntax errors)
 * and dynamically manages debounced `fs.watch` listeners for active `{ watch }` rules.
 */

import {
  existsSync,
  readFileSync,
  statSync,
  watch,
  type FSWatcher,
} from "node:fs";
import path from "node:path";
import { expandHomePath } from "../../engine/context-file.ts";
import { rulesOf } from "../../kernel/query.ts";
import { sha256Hex } from "../../kernel/store.ts";
import type { InboundEvent, RulesConfig } from "../../protocol/types.ts";
import type { HubRuntime } from "./ipc-server.ts";

export interface FileWatcherOptions {
  runtime: HubRuntime;
  rulesFilePath?: string;
  rulesDebounceMs?: number;
  rulesPollMs?: number;
  defaultWatchDebounceMs?: number;
  now?: () => number;
  onWarning?: (message: string, err?: unknown) => void;
}

export interface ReloadRulesResult {
  loaded: boolean;
  reason?: "missing" | "unchanged" | "invalid";
  error?: string;
}

export interface FileWatcherHandle {
  start(): void;
  close(): void;
  reloadRules(force?: boolean): ReloadRulesResult;
  syncWatches(config: RulesConfig | null | undefined): void;
  watchedPaths(): string[];
}

interface WatchEntry {
  resolvedPath: string;
  isDir: boolean;
  debounceMs: number;
  eventType: string;
  watcher: FSWatcher;
  pendingTimers: Map<string, ReturnType<typeof setTimeout>>;
}

const EVENT_TYPE_RE = /^[a-zA-Z0-9._-]+$/;
const SUBJECT_START_RE = /^[a-zA-Z0-9#]/;

function resolveWatchTargetPath(rawPath: string, ruleCwd: string): string {
  if (rawPath === "~" || rawPath.startsWith("~/")) {
    return expandHomePath(rawPath);
  }
  if (path.isAbsolute(rawPath)) {
    return path.resolve(rawPath);
  }
  return path.resolve(expandHomePath(ruleCwd), rawPath);
}

function pickConcreteWatchType(types?: readonly string[]): string {
  if (!types || types.length === 0) {
    return "file.changed";
  }
  for (const t of types) {
    if (!t.includes("*") && EVENT_TYPE_RE.test(t)) {
      return t;
    }
  }
  for (const t of types) {
    if (t.endsWith(".*")) {
      const candidate = `${t.slice(0, -2)}.changed`;
      if (EVENT_TYPE_RE.test(candidate)) {
        return candidate;
      }
    }
  }
  return "file.changed";
}

/**
 * Produces a safe `InboundEvent.subject` matching `^[a-zA-Z0-9#][a-zA-Z0-9#._:/@-]*$` (<= 100 chars).
 */
export function sanitizeWatchSubject(
  rawName: string,
  fallbackSuffix: string,
): string {
  let cleaned = rawName.replace(/[^a-zA-Z0-9#._:/@-]+/g, "-");
  cleaned = cleaned.replace(/^[^a-zA-Z0-9#]+/, "");
  if (cleaned.length === 0 || !SUBJECT_START_RE.test(cleaned)) {
    cleaned = `watch-${fallbackSuffix.slice(0, 12)}`;
  }
  return cleaned.slice(0, 100);
}

function normalizeWatchFilename(filename: unknown): string {
  if (typeof filename === "string") {
    return filename;
  }
  if (Buffer.isBuffer(filename)) {
    return filename.toString("utf8");
  }
  return "";
}

/**
 * Creates a hot-reloading `rules.json` and dynamic `{ watch }` directory watcher
 * bound to a `HubRuntime`.
 */
export function createFileWatcher(
  options: FileWatcherOptions,
): FileWatcherHandle {
  const runtime = options.runtime;
  const rulesFilePath = path.resolve(
    options.rulesFilePath ?? path.join(runtime.autoloopHome, "rules.json"),
  );
  const rulesDir = path.dirname(rulesFilePath);
  const rulesBase = path.basename(rulesFilePath);
  const rulesDebounceMs = options.rulesDebounceMs ?? 50;
  const rulesPollMs = options.rulesPollMs ?? 100;
  const defaultWatchDebounceMs = options.defaultWatchDebounceMs ?? 200;
  const now = options.now ?? (() => Date.now());
  const onWarning =
    options.onWarning ??
    ((msg: string, err?: unknown) => {
      if (err !== undefined) {
        console.warn(`[autoloop-watcher] ${msg}:`, err);
      } else {
        console.warn(`[autoloop-watcher] ${msg}`);
      }
    });

  let started = false;
  let closed = false;
  let lastRulesHash: string | null = null;
  let lastAttemptedRulesHash: string | null = null;
  let lastAttemptedReason: "unchanged" | "invalid" = "unchanged";
  let lastRulesStatSig: string | null = null;
  let rulesDirWatcher: FSWatcher | null = null;
  let rulesReloadTimer: ReturnType<typeof setTimeout> | null = null;
  let rulesPollTimer: ReturnType<typeof setInterval> | null = null;
  let unsubscribeRules: (() => void) | null = null;
  const watchEntries = new Map<string, WatchEntry>();

  function readRulesStatSig(): string {
    try {
      const st = statSync(rulesFilePath);
      return `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
    } catch {
      return "missing";
    }
  }

  function emitWatchEvent(
    entry: WatchEntry,
    targetPath: string,
    fsEventType: string,
  ): void {
    if (closed) {
      return;
    }

    let mtimeToken: string;
    let mtimeIso: string | null = null;
    let size = 0;
    try {
      const st = statSync(targetPath);
      if (st.isDirectory() && targetPath !== entry.resolvedPath) {
        // Ignore directory metadata churn for child subdirs unless directory itself is target
      }
      mtimeToken = String(Math.trunc(st.mtimeMs * 1000));
      mtimeIso = new Date(st.mtimeMs).toISOString();
      size = st.size;
    } catch {
      mtimeToken = `deleted-${Math.trunc(now())}`;
    }

    const pathHash = sha256Hex(targetPath).slice(0, 16);
    const id = `watch-${pathHash}-${mtimeToken}`.slice(0, 200);
    const baseName = path.basename(targetPath) || "watch";
    const subject = sanitizeWatchSubject(baseName, pathHash);
    const summary = `文件变更 (${fsEventType}): ${baseName}`.slice(0, 200);
    const detail = JSON.stringify({
      path: targetPath,
      watchRoot: entry.resolvedPath,
      fsEventType,
      mtimeIso,
      size,
    }).slice(0, 8000);

    const event: InboundEvent = {
      id,
      type: entry.eventType,
      subject,
      summary,
      detail,
    };

    try {
      runtime.ingestEvent("watch", event, false);
    } catch (err) {
      onWarning(`投递 watch 事件失败 (${targetPath})`, err);
    }
  }

  function scheduleWatchEvent(
    entry: WatchEntry,
    rawEventType: string,
    filename: unknown,
  ): void {
    if (closed) {
      return;
    }
    const nameStr = normalizeWatchFilename(filename);
    if (nameStr === ".DS_Store") {
      return;
    }

    const targetPath =
      entry.isDir && nameStr.length > 0
        ? path.resolve(entry.resolvedPath, nameStr)
        : entry.resolvedPath;

    const existingTimer = entry.pendingTimers.get(targetPath);
    if (existingTimer !== undefined) {
      clearTimeout(existingTimer);
    }

    const delay = Math.max(0, entry.debounceMs);
    const timer = setTimeout(() => {
      entry.pendingTimers.delete(targetPath);
      emitWatchEvent(entry, targetPath, rawEventType);
    }, delay);
    timer.unref?.();
    entry.pendingTimers.set(targetPath, timer);
  }

  function closeWatchEntry(entry: WatchEntry): void {
    for (const timer of entry.pendingTimers.values()) {
      clearTimeout(timer);
    }
    entry.pendingTimers.clear();
    try {
      entry.watcher.close();
    } catch {
      // Ignore close errors
    }
  }

  function syncWatches(config: RulesConfig | null | undefined): void {
    if (closed) {
      return;
    }

    const desired = new Map<
      string,
      { debounceMs: number; eventType: string }
    >();

    if (config) {
      for (const rule of config.rules) {
        if (!("watch" in rule.when)) {
          continue;
        }
        const debounceMs = rule.when.watch.debounceMs ?? defaultWatchDebounceMs;
        const eventType = pickConcreteWatchType(rule.when.watch.types);
        for (const rawPath of rule.when.watch.paths) {
          const resolved = resolveWatchTargetPath(rawPath, rule.cwd);
          const prev = desired.get(resolved);
          if (!prev) {
            desired.set(resolved, { debounceMs, eventType });
          } else {
            desired.set(resolved, {
              debounceMs: Math.min(prev.debounceMs, debounceMs),
              eventType:
                prev.eventType !== "file.changed" ? prev.eventType : eventType,
            });
          }
        }
      }
    }

    // Remove watchers no longer referenced
    for (const [resolvedPath, entry] of watchEntries) {
      if (!desired.has(resolvedPath)) {
        closeWatchEntry(entry);
        watchEntries.delete(resolvedPath);
      }
    }

    // Add or update active watchers
    for (const [resolvedPath, spec] of desired) {
      const existing = watchEntries.get(resolvedPath);
      if (existing) {
        try {
          const st = statSync(resolvedPath);
          if (st.isDirectory() === existing.isDir) {
            existing.debounceMs = spec.debounceMs;
            existing.eventType = spec.eventType;
            continue;
          }
          // Target switched between file and directory -> recreate watcher
          closeWatchEntry(existing);
          watchEntries.delete(resolvedPath);
        } catch (err) {
          closeWatchEntry(existing);
          watchEntries.delete(resolvedPath);
          onWarning(`监听路径已失效，已移除 (${resolvedPath})`, err);
          continue;
        }
      }

      if (!existsSync(resolvedPath)) {
        onWarning(`监听路径不存在，已跳过: ${resolvedPath}`);
        continue;
      }

      try {
        const st = statSync(resolvedPath);
        const isDir = st.isDirectory();
        const entry: WatchEntry = {
          resolvedPath,
          isDir,
          debounceMs: spec.debounceMs,
          eventType: spec.eventType,
          watcher: null as unknown as FSWatcher,
          pendingTimers: new Map(),
        };
        const watcher = watch(
          resolvedPath,
          { persistent: false },
          (eventType, filename) => {
            scheduleWatchEvent(entry, eventType, filename);
          },
        );
        watcher.on("error", (err) => {
          onWarning(`fs.watch 异常 (${resolvedPath})`, err);
          if (watchEntries.get(resolvedPath) === entry) {
            closeWatchEntry(entry);
            watchEntries.delete(resolvedPath);
          }
        });
        entry.watcher = watcher;
        watchEntries.set(resolvedPath, entry);
      } catch (err) {
        onWarning(`无法启动监听 (${resolvedPath})`, err);
      }
    }
  }

  function reloadRules(force = false): ReloadRulesResult {
    if (closed) {
      return { loaded: false, reason: "missing" };
    }
    lastRulesStatSig = readRulesStatSig();
    if (!existsSync(rulesFilePath)) {
      lastAttemptedRulesHash = null;
      lastAttemptedReason = "unchanged";
      return { loaded: false, reason: "missing" };
    }

    let rawText: string;
    try {
      rawText = readFileSync(rulesFilePath, "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onWarning(`读取 rules.json 失败: ${msg}`, err);
      return { loaded: false, reason: "invalid", error: msg };
    }

    const contentHash = sha256Hex(rawText);
    if (!force && contentHash === lastAttemptedRulesHash) {
      return { loaded: false, reason: lastAttemptedReason };
    }
    lastAttemptedRulesHash = contentHash;
    if (!force && contentHash === lastRulesHash) {
      lastAttemptedReason = "unchanged";
      return { loaded: false, reason: "unchanged" };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lastAttemptedReason = "invalid";
      onWarning(`rules.json JSON 语法错误，已忽略本次热重载: ${msg}`, err);
      return { loaded: false, reason: "invalid", error: msg };
    }

    try {
      runtime.configureRules(parsed);
      lastRulesHash = contentHash;
      lastAttemptedReason = "unchanged";
      return { loaded: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lastAttemptedReason = "invalid";
      onWarning(`rules.json 规则校验失败，已保留旧配置: ${msg}`, err);
      return { loaded: false, reason: "invalid", error: msg };
    }
  }

  function scheduleRulesReload(): void {
    if (closed) {
      return;
    }
    if (rulesReloadTimer !== null) {
      clearTimeout(rulesReloadTimer);
    }
    rulesReloadTimer = setTimeout(
      () => {
        rulesReloadTimer = null;
        reloadRules(false);
      },
      Math.max(0, rulesDebounceMs),
    );
    rulesReloadTimer.unref?.();
  }

  function ensureRulesDirWatcher(): void {
    if (closed || rulesDirWatcher !== null || !existsSync(rulesDir)) {
      return;
    }
    try {
      const watcher = watch(
        rulesDir,
        { persistent: false },
        (_eventType, filename) => {
          const name = normalizeWatchFilename(filename);
          if (name === "" || name === rulesBase) {
            scheduleRulesReload();
          }
        },
      );
      watcher.on("error", (err) => {
        onWarning(`rules.json 目录监听异常 (${rulesDir})`, err);
        if (rulesDirWatcher === watcher) {
          try {
            watcher.close();
          } catch {
            // Ignore close errors
          }
          rulesDirWatcher = null;
        }
      });
      rulesDirWatcher = watcher;
    } catch (err) {
      onWarning(`无法监听 rules.json 所在目录 (${rulesDir})`, err);
    }
  }

  function start(): void {
    if (closed || started) {
      return;
    }
    started = true;

    unsubscribeRules = runtime.onRulesChanged((config) => {
      syncWatches(config);
    });

    const initialLoad = reloadRules(false);
    if (!initialLoad.loaded) {
      const existingConfig = rulesOf(runtime.store.view)?.config;
      if (existingConfig) {
        syncWatches(existingConfig);
      }
    }

    ensureRulesDirWatcher();

    // Fallback stat poll covers macOS FSEvents startup windows and missed dir events under heavy I/O
    rulesPollTimer = setInterval(
      () => {
        if (closed) {
          return;
        }
        ensureRulesDirWatcher();
        const sig = readRulesStatSig();
        if (sig !== lastRulesStatSig) {
          lastRulesStatSig = sig;
          if (rulesReloadTimer === null) {
            scheduleRulesReload();
          }
        }
      },
      Math.max(25, rulesPollMs),
    );
    rulesPollTimer.unref?.();
  }

  function close(): void {
    if (closed) {
      return;
    }
    closed = true;
    started = false;

    if (rulesPollTimer !== null) {
      clearInterval(rulesPollTimer);
      rulesPollTimer = null;
    }
    if (rulesReloadTimer !== null) {
      clearTimeout(rulesReloadTimer);
      rulesReloadTimer = null;
    }
    if (rulesDirWatcher !== null) {
      try {
        rulesDirWatcher.close();
      } catch {
        // Ignore close errors
      }
      rulesDirWatcher = null;
    }
    if (unsubscribeRules !== null) {
      unsubscribeRules();
      unsubscribeRules = null;
    }
    for (const entry of watchEntries.values()) {
      closeWatchEntry(entry);
    }
    watchEntries.clear();
  }

  return {
    start,
    close,
    reloadRules,
    syncWatches,
    watchedPaths(): string[] {
      return Array.from(watchEntries.keys()).sort();
    },
  };
}
