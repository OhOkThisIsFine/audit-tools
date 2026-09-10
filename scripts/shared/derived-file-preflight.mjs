// Single source for the pre-commit gate's DERIVED leg set — imported by
// `.claude/hooks/pre-commit-gate.mjs` AND both attest scripts (P19, owner
// decision sol-1, 2026-08-12; leg DERIVATION P34+P26, owner decision
// 2026-08-18).
//
// The P19 trap this exists to remove: an attestation binds to the exact staged
// tree (`git write-tree`), but the gate that judges that tree runs later, at
// `git commit`. When a derived file (backlog seek index, HANDOFF roadmap, doc
// manifest, guard-reach registry) is stale, the gate demands a regeneration
// that edits a tracked file — which changes the staged tree and voids the
// attestation that was just written, so the same review is attested twice
// (4 records / 3 dates; S1 100b9117 verbatim in HANDOFF). The attest scripts
// therefore run the SAME checks the gate will run, BEFORE binding, and refuse
// to write an attestation for a tree the gate would reject.
//
// The P34 change: the leg set and every trigger are DERIVED from the
// guard-reach registry (scripts/guard-reach-data.mjs) instead of hand-accreted
// here and in the hook. A gate row's `preCommit` flag states its pre-commit
// behavior as data (false | 'reach' | 'always' | 'final'); a 'reach' trigger is
// the union of the `files` globs of every REACH row citing the gate, plus the
// gate's own impl script path and package.json. `check:guard-reach` reconciles
// the flags (a gate without one, or a 'reach' gate no row cites, is a red
// build), so the leg set can no longer drift narrower than the gates it
// mirrors. Both consumers (gate hook, attest preflight) derive from this one
// module — they cannot diverge, which is what keeps the P19 guarantee intact
// as the leg set grows.
//
// Deliberately NOT covered: the doc-contract test leg (`test:doc-contract`, up
// to 240s) — including it would make attest cost as much as the gate. That
// bound is stated in docs/backlog/durable-traps.md.
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { isGlob, globToRegExp } from '../check-doc-manifest.mjs';
import { GUARDS, REACH } from '../guard-reach-data.mjs';
import { OPEN_ITEMS_RELPATH, PREMISE_GREP_PATHSPECS } from '../nightly/items.mjs';
import { worktreeTree } from './worktree-tree.mjs';

const norm = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '');

// git helper — never throws; callers branch on `.ok`/`.status`. windowsHide:
// a windowless parent spawning git pops a console window on win32 otherwise.
function gitRun(root, args) {
  const r = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  return { ok: r.status === 0, status: r.status, stdout: r.stdout ?? '', stderr: (r.stderr ?? '').trim() };
}

// HANDOFF generated-state parity: custom WIDENING predicate for the
// check:handoff-roadmap leg — the current premise-probe sources and the two
// staged-pickaxe scans are underivable from reach globs, so this predicate
// stays hand-written and is OR-ed onto the derived trigger. Fires whenever the
// staged set touches HANDOFF, a backlog source, the persisted nightly queue,
// its decision ledger, a current premise-probe source, or the code that
// projects those sources. Positive probes use repo-wide git-grep for
// rename/move protection, so a staged pickaxe hit on a probe needle outside
// probe.file can change a presentation-time verdict too — both scans ride the
// staged snapshot.
export function handoffStateTriggered({ root, staged, git = (args) => gitRun(root, args) }) {
  const fixed = (p) => {
    const n = norm(p);
    return (
      n === 'docs/HANDOFF.md' ||
      n === '.audit-tools/nightly/open-items.json' ||
      n === '.claude/nightly-decisions.json' ||
      n === 'scripts/shared/generate-handoff-roadmap.mjs' ||
      n === 'scripts/nightly/items.mjs' ||
      /^docs\/backlog\/[^/]+\.md$/.test(n)
    );
  };
  if (staged.some(fixed)) return true;

  const probeSources = new Set();
  const positiveNeedles = new Set();
  try {
    const queue = JSON.parse(readFileSync(join(root, OPEN_ITEMS_RELPATH), 'utf8'));
    for (const item of Array.isArray(queue?.items) ? queue.items : []) {
      for (const probe of Array.isArray(item?.premise_probes) ? item.premise_probes : []) {
        if (typeof probe?.file === 'string' && probe.file.trim() !== '') {
          probeSources.add(norm(probe.file));
        }
        if (typeof probe?.contains === 'string' && probe.contains.trim() !== '') {
          // The evaluator's same longest-line needle, for staged pickaxe reach.
          const needle = probe.contains
            .split('\n')
            .map((line) => line.trim())
            .sort((a, b) => b.length - a.length)[0];
          if (needle) positiveNeedles.add(needle);
        }
      }
    }
  } catch {
    // Missing/malformed queue state is handled by the parity check when its own
    // path is staged. A repo with no queue has no probe-source dependency.
  }
  for (const source of probeSources) {
    const diff = git(['diff', '--cached', '--quiet', '--no-renames', '--', source]);
    if (diff.status === 1 || !diff.ok) return true;
  }
  for (const needle of positiveNeedles) {
    const diff = git([
      'diff',
      '--cached',
      '--name-only',
      '--no-renames',
      `-S${needle}`,
      '--',
      ...PREMISE_GREP_PATHSPECS,
    ]);
    // A pickaxe failure cannot prove the dependency is unchanged; triggering
    // the parity check is the safe, cheap fallback.
    if (!diff.ok || diff.stdout.trim() !== '') return true;
  }
  return false;
}

