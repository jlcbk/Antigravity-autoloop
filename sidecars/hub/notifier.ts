/**
 * macOS native desktop notifier for newly created Autoloop cards.
 * Uses `execFile("osascript", [...argv])` with strict argument-array isolation
 * so untrusted card titles/bodies are never interpolated into AppleScript source.
 */

import { execFile } from "node:child_process";
import type { CardView, RulesConfig } from "../../protocol/types.ts";

export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: { shell: false; timeout?: number },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => unknown;

export interface NotifierOptions {
  platform?: NodeJS.Platform;
  silent?: boolean;
  osascriptBin?: string;
  timeoutMs?: number;
  execFileFn?: ExecFileLike;
  onError?: (err: unknown) => void;
}

export interface NotifyResult {
  sent: boolean;
  reason?: string;
}

export interface Notifier {
  notify(title: string, body: string): Promise<NotifyResult>;
  notifyCards(
    cards: readonly CardView[],
    config?: RulesConfig | null,
  ): Promise<number[]>;
  hasNotified(cardId: number): boolean;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TITLE_LEN = 120;
const MAX_BODY_LEN = 240;

function sanitizeArgText(raw: string, maxLen: number): string {
  const cleaned = raw
    .replace(/\0/g, "")
    .replace(/[\r\n]+/g, " ")
    .trim();
  if (cleaned.length <= maxLen) {
    return cleaned;
  }
  return `${cleaned.slice(0, Math.max(0, maxLen - 1))}…`;
}

/**
 * Builds argument-isolated `osascript` CLI parameters where title and body
 * are passed purely as `argv` items (never interpolated into `-e` code).
 */
export function buildOsascriptArgs(title: string, body: string): string[] {
  return [
    "-e",
    "on run argv",
    "-e",
    "display notification (item 2 of argv) with title (item 1 of argv)",
    "-e",
    "end run",
    title,
    body,
  ];
}

/**
 * Determines whether a card qualifies for a desktop notification under rule `tell` policy.
 * Only newly created `open` `ask` cards or non-`fyi` `open` `notice` cards notify when `tell !== "never"`.
 */
export function shouldNotifyCard(
  card: CardView,
  config?: RulesConfig | null,
): boolean {
  if (card.status !== "open") {
    return false;
  }
  if (card.kind === "notice" && card.fyi === true) {
    return false;
  }
  if (card.kind !== "ask" && card.kind !== "notice") {
    return false;
  }
  const ruleSpec = config?.rules.find((r) => r.name === card.rule);
  if (ruleSpec?.tell === "never") {
    return false;
  }
  return true;
}

/**
 * Creates a deduplicated desktop notifier that emits at most one notification per card ID.
 */
export function createNotifier(options: NotifierOptions = {}): Notifier {
  const platform = options.platform ?? process.platform;
  const osascriptBin = options.osascriptBin ?? "osascript";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const execFileFn: ExecFileLike =
    options.execFileFn ??
    ((file, args, opts, cb) => {
      execFile(file, [...args], opts, (err, stdout, stderr) => {
        cb(err, String(stdout ?? ""), String(stderr ?? ""));
      });
    });

  const notifiedCardIds = new Set<number>();

  function isSilent(): boolean {
    return (
      options.silent === true || process.env.AUTOLOOP_SILENT_NOTIFY === "1"
    );
  }

  async function notify(title: string, body: string): Promise<NotifyResult> {
    if (isSilent()) {
      return { sent: false, reason: "silent" };
    }
    if (platform !== "darwin") {
      return { sent: false, reason: "unsupported-platform" };
    }

    const safeTitle = sanitizeArgText(title, MAX_TITLE_LEN) || "Autoloop";
    const safeBody = sanitizeArgText(body, MAX_BODY_LEN) || safeTitle;
    const args = buildOsascriptArgs(safeTitle, safeBody);

    return new Promise<NotifyResult>((resolve) => {
      try {
        execFileFn(
          osascriptBin,
          args,
          { shell: false, timeout: timeoutMs },
          (err) => {
            if (err) {
              options.onError?.(err);
              resolve({ sent: false, reason: "exec-error" });
              return;
            }
            resolve({ sent: true });
          },
        );
      } catch (err) {
        options.onError?.(err);
        resolve({ sent: false, reason: "exec-threw" });
      }
    });
  }

  async function notifyCards(
    cards: readonly CardView[],
    config?: RulesConfig | null,
  ): Promise<number[]> {
    const sentCardIds: number[] = [];
    for (const card of cards) {
      if (notifiedCardIds.has(card.card)) {
        continue;
      }
      if (!shouldNotifyCard(card, config)) {
        continue;
      }
      notifiedCardIds.add(card.card);

      const kindLabel = card.kind === "ask" ? "待批奏折" : "通知";
      const title = `Autoloop ${kindLabel} · ${card.title}`;
      const body = card.text || card.about || card.rule;
      const res = await notify(title, body);
      if (res.sent) {
        sentCardIds.push(card.card);
      }
    }
    return sentCardIds;
  }

  return {
    notify,
    notifyCards,
    hasNotified(cardId: number): boolean {
      return notifiedCardIds.has(cardId);
    },
  };
}
