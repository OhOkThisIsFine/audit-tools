#!/usr/bin/env node
// The commit gate at GIT'S OWN BOUNDARY: block a commit until `npm run check`
// is green on the staged snapshot and every structural refusal below is
// satisfied. Run by git through the tracked `.githooks/pre-commit`,
// `pre-merge-commit` and `pre-applypatch` hooks (`core.hooksPath` is pointed at
// `.githooks` by session-start-guards.mjs); the hook name rides in argv[2].
// Exit 0 = allow, exit non-zero = git refuses the commit and leaves the index
// staged (stderr reaches the operator or agent through git).
//
// WHY HERE, NOT AT THE TOOL BOUNDARY (P53, owner decision 2026-09-05). The
// legs below used to run inside a Claude Code PreToolUse hook that parsed the
// shell text of every Bash call to find a commit and to GUESS which repository
// it targeted — cd-chain folds, `git -C` hops, a fail-closed default that
// claimed this repository whenever a hop was unresolvable. That default refused
// a `git commit -m init` inside a fresh `mktemp -d` repo on 2026-09-04, naming
// two of this repository's constitutional docs. A gate states the boundary it
// OWNS: git runs THIS repository's hook for THIS repository's commits and never
// for anyone else's, so jurisdiction is by construction and there is nothing to
// parse. What git cannot see — a `--no-verify` or a `core.hooksPath` override
// on the command line, and the incoming content of a fast-forward merge, a
// cherry-pick or a revert (the sequencer runs no pre-commit; measured
// 2026-09-05) — stays with the thin tool-boundary hook (pre-commit-gate.mjs),
// which ROUTES such content to a hooked commit rather than judging it itself.
//
// The root is `git rev-parse --show-toplevel` in the hook's cwd (git runs hooks
// at the worktree's top level), never CLAUDE_PROJECT_DIR: a linked worktree is
// gated against its own tree with the current gate, because the hook file
// resolves this module relative to itself. Under `git commit -a`, git hands the
// hook a temporary index (GIT_INDEX_FILE) that already holds the -a content —
// so the staged snapshot is always exactly what will be committed, and the old
// "the command stages first" approximation is gone.
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
import { rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
// Only the ENV half of the shared bypass mechanic applies here: a git hook has
// no command text, and an inline `NAME=1 git commit …` prefix reaches it as a
// real environment variable — which is exactly what the tool-boundary parser
// used to approximate.
import { bypassEnabled } from './shell-split.mjs';
// The git/tree-snapshot substrate and the round-trip journal are SHARED with
// the tool-boundary hook, which heals a crashed round-trip on every shell call.
import { treeSnapshotTools } from './tree-snapshot.mjs';
// ── Session registry (Build 1 / P23) ─────────────────────────────────────────
// The child-session refusal below keys on the payload's session_id against the
// registry SessionStart writes; the same lib serves the three Stop gates.
import { readSessionRegistry, sanitizeSessionId } from '../../scripts/shared/sessionRegistry.mjs';
// The doc-contract leg RELAYS the gate runner's own attribution line rather
// than asserting a cause; the contract for that line has one home.
import { parseAttributionLine } from '../../scripts/shared/vitestGateVerdict.mjs';

// ── Loop-core adversarial-review gate ────────────────────────────────────────
// Hand-authored (non-node) edits to the dispatch / admission / quota / rolling /
// orchestrator-step substrate carry the highest blast radius and have no
// automated adversarial-review gate; three author-green defects reached main
// this way. Block a commit whose STAGED set touches a loop-core path unless a
// FRESH, staged-tree-hash-bound review attestation exists. The pattern list AND
// the membership predicate are IMPORTED from a generated sibling rather than
// re-declared here: this hook runs under plain node pre-build and cannot import
// `src/shared/loopCorePaths.ts`, but it can import a .mjs generated FROM it, so
// both keep exactly one hand-maintained home. `npm run check:loop-core-patterns`
// (in verify:checks) fails the build if the generated file drifts from the
// source of truth. A "/"-terminated pattern is a directory prefix; every other
// entry is an exact repo-relative path.
import { isLoopCorePath } from "./loop-core-patterns.mjs";

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
// The derived leg set is SINGLE-SOURCED with both attest scripts (P19 + P34):
// legs and triggers are DERIVED from the guard-reach registry
// (scripts/guard-reach-data.mjs — plain-data ESM, importable pre-build), so
// the attest preflight fires on exactly the staged sets this gate fires on, or
// an attestation would bind to a tree this gate rejects. (The nightly queue
// path and grep domain the handoff widening depends on ride along inside.)
import {
  buildPreCommitLegs,
  scriptWired,
} from "../../scripts/shared/derived-file-preflight.mjs";

// Which git hook invoked us — for the messages only; every leg is the same.
const hookName = process.argv[2] || 'pre-commit';
// The repository git is committing into: its worktree top level, resolved in
// the hook's cwd. This is the whole jurisdiction rule.
const toplevel = spawnSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
if (toplevel.status !== 0 || !toplevel.stdout.trim()) {
  // Not inside a git worktree, or git itself is faulting — there is nothing to
  // gate, and a silent exit 0 would read as a pass.
  console.error(
    `[commit gate] FAIL-OPEN (allowing the commit): \`git rev-parse --show-toplevel\` failed — no check ran. ` +
      (toplevel.stderr ?? '').trim(),
  );
  process.exit(0);
}
const root = resolve(toplevel.stdout.trim());
const {
  git,
  captureWorktreeTree,
  listTreePaths,
  checkoutTreeExact,
  STATE_DIR,
  RT_JOURNAL,
  acquireRoundTripLock,
  releaseRoundTripLock,
  recoverInterruptedRoundTrip,
} = treeSnapshotTools(root, { label: `commit gate · ${hookName}` });
// The session that is committing, when a Claude Code session is: the Bash
// tool's environment reaches the hook intact. A plain terminal has no id.
const payloadSessionId = sanitizeSessionId(process.env.CLAUDE_CODE_SESSION_ID);
const insideClaudeSession = Boolean(process.env.CLAUDE_PID || process.env.CLAUDE_CODE_SESSION_ID);

recoverInterruptedRoundTrip();

// ── Child-session refusal (Build 1 / P23) ────────────────────────────────────
// A session with no record in .claude/hooks/.state/sessions/ while the registry
// is armed is a child agent sharing this checkout. Children return work; the
// dispatching session owns git. The allow token is honored through the shared
// bypassEnabled mechanic (hook env or per-dispatch inline assignment); the scan
// runs on heredoc-blanked text so a commit-message BODY naming the token cannot
// enable it. Registry faults degrade to unarmed inside the read (fail open). A
// missing session_id fails open too, but ANNOUNCED when the registry is armed —
// a silent fail-open is indistinguishable from a clean pass; an unarmed
// registry is the normal state and warrants no announcement. The refusal text
// deliberately names no token, script, or doc (P27: a guard must not prescribe
// its own bypass — owners find recovery in durable-traps without being routed).
const registry = readSessionRegistry(root, payloadSessionId);
if (!payloadSessionId) {
  // A plain terminal has no session id and is not a child of anything; only an
  // id-less CLAUDE process is worth announcing.
  if (registry.armed && insideClaudeSession) {
    noteFailOpen('child-session refusal skipped: the committing process carries no CLAUDE_CODE_SESSION_ID');
  }
} else if (
  registry.isUnregisteredChild &&
  !bypassEnabled('AUDIT_TOOLS_AGENT_GIT', '')
) {
  console.error(
    'commit gate: commit refused — this session has no record in the session registry ' +
      '(.claude/hooks/.state/sessions/), so it is treated as a CHILD session working in the shared ' +
      'checkout. Child sessions do not mutate git state here: leave your changes in the tree and ' +
      'return your work as a diff / file list / summary to the dispatching session, which owns ' +
      'commit and push.',
  );
  process.exit(2);
}

// ── Fail-open announcement ───────────────────────────────────────────────────
// The gate fails OPEN on infra faults (never wedge the session) — but a silent
// fail-open is indistinguishable from a clean pass, so the commit it waved
// through looks verified when nothing checked it. Every fail-open path states
// which check it skipped. Written to stderr on an allow (exit 0), so it is
// advice, not a block.
function noteFailOpen(reason) {
  console.error(`[commit gate · ${hookName}] FAIL-OPEN (allowing the commit): ${reason}`);
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
// Memoized: both gates can fire on one commit. Under a git hook the index is
// final (a `git commit -a` already staged its content into the temporary index
// git hands the hook), so the binding is always `git write-tree` on that index.
let boundStagedTreeSha;
function bindStagedTreeSha() {
  if (boundStagedTreeSha !== undefined) return boundStagedTreeSha;
  boundStagedTreeSha = computeStagedTreeSha();
  return boundStagedTreeSha;
}

function computeStagedTreeSha() {
  const wt = git(['write-tree']);
  return wt.ok ? wt.stdout.trim() : null;
}

// The path set this commit will carry: the staged listing of the index git is
// committing (final under a git hook — see computeStagedTreeSha). Null on a git fault —
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
  return staged;
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
    execSync('npm run check', /** @type {any} */ ({
      cwd: root,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 240_000,
      windowsHide: true,
    }));
  } catch (err) {
    const tail = `${/** @type {any} */ (err).stdout ?? ''}\n${/** @type {any} */ (err).stderr ?? ''}`
      .trim()
      .split('\n')
      .slice(-40)
      .join('\n');
    return {
      blocked: true,
      message:
        `commit gate: \`npm run check\` FAILED — commit blocked (green-at-every-commit invariant). ` +
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


  // At git's boundary the staged snapshot IS what the commit carries — for a
  // merge commit the merged index, for `git am` the applied patch, for a routed
  // cherry-pick/revert (`-n`, then `git commit`) the applied result — so the
  // attestation checks read it directly. The verbs git does not hook (a
  // fast-forward merge, a direct cherry-pick or revert) are ROUTED here by the
  // tool-boundary hook when they carry gated content.
  const attestationPaths = staged;

  // The docs/assets the doc-contract subset pins: any markdown (docs/**.md,
  // CLAUDE.md, AGENTS.md, copilot-instructions.md, auditor.agent.md) plus the
  // rendered host assets (opencode.json, .gemini/*).
  const pinsDocContract = (p) =>
    /\.md$/i.test(p) || p === 'opencode.json' || p.startsWith('.gemini/');
  if (staged.some(pinsDocContract)) {
    try {
      execSync('npm run test:doc-contract', /** @type {any} */ ({
        cwd: root,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 240_000,
        windowsHide: true,
      }));
    } catch (err) {
      const full = `${/** @type {any} */ (err).stdout ?? ''}\n${/** @type {any} */ (err).stderr ?? ''}`.trim();
      const tail = full.split('\n').slice(-40).join('\n');
      // RELAY what the gate runner stated; never assert a cause this hook did
      // not observe. The old headline named "a staged doc/asset broke a test
      // that pins its exact content (release-contract / *-doc-sync /
      // host-asset-renderer-drift)" for EVERY failure of this run — including a
      // globalSetup fault, a live child, or a flake — and it named three files
      // while the run has four. The runner owns attribution because it alone
      // holds the run-token-validated ledger; a missing line means it said
      // nothing, which is unattributable, not permission to guess.
      // Read the FULL output, not the 40-line tail: a noisy failure could push
      // the runner's one attribution line out of the excerpt, and the hook
      // would then read a stated verdict as silence.
      const attribution = parseAttributionLine(full);
      const cause = attribution?.attributable
        ? `The run reports ${attribution.failedFiles.length} failing file(s): ` +
          `${attribution.failedFiles.join(', ')}.`
        : `The gate could not tell WHICH file failed — ${
            attribution?.reason ?? 'the runner stated no attribution'
          }. Read the output below rather than assuming a staged doc broke a content pin.`;
      return {
        blocked: true,
        message:
          `commit gate: doc-contract tests FAILED — commit blocked. ${cause} ` +
          `Fix the cause, then retry.\n${tail}`,
      };
    }
  }

  // 2b. DERIVED verify:checks legs (P34, owner decision 2026-08-18). The leg
  // set and every trigger come from the guard-reach registry
  // (scripts/guard-reach-data.mjs) via buildPreCommitLegs — a gate row's
  // preCommit flag states its pre-commit behavior as data ('reach' = staged ∩
  // its REACH-row globs ∪ its impl script ∪ package.json, plus any custom
  // widening; 'always' = unconditional when wired; 'final' = runs LAST, after
  // the structural refusals below; false = deliberate CI-only). The retired
  // shape was eight hand-accreted legs whose trigger lists drifted narrower
  // than the checks they fired — three of them were added one-at-a-time only
  // AFTER each had burned a release tag or turned main red. Now a
  // verify:checks gate cannot be missing here without the registry saying so
  // (check:guard-reach reds a flagless gate row), and a trigger narrower than
  // the check it fires cannot be hand-typed here at all.
  //
  // Wired HERE as well as in `verify:checks` deliberately: the pre-commit hook
  // does NOT run verify:checks, so a gate wired only there first fails in
  // RELEASE CI and burns a tag (the v0.33.8/v0.34.4/v0.34.17 class). This gate
  // has materialized the staged snapshot, so tree-enumerating checks (doc
  // manifest, guard-reach) see the same tree CI will.
  //
  // Repos that don't wire a leg's script (the contract tests' fixture repos)
  // skip that leg with an ANNOUNCED per-leg fail-open. A commit deleting a
  // script from this repo's package.json therefore skips too — a gate cannot
  // report its own deletion (accepted property); the announcement is what
  // keeps the skip from reading as a pass.
  let rootScripts = {};
  try {
    rootScripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts ?? {};
  } catch {
    /* unreadable package.json reads as nothing wired — every leg skips, announced */
  }
  const derivedLegs = buildPreCommitLegs({ packageScripts: rootScripts });
  const runDerivedLeg = (leg) => {
    if (!leg.triggered({ root, staged, git })) return null;
    if (!scriptWired(root, leg.script)) {
      noteFailOpen(`${leg.script} is not wired in this repo — ${leg.id} leg SKIPPED`);
      return null;
    }
    try {
      execSync(`npm run ${leg.script}`, /** @type {any} */ ({
        cwd: root,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
        windowsHide: true,
      }));
      return null;
    } catch (err) {
      const tail = `${/** @type {any} */ (err).stdout ?? ''}\n${/** @type {any} */ (err).stderr ?? ''}`.trim().split('\n').slice(-20).join('\n');
      return {
        blocked: true,
        message:
          `commit gate: ${leg.script} FAILED — commit blocked. This is a verify:checks gate — ` +
          `unfixed it fails release CI.\nFix: ${leg.fix}\n${tail}`,
      };
    }
  };
  for (const leg of derivedLegs.filter((l) => l.phase === 'main')) {
    const result = runDerivedLeg(leg);
    if (result) return result;
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
          `commit gate: commit blocked — .claude/settings.json references hook file(s) this commit would ` +
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
  const constitutionalStaged = attestationPaths.filter(isConstitutionalDocPath);
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
          `commit gate: commit blocked — it rewrites CONSTITUTIONAL doc(s), and ${why}.\n` +
          constitutionalStaged.map((p) => `  - ${p}`).join('\n') +
          `\nThese state what this project IS; the doc-review manifest routes every one of them as ` +
          `escalate-only ("never silently rewritten to match code"). Editing one to match current code ` +
          `destroys the thing the code is measured against — which is exactly what commit 6fc2e453 did to ` +
          `spec/remediate/remediation-goals.md inside a routine doc-review sweep.\n` +
          `If the owner has decided this change, record that decision and retry:\n  ${overrideHint}\n` +
          `Otherwise: unstage the constitutional doc(s), ship the rest, and escalate the change.` +
          extra,
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
  if (attestationPaths.some(isLoopCorePath)) {
    const loopCoreStaged = attestationPaths.filter(isLoopCorePath);
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
          `commit gate: loop-core commit blocked — no adversarial-review attestation for the staged tree.\n` +
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
          `commit gate: loop-core commit blocked — the review attestation at ` +
          `.claude/loop-core-review/${sha}.json is unreadable/corrupt. Re-run:\n  ${runHint}`,
      };
    }
    if (attest?.staged_tree !== sha) {
      return {
        blocked: true,
        message:
          `commit gate: loop-core commit blocked — the review attestation is STALE (binds tree ` +
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
          `commit gate: loop-core commit blocked — the review recorded verdict "${attest.verdict}"` +
          (attest.checked ? ` (checked: ${attest.checked})` : '') +
          `. Resolve the concerns and re-attest, or re-run with --override "<reason>" if intentional ` +
          `(a \`concerns\` attestation is accepted without an override on a non-main branch — WIP preservation):\n  ${runHint}`,
      };
    }
  }

  // 4. Phase-'final' derived legs — today exactly check:doc-links (relative
  // markdown links resolve on disk; recurred on three dates before the gate
  // existed, three of the last occurrence's dead links created by that run's
  // own doc moves).
  //
  // ⚠ THESE RUN LAST, DELIBERATELY. doc-links is the broadest trigger in the
  // gate (any staged markdown), so placing it earlier made it mask every
  // more-specific refusal behind it — the constitutional-doc escalation, the
  // generator-parity checks, and the loop-core attestation all reported
  // "doc-links FAILED" instead of their own actionable message. A broad
  // mechanical check must never preempt a structural one; the specific refusal
  // is the more useful signal. The ordering is REGISTRY DATA, not hook code:
  // preCommit 'final' in scripts/guard-reach-data.mjs puts a leg here.
  for (const leg of derivedLegs.filter((l) => l.phase === 'final')) {
    const result = runDerivedLeg(leg);
    if (result) return result;
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
      `commit gate: commit blocked — HEAD is the remediation run branch \`${headBranchName}\` and every ` +
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
  const wt = git(['write-tree']);
  if (!wt.ok) return null;
  const paths = listTreePaths(wt.stdout.trim());
  return paths === null ? null : new Set(paths);
}

if (!diverges) {
  // Working tree == staged index (nothing to materialize): the working tree IS
  // the snapshot that lands, so check it directly. Under a git hook the index
  // is final, so there is no "the command stages first" case to approximate.
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
    '[commit gate] another staged-snapshot round-trip is in flight — skipping the staged-snapshot ' +
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
    `[commit gate] could not capture the staged snapshot (git write-tree failed) — ` +
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
    `[commit gate] could not enumerate the staged snapshot (git ls-tree failed) — ` +
      `skipping the staged-snapshot check for this commit.`,
  );
  process.exit(0); // FAIL-OPEN on infra fault
}
const unionPaths = new Set([...stagedPaths, ...worktreePaths]);

// Journal the round-trip BEFORE the first worktree mutation: if this process is
// killed anywhere past this point, the next gate invocation restores both trees
// from these SHAs (they live in the object db and survive the crash).
// The journal also records the HEAD it was captured under: recovery refuses to
// apply it under any OTHER HEAD (see recoverInterruptedRoundTrip). A null head
// (unborn HEAD, git fault) journals anyway — recovery then refuses and
// quarantines, which is the announced-manual path, never a silent misapply.
const headRevForJournal = git(['rev-parse', 'HEAD']);
try {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(
    RT_JOURNAL,
    JSON.stringify(
      {
        worktreeTree,
        stagedTree,
        head: headRevForJournal.ok ? headRevForJournal.stdout.trim() : null,
        at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
} catch {
  // Can't journal → don't take an unrecoverable risk: skip the check (fail-open).
  try { rmSync(scratchIndex, { force: true }); } catch { /* ignore */ }
  releaseRoundTripLock();
  console.error(
    '[commit gate] could not write the round-trip recovery journal — skipping the staged-snapshot ' +
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
    `[commit gate] could not materialize the staged snapshot (git checkout-index failed) — ` +
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
      `[commit gate] WARNING: could not fully restore your working tree/index after the ` +
        `staged-snapshot check. Inspect \`git status\`; your staged changes and worktree edits ` +
        `should be intact but verify before committing.`,
    );
  }
}

process.exit(exitCode);
