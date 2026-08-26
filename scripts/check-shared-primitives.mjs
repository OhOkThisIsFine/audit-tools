#!/usr/bin/env node
//
// check:shared-primitives — the single-source gate for tiny shared primitives.
//
// WHY THIS EXISTS. `pathContainment.ts` was created (058c035d) as the ONE
// root-containment guard, replacing five hand-rolled copies — and forks regrew
// anyway. The same happened to `isRecord` (11 copies, one of them accepting
// arrays), `compareCodeUnits` (10+ copies beside a header that says "exactly
// ONE"), `hashContent` (9 inline sha256 chains, one carrying the exact
// `.slice(0, N)` anti-pattern its home bans), and the path normalizers
// (12 copies, two behaviours). Review caught none of it for months. So the
// property is enforced here instead of relied on as authoring discipline:
// a primitive with a declared single home has exactly ONE definition in `src/`,
// and the defect CLASSES (hand-rolled comparator body, hand-rolled containment
// predicate, inline sha256 chain, ICU-collation sort) are pattern-banned so a
// re-roll under a NEW name is red too.
//
// SCOPE, stated outright: this gate scans tracked `src/**/*.ts` only. The test
// tree is deliberately out of scope — a test oracle must not import the code it
// validates, so `tests/**` may carry its own comparator copies (e.g. the
// remediation contract-harness). That uncovered half is declared here and in
// scripts/guard-reach-data.mjs, not hidden.
//
// Exceptions are DATA (file + reason), never prose. An exception naming a file
// that no longer exists is itself a violation, so the list self-cleans.
//
//   node scripts/check-shared-primitives.mjs
//
// Wired as `npm run check:shared-primitives` (verify:checks). Importable as a
// library (the contract test exercises the rule matchers directly); the CLI
// body runs only on direct invocation.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * @typedef {{ file: string, line: number, rule: string, detail: string }} Violation
 */

/**
 * Single-definition rules: a `function <name>(` / `const <name> =` definition
 * of a listed name anywhere in src/ outside its declared home is a violation.
 * A name with home `null` is banned outright — it names a deleted fork whose
 * regrowth (under the same name) must stay dead; adopt the canonical helper
 * instead.
 */
export const SINGLE_DEFINITION_RULES = [
  { name: 'isRecord', home: 'src/shared/validation/basic.ts' },
  { name: 'compareCodeUnits', home: 'src/shared/compareCodeUnits.ts' },
  { name: 'hashContent', home: 'src/shared/hash.ts' },
  { name: 'stableStringify', home: 'src/shared/stableStringify.ts' },
  { name: 'formatSchemaFailure', home: 'src/shared/validation/schemaFailure.ts' },
  { name: 'errorMessage', home: 'src/shared/io/json.ts' },
  { name: 'toPosixPath', home: 'src/shared/paths.ts' },
  { name: 'normalizeRepoRelPath', home: 'src/shared/paths.ts' },
  { name: 'defaultReadFileText', home: 'src/audit/extractors/readFileText.ts' },
  { name: 'getExternalSignalPaths', home: 'src/audit/orchestrator/requeueUtils.ts' },
  // Deleted-fork names, banned outright: the canonical helper replaced them.
  { name: 'isPlainObject', home: null },
  { name: 'isSubmissionObjectMap', home: null },
  { name: 'compareIds', home: null },
  { name: 'compareNodeIds', home: null },
  { name: 'toPosix', home: null },
  { name: 'normalizePath', home: null },
  { name: 'normalizePathForMatch', home: null },
  { name: 'canonicalPath', home: null },
  { name: 'canonicalIntentPath', home: null },
  { name: 'isOutsideRoot', home: null },
  { name: 'posixify', home: null },
  { name: 'sha256', home: null },
];

/**
 * Pattern rules: a defect-class body is banned wherever it appears in src/,
 * whatever its name. Each rule: id, regex over file content, the home file(s)
 * allowed to carry it, exceptions [{file, reason}].
 */
