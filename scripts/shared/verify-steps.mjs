// The `verify:checks` step list, read from package.json — ONE parser.
//
// WHY THIS EXISTS. Two gates need the same fact: `check-gate-enumeration`
// renders the step list into its target docs, and `check-guard-reach` asks
// whether a gate was actually wired into the chain. Both used to carry their own
// reading of the `profile-run.mjs verify-checks <step> <step> …` command line,
// which is the shape a derived literal takes right before the two copies
// disagree about what the gate runs.
//
// The step list is the executable gate. It is READ here, never declared — so no
// caller can disagree with package.json about membership or order.

/**
 * The `verify:checks` steps, in package.json's own order.
 * @param {Record<string, string>} packageScripts
 * @returns {string[]}
 */
export function verifyChecksSteps(packageScripts) {
  const script = packageScripts?.['verify:checks'] ?? '';
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
