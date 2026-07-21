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
// it and forces a re-review.
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
//     [--verdict clear|concerns] [--override "<reason>"]
//
//   --reviewed-by     reviewer id (default: git user.name)
//   --attester-class  REQUIRED; who is RUNNING this attestation — `agent` when any
//                     AI agent/session issues it (even relaying a human's words),
//                     `human` only when a person types this command themselves
//   --checked         REQUIRED; what was adversarially checked (>= 20 non-space chars)
//   --verdict         clear (default) | concerns
//   --override        reason a `concerns` verdict may still pass the gate (recorded)
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// git helper — never throws; callers branch on `.ok`.
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
  console.error(`attest-loop-core-review: ${msg}`);
  process.exit(1);
}

// ── loop-core predicate (mirrors src/shared/loopCorePaths.ts; parity-tested) ──
const LOOP_CORE_PATTERNS = [
  'src/audit/cli/dispatch.ts',
  'src/audit/cli/dispatch/',
  'src/audit/cli/mergeAndIngestCommand.ts',
  'src/audit/cli/ownerTokens.ts',
  'src/audit/cli/rollingAuditDispatch.ts',
  'src/audit/orchestrator/',
  'src/remediate/riskSignal.ts',
  'src/remediate/steps/contractPipeline.ts',
  'src/remediate/steps/dispatch/',
  'src/remediate/steps/nextStep.ts',
  'src/remediate/steps/rollingSession.ts',
  'src/shared/dispatch/',
  'src/shared/engine/',
  'src/shared/quota/',
  'src/shared/rolling/',
];
function pinsLoopCore(p) {
  const norm = p.replace(/\\/g, '/').replace(/^\.\//, '');
  for (const pattern of LOOP_CORE_PATTERNS) {
    if (pattern.endsWith('/')) {
      if (norm.startsWith(pattern)) return true;
    } else if (norm === pattern) {
      return true;
    }
  }
  return false;
}

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
  else if (a === '--help' || a === '-h') {
    console.log(
      'usage: attest-loop-core-review.mjs --reviewed-by <id> --attester-class agent|human ' +
        '--checked "<...>" [--verdict clear|concerns] [--override "<reason>"]',
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

// reviewed-by defaults to git user.name.
let reviewedBy = (flags.reviewedBy ?? '').trim();
if (!reviewedBy) {
  const u = git(['config', 'user.name']);
  reviewedBy = u.ok ? u.stdout.trim() : '';
}
if (!reviewedBy) fail('could not determine --reviewed-by (no value given and git user.name unset)');

// ── compute the staged tree SHA + loop-core staged file list ───────────────────
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
const loopCoreFiles = staged.filter(pinsLoopCore);
if (loopCoreFiles.length === 0) {
  fail('nothing loop-core staged to attest — the staged set touches no loop-core path.');
}

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
    `\nThe pre-commit gate will now allow a commit of this exact staged tree.`,
);
