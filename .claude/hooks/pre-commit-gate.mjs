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
import { rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { stripQuoted, collapseQuoted, splitShellStatements } from './shell-split.mjs';

// ── Loop-core adversarial-review gate ────────────────────────────────────────
// Hand-authored (non-node) edits to the dispatch / admission / quota / rolling /
// orchestrator-step substrate carry the highest blast radius and have no
// automated adversarial-review gate; three author-green defects reached main
// this way. Block a commit whose STAGED set touches a loop-core path unless a
// FRESH, staged-tree-hash-bound review attestation exists. The pattern list is
// IMPORTED from a generated sibling rather than re-declared here: this hook runs
// under plain node pre-build and cannot import `src/shared/loopCorePaths.ts`,
// but it can import a .mjs generated FROM it, so the list keeps exactly one
// hand-maintained home. `npm run check:loop-core-patterns` (in verify:checks)
// fails the build if the generated file drifts from the source of truth.
// A "/"-terminated pattern is a directory prefix; every other entry is an exact
// repo-relative path.
import { LOOP_CORE_PATTERNS } from "./loop-core-patterns.mjs";

// ── Constitutional-doc refusal ───────────────────────────────────────────────
// A constitutional doc states what this project IS (the two philosophies, the
// instruction files, the doc-review rubric, the normative spec/audit contracts
// and goals docs). `docs/doc-review-guidelines.md` has always SAID these are
// escalate-only and "never silently rewritten to match code" — and commit
// 6fc2e453 rewrote spec/remediate/remediation-goals.md anyway, inside a routine
// nine-file doc-review sweep. The gap was a REFUSAL, not a label; this is the
// refusal. Same import arrangement as the loop-core list: the canonical home is
// `src/shared/constitutionalDocPaths.ts`, which this pre-build hook cannot
// import, so it imports a generated sibling. The generated file lives under
// `scripts/` because `.gitignore` re-includes `.claude/hooks/*` BY NAME — a new
// file there is silently dropped from commits until someone adds the allowlist
// line. `npm run check:constitutional-doc-paths` fails the build on drift.
import { isConstitutionalDocPath } from "../../scripts/shared/constitutional-doc-paths.generated.mjs";

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
  // Never wedge the session — but the gate did NOT run, and a silent exit 0 is
  // indistinguishable from a pass.
  noteFailOpen('the hook payload was unparseable — no check ran for this command');
  process.exit(0);
}

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// ── Round-trip crash safety ──────────────────────────────────────────────────
// The staged-snapshot round-trip REWRITES the working tree and, at restore, the
// real index. A hook process killed mid-round-trip (harness timeout, parallel
// tool-call interleave) used to leave that clobbered state behind with nothing
// to heal it — observed live 2026-07-23 (the real index silently absorbed the
// whole worktree). Mechanism: the two tree SHAs are JOURNALED before any
// worktree mutation; every gate invocation (any Bash/PowerShell call) heals a
// journal left behind by a crashed instance, and a mkdir-based LOCK serializes
// concurrent round-trips (a second instance fails open rather than interleaving
// tree surgery).
const STATE_DIR = join(root, '.claude', 'hooks', '.state');
const RT_JOURNAL = join(STATE_DIR, 'gate-roundtrip-journal.json');
const RT_LOCK = join(STATE_DIR, 'gate-roundtrip.lock');
const RT_LOCK_STALE_MS = 10 * 60_000;

function roundTripLockIsLive() {
  try {
    return Date.now() - statSync(RT_LOCK).mtimeMs < RT_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function acquireRoundTripLock() {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
  } catch {
    /* fall through — the lock mkdir below will fail and we fail open */
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(RT_LOCK); // atomic: EEXIST when another instance holds it
      return true;
    } catch {
      if (roundTripLockIsLive()) return false;
      try {
        rmSync(RT_LOCK, { recursive: true, force: true }); // stale — steal once
      } catch {
        return false;
      }
    }
  }
  return false;
}

