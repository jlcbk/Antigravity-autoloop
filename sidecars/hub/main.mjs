/**
 * Autoloop Hub Sidecar entrypoint & testable host assembler.
 * Supports dual runtime modes:
 * 1. Antigravity Sidecar Host mode (when ANTIGRAVITY_SIDECAR_WEB_PORT,
 *    ANTIGRAVITY_LS_ADDRESS, and ANTIGRAVITY_CSRF_TOKEN are present -> dynamic `sidecar_sdk`).
 * 2. Standalone testable local Web mode (lightweight `SidecarApp` / `Response` compat layer).
 */

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InputError, KernelError } from "../../kernel/errors.ts";
import { ProtocolInputError } from "../../protocol/validate.ts";
import { createDeliveryRunner } from "../../delivery/pipeline.ts";
import { createFileWatcher } from "./file-watcher.ts";
import {
  HubRuntime,
  resolveAutoloopHome,
  startIpcServer,
} from "./ipc-server.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, "web");

class StandaloneResponse {
  constructor(
    body,
    { contentType = "text/plain", status = 200, headers } = {},
  ) {
    this.body = body;
    this.contentType = contentType;
    this.status = status;
    this.headers = headers;
  }
}

class StandaloneSidecarApp {
  #token;
  #port;
  #server = null;
  #pages = new Map();
  #apis = new Map();

  constructor({ port = 0, token = "" } = {}) {
    this.#port = port;
    this.#token = token;
  }

  page(routePath, handler) {
    this.#pages.set(routePath, handler);
  }

  api(routePath, handler, method = "POST") {
    if (!this.#apis.has(routePath)) {
      this.#apis.set(routePath, new Map());
    }
    this.#apis.get(routePath).set(method.toUpperCase(), handler);
  }

  run() {
    this.#pages.set(
      "/preload.js",
      () =>
        new StandaloneResponse("// standalone sidecar preload\n", {
          contentType: "application/javascript; charset=utf-8",
        }),
    );

