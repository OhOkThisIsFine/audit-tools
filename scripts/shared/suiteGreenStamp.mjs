// sites-pinned: tests/shared/suite-green-stamp.test.ts, tests/shared/ledger-suite-transition.test.ts
// Evidence that the FULL suite went green on a specific worktree CONTENT.
//
// The trap this closes: a suite run BEFORE the last edit is not evidence for
// the tree you push — an edit of ANY kind after a green run invalidates that
// run (except the bounded producer transition below), and no local gate
// re-runs the full suite, so a late edit reached CI
// unseen (two commits shipped red on 2026-08-27 this exact way). The HANDOFF
// half is enforced by the pre-commit doc leg (053c4a28's test move); this stamp
// enforces the general half as closeout-challenge evidence. Discipline is what
// this repo bans wherever a property can be guaranteed mechanically.
//
// The identity is the same tree object the closeout record already binds to
// (scripts/shared/worktree-tree.mjs), for the same reason: committing exactly
// what the green run covered keeps the stamp valid, while any further edit
// correctly invalidates it. The stamp lands under .claude/hooks/.state/, which is
// gitignored, so writing it cannot change the tree it just described.
//
// A FILTERED run is not full-suite evidence. `npm test` and `verify:release`
// invoke the gate with no argv; every narrower caller (test:doc-contract passes
// file paths, verify:guards passes --retry/--exclude) passes at least one. So an
// empty argv IS the predicate — no allowlist to maintain, and a new filtered
// caller cannot accidentally mint full-suite evidence. The CI shard runs
// (`--shard=N/4`) are whole-suite runs that carry an argument, so they do NOT
// mint a stamp — by design: CI pipelines never reach the Stop-gate closeout
// this evidence feeds, and a shard alone is not whole-tree evidence anyway.
import { hashContent } from './primitives.mjs';
import { spawnSync } from 'node:child_process';
import { LEDGER_PATH, verifyLedger } from './loopCoreAttestationLedger.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { worktreeTrees } from './worktree-tree.mjs';

/**
 * Is this gate invocation a full-suite run, i.e. one whose green result is
 * evidence about the whole tree rather than about a subset?
 * @param {string[]} vitestArgs argv handed to scripts/shared/run-vitest-gate.mjs
 * @returns {boolean}
 */
export function isFullSuiteRun(vitestArgs) {
  return Array.isArray(vitestArgs) && vitestArgs.length === 0;
}

/**
 * ⚠ This stays keyed on the CHECKOUT, and that is deliberate — do not "fix" it to
 * match the session registry beside it. The registry keys on the REPOSITORY (its
 * common git dir) because a session is a fact about the repository, and keying it
 * on the checkout made its arming a property of how a worktree was created. This
 * stamp is the opposite case: it binds a TREE, and two worktrees of one repository
 * have different trees, so a repository-wide stamp would certify one worktree's
 * green as evidence for another's content. Two identities, two reasons.
 * @param {string} root
 * @returns {string}
 */
export function suiteGreenStampPath(root) {
  return join(root, '.claude', 'hooks', '.state', 'suite-green', 'latest.json');
}

/**
 * Record a full-suite green against the tree it ran on. Best-effort: a stamp that
 * cannot be written must never fail a green suite, and a MISSING stamp already
 * reads as "no evidence" downstream, which is the safe direction.
 *
 * `bumpAgnosticTree` is the RELEASE-BUMP-DELTA half (see `worktreeTrees` in
 * `worktree-tree.mjs`): the same content with the two `"version"` values masked.
 * One release costs one extra full local suite (~3.2 min) to re-certify a
 * two-line version change the publish run's own sharded suite already runs, and
 * no batching avoids it — the bump is the LAST local edit by construction. The
 * masked identity is what makes that re-run unnecessary; it is absent on a tree
 * whose id could not be taken, which reads as "no bump evidence" downstream.
 *
 * The masked id is recorded ONLY when the caller's `tree` is the checkout's own
 * tree — i.e. when both ids describe the same content. A stamp that named tree A
 * while carrying content B's masked id would certify a bump delta against
 * content the stamp never covered, which is the false green this whole file
 * exists to prevent; a mismatch records `null` and reads as "no bump evidence".
 * @param {string} root
 * @param {string | null} tree tree id, or null when it could not be taken
 * @param {object | null} [runEvidence] Original token-matched, unfiltered runner evidence.
 * @returns {boolean} whether a stamp was written
 */
