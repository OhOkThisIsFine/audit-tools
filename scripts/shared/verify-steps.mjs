// The `verify:checks` step list, read from package.json — ONE parser.
//
// `check-guard-reach` uses this parser to determine whether a gate is wired
// into the executable `profile-run.mjs verify-checks <step> <step> …` chain.
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
