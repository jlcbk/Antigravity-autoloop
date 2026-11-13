#!/usr/bin/env node
/**
 * Zero-token HTTP health probe script for Autoloop `runner: "command"`.
 *
 * Behavior:
 * - Healthy HTTP 2xx while previously healthy -> silent exit 0 (empty stdout -> `nothing`, 0 tokens).
 * - Transient failure below `--threshold` (default 2) -> persist count, silent exit 0.
 * - Consecutive failures >= `--threshold` (first transition to alerting) ->
 *   print 1-line summary + ```agent-autoloop receipt emitting `service.down`.
 * - Subsequent failures while already alerting -> silent exit 0 (prevents alert storms).
 * - Recovery HTTP 2xx while previously alerting ->
 *   print 1-line summary + ```agent-autoloop receipt emitting `service.recovered`
 *   (and resolving matching open health alert cards in `AUTOLOOP_CONTEXT` if present).
 */

import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_THRESHOLD = 2;
const DEFAULT_TIMEOUT_MS = 5_000;
const SUBJECT_RE = /^[a-zA-Z0-9#][a-zA-Z0-9#._:/@-]*$/;

function expandHome(rawPath, homeDir = os.homedir()) {
  if (rawPath === "~") return homeDir;
  if (rawPath.startsWith("~/")) return path.join(homeDir, rawPath.slice(2));
  return rawPath;
}

function resolveProbesDir(env) {
  const explicitHome = env.AUTOLOOP_HOME?.trim();
  if (explicitHome) {
    return path.join(path.resolve(expandHome(explicitHome)), "probes");
  }
  const pluginData = env.PLUGIN_DATA?.trim();
  if (pluginData) {
    return path.join(path.resolve(expandHome(pluginData)), "probes");
  }
  const contextFile = env.AUTOLOOP_CONTEXT?.trim();
  if (contextFile) {
    const runDir = path.dirname(path.resolve(expandHome(contextFile)));
    const runsDir = path.dirname(runDir);
    if (path.basename(runsDir) === "runs") {
      return path.join(path.dirname(runsDir), "probes");
    }
  }
  return path.join(os.homedir(), ".autoloop", "probes");
}

function parsePositiveInt(raw, label) {
  const num = Number(raw);
  if (!Number.isSafeInteger(num) || num <= 0) {
    throw new Error(`${label} 必须是正整数，收到: ${String(raw)}`);
  }
  return num;
}

function parseCliArgs(argv, env) {
  let url = env.PROBE_URL?.trim() || env.AUTOLOOP_PROBE_URL?.trim() || "";
  let stateFile =
    env.PROBE_STATE_FILE?.trim() || env.AUTOLOOP_PROBE_STATE?.trim() || "";
  let thresholdRaw = env.PROBE_THRESHOLD?.trim() || "";
  let timeoutRaw = env.PROBE_TIMEOUT_MS?.trim() || "";
  let subject = env.PROBE_SUBJECT?.trim() || "";
  let expectStatusRaw = env.PROBE_EXPECT_STATUS?.trim() || "";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--url" && i + 1 < argv.length) {
      url = argv[++i].trim();
    } else if (arg.startsWith("--url=")) {
      url = arg.slice("--url=".length).trim();
    } else if (
      (arg === "--state" || arg === "--state-file") &&
      i + 1 < argv.length
    ) {
      stateFile = argv[++i].trim();
    } else if (arg.startsWith("--state=")) {
      stateFile = arg.slice("--state=".length).trim();
    } else if (arg.startsWith("--state-file=")) {
      stateFile = arg.slice("--state-file=".length).trim();
    } else if (arg === "--threshold" && i + 1 < argv.length) {
      thresholdRaw = argv[++i].trim();
    } else if (arg.startsWith("--threshold=")) {
      thresholdRaw = arg.slice("--threshold=".length).trim();
    } else if (arg === "--timeout-ms" && i + 1 < argv.length) {
      timeoutRaw = argv[++i].trim();
    } else if (arg.startsWith("--timeout-ms=")) {
      timeoutRaw = arg.slice("--timeout-ms=".length).trim();
    } else if (arg === "--subject" && i + 1 < argv.length) {
      subject = argv[++i].trim();
    } else if (arg.startsWith("--subject=")) {
      subject = arg.slice("--subject=".length).trim();
    } else if (arg === "--expect-status" && i + 1 < argv.length) {
      expectStatusRaw = argv[++i].trim();
    } else if (arg.startsWith("--expect-status=")) {
      expectStatusRaw = arg.slice("--expect-status=".length).trim();
    } else if (!arg.startsWith("-") && !url) {
      url = arg.trim();
    } else {
      throw new Error(`未知或缺少参数值的选项: ${arg}`);
    }
  }

  if (!url) {
    throw new Error("缺少探测目标 URL（请传 --url <url> 或设置 PROBE_URL）");
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`探测目标不是合法 URL: ${url}`);
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error(`仅支持 http/https 协议 URL，收到: ${parsedUrl.protocol}`);
  }

  const threshold = thresholdRaw
    ? parsePositiveInt(thresholdRaw, "threshold")
    : DEFAULT_THRESHOLD;
  const timeoutMs = timeoutRaw
    ? parsePositiveInt(timeoutRaw, "timeout-ms")
    : DEFAULT_TIMEOUT_MS;
  const expectStatus = expectStatusRaw
    ? parsePositiveInt(expectStatusRaw, "expect-status")
    : null;

  const resolvedStateFile = stateFile
    ? path.resolve(expandHome(stateFile))
    : defaultStateFileForUrl(parsedUrl, env);

  const safeSubject = sanitizeSubject(
    subject || `${parsedUrl.host}${parsedUrl.pathname}`,
  );

  return {
    url: parsedUrl.toString(),
    parsedUrl,
    stateFile: resolvedStateFile,
    threshold,
    timeoutMs,
    expectStatus,
    subject: safeSubject,
  };
}

