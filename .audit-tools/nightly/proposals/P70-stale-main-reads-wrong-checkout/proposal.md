# P70 — stale-main check must read the session's own worktree, not CLAUDE_PROJECT_DIR

**Leg:** 3 (recurring-problem solutions). **Status:** proposal only — nothing in this
directory is applied by the routine; the patch is ready for the owner to review and land.

## Recurrence evidence

This is one instance of a defect CLASS — "a session-start/commit-time hook resolves git
state from `CLAUDE_PROJECT_DIR` (the main checkout) when it should read the actual directory
the session or command is working in" — documented at least twice, on different dates, in
`docs/backlog/open-bugs.md`:

1. **2026-10-06** — "The session-start 'commits BEHIND origin/main' warning measures the
   main checkout, not the session's worktree." `.claude/hooks/session-start-guards.mjs` ran
   `git rev-list --count HEAD..<remote>/main` against `ROOT` (`CLAUDE_PROJECT_DIR`)
   unconditionally. A session in a linked lap worktree that was level with `origin/main`
   still read "N commit(s) BEHIND — sync before writing code" twice in one lap, because the
   *main checkout's* local HEAD (not the worktree's) was the one actually behind.
2. **2026-10-09** — "The merge-routing check measures incoming paths from
   `CLAUDE_PROJECT_DIR`, not the checkout the command runs in." `.claude/hooks/pre-commit-gate.mjs`'s
   `incomingPaths` runs `git diff HEAD...<ref>` in `root` (also `CLAUDE_PROJECT_DIR`), so a
   `cd <worktree>; git merge --ff-only origin/main` was refused for 18 loop-core/constitutional
   paths that were actually the diff from the MAIN checkout's stale `main`, not the worktree's.

Both bugs are the same mechanism, hit on different dates, in different hooks, with the same
fix shape available in both cases (the session's actual working directory is already known —
`payload.cwd` for a SessionStart hook, the command's own target directory for a PreToolUse
hook — the bug is simply that one code path used the wrong source of truth). That clears the
nightly routine's recurrence bar (2+ independent occurrences, different dates, same trap).

## Mechanism proposed here (scoped to bug #1 — the smaller, self-contained half)

`.claude/hooks/session-start-guards.mjs` already has the fix pattern in the SAME FILE: the
"stale agent worktrees" leg (a few dozen lines below the stale-main leg) already trusts
`payload.cwd` over `CLAUDE_PROJECT_DIR` for exactly this reason (its own comment: "The
worktree the session itself works in... is never listed"). The stale-main leg just never
adopted it.

The patch (`patch.diff`) adds one small helper and swaps three call sites:

```js
function resolveSessionGitDir() {
  const cwd = typeof payload?.cwd === 'string' && payload.cwd ? payload.cwd : null;
  if (!cwd || !existsSync(cwd)) return ROOT;
  const probe = gitIn(cwd, ['rev-parse', '--is-inside-work-tree'], 5_000);
  return probe.ok && probe.stdout === 'true' ? cwd : ROOT;
}
const SESSION_GIT_DIR = resolveSessionGitDir();
```

The stale-main leg's `git(['remote'])`, `git(['fetch', remote, 'main'])` and
`git(['rev-list', '--count', ...])` now run against `SESSION_GIT_DIR` instead of the
unconditional `ROOT`. Fails open to `ROOT` whenever `payload.cwd` is absent, points at a
directory that no longer exists, or is not inside a git work tree at all — so a payload with
no `cwd` (older harness, a probe with no stdin) behaves exactly as before.

## What it would have caught historically

The exact 2026-10-06 incident: a lap worktree level with `origin/main`, with the main
checkout's own local `main` behind it, no longer produces the false "BEHIND" warning —
verified by the new regression test (see below), which reproduces that precise shape (bare
origin → main checkout clone → linked worktree fast-forwarded to origin's new tip → main
checkout left untouched).

## False-positive surface

- A session with no `cwd` in its SessionStart payload (older harness versions, or any probe
  invoked with no stdin) falls back to the prior `ROOT`-based behavior exactly — no change.
- A `cwd` that is not inside any git work tree (e.g. a session rooted above the repo) also
  falls back to `ROOT` — no change, and no new way to silence a genuine stale-main warning for
  the main checkout itself (the self-skip never fires there; `resolveSessionGitDir` resolves to
  `ROOT` when `cwd` is the main checkout too, since that IS inside the work tree and is `ROOT`
  itself — no divergent behavior for the common non-worktree case).
- A worktree whose own HEAD actually IS behind `origin/main` still gets the warning — correctly,
  since the check now answers the question "is THIS tree behind" rather than "is the main
  checkout behind."
- The `remoteName` discovered here is reused a few dozen lines later by the "stale agent
  worktrees" leg purely as a string (`${remoteName}/main`), never as a directory — unaffected
  by which directory `remoteName` was discovered from.

## Not addressed here

Bug #2 (`pre-commit-gate.mjs`'s `incomingPaths`/`gitTargetDir`) is the same mechanism but a
materially different fix: it is a PreToolUse hook parsing an arbitrary shell command string,
and `gitTargetDir` already partially tracks `-C`/`--git-dir` flags but not a leading `cd`
statement in a compound command — fixing it correctly means extending that parser, not adding
a `payload.cwd` read (PreToolUse hooks do not get a worktree-identifying `cwd` the same way
SessionStart does; the command string itself is the only signal). That is a separate, larger
change and is left as a follow-up rather than folded into this patch, to keep this proposal to
one reviewable unit.

## Files in this proposal

- `patch.diff` — the fix to `.claude/hooks/session-start-guards.mjs` plus the new regression
  test `tests/shared/hook-session-start-guards-stale-main-worktree.test.ts`.
- `RED-AT.txt` — the test run against the unfixed hook at HEAD `49a5d1cd`, verbatim failure,
  and confirmation it passes once the fix is restored.
