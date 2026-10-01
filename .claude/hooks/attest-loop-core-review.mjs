#!/usr/bin/env node
//
// Producer for the loop-core adversarial-review gate (pre-commit-gate.mjs).
//
// Hand-authored (non-node) edits to the dispatch / admission / quota / rolling /
// orchestrator-step substrate carry the highest blast radius; the pre-commit
// gate blocks a commit whose STAGED set touches a loop-core path unless a FRESH,
// staged-tree-hash-bound review attestation exists. This tool WRITES that
// attestation after the adversarial review is performed — it binds the review
// to the exact staged tree (`git write-tree`), so any later restage invalidates
// it and forces a re-review. It also records the reviewed CONTENT (each
// loop-core path's blob id) in the tracked ledger `.claude/loop-core-attestations.json`
// and stages it: that is the evidence `check:loop-core-attestations` reads in CI
// and at release, where the local record does not exist
// (scripts/shared/loopCoreAttestationLedger.mjs).
//
// It enforces attestation existence + freshness + binding MECHANICALLY. It does
// NOT — and running on the same machine as the agent, CANNOT — establish that a
// human reviewed: any credential it could check is a credential the agent can
// reach. The honest artifact is an attributable, tree-bound audit record that
// carries what actually happened: the attester's CLASS (agent or human, the
// REQUIRED --attester-class), the reviewing identities (--reviewed-by), and the
// detected session environment (agent-session markers recorded independently of
// the claim, so a self-issued clearance reads as one after the fact).
//
// Usage:
//   node .claude/hooks/attest-loop-core-review.mjs \
//     --reviewed-by <id> \
//     --attester-class agent|human \
//     --checked "<>=20 chars describing the adversarial review performed>" \
//     [--verdict clear|concerns] [--override "<reason>"] \
//     [--include-unvouched <path>]...
//
//   --reviewed-by     reviewer id (default: git user.name)
//   --attester-class  REQUIRED; who is RUNNING this attestation — `agent` when any
//                     AI agent/session issues it (even relaying a human's words),
//                     `human` only when a person types this command themselves
//   --checked         REQUIRED; what was adversarially checked (>= 20 non-space chars)
//   --verdict         clear (default) | concerns
//   --override        reason a `concerns` verdict may still pass the gate (recorded)
//   --include-unvouched  repeatable; a loop-core path OUTSIDE the staged set whose
//                     current content the ledger does not vouch for, which this
//                     review also covers. Each such path must be named: the
//                     attestation refuses rather than vouch for content silently.
//
// sites-pinned: tests/shared/loop-core-attestation-ledger.test.ts, tests/shared/attest-derived-file-preflight.test.ts, tests/shared/pre-commit-gate-attestation.test.ts
//   Each suite spawns this hook against a throwaway repo: the ledger suite
//   drives the ledger write/stage and --include-unvouched refusals, the
//   preflight suite the preflight-before-ledger ordering, and the gate suite
//   the tree-bound attestation record the pre-commit gate reads.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// git helper — never throws; callers branch on `.ok`.
function git(args) {
  const r = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: Infinity, // `ls-files -s` grows with the repository
    windowsHide: true,
  });
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: (r.stderr ?? '').trim() };
}

/** @returns {never} */
function fail(msg) {
  console.error(`attest-loop-core-review: ${msg}`);
  process.exit(1);
}

// ── loop-core predicate ──
// The pattern list and membership predicate are IMPORTED from a generated
// sibling, not re-declared: this runs under plain node pre-build and cannot
// import src/shared/loopCorePaths.ts, but it can import a .mjs generated FROM
// it. One hand-maintained home; drift is caught by
// `npm run check:loop-core-patterns` in verify:checks.
import { isLoopCorePath } from './loop-core-patterns.mjs';
import { runDerivedFilePreflight } from '../../scripts/shared/derived-file-preflight.mjs';
import { resolveNightlyDecisionKeys } from '../../scripts/shared/nightlyDecisionKey.mjs';
import {
  LEDGER_PATH,
  applyAttestation,
  loopCoreBlobs,
  readLedger,
  serializeLedger,
  unvouchedPaths,
} from '../../scripts/shared/loopCoreAttestationLedger.mjs';