// ── SUBJECT-KEYED pinning legs (T-pins) ──────────────────────────────────────
// A literal pinned in a test OUTSIDE the change's neighborhood reds only in CI.
// Measured: a shared expectation literal lived in two files, one was updated,
// and the second went red shard-by-shard in CI (`a8daeef9` closed that
// instance, and `tests/helpers/precommitLegExpectations.ts` single-sourced it).
// The open half — "nothing makes the NEXT duplicated derived literal red
// locally" — is this.
//
// THE MECHANISM. `PINS` maps a SUBJECT path to the test files that assert
// something ABOUT it. Staging the subject OBLIGES those tests: a bound test that
// fails blocks the commit even though neither the test nor the pinned literal
// was staged, which is exactly the case the reach triggers cannot see (the CI
// red arrived with the pin's owner untouched).
//
// WHAT THIS IS NOT. It is not the doc-contract leg, and it deliberately does not
// reuse it: `test:doc-contract` is a hand-listed trio at the twenty-minute end
// of the budget, and the legs here are individual fast files run when ONE
// subject is staged. Nor is it a second copy of the leg set — a pin row names a
// test file, not a gate or a trigger, so there is no registry fact to derive it
// from and no second derivation to drift.
//
// REQUIRED shape of every bound test. Note that importing the SUBJECT is
// expected and correct — a pin is a hand-written literal COMPARED against what
// the subject derives, so the import is the comparison, not a cycle. What a row
// must not do is depend on a BUILD:
//   1. the test must not import `dist/` (the package subpath). The pre-commit
//      gate runs its legs against the staged snapshot, which in a fresh
//      worktree has no `dist/` — a dist-dependent leg would fail there for a
//      reason that has nothing to do with the pin;
//   2. it must assert a literal that mirrors a fact the subject owns. That half
//      is NOT mechanically checkable here, which is why each row is one line in
//      `PINS` and gets read; the reconciler holds the row to what it CAN prove.
//
// UNCOVERED, stated because a partly-enforced trap is not deletable: the
// reconciler proves the row RESOLVES and is build-free, never that the bound
// test still pins something. A row whose test stopped asserting the literal (or
// asserts it tautologically) stays green here. And nothing detects a duplicated
// derived literal in a test for a subject that has no `PINS` row at all — the
// graph can only cover subjects someone declared.
const PINS = new Map([
  // `loop-core-gate-parity`, not `loop-core-paths`: the latter imports the
  // package subpath (`audit-tools/shared`), which resolves through dist/, and
  // the gate's legs run against a staged snapshot with no dist/ in a fresh
  // worktree. The parity test reads the TS source by RELATIVE path and the
  // generated hook sibling, so it is build-free — and it is the stronger pin
  // anyway: it is the one that asserts the generated list equals the source.
  ['src/shared/loopCorePaths.ts', ['tests/shared/loop-core-gate-parity.test.ts']],
  [
    'scripts/guard-reach-data.mjs',
    [
      'tests/shared/precommit-leg-derivation.test.ts',
      'tests/shared/attest-derived-file-preflight.test.ts',
      'tests/shared/guard-form-reach.test.ts',
      'tests/shared/guard-reach-gate.test.ts',
    ],
  ],
  ['src/shared/constitutionalDocPaths.ts', ['tests/shared/doc-manifest-gate.test.ts']],
]);

/** Repo-relative path with backslashes normalized and any leading `./` dropped. */
const normPinPath = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '');

