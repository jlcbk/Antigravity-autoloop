import { InputError } from "./errors.ts";

export interface ParsedCron {
  expression: string;
  timeZone: string;
  minutes: boolean[];
  hours: boolean[];
  daysOfMonth: boolean[];
  months: boolean[];
  daysOfWeek: boolean[];
  domWildcard: boolean;
  dowWildcard: boolean;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const SEARCH_YEARS = 40;

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = FORMATTER_CACHE.get(timeZone);
  if (cached) {
    return cached;
  }
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
      hourCycle: "h23",
    });
  } catch {
    throw new InputError(`Invalid IANA time zone: ${timeZone}`);
  }
  if (FORMATTER_CACHE.size < 128) {
    FORMATTER_CACHE.set(timeZone, fmt);
  }
  return fmt;
}

function localParts(ms: number, timeZone: string): LocalParts {
  const fmt = getFormatter(timeZone);
  const parts = fmt.formatToParts(new Date(ms));
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let weekday = 0;

  for (const part of parts) {
    switch (part.type) {
      case "year":
        year = Number(part.value);
        break;
      case "month":
        month = Number(part.value);
        break;
      case "day":
        day = Number(part.value);
        break;
      case "hour":
        hour = Number(part.value) % 24;
        break;
      case "minute":
        minute = Number(part.value);
        break;
      case "weekday": {
        const mapped = WEEKDAY_MAP[part.value];
        if (mapped !== undefined) {
          weekday = mapped;
        }
        break;
      }
      default:
        break;
    }
  }

  return { year, month, day, hour, minute, weekday };
}