export const PATTERN_RULES = [
  {
    id: 'comparator-body',
    // The code-unit comparator body: `x < y ? -1 : x > y ? 1 : 0` (any
    // identifiers/property chains, any spacing). Adopt compareCodeUnits.
    regex: /([$\w.]+)\s*<\s*([$\w.]+)\s*\?\s*-1\s*:\s*\1\s*>\s*\2\s*\?\s*1\s*:\s*0/g,
    homes: ['src/shared/compareCodeUnits.ts'],
    exceptions: [],
    fix: 'import { compareCodeUnits } from the shared home instead of re-rolling the body',
  },
  {
    id: 'containment-predicate',
    // A hand-rolled root-containment check: `relative(` combined with a
    // `.startsWith("..")`-shaped test in the same file. Adopt
    // resolveWithinRoot / assertWithinRoot (src/shared/io/pathContainment.ts).
    regex: /\.startsWith\(\s*["'`]\.\./g,
    requiresAlso: /\brelative\(/,
    homes: ['src/shared/io/pathContainment.ts'],
    exceptions: [],
    fix: 'route the predicate through resolveWithinRoot/assertWithinRoot (pathContainment.ts)',
  },
  {
    id: 'sha256-chain',
    // An inline sha256 construction outside the hash home. Adopt hashContent
    // (or contentSha256 for canonical-JSON digests).
    regex: /createHash\(\s*["'`]sha256["'`]\s*\)/g,
    homes: ['src/shared/hash.ts'],
    exceptions: [
      {
        file: 'src/audit/io/toolingManifest.ts',
        reason: 'incremental multi-update digest across a directory walk — not a single-shot hashContent call',
      },
    ],
    fix: 'route the digest through hashContent (src/shared/hash.ts)',
  },
  {
    id: 'intl-collator',
    // The other spelling of ICU collation. Same ban, same reason.
    regex: /Intl\.Collator/g,
    homes: [],
    exceptions: [],
    fix: 'sort with compareCodeUnits — ICU collation makes persisted order (and its hash) locale-dependent',
  },
  {
    id: 'locale-compare',
    // ICU collation is banned in src/ entirely: a persisted artifact ordered
    // by localeCompare hashes differently per host locale (phantom-staleness
    // class), and one comparator everywhere is the endpoint. Use
    // compareCodeUnits.
    regex: /\blocaleCompare\b/g,
    homes: [],
    exceptions: [],
    fix: 'sort with compareCodeUnits — ICU collation makes persisted order (and its hash) locale-dependent',
  },
];

/**
 * Build the definition-site regex for one primitive name.
 * @param {string} name
 */
export function definitionRegex(name) {
  // The const/let arm admits an optional type annotation between the name and
  // the `=` (`const isRecord: Predicate = ...`) — an annotated re-roll must not
  // slip past the gate.
  return new RegExp(
    String.raw`(?:function\s+${name}\s*\(|(?:const|let)\s+${name}\s*(?::[^=\n]+)?=)`,
    'g',
  );
}

/** @param {string} content @param {number} index */
function lineOf(content, index) {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

/**
 * Run every rule over one file's content.
 * @param {string} file repo-relative posix path
 * @param {string} content
 * @returns {Violation[]}
 */
export function scanFile(file, content) {
  /** @type {Violation[]} */
  const violations = [];

  for (const rule of SINGLE_DEFINITION_RULES) {
    if (rule.home === file) continue;
    const re = definitionRegex(rule.name);
    for (const m of content.matchAll(re)) {
      violations.push({
        file,
        line: lineOf(content, m.index ?? 0),
        rule: `single-definition:${rule.name}`,
        detail:
          rule.home === null
            ? `"${rule.name}" is a retired fork name — adopt the canonical shared helper`
            : `second definition of "${rule.name}" — the single home is ${rule.home}`,
      });
    }
  }

  for (const rule of PATTERN_RULES) {
    if (rule.homes.includes(file)) continue;
    if (rule.exceptions.some((e) => e.file === file)) continue;
    if (rule.requiresAlso && !rule.requiresAlso.test(content)) continue;
    for (const m of content.matchAll(rule.regex)) {
      violations.push({
        file,
        line: lineOf(content, m.index ?? 0),
        rule: rule.id,
        detail: rule.fix,
      });
    }
  }

  return violations;
}

/**
 * Every exception AND every declared home must name a file that exists in the
 * scanned set — a stale row is itself a violation, so the data self-cleans and
 * a deleted home cannot leave its rule silently vacuous.
 * @param {ReadonlySet<string>} trackedSrc
 * @returns {Violation[]}
 */
export function staleDataRows(trackedSrc) {
  /** @type {Violation[]} */
  const violations = [];
  for (const rule of SINGLE_DEFINITION_RULES) {
    if (rule.home !== null && !trackedSrc.has(rule.home)) {
      violations.push({
        file: 'scripts/check-shared-primitives.mjs',
        line: 1,
        rule: `single-definition:${rule.name}:missing-home`,
        detail: `declared home ${rule.home} is not a tracked src file — fix the row or restore the home`,
      });
    }
  }
  for (const rule of PATTERN_RULES) {
    for (const home of rule.homes) {
      if (!trackedSrc.has(home)) {
        violations.push({
          file: 'scripts/check-shared-primitives.mjs',
          line: 1,
          rule: `${rule.id}:missing-home`,
          detail: `declared home ${home} is not a tracked src file — fix the row or restore the home`,
        });
      }
    }
    for (const e of rule.exceptions) {
      if (!trackedSrc.has(e.file)) {
        violations.push({
          file: 'scripts/check-shared-primitives.mjs',
          line: 1,
          rule: `${rule.id}:stale-exception`,
          detail: `exception names ${e.file}, which is not a tracked src file — delete the row`,
        });
      }
    }
  }
  return violations;
}

function main() {
  // win32: suppress the console-window flash on every gate run — INV-WH.
  const tracked = execFileSync('git', ['ls-files', 'src/**/*.ts'], {
    encoding: 'utf8',
    windowsHide: true,
  })
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const trackedSet = new Set(tracked);

  /** @type {Violation[]} */
  const violations = [...staleDataRows(trackedSet)];
  let scanned = 0;
  for (const file of tracked) {
    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
    scanned += 1;
    violations.push(...scanFile(file, content));
  }

  if (violations.length > 0) {
    console.error(`check-shared-primitives: ${violations.length} violation(s) in ${scanned} files`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line} [${v.rule}] ${v.detail}`);
    }
    process.exit(1);
  }
  console.log(`check-shared-primitives: ${scanned} tracked src files clean`);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) main();
