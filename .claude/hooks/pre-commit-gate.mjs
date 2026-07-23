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
// FRESH, staged-tree-hash-bound review attestation exists. This re-declares the
// canonical pattern list from `src/shared/loopCorePaths.ts` (the .mjs hook can't
// import the TS module — it runs under plain node, pre-build); a parity test
// (`tests/shared/loop-core-gate-parity.test.mjs`) pins the two byte-equal so
// they can never drift. A "/"-terminated pattern is a directory prefix; every
// other entry is an exact repo-relative path.
const LOOP_CORE_PATTERNS = [
  "src/audit/cli/dispatch.ts",
  "src/audit/cli/dispatch/",
  "src/audit/cli/mergeAndIngestCommand.ts",
  "src/audit/cli/ownerTokens.ts",
  "src/audit/cli/rollingAuditDispatch.ts",
  "src/audit/orchestrator/",
  "src/remediate/riskSignal.ts",
  "src/remediate/steps/contractPipeline.ts",
  "src/remediate/steps/dispatch/",
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
  const cached = git(['diff', '--cached', '--name-only']);
  if (!cached.ok) return { blocked: false }; // can't list staged — skip subset
  let staged = cached.stdout
    .split(/\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  if (hasStageCommand) {
    const status = git(['status', '--porcelain']);
    if (status.ok) {
      const pending = status.stdout
        .split(/\r?\n/)
        .map((line) => line.slice(3).trim())
        .map((p) => (p.includes(' -> ') ? p.split(' -> ')[1] : p))
        .filter(Boolean);
      staged = Array.from(new Set([...staged, ...pending]));
    }
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

  // 2b. Doc-manifest reconciliation — only when the STAGED set carries a
  // `docs/**/*.md`. `check:doc-manifest` lives in `verify:checks` (the CI gate
  // job), which no local preflight runs in full, so an unregistered doc rode to
  // CI and burned a release tag three times (v0.33.8, v0.34.4, v0.34.17). The
  // checker enumerates GIT-TRACKED docs — which is exactly why running it here
  // is correct and running it ad-hoc is not: this gate has materialized the
  // staged snapshot, so `git ls-files` sees the same tree CI will, including a
  // brand-new doc that an untracked-file check would miss.
  if (staged.some((p) => /^docs\/.*\.md$/i.test(p.replace(/\\/g, '/')))) {
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
          `pre-commit gate: doc-manifest check FAILED — commit blocked. A staged doc under docs/ is not ` +
          `registered in the routing table in docs/doc-review-guidelines.md (or a row points at a deleted ` +
          `file). This is the check that fails RELEASE CI and burns a release tag.\n` +
          `Register the doc (type + reason) in the routing table, or delete it.\n${tail}`,
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
    let sha = null;
    if (hasStageCommand) {
      const scratchIndex = join(tmpdir(), `scratch-idx-${randomBytes(6).toString('hex')}`);
      if (gitWithIndex(scratchIndex, ['read-tree', 'HEAD']).ok && gitWithIndex(scratchIndex, ['add', '-A']).ok) {
        const wtScratch = gitWithIndex(scratchIndex, ['write-tree']);
        if (wtScratch.ok) sha = wtScratch.stdout.trim();
      }
      try {
        rmSync(scratchIndex, { force: true });
      } catch {
        /* ignore */
      }
    }
    if (!sha) {
      const wt = git(['write-tree']);
      if (!wt.ok) return { blocked: false }; // can't bind → don't wedge (infra fail-open)
      sha = wt.stdout.trim();
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
