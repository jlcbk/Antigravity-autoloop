import type {
  InboundEvent,
  Receipt,
  ReceiptAsk,
  ReceiptLater,
  ReceiptNotice,
  ReceiptResolve,
  RunOutcome,
  RunResult,
  RunUsage,
} from "./types.ts";

/**
 * Zero-dependency validation error for protocol boundaries (HTTP 400).
 */
export class ProtocolInputError extends Error {
  readonly statusCode: number = 400;
  readonly code: string = "INPUT_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "ProtocolInputError";
  }
}

const EVENT_TYPE_RE = /^[a-zA-Z0-9._-]+$/;
const EVENT_SUBJECT_RE = /^[a-zA-Z0-9#][a-zA-Z0-9#._:/@-]*$/;
const ASCII_VISIBLE_RE = /^[\x21-\x7e]+$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const ISO_OFFSET_DT_RE =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|z|[+-]\d{2}:\d{2})$/;

const INBOUND_EVENT_KEYS = new Set([
  "id",
  "type",
  "subject",
  "summary",
  "detail",
  "link",
  "hops",
]);

const RECEIPT_KEYS = new Set(["ask", "notice", "resolve", "later", "events"]);
const RUN_RESULT_KEYS = new Set([
  "outcome",
  "summary",
  "error",
  "session",
  "usage",
  "ask",
  "notice",
  "resolve",
  "later",
  "events",
]);

const ASK_KEYS = new Set([
  "key",
  "title",
  "text",
  "options",
  "recommend",
  "about",
]);
const NOTICE_KEYS = new Set(["key", "title", "text", "fyi"]);
const RESOLVE_KEYS = new Set(["card", "reason"]);
const LATER_KEYS = new Set(["key", "at", "about", "cancel"]);
const USAGE_KEYS = new Set(["input", "output", "cached", "cost"]);
const VALID_OUTCOMES = new Set<RunOutcome>([
  "done",
  "nothing",
  "failed",
  "cancelled",
]);

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function assertPlainObject(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new ProtocolInputError(`${label} 必须是 JSON 对象`);
  }
  return value;
}

export function assertAllowedKeys(
  obj: Record<string, unknown>,
  allowed: Set<string>,
  label: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new ProtocolInputError(`${label} 包含未知或越权字段: ${key}`);
    }
  }
}

export function assertNonEmptyString(
  value: unknown,
  label: string,
  maxLength?: number,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProtocolInputError(`${label} 必须是非空字符串`);
  }
  if (maxLength !== undefined && value.length > maxLength) {
    throw new ProtocolInputError(`${label} 长度不能超过 ${maxLength} 个字符`);
  }
  return value;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return isLeap ? 29 : 28;
  }
  if (month === 4 || month === 6 || month === 9 || month === 11) {
    return 30;
  }
  return 31;
}

export function isValidIsoDateTimeWithOffset(value: string): boolean {
  const match = ISO_OFFSET_DT_RE.exec(value);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const tz = match[7];

  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  if (hour < 0 || hour > 23) return false;
  if (minute < 0 || minute > 59) return false;
  if (second < 0 || second > 59) return false;

  if (tz !== "Z" && tz !== "z") {
    const offHour = Number(tz.slice(1, 3));
    const offMin = Number(tz.slice(4, 6));
    if (offHour < 0 || offHour > 23 || offMin < 0 || offMin > 59) {
      return false;
    }
  }

  return Number.isFinite(Date.parse(value));
}

function validateSafeUrl(link: string, label: string): string {
  if (link.length === 0 || link.length > 500) {
    throw new ProtocolInputError(`${label} 长度必须在 1 到 500 个字符之间`);
  }
  if (!ASCII_VISIBLE_RE.test(link)) {
    throw new ProtocolInputError(
      `${label} 仅允许纯 ASCII 且禁止空白与控制字符`,
    );
  }
  if (!link.startsWith("http://") && !link.startsWith("https://")) {
    throw new ProtocolInputError(`${label} 仅允许使用 http:// 或 https:// 协议`);
  }
  let parsed: URL;
  try {
    parsed = new URL(link);
  } catch {
    throw new ProtocolInputError(`${label} 不是合法的 URL`);
  }
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    if (parsed.hostname.length === 0) {
      throw new ProtocolInputError(`${label} 缺少合法的主机名`);
    }
  } else {
    throw new ProtocolInputError(`${label} 协议不受支持`);
  }
  return link;
}

/**
 * Validate and normalize an external or derivative InboundEvent.
 * Rejects any unknown or privileged override fields (e.g. cwd, agent, to, access, model).
 */