function releaseRoundTripLock() {
  try {
    rmSync(RT_LOCK, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// Heal the tree/index left by a CRASHED round-trip. Runs before anything else
// on every invocation; a live lock means an instance is legitimately mid-flight.
function recoverInterruptedRoundTrip() {
  if (!existsSync(RT_JOURNAL) || roundTripLockIsLive()) return;
  let j = null;
  try {
    j = JSON.parse(readFileSync(RT_JOURNAL, 'utf8'));
  } catch {
    /* corrupt journal — fall through to removal */
  }
  if (j?.worktreeTree && j?.stagedTree) {
    const scratch = join(tmpdir(), `audit-tools-gate-recover-${randomBytes(6).toString('hex')}`);
    const union = new Set([...(listTreePaths(j.worktreeTree) ?? []), ...(listTreePaths(j.stagedTree) ?? [])]);
    const restoredWt = checkoutTreeExact(scratch, j.worktreeTree, union);
    const restoredIdx = git(['read-tree', j.stagedTree]).ok;
    try {
      rmSync(scratch, { force: true });
    } catch {
      /* ignore */
    }
    console.error(
      `[pre-commit gate] recovered an INTERRUPTED staged-snapshot round-trip (a previous gate instance was ` +
        `killed mid-flight): worktree ${restoredWt ? 'restored' : 'RESTORE FAILED'}, index ` +
        `${restoredIdx ? 'restored' : 'RESTORE FAILED'}. Verify with \`git status\`.`,
    );
  }
  try {
    rmSync(RT_JOURNAL, { force: true });
  } catch {
    /* ignore */
  }
}
recoverInterruptedRoundTrip();

// Split shell statements (quote-aware — a `;` inside a commit message must not
// break the statement apart) to isolate `git commit` commands and prevent
// false-positives from flags in preceding/succeeding sub-commands (e.g. `grep -n`).
const subCmds = splitShellStatements(cmd);

// Match a git SUBCOMMAND in subcommand position: `git`, then any global options
// (`-C <path>`, `-c <name=val>`, `--flag[=value]`, `-x`), then the subcommand
// token. A substring test (`/\bgit\b[^\n]*\bcommit\b/`) false-positived on any
// command merely NAMING a path that contains "commit" — e.g.
// `git diff -- .claude/hooks/pre-commit-gate.mjs` — and ran the full
// staged-snapshot round-trip (tree/index rewrites + `npm run check`) on
// read-only commands; one such round-trip clobbered the real index live
// (2026-07-23). Known accepted false-negative: a long global option with a
// SPACE-separated value (`git --git-dir x commit`) — exotic, and the gate is a
// footgun guard, not an adversary gate.
function gitSubcommandRe(name) {
  return new RegExp(String.raw`\bgit\b(?:\s+(?:-[cC]\s+\S+|--[\w-]+(?:=\S+)?|-\w))*\s+${name}\b`);
}
// Detection runs on the QUOTE-COLLAPSED statement: `echo "git commit"` is text
// (collapses to `echo ""` — no match), while `git -C "path with spaces" commit`
// collapses to `git -C "" commit` so the option-value hop can span it.
const isGitSubcommand = (name) => (s) => gitSubcommandRe(name).test(collapseQuoted(s));
const commitSubCmds = subCmds.filter(isGitSubcommand('commit'));

// Exit early if no `git commit` invocation exists in any shell statement.
if (commitSubCmds.length === 0) process.exit(0);

// Gate-bypass vectors — a commit that disables hooks makes this gate a no-op,
// so refuse it outright (the gate can't run `check` if git skips the hook, and
// silently allowing the bypass defeats green-at-every-commit).
// `--no-verify` and `core.hooksPath` are matched against the WHOLE command: a
// SIBLING statement can arm the bypass before the commit runs
// (`git config core.hooksPath /dev/null && git commit -m …`), so scoping these
// to commit sub-commands is a hole. Only the short `-n` form stays scoped to
// `git commit` sub-commands — that scoping exists for flags that are common in
// unrelated tools (`grep -n`), which is not true of the other two vectors.
// The `-n` check runs on stripQuoted statements: `-n` inside a quoted commit
// MESSAGE (`git commit -m "use grep -n output"`) is text, not a flag, and must
// not false-trip the bypass detection. The long-form vectors stay RAW-matched
// against the whole command on purpose (fail-closed): a QUOTED flag is still a
// real flag to the shell (`git -c "core.hooksPath=x" commit`), so blanking
// quoted spans there would open an evasion, and a commit message that merely
// MENTIONS `--no-verify` is rare enough to accept the false block.
if (
  /--no-verify\b|\bcore\.hooksPath\b/.test(cmd) ||
  commitSubCmds.some((sub) => /(?:^|\s)-n(?=\s|$)/.test(stripQuoted(sub)))
) {
  console.error(
    'pre-commit gate: commit rejected — hook-bypass detected (`--no-verify`/`-n` or a `core.hooksPath` override anywhere in the command). ' +
      'These skip the green-at-every-commit gate. Remove the bypass and commit normally; if `npm run check` fails, fix it first.',
  );
  process.exit(2);
}

// Whether the command sequence stages changes (e.g. `git add -A && git commit` or `git commit -a`).
// When true, the gate inspects both currently staged files and pending modified/untracked files
// so chained commands cannot bypass loop-core / doc-contract gates before staging occurs.
// Raw-matched (not stripQuoted): a quoted `"-a"` still stages, and the cost of
// a message-text false positive here is only a WIDER inspection set — the safe
// direction. The short-flag form matches inside a CLUSTER too (`git commit -am`
// stages exactly like `-a -m`; missing the cluster form was a bypass).
const hasStageCommand =
  subCmds.some(isGitSubcommand('add')) ||
  commitSubCmds.some((s) => /(?:^|\s)(?:-(?!-)[a-zA-Z]*a[a-zA-Z]*|--all)(?=\s|$)/.test(s));

// A chained `node .claude/hooks/attest-loop-core-review.mjs … && git commit …`
// CANNOT satisfy the loop-core attestation check: PreToolUse fires once, on the
// whole Bash call, so the attest half has not run when this gate reads the
// attestation directory. Accepting the chain instead of blocking is not an
// option — the gate would then be trusting an attestation whose verdict it has
// never seen (`--verdict block` would sail through). So the chain stays blocked
// and the MESSAGE names the real cause; otherwise the generic "no attestation"
// text sends the agent off to write one it demonstrably just wrote.
//
// Raw-matched, for the same reason `hasStageCommand` above is: a QUOTED script
// path still runs the script, and stripQuoted blanks quoted-span CONTENT — so
// every shape an agent naturally writes (`node ".claude/hooks/attest-…mjs"`,
// `node "$CLAUDE_PROJECT_DIR/.claude/hooks/attest-…mjs"`, the single-quoted
// form) had the script name erased before the scan saw it, and the note was
// dropped exactly when it was needed. A commit message that merely NAMES the
// attest script now adds the note to an already-blocking message — a false
// positive here only costs one extra explanatory paragraph, the safe direction.
const chainsAttestation = subCmds.some((s) =>
  /attest-loop-core-review(?:\.mjs)?\b|attest-constitutional-doc-change(?:\.mjs)?\b/.test(s),
);
const CHAINED_ATTEST_NOTE =
  `\n⚠ This command CHAINS the attestation with the commit. That can never pass: PreToolUse fires once, ` +
  `on the whole command, so the attest step has not run yet when this gate reads the attestation. ` +
  `Run the attest command as its OWN tool call, then commit in a second call.`;

// ── Fail-open announcement ───────────────────────────────────────────────────
// The gate fails OPEN on infra faults (never wedge the session) — but a silent
// fail-open is indistinguishable from a clean pass, so the commit it waved
// through looks verified when nothing checked it. Every fail-open path states
// which check it skipped. Written to stderr on an allow (exit 0), so it is
// advice, not a block.
function noteFailOpen(reason) {
  console.error(`[pre-commit gate] FAIL-OPEN (allowing the commit): ${reason}`);
}

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

// The tree SHA an attestation binds to — the exact snapshot the commit will
// carry. When the command stages the working tree first (`git add -A && git
// commit`, `git commit -a`/`-am`) that snapshot is the WORKTREE tree, captured
// through a SCRATCH index so the real staged index is never touched; otherwise
// it is the staged-index tree. Returns null on a git fault, and every caller
// fails OPEN on that (an infra fault must not wedge the session) while failing
// CLOSED on a missing/stale attestation.
//
// Single-sourced because two independent gates below bind to it — the loop-core
// review attestation and the constitutional-doc override. Two copies of a
// binding rule is two chances for one of them to bind to the wrong tree.
// Memoized: both gates can fire on one commit, and the `hasStageCommand` path
// costs a whole scratch-index `git add -A` capture.
let boundStagedTreeSha;
function bindStagedTreeSha() {
  if (boundStagedTreeSha !== undefined) return boundStagedTreeSha;
  boundStagedTreeSha = computeStagedTreeSha();
  return boundStagedTreeSha;
}

function computeStagedTreeSha() {
  if (hasStageCommand) {
    const scratchIndex = join(tmpdir(), `scratch-idx-${randomBytes(6).toString('hex')}`);
    let sha = null;
    if (gitWithIndex(scratchIndex, ['read-tree', 'HEAD']).ok && gitWithIndex(scratchIndex, ['add', '-A']).ok) {
      const wtScratch = gitWithIndex(scratchIndex, ['write-tree']);
      if (wtScratch.ok) sha = wtScratch.stdout.trim();
    }
    try {
      rmSync(scratchIndex, { force: true });
    } catch {
      /* ignore */
    }
    if (sha) return sha;
  }
  const wt = git(['write-tree']);
  return wt.ok ? wt.stdout.trim() : null;
}

// The path set this commit will carry in the INDEX sense: the staged listing,
// widened with pending worktree changes when the command stages before
// committing (`git add -A && git commit`, `git commit -a`/`-am`) so a chained
// add cannot slip paths past a staged-set-triggered gate. Null on a git fault —
// every caller fails open on that, announcing which check it skipped.
// Single-sourced because two gates key off it (the branch-strand refusal in the
// main flow, and every staged-set trigger inside runGate); two copies of "what
// this commit stages" is two chances for one of them to answer differently.
function collectStagedSet() {
  const cached = git(['diff', '--cached', '--name-only']);
  if (!cached.ok) return null;
  const staged = cached.stdout
    .split(/\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!hasStageCommand) return staged;
  const status = git(['status', '--porcelain']);
  if (!status.ok) return staged;
  const pending = status.stdout
    .split(/\r?\n/)
    .map((line) => line.slice(3).trim())
    .map((p) => (p.includes(' -> ') ? p.split(' -> ')[1] : p))
    .filter(Boolean);
  return Array.from(new Set([...staged, ...pending]));
}

// Run the full gate (typecheck + conditional doc-contract subset) against
// whatever is currently in the working tree. Returns { blocked, message }.
// `blocked` true => a gate RESULT failed (fail-closed). Infra faults inside are
// NOT treated as blocking (return blocked:false) so the caller can fail open.
// `committedPaths` is the full path listing of the tree the commit will carry
// (null on an infra fault — path-membership checks then skip, fail-open).
function runGate(committedPaths) {
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
  const staged = collectStagedSet();
  if (staged === null) {
    // Fail open, but SAY SO: a gate that degrades in silence reads exactly like
    // a gate that ran and passed, so the one commit it waved through looks
    // verified. Every fail-open below announces which check it skipped.
    noteFailOpen('cannot list the staged set (`git diff --cached` failed) — doc-contract and loop-core checks SKIPPED');
    return { blocked: false };
  }

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

  // 2b. Doc-manifest reconciliation — whenever the STAGED set carries ANY
  // markdown or the canonical manifest data that renders the guidelines table.
  // `check:doc-manifest` lives in `verify:checks` (the CI gate job),
  // which no local preflight runs in full, so an unregistered doc rode to CI and
  // burned a release tag three times (v0.33.8, v0.34.4, v0.34.17). The checker
  // enumerates GIT-TRACKED docs — which is exactly why running it here is
  // correct and running it ad-hoc is not: this gate has materialized the staged
  // snapshot, so `git ls-files` sees the same tree CI will, including a
  // brand-new doc that an untracked-file check would miss.
  //
  // The trigger was `^docs/.*\.md$` while the checker only enumerated `docs/`.
  // The checker now reconciles the WHOLE tracked markdown tree (that narrowness
  // is how a retired proxy-setup example sat unregistered with
  // nothing to catch it), so the trigger must widen with it — a trigger narrower
  // than the check it fires plants violations the gate never runs on. Same
  // reasoning as the `paths:` filters in .github/workflows/ci.yml.
  const pinsDocManifest = (p) => {
    const normalized = p.replace(/\\/g, '/');
    return /\.md$/i.test(normalized) || normalized === 'scripts/doc-manifest-data.mjs';
  };
  if (staged.some(pinsDocManifest)) {
    try {
      execSync('npm run check:doc-manifest', {
        cwd: root,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
        windowsHide: true,
      });
    } catch (err) {
      const tail = `${err.stdout ?? ''}\n${err.stderr ?? ''}`.trim().split('\n').slice(-20).join('\n');
      return {
        blocked: true,
        message:
          `pre-commit gate: doc-manifest check FAILED — commit blocked. A staged markdown file is not ` +
          `registered in the canonical doc manifest (scripts/doc-manifest-data.mjs), or a row points at a ` +
          `deleted file, or the rendered table in docs/doc-review-guidelines.md is out of date. This is the ` +
          `check that fails RELEASE CI and burns a release tag.\n` +
          `Register the doc (type + reason to exist) in scripts/doc-manifest-data.mjs and re-render with ` +
          `\`node scripts/check-doc-manifest.mjs --write\`, or delete the doc.\n${tail}`,
      };
    }
  }

  // 2b-ii. Guard-reach reconciliation — UNCONDITIONAL, deliberately. The check
  // reconciles the whole tracked tree against the guard registry
  // (scripts/guard-reach-data.mjs), and tree membership changes on ANY staged
  // add/delete/rename while wiring changes ride package.json, settings.json or
  // a hook edit — a trigger list would have to name all of that and would drift
  // narrower than the check (the exact trap 2b documents above). The check is
  // ~1s against the materialized snapshot; the typecheck leg above already
  // costs an order of magnitude more on every commit.
  // Repos that don't wire the script (the contract tests' fixture repos) skip
  // with an ANNOUNCED fail-open. A commit deleting the script from this repo's
  // package.json therefore skips too — a gate cannot report its own deletion
  // (same accepted property as the doc-manifest leg); the announcement is what
  // keeps the skip from reading as a pass.
  let hasGuardReachScript = false;
  try {
    hasGuardReachScript = Boolean(
      JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts?.['check:guard-reach'],
    );
  } catch {
    // unreadable package.json — the typecheck leg above already dealt with worse
  }
  if (!hasGuardReachScript) {
    noteFailOpen('check:guard-reach is not wired in this repo — guard-reach leg SKIPPED');
  } else
  try {
    execSync('npm run check:guard-reach', {
      cwd: root,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
      windowsHide: true,
    });
  } catch (err) {
    const tail = `${err.stdout ?? ''}\n${err.stderr ?? ''}`.trim().split('\n').slice(-20).join('\n');
    return {
      blocked: true,
      message:
        `pre-commit gate: guard-reach check FAILED — commit blocked. A tracked file is claimed by no ` +
        `guard row, a guard is wired into no gate, or a hook/check script landed outside the registry ` +
        `(scripts/guard-reach-data.mjs). This is a verify:checks gate — unfixed it fails release CI.\n` +
        `Register the file or guard in scripts/guard-reach-data.mjs (guardedBy a real guard id, or ` +
        `'declared-gap' with the reason), then retry.\n${tail}`,
    };
  }

  // 2b-i. Nightly scheduler prompt ↔ canonical-source parity. The target is
  // WHOLE-FILE generated from the routine contract plus the leg-1 rubric. The
  // old target hand-restated both behind a precedence rule and drifted into
  // banning the shared helper its sources require. Fire on either direction of
  // drift, on the generator itself, and on package.json (which owns the check
  // and release-chain wiring); a verify:checks-only gate first fails in release
  // CI, after the bad second copy has already landed.
  const nightlyPromptInputs = new Set([
    'docs/nightly-routine.md',
    'docs/doc-review-guidelines.md',
    'docs/nightly-routine-prompt.md',
    'scripts/check-nightly-routine-prompt.mjs',
    'package.json',
  ]);
  if (staged.some((p) => nightlyPromptInputs.has(p.replace(/\\/g, '/')))) {
    try {
      execSync('npm run check:nightly-routine-prompt', {
        cwd: root,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
        windowsHide: true,
      });
    } catch (err) {
      const tail = `${err.stdout ?? ''}\n${err.stderr ?? ''}`.trim().split('\n').slice(-20).join('\n');
      return {
        blocked: true,
        message:
          `pre-commit gate: nightly scheduler prompt check FAILED — commit blocked. ` +
          `docs/nightly-routine-prompt.md is generated from docs/nightly-routine.md + ` +
          `docs/doc-review-guidelines.md and may not carry a hand-maintained summary.\n` +
          `Fix: node scripts/check-nightly-routine-prompt.mjs --write — then re-stage the target.\n${tail}`,
      };
    }
  }

  // 2b-ii. HANDOFF roadmap ↔ backlog parity — whenever the STAGED set touches
  // `docs/HANDOFF.md` or any `docs/backlog/*.md`. HANDOFF's ordered roadmap is
  // GENERATED from the backlog (`scripts/shared/generate-handoff-roadmap.mjs`);
  // the two used to carry the same open items as full specs, which is how they
  // drifted, and how ~107 lines of changelog narration regrew in HANDOFF one lap
  // after being cut. Both directions of edit can stale it, so both trigger.
  //
  // Wired HERE as well as in `verify:checks` deliberately: the pre-commit hook
  // does NOT run `verify:checks`, so a gate wired only there first fails in
  // RELEASE CI and burns a tag — the class that burned v0.34.17.
  const pinsRoadmap = (p) => {
    const n = p.replace(/\\/g, '/');
    return n === 'docs/HANDOFF.md' || /^docs\/backlog\/[^/]+\.md$/.test(n);
  };
  if (staged.some(pinsRoadmap)) {
    try {
      execSync('npm run check:handoff-roadmap', {
        cwd: root,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
        windowsHide: true,
      });
    } catch (err) {
      const tail = `${err.stdout ?? ''}\n${err.stderr ?? ''}`.trim().split('\n').slice(-20).join('\n');
      return {
        blocked: true,
        message:
          `pre-commit gate: HANDOFF roadmap check FAILED — commit blocked. docs/HANDOFF.md's generated ` +
          `roadmap no longer matches docs/backlog/, so the two are once again separate homes for the same ` +
          `open items.\n` +
          `Fix: node scripts/shared/generate-handoff-roadmap.mjs — then re-stage docs/HANDOFF.md.\n` +
          `Do NOT hand-edit inside the BEGIN/END GENERATED ROADMAP markers; the entry text lives in the ` +
          `backlog and nowhere else.\n${tail}`,
      };
    }
  }

  // 2b-iii. Backlog seek-index ↔ backlog parity — whenever the STAGED set
  // touches `docs/backlog.md` or any `docs/backlog/*.md`. The index gives every
  // entry a `file:line` anchor so `open-bugs.md` is navigable in bounded reads
  // without being split. Line numbers move under EVERY edit to a backlog file,
  // so this stales far more easily than the roadmap does — and a stale anchor is
  // worse than no anchor, because it sends the reader to confidently wrong prose
  // rather than to nothing.
  //
  // Wired HERE as well as in `verify:checks` for the same reason as 2b-ii.
  const pinsBacklogIndex = (p) => {
    const n = p.replace(/\\/g, '/');
    return n === 'docs/backlog.md' || /^docs\/backlog\/[^/]+\.md$/.test(n);
  };
  if (staged.some(pinsBacklogIndex)) {
    try {
      execSync('npm run check:backlog-index', {
        cwd: root,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
        windowsHide: true,
      });
    } catch (err) {
      const tail = `${err.stdout ?? ''}\n${err.stderr ?? ''}`.trim().split('\n').slice(-20).join('\n');
      return {
        blocked: true,
        message:
          `pre-commit gate: backlog seek-index check FAILED — commit blocked. docs/backlog.md's generated ` +
          `index no longer matches docs/backlog/, so its line anchors point at the wrong entries.\n` +
          `Fix: node scripts/shared/generate-backlog-index.mjs — then re-stage docs/backlog.md.\n` +
          `Do NOT hand-patch line numbers inside the BEGIN/END GENERATED SEEK INDEX markers; they are ` +
          `derived, and the next backlog edit moves them again.\n${tail}`,
      };
    }
  }

  // 2c. Hook-tracking invariant. `.gitignore` ignores `.claude/hooks/*` and
  // re-includes each hook BY NAME, so a new hook committed without its
  // `!.claude/hooks/<name>` line is silently dropped from the commit — and if
  // the (tracked) settings.json references it, main points at a hook that is not
  // there. Bit once (friction-stop-gate.mjs).
  //
  // Asserted against the COMMITTED PATH SET — the listing of the exact tree the
  // commit will carry — never the filesystem: an ignored-but-present hook file
  // passes an existsSync check while the commit silently drops it, which is the
  // precise trap this check exists to close. If settings.json is unreadable
  // there is nothing to assert; if the path set could not be computed
  // (committedPaths null) this skips, fail-open on infra.
  if (!committedPaths) {
    noteFailOpen('could not enumerate the committed path set — the hook-tracking invariant was SKIPPED');
  }
  if (committedPaths) try {
    const settingsText = readFileSync(join(root, '.claude', 'settings.json'), 'utf8');
    const referenced = [
      ...new Set([...settingsText.matchAll(/\.claude\/hooks\/([\w.-]+)/g)].map((m) => `.claude/hooks/${m[1]}`)),
    ];
    const missing = referenced.filter((p) => !committedPaths.has(p));
    if (missing.length > 0) {
      return {
        blocked: true,
        message:
          `pre-commit gate: commit blocked — .claude/settings.json references hook file(s) this commit would ` +
          `NOT carry, so main would point at hooks that are not there:\n` +
          missing.map((p) => `  - ${p}`).join('\n') +
          `\n.gitignore ignores \`.claude/hooks/*\` and re-includes each hook BY NAME. In THIS commit: add the ` +
          `matching \`!${missing[0]}\` line to .gitignore and \`git add\` the hook file.`,
      };
    }
  } catch {
    /* settings.json absent/unreadable in the snapshot — nothing to assert */
  }

  // 2d. Constitutional-doc refusal — only when the STAGED set touches a doc that
  // defines what the project IS (src/shared/constitutionalDocPaths.ts: the two
  // philosophies, the instruction files, the doc-review rubric, the normative
  // spec/audit contracts and goals docs).
  //
  // The manifest already CALLED these escalate-only and "never silently
  // rewritten to match code". Commit 6fc2e453 — a routine doc-review sweep —
  // rewrote spec/remediate/remediation-goals.md anyway, bundled with eight other
  // files, and nothing objected. The gap was a REFUSAL, not a label: a doc that
  // says what the project should be is the one thing that must not be quietly
  // edited to match what the code happens to do, because then nothing is left to
  // measure the code against.
  //
  // The override is the SAME mechanism as the loop-core attestation below, not a
  // second one: a record bound to the exact staged tree, naming who issued it and
  // what the owner decided. FAIL-CLOSED on a missing/stale/incomplete record;
  // FAIL-OPEN only on a genuine git write-tree fault.
  const constitutionalStaged = staged.filter(isConstitutionalDocPath);
  if (constitutionalStaged.length > 0) {
    const sha = bindStagedTreeSha();
    const overrideHint =
      `node scripts/attest-constitutional-doc-change.mjs --reviewed-by <id> ` +
      `--attester-class <agent|human> --owner-decision "<the owner's call, and where it was escalated>"`;
    if (!sha) {
      noteFailOpen(
        'cannot bind the staged tree (`git write-tree` failed) — the CONSTITUTIONAL-DOC refusal was SKIPPED ' +
          `for ${constitutionalStaged.length} normative doc(s). This commit carries NO override record.`,
      );
    } else {
      const overridePath = join(root, '.claude', 'constitutional-doc-review', sha + '.json');
      const blockMessage = (why, extra = '') => ({
        blocked: true,
        message:
          `pre-commit gate: commit blocked — it rewrites CONSTITUTIONAL doc(s), and ${why}.\n` +
          constitutionalStaged.map((p) => `  - ${p}`).join('\n') +
          `\nThese state what this project IS; the doc-review manifest routes every one of them as ` +
          `escalate-only ("never silently rewritten to match code"). Editing one to match current code ` +
          `destroys the thing the code is measured against — which is exactly what commit 6fc2e453 did to ` +
          `spec/remediate/remediation-goals.md inside a routine doc-review sweep.\n` +
          `If the owner has decided this change, record that decision and retry:\n  ${overrideHint}\n` +
          `Otherwise: unstage the constitutional doc(s), ship the rest, and escalate the change.` +
          extra +
          (chainsAttestation ? CHAINED_ATTEST_NOTE : ''),
      });
      if (!existsSync(overridePath)) {
        return blockMessage(
          'no owner-decision override record exists for the staged tree',
          `\n(The override binds to the exact staged tree ${sha.slice(0, 12)} — restaging invalidates it.)`,
        );
      }
      let override;
      try {
        override = JSON.parse(readFileSync(overridePath, 'utf8'));
      } catch {
        return blockMessage(
          `the override record at .claude/constitutional-doc-review/${sha}.json is unreadable/corrupt`,
        );
      }
      if (override?.staged_tree !== sha) {
        return blockMessage(
          `the override record is STALE (binds tree ${String(override?.staged_tree).slice(0, 12)}, staged ` +
            `tree is ${sha.slice(0, 12)})`,
        );
      }
      if (typeof override.owner_decision !== 'string' || override.owner_decision.trim() === '') {
        return blockMessage('the override record names no owner decision');
      }
      // A record written before this commit grew a NEW constitutional path can
      // only exist if the tree hash matched — which it cannot, since staging a
      // file changes the tree. Assert coverage anyway: the record is the audit
      // trail, and a path it does not name is a path nobody signed off on.
      const uncovered = constitutionalStaged.filter(
        (p) => !(override.constitutional_files ?? []).includes(p),
      );
      if (uncovered.length > 0) {
        return blockMessage(
          `the override record does not cover ${uncovered.join(', ')}`,
        );
      }
    }
  }

  // 3. Loop-core adversarial-review attestation — only when the STAGED set
  // touches a loop-core path. Hand-authored loop-core edits must carry a FRESH,
  // staged-tree-hash-bound review attestation. This enforces attestation
  // existence + freshness + binding MECHANICALLY; review QUALITY is carried by
  // an attributable, tree-bound audit record — the attestation records the
  // attester's CLASS (agent or human) and the reviewing identities, it cannot
  // enforce that a human reviewed (the honest limit). FAIL-CLOSED on a
  // missing/stale attestation for loop-core; FAIL-OPEN only on a genuine git
  // write-tree fault.
  if (staged.some(pinsLoopCore)) {
    const loopCoreStaged = staged.filter(pinsLoopCore);
    const sha = bindStagedTreeSha();
    if (!sha) {
      noteFailOpen(
        'cannot bind the staged tree (`git write-tree` failed) — the LOOP-CORE ATTESTATION check was SKIPPED ' +
          `for ${loopCoreStaged.length} loop-core path(s). This commit is NOT attested.`,
      );
      return { blocked: false }; // can't bind → don't wedge (infra fail-open)
    }
    const attestPath = join(root, '.claude', 'loop-core-review', sha + '.json');
    const runHint =
      `node .claude/hooks/attest-loop-core-review.mjs --reviewed-by <id> ` +
      `--attester-class <agent|human> --checked "<what was adversarially checked>"`;
    if (!existsSync(attestPath)) {
      return {
        blocked: true,
        message:
          `pre-commit gate: loop-core commit blocked — no adversarial-review attestation for the staged tree.\n` +
          `The staged set touches loop-core (dispatch/quota/rolling/orchestrator substrate):\n` +
          loopCoreStaged.map((p) => `  - ${p}`).join('\n') +
          `\nHand-authored loop-core edits require a FRESH, staged-tree-bound review. Run:\n  ${runHint}\n` +
          `then retry the commit (the attestation binds to the exact staged tree ${sha.slice(0, 12)}).` +
          (chainsAttestation ? CHAINED_ATTEST_NOTE : ''),
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
          `Re-review the current staged snapshot:\n  ${runHint}` +
          (chainsAttestation ? CHAINED_ATTEST_NOTE : ''),
      };
    }
    // Destination-keyed strictness: the gate protects what can LAND on main,
    // not the act of committing. A `concerns` verdict without an override blocks
    // only when the commit can reach main (current branch IS main) — preserving
    // review-blocked WIP on a side branch is the wanted path and must not force
    // an override, or the override trains into a reflex and stops signalling.
    // `block` always blocks; an unreadable branch state stays strict (fail-closed).
    let concernsBlocks = attest.verdict === 'concerns' && !attest.override;
    if (concernsBlocks) {
      const br = git(['rev-parse', '--abbrev-ref', 'HEAD']);
      if (br.ok && br.stdout.trim() !== 'main') concernsBlocks = false;
    }
    if (attest.verdict === 'block' || concernsBlocks) {
      return {
        blocked: true,
        message:
          `pre-commit gate: loop-core commit blocked — the review recorded verdict "${attest.verdict}"` +
          (attest.checked ? ` (checked: ${attest.checked})` : '') +
          `. Resolve the concerns and re-attest, or re-run with --override "<reason>" if intentional ` +
          `(a \`concerns\` attestation is accepted without an override on a non-main branch — WIP preservation):\n  ${runHint}`,
      };
    }
  }

  // 4. Relative-link resolution. A dead relative link is fully mechanical (the
  // target resolves or it does not) and had recurred on three dates before this
  // gate existed; three links in the last occurrence were created by that run's
  // own doc moves, because a mover fixes the file it moved and cannot see the
  // inbound links elsewhere. Fires on the generators too — they copy entry titles
  // VERBATIM one directory up, so a link correct at the source dies at the
  // destination, and the fix belongs in the lift, never in the generated file.
  //
  // ⚠ THIS RUNS LAST, DELIBERATELY. It is the broadest trigger in the gate (any
  // staged markdown), so placing it earlier made it mask every more-specific
  // refusal behind it — the constitutional-doc escalation, the generator-parity
  // checks, and the loop-core attestation all reported "doc-links FAILED" instead
  // of their own actionable message. A broad mechanical check must never preempt
  // a structural one; the specific refusal is the more useful signal.
  const pinsDocLinks = (p) => {
    const normalized = p.replace(/\\/g, '/');
    return (
      /\.md$/i.test(normalized) ||
      normalized === 'scripts/shared/rebase-relative-links.mjs' ||
      normalized === 'scripts/shared/generate-handoff-roadmap.mjs' ||
      normalized === 'scripts/shared/generate-backlog-index.mjs' ||
      normalized === 'scripts/check-doc-links.mjs'
    );
  };
  if (staged.some(pinsDocLinks)) {
    try {
      execSync('npm run check:doc-links', {
        cwd: root,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
        windowsHide: true,
      });
    } catch (err) {
      const tail = `${err.stdout ?? ''}\n${err.stderr ?? ''}`.trim().split('\n').slice(-30).join('\n');
      return {
        blocked: true,
        message:
          `pre-commit gate: doc-links check FAILED — commit blocked. A relative markdown link does not ` +
          `resolve on disk.\n` +
          `⚠ If the dead link is in a GENERATED doc (docs/HANDOFF.md, docs/backlog.md), fix the LIFT in ` +
          `scripts/shared/rebase-relative-links.mjs — editing the generated file is overwritten by the ` +
          `next regeneration.\n${tail}`,
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

// ── Branch-strand refusal ────────────────────────────────────────────────────
// A remediation run switches the PRIMARY checkout onto `remediation/<runId>`
// (`ensureRemediationBranchCheckedOut`) at implement-dispatch and leaves it
// there, so every later commit from that checkout lands on the run branch — a
// docs/closeout commit made afterwards strands off main. It has bitten three
// times; HANDOFF has carried a "verify HEAD before committing" warning since the
// second bite and the warning did not prevent the third, because remembering is
// not a mechanism.
//
// The discriminator is mechanical, not a judgement call: remediation edits are
// produced in the per-node LINKED worktrees and merged by accept-node, so a
// staged set that is ENTIRELY docs/spec on a `remediation/*` HEAD is main-bound
// prose that lost its branch, not run output. Refused BEFORE the staged-snapshot
// round-trip — a commit that must not happen should cost two git reads, not a
// worktree rewrite plus a full typecheck.
const isDocOrSpecPath = (p) => {
  const n = p.replace(/\\/g, '/').replace(/^\.\//, '');
  return /\.md$/i.test(n) || n.startsWith('docs/') || n.startsWith('spec/');
};
const headBranch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
const headBranchName = headBranch.ok ? headBranch.stdout.trim() : '';
if (headBranchName.startsWith('remediation/')) {
  const stagedForStrand = collectStagedSet();
  if (stagedForStrand === null) {
    noteFailOpen(
      'cannot list the staged set (`git diff --cached` failed) — the BRANCH-STRAND refusal was SKIPPED, ' +
        `and HEAD is the remediation run branch ${headBranchName}. Verify where this commit lands.`,
    );
  } else if (stagedForStrand.length > 0 && stagedForStrand.every(isDocOrSpecPath)) {
    console.error(
      `pre-commit gate: commit blocked — HEAD is the remediation run branch \`${headBranchName}\` and every ` +
        `staged path is docs/spec, so this commit would STRAND off main:\n` +
        stagedForStrand.map((p) => `  - ${p}`).join('\n') +
        `\nA remediation run switches this checkout onto \`remediation/<runId>\` and leaves it there. Run ` +
        `output is produced in the per-node linked worktrees, not here — so a prose-only commit from this ` +
        `checkout is main-bound work that lost its branch. This has happened three times.\n` +
        `Recovery — land it on main; the staged set follows the checkout:\n` +
        `  git checkout main && git commit …\n` +
        `then \`git checkout ${headBranchName}\` to resume the run. If the checkout refuses because a staged ` +
        `path differs between the branches, \`git stash --include-untracked\` first, then \`git stash pop\` ` +
        `on main.\n` +
        `If this prose genuinely belongs to the RUN, commit it together with the code change it documents.`,
    );
    process.exit(2);
  }
}

// ── Gate the staged snapshot, restoring the working tree afterward. ──────────
const diverges = workingTreeDivergesFromIndex();
if (diverges === null) {
  // Not a git repo / git error — can't reason about the staged snapshot.
  // FAIL-OPEN: allow the commit rather than wedge the session — but announce it,
  // or a skipped gate is indistinguishable from a passed one.
  noteFailOpen('`git status` failed (not a repo, or a git fault) — the ENTIRE gate was SKIPPED for this commit');
  process.exit(0);
}

// The full path listing of the tree the commit will carry, for the direct
// (non-materialized) check paths. Null on any git fault — membership checks
// then skip (fail-open on infra).
function committedPathsForDirectCheck() {
  if (hasStageCommand) {
    // The command stages the working tree before committing — the committed
    // tree is the worktree tree (tracked + untracked-unignored, deletions
    // honored), captured via the scratch index.
    const scratch = join(tmpdir(), `audit-tools-gate-paths-${randomBytes(6).toString('hex')}`);
    const tree = captureWorktreeTree(scratch);
    try { rmSync(scratch, { force: true }); } catch { /* ignore */ }
    const paths = tree === null ? null : listTreePaths(tree);
    return paths === null ? null : new Set(paths);
  }
  const wt = git(['write-tree']);
  if (!wt.ok) return null;
  const paths = listTreePaths(wt.stdout.trim());
  return paths === null ? null : new Set(paths);
}

if (!diverges || hasStageCommand) {
  // Working tree == staged index (nothing to materialize), OR the command
  // itself stages the working tree before committing (`git add -A && git
  // commit`, `git commit -a`/`-am`) — in both cases the WORKING TREE is the
  // snapshot that lands, so check it directly. (For a PARTIAL `git add <paths>`
  // chain the worktree is an approximation — exactness would need simulating
  // the add — but the old behavior checked the PRE-add index, which is wrong in
  // strictly more cases and let a chained add+commit land unchecked content.)
  const { blocked, message } = runGate(committedPathsForDirectCheck());
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
//
// Serialized: a second gate instance mid-round-trip means interleaved tree
// surgery — fail OPEN instead (skip the check), never overlap.
if (!acquireRoundTripLock()) {
  console.error(
    '[pre-commit gate] another staged-snapshot round-trip is in flight — skipping the staged-snapshot ' +
      'check for this commit (fail-open; retry if you need the gate to run).',
  );
  process.exit(0);
}
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
  releaseRoundTripLock();
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
  releaseRoundTripLock();
  console.error(
    `[pre-commit gate] could not enumerate the staged snapshot (git ls-tree failed) — ` +
      `skipping the staged-snapshot check for this commit.`,
  );
  process.exit(0); // FAIL-OPEN on infra fault
}
const unionPaths = new Set([...stagedPaths, ...worktreePaths]);

// Journal the round-trip BEFORE the first worktree mutation: if this process is
// killed anywhere past this point, the next gate invocation restores both trees
// from these SHAs (they live in the object db and survive the crash).
try {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(RT_JOURNAL, JSON.stringify({ worktreeTree, stagedTree, at: new Date().toISOString() }, null, 2));
} catch {
  // Can't journal → don't take an unrecoverable risk: skip the check (fail-open).
  try { rmSync(scratchIndex, { force: true }); } catch { /* ignore */ }
  releaseRoundTripLock();
  console.error(
    '[pre-commit gate] could not write the round-trip recovery journal — skipping the staged-snapshot ' +
      'check for this commit (a crash mid-check would otherwise be unrecoverable).',
  );
  process.exit(0);
}

// 2. Materialize the staged tree into the worktree.
if (!checkoutTreeExact(scratchIndex, stagedTree, unionPaths)) {
  checkoutTreeExact(scratchIndex, worktreeTree, unionPaths); // best-effort restore
  try { rmSync(scratchIndex, { force: true }); } catch { /* ignore */ }
  try { rmSync(RT_JOURNAL, { force: true }); } catch { /* ignore */ }
  releaseRoundTripLock();
  console.error(
    `[pre-commit gate] could not materialize the staged snapshot (git checkout-index failed) — ` +
      `skipping the staged-snapshot check for this commit.`,
  );
  process.exit(0); // FAIL-OPEN on infra fault
}

let exitCode = 0;
try {
  // 3. Gate the materialized staged snapshot. The committed tree here IS the
  // staged tree, whose listing is already in hand.
  const { blocked, message } = runGate(new Set(stagedPaths));
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
  if (restoredWt && restoredIdx) {
    try { rmSync(RT_JOURNAL, { force: true }); } catch { /* ignore */ }
  }
  // On a FAILED restore the journal stays: the next invocation retries the
  // recovery from the journaled SHAs.
  releaseRoundTripLock();
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