function defaultStateFileForUrl(parsedUrl, env) {
  const probesDir = resolveProbesDir(env);
  const slug = parsedUrl.host
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  const hash = createHash("sha256")
    .update(parsedUrl.toString())
    .digest("hex")
    .slice(0, 10);
  return path.join(probesDir, `${slug || "target"}-${hash}.json`);
}

function sanitizeSubject(raw) {
  let cleaned = String(raw)
    .replace(/[^a-zA-Z0-9#._:/@-]+/g, "_")
    .replace(/^_+/, "");
  if (cleaned.length === 0 || !/^[a-zA-Z0-9#]/.test(cleaned)) {
    cleaned = `svc-${cleaned || "health"}`;
  }
  if (cleaned.length > 100) {
    cleaned = cleaned.slice(0, 100);
  }
  if (!SUBJECT_RE.test(cleaned)) {
    return "service-health";
  }
  return cleaned;
}

function safeAsciiLink(urlStr) {
  if (
    typeof urlStr === "string" &&
    urlStr.length <= 500 &&
    (urlStr.startsWith("http://") || urlStr.startsWith("https://")) &&
    // eslint-disable-next-line no-control-regex
    !/[\x00-\x20\x7f-\uffff]/.test(urlStr)
  ) {
    return urlStr;
  }
  return undefined;
}

function truncate(str, max) {
  const s = String(str ?? "")
    .replace(/[\r\n]+/g, " ")
    .trim();
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 3))}...`;
}

function readState(stateFile) {
  if (!existsSync(stateFile)) {
    return {
      url: null,
      consecutiveFailures: 0,
      alerting: false,
      incidentId: null,
      downSince: null,
      lastStatus: null,
      lastError: null,
      lastCheckedAt: null,
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(stateFile, "utf8"));
    return {
      url: typeof parsed?.url === "string" ? parsed.url : null,
      consecutiveFailures:
        typeof parsed?.consecutiveFailures === "number" &&
        Number.isSafeInteger(parsed.consecutiveFailures) &&
        parsed.consecutiveFailures >= 0
          ? parsed.consecutiveFailures
          : 0,
      alerting: parsed?.alerting === true,
      incidentId:
        typeof parsed?.incidentId === "string" && parsed.incidentId.length > 0
          ? parsed.incidentId
          : null,
      downSince:
        typeof parsed?.downSince === "string" ? parsed.downSince : null,
      lastStatus:
        typeof parsed?.lastStatus === "number" ? parsed.lastStatus : null,
      lastError:
        typeof parsed?.lastError === "string" ? parsed.lastError : null,
      lastCheckedAt:
        typeof parsed?.lastCheckedAt === "string" ? parsed.lastCheckedAt : null,
    };
  } catch {
    return {
      url: null,
      consecutiveFailures: 0,
      alerting: false,
      incidentId: null,
      downSince: null,
      lastStatus: null,
      lastError: null,
      lastCheckedAt: null,
    };
  }
}

function writeStateAtomic(stateFile, state) {
  const dir = path.dirname(stateFile);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = path.join(
    dir,
    `.${path.basename(stateFile)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    chmodSync(tmpPath, 0o600);
    renameSync(tmpPath, stateFile);
    chmodSync(stateFile, 0o600);
  } catch (err) {
    try {
      if (existsSync(tmpPath)) {
        rmSync(tmpPath, { force: true });
      }
    } catch {
      // Best-effort cleanup
    }
    throw err;
  }
}

