#!/usr/bin/env node
import { askText, askYesNo, runCli } from "./main.ts";

// The executable entry (dist/cli.js). Kept apart from main.ts so importing the CLI never runs it.
const code = await runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
  ...(process.stdin.isTTY ? { confirm: askYesNo, ask: askText } : {}),
});
process.exit(code);
