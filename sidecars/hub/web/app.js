(() => {
  "use strict";

  const POLL_INTERVAL_MS = 2500;

  const state = {
    snapshot: null,
    extraRuns: [],
    hasMoreRuns: false,
    etag: "",
    selectedRunId: null,
    whyReport: null,
    whyLoading: false,
    whyError: null,
    pollTimer: null,
    isPolling: false,
    isLoadingMore: false,
    busyActions: new Set(),
    draftAnswers: new Map(),
    cardErrors: new Map(),
    lastCardsSig: "",
    lastPipelinesSig: "",
  };

  function getSidecarToken() {
    try {
      const search =
        globalThis.location && typeof globalThis.location.search === "string"
          ? globalThis.location.search
          : "";
      return new URLSearchParams(search).get("token") || "";
    } catch {
      return "";
    }
  }

  async function apiFetch(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    const token = getSidecarToken();
    if (token) {
      headers["x-sidecar-token"] = token;
    }
    if (options.body !== undefined && !headers["content-type"]) {
      headers["content-type"] = "application/json";
    }
    return globalThis.fetch(url, { ...options, headers });
  }

  async function apiPost(url, payload) {
    const res = await apiFetch(url, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) {
      const msg =
        (body && (body.error || body.message)) ||
        `请求失败 (HTTP ${res.status})`;
      throw new Error(String(msg));
    }
    return body;
  }

  function clearNode(node) {
    if (!node) return;
    if (typeof node.replaceChildren === "function") {
      node.replaceChildren();
      return;
    }
    while (node.firstChild) {
      node.removeChild(node.firstChild);
    }
  }

  function appendChildren(parent, children) {
    for (const child of children) {
      if (child === null || child === undefined || child === false) continue;
      if (Array.isArray(child)) {
        appendChildren(parent, child);
      } else if (typeof child === "string" || typeof child === "number") {
        parent.appendChild(document.createTextNode(String(child)));
      } else {
        parent.appendChild(child);
      }
    }
  }

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [key, val] of Object.entries(attrs)) {
        if (val === undefined || val === null || val === false) continue;
        if (key === "className") {
          node.className = String(val);
        } else if (key === "text") {
          node.textContent = String(val);
        } else if (key === "disabled" || key === "open") {
          node[key] = Boolean(val);
        } else if (key === "value") {
          node.value = String(val);
        } else if (key.startsWith("on") && typeof val === "function") {
          node.addEventListener(key.slice(2).toLowerCase(), val);
        } else if (key === "data" && typeof val === "object") {
          for (const [dk, dv] of Object.entries(val)) {
            if (dv !== undefined && dv !== null) {
              node.setAttribute(`data-${dk}`, String(dv));
            }
          }
        } else {
          node.setAttribute(key, val === true ? "" : String(val));
        }
      }
    }
    appendChildren(node, children);
    return node;
  }

  function sanitizeHttpUrl(rawUrl) {
    if (typeof rawUrl !== "string") return null;
    const trimmed = rawUrl.trim();
    if (!trimmed) return null;
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return parsed.href;
      }
      return null;
    } catch {
      return null;
    }
  }

  function createSafeLinkNode(rawUrl, label) {
    const safeHref = sanitizeHttpUrl(rawUrl);
    if (safeHref) {
      return el("a", {
        className: "safe-link",
        href: safeHref,
        target: "_blank",
        rel: "noopener noreferrer",
        text: label || rawUrl,
      });
    }
    return el("span", {
      className: "unsafe-link-text",
      text: label || rawUrl,
    });
  }

  function formatCompactNumber(num) {
    const n = typeof num === "number" && Number.isFinite(num) ? num : 0;
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
  }

  function formatIsoShort(isoStr) {
    if (typeof isoStr !== "string" || !isoStr) return "-";
    const ms = Date.parse(isoStr);
    if (!Number.isFinite(ms)) return isoStr;
    try {
      const d = new Date(ms);
      const pad = (v) => String(v).padStart(2, "0");
      return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    } catch {
      return isoStr;
    }
  }

  function formatDuration(startIso, endIso, fallbackNowIso) {
    const startMs = Date.parse(startIso || "");
    if (!Number.isFinite(startMs)) return "-";
    const endMs = Date.parse(endIso || fallbackNowIso || "");
    if (!Number.isFinite(endMs) || endMs < startMs) return "-";
    const sec = Math.floor((endMs - startMs) / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    const remSec = sec % 60;
    if (min < 60) return `${min}m${remSec}s`;
    const hr = Math.floor(min / 60);
    return `${hr}h${min % 60}m`;
  }

  function setConnectionStatus(mode, text) {
    const pill = document.getElementById("conn-pill");
    const label = document.getElementById("conn-text");
    if (pill) {
      pill.className = `conn-pill is-${mode}`;
    }
    if (label) {
      label.textContent = text;
    }
  }

  function showBanner(message) {
    const banner = document.getElementById("action-banner");
    const textEl = document.getElementById("action-banner-text");
    if (!banner || !textEl) return;
    textEl.textContent = message;
    banner.className = "action-banner";
  }

  function hideBanner() {
    const banner = document.getElementById("action-banner");
    if (banner) {
      banner.className = "action-banner is-hidden";
    }
  }

  function runStatusBadge(status, cancelAt) {
    if (cancelAt && (status === "claimed" || status === "unknown")) {
      return { cls: "badge badge-warn", label: "停止中" };
    }
    switch (status) {
      case "claimed":
        return { cls: "badge badge-info", label: "运行中" };
      case "queued":
        return { cls: "badge badge-warn", label: "排队中" };
      case "unknown":
        return { cls: "badge badge-warn", label: "租约失联" };
      case "done":
        return { cls: "badge badge-ok", label: "已完成" };
      case "nothing":
        return { cls: "badge", label: "没事可做" };
      case "failed":
        return { cls: "badge badge-err", label: "失败" };
      case "cancelled":
        return { cls: "badge", label: "已取消" };
      default:
        return { cls: "badge", label: String(status || "unknown") };
    }
  }

  function lineStatusBadge(status) {
    switch (status) {
      case "running":
        return { cls: "badge badge-info", label: "运行中" };
      case "paused":
        return { cls: "badge badge-warn", label: "已暂停" };
      default:
        return { cls: "badge badge-ok", label: "空闲" };
    }
  }

  function formatUsageSummary(usage) {
    if (!usage) return "Token -";
    const i = formatCompactNumber(usage.input || 0);
    const o = formatCompactNumber(usage.output || 0);
    const c = formatCompactNumber(usage.cached || 0);
    return `In ${i} / Out ${o} / Cache ${c}`;
  }

  async function runAction(actionKey, fn) {
    if (state.busyActions.has(actionKey)) return;
    state.busyActions.add(actionKey);
    hideBanner();
    try {
      await fn();
      await fetchState(true);
    } catch (err) {
      showBanner(err instanceof Error ? err.message : String(err));
    } finally {
      state.busyActions.delete(actionKey);
    }
  }

  function renderOverview() {
    const snap = state.snapshot;
    const pendingBadge = document.getElementById("pending-badge");
    const todayRunsEl = document.getElementById("stat-today-runs");
    const todayTokensEl = document.getElementById("stat-today-tokens");
    const sevenRunsEl = document.getElementById("stat-7d-runs");
    const sevenTokensEl = document.getElementById("stat-7d-tokens");

    if (!snap) return;

    const openCount = (snap.cards || []).filter(
      (c) => c.status === "open",
    ).length;
    if (pendingBadge) {
      pendingBadge.textContent = `${openCount} 待批`;
      pendingBadge.className =
        openCount > 0 ? "pending-badge" : "pending-badge is-zero";
    }

    const today = snap.spending?.today || {
      runs: 0,
      input: 0,
      output: 0,
      cached: 0,
      cost: 0,
    };
    const seven = snap.spending?.last7Days || {
      runs: 0,
      input: 0,
      output: 0,
      cached: 0,
      cost: 0,
    };

    if (todayRunsEl) todayRunsEl.textContent = String(today.runs);
    if (todayTokensEl) {
      todayTokensEl.textContent = `In ${formatCompactNumber(today.input)} · Out ${formatCompactNumber(today.output)} · Cache ${formatCompactNumber(today.cached)}`;
      todayTokensEl.setAttribute(
        "title",
        `Input: ${today.input}, Output: ${today.output}, Cached: ${today.cached}`,
      );
    }

    if (sevenRunsEl) sevenRunsEl.textContent = String(seven.runs);
    if (sevenTokensEl) {
      sevenTokensEl.textContent = `In ${formatCompactNumber(seven.input)} · Out ${formatCompactNumber(seven.output)} · Cache ${formatCompactNumber(seven.cached)}`;
      sevenTokensEl.setAttribute(
        "title",
        `Input: ${seven.input}, Output: ${seven.output}, Cached: ${seven.cached}`,
      );
    }
  }

  function renderActiveCard(card) {
    const kindCls =
      card.status === "decided"
        ? "is-decided"
        : card.kind === "notice"
          ? "is-notice-open"
          : "is-ask-open";

    const statusBadge =
      card.status === "decided"
        ? el("span", {
            className: "badge badge-info",
            text: "已批红・等待内阁续办中",
          })
        : card.kind === "notice"
          ? el("span", { className: "badge badge-warn", text: "呈报通知" })
          : el("span", { className: "badge badge-primary", text: "待批奏折" });

    const tags = [
      statusBadge,
      el("span", { className: "mono-tag", text: `#${card.card}` }),
      el("span", { className: "mono-tag", text: card.rule }),
    ];
    if (card.lane) {
      tags.push(el("span", { className: "mono-tag", text: card.lane }));
    }

    const children = [
      el(
        "div",
        { className: "card-meta-row" },
        el("div", { className: "card-meta-tags" }, ...tags),
        el("span", {
          className: "card-time",
          text: formatIsoShort(card.createdAt),
        }),
      ),
      el("h3", { className: "card-title", text: card.title }),
    ];

    if (card.about) {
      children.push(
        el("div", {
          className: "card-about",
          text: `事由/影响：${card.about}`,
        }),
      );
    }

    if (card.text) {
      children.push(el("p", { className: "card-text", text: card.text }));
    }

    if (card.kind === "ask" && card.status === "open") {
      const options = Array.isArray(card.options) ? card.options : [];
      if (options.length > 0) {
        const optButtons = options.map((optText, idx) => {
          const isRecommended =
            typeof card.recommend === "number" && card.recommend === idx;
          return el(
            "button",
            {
              type: "button",
              className: isRecommended
                ? "btn option-btn is-recommended"
                : "btn option-btn",
              data: {
                action: "answer-choice",
                card: card.card,
                choice: idx,
              },
              onClick: () =>
                runAction(`card-answer-${card.card}`, async () => {
                  await apiPost("/api/cards/answer", {
                    card: card.card,
                    choice: idx,
                  });
                  state.draftAnswers.delete(card.card);
                  state.cardErrors.delete(card.card);
                }),
            },
            el("span", {
              className: "option-label",
              text: `${idx + 1}. ${optText}`,
            }),
            isRecommended
              ? el("span", { className: "recommend-pill", text: "票拟推荐" })
              : null,
          );
        });
        children.push(el("div", { className: "card-options" }, ...optButtons));
      }

      const draftVal = state.draftAnswers.get(card.card) || "";
      const inputEl = el("input", {
        type: "text",
        className: "text-input",
        placeholder: "或输入自定义批复意见...",
        value: draftVal,
        "aria-label": `自定义批复卡片 ${card.card}`,
        onInput: (ev) => {
          state.draftAnswers.set(card.card, ev.target.value);
          if (state.cardErrors.has(card.card)) {
            state.cardErrors.delete(card.card);
          }
        },
      });

      const submitBtn = el("button", {
        type: "button",
        className: "btn btn-primary btn-sm",
        text: "提交批复",
        data: { action: "answer-text", card: card.card },
        onClick: () => {
          const text = String(inputEl.value || "").trim();
          if (!text) {
            state.cardErrors.set(card.card, "请输入批复意见或直接点选上方选项");
            renderCards(true);
            return;
          }
          runAction(`card-answer-${card.card}`, async () => {
            await apiPost("/api/cards/answer", {
              card: card.card,
              text,
            });
            state.draftAnswers.delete(card.card);
            state.cardErrors.delete(card.card);
          });
        },
      });

      children.push(
        el("div", { className: "card-reply-row" }, inputEl, submitBtn),
      );

      const inlineErr = state.cardErrors.get(card.card);
      if (inlineErr) {
        children.push(
          el("div", { className: "card-inline-error", text: inlineErr }),
        );
      }

      const resolveBtn = el("button", {
        type: "button",
        className: "btn btn-ghost btn-xs",
        text: "无需决定 / 结案",
        data: { action: "resolve-card", card: card.card },
        onClick: () =>
          runAction(`card-resolve-${card.card}`, async () => {
            await apiPost("/api/cards/resolve", {
              card: card.card,
              reason: "无需决定，人工结案",
            });
          }),
      });

      children.push(
        el(
          "div",
          { className: "card-footer-actions" },
          el("span", { className: "section-meta", text: `key: ${card.key}` }),
          resolveBtn,
        ),
      );
    } else if (card.status === "decided") {
      const chosenDisplay =
        card.chosen ||
        card.answerText ||
        (typeof card.choice === "number"
          ? `选项 #${card.choice + 1}`
          : "已批复");
      children.push(
        el(
          "div",
          { className: "card-decided-banner" },
          el("strong", { text: "已批红・等待内阁续办中" }),
          el("span", { text: `所选批示：${chosenDisplay}` }),
          card.decidedAt
            ? el("span", {
                className: "card-time",
                text: `批复时间：${formatIsoShort(card.decidedAt)}`,
              })
            : null,
        ),
      );
    } else if (card.kind === "notice" && card.status === "open") {
      const ackBtn = el("button", {
        type: "button",
        className: "btn btn-secondary btn-sm",
        text: "已阅结案",
        data: { action: "resolve-notice", card: card.card },
        onClick: () =>
          runAction(`card-resolve-${card.card}`, async () => {
            await apiPost("/api/cards/resolve", {
              card: card.card,
              reason: "已阅结案",
            });
          }),
      });
      children.push(
        el(
          "div",
          { className: "card-footer-actions" },
          el("span", { className: "section-meta", text: `key: ${card.key}` }),
          ackBtn,
        ),
      );
    }

    return el(
      "article",
      {
        className: `memorial-card ${kindCls}`,
        data: { card: card.card, status: card.status, kind: card.kind },
      },
      ...children,
    );
  }

  function renderRecentCard(card) {
    const statusLabel =
      card.status === "done"
        ? "已续办结案"
        : card.fyi
          ? "知会 (FYI)"
          : "已结案";
    const outcomeText = card.resolvedReason
      ? `结案说明：${card.resolvedReason}`
      : card.chosen || card.answerText
        ? `批示：${card.chosen || card.answerText}`
        : "";

    return el(
      "article",
      {
        className: "memorial-card",
        data: { card: card.card, status: card.status },
      },
      el(
        "div",
        { className: "card-meta-row" },
        el(
          "div",
          { className: "card-meta-tags" },
          el("span", { className: "badge", text: statusLabel }),
          el("span", { className: "mono-tag", text: `#${card.card}` }),
          el("span", { className: "mono-tag", text: card.rule }),
        ),
        el("span", {
          className: "card-time",
          text: formatIsoShort(card.closedAt || card.createdAt),
        }),
      ),
      el("h4", { className: "card-title", text: card.title }),
      card.text ? el("p", { className: "card-text", text: card.text }) : null,
      outcomeText
        ? el("div", { className: "card-about", text: outcomeText })
        : null,
    );
  }

  function renderCards(force = false) {
    const snap = state.snapshot;
    const activeContainer = document.getElementById("active-cards");
    const countMeta = document.getElementById("cards-count-meta");
    const recentSummary = document.getElementById("recent-cards-summary");
    const recentContainer = document.getElementById("recent-cards-list");
    if (!snap || !activeContainer) return;

    const activeCards = snap.cards || [];
    const recentCards = snap.recentCards || [];
    const nextSig = JSON.stringify({ activeCards, recentCards });
    if (
      !force &&
      nextSig === state.lastCardsSig &&
      state.cardErrors.size === 0
    ) {
      return;
    }
    state.lastCardsSig = nextSig;

    if (countMeta) {
      countMeta.textContent = `${activeCards.length} 项待处理`;
    }

    clearNode(activeContainer);
    if (activeCards.length === 0) {
      activeContainer.appendChild(
        el("div", {
          className: "empty-state",
          text: "当前暂无待批奏折，后台规则正平稳运行。",
        }),
      );
    } else {
      for (const card of activeCards) {
        activeContainer.appendChild(renderActiveCard(card));
      }
    }

    if (recentSummary) {
      recentSummary.textContent = `已办结奏折历史 (${recentCards.length})`;
    }
    if (recentContainer) {
      clearNode(recentContainer);
      if (recentCards.length === 0) {
        recentContainer.appendChild(
          el("div", { className: "empty-state", text: "暂无历史办结卡片。" }),
        );
      } else {
        for (const rc of recentCards) {
          recentContainer.appendChild(renderRecentCard(rc));
        }
      }
    }
  }

  function renderPipelineCard(line) {
    const badge = lineStatusBadge(line.status);
    const children = [
      el(
        "div",
        { className: "pipeline-top" },
        el("span", { className: "pipeline-name", text: line.rule }),
        el("span", { className: badge.cls, text: badge.label }),
      ),
      el(
        "div",
        { className: "pipeline-meta" },
        el("span", { className: "mono-tag", text: `to:${line.to}` }),
        el("span", { className: "mono-tag", text: `group:${line.group}` }),
        el("span", { className: "mono-tag", text: line.cwd }),
      ),
      el(
        "div",
        { className: "pipeline-metrics" },
        el("span", { text: `运行 ${line.activeRuns}` }),
        el("span", { text: `排队 ${line.queuedRuns}` }),
        el("span", { text: `今日完成 ${line.doneToday}` }),
        line.nextRunAt
          ? el("span", {
              text: `下次 Cron: ${formatIsoShort(line.nextRunAt)}`,
            })
          : null,
        line.lastRunAt
          ? el("span", {
              text: `上次: ${formatIsoShort(line.lastRunAt)}`,
            })
          : null,
      ),
    ];

    if (line.status === "paused") {
      const reasonPart = line.pauseReason
        ? `原因：${line.pauseReason}`
        : "已手动暂停";
      const untilPart = line.pausedUntil
        ? `（至 ${formatIsoShort(line.pausedUntil)}）`
        : "";
      children.push(
        el("div", {
          className: "pipeline-pause-note",
          text: `${reasonPart}${untilPart}`,
        }),
      );
    }

    const actionButtons = [
      el("button", {
        type: "button",
        className: "btn btn-secondary btn-sm",
        text: "立即运行",
        data: { action: "rule-run", rule: line.rule },
        onClick: () =>
          runAction(`rule-run-${line.rule}`, async () => {
            await apiPost("/api/rules/run", { rule: line.rule });
          }),
      }),
    ];

    if (line.status === "paused") {
      actionButtons.push(
        el("button", {
          type: "button",
          className: "btn btn-primary btn-sm",
          text: "恢复",
          data: { action: "rule-resume", rule: line.rule },
          onClick: () =>
            runAction(`rule-resume-${line.rule}`, async () => {
              await apiPost("/api/rules/resume", { rule: line.rule });
            }),
        }),
      );
    } else {
      actionButtons.push(
        el("button", {
          type: "button",
          className: "btn btn-sm",
          text: "暂停",
          data: { action: "rule-pause", rule: line.rule },
          onClick: () =>
            runAction(`rule-pause-${line.rule}`, async () => {
              await apiPost("/api/rules/pause", {
                rule: line.rule,
                reason: "面板手动暂停",
              });
            }),
        }),
      );
    }

    if (line.skippedCount > 0) {
      actionButtons.push(
        el("button", {
          type: "button",
          className: "btn btn-primary btn-sm",
          text: `补跑跳过事件 (${line.skippedCount})`,
          data: { action: "rule-replay", rule: line.rule },
          onClick: () =>
            runAction(`rule-replay-${line.rule}`, async () => {
              await apiPost("/api/rules/replay", { rule: line.rule });
            }),
        }),
      );
    }

    children.push(
      el("div", { className: "pipeline-actions" }, ...actionButtons),
    );

    return el(
      "div",
      {
        className: "pipeline-card",
        data: { rule: line.rule, status: line.status },
      },
      ...children,
    );
  }

  function renderPipelines() {
    const snap = state.snapshot;
    const linesContainer = document.getElementById("pipeline-lines");
    const countMeta = document.getElementById("pipelines-count-meta");
    const timersBlock = document.getElementById("timers-block");
    const timersList = document.getElementById("timers-list");
    const skippedDetails = document.getElementById("skipped-details");
    const skippedSummary = document.getElementById("skipped-summary");
    const skippedList = document.getElementById("skipped-list");

    if (!snap || !linesContainer) return;

    const lines = snap.lines || [];
    const timers = snap.timers || [];
    const skipped = snap.skipped || [];

    if (countMeta) {
      countMeta.textContent = `${lines.length} 条规则`;
    }

    clearNode(linesContainer);
    if (lines.length === 0) {
      linesContainer.appendChild(
        el("div", {
          className: "empty-state",
          text: "尚未加载任何自动化规则。",
        }),
      );
    } else {
      for (const line of lines) {
        linesContainer.appendChild(renderPipelineCard(line));
      }
    }

    if (timersBlock && timersList) {
      clearNode(timersList);
      if (timers.length === 0) {
        timersBlock.className = "sub-block is-hidden";
      } else {
        timersBlock.className = "sub-block";
        for (const t of timers) {
          timersList.appendChild(
            el(
              "div",
              { className: "timer-row" },
              el(
                "div",
                { className: "timer-top" },
                el("span", {
                  className: "mono-tag",
                  text: `${t.rule}${t.lane ? ` / ${t.lane}` : ""} · ${t.key}`,
                }),
                el("span", {
                  className: "card-time",
                  text: formatIsoShort(t.at),
                }),
              ),
              el("span", { text: t.about || "复查预约" }),
            ),
          );
        }
      }
    }

    if (skippedDetails && skippedSummary && skippedList) {
      clearNode(skippedList);
      if (skipped.length === 0) {
        skippedDetails.className = "collapsible-block is-hidden";
      } else {
        skippedDetails.className = "collapsible-block";
        skippedSummary.textContent = `暂停期间跳过事件 (${skipped.length})`;
        for (const ev of skipped) {
          skippedList.appendChild(
            el(
              "div",
              { className: "skipped-row" },
              el(
                "div",
                { className: "skipped-top" },
                el("span", {
                  className: "mono-tag",
                  text: `${ev.rule} · ${ev.sourceName || ev.source} · ${ev.type}`,
                }),
                el("span", {
                  className: "card-time",
                  text: ev.replayedAt
                    ? `已补跑 ${formatIsoShort(ev.replayedAt)}`
                    : `接收 ${formatIsoShort(ev.receivedAt)}`,
                }),
              ),
              ev.subject
                ? el("span", { className: "mono-tag", text: ev.subject })
                : null,
              ev.summary ? el("span", { text: ev.summary }) : null,
              ev.link ? createSafeLinkNode(ev.link, ev.link) : null,
            ),
          );
        }
      }
    }
  }

  function getCombinedRuns() {
    const snapRuns = state.snapshot?.runs || [];
    if (state.extraRuns.length === 0) return snapRuns;
    const seen = new Set(snapRuns.map((r) => r.run));
    const merged = [...snapRuns];
    for (const r of state.extraRuns) {
      if (!seen.has(r.run)) {
        seen.add(r.run);
        merged.push(r);
      }
    }
    return merged;
  }

  function renderRuns() {
    const snap = state.snapshot;
    const runsList = document.getElementById("runs-list");
    const paginationRow = document.getElementById("runs-pagination");
    const loadMoreBtn = document.getElementById("btn-load-more-runs");
    if (!snap || !runsList) return;

    const runs = getCombinedRuns();
    clearNode(runsList);

    if (runs.length === 0) {
      runsList.appendChild(
        el("div", { className: "empty-state", text: "暂无历史或运行中轮次。" }),
      );
    } else {
      for (const run of runs) {
        const badge = runStatusBadge(run.status, run.cancelAt);
        const canStop =
          run.status === "claimed" ||
          run.status === "queued" ||
          run.status === "unknown";
        const stopDisabled = Boolean(run.cancelAt);

        const titleGroup = [
          el("span", { className: badge.cls, text: badge.label }),
          el("span", { className: "run-id", text: `#${run.run}` }),
          el("span", { className: "run-rule", text: run.rule }),
        ];
        if (run.lane) {
          titleGroup.push(
            el("span", { className: "mono-tag", text: run.lane }),
          );
        }

        const rightActions = [];
        if (canStop) {
          rightActions.push(
            el("button", {
              type: "button",
              className: "btn btn-danger btn-xs",
              text: stopDisabled ? "停止中..." : "停止",
              disabled: stopDisabled,
              data: { action: "run-stop", run: run.run },
              onClick: (ev) => {
                if (typeof ev.stopPropagation === "function") {
                  ev.stopPropagation();
                }
                runAction(`run-stop-${run.run}`, async () => {
                  await apiPost("/api/runs/stop", { run: run.run });
                });
              },
            }),
          );
        }

        const durationStr = formatDuration(
          run.startedAt || run.claimedAt || run.createdAt,
          run.endedAt,
          snap.now,
        );

        const rowEl = el(
          "div",
          {
            className:
              state.selectedRunId === run.run
                ? "run-row is-selected"
                : "run-row",
            data: { run: run.run, status: run.status },
            onClick: () => openWhyDrawer(run.run),
          },
          el(
            "div",
            { className: "run-top" },
            el("div", { className: "run-title-group" }, ...titleGroup),
            el("div", { className: "status-controls" }, ...rightActions),
          ),
          el(
            "div",
            { className: "run-meta" },
            el("span", { text: run.model || run.agent }),
            el("span", { text: `attempt #${run.attempt}` }),
            el("span", { text: `耗时 ${durationStr}` }),
            el("span", { text: formatUsageSummary(run.usage) }),
            el("span", { text: formatIsoShort(run.createdAt) }),
          ),
          run.summary
            ? el("div", { className: "run-summary", text: run.summary })
            : null,
          run.error
            ? el("div", { className: "run-error", text: run.error })
            : null,
        );

        runsList.appendChild(rowEl);
      }
    }

    if (paginationRow && loadMoreBtn) {
      if (state.hasMoreRuns) {
        paginationRow.className = "pagination-row";
        loadMoreBtn.disabled = state.isLoadingMore;
        loadMoreBtn.textContent = state.isLoadingMore
          ? "加载中..."
          : "加载更多历史轮次";
      } else {
        paginationRow.className = "pagination-row is-hidden";
      }
    }
  }

  function renderWhyDrawer() {
    const drawer = document.getElementById("why-drawer");
    const subtitle = document.getElementById("why-drawer-subtitle");
    const body = document.getElementById("why-drawer-body");
    if (!drawer || !body) return;

    if (state.selectedRunId === null) {
      drawer.className = "why-drawer is-hidden";
      clearNode(body);
      return;
    }

    drawer.className = "why-drawer";
    if (subtitle) {
      subtitle.textContent = `Run #${state.selectedRunId}`;
    }

    clearNode(body);

    if (state.whyLoading) {
      body.appendChild(
        el("div", {
          className: "empty-state",
          text: "正在加载因果追溯报告...",
        }),
      );
      return;
    }

    if (state.whyError) {
      body.appendChild(
        el("div", {
          className: "why-rejected",
          text: `加载失败：${state.whyError}`,
        }),
      );
      return;
    }

    const report = state.whyReport;
    if (!report) return;

    const r = report.run;
    const spec = report.ruleSpec;

    if (subtitle) {
      subtitle.textContent = `Run #${r.run} · ${r.rule} (v${report.ruleVersion})`;
    }

    // 1. Metadata Block
    const kvRows = [
      ["规则 / 版本", `${r.rule} (v${report.ruleVersion})`],
      ["状态 / 尝试", `${r.status} · attempt #${r.attempt}`],
      ["模型 / 执行器", `${r.model || "-"} (${r.agent} / ${r.runner})`],
      ["工作区 cwd", spec?.cwd || "-"],
      ["Skill", spec?.skill || "-"],
      ["会话 Session", r.session || "-"],
      ["Token 用量", formatUsageSummary(r.usage)],
    ];

    const kvNodes = [];
    for (const [k, v] of kvRows) {
      kvNodes.push(el("span", { className: "why-k", text: k }));
      kvNodes.push(el("span", { className: "why-v", text: v }));
    }

    const metaBlockChildren = [
      el("h3", { className: "why-block-title", text: "执行上下文与规则版本" }),
      el("div", { className: "why-kv-list" }, ...kvNodes),
    ];

    if (r.session) {
      metaBlockChildren.push(
        el("button", {
          type: "button",
          className: "btn btn-secondary btn-xs",
          text: "复制 Session ID",
          onClick: () => {
            if (globalThis.navigator?.clipboard?.writeText) {
              globalThis.navigator.clipboard
                .writeText(r.session)
                .catch(() => {});
            }
          },
        }),
      );
    }

    if (r.summary) {
      metaBlockChildren.push(
        el("div", { className: "card-about", text: `结论：${r.summary}` }),
      );
    }
    if (r.error) {
      metaBlockChildren.push(
        el("div", { className: "why-rejected", text: `错误：${r.error}` }),
      );
    }

    body.appendChild(
      el("section", { className: "why-block" }, ...metaBlockChildren),
    );

    // 2. Triggering Events
    const eventsBlock = [
      el("h3", {
        className: "why-block-title",
        text: `触发事件源 (${(report.events || []).length})`,
      }),
    ];
    if (!report.events || report.events.length === 0) {
      eventsBlock.push(
        el("span", { className: "section-meta", text: "无关联触发事件" }),
      );
    } else {
      for (const ev of report.events) {
        eventsBlock.push(
          el(
            "div",
            { className: "why-item" },
            el("div", {
              className: "mono-tag",
              text: `${ev.sourceName || ev.source} · ${ev.type}${ev.subject ? ` · ${ev.subject}` : ""} · hops=${ev.hops ?? 0}`,
            }),
            ev.summary ? el("div", { text: ev.summary }) : null,
            ev.detail
              ? el("div", { className: "card-text", text: ev.detail })
              : null,
            ev.link ? createSafeLinkNode(ev.link, ev.link) : null,
            el("span", {
              className: "card-time",
              text: `id=${ev.id} · ${formatIsoShort(ev.receivedAt)}`,
            }),
          ),
        );
      }
    }
    body.appendChild(el("section", { className: "why-block" }, ...eventsBlock));

    // 3. Input Answers & Fired Timers
    const answers = report.answers || [];
    const timers = report.timers || [];
    if (answers.length > 0 || timers.length > 0) {
      const inputBlock = [
        el("h3", {
          className: "why-block-title",
          text: "关联人工批示与定时器",
        }),
      ];
      for (const ans of answers) {
        inputBlock.push(
          el(
            "div",
            { className: "why-item" },
            el("strong", { text: `卡片 #${ans.card}：${ans.title}` }),
            el("span", { text: `批复：${ans.chosen}` }),
            el("span", {
              className: "card-time",
              text: formatIsoShort(ans.at),
            }),
          ),
        );
      }
      for (const tm of timers) {
        inputBlock.push(
          el(
            "div",
            { className: "why-item" },
            el("span", { className: "mono-tag", text: `定时器 ${tm.key}` }),
            el("span", { text: tm.about }),
            el("span", {
              className: "card-time",
              text: formatIsoShort(tm.at),
            }),
          ),
        );
      }
      body.appendChild(
        el("section", { className: "why-block" }, ...inputBlock),
      );
    }

    // 4. Receipt Outcomes & Intercepted Items
    const cardsCreated = report.cardsCreated || [];
    const cardsResolved = report.cardsResolved || [];
    const eventsEmitted = report.eventsEmitted || [];
    const rejectedEvents = report.receipt?.rejectedEvents || [];
    const rejectedResolves = report.receipt?.rejectedResolves || [];

    const receiptBlock = [
      el("h3", { className: "why-block-title", text: "回执产出与拦截明细" }),
    ];

    if (
      cardsCreated.length === 0 &&
      cardsResolved.length === 0 &&
      eventsEmitted.length === 0 &&
      rejectedEvents.length === 0 &&
      rejectedResolves.length === 0
    ) {
      receiptBlock.push(
        el("span", { className: "section-meta", text: "本轮无额外回执衍生项" }),
      );
    } else {
      for (const c of cardsCreated) {
        receiptBlock.push(
          el(
            "div",
            { className: "why-item" },
            el("span", {
              className: "badge badge-info",
              text: `产出卡片 #${c.card} (${c.kind}/${c.status})`,
            }),
            el("span", { text: c.title }),
          ),
        );
      }
      if (cardsResolved.length > 0) {
        receiptBlock.push(
          el("div", {
            className: "why-item",
            text: `已结案卡片：${cardsResolved.map((id) => `#${id}`).join(", ")}`,
          }),
        );
      }
      for (const em of eventsEmitted) {
        receiptBlock.push(
          el(
            "div",
            { className: "why-item" },
            el("span", {
              className: "mono-tag",
              text: `衍生事件 ${em.source}:${em.type}${em.subject ? ` (${em.subject})` : ""} hops=${em.hops}`,
            }),
            em.summary ? el("span", { text: em.summary }) : null,
          ),
        );
      }
      for (const rejEv of rejectedEvents) {
        receiptBlock.push(
          el("div", {
            className: "why-rejected",
            text: `被拦截衍生事件 [${rejEv.type}]：${rejEv.error}`,
          }),
        );
      }
      for (const rejRes of rejectedResolves) {
        receiptBlock.push(
          el("div", {
            className: "why-rejected",
            text: `被拦截结案请求 [卡片 #${rejRes.card}] (${rejRes.reason})：${rejRes.error}`,
          }),
        );
      }
    }
    body.appendChild(
      el("section", { className: "why-block" }, ...receiptBlock),
    );

    // 5. Timeline
    const timeline = report.timeline || [];
    const timelineBlock = [
      el("h3", {
        className: "why-block-title",
        text: `生命周期时间线 (${timeline.length})`,
      }),
    ];
    for (const item of timeline) {
      timelineBlock.push(
        el(
          "div",
          { className: "why-item" },
          el(
            "div",
            { className: "card-meta-row" },
            el("span", { className: "mono-tag", text: item.kind }),
            el("span", {
              className: "card-time",
              text: formatIsoShort(item.at),
            }),
          ),
          el("span", { text: item.detail }),
        ),
      );
    }
    body.appendChild(
      el("section", { className: "why-block" }, ...timelineBlock),
    );
  }

  function renderAll() {
    renderOverview();
    renderCards();
    renderPipelines();
    renderRuns();
    renderWhyDrawer();
  }

  async function fetchState(force = false) {
    if (state.isPolling && !force) return;
    state.isPolling = true;
    try {
      const qs =
        !force && state.etag ? `?etag=${encodeURIComponent(state.etag)}` : "";
      const res = await apiFetch(`/api/state${qs}`);
      if (res.status === 304) {
        setConnectionStatus("online", "已连接 · 实时同步");
        return;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const next = await res.json();
      state.snapshot = next;
      state.etag = next.etag || "";
      if (state.extraRuns.length === 0) {
        state.hasMoreRuns = Boolean(next.hasMoreRuns);
      }
      setConnectionStatus("online", "已连接 · 实时同步");
      renderAll();
    } catch (err) {
      setConnectionStatus("error", "连接中断 · 重试中");
      if (!state.snapshot) {
        showBanner(
          `无法连接 Autoloop 后台：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } finally {
      state.isPolling = false;
    }
  }

  async function loadMoreRuns() {
    const combined = getCombinedRuns();
    if (combined.length === 0 || state.isLoadingMore) return;
    const lastRunId = combined[combined.length - 1].run;
    state.isLoadingMore = true;
    renderRuns();
    try {
      const res = await apiFetch(
        `/api/state?before=${encodeURIComponent(String(lastRunId))}`,
      );
      if (!res.ok) {
        throw new Error(`加载更多失败 (HTTP ${res.status})`);
      }
      const page = await res.json();
      const pageRuns = page.runs || [];
      state.extraRuns = [...state.extraRuns, ...pageRuns];
      state.hasMoreRuns = Boolean(page.hasMoreRuns);
      renderRuns();
    } catch (err) {
      showBanner(err instanceof Error ? err.message : String(err));
    } finally {
      state.isLoadingMore = false;
      renderRuns();
    }
  }

  async function openWhyDrawer(runId) {
    state.selectedRunId = runId;
    state.whyLoading = true;
    state.whyError = null;
    state.whyReport = null;
    renderRuns();
    renderWhyDrawer();

    try {
      const res = await apiFetch(
        `/api/why?run=${encodeURIComponent(String(runId))}`,
      );
      if (!res.ok) {
        let errMsg = `HTTP ${res.status}`;
        try {
          const errBody = await res.json();
          if (errBody && (errBody.error || errBody.message)) {
            errMsg = String(errBody.error || errBody.message);
          }
        } catch {
          // ignore parse failure
        }
        throw new Error(errMsg);
      }
      const report = await res.json();
      if (state.selectedRunId !== runId) return;
      state.whyReport = report;
    } catch (err) {
      if (state.selectedRunId !== runId) return;
      state.whyError = err instanceof Error ? err.message : String(err);
    } finally {
      if (state.selectedRunId === runId) {
        state.whyLoading = false;
        renderWhyDrawer();
      }
    }
  }

  function closeWhyDrawer() {
    state.selectedRunId = null;
    state.whyReport = null;
    state.whyError = null;
    state.whyLoading = false;
    renderRuns();
    renderWhyDrawer();
  }

  function bindStaticHandlers() {
    const refreshBtn = document.getElementById("btn-refresh");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", () => {
        setConnectionStatus("syncing", "同步中...");
        fetchState(true);
      });
    }

    const bannerClose = document.getElementById("action-banner-close");
    if (bannerClose) {
      bannerClose.addEventListener("click", hideBanner);
    }

    const loadMoreBtn = document.getElementById("btn-load-more-runs");
    if (loadMoreBtn) {
      loadMoreBtn.addEventListener("click", loadMoreRuns);
    }

    const whyCloseBtn = document.getElementById("why-drawer-close");
    if (whyCloseBtn) {
      whyCloseBtn.addEventListener("click", closeWhyDrawer);
    }
  }

  function destroy() {
    if (state.pollTimer !== null) {
      globalThis.clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function init() {
    destroy();
    bindStaticHandlers();
    setConnectionStatus("syncing", "连接中...");
    fetchState(true);
    state.pollTimer = globalThis.setInterval(() => {
      fetchState(false);
    }, POLL_INTERVAL_MS);
  }

  globalThis.__autoloopApp = {
    init,
    destroy,
    refresh: () => fetchState(true),
    getState: () => state,
  };

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init);
    } else {
      init();
    }
  }
})();