function findMatchingOpenCardsFromContext(env, subject, incidentId) {
  const contextPath = env.AUTOLOOP_CONTEXT?.trim();
  if (!contextPath || !existsSync(contextPath)) {
    return [];
  }
  try {
    const parsed = JSON.parse(readFileSync(contextPath, "utf8"));
    const open = Array.isArray(parsed?.context?.open)
      ? parsed.context.open
      : Array.isArray(parsed?.open)
        ? parsed.open
        : [];
    const matches = [];
    for (const card of open) {
      if (!card || typeof card.card !== "number") continue;
      const key = typeof card.key === "string" ? card.key : "";
      if (
        key.startsWith("health-") ||
        key.startsWith("service-down") ||
        (incidentId && key.includes(incidentId)) ||
        (subject && key.includes(subject))
      ) {
        matches.push(card.card);
      }
    }
    return matches;
  } catch {
    return [];
  }
}

function makeIncidentId(subject, nowMs) {
  const slug = subject.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 48);
  const rand = randomBytes(3).toString("hex");
  return `${slug || "svc"}-${nowMs}-${rand}`;
}

async function performProbe(url, timeoutMs, expectStatus) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  try {
    const res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent": "autoloop-health-probe/1.0",
        accept: "application/json, text/plain, */*",
      },
    });
    const ok =
      expectStatus !== null
        ? res.status === expectStatus
        : res.status >= 200 && res.status < 300;
    let bodySnippet = "";
    if (!ok) {
      try {
        bodySnippet = (await res.text()).slice(0, 400);
      } catch {
        bodySnippet = "";
      }
    } else {
      await res.body?.cancel().catch(() => {});
    }
    return {
      ok,
      status: res.status,
      reason: ok
        ? `HTTP ${res.status}`
        : `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`,
      bodySnippet,
    };
  } catch (err) {
    const msg =
      err instanceof Error
        ? err.name === "AbortError"
          ? `Timeout after ${timeoutMs}ms`
          : err.message
        : String(err);
    return {
      ok: false,
      status: null,
      reason: msg || "Network error",
      bodySnippet: "",
    };
  } finally {
    clearTimeout(timer);
  }
}

function emitReceiptMessage(firstLine, receipt) {
  const safeFirstLine = firstLine.replace(/[\r\n]+/g, " ").trim();
  process.stdout.write(
    `${safeFirstLine}\n\n\`\`\`agent-autoloop\n${JSON.stringify(receipt)}\n\`\`\`\n`,
  );
}

