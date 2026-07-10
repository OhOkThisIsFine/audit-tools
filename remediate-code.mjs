#!/usr/bin/env node
// Thin wrapper: locates the built dist and delegates to it.
// Interprets the installer verbs (install, ensure, verify-install, install-host)
// locally via the B2 bootstrap; every other verb (e.g. next-step) is forwarded
// to dist/remediate/index.js.

import { fileURLToPath } from "url";
import { pathToFileURL } from "url";
import { dirname, join } from "path";
import { existsSync, readdirSync, statSync } from "fs";
import { spawnSync } from "child_process";

// The installer (B2) is imported LAZILY inside main() only when an install verb
// is invoked, so the thin wrapper still loads (and hits the dist-not-found guard)
// on a published install where wrapper/ is present but for the normal run path we
// never pay to resolve it — and unit tests that copy this file alone still load.
const INSTALLER_MODULE = "./wrapper/remediate-code-wrapper-install-hosts.mjs";

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

export function shouldBuildDist() {
  if (!existsSync(sourceRoot)) {
    return false;
  }
  if (!existsSync(distEntry)) {
    return true;
  }
  // Compare dist freshness against src/ (and tsconfig.json when present). A
  // missing tsconfig.json must NOT collapse this to an existence-only check: a
  // dist older than src/ is still stale and must rebuild (CE-003). Previously
  // the tsconfig-absent branch returned `!existsSync(distEntry)`, so a present
  // but stale dist was silently used.
  const newestSourceMs = existsSync(tsconfigPath)
    ? Math.max(newestMtimeMs(sourceRoot), statSync(tsconfigPath).mtimeMs)
    : newestMtimeMs(sourceRoot);
  return statSync(distEntry).mtimeMs < newestSourceMs;
}

// Default build runner (platform-branched npm run build). Injectable in
// ensureBuilt so the build-failure control flow is unit-testable without
// spawning a real build.
function runNpmBuild() {
  return process.platform === "win32"
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
}

// Returns true when it is safe to proceed to dist forwarding, false when a
// failed/signaled build has initiated a terminating exit action and the caller
// MUST stop. The signal branch of applyWrapperExitAction re-raises the signal
// and schedules a fallback exit but RETURNS control (the fallback can only fire
// once the event loop is free); without this boolean guard main() would then
// run its blocking spawnSync and forward the command against a stale/absent
// dist before the fallback ever fires (CE-002). The exit-code branch terminates
// synchronously, so it never reaches the `return false`.
export function ensureBuilt({
  shouldBuild = shouldBuildDist,
  runBuild = runNpmBuild,
  applyExit = applyWrapperExitAction,
} = {}) {
  if (!shouldBuild()) return true;
  const result = runBuild();
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) {
    console.error(`remediate-code: failed to auto-build dist (${result.error.message})`);
  }
  if (result.status !== 0 || result.signal) {
    applyExit(getWrapperExitAction(result));
    return false;
  }
  return true;
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

export async function main(argv = process.argv.slice(2)) {
  // Route installer verbs to the B2 bootstrap handlers BEFORE dist delegation —
  // these manage repo-local host assets and never touch the built orchestrator.
  const verb = argv[0];
  if (verb === "install" || verb === "ensure" || verb === "verify-install" || verb === "install-host") {
    const installer = await import(INSTALLER_MODULE);
    if (verb === "install") await installer.installBootstrap(argv.slice(1));
    else if (verb === "ensure") await installer.ensureBootstrap(argv.slice(1));
    else if (verb === "verify-install") await installer.verifyInstalledBootstrap(argv.slice(1));
    else await installer.installHostPrompt(argv.slice(1));
    return;
  }

  // A failed/signaled build returns false here; stop rather than forward the
  // command against a stale/absent dist (CE-002). The exit action is already
  // in flight (synchronous exit for a nonzero status, pending fallback exit for
  // a re-raised signal).
  if (!ensureBuilt()) return;
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
  main().catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exit(1);
  });
}