export function parseInboundEvent(
  input: unknown,
  label = "InboundEvent",
): InboundEvent {
  const obj = assertPlainObject(input, label);
  assertAllowedKeys(obj, INBOUND_EVENT_KEYS, label);

  const id = assertNonEmptyString(obj.id, `${label}.id`, 200);
  if (CONTROL_CHAR_RE.test(id)) {
    throw new ProtocolInputError(`${label}.id 不能包含控制字符`);
  }

  const type = assertNonEmptyString(obj.type, `${label}.type`, 64);
  if (!EVENT_TYPE_RE.test(type)) {
    throw new ProtocolInputError(`${label}.type 仅允许 [a-zA-Z0-9._-]`);
  }

  const out: InboundEvent = { id, type };

  if (obj.subject !== undefined) {
    if (typeof obj.subject !== "string") {
      throw new ProtocolInputError(`${label}.subject 必须是字符串`);
    }
    if (obj.subject.length > 100) {
      throw new ProtocolInputError(`${label}.subject 长度不能超过 100 个字符`);
    }
    if (obj.subject.length > 0) {
      if (!EVENT_SUBJECT_RE.test(obj.subject)) {
        throw new ProtocolInputError(
          `${label}.subject 必须以字母/数字/# 开头且仅含 [a-zA-Z0-9#._:/@-]（禁止空白与控制字符）`,
        );
      }
      out.subject = obj.subject;
    }
  }

  if (obj.summary !== undefined) {
    if (typeof obj.summary !== "string") {
      throw new ProtocolInputError(`${label}.summary 必须是字符串`);
    }
    if (obj.summary.length > 200) {
      throw new ProtocolInputError(`${label}.summary 长度不能超过 200 个字符`);
    }
    out.summary = obj.summary;
  }

  if (obj.detail !== undefined) {
    if (typeof obj.detail !== "string") {
      throw new ProtocolInputError(`${label}.detail 必须是字符串`);
    }
    if (obj.detail.length > 8000) {
      throw new ProtocolInputError(`${label}.detail 长度不能超过 8000 个字符`);
    }
    out.detail = obj.detail;
  }

  if (obj.link !== undefined) {
    if (typeof obj.link !== "string") {
      throw new ProtocolInputError(`${label}.link 必须是字符串`);
    }
    out.link = validateSafeUrl(obj.link, `${label}.link`);
  }

  if (obj.hops !== undefined) {
    if (
      typeof obj.hops !== "number" ||
      !Number.isSafeInteger(obj.hops) ||
      obj.hops < 0
    ) {
      throw new ProtocolInputError(`${label}.hops 必须是非负安全整数`);
    }
    out.hops = obj.hops;
  }

  return out;
}

function parseAskItem(raw: unknown, index: number): ReceiptAsk {
  const label = `receipt.ask[${index}]`;
  const obj = assertPlainObject(raw, label);
  assertAllowedKeys(obj, ASK_KEYS, label);

  const key = assertNonEmptyString(obj.key, `${label}.key`);
  const title = assertNonEmptyString(obj.title, `${label}.title`);
  const text = assertNonEmptyString(obj.text, `${label}.text`);
  const about = assertNonEmptyString(obj.about, `${label}.about`);

  if (!Array.isArray(obj.options) || obj.options.length < 2) {
    throw new ProtocolInputError(
      `${label}.options 必须是至少包含 2 个选项的数组`,
    );
  }
  const options: string[] = [];
  for (let i = 0; i < obj.options.length; i++) {
    options.push(
      assertNonEmptyString(obj.options[i], `${label}.options[${i}]`),
    );
  }

  const item: ReceiptAsk = { key, title, text, options, about };
  if (obj.recommend !== undefined) {
    if (
      typeof obj.recommend !== "number" ||
      !Number.isInteger(obj.recommend) ||
      obj.recommend < 0 ||
      obj.recommend >= options.length
    ) {
      throw new ProtocolInputError(
        `${label}.recommend 必须是 0 到 ${options.length - 1} 之间的整数下标`,
      );
    }
    item.recommend = obj.recommend;
  }
  return item;
}

function parseNoticeItem(raw: unknown, index: number): ReceiptNotice {
  const label = `receipt.notice[${index}]`;
  const obj = assertPlainObject(raw, label);
  assertAllowedKeys(obj, NOTICE_KEYS, label);

  const title = assertNonEmptyString(obj.title, `${label}.title`);
  const text = assertNonEmptyString(obj.text, `${label}.text`);
  const item: ReceiptNotice = { title, text };

  if (obj.key !== undefined) {
    item.key = assertNonEmptyString(obj.key, `${label}.key`);
  }
  if (obj.fyi !== undefined) {
    if (typeof obj.fyi !== "boolean") {
      throw new ProtocolInputError(`${label}.fyi 必须是布尔值`);
    }
    item.fyi = obj.fyi;
  }
  return item;
}

function parseResolveItem(raw: unknown, index: number): ReceiptResolve {
  const label = `receipt.resolve[${index}]`;
  const obj = assertPlainObject(raw, label);
  assertAllowedKeys(obj, RESOLVE_KEYS, label);

  if (
    typeof obj.card !== "number" ||
    !Number.isSafeInteger(obj.card) ||
    obj.card <= 0
  ) {
    throw new ProtocolInputError(`${label}.card 必须是正整数`);
  }
  const reason = assertNonEmptyString(obj.reason, `${label}.reason`);
  return { card: obj.card, reason };
}

