#!/usr/bin/env node
// PreToolUse hook: the THIN tool-boundary half of the commit gate (P53, owner
// decision 2026-09-05). Receives the hook payload on stdin:
// { tool_name, tool_input: { command }, cwd?, session_id? }. Exit 0 = allow,
// exit 2 = block (stderr is fed back to the agent). Fires on every
// Bash/PowerShell call; non-commit commands exit in ~ms.
//
// The commit legs themselves — `npm run check` on the staged snapshot, the
// derived verify:checks legs, the doc-contract subset, the constitutional-doc
// refusal, the loop-core attestation, the branch-strand and child-session
// refusals — run at GIT'S OWN BOUNDARY now: .githooks/pre-commit (and
// pre-merge-commit, pre-applypatch) → .claude/hooks/commit-gate.mjs. Git runs
// this repository's hook for this repository's commits and never for anyone
// else's, so jurisdiction there is by construction. This hook used to parse the
// shell text to GUESS the target repository and claimed this one whenever a hop
// was unresolvable — which refused a `git commit -m init` inside a fresh
// `mktemp -d` repo on 2026-09-04.
//
// What stays here is exactly what git cannot see or cannot refuse:
//   • a hook BYPASS on the command line (`--no-verify`/`-n`, or any
//     `core.hooksPath` override — git skips the hooks entirely, so nothing
//     downstream can judge the commit). Fail-CLOSED even when the target is
//     unresolvable: the false-positive surface is "a bypass token in a chain we
//     cannot follow", which is the one shape worth refusing on suspicion.
//   • the child-session refusal for a PUSH (there is no pre-push gate of ours;
//     the commit half is enforced again at git's boundary from the environment).
//   • MERGE routing: a fast-forward `git merge` writes no commit and runs no
//     hook, so a merge that introduces loop-core or constitutional content must
//     be a merge COMMIT (`--no-ff`) — then pre-merge-commit runs the full gate.
//   • healing a crashed staged-snapshot round-trip left by the git-boundary gate
//     (this hook runs on every shell call, so it is the prompt healer).
// An unresolvable target with none of those is OUT of jurisdiction: exit 0.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  stripQuoted,
  collapseQuoted,
  splitShellStatements,
  stripHeredocBodies,
  bypassEnabled,
} from './shell-split.mjs';
// The git/tree-snapshot substrate and the round-trip journal are the git-boundary
// gate's; this hook imports them only to HEAL a crashed round-trip promptly.
import { treeSnapshotTools } from './tree-snapshot.mjs';
// ── Session registry (Build 1 / P23) ─────────────────────────────────────────
// The child-session refusal below keys on the payload's session_id against the
// registry SessionStart writes; the same lib serves the three Stop gates.
import { readSessionRegistry, sanitizeSessionId } from '../../scripts/shared/sessionRegistry.mjs';

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

let raw = '';
for await (const chunk of process.stdin) raw += chunk;

let cmd = '';
let payloadSessionId = '';
let payloadCwd = '';
try {
  const payload = JSON.parse(raw);
  cmd = payload?.tool_input?.command ?? '';
  payloadSessionId = sanitizeSessionId(payload?.session_id);
  payloadCwd = typeof payload?.cwd === 'string' ? payload.cwd : '';
} catch {
  // Never wedge the session — but the gate did NOT run, and a silent exit 0 is
  // indistinguishable from a pass.
  noteFailOpen('the hook payload was unparseable — no check ran for this command');
  process.exit(0);
}

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const { git, recoverInterruptedRoundTrip } = treeSnapshotTools(root, { label: 'pre-commit gate' });
// Heal the tree/index a CRASHED git-boundary round-trip left behind — first,
// on every invocation (a live lock means an instance is legitimately mid-flight).
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
// Every subcommand that can CREATE a commit, not just the one named "commit".
// A merge, a rebase continuation, a cherry-pick, a revert or an `am` all write
// history, and every one of them used to skip all legs of this gate (observed
// live: stray-doc failures on all three v0.34.7 merge commits, main red until
// 0c6a5a6d). Known accepted limit — pre-hoc, the gate can only validate the
// CURRENT staged snapshot: for `--continue` forms the index already holds the
// resolved result (fully gated), but the content a `git merge <branch>` or a
// fresh cherry-pick will INTRODUCE does not exist yet, so an incoming bad tree
// still lands and surfaces at the next local gate run / CI. What this widening
// guarantees: no commit-creating command runs from an already-red snapshot,
// and the hook-bypass vectors are refused on every history-writing form.
const COMMIT_CREATING_SUBCOMMANDS = ['commit', 'merge', 'rebase', 'cherry-pick', 'revert', 'am'];
const isCommitCreating = (s) => COMMIT_CREATING_SUBCOMMANDS.some((name) => isGitSubcommand(name)(s));