// ── parse argv ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flags = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--reviewed-by') flags.reviewedBy = argv[++i];
  else if (a === '--attester-class') flags.attesterClass = argv[++i];
  else if (a === '--checked') flags.checked = argv[++i];
  else if (a === '--verdict') flags.verdict = argv[++i];
  else if (a === '--override') flags.override = argv[++i];
  else if (a === '--include-unvouched') (flags.includeUnvouched ??= []).push(argv[++i]);
  else if (a === '--help' || a === '-h') {
    console.log(
      'usage: attest-loop-core-review.mjs --reviewed-by <id> --attester-class agent|human ' +
        '--checked "<...>" [--verdict clear|concerns] [--override "<reason>"] [--include-unvouched <path>]...',
    );
    process.exit(0);
  } else fail(`unknown argument: ${a}`);
}

// --attester-class is REQUIRED: the record must state WHO issued it. `agent`
// covers any AI agent/session running this command (including on a human's
// behalf); `human` means a person typed it themselves. There is deliberately no
// default — defaulting would let the distinction be carried by omission, which
// is exactly the assumption this field replaces.
const attesterClass = (flags.attesterClass ?? '').trim();
if (attesterClass !== 'agent' && attesterClass !== 'human') {
  fail(
    '--attester-class is REQUIRED and must be "agent" or "human". State who is RUNNING this ' +
      'attestation: any AI agent/session must say "agent" (even when relaying a human review); ' +
      '"human" means a person typed this command themselves. The class is recorded, not enforced — ' +
      'it exists so a self-issued clearance is distinguishable from a human sign-off after the fact.',
  );
}

// Agent-session environment markers, detected independently of the claim. This
// is provenance, not enforcement: a record claiming `human` from a shell that
// carries agent-session markers is greppable as a contradiction after the fact.
const AGENT_ENV_MARKERS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'GEMINI_CLI'];
const agentEnvMarkers = AGENT_ENV_MARKERS.filter((k) => process.env[k] != null && process.env[k] !== '');

// ── what counts as ADMISSIBLE --checked evidence ─────────────────────────────
// The floor below is a floor on LENGTH, and length is not evidence. What makes
// the field worth anything is that it names a defect the writer went LOOKING
// for and the mechanism that would have caught it — a claim a later reader can
// check against the tree, not a verdict about the writer's own work.
//
//   ADMISSIBLE: a named defect class + the reach that was exercised, e.g.
//     "checked admission-ledger double-release on 429 backoff; reverted the
//      reservation guard and the ledger test went red"
//   NOT ADMISSIBLE — and this is the shape to refuse to write:
//     • "red-green validated" with nothing named — the author's word about
//       their own work. `npm run check:sites-pinned` derives a site list from
//       the diff, but its expected-failing TEST NAMES are author-supplied, so
//       ITS OUTPUT IS NOT ADMISSIBLE EITHER (it prints that admission itself).
//     • "all tests pass" / "the suite is green" — a fact about the tree, not
//       about what was reviewed.
//     • "reviewed by <agent>" alone — an identity, not a finding.
//
// The gate enforces existence, freshness, staged-tree binding and verdict; it
// deliberately does NOT grade this text. This block is here because the field
// is written HERE, and a rule that lives only in a doc is one nobody reads at
// the moment they are typing the sentence.
// --checked is REQUIRED and must describe a real review (>= 20 non-space chars).
const checked = (flags.checked ?? '').trim();
if (checked.replace(/\s/g, '').length < 20) {
  fail(
    'the --checked flag is REQUIRED and must be >= 20 non-space characters describing the ' +
      'adversarial review performed (what defects you actively looked for, e.g. ' +
      '"checked admission-ledger reservation accounting for double-release + off-by-one on 429 backoff"). ' +
      'This is the attributable human-review record.',
  );
}

const verdict = (flags.verdict ?? 'clear').trim();
if (verdict !== 'clear' && verdict !== 'concerns') {
  fail(`--verdict must be "clear" or "concerns" (got "${verdict}")`);
}
const override = flags.override != null ? String(flags.override).trim() : null;

