// Single source for the pre-commit gate's DERIVED-FILE trigger predicates and
// their check commands — imported by `.claude/hooks/pre-commit-gate.mjs` AND
// both attest scripts (P19, owner decision sol-1, 2026-08-12).
//
// The trap this exists to remove: an attestation binds to the exact staged
// tree (`git write-tree`), but the gate that judges that tree runs later, at
// `git commit`. When a derived file (backlog seek index, HANDOFF roadmap, doc
// manifest, guard-reach registry) is stale, the gate demands a regeneration
// that edits a tracked file — which changes the staged tree and voids the
// attestation that was just written, so the same review is attested twice
// (4 records / 3 dates; S1 100b9117 verbatim in HANDOFF). The attest scripts
// therefore run the SAME derived-file checks the gate will run, BEFORE
// binding, and refuse to write an attestation for a tree the gate would
// reject. Nothing is bound, so nothing is wasted.
//
// These predicates must never be copied — five copies of a guard hid two bugs
// once already. The gate imports the predicates from here and keeps its own
// per-leg block messages; the attest scripts consume runDerivedFilePreflight.
//
// Deliberately NOT covered: the doc-contract test leg (up to 240s) — including
// it would make attest cost as much as the gate. This module owns the four
// derived-file legs, whose failures are the ones that force a tracked-file
// edit. That bound is stated in docs/backlog/durable-traps.md.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
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

// 2b. Doc-manifest reconciliation — whenever the staged set carries ANY
// markdown or the canonical manifest data that renders the guidelines table.
// (The checker reconciles the WHOLE tracked markdown tree; a trigger narrower
// than the check it fires plants violations the gate never runs on.)
export function pinsDocManifest(p) {
  const n = norm(p);
  return /\.md$/i.test(n) || n === 'scripts/doc-manifest-data.mjs';
}

// 2b-iii. Backlog seek-index parity — whenever the staged set touches
// `docs/backlog.md` or any `docs/backlog/*.md`.
export function pinsBacklogIndex(p) {
  const n = norm(p);
  return n === 'docs/backlog.md' || /^docs\/backlog\/[^/]+\.md$/.test(n);
}

// 2b-i. Guard-reach reconciliation is UNCONDITIONAL when wired — tree
// membership changes on ANY staged add/delete/rename, so there is no narrower
// honest trigger. Repos that don't wire the script (fixture repos) skip with
// an ANNOUNCED fail-open.
export function guardReachWired(root) {
  try {
    return Boolean(
      JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts?.['check:guard-reach'],
    );
  } catch {
    return false;
  }
}

// 2b-ii. HANDOFF generated-state parity — whenever the staged set touches
// HANDOFF, a backlog source, the persisted nightly queue, its decision ledger,
// a current premise-probe source, or the code that projects those sources.
// Positive probes use repo-wide git-grep for rename/move protection, so a
// staged pickaxe hit on a probe needle outside probe.file can change a
// presentation-time verdict too — both scans ride the staged snapshot.
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

// The four derived-file checks, keyed by what regenerates them — the fix line
// is what an attest refusal prints, so it must name the exact command.
export const DERIVED_FILE_CHECKS = [
  {
    id: 'doc-manifest',
    script: 'check:doc-manifest',
    fix: 'register the doc in scripts/doc-manifest-data.mjs and re-render with `node scripts/check-doc-manifest.mjs --write`',
  },
  {
    id: 'guard-reach',
    script: 'check:guard-reach',
    fix: 'register the file or guard in scripts/guard-reach-data.mjs',
  },
  {
    id: 'handoff-roadmap',
    script: 'check:handoff-roadmap',
    fix: 'run `node scripts/shared/generate-handoff-roadmap.mjs`, then re-stage docs/HANDOFF.md',
  },
  {
    id: 'backlog-index',
    script: 'check:backlog-index',
    fix: 'run `node scripts/shared/generate-backlog-index.mjs`, then re-stage docs/backlog.md',
  },
];

function scriptWired(root, script) {
  try {
    return Boolean(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts?.[script]);
  } catch {
    return false;
  }
}

/** Which of the four checks the gate would run for this staged set. */
export function evaluateTriggeredChecks({ root, staged, git }) {
  const triggered = [];
  if (staged.some(pinsDocManifest)) triggered.push('doc-manifest');
  triggered.push('guard-reach'); // unconditional when wired — see above
  if (handoffStateTriggered({ root, staged, git })) triggered.push('handoff-roadmap');
  if (staged.some(pinsBacklogIndex)) triggered.push('backlog-index');
  return DERIVED_FILE_CHECKS.filter((c) => triggered.includes(c.id));
}

/**
 * Attest-side preflight: run exactly the derived-file checks the gate would
 * run for this staged set. An unwired check FAILS OPEN with an announcement
 * (matching the gate's noteFailOpen parity) — a missing script must never make
 * a repo un-attestable. Returns { failures, skipped }; the caller refuses to
 * bind when failures is non-empty.
 */
export function runDerivedFilePreflight({ root, staged, git }) {
  const failures = [];
  const skipped = [];
  for (const check of evaluateTriggeredChecks({ root, staged, git })) {
    if (!scriptWired(root, check.script)) {
      skipped.push(`${check.script} is not wired in this repo — preflight leg SKIPPED (fail-open)`);
      continue;
    }
    try {
      execSync(`npm run ${check.script}`, {
        cwd: root,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
        windowsHide: true,
      });
    } catch (err) {
      const tail = `${err.stdout ?? ''}\n${err.stderr ?? ''}`.trim().split('\n').slice(-12).join('\n');
      failures.push({ ...check, tail });
    }
  }
  return { failures, skipped };
}
