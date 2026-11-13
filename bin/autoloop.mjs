#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { runCli } from "../cli/main.ts";

try {
  const exitCode = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
