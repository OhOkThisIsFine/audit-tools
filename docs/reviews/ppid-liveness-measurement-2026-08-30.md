# Session-liveness measurement — `process.ppid` and the `suiteLock` storage (2026-08-30)

Owner decision, 2026-08-30: **measure before designing.** Three sketches for a session-liveness
signal died because a shape was chosen before anything was measured, so this lap establishes facts
and stops. The lap was approved with the fallback included, so both candidates were measured:
the `process.ppid` ancestry walk, and the `tests/helpers/suiteLock.ts` storage.

No design is proposed here and no code changed. What follows is what was observed.

## Why a liveness signal is wanted

`tests/helpers/global-setup.ts` teardown diffs the repo-root entry list between `setup` and
`teardown` and reports every entry the run added. A **concurrent agent session writing into the same
checkout** inside that window is attributed to the run, which reds a commit whose own tests all
passed. The teardown needs a predicate it does not have: *is another session live in this checkout?*

## Environment

Windows 11 Pro 10.0.26200, Claude Code 2.1.247 desktop app, Node 22, vitest 3.2.6, checkout
`C:/Code/audit-tools`. Every number below was measured during this lap.

## How a session appears in the process table

The desktop app runs **one root `claude.exe`** (pid 1388, parent `explorer.exe`). Every other
`claude.exe` is a child of that root. The children split cleanly in two:

| Class | Count at lap open | Distinguishing mark |
|---|---|---|
| Electron helpers | 12 | every one carries `--type=` (`renderer`, `utility`, `gpu-process`, `crashpad-handler`) |
| Agent sessions | 6 | **no** `--type=` in the command line; command line ~1058 chars |

So a session is mechanically identifiable: *`claude.exe`, whose parent is also `claude.exe`, with no
`--type=` in its command line.* The classifier needed no heuristics and no tie-breaks.

## Result 1 — the pid IS readable without a hook, but not through `npm`

The walk reaches the session from a **directly spawned** process, and does not reach it through
`npm`. Both results are deterministic, not racy.

| Spawn path | Runs | Terminus | Chain |
|---|---|---|---|
| `node <probe>` | 5/5 | `SESSION` pid 31564 | `node>bash>bash>bash>claude` |
| `npm exec -- node <probe>` | 5/5 | `DEAD_ANCESTOR` | `node>cmd>node>bash>bash><gone:PID>` |
| vitest `globalSetup` + `teardown`, direct binary | 2/2 | `SESSION` pid 31564 | `node>bash>bash>bash>claude` |
| vitest `globalSetup` + `teardown`, via `npm exec` | 2/2 | `DEAD_ANCESTOR` | `node>cmd>node>bash>bash><gone:32124>` |

The last row is the one that matters. It was measured **in the exact position the consumer occupies**
— a real vitest `globalSetup` and `teardown` — and under the npm-mediated shape that `npm test` has.
The npm `.cmd` shim adds a `cmd.exe` hop and leaves an intermediate shell that has already exited by
the time the walk runs. Both setup and teardown reported the same dead pid, so the break is stable
within a run and not a transient.

**A dead ancestor is worse than a break.** Windows reuses pids, so a walk that continues past a dead
parent can enter a false ancestry and return a wrong session. 13 live processes currently hold a
parent pid that no longer exists, so the population of reuse candidates is not hypothetical.

## Result 2 — the reuse hazard IS detectable

`Win32_Process.CreationDate` was present for **all 344** live processes (0 missing), and the live
chain satisfied *parent created no later than child* at **every hop (0 violations)**. A walk can
therefore reject a reused pid.

This bounds the damage; it does not repair it. Creation time lets a walk report a break **honestly**
instead of returning a wrong answer. It cannot make a broken chain reach the session.

## Result 3 — the pid DOES survive the session

- Session pid **31564 was identical on every probe across the lap** (~40 minutes, 15+ separate
  spawns), while the intermediate `bash.exe` pids changed on every single invocation. The session pid
  is stable; the shell pids are not.
- The live session set went **6 → 4** during the lap: pids 8948 and 47632 exited and left the table.
  A closed session leaves no live process behind, so `processAlive` on a session pid is meaningful in
  both directions.

