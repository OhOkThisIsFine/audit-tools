#!/usr/bin/env node
//
// Producer for the constitutional-doc refusal (.claude/hooks/pre-commit-gate.mjs).
//
// A **constitutional doc** (`src/shared/constitutionalDocPaths.ts`) defines what
// this project IS — the two philosophies, the instruction files, the doc-review
// rubric itself, and the normative `spec/audit/*` + goals docs. The manifest has
// always SAID these are escalate-only and "never silently rewritten to match
// code"; commit 6fc2e453 rewrote `spec/remediate/remediation-goals.md` anyway,
// inside a nine-file doc-review sweep. A label is not a refusal, so the gate now
// blocks such a commit unless THIS tool has written a fresh, staged-tree-bound
// override record.
//
// It is deliberately the SAME mechanism as `attest-loop-core-review.mjs`, not a
// second unrelated one: bind the record to the exact staged tree
// (`git write-tree`) so any later restage invalidates it, require the issuer to
// state their CLASS, detect agent-session markers independently of that claim,
// and require a substantive free-text field so the record says what happened.
//
// What it does NOT do — and running on the same machine as the agent, cannot —
// is establish that the OWNER actually decided. The honest artifact is an
// attributable record of a decision being claimed, which is exactly why the
// constitutional list is kept narrow: an override that gets used routinely has
// stopped signalling anything.
//
// Usage:
//   node scripts/attest-constitutional-doc-change.mjs \
//     --reviewed-by <id> \
//     --attester-class agent|human \
//     --owner-decision "<>=20 chars: the owner's call, and where it was escalated>"
//
//   --reviewed-by     who is recorded as carrying the change (default: git user.name)
//   --attester-class  REQUIRED; who is RUNNING this command — `agent` when any AI
//                     agent/session issues it (even relaying a human's words),
//                     `human` only when a person types this command themselves
//   --owner-decision  REQUIRED; the owner decision this change implements, and where
//                     it was escalated (>= 20 non-space chars)
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONSTITUTIONAL_DOC_PATHS } from './shared/constitutional-doc-paths.generated.mjs';
import { runDerivedFilePreflight } from './shared/derived-file-preflight.mjs';

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// git helper — never throws; callers branch on `.ok`. windowsHide: a windowless
// parent spawning git pops a console window on win32 otherwise — INV-WH.
function git(args) {
  const r = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: (r.stderr ?? '').trim() };
}

function fail(msg) {
  console.error(`attest-constitutional-doc-change: ${msg}`);
  process.exit(1);
}

const isConstitutional = (p) =>
  CONSTITUTIONAL_DOC_PATHS.includes(p.replace(/\\/g, '/').replace(/^\.\//, ''));

// ── parse argv ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flags = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--reviewed-by') flags.reviewedBy = argv[++i];
  else if (a === '--attester-class') flags.attesterClass = argv[++i];
  else if (a === '--owner-decision') flags.ownerDecision = argv[++i];
  else if (a === '--help' || a === '-h') {
    console.log(
      'usage: attest-constitutional-doc-change.mjs --reviewed-by <id> --attester-class agent|human ' +
        '--owner-decision "<...>"',
    );
    process.exit(0);
  } else fail(`unknown argument: ${a}`);
}

// --attester-class is REQUIRED: the record must state WHO issued it. There is
// deliberately no default — a default lets the distinction be carried by
// omission, which is exactly the assumption this field replaces.
const attesterClass = (flags.attesterClass ?? '').trim();
if (attesterClass !== 'agent' && attesterClass !== 'human') {
  fail(
    '--attester-class is REQUIRED and must be "agent" or "human". State who is RUNNING this ' +
      'command: any AI agent/session must say "agent" (even when relaying an owner decision); ' +
      '"human" means a person typed this themselves. The class is recorded, not enforced — it ' +
      'exists so a self-issued override is distinguishable from an owner sign-off after the fact.',
  );
}

// Agent-session markers, detected independently of the claim: a record claiming
// `human` from a shell carrying these is a greppable contradiction.
const AGENT_ENV_MARKERS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'GEMINI_CLI'];
const agentEnvMarkers = AGENT_ENV_MARKERS.filter((k) => process.env[k] != null && process.env[k] !== '');

const ownerDecision = (flags.ownerDecision ?? '').trim();
if (ownerDecision.replace(/\s/g, '').length < 20) {
  fail(
    'the --owner-decision flag is REQUIRED and must be >= 20 non-space characters naming the owner ' +
      'decision this change implements and where it was escalated (e.g. "owner approved dropping the ' +
      'flow-coverage obligation from the audit goals — decided in the 2026-07-25 lap hand-back"). ' +
      'A constitutional doc states what the project IS; changing one to match code is the exact ' +
      'failure this refusal exists to stop, so the record must name the decision, not the edit.',
  );
}