// Build 1 (P23): `git push` is detected ONLY for the child-session refusal
// below. It must never enter the commit machinery — no hook-bypass scan, no
// staged-set reads, no runGate, no staged-snapshot round-trip.
const isPush = isGitSubcommand('push');

// Exit early if no commit-creating or push invocation exists in any statement.
if (!subCmds.some((s) => isCommitCreating(s) || isPush(s))) process.exit(0);

// ── Target-repo scoping ──────────────────────────────────────────────────────
// Every check below reads THIS repository's state (root = CLAUDE_PROJECT_DIR):
// the staged set, the attestations, the branch, the staged-snapshot round-trip.
// But the hook fires on every Bash/PowerShell call in the session, so a commit
// made in a DIFFERENT repo — `cd C:/other && git commit …`, `git -C ../other
// commit …`, or a plain `git commit` after the session cd'd away — used to be
// gated against audit-tools' own index anyway. Observed live 2026-08-19: an
// unrelated fresh repo's first commit was blocked because a concurrent session
// had loop-core files staged HERE. That is the false-RED class — as corrosive
// as a false green, because it trains the reader to distrust or bypass the
// gate. [[false-red-is-as-corrosive-as-false-green]]
//
// So each detected commit/push statement is resolved to the repository it
// actually targets: the payload cwd, folded through the `cd`/`chdir`/`pushd`/
// `sl`/`Set-Location`/`Push-Location` statements EARLIER in the chain, then
// through the statement's own `git -C <path>` hops. Repo identity is the
// absolute `--git-common-dir`, NOT `--show-toplevel`: a linked worktree has
// its own toplevel but shares the common dir, and a commit into a sibling
// worktree of THIS repo must stay gated. Statements that target another
// repository fall out of the gate's view entirely — including the hook-bypass
// scan and the child-session refusal, which exist to protect this repo's
// history, not to govern git use elsewhere.
//
// FAIL-CLOSED on resolution faults, by design: an unresolvable hop (`cd "$V"`,
// `cd -`, popd, a bare `cd`, a `--git-dir`/`--work-tree` override, a target
// git cannot answer for) counts as targeting THIS repo. The worst residue is
// the old false RED in an exotic shape — never an ungated audit-tools commit.

// Canonical comparable form of a filesystem path: realpath when it exists
// (settles symlinked tempdirs, Windows 8.3/case aliases), forward slashes,
// case-folded on win32.
function normalizeFsPath(p) {
  let n = resolve(p);
  try {
    n = realpathSync.native(n);
  } catch {
    /* nonexistent — keep the resolved form */
  }
  n = n.replace(/\\/g, '/');
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

// Quote-aware tokenization of one statement: whitespace splits only outside
// quoted spans; tokens keep their quote characters (unquoteToken strips them).
// Same escape model as stripQuoted.
function tokenizeStatement(s) {
  const tokens = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote === '"' && c === '\\' && i + 1 < s.length) {
      cur += c + s[i + 1];
      i++;
    } else if (quote) {
      cur += c;
      if (c === quote) quote = null;
    } else if (c === '\\' && i + 1 < s.length) {
      cur += c + s[i + 1];
      i++;
    } else if (c === "'" || c === '"') {
      quote = c;
      cur += c;
    } else if (/\s/.test(c)) {
      if (cur) {
        tokens.push(cur);
        cur = '';
      }
    } else {
      cur += c;
    }
  }
  if (cur) tokens.push(cur);
  return tokens;
}

