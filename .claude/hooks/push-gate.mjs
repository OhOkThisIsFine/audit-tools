#!/usr/bin/env node
// PreToolUse hook: refuse an AGENT push to \`main\` unless a full-suite green
// stamp binds the tree being pushed.
//
// THE GAP. "Before any push: \`npm run build && npm run check\` → zero errors" is
// enforced at git's own boundary (the commit gate), and every narrow gate runs
// against the touched area. Neither can see a CROSS-AREA invariant: a change to
// area A breaks a contract test in area B, every touched-area leg is green, and
// the breakage surfaces only in the full suite — which nothing local runs before
// a push. The two-tag burn of 2026-08-27 is the measured instance. The touched
// area's suite is not a substitute for the full suite, and no list of "the areas
// a change touches" can be made complete by hand.
//
// WHAT THIS DOES. \`scripts/shared/suiteGreenStamp.mjs\` already records a
// full-suite green bound to the worktree TREE it ran on (\`writeSuiteGreenStamp\`
// from the one gate runner), and \`suiteGreenVerdict\` already decides whether that
// record certifies the current tree. The closeout challenge consumes that
// evidence; this hook is the PUSH boundary consuming the same single-sourced
// verdict — never a second reading of what "green" or "this tree" means.
//
// WHY A HOOK AND NOT PROSE. A needed manual flag is a bug signal, and "remember
// to run the full suite before pushing" is exactly a rule enforced by memory.
// The stamp is written by the gate runner itself, so the only way to satisfy
// this hook is to actually run the suite.
//
// SCOPE — stated because a partly-enforced trap is not deletable:
//   • AGENT sessions only. A human at a terminal pushes as they always have;
//     the discipline this replaces was the agent's, and gating a person's own
//     shell is not this project's business.
//   • a push that plainly runs in THIS repository: a bare \`git push\` statement
//     with no \`cd\`/\`Set-Location\`/\`pushd\` prefix and no \`git -C\` hop. A chained or
//     relocated push is NOT judged — it FAILS OPEN, ANNOUNCED, so the skip can
//     never read as a pass (see below).
//   • a push whose target is the PROTECTED branch: \`main\`/\`master\`, named in the
//     refspec, or a bare \`git push\` while HEAD is that branch. A feature-branch
//     push is not gated — the stamp is about what reaches \`main\`.
//   • \`--force\`/\`-f\` does not widen this: a force-push to \`main\` is gated like
//     any other, since the refspec still names it.
//
// FAIL-OPEN, ANNOUNCED, on infra faults: no stamp machinery reachable, an
// unreadable stamp, an uncomputable tree. A silent fail-open is
// indistinguishable from a clean pass, so every such path prints why.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readSuiteGreenStamp, suiteGreenVerdict } from '../../scripts/shared/suiteGreenStamp.mjs';
import { worktreeTree } from '../../scripts/shared/worktree-tree.mjs';
import { splitShellStatements, stripHeredocBodies, stripQuoted } from './shell-split.mjs';

const PROTECTED = ['main', 'master'];

function noteFailOpen(reason) {
  console.error(`[push gate] FAIL-OPEN (allowing the push): ${reason}`);
}

let payload;
try {
  payload = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0); // no payload = not a tool call we can judge
}
const command = payload?.tool_input?.command;
if (typeof command !== 'string' || command.trim() === '') process.exit(0);

// THE AGENT BOUNDARY. CLAUDE_CODE_SESSION_ID / CLAUDE_PID mark a Claude Code
// session; AUDIT_TOOLS_CHILD_SESSION marks a dispatched child. A plain terminal
// carries none and is not gated.
const isAgentSession = Boolean(
  process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_PID || process.env.AUDIT_TOOLS_CHILD_SESSION,
);
if (!isAgentSession) process.exit(0);

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();

const statements = splitShellStatements(stripHeredocBodies(command));

// A \`cd X && git push\` chain and a \`git -C X push\` hop are OUT of scope: the target
// repository cannot be established here without a second copy of the commit
// gate's jurisdiction machinery, and guessing it would refuse a push into an
// unrelated repository (the 2026-08-19 false-red class). Announced, never
// silent — the one case where a skip would otherwise read as a pass.
if (/\bgit\s+push\b/.test(command) && /\bgit\s+-C\b|\b(?:cd|chdir|pushd|set-location|push-location)\b/i.test(command)) {
  noteFailOpen(
    'a relocated push (a \`cd\`/\`Set-Location\` prefix or a \`git -C\` hop) is not judged here — ' +
      'establish the target repository and run the full suite before pushing to main.',
  );
  process.exit(0);
}

// \`git push\`, not a dry run (which writes no ref), and with no hop that could
// relocate it (handled above).
const isPushStatement = (s) => {
  const t = stripQuoted(s).trim();
  if (/\bgit\s+push\b/.test(t) === false) return false;
  return !/(?:^|\s)--dry-run(?:\s|$)/.test(t);
};

const pushes = statements.filter(isPushStatement);
if (pushes.length === 0) process.exit(0);

const git = (args) => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  return { ok: r.status === 0, stdout: r.stdout ?? '' };
};

// Which branch does this push put on the protected ref? A refspec naming one
// (\`HEAD:main\`, \`main\`, \`+main\`) decides it; a bare push falls back to HEAD.
const namesProtected = (s) => {
  const t = stripQuoted(collapse(s));
  const parts = t.split(/\s+/).slice(t.split(/\s+/).findIndex((x) => x === 'push') + 1);
  for (const p of parts) {
    if (p.startsWith('-')) continue;
    const ref = p.includes(':') ? p.slice(p.indexOf(':') + 1) : p;
    if (PROTECTED.includes(ref.replace(/^\+/, ''))) return true;
  }
  return false;
};
function collapse(s) {
  return s.replace(/\s+/g, ' ');
}
const targetsProtected = pushes.some(namesProtected);
if (!targetsProtected) {
  // No refspec named a protected branch: the pushed branch is HEAD's.
  const head = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!head.ok) {
    noteFailOpen('cannot resolve HEAD (\`git rev-parse --abbrev-ref HEAD\` failed) — the protected-branch check was SKIPPED.');
    process.exit(0);
  }
  if (!PROTECTED.includes(head.stdout.trim())) process.exit(0);
}

const tree = worktreeTree(root);
const verdict = suiteGreenVerdict(readSuiteGreenStamp(root), tree);
if (verdict.ok) process.exit(0);

console.error(
  `[push gate] push to a PROTECTED branch (${PROTECTED.join('/')}) refused — ${verdict.reason}.\n` +
    `Every narrow gate passes on a touched area; a CROSS-AREA invariant is only reachable by the\n` +
    `full suite, which nothing local runs before a push (two commits shipped red this way on\n` +
    `2026-08-27). Run the full suite, then push again:\n` +
    `  npm test\n` +
    `A green FULL run writes the stamp this gate reads, bound to the tree it ran on — so any edit\n` +
    `after it invalidates it and the suite has to be re-run. A FILTERED run (a file path, --shard,\n` +
    `--exclude) mints no stamp by design: a subset is not whole-tree evidence.`,
);
process.exit(2);
