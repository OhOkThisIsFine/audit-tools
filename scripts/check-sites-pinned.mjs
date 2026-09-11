#!/usr/bin/env node
//
// Per-site pinning gate — "every changed site is pinned by a test" as a
// MECHANICAL check instead of a claim the author makes about their own work.
//
// THE DEFECT CLASS, and it is documented in `docs/backlog/open-bugs.md` under
// "A per-site pinning gate would make 'red-green validated' mechanically
// checkable". An adversarial review of a prototype (`assert-sites-pinned.mjs`,
// on an unmerged branch, reachable from NO ref) found TWO fail-open shapes, and
// this gate is built to close the first by construction:
//
//   1. THE DENOMINATOR. The prototype took a hand-written site list — 7 sites
//      declared against >=11 substantive hunks. "All 7 changed sites are
//      individually pinned" was literally true and materially misleading, and
//      the two hunks that WERE the change's core claim fell outside it. Here the
//      site list is DERIVED FROM THE DIFF, so an omitted hunk is impossible.
//
//   2. THE BINDING (not closed this lap — see below). The prototype measured
//      "the suite went red", not "a test asserting THIS behaviour went red":
//      renaming an export so importers crash produced 71 failures and still
//      reported `All 1 site(s) individually pinned.`
//
// ── WHAT THIS GATE IS, AND WHAT IT IS NOT ────────────────────────────────────
// The DERIVED SITE LIST is done. Each changed site is derived from the staged
// diff and must be BOUND to the name(s) of the test(s) expected to fail.
//
// THE NAME BINDING IS NOT DERIVED YET. It is read from the `// sites-pinned:`
// declaration beside the code, so it is AUTHOR-SUPPLIED — which is exactly the
// relocation the backlog warns about: it moves the claim one level up rather
// than removing it. ⚠ **THIS GATE'S OUTPUT IS THEREFORE NOT ADMISSIBLE AS
// LOOP-CORE ATTESTATION EVIDENCE** — a `--checked "red-green validated"` that
// cites this gate still rests on the author's word about their own work. The
// derivation that would make it admissible is a baseline coverage / ownership
// map (which test file owns which source region), and it is not built. This
// paragraph is the gate's own admission, printed in its output too, so a reader
// never has to take it on the gate's silence.
//
// ── HOW A SITE IS DERIVED ────────────────────────────────────────────────────
// `git diff --cached -U0 --diff-filter=ACMR -- <tracked source>` over the staged
// tree. Every added or removed line in a source file is a site, and each site
// carries its line number in the new file. A site is EXCLUDED only by a
// declared, printed rule:
//   • a whitespace-only or comment-only change (it asserts no behaviour);
//   • an import / re-export line (a module edge, not a behaviour);
//   • a line a `// sites-pinned: none — <why>` declaration governs (a
//     whole-file exemption, one line, with a stated reason — the word `none` as
//     a whole token, never a prefix, so `nonexistent.test.ts` is a TEST NAME and
//     is checked as one);
//   • a line of a GENERATED file (its content is derived from a source that is
//     itself pinned, and the remedy a declaration would demand is the hand edit
//     `check:generated-artifacts` forbids — the set is read from the GENERATED
//     registry, never matched from header text).
// Everything else must be bound. The rules are DATA at the top of this module so
// what is excluded is readable in one place rather than spread through the walk.
//
// ── HOW A SITE IS BOUND ──────────────────────────────────────────────────────
// To the declaration NEAREST ABOVE it. A declaration governs every site below it
// until the next declaration; a site with no declaration above it is unbound and
// refused. So a stale header declaration cannot answer for a hunk a later
// declaration was written to bind, and a hunk above every declaration cannot be
// covered by one that appears further down the file.
//
//   node scripts/check-sites-pinned.mjs              # verify the STAGED diff
//   node scripts/check-sites-pinned.mjs --base <rev> # verify <rev>..worktree
//
// Exits 0 with an explanation when there is nothing staged to pin — a gate with
// no subject is not a pass, and it says so rather than printing a bare tick.
// sites-pinned: tests/shared/sites-pinned-gate.test.ts
//   Every changed site of this gate is pinned by that suite, which drives the
//   exported walker over fixture diffs and spawns this CLI against a throwaway
//   repo for the one refusal that must fire exactly as shipped.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
// The glob grammar check-doc-manifest.mjs owns — imported, never re-implemented,
// so a pattern means the same thing in this gate as in every other one.
import { globToRegExp, isGlob } from './check-doc-manifest.mjs';
// The GENERATED registry, imported rather than restated: it is the data
// `check:generated-artifacts` reconciles the whole tree against, so a file that
// has a generator lands in this gate's exclusion set in the same edit that gives
// it one. A second hand-written list here is the drift this repository bans.
import { GENERATED } from './guard-reach-data.mjs';
// The repo-wide argument rule. This gate's DEFAULT action judges the staged
// index, so a mistyped flag read as consent would run the gate over a different
// subject than the operator asked for — the argv-guard shape exactly.
import { guardArgv } from './shared/argvGuard.mjs';


