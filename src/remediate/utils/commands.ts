import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import {
  runTracked,
  quoteForCmd,
  platformCommand,
  type RunTrackedOptions,
  type RunTrackedResult,
} from "audit-tools/shared";

type SpawnResult = ReturnType<typeof spawnSync>;

// The Windows wrapping/quoting logic now lives in `audit-tools/shared`
// (tooling/exec.ts) so the auditor and remediator share one implementation.
// These re-exports preserve the import surface callers (and tests) rely on.
export { quoteForCmd, platformCommand };

/**
 * Run a command synchronously by argv. Delegates to the shared `runTracked`,
 * which applies the single Windows `.cmd`/`.bat` wrapping implementation and
 * never uses `shell: true`.
 */
export function runCommand(
  command: string,
  args: string[],
  options: RunTrackedOptions = {},
): RunTrackedResult {
  return runTracked([command, ...args], options);
}

/**
 * Run a stored command *string* (e.g. a configured `test_command`) through the
 * platform shell. argv-based callers should use `runCommand`/`runTracked`;
 * this exists only for opaque single-string commands that need shell parsing.
 */
export function runShellCommand(
  command: string,
  options: SpawnSyncOptions = {},
): SpawnResult {
  return spawnSync(command, {
    ...options,
    shell: true,
  });
}
