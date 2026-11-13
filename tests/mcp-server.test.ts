/**
 * Stdio MCP Server (`autoloop_hub`) & Subagent Isolation Tests (Layer 2).
 *
 * Prevents:
 * 1. Subagent privilege escalation / self-approval: ensures processes with
 *    `AUTOLOOP_RUN_ID` or `AUTOLOOP_GUARD_FILE` cannot see or invoke any of the
 *    7 owner admin tools (`answer`, `resolve`, `pause`, `resume`, `replay`, `run`, `stop`)
 *    and never read or transmit `owner.token`.
 * 2. Stdio transport framing corruption across newline-delimited JSON-RPC 2.0
 *    and `Content-Length` framed multi-byte UTF-8 payloads.
 * 3. Broken IPC routing or failed local SQLite single-transaction fallback when
 *    Sidecar is offline or `ipc.json` is stale.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { decide } from "../kernel/decide.ts";
import {
  createTokenSigner,
  openStore,
  safeTokenEquals,
} from "../kernel/store.ts";
import type { RulesConfig } from "../protocol/types.ts";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const SERVER_PATH = path.join(REPO_ROOT, "mcp", "server.mjs");
const MCP_CONFIG_PATH = path.join(REPO_ROOT, "mcp_config.json");

const ADMIN_TOOL_NAMES = [
  "autoloop_answer",
  "autoloop_resolve",
  "autoloop_pause",
  "autoloop_resume",
  "autoloop_replay",
  "autoloop_run",
  "autoloop_stop",
] as const;

const SAFE_TOOL_NAMES = [
  "autoloop_status",
  "autoloop_why",
  "autoloop_explain_rules",
  "autoloop_emit",
] as const;

function makeSampleConfig(): RulesConfig {
  return {
    timezone: "Asia/Shanghai",
    askFirst: ["rm -rf", "git push --force"],
    sources: {
      inbox: { name: "Local Inbox" },
      manual: { name: "Manual Trigger" },
    },
    agents: {
      worker: {
        name: "Worker Agent",
        runner: "agy-print",
        model: "gemini-4-hydrogen-high",
        access: "edit",
      },
    },
    rules: [
      {
        name: "triage",
        when: { source: "inbox", types: ["issue.*"] },
        to: "worker",
        cwd: "/tmp/autoloop-mcp-repo",
        group: "triage-grp",
        parallel: 2,
      },
      {
        name: "morning",
        when: { cron: "0 9 * * *" },
        to: "worker",
        cwd: "/tmp/autoloop-mcp-repo",
      },
      {
        name: "inbox-watch",
        when: {
          watch: {
            paths: ["/tmp/autoloop-mcp-repo/.autoloop/inbox"],
            debounceMs: 1200,
            types: ["inbox.file"],
          },
        },
        to: "worker",
        cwd: "/tmp/autoloop-mcp-repo",
      },
    ],
  };
}

class McpTestClient {
  private readonly proc: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    number | string,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();
  private readonly stderrChunks: string[] = [];
  private stdoutBuffer = "";
  private nextId = 1;
  private closed = false;

  constructor(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    cwd = REPO_ROOT,
  ) {
    this.proc = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => {
      this.stdoutBuffer += chunk;
      while (true) {
        const nlIdx = this.stdoutBuffer.indexOf("\n");
        if (nlIdx === -1) {
          break;
        }
        const line = this.stdoutBuffer.slice(0, nlIdx).trim();
        this.stdoutBuffer = this.stdoutBuffer.slice(nlIdx + 1);
        if (line.length === 0) {
          continue;
        }
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch (err) {
          for (const entry of this.pending.values()) {
            entry.reject(
              new Error(`Invalid JSON line from MCP server: ${line}`),
            );
          }
          this.pending.clear();
          return;
        }
        if (msg && msg.id !== undefined && msg.id !== null) {
          const waiter = this.pending.get(msg.id);
          if (waiter) {
            this.pending.delete(msg.id);
            waiter.resolve(msg);
          }
        }
      }
    });

    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk: string) => {
      this.stderrChunks.push(chunk);
    });

    this.proc.on("exit", (code) => {
      this.closed = true;
      for (const entry of this.pending.values()) {
        entry.reject(
          new Error(
            `MCP server exited prematurely (code=${String(code)}). stderr=${this.stderrChunks.join("")}`,
          ),
        );
      }
      this.pending.clear();
    });
  }

  request(method: string, params?: Record<string, unknown>): Promise<any> {
    if (this.closed) {
      return Promise.reject(new Error("MCP server already closed"));
    }
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `MCP request timed out: ${method}. stderr=${this.stderrChunks.join("")}`,
          ),
        );
      }, 8000);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  requestContentLength(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<any> {
    if (this.closed) {
      return Promise.reject(new Error("MCP server already closed"));
    }
    const id = this.nextId++;
    const json = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const byteLen = Buffer.byteLength(json, "utf8");
    const frame = `Content-Type: application/vscode-jsonrpc; charset=utf-8\r\nContent-Length: ${byteLen}\r\n\r\n${json}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP Content-Length request timed out: ${method}`));
      }, 8000);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.proc.stdin.write(frame);
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    if (!this.closed) {
      this.proc.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
      );
    }
  }

  async callTool(name: string, args?: Record<string, unknown>): Promise<any> {
    const resp = await this.request("tools/call", {
      name,
      ...(args !== undefined ? { arguments: args } : {}),
    });
    assert.equal(
      resp.error,
      undefined,
      `Unexpected JSON-RPC error for ${name}: ${JSON.stringify(resp.error)}`,
    );
    return resp.result;
  }

  async close(): Promise<number | null> {
    if (this.closed) {
      return 0;
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.proc.kill("SIGKILL");
      }, 3000);
      this.proc.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      this.proc.stdin.end();
    });
  }
}

function spawnMcpProcess(
  autoloopHome: string,
  extraEnv: Record<string, string | undefined> = {},
): McpTestClient {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AUTOLOOP_HOME: autoloopHome,
  };
  delete env.AUTOLOOP_RUN_ID;
  delete env.AUTOLOOP_GUARD_FILE;
  delete env.PLUGIN_DATA;
  for (const [k, v] of Object.entries(extraEnv)) {
    if (v === undefined) {
      delete env[k];
    } else {
      env[k] = v;
    }
  }
  return new McpTestClient(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", SERVER_PATH],
    env,
  );
}

function parseToolJson(toolResult: any): any {
  assert.ok(Array.isArray(toolResult.content), "toolResult.content missing");
  assert.equal(toolResult.content[0]?.type, "text");
  return JSON.parse(toolResult.content[0].text);
}

async function withTempHome(
  fn: (homeDir: string) => Promise<void>,
): Promise<void> {
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "autoloop-mcp-test-"));
  try {
    await fn(homeDir);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
}

describe("mcp_config.json & Stdio MCP protocol", () => {
  it("validates mcp_config.json and launches autoloop_hub via PLUGIN_ROOT", async () => {
    const raw = JSON.parse(readFileSync(MCP_CONFIG_PATH, "utf8"));
    const hub = raw.mcpServers?.autoloop_hub;
    assert.ok(hub, "mcpServers.autoloop_hub must be registered");
    assert.equal(hub.command, "sh");
    assert.equal(hub.args[0], "-c");
    assert.match(
      hub.args[1],
      /\$\{PLUGIN_ROOT:-\.\}\/mcp\/server\.mjs/,
      "args must invoke ${PLUGIN_ROOT:-.}/mcp/server.mjs",
    );

    await withTempHome(async (homeDir) => {
      const client = new McpTestClient(
        hub.command,
        hub.args,
        {
          ...process.env,
          PLUGIN_ROOT: REPO_ROOT,
          AUTOLOOP_HOME: homeDir,
        },
        os.tmpdir(), // Ensure it works regardless of cwd when PLUGIN_ROOT is set
      );
      try {
        const initRes = await client.request("initialize", {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test-host", version: "0.1.0" },
        });
        assert.equal(initRes.result.protocolVersion, "2025-03-26");
        assert.deepEqual(initRes.result.capabilities, { tools: {} });
        assert.deepEqual(initRes.result.serverInfo, {
          name: "autoloop_hub",
          version: "1.0.0",
        });

        // Notification must not produce a response; ping immediately verifies stream sync.
        client.notify("notifications/initialized");
        const pingRes = await client.request("ping");
        assert.deepEqual(pingRes.result, {});
      } finally {
        const exitCode = await client.close();
        assert.equal(exitCode, 0);
      }
    });
  });

  it("supports Content-Length framing with multi-byte UTF-8 and JSON-RPC error codes", async () => {
    await withTempHome(async (homeDir) => {
      writeFileSync(
        path.join(homeDir, "rules.json"),
        JSON.stringify(makeSampleConfig(), null, 2),
      );

      const client = spawnMcpProcess(homeDir);
      try {
        const initRes = await client.requestContentLength("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
        });
        assert.equal(initRes.result.protocolVersion, "2024-11-05");

        // Multi-byte UTF-8 Chinese payload inside Content-Length frame
        const emitRes = await client.requestContentLength("tools/call", {
          name: "autoloop_emit",
          arguments: {
            source: "inbox",
            dryRun: true,
            event: {
              id: "utf8-check-1",
              type: "issue.opened",
              subject: "issue#42",
              summary: "中文测试摘要：校验字节长度帧解析",
            },
          },
        });
        assert.notEqual(emitRes.result.isError, true);
        const parsed = parseToolJson(emitRes.result);
        assert.equal(parsed.dryRun, true);
        assert.deepEqual(parsed.routed, ["triage"]);

        const unknownMethod = await client.request("unknown/method");
        assert.equal(unknownMethod.error.code, -32601);
      } finally {
        await client.close();
      }
    });
  });
});

describe("Main session tools & local SQLite fallback", () => {
  it("lists all 11 tools with accurate annotations and executes full fallback workflow", async () => {
    await withTempHome(async (homeDir) => {
      writeFileSync(
        path.join(homeDir, "rules.json"),
        JSON.stringify(makeSampleConfig(), null, 2),
      );

      const client = spawnMcpProcess(homeDir);
      try {
        await client.request("initialize", { protocolVersion: "2025-03-26" });

        // 1. tools/list returns all 11 tools with exact metadata
        const listRes = await client.request("tools/list");
        const tools = listRes.result.tools as Array<any>;
        assert.equal(tools.length, 11);

        const byName = new Map(tools.map((t) => [t.name, t]));
        for (const name of [...SAFE_TOOL_NAMES, ...ADMIN_TOOL_NAMES]) {
          assert.ok(byName.has(name), `Missing tool ${name}`);
          assert.equal(typeof byName.get(name).inputSchema, "object");
          assert.equal(
            typeof byName.get(name).annotations?.readOnlyHint,
            "boolean",
          );
          assert.equal(
            typeof byName.get(name).annotations?.destructiveHint,
            "boolean",
          );
        }
        assert.equal(
          byName.get("autoloop_status").annotations.readOnlyHint,
          true,
        );
        assert.equal(byName.get("autoloop_why").annotations.readOnlyHint, true);
        assert.equal(
          byName.get("autoloop_explain_rules").annotations.readOnlyHint,
          true,
        );
        assert.equal(
          byName.get("autoloop_stop").annotations.destructiveHint,
          true,
        );

        // 2. Initial status before hub.db exists gives fallback hint & clickable workbench link
        const status0 = await client.callTool("autoloop_status");
        assert.notEqual(status0.isError, true);
        const status0Json = parseToolJson(status0);
        assert.equal(status0Json.mode, "local-fallback");
        assert.match(
          status0Json.hint,
          /\[Autoloop 工作台\]\(sidecar:\/\/autoloop\/hub\/\)/,
        );
        assert.deepEqual(status0Json.cards, []);

        // 3. explain_rules validates rules.json and rejects invalid drafts
        const explainOk = await client.callTool("autoloop_explain_rules", {
          nowMs: Date.UTC(2026, 10, 14, 0, 0, 0),
        });
        assert.notEqual(explainOk.isError, true);
        const explainJson = parseToolJson(explainOk);
        assert.equal(explainJson.valid, true);
        assert.equal(explainJson.rules.length, 3);
        assert.equal(explainJson.rules[1].trigger.kind, "cron");
        assert.ok(explainJson.rules[1].trigger.nextRunAt);
        assert.deepEqual(explainJson.rules[2].trigger, {
          kind: "watch",
          paths: ["/tmp/autoloop-mcp-repo/.autoloop/inbox"],
          debounceMs: 1200,
          types: ["inbox.file"],
        });

        const explainBad = await client.callTool("autoloop_explain_rules", {
          config: { askFirst: [], sources: {}, agents: {}, rules: "invalid" },
        });
        assert.equal(explainBad.isError, true);

        // 4. emit (dryRun vs real)
        const dryEmit = await client.callTool("autoloop_emit", {
          source: "inbox",
          dryRun: true,
          event: { id: "ev-dry", type: "issue.opened", subject: "issue#10" },
        });
        assert.deepEqual(parseToolJson(dryEmit).routed, ["triage"]);

        const realEmit = await client.callTool("autoloop_emit", {
          source: "inbox",
          event: {
            id: "ev-1",
            type: "issue.opened",
            subject: "issue#11",
            summary: "Fix crash on startup",
          },
        });
        const emitJson = parseToolJson(realEmit);
        assert.equal(emitJson.mode, "local-fallback");
        assert.match(
          emitJson.hint,
          /\[Autoloop 工作台\]\(sidecar:\/\/autoloop\/hub\/\)/,
        );
        assert.deepEqual(emitJson.routed, ["triage"]);
        assert.equal(emitJson.runs.length, 1);
        const firstRunId = emitJson.runs[0];

        // 5. Simulate worker claiming and submitting an ask card + notice card into hub.db
        const dbPath = path.join(homeDir, "hub.db");
        const store = openStore(dbPath);
        try {
          const signer = createTokenSigner("a".repeat(64));
          const env = { signToken: signer, safeTokenEquals };
          const nowMs = Date.now();

          const claimRes = decide(
            store.view,
            { type: "claimWork", claimId: "test-worker", capacity: 4 },
            nowMs,
            env,
          );
          store.commit(claimRes.facts);
          const job = claimRes.value.jobs[0];
          assert.equal(job.run, firstRunId);

          const startRes = decide(
            store.view,
            {
              type: "markStarted",
              run: job.run,
              token: job.token,
              session: "conv-session-1",
            },
            nowMs + 10,
            env,
          );
          store.commit(startRes.facts);

          const submitRes = decide(
            store.view,
            {
              type: "submitResult",
              run: job.run,
              token: job.token,
              result: {
                outcome: "done",
                summary: "Need decision",
                session: "conv-session-1",
                ask: [
                  {
                    key: "confirm-fix",
                    title: "Choose fix strategy",
                    text: "Should we patch A or B?",
                    options: ["Patch A (Recommended)", "Patch B"],
                    recommend: 0,
                    about: "issue#11",
                  },
                ],
                notice: [
                  {
                    key: "info-note",
                    title: "Diagnosis complete",
                    text: "Root cause isolated",
                  },
                ],
              },
            },
            nowMs + 20,
            env,
          );
          store.commit(submitRes.facts);
        } finally {
          store.close();
        }

        // 6. status + why see the cards and run details
        const status1 = parseToolJson(await client.callTool("autoloop_status"));
        assert.equal(status1.cards.length, 2);
        const askCard = status1.cards.find((c: any) => c.kind === "ask");
        const noticeCard = status1.cards.find((c: any) => c.kind === "notice");
        assert.ok(askCard && noticeCard);

        const whyRes = parseToolJson(
          await client.callTool("autoloop_why", { run: firstRunId }),
        );
        assert.equal(whyRes.run.run, firstRunId);
        assert.equal(whyRes.run.status, "done");
        assert.equal(whyRes.cardsCreated.length, 2);

        // 7. answer + resolve
        const ansRes = parseToolJson(
          await client.callTool("autoloop_answer", {
            card: askCard.card,
            choice: 0,
          }),
        );
        assert.equal(ansRes.card.status, "decided");
        assert.equal(ansRes.card.choice, 0);
        assert.equal(typeof ansRes.run, "number");

        const resolveRes = parseToolJson(
          await client.callTool("autoloop_resolve", {
            card: noticeCard.card,
            reason: "Reviewed by owner",
          }),
        );
        assert.equal(resolveRes.card.status, "closed");

        // 8. pause -> emit (skipped) -> resume -> replay
        const pauseRes = parseToolJson(
          await client.callTool("autoloop_pause", {
            rule: "triage",
            reason: "Maintenance",
          }),
        );
        assert.equal(pauseRes.rule, "triage");

        const skippedEmit = parseToolJson(
          await client.callTool("autoloop_emit", {
            source: "inbox",
            event: {
              id: "ev-while-paused",
              type: "issue.opened",
              subject: "issue#99",
            },
          }),
        );
        assert.deepEqual(skippedEmit.paused, ["triage"]);
        assert.deepEqual(skippedEmit.runs, []);

        const resumeRes = parseToolJson(
          await client.callTool("autoloop_resume", { rule: "triage" }),
        );
        assert.equal(resumeRes.wasPaused, true);
        assert.equal(resumeRes.skipped.length, 1);

        const replayRes = parseToolJson(
          await client.callTool("autoloop_replay", { rule: "triage" }),
        );
        assert.equal(replayRes.replayedCount, 1);
        assert.equal(replayRes.runs.length, 1);

        // 9. manual run -> stop
        const runRes = parseToolJson(
          await client.callTool("autoloop_run", {
            rule: "morning",
          }),
        );
        assert.equal(typeof runRes.run, "number");

        const stopRes = parseToolJson(
          await client.callTool("autoloop_stop", { run: runRes.run }),
        );
        assert.equal(stopRes.changed, true);
        assert.equal(stopRes.run.status, "cancelled");
      } finally {
        await client.close();
      }
    });
  });
});

describe("IPC routing & Subagent self-approval hard isolation (Security Critical)", () => {
  it("routes owner session via owner.token to /ipc/* and rejects subagent admin calls while restricting to ingest.token", async () => {
    await withTempHome(async (homeDir) => {
      const ownerToken = "11".repeat(32);
      const ingestToken = "22".repeat(32);
      writeFileSync(path.join(homeDir, "owner.token"), ownerToken, {
        mode: 0o600,
      });
      writeFileSync(path.join(homeDir, "ingest.token"), ingestToken, {
        mode: 0o600,
      });
      chmodSync(path.join(homeDir, "owner.token"), 0o600);
      chmodSync(path.join(homeDir, "ingest.token"), 0o600);

      const seenRequests: Array<{
        method: string;
        url: string;
        auth: string | undefined;
        body: unknown;
      }> = [];

      const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          const rawBody = Buffer.concat(chunks).toString("utf8");
          const body = rawBody.length > 0 ? JSON.parse(rawBody) : null;
          const auth = req.headers.authorization;
          seenRequests.push({
            method: req.method ?? "",
            url: req.url ?? "",
            auth,
            body,
          });

          const token = auth?.startsWith("Bearer ")
            ? auth.slice("Bearer ".length)
            : "";

          if (
            req.url?.startsWith("/ipc/cards/") ||
            req.url?.startsWith("/ipc/rules/") ||
            req.url?.startsWith("/ipc/runs/")
          ) {
            if (token !== ownerToken) {
              res.writeHead(403, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  error: { code: "FORBIDDEN", message: "owner.token required" },
                }),
              );
              return;
            }
          } else if (token !== ownerToken && token !== ingestToken) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "unauthorized" }));
            return;
          }

          if (req.url === "/ipc/runs/stop" && body?.run === 999) {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: { code: "CONFLICT", message: "run 999 conflict" },
              }),
            );
            return;
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: true,
              echoedRoute: req.url,
              cards: [],
              recentCards: [],
              lines: [],
              runs: [],
              timers: [],
              pauses: [],
              skipped: [],
              spending: {
                today: { runs: 0, input: 0, output: 0, cached: 0, cost: 0 },
                last7Days: { runs: 0, input: 0, output: 0, cached: 0, cost: 0 },
              },
            }),
          );
        });
      });

      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const address = server.address();
      assert.ok(address && typeof address === "object");

      writeFileSync(
        path.join(homeDir, "ipc.json"),
        JSON.stringify({
          host: "127.0.0.1",
          port: address.port,
          pid: process.pid,
          startedAt: new Date().toISOString(),
        }),
        { mode: 0o600 },
      );

      try {
        // Part A: Main owner session uses owner.token for IPC calls
        const ownerClient = spawnMcpProcess(homeDir);
        try {
          await ownerClient.request("initialize", {
            protocolVersion: "2025-03-26",
          });

          const statusRes = parseToolJson(
            await ownerClient.callTool("autoloop_status", {
              beforeRun: 10,
              limit: 5,
            }),
          );
          assert.equal(statusRes.mode, "ipc");
          assert.equal(statusRes.echoedRoute, "/ipc/state?before=10&limit=5");

          const emitRes = parseToolJson(
            await ownerClient.callTool("autoloop_emit", {
              source: "manual",
              event: { id: "ipc-ev-1", type: "manual.ping" },
              dryRun: true,
            }),
          );
          assert.equal(emitRes.mode, "ipc");

          const ansRes = parseToolJson(
            await ownerClient.callTool("autoloop_answer", {
              card: 3,
              choice: 1,
            }),
          );
          assert.equal(ansRes.mode, "ipc");
          assert.equal(ansRes.echoedRoute, "/ipc/cards/answer");

          const conflictRes = await ownerClient.callTool("autoloop_stop", {
            run: 999,
          });
          assert.equal(conflictRes.isError, true);
          assert.equal(parseToolJson(conflictRes).code, "CONFLICT");
        } finally {
          await ownerClient.close();
        }

        assert.ok(
          seenRequests.every((r) => r.auth === `Bearer ${ownerToken}`),
          "Owner session must authenticate with owner.token",
        );

        // Part B: Subagent session with AUTOLOOP_RUN_ID="42"
        seenRequests.length = 0;
        const subagentClient = spawnMcpProcess(homeDir, {
          AUTOLOOP_RUN_ID: "42",
        });
        try {
          await subagentClient.request("initialize", {
            protocolVersion: "2025-03-26",
          });

          // 1. tools/list hides all 7 admin tools
          const listRes = await subagentClient.request("tools/list");
          const toolNames: string[] = (listRes.result.tools as Array<any>).map(
            (t) => String(t.name),
          );
          for (const forbidden of ADMIN_TOOL_NAMES) {
            assert.equal(
              toolNames.includes(forbidden),
              false,
              `Subagent tools/list leaked ${forbidden}`,
            );
          }
          assert.deepEqual(toolNames, [...SAFE_TOOL_NAMES]);

          // 2. Hard rejection on direct tools/call for all 7 admin tools
          const adminPayloads: Record<(typeof ADMIN_TOOL_NAMES)[number], any> =
            {
              autoloop_answer: { card: 1, choice: 0 },
              autoloop_resolve: { card: 1, reason: "self approve" },
              autoloop_pause: { rule: "triage" },
              autoloop_resume: { rule: "triage" },
              autoloop_replay: { rule: "triage" },
              autoloop_run: { rule: "triage" },
              autoloop_stop: { run: 42 },
            };

          for (const adminTool of ADMIN_TOOL_NAMES) {
            const callRes = await subagentClient.callTool(
              adminTool,
              adminPayloads[adminTool],
            );
            assert.equal(
              callRes.isError,
              true,
              `${adminTool} must return isError=true for subagent`,
            );
            const errJson = parseToolJson(callRes);
            assert.equal(errJson.code, "FORBIDDEN_SUBAGENT_ADMIN");
          }

          // Zero IPC requests may be sent for blocked admin calls
          assert.equal(seenRequests.length, 0);

          // 3. Allowed tools use ingest.token ONLY (never owner.token)
          const subStatus = parseToolJson(
            await subagentClient.callTool("autoloop_status"),
          );
          assert.equal(subStatus.mode, "ipc");

          const subEmit = parseToolJson(
            await subagentClient.callTool("autoloop_emit", {
              source: "manual",
              event: { id: "sub-ev-1", type: "subagent.done" },
            }),
          );
          assert.equal(subEmit.mode, "ipc");
        } finally {
          await subagentClient.close();
        }

        assert.equal(seenRequests.length, 2);
        for (const req of seenRequests) {
          assert.equal(
            req.auth,
            `Bearer ${ingestToken}`,
            "Subagent MUST only send ingest.token, never owner.token",
          );
        }

        // Part C: Subagent context detection via AUTOLOOP_GUARD_FILE alone
        const guardOnlyClient = spawnMcpProcess(homeDir, {
          AUTOLOOP_GUARD_FILE: path.join(homeDir, "runs", "42-1", "guard.json"),
        });
        try {
          await guardOnlyClient.request("initialize", {
            protocolVersion: "2025-03-26",
          });
          const listRes = await guardOnlyClient.request("tools/list");
          assert.deepEqual(
            (listRes.result.tools as Array<any>).map((t) => t.name),
            [...SAFE_TOOL_NAMES],
          );
          const stopDeny = await guardOnlyClient.callTool("autoloop_stop", {
            run: 1,
          });
          assert.equal(stopDeny.isError, true);
        } finally {
          await guardOnlyClient.close();
        }
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }

      // Part D: Stale ipc.json (connection refused) seamlessly falls back to local SQLite
      const staleClient = spawnMcpProcess(homeDir);
      try {
        await staleClient.request("initialize", {
          protocolVersion: "2025-03-26",
        });
        const fallbackStatus = parseToolJson(
          await staleClient.callTool("autoloop_status"),
        );
        assert.equal(fallbackStatus.mode, "local-fallback");
        assert.match(
          fallbackStatus.hint,
          /\[Autoloop 工作台\]\(sidecar:\/\/autoloop\/hub\/\)/,
        );
      } finally {
        await staleClient.close();
      }
    });
  });
});
