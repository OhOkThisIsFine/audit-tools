#!/usr/bin/env node
// Thin wrapper: locates the built dist and delegates to it.
// Supports: run, install, ensure, validate

import { fileURLToPath } from "url";
import { pathToFileURL } from "url";
import { dirname, join } from "path";
import { existsSync, readdirSync, statSync } from "fs";
import { spawnSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distEntry = join(__dirname, "dist", "remediate", "index.js");
const sourceRoot = join(__dirname, "src");
const tsconfigPath = join(__dirname, "tsconfig.json");

function newestMtimeMs(path) {
  const stats = statSync(path);
  if (!stats.isDirectory()) return stats.mtimeMs;
  let newest = stats.mtimeMs;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtimeMs(child));
    } else if (entry.isFile()) {
      newest = Math.max(newest, statSync(child).mtimeMs);
    }
  }
  return newest;
}

function shouldBuildDist() {
  if (!existsSync(sourceRoot)) {
    return false;
  }
  if (!existsSync(tsconfigPath)) {
    return !existsSync(distEntry);
  }
  if (!existsSync(distEntry)) {
    return true;
  }
  return statSync(distEntry).mtimeMs < Math.max(
    newestMtimeMs(sourceRoot),
    statSync(tsconfigPath).mtimeMs,
  );
}

function ensureBuilt() {
  if (!shouldBuildDist()) return;
  const result =
    process.platform === "win32"
      ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm run build"], {
          cwd: __dirname,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        })
      : spawnSync("npm", ["run", "build"], {
          cwd: __dirname,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) {
    console.error(`remediate-code: failed to auto-build dist (${result.error.message})`);
  }
  if (result.status !== 0 || result.signal) {
    applyWrapperExitAction(getWrapperExitAction(result));
  }
}

export function getWrapperExitAction(result, platform = process.platform) {
  if (result.signal) {
    return platform === "win32"
      ? { type: "exit", code: 1 }
      : { type: "signal", signal: result.signal };
  }
  return { type: "exit", code: result.status ?? 1 };
}

export function applyWrapperExitAction(
  action,
  {
    kill = process.kill,
    exit = process.exit,
    setExitFallback = setTimeout,
  } = {},
) {
  if (action.type === "signal") {
    try {
      kill(process.pid, action.signal);
    } catch {
      exit(1);
      return;
    }
    setExitFallback(() => exit(1), 1000);
    return;
  }
  exit(action.code);
}

export function main(argv = process.argv.slice(2)) {
  ensureBuilt();
  if (!existsSync(distEntry)) {
    console.error("remediate-code: dist/remediate/index.js not found. Run: npm run build");
    process.exit(1);
  }

  const result = spawnSync(process.execPath, ["--no-warnings", distEntry, ...argv], {
    stdio: "inherit",
  });
  applyWrapperExitAction(getWrapperExitAction(result));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
