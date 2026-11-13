/**
 * Architecture Purity Gate (Layer 1 Static Guard).
 *
 * Prevents architectural boundary regressions across `protocol/` and `kernel/`:
 * 1. `protocol/` must have zero external or `node:*` imports, zero non-deterministic
 *    clock/RNG/env/network calls, and zero `sidecar_sdk`/`feishu` host leakage.
 * 2. `kernel/` (except `kernel/store.ts`) must have zero external or `node:*` imports.
 *    `kernel/store.ts` may import only `node:sqlite` and pure synchronous `node:crypto`
 *    hash/HMAC primitives (no `randomUUID` / `randomBytes`).
 * 3. `kernel/` must have zero `Date.now`, parameterless `new Date()`, `Math.random`,
 *    `randomUUID`, `randomBytes`, `process.env`, or `fetch(`.
 * 4. `kernel/` must contain zero concrete runtime/host/model names
 *    (`agy`, `agentapi`, `sidecar_sdk`, `hydrogen`, `carbon`, `claude`, `feishu`).
 * 5. `package.json` must contain zero runtime `dependencies`.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

export interface PurityViolation {
  file: string;
  rule: string;
  detail: string;
}

export interface SourceEntry {
  path: string;
  content: string;
}

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const KERNEL_FORBIDDEN_HOSTS_RE =
  /\b(agy|agentapi|sidecar_sdk|hydrogen|carbon|claude|feishu)\b/i;

const PROTOCOL_FORBIDDEN_HOSTS_RE = /\b(sidecar_sdk|feishu)\b/i;

const FORBIDDEN_CRYPTO_PRIMITIVES_RE =
  /\b(randomUUID|randomBytes|randomInt|randomFillSync|randomFill|generateKeyPairSync|generateKeyPair)\b/;

const FORBIDDEN_RUNTIME_APIS: Array<{ rule: string; pattern: RegExp }> = [
  { rule: "forbidden-clock-date-now", pattern: /\bDate\s*\.\s*now\b/ },
  { rule: "forbidden-clock-new-date", pattern: /\bnew\s+Date\s*\(\s*\)/ },
  { rule: "forbidden-rng-math-random", pattern: /\bMath\s*\.\s*random\b/ },
  { rule: "forbidden-rng-random-uuid", pattern: /\brandomUUID\b/ },
  { rule: "forbidden-rng-random-bytes", pattern: /\brandomBytes\b/ },
  { rule: "forbidden-env-access", pattern: /\bprocess\s*\.\s*env\b/ },
  { rule: "forbidden-network-fetch", pattern: /\bfetch\s*\(/ },
];

const REGEX_PREFIX_CHARS = new Set([
  "=",
  "(",
  "[",
  ",",
  ":",
  ";",
  "!",
  "&",
  "|",
  "?",
  "{",
  "}",
  "~",
  "^",
  "+",
  "-",
  "*",
  "%",
  "<",
  ">",
]);

const REGEX_PREFIX_KEYWORDS = new Set([
  "return",
  "throw",
  "case",
  "delete",
  "void",
  "typeof",
  "await",
  "yield",
  "in",
  "of",
  "else",
]);

function isWordChar(ch: string): boolean {
  return (
    (ch >= "a" && ch <= "z") ||
    (ch >= "A" && ch <= "Z") ||
    (ch >= "0" && ch <= "9") ||
    ch === "_" ||
    ch === "$"
  );
}

/**
 * Strips `//` and `/* ... * /` comments while preserving string literals,
 * template literals, and regex literals so URLs or regex patterns are not mangled.
 */
