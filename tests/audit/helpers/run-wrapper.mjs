import { runBounded } from "../../helpers/spawn.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// helpers/ -> tests/ -> package root
const wrapperPath = join(here, "..", "..", "..", "audit-code.mjs");

/**
 * Spawns the audit-code.mjs wrapper with the given args and options, under the
 * suite's per-CLI-call deadline.
 * Strips CLAUDECODE from the environment to avoid test interference.
 * Resolves with { stdout, stderr } on exit code 0; rejects otherwise.
 *
 * The deadline lives in `tests/helpers/trackedSpawn.ts` (`runBounded`), not
 * here, and this file deliberately has no spawn of its own. A local
 * `new Promise` resolving only from the child's `exit` event is what made a
 * wedged CLI indistinguishable from a slow one: the promise never settled, the
 * 300s test ceiling fired on whichever test happened to be running, and the
 * `audit-code` child outlived the abort. `runBounded` fails at the CALL, names
 * the command and the output it produced, and kills the child.
 *
 * @param {string[]} args
 * @param {{ cwd?: string, env?: Record<string, string>, timeoutMs?: number }} [options]
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
export function runWrapper(args, options = {}) {
  const { CLAUDECODE: _cc, ...cleanEnv } = process.env;
  return runBounded(process.execPath, [wrapperPath, ...args], {
    cwd: options.cwd ?? dirname(wrapperPath),
    env: { ...cleanEnv, ...(options.env ?? {}) },
    timeoutMs: options.timeoutMs,
  });
}
