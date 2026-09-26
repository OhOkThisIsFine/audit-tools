#!/usr/bin/env node
// sites-pinned: tests/shared/push-gate.test.ts
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
// FAIL-OPEN, ANNOUNCED, on infra faults OUTSIDE the push's own refs: no repo
// root resolvable, no HEAD behind a bare push, or a relocated push this hook
// cannot attribute. A silent fail-open is indistinguishable from a clean pass,
// so every such path prints why. The one path that FAILS CLOSED is a NAMED
// protected ref whose sent tree does not resolve: the push would put that
// ref's content on the remote with no stamp able to certify it, so the gate
// refuses rather than wave through evidence-free content.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readSuiteGreenStamp, suiteGreenVerdict } from '../../scripts/shared/suiteGreenStamp.mjs';
import { worktreeTrees } from '../../scripts/shared/worktree-tree.mjs';
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

// Resolve the actual push working directory. Prioritize payload cwd / tool_input cwd;
// never substitute CLAUDE_PROJECT_DIR when the push executes in a linked worktree.
const payloadCwd =
  (typeof payload?.cwd === 'string' && payload.cwd.trim()) ||
  (typeof payload?.tool_input?.cwd === 'string' && payload.tool_input.cwd.trim()) ||
  null;
const pushCwd = payloadCwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();

const toplevel = spawnSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: pushCwd,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
if (toplevel.status !== 0 || !toplevel.stdout.trim()) {
  noteFailOpen(`\`git rev-parse --show-toplevel\` failed in ${pushCwd} — protected-branch check was SKIPPED.`);
  process.exit(0);
}
const root = resolve(toplevel.stdout.trim());

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

function collapse(s) {
  return s.replace(/\s+/g, ' ');
}

// Which branches does this push put on protected refs? Refspecs naming one
// (`HEAD:main`, `main`, `+main`, `feature:main`) decide it; bare pushes fall back to HEAD.
function inspectPushTargets(pushStatements) {
  const localRefs = [];

  for (const s of pushStatements) {
    const t = stripQuoted(collapse(s));
    const parts = t.split(/\s+/).slice(t.split(/\s+/).findIndex((x) => x === 'push') + 1);

    const isDeleteFlag = parts.some(
      (p) =>
        p === '--delete' ||
        p.startsWith('--delete=') ||
        p === '-d' ||
        (p.startsWith('-') && !p.startsWith('--') && p.includes('d')),
    );
    if (isDeleteFlag) {
      // Any ref in this push statement is a remote deletion; no local ref is sent.
      continue;
    }

    // These options send multiple refs even though the command has no named
    // refspec. The checked-out branch is not enough: `--all` from a feature
    // worktree can still send the local main branch.
    if (parts.includes('--all') || parts.includes('--mirror')) {
      for (const protectedRef of PROTECTED) {
        if (git(['rev-parse', '--verify', `refs/heads/${protectedRef}^{tree}`]).ok) {
          localRefs.push(`refs/heads/${protectedRef}`);
        }
      }
    }

    const nonFlags = parts.filter((p) => !p.startsWith('-'));
    let targetsProtected = false;
    let hasExplicitRefspecs = false;

    for (let i = 0; i < nonFlags.length; i++) {
      const p = nonFlags[i];
      const hasColon = p.includes(':');
      if (hasColon || i > 0) {
        hasExplicitRefspecs = true;
      }
      const remotePart = hasColon ? p.slice(p.indexOf(':') + 1) : p;
      const cleanRemote = remotePart.replace(/^\+/, '').replace(/^refs\/heads\//, '');
      if (!hasColon && cleanRemote === 'HEAD') {
        const head = git(['rev-parse', '--abbrev-ref', 'HEAD']);
        if (head.ok && PROTECTED.includes(head.stdout.trim())) localRefs.push('HEAD');
      }
      if (PROTECTED.includes(cleanRemote)) {
        targetsProtected = true;
        if (hasColon) {
          const localPart = p.slice(0, p.indexOf(':')).replace(/^\+/, '').replace(/^refs\/heads\//, '');
          if (!localPart) {
            // Deletion refspec like :main — sends no local tree
            continue;
          }
          localRefs.push(localPart);
        } else {
          localRefs.push(cleanRemote);
        }
      }
    }

    // A bare push (`git push`, `git push origin`) with no explicit refspecs defaults to pushing HEAD.
    if (!hasExplicitRefspecs && !targetsProtected) {
      const head = git(['rev-parse', '--abbrev-ref', 'HEAD']);
      if (!head.ok) {
        noteFailOpen('cannot resolve HEAD (`git rev-parse --abbrev-ref HEAD` failed) — the protected-branch check was SKIPPED.');
        process.exit(0);
      }
      const currentBranch = head.stdout.trim();
      if (PROTECTED.includes(currentBranch)) {
        localRefs.push('HEAD');
      }
    }
  }

  return [...new Set(localRefs)];
}

const localRefs = inspectPushTargets(pushes);
if (localRefs.length === 0) {
  process.exit(0);
}

const stamp = readSuiteGreenStamp(root);
const trees = worktreeTrees(root);

for (const ref of localRefs) {
  const sentTreeRes = git(['rev-parse', `${ref}^{tree}`]);
  if (!sentTreeRes.ok) {
    // FAIL CLOSED: the push names a protected ref whose sent tree cannot be
    // resolved, so no stamp can certify the content it would put on the
    // remote — allowing it would let an agent push to main with zero evidence
    // behind it, the exact breakage this gate exists to stop. In practice git
    // itself rejects a push whose source ref resolves to nothing, so this
    // refusal costs a pointed message at worst, never a blocked real push.
    console.error(
      `[push gate] push to a PROTECTED branch (${PROTECTED.join('/')}) refused — ` +
        `cannot resolve the sent tree for ref \`${ref}\` ` +
        `(\`git rev-parse ${ref}^{tree}\` failed), so no full-suite green stamp can certify ` +
        `the content being pushed.\n` +
        `If the ref name is wrong, fix it and push again; if the content is real, run the ` +
        `full suite, then push again:\n` +
        `  npm test`,
    );
    process.exit(2);
  }
  const sentTree = sentTreeRes.stdout.trim();

  const candidateTree =
    trees?.tree === sentTree
      ? trees
      : { tree: sentTree, bumpAgnosticTree: null };

  const verdict = suiteGreenVerdict(stamp, candidateTree);
  if (!verdict.ok) {
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
  }
}

process.exit(0);