let reviewedBy = (flags.reviewedBy ?? '').trim();
if (!reviewedBy) {
  const u = git(['config', 'user.name']);
  reviewedBy = u.ok ? u.stdout.trim() : '';
}
if (!reviewedBy) fail('could not determine --reviewed-by (no value given and git user.name unset)');

// ── compute the staged tree SHA + staged constitutional file list ─────────────
const wt = git(['write-tree']);
if (!wt.ok || !wt.stdout.trim()) {
  fail(`\`git write-tree\` failed — nothing staged, or not a git repo. ${wt.stderr}`);
}
const sha = wt.stdout.trim();

const cached = git(['diff', '--cached', '--name-only']);
if (!cached.ok) fail(`could not list the staged set (\`git diff --cached\` failed). ${cached.stderr}`);
const staged = cached.stdout
  .split(/\r?\n/)
  .map((p) => p.trim())
  .filter(Boolean);
const constitutionalFiles = staged.filter(isConstitutional);
if (constitutionalFiles.length === 0) {
  fail('nothing constitutional staged to attest — the staged set touches no constitutional doc path.');
}

// ── P19: refuse to bind to a tree the gate would reject ────────────────────────
// Same preflight as attest-loop-core-review.mjs, same single-sourced module: a
// constitutional-doc edit is almost always a markdown edit, which is exactly
// what trips the doc-manifest / HANDOFF / backlog-index legs after binding.
// No `git` passed: the module's own runner carries `.status`, which the
// staged-pickaxe scans branch on; this script's local helper does not.
// The legs read the WORKING tree; this attestation binds the STAGED tree. The
// preflight refuses only when the two are the same object before AND after the
// legs run, and otherwise ABSTAINS — see the module's header.
const preflight = runDerivedFilePreflight({ root, staged, stagedTree: sha });
{
  for (const s of preflight.skipped) console.error(`attest-constitutional-doc-change: note — ${s}`);
  if (preflight.failures.length > 0) {
    for (const f of preflight.failures) {
      console.error(`\n✗ ${f.script} FAILED — fix: ${f.fix}\n${f.tail}`);
    }
    fail(
      'refusing to bind: the staged tree would be rejected by the pre-commit gate\'s derived-file ' +
        'checks above — verified against the staged tree (working tree is identical). ' +
        'Fix + re-stage, THEN attest — nothing was written, so nothing is wasted.',
    );
  }
  if (preflight.unattributed.length > 0) {
    for (const u of preflight.unattributed) {
      console.error(
        `\n… ${u.script} ${u.outcome.toUpperCase()} — NOT a verdict about the staged tree` +
          (u.tail ? `\n${u.tail}` : ''),
      );
    }
    console.error(
      `\nattest-constitutional-doc-change: the working tree is NOT identical to the staged tree ` +
        `(staged ${preflight.stagedTree}, worktree ${preflight.worktreeTreeBefore ?? 'unknown'}), ` +
        `so the results above describe the DISK, not the tree being bound. The pre-commit gate ` +
        `materializes the staged tree and judges it exactly at commit. Stage or set aside the ` +
        `divergence and re-run for a judged verdict.`,
    );
  }
}

const headRev = git(['rev-parse', 'HEAD']);
const gitHead = headRev.ok ? headRev.stdout.trim() : null;

// ── write the bound override record ──────────────────────────────────────────
const dir = join(root, '.claude', 'constitutional-doc-review');
mkdirSync(dir, { recursive: true });
const recordPath = join(dir, sha + '.json');
const record = {
  schema_version: 'constitutional-doc-change/v1',
  staged_tree: sha,
  reviewed_by: reviewedBy,
  attester_class: attesterClass,
  agent_env_markers: agentEnvMarkers,
  owner_decision: ownerDecision,
  constitutional_files: constitutionalFiles,
  // What the preflight established about THIS tree — see the twin block in
  // .claude/hooks/attest-loop-core-review.mjs. No schema_version bump: the field
  // has no reader.
  preflight: {
    attributable: preflight.attributable,
    staged_tree: preflight.stagedTree,
    worktree_tree_before: preflight.worktreeTreeBefore,
    worktree_tree_after: preflight.worktreeTreeAfter,
    unattributed: preflight.unattributed.map((u) => ({ id: u.id, outcome: u.outcome })),
  },
  git_head: gitHead,
  created_at: new Date().toISOString(),
};
writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n', 'utf8');

console.log(
  `attest-constitutional-doc-change: wrote ${recordPath}\n` +
    `  staged_tree    : ${sha}\n` +
    `  reviewed_by    : ${reviewedBy}\n` +
    `  attester       : ${attesterClass}${agentEnvMarkers.length ? ` (env markers: ${agentEnvMarkers.join(', ')})` : ''}\n` +
    `  owner_decision : ${ownerDecision}\n` +
    `  constitutional : ${constitutionalFiles.length} file(s)\n` +
    constitutionalFiles.map((p) => `                 - ${p}`).join('\n') +
    `\nThe pre-commit gate will now allow a commit of this exact staged tree.`,
);