function localMsAt(ms: number, timeZone: string): number {
  const p = localParts(ms, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
}

function offsetAt(ms: number, timeZone: string): number {
  const rounded = Math.floor(ms / MINUTE_MS) * MINUTE_MS;
  return localMsAt(rounded, timeZone) - rounded;
}

/**
 * Resolves a local wall-clock timestamp `(year, month, day, hour, minute)` to the
 * earliest matching UTC millisecond timestamp in `timeZone`.
 * Returns `null` when the local wall-clock time does not exist (spring-forward gap).
 * When a local time occurs twice (fall-back fold), returns the first occurrence only.
 */
function resolveFirstUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number | null {
  const targetLocalMs = Date.UTC(year, month - 1, day, hour, minute);
  const offA = offsetAt(targetLocalMs, timeZone);
  const tApprox = targetLocalMs - offA;

  const probeTimes = [tApprox - 6 * HOUR_MS, tApprox, tApprox + 6 * HOUR_MS];
  const seenCandidates = new Set<number>();
  let best: number | null = null;

  for (const probe of probeTimes) {
    const cand = targetLocalMs - offsetAt(probe, timeZone);
    if (seenCandidates.has(cand)) {
      continue;
    }
    seenCandidates.add(cand);
    if (localMsAt(cand, timeZone) === targetLocalMs) {
      if (best === null || cand < best) {
        best = cand;
      }
    }
  }

  // Fallback for rare >6h historical offset jumps.
  if (best === null) {
    for (const shift of [-24 * HOUR_MS, 24 * HOUR_MS]) {
      const cand = targetLocalMs - offsetAt(tApprox + shift, timeZone);
      if (!seenCandidates.has(cand)) {
        seenCandidates.add(cand);
        if (localMsAt(cand, timeZone) === targetLocalMs) {
          if (best === null || cand < best) {
            best = cand;
          }
        }
      }
    }
  }

  return best;
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

function parseUint(token: string, label: string): number {
  if (!/^\d+$/.test(token)) {
    throw new InputError(`Invalid integer "${token}" in cron ${label} field`);
  }
  return Number(token);
}

function parseField(
  raw: string,
  min: number,
  max: number,
  label: string,
  allowSundaySeven: boolean,
): boolean[] {
  if (raw.length === 0) {
    throw new InputError(`Empty cron ${label} field`);
  }

  const size = allowSundaySeven ? 7 : max + 1;
  const table = new Array<boolean>(size).fill(false);
  const parts = raw.split(",");

  for (const item of parts) {
    if (item.length === 0) {
      throw new InputError(`Empty list item in cron ${label} field: "${raw}"`);
    }

    const slashParts = item.split("/");
    if (slashParts.length > 2) {
      throw new InputError(`Invalid step syntax in cron ${label}: "${item}"`);
    }

    const rangePart = slashParts[0]!;
    const hasStep = slashParts.length === 2;
    const step = hasStep ? parseUint(slashParts[1]!, label) : 1;
    if (step < 1) {
      throw new InputError(
        `Cron ${label} step must be >= 1, got "${slashParts[1]}"`,
      );
    }

    let start: number;
    let end: number;

    if (rangePart === "*") {
      start = min;
      end = allowSundaySeven ? 6 : max;
    } else if (rangePart.includes("-")) {
      const dashParts = rangePart.split("-");
      if (
        dashParts.length !== 2 ||
        dashParts[0] === "" ||
        dashParts[1] === ""
      ) {
        throw new InputError(`Invalid range in cron ${label} field: "${item}"`);
      }
      start = parseUint(dashParts[0]!, label);
      end = parseUint(dashParts[1]!, label);
      if (start < min || end > max || start > end) {
        throw new InputError(
          `Out-of-bounds range in cron ${label} field: "${item}"`,
        );
      }
    } else {
      const val = parseUint(rangePart, label);
      if (val < min || val > max) {
        throw new InputError(
          `Out-of-bounds value in cron ${label} field: "${item}"`,
        );
      }
      start = val;
      if (hasStep) {
        end = allowSundaySeven ? (val === 7 ? 7 : 6) : max;
      } else {
        end = val;
      }
    }

    for (let v = start; v <= end; v += step) {
      const normalized = allowSundaySeven && v === 7 ? 0 : v;
      table[normalized] = true;
    }
  }

  return table;
}

function dayMatches(
  parsed: ParsedCron,
  year: number,
  month: number,
  day: number,
): boolean {
  const domMatch = parsed.daysOfMonth[day] === true;
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const dowMatch = parsed.daysOfWeek[dow] === true;

  if (!parsed.domWildcard && !parsed.dowWildcard) {
    return domMatch || dowMatch;
  }
  return domMatch && dowMatch;
}

function assertFiniteMs(value: number, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InputError(`${label} must be a finite timestamp`);
  }
}

/**
 * Parses a standard 5-field cron expression (`minute hour dayOfMonth month dayOfWeek`)
 * with optional `CRON_TZ=<Zone> ` prefix overriding `fallbackTimeZone`.
 */
export function parseCron(
  expression: string,
  fallbackTimeZone = "UTC",
): ParsedCron {
  if (typeof expression !== "string") {
    throw new InputError("Cron expression must be a string");
  }
  const trimmed = expression.trim();
  if (trimmed.length === 0) {
    throw new InputError("Cron expression must not be empty");
  }

  let timeZone = fallbackTimeZone;
  let body = trimmed;

  if (trimmed.startsWith("CRON_TZ=")) {
    const match = /^CRON_TZ=(\S+)\s+(.+)$/.exec(trimmed);
    if (!match) {
      throw new InputError(`Invalid CRON_TZ prefix in cron: "${expression}"`);
    }
    timeZone = match[1]!;
    body = match[2]!.trim();
  }

  if (typeof timeZone !== "string" || timeZone.trim().length === 0) {
    throw new InputError("Time zone must be a non-empty IANA time zone");
  }
  timeZone = timeZone.trim();
  getFormatter(timeZone);

  const fields = body.split(/\s+/);
  if (fields.length !== 5) {
    throw new InputError(
      `Cron expression must have exactly 5 fields, got ${fields.length}: "${expression}"`,
    );
  }

  const [minStr, hourStr, domStr, monthStr, dowStr] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];

  const minutes = parseField(minStr, 0, 59, "minute", false);
  const hours = parseField(hourStr, 0, 23, "hour", false);
  const daysOfMonth = parseField(domStr, 1, 31, "dayOfMonth", false);
  const months = parseField(monthStr, 1, 12, "month", false);
  const daysOfWeek = parseField(dowStr, 0, 7, "dayOfWeek", true);

  return {
    expression: trimmed,
    timeZone,
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    domWildcard: domStr === "*" || domStr === "*/1",
    dowWildcard: dowStr === "*" || dowStr === "*/1",
  };
}

/**
 * Computes the earliest trigger timestamp (in epoch ms) strictly greater than `afterMs`.
 * Non-existent spring-forward times are skipped; repeated fall-back times trigger only once
 * on their first occurrence.
 */