    const server = createServer(async (req, res) => {
      const portHint = this.#port || 80;
      const url = new URL(req.url || "/", `http://127.0.0.1:${portHint}`);

      if (req.method !== "GET" && !this.#validateToken(req, url)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }

      if (req.method === "GET" && this.#pages.has(url.pathname)) {
        try {
          const content = await this.#pages.get(url.pathname)();
          if (
            content instanceof StandaloneResponse ||
            (content &&
              typeof content === "object" &&
              content.contentType &&
              content.body !== undefined)
          ) {
            res.writeHead(content.status || 200, {
              "Content-Type": content.contentType,
              ...content.headers,
            });
            res.end(content.body);
            return;
          }
          const isJS = url.pathname.endsWith(".js");
          res.writeHead(200, {
            "Content-Type": isJS
              ? "application/javascript; charset=utf-8"
              : "text/html; charset=utf-8",
          });
          res.end(content);
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
        return;
      }

      if (this.#apis.has(url.pathname)) {
        const methodMap = this.#apis.get(url.pathname);
        const method = (req.method || "GET").toUpperCase();
        if (methodMap.has(method)) {
          const handler = methodMap.get(method);
          let body = "";
          req.on("data", (chunk) => {
            body += chunk;
          });
          req.on("end", async () => {
            try {
              const data = {};
              if (method === "GET" || url.searchParams.size > 0) {
                for (const [key, value] of url.searchParams.entries()) {
                  if (key.toLowerCase() !== "token") {
                    data[key] = value;
                  }
                }
              }
              if (body.trim().length > 0) {
                let parsed;
                try {
                  parsed = JSON.parse(body);
                } catch {
                  res.writeHead(400, { "Content-Type": "application/json" });
                  res.end(
                    JSON.stringify({
                      error: "请求体不是合法的 JSON",
                      code: "INPUT_ERROR",
                    }),
                  );
                  return;
                }
                if (
                  typeof parsed !== "object" ||
                  parsed === null ||
                  Array.isArray(parsed)
                ) {
                  res.writeHead(400, { "Content-Type": "application/json" });
                  res.end(
                    JSON.stringify({
                      error: "请求体必须是 JSON 对象",
                      code: "INPUT_ERROR",
                    }),
                  );
                  return;
                }
                Object.assign(data, parsed);
              }

              const result = await handler(data);
              if (
                result instanceof StandaloneResponse ||
                (result &&
                  typeof result === "object" &&
                  result.contentType &&
                  result.body !== undefined)
              ) {
                const status = result.status || 200;
                const respBody =
                  typeof result.body === "string"
                    ? result.body
                    : Buffer.from(result.body);
                res.writeHead(status, {
                  "Content-Type": result.contentType,
                  ...result.headers,
                });
                res.end(respBody);
                return;
              }
              res.writeHead(200, {
                "Content-Type": "application/json; charset=utf-8",
              });
              res.end(JSON.stringify(result));
            } catch (err) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  error: err instanceof Error ? err.message : String(err),
                }),
              );
            }
          });
          return;
        }
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Method Not Allowed" }));
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });

    return new Promise((resolve, reject) => {
      const onError = (err) => {
        server.off("listening", onListen);
        reject(err);
      };
      const onListen = () => {
        server.off("error", onError);
        this.#server = server;
        resolve(server);
      };
      server.once("error", onError);
      server.once("listening", onListen);
      server.listen(this.#port, "127.0.0.1");
    });
  }

  close() {
    return new Promise((resolve) => {
      if (this.#server) {
        this.#server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  #validateToken(req, url) {
    if (url.pathname === "/preload.js") return true;
    if (!this.#token) return true;
    const provided =
      req.headers["x-sidecar-token"] || url.searchParams.get("token");
    return provided === this.#token;
  }
}

function isSidecarHostEnv(env) {
  return Boolean(
    env.ANTIGRAVITY_SIDECAR_WEB_PORT &&
    env.ANTIGRAVITY_LS_ADDRESS &&
    env.ANTIGRAVITY_CSRF_TOKEN,
  );
}

function parseOptionalPositiveIntParam(raw, label) {
  if (raw === undefined || raw === null || raw === "") {
    return undefined;
  }
  if (typeof raw === "number") {
    if (!Number.isSafeInteger(raw) || raw <= 0) {
      throw new InputError(`${label} 必须是正整数`);
    }
    return raw;
  }
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw new InputError(`${label} 必须是正整数`);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new InputError(`${label} 必须是正安全整数`);
  }
  return n;
}

function wrapApiHandler(ResponseCtor, handler) {
  return async (data) => {
    try {
      return await handler(data ?? {});
    } catch (err) {
      if (err instanceof KernelError) {
        return new ResponseCtor(
          JSON.stringify({ error: err.message, code: err.code }),
          {
            status: err.statusCode,
            contentType: "application/json; charset=utf-8",
          },
        );
      }
      if (err instanceof ProtocolInputError) {
        return new ResponseCtor(
          JSON.stringify({ error: err.message, code: err.code }),
          {
            status: 400,
            contentType: "application/json; charset=utf-8",
          },
        );
      }
      throw err;
    }
  };
}

/**
 * Starts the Autoloop Hub host (Web UI server + Local IPC server + Runtime + Supervisor + FileWatcher).
 */
export async function startHubHost(options = {}) {
  const env = options.env ?? process.env;
  const autoloopHome = options.autoloopHome ?? resolveAutoloopHome(env);
  const useSidecarSdk = options.standalone !== true && isSidecarHostEnv(env);

  let SidecarAppCtor = StandaloneSidecarApp;
  let ResponseCtor = StandaloneResponse;
  if (useSidecarSdk) {
    const sdk = await import("sidecar_sdk");
    SidecarAppCtor = sdk.SidecarApp;
    ResponseCtor = sdk.Response;
  }

  const app = useSidecarSdk
    ? new SidecarAppCtor()
    : new StandaloneSidecarApp({
        port: options.webPort ?? 0,
        token: options.uiToken ?? env.ANTIGRAVITY_SIDECAR_UI_TOKEN ?? "",
      });

  const runtime = new HubRuntime({
    autoloopHome,
    env,
    now: options.now,
    enableSupervisor: options.enableSupervisor,
    capacity: options.capacity,
    pollIntervalMs: options.pollIntervalMs,
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    killGraceMs: options.killGraceMs,
    postResultGraceMs: options.postResultGraceMs,
    agyBin: options.agyBin,
    agentApiBin: options.agentApiBin,
    codexBin: options.codexBin,
    claudeBin: options.claudeBin,
    herdrBin: options.herdrBin,
    appDataDir: options.appDataDir,
    baseEnv: options.baseEnv,
    deliveryRunner:
      options.deliveryRunner ??
      createDeliveryRunner({
        agyBin: options.agyBin,
        codexBin: options.codexBin,
        claudeBin: options.claudeBin,
        herdrBin: options.herdrBin,
        postResultGraceMs: options.postResultGraceMs,
      }),
    notifier: options.notifier,
    notifierOptions: {
      silent: options.silentNotify,
      platform: options.notifyPlatform,
      execFileFn: options.execFileFn,
      ...options.notifierOptions,
    },
    onError: options.onError,
  });

  const enableWatcher = options.enableWatcher ?? true;
  const watcher = enableWatcher
    ? createFileWatcher({
        runtime,
        rulesFilePath: options.rulesFilePath,
        rulesDebounceMs: options.rulesDebounceMs,
        defaultWatchDebounceMs: options.defaultWatchDebounceMs,
        now: options.now,
        onWarning: options.onWarning,
      })
    : null;

  const indexHtmlPath = path.join(WEB_DIR, "index.html");
  const stylesCssPath = path.join(WEB_DIR, "styles.css");
  const appJsPath = path.join(WEB_DIR, "app.js");

  app.page("/", () => {
    const html = readFileSync(indexHtmlPath, "utf8");
    return new ResponseCtor(html, {
      status: 200,
      contentType: "text/html; charset=utf-8",
    });
  });

  app.page("/styles.css", () => {
    const css = readFileSync(stylesCssPath, "utf8");
    return new ResponseCtor(css, {
      status: 200,
      contentType: "text/css; charset=utf-8",
    });
  });

  app.page("/app.js", () => {
    const js = readFileSync(appJsPath, "utf8");
    return new ResponseCtor(js, {
      status: 200,
      contentType: "application/javascript; charset=utf-8",
    });
  });

  app.api(
    "/api/state",
    wrapApiHandler(ResponseCtor, (data) => {
      const beforeRun = parseOptionalPositiveIntParam(data.before, "before");
      const limit = parseOptionalPositiveIntParam(data.limit, "limit");
      const snapshot = runtime.getState({ beforeRun, limit });
      const clientEtag = typeof data.etag === "string" ? data.etag : "";
      if (clientEtag && clientEtag === snapshot.etag) {
        return new ResponseCtor("", {
          status: 304,
          contentType: "application/json; charset=utf-8",
          headers: { ETag: snapshot.etag },
        });
      }
      return new ResponseCtor(JSON.stringify(snapshot), {
        status: 200,
        contentType: "application/json; charset=utf-8",
        headers: { ETag: snapshot.etag },
      });
    }),
    "GET",
  );

  app.api(
    "/api/why",
    wrapApiHandler(ResponseCtor, (data) => {
      const runId = parseOptionalPositiveIntParam(data.run, "run");
      if (runId === undefined) {
        throw new InputError("缺少查询参数 run");
      }
      return runtime.getWhy(runId);
    }),
    "GET",
  );

  app.api(
    "/api/cards/answer",
    wrapApiHandler(ResponseCtor, (data) =>
      runtime.answerCard({
        card: data.card,
        choice: data.choice,
        text: data.text,
      }),
    ),
    "POST",
  );

  app.api(
    "/api/cards/resolve",
    wrapApiHandler(ResponseCtor, (data) =>
      runtime.resolveCard({
        card: data.card,
        reason: data.reason,
      }),
    ),
    "POST",
  );

  app.api(
    "/api/runs/stop",
    wrapApiHandler(ResponseCtor, (data) => runtime.stopRun(data.run)),
    "POST",
  );

  app.api(
    "/api/rules/pause",
    wrapApiHandler(ResponseCtor, (data) =>
      runtime.pauseRule({
        rule: data.rule,
        reason: data.reason,
        until: data.until,
      }),
    ),
    "POST",
  );

  app.api(
    "/api/rules/resume",
    wrapApiHandler(ResponseCtor, (data) => runtime.resumeRule(data.rule)),
    "POST",
  );

  app.api(
    "/api/rules/replay",
    wrapApiHandler(ResponseCtor, (data) =>
      runtime.replayRule({
        rule: data.rule,
        since: data.since,
      }),
    ),
    "POST",
  );

  app.api(
    "/api/rules/run",
    wrapApiHandler(ResponseCtor, (data) =>
      runtime.runRule({
        rule: data.rule,
        subject: data.subject,
      }),
    ),
    "POST",
  );

  let ipcServer = null;
  let webServer = null;

  try {
    watcher?.start();
    runtime.start();

    ipcServer = await startIpcServer({
      runtime,
      autoloopHome: runtime.autoloopHome,
      port: options.ipcPort ?? 0,
      rulesFilePath: options.rulesFilePath,
      onError: options.onError,
    });

    webServer = await app.run();
    const webAddr = webServer.address();
    const webPort = webAddr && typeof webAddr === "object" ? webAddr.port : 0;

    let closed = false;
    return {
      host: "127.0.0.1",
      webPort,
      webUrl: `http://127.0.0.1:${webPort}`,
      ipcHost: ipcServer.host,
      ipcPort: ipcServer.port,
      ipcUrl: ipcServer.url,
      ipcFilePath: ipcServer.ipcFilePath,
      autoloopHome: runtime.autoloopHome,
      tokens: runtime.tokens,
      runtime,
      ipcServer,
      watcher,
      notifier: runtime.notifier,
      async close() {
        if (closed) {
          return;
        }
        closed = true;
        watcher?.close();
        await app.close();
        await ipcServer?.close();
        await runtime.close();
      },
    };
  } catch (err) {
    watcher?.close();
    if (webServer) {
      await app.close().catch(() => {});
    }
    if (ipcServer) {
      await ipcServer.close().catch(() => {});
    }
    await runtime.close().catch(() => {});
    throw err;
  }
}

const isEntrypoint =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  let hostHandle = null;
  let shuttingDown = false;

  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    try {
      await hostHandle?.close();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });

  startHubHost().then(
    (handle) => {
      hostHandle = handle;
    },
    (err) => {
      console.error("[autoloop-hub] 启动失败:", err);
      process.exit(1);
    },
  );
}