/** Does `text` import the built package (the `dist/`-backed subpath)? */
function importsBuiltPackage(text) {
  const re = /(?:^|\n)\s*import\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
  for (const m of text.matchAll(re)) {
    const spec = m[1];
    if (/^audit-tools(?:\/|$)/.test(spec) || /^(?:\.\.\/)+dist\//.test(normPinPath(spec))) return true;
  }
  return false;
}

// Reconcile the PIN graph against the tracked tree. Pure — takes the tracked
// path list and a path→content reader; returns error strings (empty = clean).
// Wired into `verify:checks` as `check:pin-obligations` so a row that stops
// meaning anything repairs at CONFIGURATION time. Without it a stale row would
// land silently, obliging a test forever and reading as coverage that had been
// checked — the durable-traps rule that a half-enforced trap states its
// uncovered half applies to the row itself, not only to the mechanism.
/**
 * @param {string[]} tracked repo-relative tracked paths
 * @param {(path: string) => string} readText
 * @param {Map<string, string[]>} [pins] the graph to reconcile; defaults to the
 *   shipped `PINS`. The seam exists so a test can exercise the REFUSALS against
 *   a fixture graph — asserting them against the real one is impossible without
 *   breaking the real tree, and a refusal path that is never exercised is the
 *   half-enforced trap this check exists to prevent.
 * @returns {string[]}
 */
export function reconcilePinObligations(tracked, readText, pins = PINS) {
  const files = new Set(tracked.map(normPinPath));
  const errors = [];
  for (const [subject, tests] of pins) {
    if (!files.has(subject)) {
      errors.push(`PINS names the subject ${subject}, which is NOT a tracked file — the pin can never fire.`);
      continue;
    }
    if (tests.length === 0) {
      errors.push(`PINS names ${subject} with NO bound test — an obligation that obliges nothing.`);
      continue;
    }
    for (const test of tests) {
      if (!files.has(test)) {
        errors.push(`PINS binds ${subject} to ${test}, which is NOT a tracked file.`);
        continue;
      }
      let text;
      try {
        text = readText(test);
      } catch {
        errors.push(`PINS binds ${subject} to ${test}, which could not be read.`);
        continue;
      }
      if (importsBuiltPackage(text)) {
        errors.push(
          `PINS binds ${subject} to ${test}, but that test imports the BUILT package (audit-tools / ` +
            `dist/) — the pre-commit gate runs its legs against the staged snapshot, which has no ` +
            `dist/ in a fresh worktree, so the leg would red for a reason unrelated to the pin.`,
        );
      }
    }
  }
  return errors;
}

// How a caller RUNS a leg. Gate legs are npm scripts (wired, run by name); pin
// legs are test files (run by path through the one vitest gate). Single-sourced
// here so the commit gate and the attest preflight cannot disagree about which
// kind a leg is — and so a future leg kind is one branch in one place.
/**
 * @param {{script: string, testPath?: string}} leg
 * @returns {{kind: 'npm', command: string} | {kind: 'test', command: string}}
 */
export function legCommand(leg) {
  return leg.testPath
    ? { kind: 'test', command: `node scripts/shared/run-vitest-gate.mjs ${leg.testPath}` }
    : { kind: 'npm', command: `npm run ${leg.script}` };
}

// Per-gate custom widening predicates, OR-ed onto the derived reach trigger.
// A widening may only ADD firings — narrowing belongs in the registry as data.
const CUSTOM_WIDENING = {
  'check:handoff-roadmap': handoffStateTriggered,
};

/** Whether `root`'s package.json wires `script`. Unreadable reads as unwired. */
export function scriptWired(root, script) {
  try {
    return Boolean(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts?.[script]);
  } catch {
    return false;
  }
}

/**
 * Whether a leg can run in `root`. Gate legs are npm scripts (`scriptWired`);
 * pin legs are test files judged by their own presence on disk — a fixture repo
 * has no `tests/` tree, and reporting a pin leg "unwired" there would be a
 * misleading announcement rather than the honest fail-open it is meant to be.
 * @param {string} root
 * @param {{script: string, testPath?: string}} leg
 */
export function legRunnable(root, leg) {
  if (leg.testPath) return existsSync(join(root, leg.testPath));
  return scriptWired(root, leg.script);
}

// The first repo-relative .mjs path in an npm-script command string —
// `node scripts/check-doc-manifest.mjs` → `scripts/check-doc-manifest.mjs`.
// Appending it (plus package.json) to every reach trigger makes "editing the
// gate's own script re-runs the gate" a derived property instead of a
// hand-listed one.
function implPathFrom(command) {
  if (typeof command !== 'string') return null;
  const m = command.match(/(?:^|\s)((?:[\w.-]+\/)+[\w.-]+\.mjs)(?=\s|$)/);
  return m ? m[1] : null;
}

/**
 * Derive the ordered pre-commit leg set from the guard-reach registry.
 *
 * Returns `[{ id, script, phase: 'main'|'final', fix, triggered({root, staged,
 * git?}) }]` — phase-'main' legs first, then phase-'final' (check:doc-links:
 * the broadest trigger must run AFTER every structural refusal or it masks
 * them), registry order within each phase. A leg's trigger:
 *   'always'        → true for every staged set.
 *   'reach'/'final' → the staged set intersects the union of the `files` globs
 *                     of every REACH row citing the gate ∪ { the gate's impl
 *                     script path (from packageScripts), 'package.json' } — OR
 *                     the gate's custom widening predicate fires.
 * Callers still own wiring (scriptWired) and execution; a leg carries no
 * environment of its own, so fixture repos derive the same set and skip
 * unwired legs with an announcement.
 */
export function buildPreCommitLegs({ guards = GUARDS, reach = REACH, packageScripts = {} } = {}) {
  const legs = [];
  for (const g of guards) {
    if (g.kind !== 'gate' || g.preCommit === false || g.preCommit == null) continue;
    const phase = g.preCommit === 'final' ? 'final' : 'main';
    const fix = g.fix ?? `investigate with \`npm run ${g.impl}\``;
    if (g.preCommit === 'always') {
      // Same arity as the reach triggers — a mixed-arity union breaks typed
      // consumers (TS resolves a union of signatures to the stricter one).
      legs.push({ id: g.id, script: g.impl, phase, fix, triggered: (_ctx) => true });
      continue;
    }
    const patterns = new Set(['package.json']);
    for (const row of reach) {
      if (row.guardedBy === 'declared-gap' || !row.guardedBy.includes(g.id)) continue;
      for (const f of row.files) patterns.add(norm(f));
    }
    const impl = implPathFrom(packageScripts[g.impl]);
    if (impl) patterns.add(norm(impl));
    const matchers = [...patterns].map((p) => ({ p, re: isGlob(p) ? globToRegExp(p) : null }));
    const widen = CUSTOM_WIDENING[g.id];
    legs.push({
      id: g.id,
      script: g.impl,
      phase,
      fix,
      triggered: ({ root, staged, git }) => {
        const hit = staged.some((s) => {
          const n = norm(s);
          return matchers.some((m) => (m.re ? m.re.test(n) : m.p === n));
        });
        if (hit) return true;
        if (!widen) return false;
        // Omit `git` when the caller did, so the widening's own default runner
        // (which carries `.status` for the staged-pickaxe scans) kicks in.
        return widen(git ? { root, staged, git } : { root, staged });
      },
    });
  }
  // Subject-keyed pin legs ride along in the SAME list and the SAME shape, so
  // both consumers run them through identical wiring (scriptWired, the
  // announced unwired-skip, the fix hint) rather than growing a parallel loop.
  // Their trigger reads the staged set the caller passes to `triggered`, so the
  // binding is evaluated per call exactly like a reach trigger. Phase 'main':
  // they are not the broad-corpus check the ordering rule protects.
  for (const [subject, tests] of PINS) {
    for (const test of tests) {
      legs.push({
        id: `pin:${test}`,
        // No npm script — the leg IS a test file, run by path. `scriptWired`
        // would read `package.json` for a script named after the path and
        // report it unwired, so `testPath` marks it for the runners below.
        script: test,
        testPath: test,
        pinSubject: subject,
        phase: 'main',
        fix:
          `\`${subject}\` is staged and \`${test}\` pins a fact it owns, so that pin is OBLIGED — this ` +
          `is exactly how a shared expectation literal went red in CI on 2026-08-29 (one copy updated, ` +
          `the other found shard-by-shard). Update the pin in the same change, or drop the row from ` +
          `PINS in scripts/shared/derived-file-preflight.mjs if the binding no longer holds.`,
        triggered: ({ staged }) => (staged ?? []).map(norm).includes(norm(subject)),
      });
    }
  }
  return [
    ...legs.filter((l) => l.phase === 'main'),
    ...legs.filter((l) => l.phase === 'final'),
  ];
}

/**
 * Draw the cheap file-scoped legs for one edited path from the same registry
 * and reach data as the commit gate. These are hints only; the commit gate
 * remains the authority over the complete staged tree.
 */
export function buildWriteTimeLegs(
  filePath,
  { root = process.cwd(), guards = GUARDS, reach = REACH, packageScripts = {} } = {},
) {
  const normalized = norm(isAbsolute(filePath) ? relative(root, filePath) : filePath);
  const writeTime = new Map(
    guards
      .filter((guard) => guard.kind === 'gate' && guard.writeTime?.scope === 'file')
      .map((guard) => [guard.id, guard.writeTime]),
  );
  return buildPreCommitLegs({ guards, reach, packageScripts })
    .filter((leg) => writeTime.has(leg.id) && leg.triggered({ root, staged: [normalized] }))
    .map((leg) => ({ ...leg, maxMs: writeTime.get(leg.id)?.maxMs ?? 1000 }));
}

/**
 * Run write-time legs as advisory observations. A failed check is returned as
 * data; this function never throws for a leg result and never owns an exit
 * code, so a caller cannot accidentally turn an intermediate edit into a gate.
 */
export function runWriteTimeAdvisories({
  root,
  filePath,
  packageScripts = readPackageScripts(root),
  execute = execSync,
}) {
  const findings = [];
  const skipped = [];
  for (const leg of buildWriteTimeLegs(filePath, { root, packageScripts })) {
    if (!scriptWired(root, leg.script)) {
      skipped.push(`${leg.script} is not wired in this repo`);
      continue;
    }
    try {
      execute(`npm run ${leg.script}`, /** @type {any} */ ({
        cwd: root,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: leg.maxMs,
        windowsHide: true,
      }));
    } catch (error) {
      const tail = `${/** @type {any} */ (error).stdout ?? ''}\n${/** @type {any} */ (error).stderr ?? ''}`
        .trim()
        .split('\n')
        .slice(-20)
        .join('\n');
      findings.push({ id: leg.id, script: leg.script, fix: leg.fix, tail });
    }
  }
  return { findings, skipped };
}

function readPackageScripts(root) {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts ?? {};
  } catch {
    return {};
  }
}

