#!/usr/bin/env node
// PreToolUse gate: block `git commit` until `npm run check` is green.
// Receives the hook payload on stdin: { tool_name, tool_input: { command } }.
// Exit 0 = allow, exit 2 = block (stderr is fed back to the agent).
// Fires on every Bash/PowerShell call; non-commit commands exit in ~ms, and a
// commit/push that targets a DIFFERENT repository is out of jurisdiction
// entirely (see "Target-repo scoping" below).
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
import { rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, statSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  stripQuoted,
  collapseQuoted,
  splitShellStatements,
  stripHeredocBodies,
  bypassEnabled,
} from './shell-split.mjs';
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
  let cur = payloadCwd || root;
  for (const s of subCmds) {
    stmtCwd.push(cur);
    if (cur === null) continue;
    const eff = cdEffect(s);
    if (eff) cur = eff.poison ? null : resolve(cur, eff.to);
  }
}

// Whether the statement at index i targets THIS repository. Fail-closed: a
// poisoned cwd, an unmodeled repo override, or a failed identity lookup on
// EITHER side all answer true (the gate runs — the pre-scoping behavior).
function statementTargetsThisRepo(i) {
  const base = stmtCwd[i];
  if (base === null) return true;
  const dir = gitTargetDir(subCmds[i], base);
  if (dir === null) return true;
  if (normalizeFsPath(dir) === normalizeFsPath(root)) return true; // the common case, no spawn
  const targetKey = repoKeyFor(dir);
  const ownKey = repoKeyFor(root);
  return targetKey === null || ownKey === null || targetKey === ownKey;
}

const commitSubCmds = subCmds.filter((s, i) => isCommitCreating(s) && statementTargetsThisRepo(i));
const pushSubCmds = subCmds.filter((s, i) => isPush(s) && statementTargetsThisRepo(i));

// Every detected commit/push lands in a DIFFERENT repository — this gate has
// no jurisdiction there. Exit before any leg runs.
if (commitSubCmds.length === 0 && pushSubCmds.length === 0) process.exit(0);

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

// Push-only command from a permitted session: done. `git push` must not start
// the commit machinery (staged reads, round-trip, runGate).
if (commitSubCmds.length === 0) process.exit(0);

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
      execSync(`npm run ${leg.script}`, {
        cwd: root,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
        windowsHide: true,
      });
      return null;
    } catch (err) {
      const tail = `${err.stdout ?? ''}\n${err.stderr ?? ''}`.trim().split('\n').slice(-20).join('\n');
      return {
        blocked: true,
        message:
          `pre-commit gate: ${leg.script} FAILED — commit blocked. This is a verify:checks gate — ` +
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
  if (staged.some(isLoopCorePath)) {
    const loopCoreStaged = staged.filter(isLoopCorePath);
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
