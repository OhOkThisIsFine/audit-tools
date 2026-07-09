#!/usr/bin/env node
// PreToolUse gate: block `git commit` until `npm run check` is green.
// Receives the hook payload on stdin: { tool_name, tool_input: { command } }.
// Exit 0 = allow, exit 2 = block (stderr is fed back to the agent).
// Fires on every Bash/PowerShell call; non-commit commands exit in ~ms.
//
// STAGED-SNAPSHOT SEMANTICS (why this is not just `npm run check` on the cwd):
// The gate must validate the snapshot that would actually be COMMITTED — the
// staged index — not the dirty working tree. Otherwise an unstaged local edit
// can mask a broken staged change (green working tree, red commit) or a staged
// break can be hidden by an unstaged fix. So when the working tree diverges from
// the index we materialize the staged snapshot into the working tree, run the
// check against it, and ALWAYS restore the pre-gate state in a `finally`.
//
// Materialization uses a TEMP-INDEX round-trip, not `git stash`. A
// `stash --keep-index` + `pop` cannot faithfully restore a file that is BOTH
// staged and unstaged-modified: pop's 3-way merge sees the worktree already at
// the index base and silently drops the unstaged version (verified). The
// temp-index method is deterministic — no merge:
//   1. capture worktree tree  (all tracked+untracked files, via a scratch index)
//   2. capture staged tree     (`git write-tree` on the real index)
//   3. materialize staged tree into the worktree (exact: write staged files,
//      delete anything not in the staged tree) → run the gate
//   4. finally: restore worktree tree exactly + reset real index to staged tree
//
// Failure policy: FAIL-OPEN on infrastructure faults (can't capture/materialize/
// restore, git error) — never wedge the session; FAIL-CLOSED on gate results
// (a real `npm run check` / doc-contract failure blocks the commit).
import { execSync, spawnSync } from 'node:child_process';
import { rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

// ── Loop-core adversarial-review gate ────────────────────────────────────────
// Hand-authored (non-node) edits to the dispatch / admission / quota / rolling /
// orchestrator-step substrate carry the highest blast radius and have no
// automated adversarial-review gate; three author-green defects reached main
// this way. Block a commit whose STAGED set touches a loop-core path unless a
// FRESH, staged-tree-hash-bound review attestation exists. This re-declares the
// canonical pattern list from `src/shared/loopCorePaths.ts` (the .mjs hook can't
// import the TS module — it runs under plain node, pre-build); a parity test
// (`tests/shared/loop-core-gate-parity.test.mjs`) pins the two byte-equal so
// they can never drift. A "/"-terminated pattern is a directory prefix; every
// other entry is an exact repo-relative path.
const LOOP_CORE_PATTERNS = [
  "src/audit/cli/dispatch.ts",
  "src/audit/cli/dispatch/",
  "src/audit/cli/rollingAuditDispatch.ts",
  "src/audit/orchestrator/",
  "src/remediate/riskSignal.ts",
  "src/remediate/steps/contractPipeline.ts",
  "src/remediate/steps/dispatch/",
  "src/remediate/steps/leanFastPath.ts",
  "src/remediate/steps/nextStep.ts",
  "src/remediate/steps/rollingSession.ts",
  "src/shared/dispatch/",
  "src/shared/engine/",
  "src/shared/quota/",
  "src/shared/rolling/",
];

// Whether a repo-relative path is in the loop-core set. Mirrors `isLoopCorePath`
// from src/shared/loopCorePaths.ts: normalize backslashes + leading "./"; a
// "/"-terminated pattern matches the directory prefix, else exact match.
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

let raw = '';
for await (const chunk of process.stdin) raw += chunk;

let cmd = '';
try {
  cmd = JSON.parse(raw)?.tool_input?.command ?? '';
} catch {
  process.exit(0); // unparseable payload — never wedge the session
}

// A real commit invocation: `git … commit` within one shell statement,
// not the word "commit" elsewhere (e.g. git log --grep=commit).
if (!/\bgit\b[^\n|;&]*\bcommit\b/.test(cmd)) process.exit(0);

// Gate-bypass vectors — a commit that disables hooks makes this gate a no-op,
// so refuse it outright (the gate can't run `check` if git skips the hook, and
// silently allowing the bypass defeats green-at-every-commit). Covers the
// `--no-verify`/`-n` flag and any `core.hooksPath` override (`-c core.hooksPath=…`
// or the GIT_CONFIG_* env form), matched anywhere in the statement.
if (/--no-verify\b|(^|[\s;&|])-n(?=[\s;&|]|$)|\bcore\.hooksPath\b/.test(cmd)) {
  console.error(
    'pre-commit gate: commit rejected — hook-bypass flag detected (`--no-verify`/`-n` or `core.hooksPath` override). ' +
      'These skip the green-at-every-commit gate. Remove the bypass and commit normally; if `npm run check` fails, fix it first.',
  );
  process.exit(2);
}

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// ── git helper: run a git subcommand, capturing status/stdout/stderr. ────────
// Never throws — callers branch on `.ok`. Used for the snapshot orchestration so
// a git fault degrades to a decision, not an unhandled exception.
function git(args) {
  const r = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: r.stdout ?? '', // raw — callers that need porcelain columns must not lose leading spaces
    stderr: (r.stderr ?? '').trim(),
    spawnError: r.error,
  };
}