// A `--override` is the decision-bearing free text on this side: it is where a
// review that raises concerns states the owner's call to proceed anyway, and it
// is recorded durably. An owner call that rests on a settled nightly question
// usually cites that question's key, and a typo in the record is a dangling
// reference nobody can later follow (2026-09-04: `cde41c31c1c6a7f3` recorded
// where the ledger held `cde41c31f1c6a7f3`; only a later `answer.mjs --done`
// noticed). A citation is mechanically checkable, so it is checked before the
// record is written. An absent or unreadable ledger FAILS OPEN — announced,
// never silent (see the module).
const keyCheck = resolveNightlyDecisionKeys(root, override ?? '');
if (!keyCheck.ok) {
  fail(
    `the --override ${keyCheck.reason}. ` +
      (keyCheck.suggestion
        ? `Did you mean "${keyCheck.suggestion}"? `
        : `Look the key up with \`node scripts/nightly/answer.mjs --list\`. `) +
      `The attestation is the durable audit record, so a key it cites must resolve.`,
  );
}
if (keyCheck.skipped) {
  console.error(
    `attest-loop-core-review: note — the nightly-ledger citation check was SKIPPED: ${keyCheck.skipped}. ` +
      `Any 16-hex key in --override is UNVERIFIED.`,
  );
} else if (keyCheck.keys.length > 0) {
  console.error(
    `attest-loop-core-review: resolved ${keyCheck.keys.length} nightly ledger key(s) cited by --override: ` +
      keyCheck.keys.join(', '),
  );
}


// reviewed-by defaults to git user.name.
let reviewedBy = (flags.reviewedBy ?? '').trim();
if (!reviewedBy) {
  const u = git(['config', 'user.name']);
  reviewedBy = u.ok ? u.stdout.trim() : '';
}
if (!reviewedBy) fail('could not determine --reviewed-by (no value given and git user.name unset)');

