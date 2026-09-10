// The repo-wide CLI argument rule: a script REFUSES an argument it does not
// recognize, and never reads an unrecognized flag as consent to do its work.
//
// WHY THIS EXISTS (nightly 2026-09-06, friction: tool_should_decide).
// `node scripts/nightly/ingest-answers.mjs --help` did not print usage — it
// ingested ten answers and wrote `.claude/nightly-decisions.json`. The flag was
// simply ignored, and the script's default action is a durable write. Every
// script of that shape has the same defect: the operator reaches for the
// universal query flag, the script performs its write instead, and a typo
// (`--dryrun` for `--dry-run`) is indistinguishable from a valid run.
//
// The rule is enforced by `.claude/hooks/…`-adjacent contract test over the
// tracked script set — `tests/shared/script-argv-refusal.test.ts` — because a
// convention nobody can check is a convention that decays. This module is the
// ONE implementation that test recognizes, so the parsing rule itself is
// single-sourced rather than re-derived per script.
//
// `--help` is deliberately RECOGNIZED in every spec rather than special-cased:
// it is usage, not work, and a script that answers it never reaches its write.

/** A refused invocation exits 2, matching the `scope-ledger` verb convention. */
export const USAGE_EXIT = 2;

/** True for the two spellings of the usage flag. */
export const isHelpFlag = (arg) => arg === '--help' || arg === '-h';

/**
 * Parse `argv` against a declared spec.
 *
 * Spec shape — everything is optional and an EMPTY spec means "this script
 * takes no arguments at all", which is the strictest and the correct default
 * for a gate:
 *   { flags: ['--check'], values: ['--root'], positionals: 1 }
 *
 * - `flags` are boolean switches; the value list is consumed as `--k v`.
 * - `values` take the NEXT argv entry as their value; a trailing `--k` with no
 *   value is reported through `missingValue`, never silently read as empty.
 * - `positionals` caps how many non-flag arguments are accepted before the rest
 *   are `unknown` (`Infinity` for a variadic tail).
 *
 * `--` ends flag parsing, as everywhere else: every remaining argument is DATA,
 * taken as a positional and never inspected for flags. That is the one escape
 * for a variadic tail of free prose that may itself begin with a dash
 * (`answer.mjs DOC-1 -- "--keep the pin"`), and it is the standard separator
 * rather than a bespoke flag. Everything BEFORE it is still refused when
 * unrecognized, so the escape cannot be used to smuggle a mistyped flag past
 * the guard — it can only carry data.
 *
 * Returns a verdict; it never prints and never exits, so the same call is
 * usable from a CLI and from a test.
 */
export function parseArgv(argv, spec = {}) {
  const flags = new Set(spec.flags ?? []);
  const values = new Set(spec.values ?? []);
  const maxPositionals = spec.positionals ?? 0;
  const positionals = [];
  const seen = new Map();
  const unknown = [];
  const missingValue = [];
  let help = false;
  let dataOnly = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (dataOnly) {
      positionals.push(arg);
      continue;
    }
    if (arg === '--') {
      dataOnly = true;
      continue;
    }
    if (isHelpFlag(arg)) {
      help = true;
      continue;
    }
    if (values.has(arg)) {
      if (i + 1 >= argv.length) missingValue.push(arg);
      else seen.set(arg, argv[++i]);
      continue;
    }
    if (flags.has(arg)) {
      seen.set(arg, true);
      continue;
    }
    // Anything else that looks like a flag is refused. A bare `-` is a
    // positional (a common stdin convention); a leading `--` is not.
    if (arg.startsWith('-') && arg !== '-') {
      unknown.push(arg);
      continue;
    }
    if (positionals.length >= maxPositionals) unknown.push(arg);
    else positionals.push(arg);
  }

  return {
    ok: unknown.length === 0 && missingValue.length === 0 && !help,
    help,
    unknown,
    missingValue,
    positionals,
    has: (name) => seen.has(name),
    get: (name, fallback = undefined) => (seen.has(name) ? seen.get(name) : fallback),
  };
}

/**
 * The rendered refusal for a failed parse, or null when there is nothing to
 * refuse. One message shape for the whole tree, so an operator meets the same
 * sentence wherever they mistype.
 */
export function refusalMessage(parsed, { name, usage }) {
  if (parsed.unknown.length === 0 && parsed.missingValue.length === 0) return null;
  const lines = [];
  if (parsed.unknown.length > 0) {
    lines.push(`${name}: unrecognized argument(s) ${parsed.unknown.map((a) => `"${a}"`).join(', ')}.`);
  }
  if (parsed.missingValue.length > 0) {
    lines.push(`${name}: ${parsed.missingValue.map((a) => `"${a}"`).join(', ')} needs a value.`);
  }
  lines.push(
    `This script refuses arguments it does not recognize — an unrecognized flag is never ` +
      `read as consent to run.`,
    `usage: ${usage}`,
    `       (--help prints this)`,
  );
  return `${lines.join('\n')}\n`;
}

/**
 * The CLI boundary for `scripts/**`: print usage, refuse, or hand back the
 * parsed arguments. Calls `process.exit`, so it belongs in a script's entry
 * block and never in an importable library body.
 *
 * Returns the parse verdict on success; otherwise it does not return.
 */
export function guardArgv(argv, { name, usage, ...spec }) {
  const parsed = parseArgv(argv, spec);
  if (parsed.help) {
    process.stdout.write(`${usage}\n`);
    process.exit(0);
  }
  const refusal = refusalMessage(parsed, { name, usage });
  if (refusal) {
    process.stderr.write(refusal);
    process.exit(USAGE_EXIT);
  }
  return parsed;
}