// Run a git subcommand with a SCRATCH index (GIT_INDEX_FILE) so it never touches
// the real staged state. Same shape as git(); used to build/apply worktree trees.
function gitWithIndex(indexFile, args) {
  const r = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_INDEX_FILE: indexFile },
    windowsHide: true,
  });
  return { ok: r.status === 0, status: r.status, stdout: r.stdout ?? '', stderr: (r.stderr ?? '').trim() };
}

// Snapshot the ENTIRE working tree (all tracked + untracked files, honoring
// .gitignore) as a git tree object, without disturbing the real index. Returns
// the tree SHA or null on any git fault.
function captureWorktreeTree(scratchIndex) {
  if (!gitWithIndex(scratchIndex, ['read-tree', 'HEAD']).ok) return null;
  if (!gitWithIndex(scratchIndex, ['add', '-A']).ok) return null;
  const wt = gitWithIndex(scratchIndex, ['write-tree']);
  if (!wt.ok) return null;
  return wt.stdout.trim();
}

// List the paths contained in a tree object (recursive). Null on fault.
function listTreePaths(tree) {
  const r = git(['ls-tree', '-r', '-z', '--name-only', tree]);
  if (!r.ok) return null;
  return r.stdout.split('\0').filter(Boolean);
}

// Check out `tree` into the working tree EXACTLY: write every file the tree
// contains, then delete any currently-present file that the tree does NOT
// contain (so a staged deletion / untracked file is honored). `presentPaths` is
// the union of the two trees involved in the round-trip — the candidate set to
// prune. Uses a scratch index so the real index is untouched. True on success.
function checkoutTreeExact(scratchIndex, tree, presentPaths) {
  if (!gitWithIndex(scratchIndex, ['read-tree', tree]).ok) return false;
  if (!gitWithIndex(scratchIndex, ['checkout-index', '-f', '-a']).ok) return false;
  const wanted = new Set(listTreePaths(tree) ?? []);
  for (const p of presentPaths) {
    if (!wanted.has(p)) {
      // Delete files the target tree does not include (best-effort; a leftover
      // file is a soft fault, never a wedge).
      try {
        rmSync(join(root, p), { force: true });
      } catch {
        /* ignore */
      }
    }
  }
  return true;
}