async function main() {
  let cfg;
  try {
    cfg = parseCliArgs(process.argv.slice(2), process.env);
  } catch (err) {
    process.stderr.write(
      `[probe-url] 参数错误: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
  }

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const prev = readState(cfg.stateFile);
  const probe = await performProbe(cfg.url, cfg.timeoutMs, cfg.expectStatus);
  const link = safeAsciiLink(cfg.url);

  if (probe.ok) {
    const wasAlerting = prev.alerting === true;
    const prevFailures = prev.consecutiveFailures;
    const prevIncidentId =
      prev.incidentId || makeIncidentId(cfg.subject, nowMs);
    const downSince = prev.downSince;

    writeStateAtomic(cfg.stateFile, {
      url: cfg.url,
      consecutiveFailures: 0,
      alerting: false,
      incidentId: null,
      downSince: null,
      lastStatus: probe.status,
      lastError: null,
      lastCheckedAt: nowIso,
    });

    if (!wasAlerting) {
      // Healthy and was not alerting -> silent exit 0 -> command-runner marks `nothing` (0 tokens)
      process.exit(0);
    }

    const openCardIds = findMatchingOpenCardsFromContext(
      process.env,
      cfg.subject,
      prevIncidentId,
    );
    const eventId = `probe-recovered-${prevIncidentId}`.slice(0, 200);
    const summary = truncate(
      `Service recovered (${probe.reason}) after ${prevFailures} failed checks: ${cfg.url}`,
      200,
    );
    const detail = [
      `URL: ${cfg.url}`,
      `Status: ${probe.reason}`,
      `Previous consecutive failures: ${prevFailures}`,
      downSince ? `Down since: ${downSince}` : null,
      `Recovered at: ${nowIso}`,
    ]
      .filter(Boolean)
      .join("\n")
      .slice(0, 8000);

    const receipt = {
      events: [
        {
          id: eventId,
          type: "service.recovered",
          subject: cfg.subject,
          summary,
          detail,
          ...(link ? { link } : {}),
        },
      ],
      ...(openCardIds.length > 0
        ? {
            resolve: openCardIds.map((card) => ({
              card,
              reason: `健康探针确认 ${cfg.url} 已恢复 ${probe.reason}`,
            })),
          }
        : {}),
    };

    emitReceiptMessage(
      `服务已恢复健康：${cfg.url} 返回 ${probe.reason}（此前连续失败 ${prevFailures} 次）。`,
      receipt,
    );
    process.exit(0);
  }

  // Probe failed
  const nextFailures = prev.consecutiveFailures + 1;
  const shouldAlert = !prev.alerting && nextFailures >= cfg.threshold;
  const incidentId = shouldAlert
    ? makeIncidentId(cfg.subject, nowMs)
    : prev.incidentId;
  const downSince = prev.downSince ?? (shouldAlert ? nowIso : null);

  writeStateAtomic(cfg.stateFile, {
    url: cfg.url,
    consecutiveFailures: nextFailures,
    alerting: prev.alerting || shouldAlert,
    incidentId,
    downSince,
    lastStatus: probe.status,
    lastError: truncate(probe.reason, 500),
    lastCheckedAt: nowIso,
  });

  if (!shouldAlert) {
    // Either below threshold (transient blip) or already alerting -> silent exit 0 -> no token burn / no alert storm
    process.exit(0);
  }

  const eventId = `probe-down-${incidentId}`.slice(0, 200);
  const summary = truncate(
    `Service down (${probe.reason}) for ${nextFailures}/${cfg.threshold} checks: ${cfg.url}`,
    200,
  );
  const detail = [
    `URL: ${cfg.url}`,
    `Failure: ${probe.reason}`,
    `Consecutive failures: ${nextFailures} (threshold=${cfg.threshold})`,
    `Detected at: ${nowIso}`,
    probe.bodySnippet
      ? `Response snippet (untrusted data):\n${probe.bodySnippet}`
      : null,
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 8000);

  emitReceiptMessage(
    `健康巡检连续失败 ${nextFailures} 次（阈值 ${cfg.threshold}）：${cfg.url} ${truncate(probe.reason, 120)}`,
    {
      events: [
        {
          id: eventId,
          type: "service.down",
          subject: cfg.subject,
          summary,
          detail,
          ...(link ? { link } : {}),
        },
      ],
    },
  );
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(
    `[probe-url] 探测异常: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
