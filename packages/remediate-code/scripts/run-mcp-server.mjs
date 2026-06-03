#!/usr/bin/env node
// Standalone MCP server launcher for IDE integrations that need a subprocess.
import { spawnSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distEntry = join(pkgRoot, "dist", "index.js");
const argv = process.argv.slice(2); // forward --root, --artifacts-dir, etc.
process.stderr.write(`[mcp-server] starting: node=${process.execPath} entry=${distEntry}\n`);

const result = spawnSync(
  process.execPath,
  ["--no-warnings", distEntry, "mcp", ...argv],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