export function writeSuiteGreenStamp(root, tree, runEvidence = null) {
  if (!tree || (runEvidence !== null && !validRunEvidence(runEvidence, tree))) return false;
  const path = suiteGreenStampPath(root);
  try {
    const trees = worktreeTrees(root);
    const bumpAgnosticTree = trees?.tree === tree ? (trees.bumpAgnosticTree ?? null) : null;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          tree,
          ...(runEvidence === null ? {} : { run_evidence: runEvidence }),
          bump_agnostic_tree: bumpAgnosticTree,
          ran_at: new Date().toISOString(),
          session_id: process.env.CLAUDE_SESSION_ID ?? null,
        },
        null,
        2,
      )}\n`,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} root
 * @returns {{ tree?: string, bump_agnostic_tree?: string|null, ran_at?: string } | null} null when absent/unreadable
 */
export function readSuiteGreenStamp(root) {
  try {
    return JSON.parse(readFileSync(suiteGreenStampPath(root), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Decide whether a recorded full-suite run certifies the current worktree.
 * This pure seam judges exact and release-version-only evidence. The
 * root-aware qualification seam below adds the official ledger transition
 * for landing, push, closeout readiness and the owned status CLI.
 *
 * `currentTree` may be either a bare tree id (the pre-existing shape, which
 * keeps every existing caller correct) or the pair from `worktreeTrees`, which
 * additionally admits a BUMP-ONLY delta — a content difference that is exactly
 * the release version values, and nothing else. Both sides of that comparison
 * must be present and equal; a missing masked id on either side is "cannot
 * tell", never a match, so a stamp written before this mechanism existed does
 * not silently certify a bumped tree.
 *
 * @param {{tree?: string, bump_agnostic_tree?: string|null, ran_at?: string} | null} stamp
 * @param {string | {tree: string|null, bumpAgnosticTree: string|null} | null} currentTree
 * @returns {{ok: true, tree: string, ranAt: string | null, viaBumpDelta: boolean} | {ok: false, reason: string}}
 */
export function suiteGreenVerdict(stamp, currentTree) {
  const current =
    typeof currentTree === 'string' || currentTree === null
      ? { tree: currentTree, bumpAgnosticTree: null }
      : currentTree;
  if (!current?.tree) {
    return { ok: false, reason: 'could not compute the current worktree tree' };
  }
  if (!stamp?.tree) {
    return { ok: false, reason: 'no full-suite green stamp exists for this checkout' };
  }
  if (stamp.tree === current.tree) {
    return { ok: true, tree: current.tree, ranAt: stamp.ran_at ?? null, viaBumpDelta: false };
  }
  // The release-bump delta: the two contents differ only by the version values
  // the release script itself rewrites. Strictly bounded — both masked ids must
  // exist and be equal, which a dependency bump, a script edit or any other
  // change cannot satisfy.
  if (
    stamp.bump_agnostic_tree &&
    current.bumpAgnosticTree &&
    stamp.bump_agnostic_tree === current.bumpAgnosticTree
  ) {
    return { ok: true, tree: current.tree, ranAt: stamp.ran_at ?? null, viaBumpDelta: true };
  }
  return {
    ok: false,
    reason: `the last full-suite green covered different content (${stamp.tree.slice(0, 12)} != ${current.tree.slice(0, 12)})`,
  };
}

// Local writable evidence is an attributable audit record, not an authentication
// boundary. Preserve the real stamp on A; never mint a fictional full run on B.
const TRANSITION_PRODUCER = 'attest-loop-core-review/ledger-only-v1';
const treeId = (value) => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);

/** @param {any} evidence @param {string} tree */
function validRunEvidence(evidence, tree) {
  const outcome = evidence?.reporter?.outcome;
  return Boolean(evidence && typeof evidence.run_token === 'string' && evidence.run_token &&
    evidence.reporter?.runToken === evidence.run_token && isFullSuiteRun(evidence.vitest_args) &&
    evidence.tree_before === tree && evidence.tree_after === tree &&
    outcome?.failed === 0 && outcome?.unfinished === 0 && outcome?.passed > 0 &&
    Number.isInteger(outcome.passed) && Number.isInteger(outcome.skipped) && outcome.skipped >= 0 &&
    outcome.total === outcome.passed + outcome.skipped &&
    Array.isArray(outcome.failedFiles) && outcome.failedFiles.length === 0);
}

function transitionGit(root) {
  /** @param {string[]} args @param {BufferEncoding} [encoding] */
  const git = (args, encoding = 'utf8') => {
    const r = spawnSync('git', args, { cwd: root, encoding, windowsHide: true, maxBuffer: Infinity });
    return { ok: r.status === 0 && !r.error, stdout: r.stdout ?? '' };
  };
  return git;
}

// Compare every entry, including mode/type, additions and deletions. No path
// exclusion, source fingerprint, rename heuristic or comparison to the index.
function ledgerOnlyBlob(git, from, to) {
  if (!treeId(from) || !treeId(to) || from === to) return null;
  const entries = (tree) => {
    // Latin-1 preserves every filename byte; UTF-8 replacement characters can
    // collapse distinct invalid-byte Git names into the same map key.
    const r = git(['ls-tree', '-r', '-t', '-z', '--full-tree', tree], 'latin1');
    if (!r.ok) return null;
    const map = new Map();
    for (const entry of r.stdout.split('\0').filter(Boolean)) {
      const tab = entry.indexOf('\t');
      if (tab < 0) return null;
      // Tree identities change for ledger ancestors; compare their presence and
      // mode/type, with every descendant compared separately (even empty trees).
      const meta = entry.slice(0, tab);
      map.set(entry.slice(tab + 1), meta.startsWith('040000 tree ') ? '040000 tree' : meta);
    }
    return map;
  };
  const a = entries(from), b = entries(to);
  if (!a || !b) return null;
  const changed = [...new Set([...a.keys(), ...b.keys()])].filter((path) => {
    if (a.get(path) === b.get(path)) return false;
    // Only the exact ledger's newly created directory ancestors may accompany
    // an addition. Extra (including empty) descendants still differ below.
    return !(LEDGER_PATH.startsWith(`${path}/`) && !a.has(path) && b.get(path) === '040000 tree');
  });
  if (changed.length !== 1 || changed[0] !== LEDGER_PATH) return null;
  const after = b.get(LEDGER_PATH)?.match(/^100644 blob ([a-f0-9]+)$/);
  if (!after || (a.has(LEDGER_PATH) && !a.get(LEDGER_PATH).startsWith('100644 blob '))) return null;
  return after[1];
}

/**
 * Called only by the official producer after an attributable, unchanged-A
 * preflight. Consumers independently recheck the immutable trees and ledger.
 * A missing original runner record simply leaves the existing full-suite path.
 * @param {string} root @param {string} from @param {string} to
 * @param {string} originalStamp exact bytes read before the producer runs checks
 */
export function ledgerSuiteTransition(root, from, to, originalStamp) {
  try {
    const stamp = JSON.parse(originalStamp);
    if (stamp.tree !== from || !validRunEvidence(stamp.run_evidence, from) ||
        readFileSync(suiteGreenStampPath(root), 'utf8') !== originalStamp) return null;
    const git = transitionGit(root);
    const blob = ledgerOnlyBlob(git, from, to);
    if (!blob || worktreeTrees(root)?.tree !== to) return null;
    // The transition is eligible for protected destinations, even if produced
    // on a feature branch. The destination's consumer checks again below.
    const ledger = verifyLedger({ git, rev: to, concernsBlock: true });
    if (ledger.fault || ledger.problems.length) return null;
    return { producer: TRANSITION_PRODUCER, from_tree: from, to_tree: to, ledger_blob: blob,
      original_stamp: originalStamp, original_stamp_sha256: hashContent(originalStamp) };
  } catch { return null; }
}

/**
 * One qualification policy for landing, pushed source trees and readiness.
 * Existing exact and release-only evidence is unchanged. A transition never
 * updates that evidence and cannot be composed with the release exception.
 * @param {string} root
 * @param {string | {tree: string|null, bumpAgnosticTree: string|null} | null} currentTree
 * @param {{concernsBlock: boolean}} options Actual destination policy; readiness uses the stricter protected policy.
 * @returns {{ok: true, tree: string, ranAt: string|null, viaBumpDelta: boolean, viaLedgerTransition: boolean} | {ok: false, reason: string}}
 */
export function suiteQualificationVerdict(root, currentTree, { concernsBlock }) {
  const stamp = readSuiteGreenStamp(root);
  const ordinary = suiteGreenVerdict(stamp, currentTree);
  if (ordinary.ok) return { ...ordinary, viaLedgerTransition: false };
  const tree = typeof currentTree === 'string' ? currentTree : currentTree?.tree;
  if (typeof tree !== 'string' || !treeId(tree)) return ordinary;
  try {
    const record = JSON.parse(readFileSync(join(root, '.claude', 'loop-core-review', `${tree}.json`), 'utf8'));
    const t = record.suite_transition;
    const original = readFileSync(suiteGreenStampPath(root), 'utf8');
    const parsed = JSON.parse(original);
    if (record.schema_version !== 'loop-core-review/v2' || record.staged_tree !== tree ||
        record.verdict !== 'clear' || !record.preflight?.attributable || record.preflight.abstention ||
        t?.producer !== TRANSITION_PRODUCER || t.to_tree !== tree || parsed.tree !== t.from_tree ||
        record.preflight.staged_tree !== t.from_tree ||
        record.preflight.worktree_tree_before !== t.from_tree || record.preflight.worktree_tree_after !== t.from_tree ||
        t.original_stamp !== original || t.original_stamp_sha256 !== hashContent(original) ||
        !validRunEvidence(parsed.run_evidence, t.from_tree) ||
        record.tests_ran?.scope !== 'full-suite' || record.tests_ran.tree !== t.from_tree ||
        record.tests_ran.ran_at !== parsed.ran_at) return ordinary;
    const git = transitionGit(root);
    if (ledgerOnlyBlob(git, t.from_tree, tree) !== t.ledger_blob || !t.ledger_blob) return ordinary;
    const ledger = verifyLedger({ git, rev: tree, concernsBlock });
    if (ledger.fault || ledger.problems.length) return ordinary;
    return { ok: true, tree, ranAt: parsed.ran_at ?? null, viaBumpDelta: false, viaLedgerTransition: true };
  } catch { return ordinary; }
}
