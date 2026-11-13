#!/usr/bin/env node
/**
 * Antigravity Stop lifecycle hook for Autoloop runs.
 * - Zero-interference fast path when AUTOLOOP_GUARD_FILE is unset or
 *   terminationReason !== "NO_TOOL_CALL".
 * - Inspects the last model response in `transcriptPath` using `readMessage()`.
 * - Blocks premature stop up to 2 times with `{"decision":"continue","reason": repairPrompt(problem)}`
 *   so malformed receipts are repaired in-place without cold-restarting.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readMessage, repairPrompt } from "../protocol/receipt.ts";

const MAX_STOP_RETRIES = 2;

function respond(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      resolve(data);
    });
    process.stdin.on("error", () => {
      resolve(data);
    });
  });
}

function resolveFullStepContent(transcriptPath, step, lineIndex) {
  const fallback = typeof step.content === "string" ? step.content : "";
  if (
    !Array.isArray(step.truncated_fields) ||
    !step.truncated_fields.includes("content")
  ) {
    return fallback;
  }

  const fullPath = path.join(
    path.dirname(transcriptPath),
    "transcript_full.jsonl",
  );
  if (!existsSync(fullPath)) {
    return fallback;
  }

  try {
    const fullLines = readFileSync(fullPath, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);
    if (step.step_index !== undefined) {
      for (let i = fullLines.length - 1; i >= 0; i--) {
        try {
          const cand = JSON.parse(fullLines[i]);
          if (
            cand &&
            cand.step_index === step.step_index &&
            typeof cand.content === "string"
          ) {
            return cand.content;
          }
        } catch {
          // Ignore malformed line
        }
      }
    }
    if (lineIndex >= 0 && lineIndex < fullLines.length) {
      const cand = JSON.parse(fullLines[lineIndex]);
      if (cand && typeof cand.content === "string") {
        return cand.content;
      }
    }
  } catch {
    // Fall back to compact content
  }
  return fallback;
}

function extractLastModelText(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return null;
  }

  let raw;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return null;
  }

  if (raw.trim().length === 0) {
    return null;
  }

  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const parsedEntries = [];
  let hasNonJsonLine = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith("{")) {
      hasNonJsonLine = true;
      continue;
    }
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        parsedEntries.push({ obj, index: i });
      } else {
        hasNonJsonLine = true;
      }
    } catch {
      hasNonJsonLine = true;
    }
  }

  for (let i = parsedEntries.length - 1; i >= 0; i--) {
    const { obj, index } = parsedEntries[i];
    const stepType = typeof obj.type === "string" ? obj.type : "";
    const role = typeof obj.role === "string" ? obj.role.toLowerCase() : "";

    if (stepType === "PLANNER_RESPONSE") {
      const hasToolCalls =
        Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0;
      if (hasToolCalls && (!obj.content || String(obj.content).trim() === "")) {
        continue;
      }
      if (typeof obj.content === "string") {
        return resolveFullStepContent(transcriptPath, obj, index);
      }
    }

    if (
      stepType === "assistant" ||
      stepType === "result" ||
      role === "assistant"
    ) {
      if (typeof obj.content === "string") {
        return obj.content;
      }
      if (typeof obj.text === "string") {
        return obj.text;
      }
      if (typeof obj.result === "string") {
        return obj.result;
      }
    }
  }

  if (hasNonJsonLine || parsedEntries.length === 0) {
    return raw;
  }

  return null;
}

function readRetryCount(counterFile) {
  if (!existsSync(counterFile)) {
    return 0;
  }
  try {
    const data = JSON.parse(readFileSync(counterFile, "utf8"));
    return typeof data?.count === "number" &&
      Number.isSafeInteger(data.count) &&
      data.count >= 0
      ? data.count
      : 0;
  } catch {
    return 0;
  }
}

function writeRetryCount(counterFile, count) {
  try {
    mkdirSync(path.dirname(counterFile), { recursive: true });
    writeFileSync(
      counterFile,
      `${JSON.stringify({ count }, null, 2)}\n`,
      "utf8",
    );
  } catch {
    // Best-effort counter persistence
  }
}

async function main() {
  const stdinRaw = await readStdin();

  const guardFile = process.env.AUTOLOOP_GUARD_FILE;
  if (!guardFile) {
    respond({ decision: "stop" });
    return;
  }

  let payload = {};
  try {
    if (stdinRaw.trim().length > 0) {
      payload = JSON.parse(stdinRaw);
    }
  } catch {
    respond({ decision: "stop" });
    return;
  }

  if (payload?.terminationReason !== "NO_TOOL_CALL") {
    respond({ decision: "stop" });
    return;
  }

  const transcriptPath =
    typeof payload?.transcriptPath === "string" ? payload.transcriptPath : "";
  const lastText = extractLastModelText(transcriptPath);
  if (lastText === null) {
    respond({ decision: "stop" });
    return;
  }

  const parsed = readMessage(lastText);
  const counterFile = path.join(
    path.dirname(guardFile),
    "stop-retry-count.json",
  );

  if (parsed.problem === null) {
    if (existsSync(counterFile)) {
      writeRetryCount(counterFile, 0);
    }
    respond({ decision: "stop" });
    return;
  }

  const count = readRetryCount(counterFile);
  if (count < MAX_STOP_RETRIES) {
    writeRetryCount(counterFile, count + 1);
    respond({
      decision: "continue",
      reason: repairPrompt(parsed.problem),
    });
    return;
  }

  respond({ decision: "stop" });
}

main().catch(() => {
  respond({ decision: "stop" });
});