function unquoteToken(tok) {
  const m = /^(["'])([\s\S]*)\1$/.exec(tok);
  return m ? m[2] : tok;
}

// A path we can resolve WITHOUT evaluating shell: no substitutions ($var,
// backtick), no globs. `~` expands to the home directory. Null = unresolvable.
function resolvablePathToken(tok) {
  const t = unquoteToken(tok);
  if (!t || t === '-' || /[$`*?]/.test(t)) return null;
  if (t === '~') return homedir();
  if (t.startsWith('~/') || t.startsWith('~\\')) return join(homedir(), t.slice(2));
  return t;
}

// The effect of one statement on the effective cwd: { to } for a resolvable
// directory change, { poison: true } when it changes cwd in a way this hook
// cannot evaluate, null when it does not change cwd at all.
const CD_WORDS = new Set(['cd', 'chdir', 'pushd', 'sl', 'set-location', 'push-location']);
function cdEffect(statement) {
  const tokens = tokenizeStatement(statement.replace(/^[\s(]+/, ''));
  if (tokens.length === 0) return null;
  const head = unquoteToken(tokens[0]).toLowerCase();
  if (head === 'popd' || head === 'pop-location') return { poison: true };
  if (!CD_WORDS.has(head)) return null;
  let i = 1;
  while (i < tokens.length && tokens[i].startsWith('-')) {
    if (tokens[i] === '-') return { poison: true }; // `cd -` — previous dir, unknown here
    // PowerShell -Path/-LiteralPath name the target in the NEXT token; every
    // other option (-P, -L, -PassThru, …) is skipped.
    if (/^-(?:path|literalpath)$/i.test(tokens[i])) {
      i++;
      break;
    }
    i++;
  }
  if (i >= tokens.length) return { poison: true }; // bare `cd` — target is shell-dependent
  const target = resolvablePathToken(tokens[i]);
  // Trailing tokens mean this is not a plain directory change (`cd x & git …`
  // backgrounds the cd; redirects/extra args are anyone's guess) — refuse to
  // model it rather than mis-track the cwd.
  if (target === null || i + 1 < tokens.length) return { poison: true };
  return { to: target };
}

// Fold a statement's `git -C <path>` hops onto `dir`. Null = the statement
// overrides the repo in a way this hook does not model (--git-dir/--work-tree)
// or hops through an unresolvable path — callers fail closed.
function gitTargetDir(statement, dir) {
  const tokens = tokenizeStatement(statement.replace(/^[\s(]+/, ''));
  const gitIdx = tokens.findIndex((t) => unquoteToken(t) === 'git');
  if (gitIdx === -1) return dir; // defensive — detection already saw `git` here
  let out = dir;
  for (let i = gitIdx + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^--(?:git-dir|work-tree)(?:$|=)/.test(t)) return null;
    if (t === '-C') {
      const hop = i + 1 < tokens.length ? resolvablePathToken(tokens[i + 1]) : null;
      if (hop === null) return null;
      out = resolve(out, hop);
      i++;
    } else if (t === '-c') {
      i++; // -c name=val — skip its value
    } else if (!t.startsWith('-')) {
      break; // the subcommand — git's global options end here
    }
  }
  return out;
}

// The repository identity of `dir`: its absolute git common dir — shared by
// the main checkout and every linked worktree — normalized for comparison.
// Null when git cannot answer (missing dir, not a repo, spawn fault).
const repoKeyCache = new Map();
function repoKeyFor(dir) {
  const key = normalizeFsPath(dir);
  if (repoKeyCache.has(key)) return repoKeyCache.get(key);
  let out = null;
  try {
    const r = spawnSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    // Relative output (e.g. `.git`) is relative to the spawn cwd.
    if (r.status === 0 && !r.error) out = normalizeFsPath(resolve(dir, r.stdout.trim()));
  } catch {
    /* unresolvable — fall through to null */
  }
  repoKeyCache.set(key, out);
  return out;
}

// Effective cwd when each statement runs: the payload cwd folded through the
// directory changes before it. Null = poisoned (unknown from that point on).
const stmtCwd = [];
{
    /** @type {string|null} */
    let cur = payloadCwd || root;
  for (const s of subCmds) {
    stmtCwd.push(cur);
    if (cur === null) continue;
    const eff = cdEffect(s);
    if (eff) cur = eff.poison ? null : resolve(cur, eff.to);
  }
}


// Where the statement at index i lands: THIS repository, another one, or
// unresolvable (a poisoned cwd, an unmodeled `--git-dir`/`--work-tree`
// override, a failed identity lookup on either side). P53: the commit legs run
// at git's own boundary, so an unresolvable target is no longer CLAIMED as this
// repository — only the bypass refusal, which git cannot make, still fails
// closed on it. Memoized per statement; only commit/push statements are asked.
const jurisdictionMemo = new Map();
function statementJurisdiction(i) {
  if (jurisdictionMemo.has(i)) return jurisdictionMemo.get(i);
  let verdict = 'unresolvable';
  const base = stmtCwd[i];
  if (base !== null) {
    const dir = gitTargetDir(subCmds[i], base);
    if (dir !== null) {
      if (normalizeFsPath(dir) === normalizeFsPath(root)) verdict = 'this'; // the common case, no spawn
      else {
        const targetKey = repoKeyFor(dir);
        const ownKey = repoKeyFor(root);
        if (targetKey !== null && ownKey !== null) verdict = targetKey === ownKey ? 'this' : 'other';
      }
    }
  }
  jurisdictionMemo.set(i, verdict);
  return verdict;
}
const owned = (i) => statementJurisdiction(i) === 'this';
const possiblyOwned = (i) => statementJurisdiction(i) !== 'other';

// Commit-creating statements that MAY be ours (resolved here, or unresolvable)
// feed the bypass refusal; the two refusals below that need real jurisdiction
// read the RESOLVED sets.
const commitSubCmds = subCmds.filter((s, i) => isCommitCreating(s) && possiblyOwned(i));
const ownedCommitSubCmds = subCmds.filter((s, i) => isCommitCreating(s) && owned(i));
const ownedPushSubCmds = subCmds.filter((s, i) => isPush(s) && owned(i));

// Every detected commit/push lands in a DIFFERENT repository — this hook has
// no jurisdiction there. Exit before any leg runs.
if (commitSubCmds.length === 0 && ownedPushSubCmds.length === 0) process.exit(0);

// Gate-bypass vectors — a commit that disables hooks makes this gate a no-op,
// so refuse it outright (the gate can't run `check` if git skips the hook, and
// silently allowing the bypass defeats green-at-every-commit).
// `--no-verify` and `core.hooksPath` are matched against the WHOLE command: a
// SIBLING statement can arm the bypass before the commit runs
// (`git config core.hooksPath /dev/null && git commit -m …`), so scoping these
// to commit sub-commands is a hole. Only the short `-n` form stays scoped, and
// specifically to `git commit` — that scoping exists for flags that are common in
// unrelated tools (`grep -n`), which is not true of the other two vectors.
// `commit` ALONE, not every commit-creating subcommand: `-n` is `--no-verify`
// only there. On cherry-pick and revert it is `--no-commit` — the SAFER form,
// which leaves the result staged for this gate to read — and on merge it is
// `--no-stat`. Refusing those was a false RED that pushed the caller toward the
// un-inspectable form, i.e. the opposite of what this gate wants.
// The `-n` check runs on stripQuoted statements: `-n` inside a quoted commit
// MESSAGE (`git commit -m "use grep -n output"`) is text, not a flag, and must
// not false-trip the bypass detection. The long-form vectors stay RAW-matched
// against the whole command on purpose (fail-closed): a QUOTED flag is still a
// real flag to the shell (`git -c "core.hooksPath=x" commit`), so blanking
// quoted spans there would open an evasion, and a commit message that merely
// MENTIONS `--no-verify` is rare enough to accept the false block.
// Guarded to commit-bearing commands: push detection (above) must not NEWLY
// route a push-only `git push --no-verify` — which exited 0 before pushes were
// detected at all — into this refusal. Every command that previously reached
// it had commitSubCmds non-empty, so the guard is a strict no-behavior-change.
if (
  commitSubCmds.length > 0 &&
  (/--no-verify\b|\bcore\.hooksPath\b/.test(cmd) ||
    commitSubCmds
      .filter((sub) => isGitSubcommand('commit')(sub))
      .some((sub) => /(?:^|\s)-n(?=\s|$)/.test(stripQuoted(sub))))
) {
  console.error(
    'pre-commit gate: commit rejected — hook-bypass detected (`--no-verify`/`-n` or a `core.hooksPath` override anywhere in the command). ' +
      'These skip the green-at-every-commit gate. Remove the bypass and commit normally; if `npm run check` fails, fix it first.',
  );
  process.exit(2);
}

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
  if (registry.armed) {
    noteFailOpen('child-session refusal skipped: the hook payload carried no session_id');
  }
} else if (
  (ownedCommitSubCmds.length > 0 || ownedPushSubCmds.length > 0) &&
  registry.isUnregisteredChild &&
  !bypassEnabled('AUDIT_TOOLS_AGENT_GIT', stripHeredocBodies(cmd))
) {
  console.error(
    'pre-commit gate: commit/push refused — this session has no record in the session registry ' +
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
  console.error(`[pre-commit gate] FAIL-OPEN (allowing the commit): ${reason}`);
}

// ── Incoming content for history-moving verbs (owner decision, 2026-08-29) ───
// This gate reads the INDEX, and a fresh `git cherry-pick <sha>` / `git merge
// <branch>` stages NOTHING — so the loop-core and constitutional attestation
// checks read an empty set and demanded nothing while the command landed the
// incoming tree. On a branch that is survivable (the gates re-run when the work
// reaches `main` by ordinary commit); onto `main` it lands loop-core or
// constitutional content with zero mechanical review. The gate used to record
// this as an accepted limit; the owner reversed that acceptance, because the
// incoming path set IS derivable before the command runs, from the ref it names.
//
// Covered: cherry-pick and revert (`git show --name-only`), merge (`git diff
// --name-only HEAD...<ref>`). NOT covered, and stated in the backlog entry:
// `git am <mailbox>` names no ref at all, and the `--continue`/`--abort`/`--skip`
// forms carry no incoming ref either — for `--continue` the index already holds
// the resolved result, which the staged set already covers.
const INCOMING_REF_VERBS = { 'cherry-pick': 'show', revert: 'show', merge: 'diff' };
const REF_LESS_FLAGS = new Set(['--continue', '--abort', '--skip', '--quit', '--edit-todo']);

/**
 * The ref a history-moving statement names, or null when it names none that can
 * be trusted. Null is always "cannot tell", never "introduces nothing".
 * @param {string} statement quote-COLLAPSED statement text
 * @param {string} verb the git subcommand that was matched
 * @returns {string | null}
 */
function incomingRefOf(statement, verb) {
  const tokens = statement.trim().split(/\s+/);
  const at = tokens.indexOf(verb);
  if (at < 0) return null;
  for (const tok of tokens.slice(at + 1)) {
    if (REF_LESS_FLAGS.has(tok)) return null;
    if (tok.startsWith('-')) continue;
    // A collapsed quote or a shell metacharacter is not a ref we can resolve.
    if (tok === '""' || tok === "''" || /[;&|<>$`()]/.test(tok)) return null;
    return tok;
  }
  return null;
}

/**
 * Paths the pending history-moving commands will INTRODUCE.
 * @param {string[]} statements commit-creating statements targeting this repo
 * @returns {{ paths: string[], unresolved: string[] }} unresolved names the
 *   refs git could not read, so the caller can fail OPEN and say so.
 */
function incomingPaths(statements) {
  const paths = new Set();
  const unresolved = [];
  for (const s of statements) {
    for (const [verb, mode] of Object.entries(INCOMING_REF_VERBS)) {
      if (!isGitSubcommand(verb)(s)) continue;
      const ref = incomingRefOf(collapseQuoted(s), verb);
      if (!ref) continue;
      const r =
        mode === 'show'
          ? git(['show', '--name-only', '--pretty=format:', ref])
          : git(['diff', '--name-only', `HEAD...${ref}`]);
      if (!r.ok) {
        unresolved.push(`${verb} ${ref}`);
        continue;
      }
      for (const line of r.stdout.split(/\r?\n/)) {
        const p = line.trim();
        if (p) paths.add(p.replace(/\\/g, '/'));
      }
    }
  }
  // Stable, content-derived order — never git's emission order.
  return { paths: [...paths].sort(), unresolved };
}

// ── Routing for the incoming-content verbs git cannot gate ───────────────────
// Measured 2026-09-05 (git 2.55): the sequencer runs NO pre-commit for a
// cherry-pick, a revert, or a rebase replay, and a fast-forward `git merge`
// writes no commit at all — so the git-boundary gate never sees the loop-core
// or constitutional content those verbs introduce (owner decision 2026-08-29:
// incoming content is gated, not an accepted limit). Rather than re-judge it
// here with a second copy of the attestation legs, ROUTE it to the one place
// that has them: a verb whose incoming paths include such content must land
// through a hooked commit —
//   • merge:               `--no-ff`, so git writes the merge commit through
//                          pre-merge-commit;
//   • cherry-pick / revert: `-n` / `--no-commit`, so the result is left STAGED
//                          and `git commit` runs pre-commit on it.
// If the hooked commit then refuses for a missing attestation, the index it
// judged is exactly what stays staged: attest against it and commit again.
// A verb introducing no gated content passes through; `am` reaches
// pre-applypatch on its own and needs no routing.
const ROUTED_VERBS = {
  merge: { flag: /(?:^|\s)--no-ff(?=\s|$)/, hint: '`--no-ff` (a merge commit runs pre-merge-commit)' },
  'cherry-pick': { flag: /(?:^|\s)(?:-n|--no-commit)(?=\s|$)/, hint: '`-n` / `--no-commit`, then `git commit` (which runs pre-commit)' },
  revert: { flag: /(?:^|\s)(?:-n|--no-commit)(?=\s|$)/, hint: '`-n` / `--no-commit`, then `git commit` (which runs pre-commit)' },
};
for (const [verb, route] of Object.entries(ROUTED_VERBS)) {
  const statements = ownedCommitSubCmds.filter((s) => isGitSubcommand(verb)(s));
  if (statements.length === 0) continue;
  const incoming = incomingPaths(statements);
  if (incoming.unresolved.length > 0) {
    noteFailOpen(
      `cannot resolve the incoming ref(s) ${incoming.unresolved.join(', ')} (\`git show\`/\`git diff\` failed) — ` +
        `the ${verb} routing check was SKIPPED for this command.`,
    );
  }
  const gated = incoming.paths.filter((p) => isLoopCorePath(p) || isConstitutionalDocPath(p));
  const unrouted = statements.some((s) => !route.flag.test(collapseQuoted(s)));
  if (gated.length > 0 && unrouted) {
    console.error(
      `pre-commit gate: ${verb} refused — it introduces loop-core or constitutional content, and this form ` +
        `writes history without running the commit gate, so nothing would judge it:\n` +
        gated.map((p) => `  - ${p}`).join('\n') +
        `\nRe-run with ${route.hint}. If that commit refuses for a missing attestation, write the ` +
        `attestation against the index it leaves staged, then commit again.`,
    );
    process.exit(2);
  }
}
process.exit(0);