export function nextRun(
  expression: string,
  timeZone: string,
  afterMs: number,
): number {
  assertFiniteMs(afterMs, "afterMs");
  const parsed = parseCron(expression, timeZone);
  const tz = parsed.timeZone;
  const start = localParts(afterMs, tz);

  for (let y = start.year; y <= start.year + SEARCH_YEARS; y++) {
    const mStart = y === start.year ? start.month : 1;
    for (let m = mStart; m <= 12; m++) {
      if (!parsed.months[m]) {
        continue;
      }
      const maxD = daysInMonth(y, m);
      const dStart = y === start.year && m === start.month ? start.day : 1;
      for (let d = dStart; d <= maxD; d++) {
        if (!dayMatches(parsed, y, m, d)) {
          continue;
        }
        const hStart =
          y === start.year && m === start.month && d === start.day
            ? start.hour
            : 0;
        for (let h = hStart; h <= 23; h++) {
          if (!parsed.hours[h]) {
            continue;
          }
          const minStart =
            y === start.year &&
            m === start.month &&
            d === start.day &&
            h === start.hour
              ? start.minute
              : 0;
          for (let min = minStart; min <= 59; min++) {
            if (!parsed.minutes[min]) {
              continue;
            }
            const utc = resolveFirstUtc(y, m, d, h, min, tz);
            if (utc !== null && utc > afterMs) {
              return utc;
            }
          }
        }
      }
    }
  }

  throw new InputError(
    `Cron expression "${expression}" has no valid occurrence within ${SEARCH_YEARS} years`,
  );
}

/**
 * Computes the most recent trigger timestamp (in epoch ms) at or before `atOrBeforeMs`,
 * or `null` if none exists within the search horizon.
 */
export function latestBefore(
  expression: string,
  timeZone: string,
  atOrBeforeMs: number,
): number | null {
  assertFiniteMs(atOrBeforeMs, "atOrBeforeMs");
  const parsed = parseCron(expression, timeZone);
  const tz = parsed.timeZone;

  const pNow = localParts(atOrBeforeMs, tz);
  const nowLocalMs = Date.UTC(
    pNow.year,
    pNow.month - 1,
    pNow.day,
    pNow.hour,
    pNow.minute,
  );
  // During a fall-back fold, an earlier UTC instant may have a higher wall-clock time
  // than `pNow` (e.g. 01:45 first pass occurred before 01:40 second pass).
  const lookbackShift = 3 * HOUR_MS;
  const pPrev = localParts(atOrBeforeMs - lookbackShift, tz);
  const prevProjectedMs =
    Date.UTC(pPrev.year, pPrev.month - 1, pPrev.day, pPrev.hour, pPrev.minute) +
    lookbackShift;

  const startLocalMs = Math.max(nowLocalMs, prevProjectedMs);
  const startDate = new Date(startLocalMs);
  const endY = startDate.getUTCFullYear();
  const endM = startDate.getUTCMonth() + 1;
  const endD = startDate.getUTCDate();
  const endH = startDate.getUTCHours();
  const endMin = startDate.getUTCMinutes();

  const minYear = endY - SEARCH_YEARS;

  for (let y = endY; y >= minYear; y--) {
    const mStart = y === endY ? endM : 12;
    for (let m = mStart; m >= 1; m--) {
      if (!parsed.months[m]) {
        continue;
      }
      const maxD = daysInMonth(y, m);
      const dStart = y === endY && m === endM ? endD : maxD;
      for (let d = dStart; d >= 1; d--) {
        if (!dayMatches(parsed, y, m, d)) {
          continue;
        }
        const hStart = y === endY && m === endM && d === endD ? endH : 23;
        for (let h = hStart; h >= 0; h--) {
          if (!parsed.hours[h]) {
            continue;
          }
          const minStart =
            y === endY && m === endM && d === endD && h === endH ? endMin : 59;
          for (let min = minStart; min >= 0; min--) {
            if (!parsed.minutes[min]) {
              continue;
            }
            const utc = resolveFirstUtc(y, m, d, h, min, tz);
            if (utc !== null && utc <= atOrBeforeMs) {
              return utc;
            }
          }
        }
      }
    }
  }

  return null;
}

/**
 * Returns the UTC epoch millisecond timestamp for 00:00:00 (or the earliest local instant
 * of that calendar day if midnight is skipped by DST) on `nowMs`'s local date in `timeZone`.
 */
export function dayStartMs(nowMs: number, timeZone: string): number {
  assertFiniteMs(nowMs, "nowMs");
  if (typeof timeZone !== "string" || timeZone.trim().length === 0) {
    throw new InputError("Time zone must be a non-empty IANA time zone");
  }
  const tz = timeZone.trim();
  getFormatter(tz);
  const p = localParts(nowMs, tz);

  const midnight = resolveFirstUtc(p.year, p.month, p.day, 0, 0, tz);
  if (midnight !== null) {
    return midnight;
  }

  // Handle time zones where 00:00 is skipped by a midnight DST spring-forward.
  for (let totalMin = 1; totalMin < 24 * 60; totalMin++) {
    const h = Math.floor(totalMin / 60);
    const min = totalMin % 60;
    const utc = resolveFirstUtc(p.year, p.month, p.day, h, min, tz);
    if (utc !== null) {
      return utc;
    }
  }

  throw new InputError(`Unable to determine day start for ${tz}`);
}