function parseLaterItem(raw: unknown, index: number): ReceiptLater {
  const label = `receipt.later[${index}]`;
  const obj = assertPlainObject(raw, label);
  assertAllowedKeys(obj, LATER_KEYS, label);

  const key = assertNonEmptyString(obj.key, `${label}.key`);

  if (obj.cancel !== undefined && typeof obj.cancel !== "boolean") {
    throw new ProtocolInputError(`${label}.cancel 必须是布尔值`);
  }

  if (obj.cancel === true) {
    if (obj.at !== undefined || obj.about !== undefined) {
      throw new ProtocolInputError(
        `${label} 设置 cancel: true 时不能同时提供 at 或 about`,
      );
    }
    return { key, cancel: true };
  }

  if (typeof obj.at !== "string" || !isValidIsoDateTimeWithOffset(obj.at)) {
    throw new ProtocolInputError(
      `${label}.at 必须是带显式时区偏移（Z 或 ±HH:MM）的合法 ISO 时间`,
    );
  }
  const about = assertNonEmptyString(obj.about, `${label}.about`);
  const item: ReceiptLater = { key, at: obj.at, about };
  if (obj.cancel === false) {
    item.cancel = false;
  }
  return item;
}

function extractReceiptFields(
  obj: Record<string, unknown>,
  out: Receipt,
): void {
  if (obj.ask !== undefined) {
    if (!Array.isArray(obj.ask)) {
      throw new ProtocolInputError("receipt.ask 必须是数组");
    }
    out.ask = obj.ask.map((item, idx) => parseAskItem(item, idx));
  }

  if (obj.notice !== undefined) {
    if (!Array.isArray(obj.notice)) {
      throw new ProtocolInputError("receipt.notice 必须是数组");
    }
    out.notice = obj.notice.map((item, idx) => parseNoticeItem(item, idx));
  }

  if (obj.resolve !== undefined) {
    if (!Array.isArray(obj.resolve)) {
      throw new ProtocolInputError("receipt.resolve 必须是数组");
    }
    out.resolve = obj.resolve.map((item, idx) => parseResolveItem(item, idx));
  }

  if (obj.later !== undefined) {
    if (!Array.isArray(obj.later)) {
      throw new ProtocolInputError("receipt.later 必须是数组");
    }
    out.later = obj.later.map((item, idx) => parseLaterItem(item, idx));
  }

  if (obj.events !== undefined) {
    if (!Array.isArray(obj.events)) {
      throw new ProtocolInputError("receipt.events 必须是数组");
    }
    out.events = obj.events.map((item, idx) =>
      parseInboundEvent(item, `receipt.events[${idx}]`),
    );
  }
}

export function parseReceipt(input: unknown): Receipt {
  const obj = assertPlainObject(input, "Receipt");
  assertAllowedKeys(obj, RECEIPT_KEYS, "Receipt");
  const receipt: Receipt = {};
  extractReceiptFields(obj, receipt);
  return receipt;
}

function parseUsage(raw: unknown): RunUsage {
  const obj = assertPlainObject(raw, "RunResult.usage");
  assertAllowedKeys(obj, USAGE_KEYS, "RunResult.usage");
  const usage: RunUsage = {};
  for (const field of ["input", "output", "cached", "cost"] as const) {
    const val = obj[field];
    if (val !== undefined) {
      if (typeof val !== "number" || !Number.isFinite(val) || val < 0) {
        throw new ProtocolInputError(
          `RunResult.usage.${field} 必须是非负有限数字`,
        );
      }
      usage[field] = val;
    }
  }
  return usage;
}

export function parseRunResult(input: unknown): RunResult {
  const obj = assertPlainObject(input, "RunResult");
  assertAllowedKeys(obj, RUN_RESULT_KEYS, "RunResult");

  if (
    typeof obj.outcome !== "string" ||
    !VALID_OUTCOMES.has(obj.outcome as RunOutcome)
  ) {
    throw new ProtocolInputError(
      'RunResult.outcome 必须是 "done"、"nothing"、"failed" 或 "cancelled"',
    );
  }

  const result: RunResult = { outcome: obj.outcome as RunOutcome };

  if (obj.summary !== undefined) {
    if (typeof obj.summary !== "string") {
      throw new ProtocolInputError("RunResult.summary 必须是字符串");
    }
    result.summary = obj.summary;
  }

  if (obj.error !== undefined) {
    if (typeof obj.error !== "string") {
      throw new ProtocolInputError("RunResult.error 必须是字符串");
    }
    result.error = obj.error;
  }

  if (obj.session !== undefined) {
    result.session = assertNonEmptyString(obj.session, "RunResult.session");
  }

  if (obj.usage !== undefined) {
    result.usage = parseUsage(obj.usage);
  }

  extractReceiptFields(obj, result);
  return result;
}