export function stripComments(source: string): string {
  const out: string[] = [];
  const len = source.length;
  let i = 0;
  let prevNonSpace = "";
  let prevWord = "";

  while (i < len) {
    const ch = source[i]!;
    const next = i + 1 < len ? source[i + 1]! : "";

    // Single-line comment
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < len && source[i] !== "\n") {
        i += 1;
      }
      continue;
    }

    // Block comment (preserve newlines for readability)
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < len && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") {
          out.push("\n");
        }
        i += 1;
      }
      i += 2;
      continue;
    }

    // String literals (' or ")
    if (ch === "'" || ch === '"') {
      const quote = ch;
      out.push(ch);
      i += 1;
      while (i < len) {
        const c = source[i]!;
        out.push(c);
        if (c === "\\" && i + 1 < len) {
          out.push(source[i + 1]!);
          i += 2;
          continue;
        }
        i += 1;
        if (c === quote) {
          break;
        }
      }
      prevNonSpace = quote;
      prevWord = "";
      continue;
    }

    // Template literal
    if (ch === "`") {
      out.push(ch);
      i += 1;
      while (i < len) {
        const c = source[i]!;
        out.push(c);
        if (c === "\\" && i + 1 < len) {
          out.push(source[i + 1]!);
          i += 2;
          continue;
        }
        i += 1;
        if (c === "`") {
          break;
        }
      }
      prevNonSpace = "`";
      prevWord = "";
      continue;
    }

    // Regex literal heuristic
    if (
      ch === "/" &&
      (prevNonSpace === "" ||
        REGEX_PREFIX_CHARS.has(prevNonSpace) ||
        REGEX_PREFIX_KEYWORDS.has(prevWord))
    ) {
      out.push(ch);
      i += 1;
      let inClass = false;
      while (i < len) {
        const c = source[i]!;
        out.push(c);
        if (c === "\\" && i + 1 < len) {
          out.push(source[i + 1]!);
          i += 2;
          continue;
        }
        if (c === "[") {
          inClass = true;
        } else if (c === "]") {
          inClass = false;
        } else if (c === "/" && !inClass) {
          i += 1;
          break;
        } else if (c === "\n") {
          i += 1;
          break;
        }
        i += 1;
      }
      prevNonSpace = "/";
      prevWord = "";
      continue;
    }

    out.push(ch);
    if (ch !== " " && ch !== "\t" && ch !== "\r" && ch !== "\n") {
      if (isWordChar(ch)) {
        prevWord = isWordChar(prevNonSpace) ? prevWord + ch : ch;
      } else {
        prevWord = "";
      }
      prevNonSpace = ch;
    }
    i += 1;
  }

  return out.join("");
}

export function extractModuleSpecifiers(codeWithoutComments: string): string[] {
  const specifiers: string[] = [];

  const fromRe = /\b(?:import|export)\b[^;'"`]*?\bfrom\s*(['"])([^'"]+)\1/g;
  for (const match of codeWithoutComments.matchAll(fromRe)) {
    specifiers.push(match[2]!);
  }

  const sideEffectImportRe = /(?:^|[;\n{}])\s*import\s+(['"])([^'"]+)\1/g;
  for (const match of codeWithoutComments.matchAll(sideEffectImportRe)) {
    specifiers.push(match[2]!);
  }

  const dynamicImportRe = /\bimport\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g;
  for (const match of codeWithoutComments.matchAll(dynamicImportRe)) {
    specifiers.push(match[2]!);
  }

  const requireRe = /\brequire\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g;
  for (const match of codeWithoutComments.matchAll(requireRe)) {
    specifiers.push(match[2]!);
  }

  const builtinRe = /\bgetBuiltinModule\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g;
  for (const match of codeWithoutComments.matchAll(builtinRe)) {
    specifiers.push(match[2]!);
  }

  return specifiers;
}

function normalizeRelPath(relPath: string): string {
  return relPath.replaceAll("\\", "/").replace(/^\.\//, "");
}

function isRelativeAllowed(
  fromFile: string,
  specifier: string,
  allowedTopDirs: readonly string[],
): boolean {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    return false;
  }
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(fromFile), specifier),
  );
  if (resolved.startsWith("../") || resolved === "..") {
    return false;
  }
  return allowedTopDirs.some((dir) => resolved.startsWith(`${dir}/`));
}

/**
 * Scans a single TypeScript file (in-memory or from disk) for purity violations.
 */
export function scanSource(
  relPath: string,
  content: string,
): PurityViolation[] {
  const file = normalizeRelPath(relPath);
  const violations: PurityViolation[] = [];
  const isProtocol = file.startsWith("protocol/");
  const isKernel = file.startsWith("kernel/");

  if (!isProtocol && !isKernel) {
    return violations;
  }

  const code = stripComments(content);
  const specifiers = extractModuleSpecifiers(code);

  // 1. Module import boundaries
  if (isProtocol) {
    for (const spec of specifiers) {
      if (!isRelativeAllowed(file, spec, ["protocol"])) {
        violations.push({
          file,
          rule: "protocol-forbidden-import",
          detail: `protocol/ must not import "${spec}"`,
        });
      }
    }
  } else if (file === "kernel/store.ts") {
    const storeAllowedBuiltins = new Set(["node:sqlite", "node:crypto"]);
    for (const spec of specifiers) {
      if (storeAllowedBuiltins.has(spec)) {
        continue;
      }
      if (!isRelativeAllowed(file, spec, ["kernel", "protocol"])) {
        violations.push({
          file,
          rule: "kernel-store-forbidden-import",
          detail: `kernel/store.ts must not import "${spec}"`,
        });
      }
    }
    const cryptoMatch = code.match(FORBIDDEN_CRYPTO_PRIMITIVES_RE);
    if (cryptoMatch) {
      violations.push({
        file,
        rule: "kernel-store-forbidden-crypto-rng",
        detail: `kernel/store.ts must not use non-deterministic crypto primitive "${cryptoMatch[1]}"`,
      });
    }
  } else {
    for (const spec of specifiers) {
      if (!isRelativeAllowed(file, spec, ["kernel", "protocol"])) {
        violations.push({
          file,
          rule: "kernel-forbidden-import",
          detail: `kernel/ must not import "${spec}"`,
        });
      }
    }
  }

  // 2. Non-deterministic / IO globals
  for (const check of FORBIDDEN_RUNTIME_APIS) {
    if (check.pattern.test(code)) {
      violations.push({
        file,
        rule: check.rule,
        detail: `${file} matched forbidden API pattern ${check.pattern}`,
      });
    }
  }

  // 3. Concrete runtime / host / model names
  if (isKernel) {
    const hostMatch = content.match(KERNEL_FORBIDDEN_HOSTS_RE);
    if (hostMatch) {
      violations.push({
        file,
        rule: "kernel-forbidden-host-or-model",
        detail: `kernel/ must not mention concrete host/model "${hostMatch[1]}"`,
      });
    }
  } else if (isProtocol) {
    const hostMatch = content.match(PROTOCOL_FORBIDDEN_HOSTS_RE);
    if (hostMatch) {
      violations.push({
        file,
        rule: "protocol-forbidden-host",
        detail: `protocol/ must not mention concrete host "${hostMatch[1]}"`,
      });
    }
  }

  return violations;
}

