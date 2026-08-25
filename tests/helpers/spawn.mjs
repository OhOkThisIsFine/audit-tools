/**
 * Window-hidden child_process wrappers for the whole test suite.
 *
 * **SEAM-PREP CONTRACT (seam-3081)** — scripts-remediate, tests-helpers, tests-remediate
 *
 * This module is a coordination seam between audit/remediate test blocks that share
 * dependency on windowless process spawning. Changes to this module MUST be coordinated
 * across dependent test suites:
 * - Scripts using `spawnHidden` / `spawnSyncHidden` must receive matching signatures
 * - The re-export pattern from `src/shared/tooling/exec.ts` is the single source of truth
 * - All exec* wrappers must apply `windowsHide: true` uniformly (INV-WH enforcement)
 *
 * When modifying: verify that all import sites in tests/audit/, tests/remediate/, and
 * scripts/ continue to resolve correctly. Cross-check with shared-tests-invariants.test.mjs
 * for INV-WH compliance.
 *
 * A windowless parent (node launched by an IDE/agent) spawning a console child
 * (node, git, gh, …) pops a console window on win32 unless `windowsHide: true`
 * is passed. Node's own default for `windowsHide` is `false`, so every raw
 * `spawn` / `spawnSync` / `exec*` in a test flashes a window when a developer
 * runs the vitest suite locally on Windows. Route them through these helpers
 * instead (they force `windowsHide: true` last, so it always wins) — or pass
 * `windowsHide: true` inline. INV-WH (tests/shared/shared-tests-invariants) is
 * the grep-guard that keeps this true across the whole test tree.
 *
 * `spawnSyncHidden` is re-exported from the single shared source so tests and
 * production share one implementation. The `exec*Hidden` wrappers below cover
 * the sync exec entry points tests use.
 *
 * The two ASYNC entry points — `spawnHidden` and `execFileHidden` — come from
 * `trackedSpawn.ts` instead, which is the same helper plus a ledger of the
 * children still running. Only an async spawn can outlive its test, and a child
 * that does writes into the checkout after every check has passed; read that
 * module's header for what the ledger reaches and what it does not.
 */
import { execFileSync, execSync } from "node:child_process";

export { spawnSyncHidden } from "../../src/shared/tooling/exec.ts";
export { spawnHidden, execFileHidden } from "./trackedSpawn.ts";

/** `child_process.execFileSync` with `windowsHide` forced on. */
export const execFileSyncHidden = (command, args, options) =>
  execFileSync(command, args, { ...(options ?? {}), windowsHide: true });

/** `child_process.execSync` with `windowsHide` forced on. */
export const execSyncHidden = (command, options) =>
  execSync(command, { ...(options ?? {}), windowsHide: true });