## Result 4 — from a HOOK's position the walk succeeds, and the hook also knows the checkout

Measured with a temporary `PreToolUse` hook installed in the **gitignored**
`.claude/settings.local.json` (tracked tree untouched throughout; restored byte-for-byte afterwards,
10336 → 10336, `hooks` key absent).

3 samples, 3 × `terminus=SESSION`, all `session_pid=31564`:

```
node(6732)>bash(39176)>bash(32656)>claude(31564)
```

Each sample also carried `cwd=C:\Code\audit-tools` and `CLAUDE_PROJECT_DIR=C:/Code/audit-tools`.

This is the pair design (3) was missing. That design died on *"only hooks write `pid`, and a hook is
dead before anything reads its pid"* — which is true of the **hook's own** pid. It is not true of the
session pid: a hook can read the session's pid by walking up, and that pid outlives the hook by the
whole session. The hook is not npm-mediated, so the break in Result 1 does not apply to it.

## Result 5 — the process table alone cannot attribute a session to a CHECKOUT

This is a new constraint, not previously recorded.

A session's command line carries the app path and the `--plugin-dir` paths only. It contains two
UUIDs, and those UUIDs are **identical across all sessions** — they are the skills-plugin install
path, not a session or workspace identity. Windows does not expose another process's working
directory without reading its PEB, which is not something a test helper should do.

So process ancestry answers *"is another session live on this machine"*, never *"is another session
live in this checkout"*. Used alone it would make the teardown abstain whenever any session is open
anywhere, including sessions in unrelated repositories.

## Result 6 — the `suiteLock` storage works for a cross-session, per-checkout signal

All four facts the fallback depends on were measured, and all four are positive.

| Fact | Measured |
|---|---|
| `os.tmpdir()` is shared across sessions, not per-session | `C:\Users\ethan\AppData\Local\Temp`; `TMP` and `TEMP` agree. One session can see another's entry. |
| keyed per checkout | `suiteLockDir` hashes the repo root; a different checkout path yields a different directory. |
| outside the tree | `tmpdir_is_inside_repo=false`, so `git worktree add` can neither copy it nor leave it empty — immune to the hazard that killed design (2). |
| `processAlive` works on foreign pids | `true` for all five live session pids probed (none spawned by the prober), `false` for 999999. |

The directory existed and held zero holder entries, consistent with no suite running.

## What is proven, and what is still open

**Proven.** A durable, checkout-attributable session pid is obtainable: a hook can read it (Result 4)
and the `suiteLock`-shaped storage can hold it where another session can find it (Result 6). Neither
half required a design decision to establish.

**Not proven, and load-bearing.** The two halves are *coupled*, and this lap measured them separately:

- The consumer cannot read the pid itself. The teardown runs under `npm test`, where the walk fails
  deterministically (Result 1), so the teardown must **read a stored pid** rather than walk. That is
  what makes Result 6 necessary rather than merely available.
- Nothing was measured about **write and sweep timing**: when a hook writes the entry, what removes
  it when a session ends without a clean exit, or whether `processAlive` alone is a sufficient sweep.
- The three constraints already recorded on the backlog entry are untouched by this lap and still
  bind any design: the throw is part of the declared green mechanism; "notice instead of throw" is
  silence; and nothing binds `teardown()`'s composition, so a fix can ship unwired with every pinned
  case green.

**OS-agnostic cost, stated because the repo requires it.** `process.ppid` is Node core and portable.
The **ancestry walk is not**: it needs a per-OS process table (`Win32_Process` here, `/proc` or `ps`
elsewhere), and the `--type=` session classifier is specific to this app's Electron layout. Any design
built on Result 4 imports a platform-specific component into a repo whose stated invariant is
*OS/platform-agnostic by default*, so it must route through an abstraction or degrade to abstention
off-win32.

## Bearing on the lane-detection entry

The open lane-detection entry in [`open-bugs.md`](../backlog/open-bugs.md) records process ancestry as
*"the one candidate never tried and never retired, and it is OS-specific"*. It has now been tried.
Results 1, 4 and 5 apply to it directly: the walk works from a hook and fails through `npm`, and it
cannot attribute a process to a checkout. That entry's owner-decided **abstention still stands** — this
is a measurement recorded against it, not a reopening of it.
