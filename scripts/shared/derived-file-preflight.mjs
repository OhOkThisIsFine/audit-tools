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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { isGlob, globToRegExp } from '../check-doc-manifest.mjs';
import { GUARDS, REACH } from '../guard-reach-data.mjs';
import { OPEN_ITEMS_RELPATH, PREMISE_GREP_PATHSPECS } from '../nightly/items.mjs';

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
  return [...legs.filter((l) => l.phase === 'main'), ...legs.filter((l) => l.phase === 'final')];
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
 * a repo un-attestable. Returns { failures, skipped }; the caller refuses to
 * bind when failures is non-empty.
 */
export function runDerivedFilePreflight({ root, staged, git }) {
  const failures = [];
  const skipped = [];
  for (const leg of buildPreCommitLegs({ packageScripts: readPackageScripts(root) })) {
    if (!leg.triggered(git ? { root, staged, git } : { root, staged })) continue;
    if (!scriptWired(root, leg.script)) {
      skipped.push(`${leg.script} is not wired in this repo — preflight leg SKIPPED (fail-open)`);
      continue;
    }
    try {
      execSync(`npm run ${leg.script}`, {
        cwd: root,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
        windowsHide: true,
      });
    } catch (err) {
      const tail = `${err.stdout ?? ''}\n${err.stderr ?? ''}`.trim().split('\n').slice(-12).join('\n');
      failures.push({ id: leg.id, script: leg.script, fix: leg.fix, tail });
    }
  }
  return { failures, skipped };
}
