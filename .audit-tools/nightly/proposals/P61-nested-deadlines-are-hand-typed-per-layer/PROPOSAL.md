# P61 — Nested deadlines are hand-typed at each layer, so an expiry names nothing

**Scope: REPO.** The spawn chokepoint is `runExternalAnalyzer` →
`runTrackedAsync` in `src/shared/analyzers/acquisitionEngine.ts`. The work item
belongs in `docs/backlog/open-bugs.md`.

**No patch attached.** The reporting half is settled and the propagation half is
not — see *The open choice*.

## The recurrence

Five records across four distinct dates. All quotes verified at their cited
source.

- **2026-09-04**, `docs/backlog/open-bugs.md` — "`type-coverage`'s acquired-analyzer
  spawn carries a deadline ten times longer than the callers actually waiting on
  it … `ANALYZER_CHILD_DEADLINE_MS`, 10 minutes … It is simply longer than any
  real caller's budget: vitest's own 300-second per-file timeout, and this
  project's one bounded step fold invariant." Confirmed in code:
  `ANALYZER_CHILD_DEADLINE_MS = 10 * 60 * 1_000` in
  `src/shared/analyzers/acquisitionEngine.ts`, passed straight into
  `runTrackedAsync`.
- **2026-09-04**, same file, tagged `false_red`, severity high — "CI orchestration
  shards time out at 300s with the spawned `audit-code next-step` still alive …
  Both report `Test timed out in 300000ms` … a bare 300s timeout with a live child
  names nothing."
- **2026-09-08**, `C:\Code\docs\backlog.md` Open items — "`posttooluse-typecheck.mjs`:
  the outer 120 s budget cannot hold three 100 s inner runs … a slow repository is
  killed silently by the settings timeout and reports nothing. Property: one
  budget, declared once."
- **2026-07-24**, `docs/backlog/durable-traps.md` — "The Bash tool silently CLAMPS
  `timeout` to 600000ms": a caller-imposed bound the callee never learns.
- `~/.claude/CLAUDE.md` — "three client idle timeouts must be lifted or a long
  think dies at ~300 s"; "agy `--print-timeout` defaults to `5m0s` and silently
  truncates a long lane."

The shape is constant: each layer hand-types a duration, no layer knows its
caller's remaining budget, and the expiry message names neither what it waited on
nor whether the child survived.

## The mechanism

Propagate a **deadline**, not a duration, through the one spawn chokepoint this
repo already owns.

`runExternalAnalyzer` → `runTrackedAsync` currently takes a per-callee constant.
Make the parameter an absolute deadline the CALLER supplies from its own remaining
budget, and have the spawn boundary take `min(own cap, caller remaining)`. A
test-context caller derives it from vitest's per-file timeout, so a child can
never be given longer than the process waiting on it will wait.

The second half is what ends the false red: on expiry the boundary must report
WHAT it waited on — the argv, the elapsed time, and whether the child is still
alive — rather than a bare `Test timed out in 300000ms`.

`check:guard-reach` is the precedent for the declared-data half: the deadline set
becomes a registry rather than five hand-typed literals, so a callee whose cap
exceeds every declared caller's is a red build instead of a discovery.

## What it would have caught

The two `audit-code-test-suite` shard failures on `main` the same day
(`e197ea2c` shard 1/4, `001d45f1` shard 3/4). Each reported a bare 300 s timeout
on a different test while `node audit-code.mjs next-step` was still running. A
deadline-aware boundary would have named the surviving child and the argv it was
waiting on — the whole difference between a diagnosable red and the red everyone
learns to skip while `ci` reads green on the same commit. It would also have made
the 10-minute `type-coverage` deadline structurally impossible to hand to a
300-second vitest caller.

## False-positive surface

Real, and it sits entirely in the propagation half. Shortening a child's deadline
to its caller's remaining budget converts some currently-slow-but-successful runs
into failures — specifically the cold `_npx`-cache analyzer fetch that the same
open-bugs entry measured, where the first spawn legitimately needs longer than any
single test file's budget. That case needs an explicit warm-cache precondition or
an out-of-band fetch, not a bigger number; getting it wrong makes a cold CI runner
red.

The reporting half has no false-positive surface at all. It only adds text to an
expiry that already happened.

## The open choice

1. **Both halves** — deadline propagation plus the naming expiry, with the
   cold-cache fetch moved out of band first.
2. **Reporting half only** — name the argv, elapsed time and surviving child on
   every expiry. Zero false-positive surface, lands immediately, and turns the
   recurring false red into a diagnosable one. It does not stop a child being
   handed a longer deadline than its caller will wait.
3. **Declared-data half only** — put the deadline set in the guard registry so a
   callee cap exceeding every caller's is a red build, without changing runtime
   propagation.

## Checked against existing proposals

Checked against the full P1–P57 listing and `INDEX-2026-09-06.md`: no proposal
concerns timeouts, deadlines, budgets, or spawn expiry. Nearest neighbours are P21
(a buffering pipe hides a live/hung run — same symptom class, opposite cause:
there the run is fine and the VIEW is empty; here the bound itself is wrong), P36
(lane liveness), and P57 (load-flake classified at the gate — a CI red re-run
solo, which overlaps the shard symptom but explicitly declines to touch the
deadline). `.claude/nightly-decisions.json` carries no settled subject on
timeout / deadline / budget; the only budget hits are backlog-entry SIZE budgets,
an unrelated subject.