/**
 * Attest-side preflight: run exactly the derived pre-commit legs the gate
 * would run for this staged set — ALL of them, phase-'final' included (a
 * doc-links failure forces a tracked-file edit and voids an attestation the
 * same way a stale index does). An unwired leg FAILS OPEN with an announcement
 * (matching the gate's noteFailOpen parity) — a missing script must never make
 * a repo un-attestable.
 *
 * ── ATTRIBUTABILITY: why a leg result is not always a verdict ────────────────
 * The legs run in the real root (an npm script, or a pinned test file), so every
 * one of them reads the WORKING TREE. The attestation binds to the STAGED tree
 * (`git write-tree`).
 * When those two trees differ, a leg's result describes the disk and not the
 * object being bound — and refusing on it is a false red. That is not
 * hypothetical: an UNSTAGED guard-registry row naming a not-yet-tracked test
 * file (both belonging to a LATER commit) refused an attestation of a staged set
 * that contained neither, and forced a commit reorder.
 *
 * The fix is a TREE-IDENTITY gate, not an attribution heuristic. A refusal is
 * issued only when the worktree tree equals `stagedTree` BEFORE and AFTER the
 * legs run. Under that equality every tracked byte on disk IS the staged tree,
 * and equality also implies zero untracked files (`add -A` would otherwise move
 * the hash) — so even the legs that enumerate `git ls-files --others` see the
 * bound object. cwd, $HOME and gitignored state are the same ones the gate will
 * see. The AFTER snapshot is not decoration: it closes the window in which a
 * concurrent session edits this shared checkout while the legs run.
 *
 * Per-leg attribution by declared REACH was measured and REJECTED. Reach is safe
 * as a TRIGGER, because an under-declaration only means a leg does not fire; it
 * is unsound as ATTRIBUTION, because an under-declaration would stamp a refusal
 * as proven. `check-guard-reach.mjs` states verbatim that a row's stated reach
 * may be narrower than its guard's true inputs, so the registry explicitly
 * declines to maintain the invariant such attribution would need.
 *
 * Every failure mode degrades toward ABSTENTION, never toward refusal: a null
 * tree id, a torn read, a git fault. The mechanism cannot manufacture a false
 * red — which is the defect class it exists to remove.
 *
 * Returns `{ failures, skipped, attributable, abstention, stagedTree,
 * worktreeTreeBefore, worktreeTreeAfter, unattributed }`. `failures` is non-empty
 * ONLY when attributable, so the caller's existing refusal is now sound as
 * written. On the abstaining path every executed leg — failed AND passed — lands
 * in `unattributed`, because the false-GREEN half (an unstaged fix masking a
 * broken staged tree) is today completely silent.
 *
 * `abstention` NAMES the divergence, or is null when the preflight reached a
 * verdict. "No verdict" and "the checks passed" are otherwise the same shape to
 * a caller, and the divergent case is the one where the caller most needs to
 * know which of the two it is holding: a `failures.length === 0` result reads
 * identically whether every leg judged the bound tree green or no leg judged it
 * at all. The reason string is built here, where the two tree ids are in hand,
 * so no caller has to reconstruct which side moved.
 */
