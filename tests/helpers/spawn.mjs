// Window-hidden child_process wrappers for the whole test suite.
//
// A windowless parent (node launched by an IDE/agent) spawning a console child
// (node, git, gh, …) pops a console window on win32 unless `windowsHide: true`
// is passed. Node's own default for `windowsHide` is `false`, so every raw
// `spawn` / `spawnSync` / `exec*` in a test flashes a window when a developer
// runs the vitest suite locally on Windows. Route them through these helpers
// instead (they force `windowsHide: true` last, so it always wins) — or pass
// `windowsHide: true` inline. INV-WH (tests/shared/shared-tests-invariants) is
// the grep-guard that keeps this true across the whole test tree.
//
// `spawnHidden` / `spawnSyncHidden` are re-exported from the single shared
// source so tests and production share one implementation. The `exec*Hidden`
// wrappers below cover the sync/promisified exec entry points tests use.
import { execFile, execFileSync, execSync } from "node:child_process";

export { spawnHidden, spawnSyncHidden } from "../../src/shared/tooling/exec.ts";

/** `child_process.execFileSync` with `windowsHide` forced on. */
export const execFileSyncHidden = (command, args, options) =>
  execFileSync(command, args, { ...(options ?? {}), windowsHide: true });

/** `child_process.execSync` with `windowsHide` forced on. */
export const execSyncHidden = (command, options) =>
  execSync(command, { ...(options ?? {}), windowsHide: true });

/**
 * `child_process.execFile` with `windowsHide` forced on. Arity matches the
 * `(file, args, options, callback)` form so `promisify(execFileHidden)` works.
 */
export const execFileHidden = (command, args, options, callback) =>
  execFile(command, args, { ...(options ?? {}), windowsHide: true }, callback);