// Run the full gate (typecheck + conditional doc-contract subset) against
// whatever is currently in the working tree. Returns { blocked, message }.
// `blocked` true => a gate RESULT failed (fail-closed). Infra faults inside are
// NOT treated as blocking (return blocked:false) so the caller can fail open.
function runGate() {
  // 1. Typecheck the (materialized) snapshot.
  try {
    execSync('npm run check', {
      cwd: root,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 240_000,
      windowsHide: true,
    });
  } catch (err) {
    const tail = `${err.stdout ?? ''}\n${err.stderr ?? ''}`
      .trim()
      .split('\n')
      .slice(-40)
      .join('\n');
    return {
      blocked: true,
      message:
        `pre-commit gate: \`npm run check\` FAILED — commit blocked (green-at-every-commit invariant). ` +
        `Fix the type errors, then retry the commit.\n${tail}`,
    };
  }

  // 2. Doc-contract subset — only when the STAGED set touches a pinned doc/asset.
  // `npm run check` only typechecks; a prose reword can land a RED doc-contract
  // test on main (release-contract.test.mjs asserts EXACT strings). We inspect
  // the staged set (git diff --cached) — the files that will actually commit.
  const cached = git(['diff', '--cached', '--name-only']);
  if (!cached.ok) return { blocked: false }; // can't list staged — skip subset
  const staged = cached.stdout
    .split(/\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  // The docs/assets the doc-contract subset pins: any markdown (docs/**.md,
  // CLAUDE.md, AGENTS.md, copilot-instructions.md, auditor.agent.md) plus the
  // rendered host assets (opencode.json, .gemini/*).
  const pinsDocContract = (p) =>
    /\.md$/i.test(p) || p === 'opencode.json' || p.startsWith('.gemini/');
  if (staged.some(pinsDocContract)) {
    try {
      execSync('npm run test:doc-contract', {
        cwd: root,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 240_000,
        windowsHide: true,
      });
    } catch (err) {
      const tail = `${err.stdout ?? ''}\n${err.stderr ?? ''}`
        .trim()
        .split('\n')
        .slice(-40)
        .join('\n');
      return {
        blocked: true,
        message:
          `pre-commit gate: doc-contract tests FAILED — commit blocked. A staged doc/asset broke a test that ` +
          `pins its exact content (release-contract / *-doc-sync / host-asset-renderer-drift). ` +
          `Fix the doc or the test, then retry.\n${tail}`,
      };
    }
  }

  // 3. Loop-core adversarial-review attestation — only when the STAGED set
  // touches a loop-core path. Hand-authored loop-core edits must carry a FRESH,
  // staged-tree-hash-bound review attestation. This enforces attestation
  // existence + freshness + binding MECHANICALLY; review QUALITY stays a logged,
  // attributable human step (the honest limit). FAIL-CLOSED on a missing/stale
  // attestation for loop-core; FAIL-OPEN only on a genuine git write-tree fault.
  if (staged.some(pinsLoopCore)) {
    const loopCoreStaged = staged.filter(pinsLoopCore);
    const wt = git(['write-tree']);
    if (!wt.ok) return { blocked: false }; // can't bind → don't wedge (infra fail-open)
    const sha = wt.stdout.trim();
    const attestPath = join(root, '.claude', 'loop-core-review', sha + '.json');
    const runHint =
      `node .claude/hooks/attest-loop-core-review.mjs --reviewed-by <id> ` +
      `--checked "<what was adversarially checked>"`;
    if (!existsSync(attestPath)) {
      return {
        blocked: true,
        message:
          `pre-commit gate: loop-core commit blocked — no adversarial-review attestation for the staged tree.\n` +
          `The staged set touches loop-core (dispatch/quota/rolling/orchestrator substrate):\n` +
          loopCoreStaged.map((p) => `  - ${p}`).join('\n') +
          `\nHand-authored loop-core edits require a FRESH, staged-tree-bound review. Run:\n  ${runHint}\n` +
          `then retry the commit (the attestation binds to the exact staged tree ${sha.slice(0, 12)}).`,
      };
    }
    let attest;
    try {
      attest = JSON.parse(readFileSync(attestPath, 'utf8'));
    } catch {
      return {
        blocked: true,
        message:
          `pre-commit gate: loop-core commit blocked — the review attestation at ` +
          `.claude/loop-core-review/${sha}.json is unreadable/corrupt. Re-run:\n  ${runHint}`,
      };
    }
    if (attest?.staged_tree !== sha) {
      return {
        blocked: true,
        message:
          `pre-commit gate: loop-core commit blocked — the review attestation is STALE (binds tree ` +
          `${String(attest?.staged_tree).slice(0, 12)}, staged tree is ${sha.slice(0, 12)}). ` +
          `Re-review the current staged snapshot:\n  ${runHint}`,
      };
    }
    if (attest.verdict === 'block' || (attest.verdict === 'concerns' && !attest.override)) {
      return {
        blocked: true,
        message:
          `pre-commit gate: loop-core commit blocked — the review recorded verdict "${attest.verdict}"` +
          (attest.checked ? ` (checked: ${attest.checked})` : '') +
          `. Resolve the concerns and re-attest, or re-run with --override "<reason>" if intentional:\n  ${runHint}`,
      };
    }
  }

  return { blocked: false };
}

// Does the working tree diverge from the staged index? If not (everything is
// staged, or nothing is), the working tree already IS the staged snapshot and we
// can check it directly — no materialization churn on the common "git add -A &&
// commit". `git status --porcelain` lines are "XY path": X = index state, Y =
// worktree state. A divergence exists when any Y is non-space (unstaged
// modification/deletion) or the entry is untracked (`??`).
function workingTreeDivergesFromIndex() {
  const st = git(['status', '--porcelain', '--untracked-files=all']);
  if (!st.ok) return null; // git error — caller fails open
  // NB: porcelain lines carry a significant 2-column status prefix ("XY path");
  // split on newlines WITHOUT trimming lines, or the leading index column is lost
  // and the worktree column (Y) shifts under the wrong index → false negatives.
  for (const line of st.stdout.split(/\r?\n/)) {
    if (!line) continue;
    const y = line[1];
    // '??' (untracked) and any non-space worktree flag mean the tree != index.
    if (line.startsWith('??') || (y && y !== ' ')) return true;
  }
  return false;
}

// ── Gate the staged snapshot, restoring the working tree afterward. ──────────
const diverges = workingTreeDivergesFromIndex();
if (diverges === null) {
  // Not a git repo / git error — can't reason about the staged snapshot.
  // FAIL-OPEN: allow the commit rather than wedge the session.
  process.exit(0);
}

if (!diverges) {
  // Working tree == staged index. Check it directly; no materialization needed.
  const { blocked, message } = runGate();
  if (blocked) {
    console.error(message);
    process.exit(2);
  }
  process.exit(0);
}

// Working tree diverges from the index → materialize the staged snapshot via a
// deterministic temp-index round-trip (see header). All git-plumbing goes
// through a SCRATCH index file so the real staged index is never mutated by the
// capture/checkout steps; the only real-index write is the final restore.
// Scratch index for the staged-snapshot round-trip. It MUST NOT live under
// `join(root, '.git', …)`: in a LINKED worktree `.git` is a FILE (a gitdir
// pointer), so a path "under" it is unwritable and every git-with-scratch-index
// call fails — silently failing the ENTIRE staged-snapshot gate open (it was a
// no-op in every linked worktree with a divergent tree). GIT_INDEX_FILE only
// relocates the index; objects still resolve through the real gitdir via `cwd`,
// so a temp-dir path is safe and works identically in main and linked worktrees.
const scratchIndex = join(tmpdir(), `audit-tools-pre-commit-index-${randomBytes(6).toString('hex')}`);

// 1. Capture the current worktree tree and the staged (real-index) tree.
const worktreeTree = captureWorktreeTree(scratchIndex);
const stagedWt = git(['write-tree']);
if (worktreeTree === null || !stagedWt.ok) {
  try { rmSync(scratchIndex, { force: true }); } catch { /* ignore */ }
  console.error(
    `[pre-commit gate] could not capture the staged snapshot (git write-tree failed) — ` +
      `skipping the staged-snapshot check for this commit. ${stagedWt.stderr}`,
  );
  process.exit(0); // FAIL-OPEN on infra fault
}
const stagedTree = stagedWt.stdout.trim();

// Union of paths across both trees — the prune candidate set for exact checkouts
// (materialize removes untracked/unstaged-only files; restore removes anything
// the worktree tree lacks).
const stagedPaths = listTreePaths(stagedTree);
const worktreePaths = listTreePaths(worktreeTree);
if (stagedPaths === null || worktreePaths === null) {
  try { rmSync(scratchIndex, { force: true }); } catch { /* ignore */ }
  console.error(
    `[pre-commit gate] could not enumerate the staged snapshot (git ls-tree failed) — ` +
      `skipping the staged-snapshot check for this commit.`,
  );
  process.exit(0); // FAIL-OPEN on infra fault
}
const unionPaths = new Set([...stagedPaths, ...worktreePaths]);

// 2. Materialize the staged tree into the worktree.
if (!checkoutTreeExact(scratchIndex, stagedTree, unionPaths)) {
  checkoutTreeExact(scratchIndex, worktreeTree, unionPaths); // best-effort restore
  try { rmSync(scratchIndex, { force: true }); } catch { /* ignore */ }
  console.error(
    `[pre-commit gate] could not materialize the staged snapshot (git checkout-index failed) — ` +
      `skipping the staged-snapshot check for this commit.`,
  );
  process.exit(0); // FAIL-OPEN on infra fault
}

let exitCode = 0;
try {
  // 3. Gate the materialized staged snapshot.
  const { blocked, message } = runGate();
  if (blocked) {
    console.error(message);
    exitCode = 2;
  }
} finally {
  // 4. ABSOLUTE restoration: put the worktree back exactly, and reset the real
  // index to the staged tree (the checkout-index steps ran on the scratch index,
  // so the real index is already intact — this read-tree is a belt-and-suspenders
  // guarantee the staged snapshot is preserved verbatim).
  const restoredWt = checkoutTreeExact(scratchIndex, worktreeTree, unionPaths);
  const restoredIdx = git(['read-tree', stagedTree]).ok;
  try { rmSync(scratchIndex, { force: true }); } catch { /* ignore */ }
  if (!restoredWt || !restoredIdx) {
    // Restoration hit an infra fault. Surface it loudly, but do NOT convert it
    // into a spurious commit block (fail-open on infra): keep a real gate block
    // if one was already decided, otherwise allow.
    console.error(
      `[pre-commit gate] WARNING: could not fully restore your working tree/index after the ` +
        `staged-snapshot check. Inspect \`git status\`; your staged changes and worktree edits ` +
        `should be intact but verify before committing.`,
    );
  }
}

process.exit(exitCode);