/// ── the staged set + what this attestation vouches for ─────────────────────────
function listStaged() {
  const cached = git(['diff', '--cached', '--name-only']);
  if (!cached.ok) fail(`could not list the staged set (\`git diff --cached\` failed). ${cached.stderr}`);
  return cached.stdout
    .split(/\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}
const stagedBeforeLedger = listStaged();
const stagedLoopCore = stagedBeforeLedger.filter(isLoopCorePath);

// The TRACKED ledger (scripts/shared/loopCoreAttestationLedger.mjs) is the
// evidence that travels with the tree, so CI and the release gate can judge a
// commit no local hook saw. This attestation vouches for every staged loop-core
// change. Loop-core content OUTSIDE the staged set that the ledger does not
// vouch for (a newly classified path, or content that landed without a review)
// is vouched for only when the attester NAMES each path with
// --include-unvouched: a review of a one-file change must not silently cover
// every unattested file in the tree. Entries for paths that are no longer
// tracked loop-core are dropped.
const blobs = loopCoreBlobs(git);
if (blobs === null) fail('could not list the index (`git ls-files -s` failed).');
const loadedLedger = readLedger(git);
if (loadedLedger.kind === 'corrupt') {
  fail(`the staged ${LEDGER_PATH} is unreadable (${loadedLedger.reason}); fix or remove it, then re-run.`);
}
const priorLedger = loadedLedger.kind === 'ok' ? loadedLedger.ledger : null;
const unvouched = unvouchedPaths(priorLedger, blobs);
const stagedLoopCoreSet = new Set(stagedLoopCore);
const unvouchedOutsideStaged = unvouched.filter((p) => !stagedLoopCoreSet.has(p));
const named = [...new Set((flags.includeUnvouched ?? []).map((p) => String(p ?? '').trim().replace(/\\/g, '/')))];
const notUnvouched = named.filter((p) => !unvouched.includes(p));
if (notUnvouched.length > 0) {
  fail(
    `--include-unvouched names ${notUnvouched.map((p) => `"${p}"`).join(', ')}, which ` +
      `${notUnvouched.length === 1 ? 'is' : 'are'} not loop-core content the ledger fails to vouch for. ` +
      (unvouchedOutsideStaged.length > 0
        ? `The unvouched loop-core paths outside the staged set are:\n${unvouchedOutsideStaged.map((p) => `  ${p}`).join('\n')}`
        : 'There is no unvouched loop-core content outside the staged set.'),
  );
}
const unnamed = unvouchedOutsideStaged.filter((p) => !named.includes(p));
if (unnamed.length > 0) {
  fail(
    `refusing to attest: ${unnamed.length} loop-core path(s) outside the staged set carry content ` +
      `${LEDGER_PATH} does not vouch for, and this review would bind a tree that contains them:\n` +
      unnamed.map((p) => `  ${p}`).join('\n') +
      `\nReview that content too, then name each path on the command line ` +
      `(${unnamed.map((p) => `--include-unvouched ${p}`).join(' ')}), ` +
      `or restore it to the content the ledger vouches for. Nothing was written.`,
  );
}
const loopCoreFiles = [...new Set([...stagedLoopCore, ...named])].sort();
const nextLedger = applyAttestation(priorLedger, blobs, loopCoreFiles, {
  reviewed_by: reviewedBy,
  attester_class: /** @type {'agent'|'human'} */ (attesterClass),
  checked,
  verdict: /** @type {'clear'|'concerns'} */ (verdict),
  override: override ?? null,
  attested_at: new Date().toISOString(),
});
// Changed = the serialized ledger differs from the staged one. With nothing to
// vouch for, the only possible change is dropping orphan entries; a repo with no
// ledger and no loop-core content gets no ledger at all.
const ledgerChanged =
  priorLedger === null
    ? loopCoreFiles.length > 0
    : serializeLedger(nextLedger) !== serializeLedger(priorLedger);
if (loopCoreFiles.length === 0 && !ledgerChanged) {
  fail('nothing loop-core to attest — the staged set touches no loop-core path and the ledger already vouches for every one.');
}

// ── P19: refuse to bind to a tree the gate would reject ────────────────────────
// The gate runs at commit time; this attestation is written earlier, so no
// arrangement of the gate's own legs can reach back to inform it. Run the same
// derived-file checks the gate will run (single-sourced module — never copied)
// and refuse to bind when one fails: a stale index is reported BEFORE any
// attestation exists, so the same review is never attested twice. An unwired
// check fails open with an announcement — a missing script must never make a
// repo un-attestable.
// No `git` passed: the module's own runner carries `.status`, which the
// staged-pickaxe scans branch on; this script's local helper does not.
// The legs read the WORKING tree; this attestation binds the STAGED tree. The
// preflight therefore refuses only when the two are the same object before AND
// after the legs run, and otherwise ABSTAINS — see the module's header.
//
// The preflight runs BEFORE the ledger is written, so a refusal leaves nothing
// behind: no record, no rewritten or staged ledger. It therefore judges the
// staged tree WITHOUT this run's ledger update — the only file this script then
// writes — and the ledger's own leg is excluded: it would judge the ledger
// before the write that makes it vouch for the staged change. The commit gate
// runs that leg on the final staged tree.
const preflightTree = git(['write-tree']);
if (!preflightTree.ok || !preflightTree.stdout.trim()) {
  fail(`\`git write-tree\` failed — not a git repo, or the index is unmerged. ${preflightTree.stderr}`);
}
const preflight = runDerivedFilePreflight({
  root,
  staged: stagedBeforeLedger,
  stagedTree: preflightTree.stdout.trim(),
  exclude: {
    'check:loop-core-attestations':
      `this attestation writes ${LEDGER_PATH} only after the preflight passes; the commit gate judges it`,
  },
});
for (const s of preflight.skipped) console.error(`attest-loop-core-review: note — ${s}`);
if (preflight.failures.length > 0) {
  for (const f of preflight.failures) {
    console.error(`\n✗ ${f.script} FAILED — fix: ${f.fix}\n${f.tail}`);
  }
  fail(
    'refusing to bind: the staged tree would be rejected by the pre-commit gate\'s derived-file ' +
      'checks above — verified against the staged tree (working tree is identical). ' +
      `Fix + re-stage, THEN attest — no review record was written and ${LEDGER_PATH} was not touched.`,
  );
}
if (preflight.abstention) {
  console.error(`\n… the preflight ABSTAINED — NOT a verdict about the staged tree: ${preflight.abstention.reason}`);
  for (const u of preflight.unattributed) {
    console.error(
      `  · ${u.script} ${u.outcome.toUpperCase()} — judged the WORKTREE, not the tree being bound` +
        (u.tail ? `\n${u.tail}` : ''),
    );
  }
  console.error(
    `\nattest-loop-core-review: the working tree is NOT identical to the staged tree ` +
      `(staged ${preflight.stagedTree}, worktree ${preflight.worktreeTreeBefore ?? 'unknown'}` +
      `${
        preflight.worktreeTreeAfter !== preflight.worktreeTreeBefore
          ? ` then ${preflight.worktreeTreeAfter ?? 'unknown'}`
          : ''
      }), so the results above describe the DISK, not the tree being bound. ` +
      `The pre-commit gate materializes the staged tree and judges it exactly at commit. ` +
      `Stage or set aside the divergence and re-run for a judged verdict.`,
  );
}

// ── write + stage the ledger, THEN compute the bound tree ─────────────────────
// Written and staged together, so the worktree and the staged tree move as one
// object and the preflight's tree identity carries over to the bound tree.
if (ledgerChanged) {
  const ledgerFile = join(root, ...LEDGER_PATH.split('/'));
  mkdirSync(dirname(ledgerFile), { recursive: true });
  writeFileSync(ledgerFile, serializeLedger(nextLedger), 'utf8');
  // -f: the ledger lives under `.claude/`, which is ignored except by name.
  const add = git(['add', '-f', '--', LEDGER_PATH]);
  if (!add.ok) fail(`could not stage ${LEDGER_PATH}. ${add.stderr}`);
}
const wt = git(['write-tree']);
if (!wt.ok || !wt.stdout.trim()) {
  fail(`\`git write-tree\` failed — nothing staged, or not a git repo. ${wt.stderr}`);
}
const sha = wt.stdout.trim();

const headRev = git(['rev-parse', 'HEAD']);
const gitHead = headRev.ok ? headRev.stdout.trim() : null;

// ── write the bound attestation ────────────────────────────────────────────────
const dir = join(root, '.claude', 'loop-core-review');
mkdirSync(dir, { recursive: true });
const attestPath = join(dir, sha + '.json');
const record = {
  schema_version: 'loop-core-review/v2',
  staged_tree: sha,
  reviewed_by: reviewedBy,
  // Who ISSUED this attestation (self-declared, required) vs. what the shell
  // environment says (detected). The pair makes a self-issued clearance read as
  // one: `attester_class: "agent"` is the honest path for any AI session, and a
  // `human` claim carrying agent_env_markers is a greppable contradiction.
  attester_class: attesterClass,
  agent_env_markers: agentEnvMarkers,
  checked,
  verdict,
  override: override ?? null,
  loop_core_files: loopCoreFiles,
  // What the preflight was actually able to establish about THIS tree. An
  // abstention is recorded as data rather than passing silently, so "the legs
  // were run" and "the legs judged the bound tree" stay distinguishable after
  // the fact. No schema_version bump: the field has no reader — the gate reads
  // staged_tree, verdict, override and freshness only. Its `staged_tree` is the
  // tree the preflight judged: the bound tree minus this run's ledger write.
  preflight: {
    attributable: preflight.attributable,
    staged_tree: preflight.stagedTree,
    worktree_tree_before: preflight.worktreeTreeBefore,
    worktree_tree_after: preflight.worktreeTreeAfter,
    abstention: preflight.abstention?.reason ?? null,
    unattributed: preflight.unattributed.map((u) => ({ id: u.id, outcome: u.outcome })),
  },
  git_head: gitHead,
  created_at: new Date().toISOString(),
};
writeFileSync(attestPath, JSON.stringify(record, null, 2) + '\n', 'utf8');

console.log(
  `attest-loop-core-review: wrote ${attestPath}\n` +
    `  staged_tree : ${sha}\n` +
    `  reviewed_by : ${reviewedBy}\n` +
    `  attester    : ${attesterClass}${agentEnvMarkers.length ? ` (env markers: ${agentEnvMarkers.join(', ')})` : ''}\n` +
    `  verdict     : ${verdict}${override ? ` (override: ${override})` : ''}\n` +
    `  loop_core   : ${loopCoreFiles.length} file(s)\n` +
    loopCoreFiles.map((p) => `                - ${p}`).join('\n') +
    (named.length > 0
      ? `\n  of which ${named.length} outside the staged set, named with --include-unvouched, carried content ` +
        `the ledger did not vouch for before this review.`
      : '') +
    (ledgerChanged ? `\n  ledger      : ${LEDGER_PATH} updated and staged — commit it with the change.` : '') +
    `\nThe pre-commit gate will now allow a commit of this exact staged tree.`,
);
