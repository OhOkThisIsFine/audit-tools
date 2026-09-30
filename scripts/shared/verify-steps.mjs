// sites-pinned: tests/shared/executable-gate-catalog.test.ts, tests/shared/backlog-consolidated.test.ts
import { GUARDS } from '../guard-reach-data.mjs';

// The release and checks draws come from the executable guard catalog.
// Legacy explicit script chains remain readable for external fixture callers.

/** Ordered executable draw. The guard declaration owns membership and order. */
export function catalogGates(stage = 'checks', guards = GUARDS) {
  return guards.filter((g) => g.kind === 'gate' && g.releaseOrder !== undefined &&
    (stage === 'release' || g.releaseStage === 'checks'))
    .sort((a, b) => Number(a.releaseOrder) - Number(b.releaseOrder));
}

/** Commands reference existing npm implementations; direct path gates use node. */
export function catalogCommands(stage = 'checks', guards = GUARDS, npm = 'npm') {
  return catalogGates(stage, guards).map((g) => ({
    label: g.id,
    command: g.impl.includes('/') ? process.execPath : npm,
    args: g.impl.includes('/') ? [g.impl] : ['run', '--silent', g.impl],
  }));
}

/**
 * The `verify:checks` steps in executable order, including legacy explicit chains.
 * @param {Record<string, string>} packageScripts
 * @returns {string[]}
 */
export function verifyChecksSteps(packageScripts, guards = GUARDS) {
  const script = packageScripts?.['verify:checks'] ?? '';
  if (script.includes('--catalog=checks')) return catalogGates('checks', guards).map((g) => g.impl);
  const marker = 'verify-checks';
  const idx = script.indexOf(marker);
  if (idx < 0) {
    throw new Error(
      'verify:checks no longer runs through `profile-run.mjs verify-checks <step> …` — ' +
        'update scripts/shared/verify-steps.mjs',
    );
  }
  return script
    .slice(idx + marker.length)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}