export function collectTsFiles(rootDir: string, subdir: string): SourceEntry[] {
  const baseDir = path.join(rootDir, subdir);
  let entries: string[];
  try {
    if (!statSync(baseDir).isDirectory()) {
      return [];
    }
    entries = readdirSync(baseDir);
  } catch {
    return [];
  }

  const results: SourceEntry[] = [];
  for (const name of entries.sort()) {
    const full = path.join(baseDir, name);
    const rel = path.posix.join(subdir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      results.push(...collectTsFiles(rootDir, rel));
    } else if (st.isFile() && name.endsWith(".ts")) {
      results.push({ path: rel, content: readFileSync(full, "utf8") });
    }
  }
  return results;
}

export function scanRepository(rootDir: string): PurityViolation[] {
  const files = [
    ...collectTsFiles(rootDir, "protocol"),
    ...collectTsFiles(rootDir, "kernel"),
  ];
  const violations: PurityViolation[] = [];
  for (const entry of files) {
    violations.push(...scanSource(entry.path, entry.content));
  }
  return violations;
}

describe("Architecture Purity Gate", () => {
  it("repository protocol/ and kernel/ files have zero purity violations", () => {
    const kernelFiles = collectTsFiles(REPO_ROOT, "kernel");
    assert.ok(
      kernelFiles.length > 0,
      "expected at least kernel/errors.ts to exist",
    );

    const violations = scanRepository(REPO_ROOT);
    assert.deepEqual(violations, []);
  });

  it("package.json declares zero runtime dependencies", () => {
    const pkgPath = path.join(REPO_ROOT, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<
      string,
      unknown
    >;
    assert.equal(
      "dependencies" in pkg,
      false,
      "package.json must not contain dependencies",
    );
  });

  it("detects forbidden external and node:* imports in protocol/", () => {
    for (const badImport of [
      `import fs from "node:fs";`,
      `import { DatabaseSync } from "node:sqlite";`,
      `import { register } from "sidecar_sdk";`,
      `import pkg from "some-npm-pkg";`,
      `import { InputError } from "../kernel/errors.ts";`,
      `const m = await import("node:http");`,
    ]) {
      const violations = scanSource("protocol/bad.ts", badImport);
      assert.ok(
        violations.some((v) => v.rule === "protocol-forbidden-import"),
        `expected violation for: ${badImport}`,
      );
    }
  });

  it("allows intra-protocol imports and frozen RunnerKind/comment examples in protocol/", () => {
    const validProtocol = `
      import type { InboundEvent } from "./types.ts";
      /** Example model: gemini-4-hydrogen-high, gemini-4-carbon-high */
      export type RunnerKind = "agy-print" | "agentapi-ui" | "command" | "delivery";
      export function atDate(ms: number): Date { return new Date(ms); }
    `;
    assert.deepEqual(scanSource("protocol/valid.ts", validProtocol), []);
  });

  it("detects forbidden imports in kernel/ (non-store files)", () => {
    for (const badImport of [
      `import http from "node:http";`,
      `import { spawn } from "node:child_process";`,
      `import { readFileSync } from "node:fs";`,
      `import { DatabaseSync } from "node:sqlite";`,
      `import { createHash } from "node:crypto";`,
      `import sdk from "sidecar_sdk";`,
      `import lodash from "lodash";`,
      `import { run } from "../engine/agy-runner.ts";`,
    ]) {
      const violations = scanSource("kernel/decide.ts", badImport);
      assert.ok(
        violations.some((v) => v.rule === "kernel-forbidden-import"),
        `expected kernel-forbidden-import for: ${badImport}`,
      );
    }
  });

  it("allows node:sqlite and sync node:crypto hash/HMAC in kernel/store.ts while blocking IO and RNG", () => {
    const validStore = `
      import { DatabaseSync } from "node:sqlite";
      import { createHash, createHmac, timingSafeEqual } from "node:crypto";
      import { InputError } from "./errors.ts";
      import type { InboundEvent } from "../protocol/types.ts";
      export function digest(v: string): string {
        return createHash("sha256").update(v).digest("hex");
      }
    `;
    assert.deepEqual(scanSource("kernel/store.ts", validStore), []);

    for (const badStore of [
      `import fs from "node:fs";`,
      `import http from "node:http";`,
      `import { spawn } from "node:child_process";`,
      `import sdk from "sidecar_sdk";`,
    ]) {
      const violations = scanSource("kernel/store.ts", badStore);
      assert.ok(
        violations.some((v) => v.rule === "kernel-store-forbidden-import"),
        `expected kernel-store-forbidden-import for: ${badStore}`,
      );
    }

    for (const badCrypto of [
      `import { randomUUID } from "node:crypto";`,
      `import { randomBytes } from "node:crypto";`,
      `import crypto from "node:crypto"; const id = crypto.randomUUID();`,
    ]) {
      const violations = scanSource("kernel/store.ts", badCrypto);
      assert.ok(
        violations.some((v) => v.rule === "kernel-store-forbidden-crypto-rng"),
        `expected kernel-store-forbidden-crypto-rng for: ${badCrypto}`,
      );
    }
  });

  it("detects non-deterministic clock, RNG, env, and fetch calls in kernel/ and protocol/", () => {
    const cases: Array<{ code: string; expectedRule: string }> = [
      {
        code: `export const t = Date.now();`,
        expectedRule: "forbidden-clock-date-now",
      },
      {
        code: `export const d = new Date();`,
        expectedRule: "forbidden-clock-new-date",
      },
      {
        code: `export const r = Math.random();`,
        expectedRule: "forbidden-rng-math-random",
      },
      {
        code: `export const u = crypto.randomUUID();`,
        expectedRule: "forbidden-rng-random-uuid",
      },
      {
        code: `export const k = process.env.HOME;`,
        expectedRule: "forbidden-env-access",
      },
      {
        code: `export const f = fetch("https://example.com");`,
        expectedRule: "forbidden-network-fetch",
      },
    ];

    for (const target of ["kernel/bad.ts", "protocol/bad.ts"]) {
      for (const c of cases) {
        const violations = scanSource(target, c.code);
        assert.ok(
          violations.some((v) => v.rule === c.expectedRule),
          `expected ${c.expectedRule} in ${target} for: ${c.code}`,
        );
      }
    }

    // Parameterized Date constructor is deterministic and allowed
    assert.deepEqual(
      scanSource("kernel/cron.ts", `export const d = new Date(1700000000000);`),
      [],
    );
  });

  it("detects concrete host/model names in kernel/ and sidecar_sdk/feishu in protocol/", () => {
    for (const forbidden of [
      "agy",
      "agentapi",
      "sidecar_sdk",
      "hydrogen",
      "carbon",
      "claude",
      "feishu",
    ]) {
      const codeViolation = scanSource(
        "kernel/bad.ts",
        `export const host = "${forbidden}";`,
      );
      assert.ok(
        codeViolation.some((v) => v.rule === "kernel-forbidden-host-or-model"),
        `expected host/model violation in kernel/ code for: ${forbidden}`,
      );

      const commentViolation = scanSource(
        "kernel/bad.ts",
        `// mentions ${forbidden}`,
      );
      assert.ok(
        commentViolation.some(
          (v) => v.rule === "kernel-forbidden-host-or-model",
        ),
        `expected host/model violation in kernel/ comment for: ${forbidden}`,
      );
    }

    // Ordinary English words containing "agy" as substring must not false-positive
    assert.deepEqual(
      scanSource("kernel/ok.ts", `// strategy, legacy, usage, language`),
      [],
    );

    for (const forbiddenProto of ["sidecar_sdk", "feishu"]) {
      const violations = scanSource(
        "protocol/bad.ts",
        `export const target = "${forbiddenProto}";`,
      );
      assert.ok(
        violations.some((v) => v.rule === "protocol-forbidden-host"),
        `expected protocol-forbidden-host for: ${forbiddenProto}`,
      );
    }
  });
});
