# P60 — Machine-wide tooling names shared files by a non-unique identity, so a second writer clobbers the first

**Scope: MACHINE-WIDE.** The affected writers are `capture.mjs` / `capture-run.mjs`
run logs, the global hooks' `.state/` records, `.claude/compaction-checkpoint.md`,
and the per-project memory store — all under `~/.agent-config` and `~/.claude`.
The work item belongs in `C:\Code\docs\backlog.md`, not in this repo's backlog.

**No patch attached.** The write half is a rename and is settled; the READ half is
not, and it is where the cost sits. See *The open choice*.

## The recurrence

Five records across four distinct dates. All quotes verified at their cited
source.

- **2026-09-08**, `C:\Code\docs\backlog.md` Open items — "Concurrent capture logs
  can share a filename. Two `capture.mjs` invocations in audit-tools started at
  04:47:51.055Z and both reported the same run-log name; one completion retained a
  `running.log` pointer after the other renamed the shared file."
- **2026-09-07**, same file — "Concurrent capture runs can share a log filename.
  Two `capture.mjs` … their headers/output interleaved and one returned a stale
  `-running.log` path." **The same trap, filed twice on consecutive days.** A trap
  that gets written down a second time because nobody found the first entry is
  itself the recurrence signal.
- **2026-09-07**, same file — "A delegated task can overwrite its owner's
  compaction checkpoint … replaced `.claude/compaction-checkpoint.md` with its own
  narrower status, erasing the other active workstreams."
- **2026-09-08**, same file — "Hook contract tests and the calibrate script write
  into the LIVE `hooks/.state/` … `question-philosophy-gate.test.mjs` wiped the
  live `philosophy-injected/` directory at start and end, re-arming the gate in
  every open session."
- **2026-08-09**, `docs/backlog/durable-traps.md` — "The per-project memory store
  has NO locking, and a concurrent session silently reverts your edits."

## The mechanism

Not a lock and not a guard — remove the collision by construction.

Every machine-wide file a tool writes on its own behalf gets its path minted from
the writer's own identity, which the child process **already holds**. That fact is
recorded in `C:\Code\docs\backlog.md`'s own standing traps: a tool child knows its
session, because `CLAUDE_PID` and `CLAUDE_CODE_SESSION_ID` are in its environment.

One shared helper in `~/.agent-config/` mints `<base>-<sessionId>-<pid>` and
creates it with an `wx` open — fail-if-exists — rather than a timestamp string, so
two writers cannot select the same name even inside one millisecond. A second
helper reads the set. The same helper carries the state-root override the hooks
entry already asks for, so a test run points at a temp directory by passing an env
var rather than by remembering to clean up.

Ownership becomes a property of the filename instead of a convention. A timestamp
is not an identity: two processes that start in the same millisecond get the same
string, which is precisely what the 2026-09-08 record measured.

## What it would have caught

- The two `capture.mjs` runs at `2026-09-08T04-47-51-055Z` that both claimed one
  log and left a stale `-running.log` pointer. With `wx` creation the second run
  takes the next name instead of interleaving into the first's file — so the
  truncated-diagnostics failure that `capture.mjs` exists to prevent does not
  recur through `capture.mjs`'s own log.
- The benchmark helper that erased the owner's `.claude/compaction-checkpoint.md`
  would have written its own session-scoped checkpoint, and the orchestrator's
  would still exist.
- `staging-scope-guard.test.mjs` would not have left records in the live state
  root, and `question-philosophy-gate.test.mjs` would not have re-armed the gate
  in every open session.

## False-positive surface

Essentially none on the write path — this is a rename, not a new refusal.

The cost is on the READ path. Any consumer that today globs a fixed filename must
move to the set-reading helper, and a per-session filename multiplies file count
in `run-logs/`, so a retention sweep becomes load-bearing where the shared name
previously self-limited. `C:\Code\docs\backlog.md` already carries "Nothing prunes
hook state except `compaction-lib.mjs`'s own directory (2026-09-08)", so this
change creates pressure to do that sweep rather than being able to assume it.

## The open choice

1. **Mint identity everywhere, then do the retention sweep** — the complete fix,
   and it makes the pruning item urgent rather than optional.
2. **Mint identity for the two writers that measurably collided** (capture logs
   and the compaction checkpoint) and leave hook state and the memory store —
   smaller, but it leaves two of five recurrence sources standing.
3. **Do nothing structural; add the state-root env override only** — closes the
   test-pollution case alone, which is the one with a clean workaround already.

## Checked against existing proposals

P25 (host artifact arrives by a guessable path — audit-tools-internal, and settled
2026-08-12 by removing the path in favour of a validating submit; the machine-wide
tooling never got that treatment), P43 (answered-work vs open-run collision), P23
(child session indistinguishable from owner — gate attribution, not file
identity), P52 (session-scoped commit refusal), P24 (gates cannot attribute tree
dirt). None touches capture logs, hook state, or the compaction checkpoint.