/** The marker a site's expected-failing tests are declared on. */
export const PIN_MARKER = 'sites-pinned';

/**
 * The whole-file exemption marker. The documented form carries a reason —
 * `// sites-pinned: none — <why>` — and a bare `none` is refused, because an
 * exemption is a DECISION and a decision with no stated reason is the silence
 * this marker exists to replace.
 */
export const NO_PINS_MARKER = 'sites-pinned: none';

/**
 * The paths whose STAGED hunks this gate pins. A source tree, not a doc tree: a
 * markdown edit asserts no behaviour and pinning one would be noise that trains
 * the reader to skip the refusals.
 */
export const PINNED_PATHS = [
  'src/**/*.ts',
  'scripts/**/*.mjs',
  'scripts/*.mjs',
  '.claude/hooks/*.mjs',
  'wrapper/*.mjs',
  'wrapper/**/*.mjs',
  'dispatch/*.mjs',
  'dispatch/**/*.mjs',
  'audit-code.mjs',
  'remediate-code.mjs',
];

// ── the exclusion rules, as data ─────────────────────────────────────────────
// Each rule is a PREDICATE over one changed line plus the reason it is excluded.
// They are checked in order and the first hit wins, so the reason a line was
// skipped is always the first true one.
export const LINE_EXCLUSION_RULES = [
  {
    id: 'blank',
    reason: 'a blank line asserts no behaviour',
    test: (line) => line.trim() === '',
  },
  {
    id: 'comment-only',
    reason: 'a comment asserts no behaviour',
    test: (line) => /^\s*(\/\/|\/\*|\*|\*\/|#)/.test(line),
  },
  {
    id: 'import-edge',
    reason: 'an import/re-export is a module edge, not a behaviour',
    test: (line) =>
      /^\s*(import|export)\b.*\bfrom\b|\brequire\s*\(|^\s*import\s*\(/.test(line) ||
      /^\s*\}?\s*from\s*["']/.test(line),
  },
];

/** Whether `line` is excluded, and by which rule. */
export function classifyChangedLine(line) {
  for (const rule of LINE_EXCLUSION_RULES) {
    if (rule.test(line)) return { excluded: true, rule: rule.id, reason: rule.reason };
  }
  return { excluded: false, rule: null, reason: null };
}

/**
 * Parse `git diff --cached -U0` output into per-file changed-line records.
 *
 * `-U0` matters: with context lines every site would swallow its neighbourhood
 * and two adjacent changes would read as one. Zero context makes a hunk exactly
 * the lines that changed.
 *
 * EACH LINE CARRIES ITS NEW-FILE LINE NUMBER (read out of the hunk header). That number is
 * what binds a changed site to the declaration ABOVE it: a site is not a
 * property of the file, it is a position in it, and the position is the only
 * thing that can tell a declaration written for this hunk from one written
 * above an older hunk.
 *
 * `head` of `null` means the hunk DELETES lines with nothing left at that
 * position (the `+c,0` form). Those lines were above every declaration at their
 * old position and there is no governed line left to check them against, so the
 * site is reported as a reported exclusion rather than silently bound.
 *
 * @param {string} diffText
 * @returns {Map<string, {path: string, lines: {text: string, head: number|null}[]}>}
 */
export function parseUnifiedDiff(diffText) {
  /** @type {Map<string, {path: string, lines: {text: string, head: number|null}[]}>} */
  const files = new Map();
  /** @type {{path: string, lines: {text: string, head: number|null}[]} | null} */
  let current = null;
  let head = null;
  for (const raw of diffText.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      current = null;
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const path = raw.slice(4).replace(/^b\//, '').trim();
      if (path === '/dev/null') {
        current = null;
        continue;
      }
      // APPEND to a record the same path already has. `git diff` emits one
      // `diff --git` block per file, but `--base <rev>` is not the only caller
      // and a concatenation of two diffs of one file is a shape this parser is
      // handed; keying by path and overwriting silently dropped every hunk but
      // the last, which would derive a site list narrower than the change.
      current = files.get(path) ?? { path, lines: [] };
      files.set(path, current);
      continue;
    }
    if (raw.startsWith('@@')) {
      const m = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      // `+c` alone means one line at c; `+c,0` means the hunk leaves nothing at c,
      // which is a pure deletion and has no position to bind to.
      head = m && m[2] !== '0' ? Number(m[1]) : null;
      continue;
    }
    if (raw.startsWith('--- ') || raw.startsWith('index ')) continue;
    if (current === null) continue;
    if (raw.startsWith('+')) {
      current.lines.push({ text: raw.slice(1), head });
      if (head !== null) head += 1;
    } else if (raw.startsWith('-')) {
      current.lines.push({ text: raw.slice(1), head });
    }
  }
  return files;
}

/**
 * Every changed line of a file that is NOT excluded by a rule, in diff order.
 *
 * `null` heads (a pure deletion, which has no position in the new file) are
 * carried as `null` so the caller can report them rather than judge them.
 */
export function changedSites(lines) {
  const kept = [];
  for (const line of lines) {
    const text = typeof line === 'string' ? line : line.text;
    const head = typeof line === 'string' ? null : line.head;
    const verdict = classifyChangedLine(text);
    if (!verdict.excluded) kept.push({ text: text.trim(), head });
  }
  return kept;
}

/**
 * The declaration parse, shared by both lookup forms below.
 *
 * The marker is anchored at the comment's start and the operand must be followed
 * by a separator, so a line of PROSE about the marker (`// a \`// sites-pinned:
 * <test names>\` declaration beside it`, this gate's own header) is not read as a
 * declaration. A declaration names a subject.
 *
 * An operand that is NOT a name list is `null` — no declaration — rather than a
 * binding to something that is not a path, which would surface later as a
 * confusing "not a tracked file".
 */
function parsePinLine(line) {
  const m = line.match(new RegExp(`^\\s*(?://|#)\\s*${PIN_MARKER}:\\s+(.+)$`));
  if (!m) return null;
  const body = m[1].trim();
  // THE WHOLE-FILE EXEMPTION IS THE WORD `none`, AS A WHOLE TOKEN, FOLLOWED BY A
  // STATED REASON. Matching `startsWith('none')` made `sites-pinned:
  // nonexistent.test.ts` an exemption and skipped the name check entirely — the
  // gate passed with its binding deleted, which is the one fail-open shape a
  // pinning gate cannot have. A `none` with no reason is likewise refused: an
  // exemption is a decision that has to be readable, and "none" alone is the
  // silence an exemption exists to replace.
  const none = body.match(/^none\b\s*[—:-]?\s*(.*)$/i);
  if (none) {
    const why = none[1].trim();
    if (why === '') {
      return {
        kind: 'malformed',
        names: [],
        why: '',
        form: `\`// ${PIN_MARKER}: none — <why>\``,
        detail:
          'a bare `none` states no reason — the exemption has to say WHY this file asserts no ' +
          'behaviour, in the documented `none — <why>` form',
      };
    }
    return { kind: 'whole-file', names: [], why };
  }
  const names = body
    .split(',')
    .map((n) => n.trim().replace(/^["'`]|["'`]$/g, ''))
    .filter(Boolean);
  if (!names.every((n) => /^[\w./@-]+\.(test\.[cm]?[jt]sx?|mjs|ts)$/.test(n))) return null;
  return { kind: 'tests', names, why: '' };
}

/**
 * The `// sites-pinned: <test names>` declaration that GOVERNS a line — the
 * nearest one ABOVE it — or null when no declaration precedes the line.
 *
 * The binding is read from the file rather than from a manifest so a site and
 * its expected-failing tests live together; the parse is deliberately strict,
 * because a malformed declaration that silently reads as "unbound" is the same
 * shape as an absent one and the gate's whole job is telling those apart.
 *
 * POSITION IS THE POINT. A declaration covers every site below it until the next
 * declaration, so a file with a stale header declaration and a fresh one above
 * the changed function binds the change to the SECOND — the one written for it.
 * A line above every declaration is bound to nothing and is refused, which is
 * what makes "nearest above" a rule rather than a docstring: returning the first
 * declaration in the file let a header exempt a site a later declaration was
 * written to bind.
 *
 * @param {string} source
 * @param {number} [line] the 1-based line the site is at
 */
export function readPinDeclaration(source, line) {
  const lines = source.split('\n');
  // INCLUSIVE of the site's own line: a 1-based line N is index N-1, and the
  // slice must reach it. An exclusive bound off-by-one here reads the very
  // declaration the site sits under as absent.
  const last = line === undefined ? lines.length : Math.min(line, lines.length);
  /** @type {ReturnType<typeof parsePinLine>} */
  let governing = null;
  for (let i = 0; i < last; i++) {
    const parsed = parsePinLine(lines[i]);
    if (parsed) governing = parsed;
  }
  return governing;
}

/**
 * Pin every derived site. Pure — the diff text, the source reader and the file
 * list are all injected, so the contract test drives fixture diffs and every
 * refusal path is exercised without touching the real index.
 *
 * THE UNIT IS A SITE, NOT A FILE (D6). Each changed line is bound to the
 * declaration nearest ABOVE it, so two hunks of one file can bind to different
 * tests, and a hunk above every declaration is refused rather than covered by
 * whatever declaration happens to appear later in the file.
 *
 * @param {{
 *   diffText: string,
 *   readText: (path: string) => string,
 *   include: (path: string) => boolean,
 *   checkNames?: (names: string[], source: string) => string[],
 *   isGenerated?: (path: string) => string | null,
 * }} input
 * @returns {{errors: string[], sites: {path: string, lines: string[], tests: string[]}[], excluded: {path: string, reason: string}[], generated: {path: string, generator: string}[]}}
 */
export function pinSites({ diffText, readText, include, checkNames, isGenerated }) {
  /** @type {string[]} */
  const errors = [];
  /** @type {{path: string, lines: string[], tests: string[]}[]} */
  const sites = [];
  /** @type {{path: string, reason: string}[]} */
  const excluded = [];
  /** @type {{path: string, generator: string}[]} */
  const generated = [];

  for (const [path, record] of parseUnifiedDiff(diffText)) {
    if (!include(path)) continue;
    let source;
    try {
      source = readText(path);
    } catch {
      // A deletion of a pinned source file has nothing to pin — its removal is
      // asserted by whatever test covers the consumer, and there is no site left
      // to name. Reported, not silently dropped.
      excluded.push({ path, reason: 'the file no longer exists at this revision' });
      continue;
    }
    // A GENERATED file needs no declaration (D2). Its content is derived from a
    // source that is itself pinned, it is rewritten wholesale by its generator,
    // and the remedy a declaration would demand — a hand edit — is exactly what
    // `check:generated-artifacts` forbids. The set is DATA the caller supplies
    // (read out of the GENERATED registry, never matched from header text), and
    // it is reported so a reader can see what was excluded and on what authority.
    const generator = isGenerated ? isGenerated(path) : null;
    if (generator) {
      generated.push({ path, generator });
      continue;
    }
    const kept = changedSites(record.lines);
    if (kept.length === 0) {
      excluded.push({
        path,
        reason: `every changed line is excluded (${record.lines.length} line(s): blank / comment / import)`,
      });
      continue;
    }

    // ── per-site binding, in file order ───────────────────────────────────────
    /** @type {Map<string, {lines: string[], tests: string[]}>} */
    const bound = new Map();
    for (const site of kept) {
      if (site.head === null) {
        excluded.push({
          path,
          reason: `a deleted line with no position in the new file (${JSON.stringify(site.text)}) — a deletion is pinned by the test that covers the file it was removed from`,
        });
        continue;
      }
      const declared = readPinDeclaration(source, site.head);
      if (declared?.kind === 'malformed') {
        errors.push(
          `${path}:${site.head} is governed by a \`${PIN_MARKER}:\` declaration that is malformed — ` +
            `${declared.detail}. The documented form is ${declared.form}.`,
        );
        continue;
      }
      if (declared?.kind === 'whole-file') {
        excluded.push({
          path,
          reason: `line ${site.head} is under a declared \`${NO_PINS_MARKER} — ${declared.why}\` exemption`,
        });
        continue;
      }
      if (declared === null) {
        errors.push(
          `${path}:${site.head} has no \`// ${PIN_MARKER}: <test file names>\` declaration ABOVE it — ` +
            `each site must bind to the NAME(s) of the test(s) expected to fail, and a declaration ` +
            `governs only the lines below it. Add the declaration above this site, or ` +
            `\`// ${NO_PINS_MARKER} — <why>\` if this file asserts no behaviour. ` +
            `Changed line: ${JSON.stringify(site.text)}`,
        );
        continue;
      }
      if (declared.names.length === 0) {
        errors.push(
          `${path}:${site.head} is governed by a \`// ${PIN_MARKER}:\` declaration with no test names ` +
            `— a binding to nothing reads as a binding.`,
        );
        continue;
      }
      const key = declared.names.join(', ');
      const entry = bound.get(key) ?? { lines: /** @type {string[]} */ ([]), tests: declared.names };
      entry.lines.push(site.text);
      bound.set(key, entry);
    }

    for (const entry of bound.values()) {
      if (checkNames) errors.push(...checkNames(entry.tests, source));
      sites.push({ path, lines: entry.lines, tests: entry.tests });
    }
  }

  return { errors, sites, excluded, generated };
}

/**
 * The admission this gate prints on every run, pass or fail.
 *
 * It is here, in the gate, rather than only in the backlog entry, because the
 * person who would over-read a green run is the person reading the gate's output
 * and not the person reading the backlog.
 */
/**
 * The GENERATED-file exemption set, as a `path → generator` lookup (D2).
 *
 * A generated file is exempt because its CONTENT is derived: the source it is
 * rendered from is what a change to it has to pin, and the generator rewrites
 * the file wholesale. The set is derived from the declared data — the GENERATED
 * registry's `generator` (every generator script is itself in the pinned source
 * set, so it is judged like any other file) and `artifacts` (the files it
 * writes) — never from a header-text match and never from a second list.
 *
 * `src/audit/extractors/languageMap.generated.ts` is named by no row's
 * `artifacts`: `check:generated-artifacts` reconciles its freshness through a
 * contract test rather than a declared artifact, so the row carries the path
 * under `generatedArtifacts` instead. Reading only `artifacts` here would leave
 * exactly the false red this exemption exists to remove.
 *
 * @param {readonly {generator: string, artifacts?: readonly string[], generatedArtifacts?: readonly string[]}[]} rows
 * @returns {Map<string, string>}
 */
export function deriveGeneratedFiles(rows) {
  const byFile = new Map();
  for (const row of rows) {
    for (const artifact of [...(row.artifacts ?? []), ...(row.generatedArtifacts ?? [])]) {
      byFile.set(artifact, row.generator);
    }
  }
  return byFile;
}

/** The admission this gate prints on every run, pass or fail. */
export const ADMISSIBILITY_NOTE =
  'NOT ADMISSIBLE AS ATTESTATION EVIDENCE: the site list is derived from the diff, but the ' +
  'expected-failing test NAMES are author-supplied, so this measures "the declared tests exist" ' +
  'rather than "a test asserting THIS behaviour went red". A `--checked "red-green validated"` ' +
  'citing this gate is still the author\'s word about their own work.';

/**
 * @param {{base: string|null, root: string}} options
 */
function main({ base, root: repoArg }) {
  // The repository this run judges. Defaults to the CWD — `git rev-parse
  // --show-toplevel` from where the caller stands, exactly as the commit gate
  // does — never this file's own location. A gate that resolved its own path
  // would silently judge ITS checkout while the operator was standing in
  // another, which is the "gate reports on the wrong subject" shape.
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    cwd: repoArg,
    windowsHide: true,
  }).trim();

  const diffArgs = base
    ? ['diff', '-U0', '--diff-filter=ACMR', `${base}`, '--']
    : ['diff', '--cached', '-U0', '--diff-filter=ACMR', '--'];

  const diffText = execFileSync('git', diffArgs, {
    encoding: 'utf8',
    cwd: root,
    windowsHide: true, // INV-WH — a console child from a windowless parent pops a window
  });

  const tracked = new Set(
    execFileSync('git', ['ls-files'], { encoding: 'utf8', cwd: root, windowsHide: true })
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean),
  );

  const matchers = PINNED_PATHS.map((p) => ({
    re: isGlob(p) ? globToRegExp(p) : null,
    literal: p,
  }));
  const include = (path) =>
    matchers.some((m) => (m.re ? m.re.test(path) : m.literal === path));

  // The name binding: a declared test path must be a TRACKED file that EXISTS.
  // This is the half that is mechanically checkable without a coverage map —
  // it refuses a binding to a test that was renamed or never written, which is
  // the failure mode that makes an author-supplied list worthless rather than
  // merely weak.
  const checkNames = (names) => {
    const errs = [];
    for (const name of names) {
      if (!tracked.has(name)) {
        errs.push(
          `\`// ${PIN_MARKER}:\` binds a site to "${name}", which is NOT a tracked file — a ` +
            `binding to a test that does not exist obliges nothing.`,
        );
        continue;
      }
      const text = readFileSync(join(root, name), 'utf8');
      if (!/\.test\.[cm]?tsx?$/.test(name) && !/\.test\.mjs$/.test(name)) {
        errs.push(
          `\`// ${PIN_MARKER}:\` binds a site to "${name}", which is not a test file — the ` +
            `binding names the test(s) expected to fail, not an implementation module.`,
        );
      } else if (!/\b(test|it|describe)\s*\(/.test(text)) {
        errs.push(
          `\`// ${PIN_MARKER}:\` binds a site to "${name}", which declares no test(...) case.`,
        );
      }
    }
    return errs;
  };

  const generatedFiles = deriveGeneratedFiles(GENERATED);
  const { errors, sites, excluded, generated } = pinSites({
    diffText,
    readText: (rel) => readFileSync(join(root, rel), 'utf8'),
    include,
    checkNames,
    isGenerated: (rel) => generatedFiles.get(rel) ?? null,
  });

  process.stdout.write(`sites-pinned: ${ADMISSIBILITY_NOTE}\n\n`);
  // What is excluded on a DECLARED authority is stated on every run, with the
  // data it was read from — so "why was this file not judged" is answerable
  // from the output rather than from this file's source.
  process.stdout.write(
    `sites-pinned: GENERATED files are excluded — their content is derived and rewritten by their ` +
      `generator. The set is read from the GENERATED registry (scripts/guard-reach-data.mjs): ` +
      `${generatedFiles.size} declared generated file(s).\n\n`,
  );

  if (diffText.trim() === '') {
    process.stdout.write(
      base
        ? `sites-pinned: nothing changed against ${base} — no sites to pin. This is NOT a pass; ` +
            `it is an empty subject.\n`
        : 'sites-pinned: nothing STAGED — no sites to pin. This is NOT a pass; it is an empty ' +
            'subject. Stage the change (or pass --base <rev>) and run again.\n',
    );
    return;
  }

  for (const g of generated)
    process.stdout.write(`  ◇ ${g.path}: GENERATED by ${g.generator} — needs no declaration\n`);
  for (const e of excluded) process.stdout.write(`  · ${e.path}: ${e.reason}\n`);
  for (const s of sites) {
    process.stdout.write(
      `  ✓ ${s.path} — ${s.lines.length} site(s) bound to ${s.tests.join(', ')}\n`,
    );
  }

  if (errors.length > 0) {
    process.stderr.write(`\n✗ sites-pinned:\n\n${errors.map((e) => `  - ${e}`).join('\n\n')}\n\n`);
    process.exit(1);
  }
  if (sites.length === 0) {
    process.stdout.write(
      `\nsites-pinned: every changed site was excluded by a declared rule — nothing was pinned, ` +
        `and nothing claimed to be.\n`,
    );
    return;
  }
  process.stdout.write(`\n✓ sites-pinned: ${sites.length} file(s) with derived sites, all bound.\n`);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const args = guardArgv(process.argv.slice(2), {
    name: 'check-sites-pinned',
    usage: 'node scripts/check-sites-pinned.mjs [--base <rev>] [--root <dir>]',
    values: ['--base', '--root'],
  });
  main({ base: args.get('--base') ?? null, root: args.get('--root') ?? process.cwd() });
}
