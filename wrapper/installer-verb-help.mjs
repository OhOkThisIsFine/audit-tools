// Single source for the installer verbs BOTH shipped bins expose, and for the
// help body each one prints.
//
// The verbs are intercepted by each bin's wrapper before the dist CLI is
// reached, so commander — which answers `<verb> --help` natively for every
// command it owns — never sees them. That left `remediate-code install --help`
// running the installer and writing four files, and `audit-code install --help`
// doing the same, because audit's `hasLeadingFlag` deliberately stops at the
// first non-flag token (it must, or `explain-task -v` would print the wrapper's
// version instead of forwarding `-v`). Two reasonable local decisions adding up
// to the same surprise on the commands a new operator touches first, two of
// which write into the repo and the home directory.
//
// One home for the list and the text: a verb added to one bin cannot silently
// go undocumented in the other, and the contract test enumerates THIS array
// rather than a hand-copied one, so coverage follows the source.

/** Every verb a bin's wrapper handles before the dist CLI sees the argv. */
export const INSTALLER_VERBS = Object.freeze([
  'ensure',
  'install',
  'install-host',
  'verify-install',
]);

// `{product}` is substituted with the slash-command the bin installs, so the
// same sentence serves both bins without a second copy drifting.
const VERB_SUMMARY = Object.freeze({
  ensure: 'lazily bootstraps repo-local {product} assets when they are missing or stale',
  install: 'bootstraps {product} into supported repo-local host surfaces',
  'install-host': 'installs {product} into ONE named host surface (--host <name>)',
  'verify-install': 'smoke-tests the generated {product} host assets after an install',
});

const VERB_DETAIL = Object.freeze({
  ensure: [
    'Idempotent: re-running it repairs drift rather than duplicating assets.',
    'Runs implicitly when a stale or missing asset is detected, so it rarely',
    'needs to be invoked by hand.',
  ],
  install: [
    'Writes repo-local host assets for every supported surface it detects.',
    'This WRITES to the repository and to the home directory.',
  ],
  'install-host': [
    'The narrower path when only one surface should be written, e.g.',
    '  --host copilot',
    'This WRITES to the repository and to the home directory.',
  ],
  'verify-install': [
    'Read-only. Exits non-zero when a generated asset is missing or stale.',
  ],
});

/**
 * One verb's one-line summary, with `{product}` bound to the slash-command the
 * bin installs. The accessor exists so the surface can be RENDERED — the docs
 * that list these verbs read this module rather than restating it, which is how
 * `docs/audit-pkg/product.md` came to omit two of the four.
 */
export function installerVerbSummary(verb, product) {
  const summary = VERB_SUMMARY[verb];
  if (summary === undefined) throw new Error(`unknown installer verb: ${verb}`);
  return summary.replace('{product}', product);
}

/** True when `verb` is one of the wrapper-intercepted installer verbs. */
export function isInstallerVerb(verb) {
  return typeof verb === 'string' && INSTALLER_VERBS.includes(verb);
}

/**
 * True when argv asks for help ON an installer verb — `<verb> --help` in any
 * position after the verb.
 *
 * Deliberately NOT the same predicate as the bare leading-flag scan: that one
 * must stop at the first non-flag token so a dist command's own `-h`/`-v` is
 * forwarded rather than hijacked. Here the verb is already known to be
 * wrapper-owned, so nothing downstream can want the flag.
 */
export function wantsInstallerVerbHelp(argv) {
  if (!Array.isArray(argv) || !isInstallerVerb(argv[0])) return false;
  return argv.slice(1).some((token) => token === '--help' || token === '-h');
}

/**
 * The help body for one installer verb. `product` is the slash-command the bin
 * installs (e.g. `/audit-code`); `usageName` is the bin as the caller invoked it.
 */
export function installerVerbHelp(verb, { usageName, product }) {
  const summary = installerVerbSummary(verb, product);
  return [
    `Usage: node ${usageName} ${verb} [--root PATH] [--quiet]`,
    '',
    `${verb} — ${summary}`,
    '',
    ...VERB_DETAIL[verb],
    '',
    'Common options:',
    // NOT "(default: .)" — an absent --root is DISCOVERED (nearest ancestor
    // owning .audit-tools/ or .git), not the cwd verbatim, on both bins.
    '- --root PATH   repository root (default: the repository the working directory is in)',
    '- --quiet       suppress output',
  ].join('\n');
}

/** The one-line summaries, for a bin's top-level help listing. */
export function installerVerbSummaries(product) {
  return INSTALLER_VERBS.map((verb) => `- ${verb} ${installerVerbSummary(verb, product)}`);
}