/**
 * @param {{root: string, staged: string[], stagedTree: string, git?: Function}} options
 */
export function runDerivedFilePreflight({ root, staged, stagedTree, git }) {
  if (typeof stagedTree !== 'string' || stagedTree.trim() === '') {
    // The object judged must be the object bound. A caller that cannot name it
    // has no business receiving a verdict about it.
    throw new TypeError(
      'runDerivedFilePreflight requires `stagedTree` — the tree id the attestation binds to',
    );
  }
  const worktreeTreeBefore = worktreeTree(root);
  /** @type {{id: string, script: string, fix: string, tail: string, outcome: 'passed'|'failed'}[]} */
  const executed = [];
  const skipped = [];
  for (const leg of buildPreCommitLegs({ packageScripts: readPackageScripts(root) })) {
    if (!leg.triggered(git ? { root, staged, git } : { root, staged })) continue;
    // Gate legs are npm scripts, pin legs are test files — the KIND is a
    // property of the leg, so both the runnability probe and the command come
    // from the one shared decision (legRunnable / legCommand) rather than from
    // this caller re-deriving `npm run` for a leg that is not an npm script.
    if (!legRunnable(root, leg)) {
      skipped.push(`${leg.script} is not wired in this repo — preflight leg SKIPPED (fail-open)`);
      continue;
    }
    // The legs run even on the abstaining path: their output is still the
    // advisory the operator wants, and short-circuiting would create a second
    // code path that can drift from the gate's leg set.
    try {
      execSync(legCommand(leg).command, /** @type {any} */ ({
        cwd: root,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
        windowsHide: true,
      }));
      executed.push({ id: leg.id, script: leg.script, fix: leg.fix, tail: '', outcome: 'passed' });
    } catch (err) {
    const tail = `${/** @type {any} */ (err).stdout ?? ''}\n${/** @type {any} */ (err).stderr ?? ''}`.trim().split('\n').slice(-12).join('\n');
      executed.push({ id: leg.id, script: leg.script, fix: leg.fix, tail, outcome: 'failed' });
    }
  }
  const worktreeTreeAfter = worktreeTree(root);
  const attributable =
    worktreeTreeBefore !== null &&
    worktreeTreeAfter !== null &&
    worktreeTreeBefore === stagedTree &&
    worktreeTreeAfter === stagedTree;
  const failures = attributable
    ? executed
        .filter((e) => e.outcome === 'failed')
        .map(({ id, script, fix, tail }) => ({ id, script, fix, tail }))
    : [];
  const short = (t) => (typeof t === 'string' && t !== '' ? t.slice(0, 12) : 'unknown');
  let abstention = null;
  if (!attributable) {
    if (worktreeTreeBefore === null || worktreeTreeAfter === null) {
      abstention = {
        reason:
          `the preflight could not read the worktree tree (${worktreeTreeBefore === null ? 'before' : 'after'} ` +
          `the legs ran, it came back null), so it cannot say whether the legs judged the staged tree`,
      };
    } else if (worktreeTreeBefore !== worktreeTreeAfter) {
      abstention = {
        reason:
          `the worktree CHANGED while the legs ran (${short(worktreeTreeBefore)} → ${short(worktreeTreeAfter)}), ` +
          `so the legs judged at least two different trees and neither is the staged tree (${short(stagedTree)})`,
      };
    } else {
      abstention = {
        reason:
          `the worktree is not the staged tree (worktree ${short(worktreeTreeBefore)}, staged ${short(stagedTree)})`,
      };
    }
  }
  return {
    failures,
    skipped,
    attributable,
    abstention,
    stagedTree,
    worktreeTreeBefore,
    worktreeTreeAfter,
    unattributed: attributable ? [] : executed,
  };
}
