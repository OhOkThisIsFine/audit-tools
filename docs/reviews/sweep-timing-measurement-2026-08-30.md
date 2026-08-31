# Sweep-timing measurement — what removes a stored session entry, and whether `processAlive` suffices (2026-08-30)

Owner decision, 2026-08-30, taken on reading the
[`ppid` result](ppid-liveness-measurement-2026-08-30.md): **measure sweep timing before designing.**
That record proved a durable session pid is obtainable from a hook and storable where another
session can read it, and named the untouched half in its own words — *"nothing was measured about
write and sweep timing: when a hook writes the entry, what removes it when a session ends without a
clean exit, or whether `processAlive` alone is a sufficient sweep."* This lap measures that half.

The lap was approved with a design half attached, so a proposal follows the measurements. Every
number below was measured during this lap. No production code changed while measuring.

## Environment

Windows 11 Pro 10.0.26200, Claude Code 2.1.247 desktop app, Node 22, checkout `C:/Code/audit-tools`,
HEAD `5876f7c5`. Probes ran against a holder directory keyed to a **fake** repo root, so no live
suite entry and no real session record was touched.

## Prior art found before measuring, and it changes the question

The prior record proposed the `suiteLock` storage as the place a session pid could live. A broad
search first found that **this repo already has a session registry**, and it is closer to the need
than `suiteLock` is.

`scripts/shared/sessionRegistry.mjs`, written by the `SessionStart` hook
`.claude/hooks/session-start-guards.mjs`, read by the closeout, friction-stop, question-philosophy
and pre-commit gates:

| Property | Value |
|---|---|
| Written at | `SessionStart` — i.e. at session start, which answers the *write timing* half outright |
| Keyed on | the **repository** (git common dir), so every worktree of one repository shares it |
| Record | `{version, session_id, registered_at, source, baseline}` |
| Carries a pid | **No** |
| Carries a checkout | **No** |
| Sweep | `pruneStaleSessionRecords` — unlink `*.json` older than **30 days** by mtime |
| Prune caller | the same `SessionStart` leg, best-effort |

Two consequences follow without any measurement.

1. **The write-timing question is already answered.** An entry exists from session start, not from
   the first tool call, because `SessionStart` is the writing event.
2. **The existing sweep cannot serve liveness.** A dead session's record claims presence for 30
   days. The horizon was chosen for record *hygiene*, and the module says so — first-write-wins
   refreshes mtime on every resume re-fire, so only a session untouched for the whole horizon loses
   its record. Nothing about it was ever intended to answer *"is a session live right now"*.

So the design target is not a new store. It is a liveness predicate over a store that already
exists, is already written at the right moment, and already has the right writer.

## Result 1 — nothing removes a stored entry on an unclean death; the sweep is reader-driven only

Probe 1 wrote a holder entry for a real child process, killed the child with `taskkill /F`, and then
asked what happened to the entry. 9 cases, 3 iterations of 3 shapes.

| Shape | Runs | Entry still on disk after the kill | Removed by | `processAlive` flip |
|---|---|---|---|---|
| C — handle held by the prober | 3/3 | **yes**, every run | the reader's sweep | 0.042–0.045 ms |
| D — no handle held anywhere | 3/3 | **yes**, every run | the reader's sweep | 0.034–0.042 ms |
| E — clean `process.exit(0)` | 3/3 | **yes**, every run | the reader's sweep | 627–639 ms (the child's own timer) |

**Nothing in the operating system, the filesystem, or the storage removes the entry.** In all 9
cases the file survived the owner's death and disappeared only when a reader ran the
`liveHolders`-shaped sweep. A clean exit is no different from a kill in this respect: `unregisterSuite`
removes the entry only when the process reaches its own teardown, and an unclean death never does.

**The exposure window is therefore "from the death until the next reader", not a timer.** That is the
quantity a design must reason about, and it is bounded only by how often something reads the store.

Two secondary results, both stated because they retire a hazard rather than raise one:

- **A held handle does not keep `processAlive` true.** Windows `OpenProcess` can succeed on a
  terminated process whose handle is still open, which would have made `processAlive` report a dead
  process as alive. Cases C and D are indistinguishable in the data, so this does not occur here.
- **`tasklist` agreed with `processAlive` in all 9 cases**, before and after each kill, so no result
  above rests on `process.kill(pid, 0)` confirming itself.

## Result 2 — `processAlive` alone is NOT a sufficient sweep, and the first probe nearly said the opposite

This is the load-bearing result, and it is also a correction of an earlier reading taken in this same
lap. Both probes are reported, because the disagreement is the finding.

**Probe 2 — 3,240 process creations, zero reuse.** Six rounds of 40 concurrent spawns, then two
direct hunts of 1,500 spawns each against one specific killed pid. No tracked dead pid ever came
back. Read alone, this says `processAlive` is fine.

**Probe 3 — 12,000 creations, reuse in 2.2 seconds.** The same machine, driven harder and tracking
every pid rather than a few.

| Measure | Value |
|---|---|
| Creations | 12,000 in 96.6 s (124/s) |
| **Distinct pids drawn** | **5,144** |
| Reuse events | ≥25 (the probe stopped recording at 25) |
| **Minimum creations between a pid's use and its reuse** | **270** |
| **Minimum elapsed time between use and reuse** | **2.216 s** |
| Observed pid range | 276 – 51,192 |

**Probe 2 was wrong because of its sample, not its method.** It tracked 240 dead pids against a
working set of ~5,144, so it never wrapped. The wide observed pid range (276–51,192) also invites the
wrong inference: the numeric range is large, but the allocator recycles a much smaller working set.
Had this lap stopped at probe 2 it would have handed the design a false premise, which is the exact
failure the owner's *measure before designing* rule exists to prevent.

**What this means.** A stale entry sweeps only because `processAlive(pid)` is false. Once the OS
re-issues that pid to an unrelated process, the predicate returns true and **the entry never sweeps
again**. Combined with Result 1 — nothing removes the entry on its own — a single reuse converts a
dead session's record into a permanent claim of liveness.

**The repo already believed this; it had not measured it.**
`tests/helpers/global-setup.ts`'s `liveChildProblems` says *"a pid outlives the process that owned it
and the OS reuses it, so killing by pid can hit an unrelated process"*, and refuses to kill for that
reason. This measurement supplies the number that comment lacked, and extends the consequence from
*killing* to *believing*.

**Honest bound on the number.** 124 creations/s is heavy pressure, not an idle machine, so 2.216 s is
a floor and not a typical value. It is not an artificial regime for this repo: `npm test` spawns
processes at scale, and the store is read by suite runs and gates. The correct reading is that reuse
is a live mechanism with a measured floor of seconds, not a theoretical one with a horizon of days.

## Result 3 — creation time detects reuse, at a platform-specific cost

The mitigation is to check that the process now holding the pid is the same one the entry described.

| Measure | Value |
|---|---|
| `Win32_Process.CreationDate` available for a live pid | yes |
| Stable across repeated reads of one live pid | yes |
| First query | 314 ms |
| Mean of subsequent queries | 282 ms |

The record already carries `registered_at`, so the test needs no new stored field:

> An entry is evidence of a live session only if `processAlive(pid)` **and** the process's creation
> time is not later than `registered_at`.

The direction is one-sided and sound. A genuine session existed before the hook that recorded it, so
its creation time precedes `registered_at`. A process that later inherits the pid was created after
the record was written, so it fails the comparison.

**The cost is the problem, and it is the repo's stated invariant that makes it one.** Reading another
process's creation time has no portable Node API. `Win32_Process` here, `/proc` or `ps` elsewhere,
and ~282 ms of PowerShell per query. `CLAUDE.md` requires OS/platform-agnostic core logic, so a
design resting on this either routes through an abstraction with a real implementation per platform,
or degrades to abstention off win32 — and an abstention that fires on every non-Windows machine is
the *silence* that constraint (ii) on the backlog entry already rules out.

## Result 4 — hook firing cadence, which is what a portable alternative would rest on

Measured with a temporary `PreToolUse` / `PostToolUse` / `Stop` / `UserPromptSubmit` hook installed
in the **gitignored** `.claude/settings.local.json`, exactly as the prior lap measured Result 4 there.
The tracked tree was untouched throughout, and the file was restored byte-for-byte (10336 → 11574 →
10336, `hooks` key absent again).

| Measure | Value |
|---|---|
| Fires observed | 58 |
| Span | 516.8 s (8.6 min) |
| By event | `PreToolUse` 31, `PostToolUse` 27 |
| Gap between fires — min | 0.08 s |
| **Gap — median** | **2.54 s** |
| Gap — p90 | 27.0 s |
| Gap — max | 68.5 s |

**Stated limit of this sample.** It covers a single session inside ONE assistant turn, so `Stop` and
`UserPromptSubmit` never fired and the sample contains no turn boundary. The gaps here are
assistant-thinking gaps, not owner-idle gaps, and the largest real gaps in a session are the latter.
The number this result supports is therefore the narrow one: **during active work, hook fires are
dense relative to a suite run** — a median of 2.54 s against a suite measured in minutes. It does not
support any claim about how long a live session can go without firing.

The portable alternative to creation time is a **heartbeat**: hooks already fire many times per
session, so a record whose mtime stops advancing is a record whose session stopped. That needs no
process table, no ancestry walk, and no per-OS branch.

**Its own failure mode is the mirror of reuse.** An idle-but-live session goes stale and is read as
dead. That direction is the safe one here, and the reason is specific rather than general: the
foreign write this whole mechanism exists to attribute **is itself a tool call**, so the act that
creates the dirt is the same act that refreshes the record. A session that has not fired a hook for
the whole horizon has not written into the root during it either.

## Result 5 — the environment already carries the session identity, and it survives `npm`

This was not on the lap's list. It was found while checking one small premise of the proposal, and it
retires more prior work than anything else measured here.

The `ppid` lap established that the consumer cannot obtain its own session pid, because the ancestry
walk dies through `npm` — the shape `npm test` has — and concluded the consumer must READ a stored
pid. **That conclusion rested on the walk being the only route. It is not.**

| Variable | In a Bash-tool child | Through `npm exec` | In vitest `globalSetup` | In `teardown` | In a worker |
|---|---|---|---|---|---|
| `CLAUDE_CODE_SESSION_ID` | set, `cde63734-…` | survives | present | present | present |
| `CLAUDE_PID` | set, `41588` | survives | present, **verified alive** | present, alive | present |
| `CLAUDE_PROJECT_DIR` | **UNSET** | — | — | — | — |

`CLAUDE_PID` 41588 is a live `claude.exe` whose `ParentProcessId` is **1388** — the root `claude.exe`
the `ppid` lap identified, whose own parent is `explorer.exe`. So the environment hands over exactly
the process the ancestry walk was built to find, and the value the walk had to derive from a
platform-specific process table arrives as a plain string.

The last three columns were measured in a **real vitest run launched through `npm exec`**, which is
the exact position `repoRootProblems` occupies and the exact shape that broke the walk. Environment
inheritance and process ancestry are different mechanisms; `npm`'s extra `cmd.exe` hop severs the
second and not the first.

**Consequences.**

- The blocking constraint the `ppid` lap recorded — *"the consumer must READ a stored pid rather than
  walk"* — is **dissolved for the consumer's OWN identity**. It needs neither.
- **The consumer can name its own session**, which is what makes any "exclude myself" test possible.
- A design may still need a store for OTHER sessions. That is a different need from the one the
  prior lap was solving.
- `CLAUDE_PROJECT_DIR` is **not** available in a tool shell — it is a hook-invocation variable
  substituted into `.claude/settings.json` command lines and never exported. The repo's
  `shell-trap-guard` already states this trap and it is what surfaced the fact here. So a checkout
  path must come from the hook that records it, never from the consumer's environment.

## What is proven, and what a design must now clear

**Proven by this lap.**

1. Nothing removes a stored entry when a session dies uncleanly. The sweep is reader-driven and
   nothing else (9/9 cases, both handle regimes, and a clean exit alike).
2. `processAlive` flips within ~0.04 ms of an unclean death, and a held handle does not defeat it.
3. **`processAlive` alone is NOT a sufficient sweep.** Pid reuse is real, with a measured floor of
   270 creations / 2.216 s, and one reuse makes a dead session's entry claim liveness permanently.
4. Creation time detects reuse soundly against the `registered_at` the record already carries, at
   ~282 ms and with no portable API.
5. Write timing needs no design: `SessionStart` already writes the record at session start.
6. **The environment already carries the session identity**, in the consumer's exact position and
   through `npm`: `CLAUDE_CODE_SESSION_ID` and a live, correct `CLAUDE_PID`. `CLAUDE_PROJECT_DIR`
   does not — it is hook-only.

**Not proven, and load-bearing for whatever is built.**

- The reuse floor was measured under heavy spawn pressure on one machine. The distribution of reuse
  intervals under ordinary load was not measured, and the probe stopped recording at 25 events.
- The cadence sample is one session inside one turn, with no turn boundary in it.
- No design was executed and **no failing test was written.** The design section is a proposal, and
  the two breaks its refutation found are recorded there with their verification.

### The five standing constraints, restated with what this lap did to each

| # | Constraint | Status after this lap |
|---|---|---|
| (i) | The throw is part of the DECLARED green mechanism, so a downgraded local verdict makes `npm test` stamp a tree containing the leak | **BINDS, and it broke the first proposal.** Verified at `writeSuiteGreenStamp` (`scripts/shared/run-vitest-gate.mjs`). The revision withholds the stamp rather than downgrading the suite. |
| (ii) | "Notice instead of throw" is silence — the pre-commit leg reads the child's streams only in `catch` | **BINDS.** Answered by routing the abstention through the stamp, which the closeout gate already reads, rather than through a stream. |
| (iii) | Nothing binds `teardown()`'s composition — `repoRootProblems` has one caller and zero test observers | **BINDS, and it is sharper than recorded.** Verified: the path-spelling mismatch makes an unnormalized fix match nothing and ship inert. It is also why the smallest failing test cannot be written until the decision is extracted. |
| (iv) | The process table cannot attribute a session to a CHECKOUT | **ROUTED AROUND, not refuted.** It remains true of the process table. The `SessionStart` hook holds `CLAUDE_PROJECT_DIR` and records the checkout directly, so nothing needs to ask the process table. |
| (v) | The ancestry walk is platform-specific, against the OS-agnostic invariant | **DISSOLVED.** Result 5: no walk is needed. The identity arrives as an environment variable, which is portable by construction. |

The `ppid` lap's own blocking conclusion — *"the consumer must READ a stored pid rather than walk"* —
is also dissolved for the consumer's own identity by Result 5. A store is still needed for OTHER
sessions, which is a different requirement than the one that conclusion was serving.

## The design half — proposal, refutation, and what survived

The lap was approved with a design half attached, on the condition that the measurement ran first.
It did. This section is a **proposal that has not been implemented**; no code changed this lap.

### The three dead designs this replaces

Carried here from the backlog entry so the entry can point rather than retell. Any new design must
clear all three bars.

1. **Attribute the writer.** No OS offers post-hoc file→writer attribution, and ESM named imports
   bypass a `node:fs` patch.
2. **Assert only where the run is sole writer.** The state dir is unreliable both ways: `git worktree
   add` leaves it empty while the harness mechanism COPIES it.
3. **Session liveness via a stored pid.** Died on *"a hook is dead before anything reads its pid"* —
   which the `ppid` lap showed is true of the hook's own pid and false of the session's. Its
   replacement cause, *"the walk dies through `npm`"*, is retired by Result 5 above. **Both stated
   causes for this design's death turned out to be untested premises**, which is the durable lesson of
   the pair of laps.

### The proposal — replace the LIVENESS question with an OVERLAP question

Every prior attempt asked *is another session live?* and died on it. The measurements say that
question is the wrong one, and an expensive one: liveness needs a pid (R2 — reuse makes a stored pid
claim liveness permanently), and repairing the pid needs creation time (R3 — ~282 ms and no portable
API).

The teardown does not need liveness. It needs to know whether another session **acted inside its own
window**, which is a timestamp comparison.

1. Each session's hook fire stamps its own registry record with `last_active`, and `SessionStart`
   records the checkout it belongs to. Both writers already exist and already hold both values.
2. `setup()` records `windowStart`; `teardown()` records `windowEnd`.
3. The attribution question becomes: is there a record, **other than this run's own session**, for
   **this checkout**, whose `last_active` falls inside `[windowStart, windowEnd]`?
4. If there is, the added root entries are not attributable to this run.

What the measurements buy it: no pid, so R2 is dissolved rather than mitigated; no process table and
no per-OS branch, so R3's cost and the OS-agnostic conflict both disappear; no staleness horizon to
tune, because the window is the suite's own interval; and a never-swept stale record is harmless,
because the record's AGE is the signal rather than something to clean up — which is R1 answered
without any sweep at all. R5 supplies the "exclude myself" half: the consumer knows its own session
id. R4 supplies the reason the stamp lands in time — a foreign write IS a tool call, so the act that
creates the dirt is the act that stamps.

### The refutation, and the two findings that survived verification

An independent lane (`agy-gemini`, 68 s) was asked the design gate's three questions. Its answers are
leads, so each was re-checked against source. **Two survived, and both are real.**

**Break 1 — the abstention breaches the declared green mechanism. VERIFIED.**
`writeSuiteGreenStamp` in `scripts/shared/run-vitest-gate.mjs` runs as `if (isFullSuiteRun(vitestArgs))
writeSuiteGreenStamp(repoRoot, worktreeTree(repoRoot))` on any full-suite run that reaches it. The
teardown throw is what stops a leaking run from reaching that line. Convert the throw into an
abstention and the run exits 0, line 153 executes, and **`npm test` mints full-suite green evidence
over a tree that contains a real leak.** That is constraint (i) exactly, and it kills the proposal as
first written.

**Break 2 — the fix ships INERT on a path spelling. VERIFIED.**
`tests/helpers/global-setup.ts` computes its root as `join(dirname(fileURLToPath(import.meta.url)),
"..", "..")`, which on win32 yields `C:\Code\audit-tools`. The hook's `CLAUDE_PROJECT_DIR` is
`C:/Code/audit-tools`. A naive string comparison of the two is **`false`**. A `root`-filtered overlap
test would therefore match nothing, fire never, and leave every pinned case green — which is
constraint (iii) realized precisely, not merely risked.

A third lane point — that the registry is keyed on the REPOSITORY while the teardown asks about a
CHECKOUT — is real but is what the `root` field is for; Break 2 is the sharp form of it.

### The revision the refutation forces

**Answering Break 1: the abstention withholds the STAMP rather than downgrading the suite.**
Constraint (i) protects the green stamp, so that is the thing the abstention must act on. When the
teardown cannot establish attribution it does three things: it does not throw (so no false red), it
**withholds the full-suite green stamp** (so no false green over an unverified tree), and it reports
the abstention naming the concurrent session.

This also answers constraint (ii), which says "notice instead of throw is silence" because the
pre-commit leg reads the child's streams only in `catch`. A withheld stamp is not a stream — the
closeout Stop gate already refuses on missing or stale stamp evidence and says why. The abstention
reaches a reader through a channel that already exists, which is what
[[abstention-is-a-legitimate-gate-verdict]] requires of an abstain-and-RECORD verdict.

**Answering Break 2: normalize both paths, and pin the spelling case.** Both sides route through the
repo's existing `normalizeRepoPath` abstraction rather than comparing raw strings, and the
path-spelling case gets its own pinned test — because that spelling is the exact way this ships inert.

**Answering constraint (iii) structurally.** `repoRootProblems` has one caller and zero test
observers today, which is also why the smallest honest failing test cannot be written against it as
it stands. The attribution decision must be extracted into a pure, exported, directly-tested function
before the behaviour changes, so the fix has an observer that a later edit cannot silently unwire.

### Friction hit during this lap

Two items, and **neither is new** — both are fresh instances of traps already filed, which is worth
stating because it is evidence the filings are pitched at the right level. Each was added as a
spelling to its existing entry rather than filed again.

1. **The green-mechanism deferral hands back a module, not a command** — already filed machine-wide in
   `C:\Code\docs\backlog.md` (2026-08-30), and hit again here following step 3 of `/start-lap`.
   **What this lap adds is that the dead end is GREEN-SHAPED**, which the entry did not say: running
   `node scripts/shared/suiteGreenStamp.mjs check` prints nothing and **exits 0**, because a library
   module with no CLI succeeds silently. So the deferral does not merely fail to answer — it hands
   back something that reads like a pass. The real answer was to compare the stamp's `tree` field
   against `git rev-parse HEAD^{tree}` by hand.

2. **Git Bash mangles a `/FLAG` argument into a path** — already filed in
   [`durable-traps.md`](../backlog/durable-traps.md) as a class, with `claude -p "/insights"` and
   `cmd /c` as its spellings. **This lap adds a third:** `tasklist /FI "PID eq N"` fails with
   `Invalid argument/option - 'C:/Program Files/Git/FI'`, while the same call as argv from Node
   (`spawnSync("tasklist", ["/FI", …])`) is unaffected — so the trap is the SHELL, not the tool.

### Second refutation — the revisions were checked independently, and the design DIED

Owner decision, taken on reading the first refutation: **refute the revisions before writing any
code**, because the revisions above answered the first refutation but were written by the proposal's
own author. A second independent lane (`agy-gemini`, 50 s) was asked to attack them. It returned
`fatal: true` on all three questions. Each checkable claim was re-verified against source before
being accepted; the two that were verifiable are verified, and one improves on the proposal.

**Revision B is dead, and the correct primitive already exists.** `normalizeRepoPath` is
`p.trim().replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase()`
(`src/shared/validation/findingGrounding.ts`). It never calls `resolve()`, so it cannot reconcile two
absolute spellings; it lowercases unconditionally, which is wrong off win32; and it lives in the
TypeScript tree, so a `.mjs` hook importing it takes a dependency on a built `dist/` — in a repo
that already warns a fresh worktree resolves a STALE `dist/`. **`samePath`
(`.claude/hooks/session-start-guards.mjs`) is the right tool and is already in the writing file**:
`resolve()`, forward-slash, trailing-slash strip, and a case-fold guarded by
`process.platform === 'win32'`. It has no `dist/` dependency. Verified by reading both.

**Revision A is dead.** Two of the three counts hold. The closeout's missing-stamp finding says
*"`npm test` has not passed since the stamp was last cleared … run it after your last edit"*, which
for an abstention is simply FALSE — the suite passed and merely could not attribute — so the
abstention reaches a reader wearing the wrong diagnosis. And a re-run does not clear it: while the
other session keeps acting, every re-run abstains again, and the operator is told to do the one thing
that cannot help. *(Stated accurately rather than as the lane put it: this is not an infinite loop —
it clears once the other session goes quiet. The defect is that nothing tells the operator that, so
they cannot know to wait.)* The lane's first count — that the gate stamps after vitest exits, so
teardown cannot reach the decision — is a cost rather than an impossibility, since the gate already
reads a per-run ledger; but with the other two counts standing it does not need to be settled.

**The whole overlap design is dead, on a flaw neither refutation round had reached.** Hook fires
track TOOL ACTIVITY, not filesystem writes. A concurrent session that merely READS a file during the
suite window updates its `last_active`, the window reads as overlapped, and **a genuine leak created
by the suite itself is silently excused**. Confirmed against this lap's own cadence probe, whose
matcher was `*` and which fired on every tool call. So the design does not remove the false red — it
**converts it into a false green**, which is the exact direction constraint (i) exists to forbid.
That is fatal, and it is not repairable by narrowing the matcher: a `Bash` call cannot be classified
as read-only from a hook.

### What survives the death, so the next attempt starts ahead

- **Every measurement above.** R1–R5 are facts about the machine and the repo, not about this design.
- **`samePath` is the checkout-comparison primitive**, already written, already in the hook.
- **The consumer knows its own session** (R5). That remains true and useful to any design.
- **A sixth constraint, added by this lap.** Any future design must satisfy it:
  **(vi) an abstention trigger must be correlated with WRITES, not with activity — and an abstention
  must never become a green.** A trigger that fires on read-only activity converts the false red into
  a false green; an abstention routed through a missing stamp reaches the operator as a false
  diagnosis and cannot be cleared by the action it recommends.

### A FIFTH design died the same day — and it exposed why all five failed

Owner decision after reading the fourth death: **authorise a fifth attempt on a WRITE-correlated
trigger**, which is what constraint (vi) demands. It was designed, refuted, and died. Recorded here
rather than in a second dated record, so this file is the ONE home for the defect's design history.

**v1, killed by its own author before review.** A `PostToolUse` hook `readdir`s the repo root per
tool call and records entries that APPEARED. Cost is not the objection — `readdirSync` on this root
is **0.036 ms** mean over 2,000 calls, 47 entries. The objection is that observing an entry APPEAR
does not establish that the observing session CREATED it, so a concurrent session would observe the
suite's own leak and excuse it. That is design four again at finer granularity.

**v2, the one reviewed.** Record only what a session can attribute from its OWN tool input: a
`PostToolUse` hook on `Write|Edit` reads the path the payload carries, and the teardown suppresses an
entry only on positive, input-derived evidence naming that exact entry in-window. Bash was
deliberately excluded, because a readdir delta around a shell call is observation, not input.

**Two breaks, one fatal.**

- **It fixes nothing that actually happens. FATAL, and verified against project memory
  ([[repo-root-empty-files-are-shell-redirect-artifacts]]).** The real root artifacts are empty files
  named from code fragments — `o.testId)`, `60s`, `0)`, `entry.tool` — and their producer is
  **measured**: a command STRING reaching **cmd.exe**, where `>` redirects anywhere in the line. The
  same record exonerates the suite outright: 6,496 instrumented spawns, **zero** carrying `>`. And it
  states who does produce them — *"the artifacts appear while an AGENT session works in the main
  checkout"*. So the foreign writes this defect is about arrive through **shell** tool calls, which is
  exactly what v2 declines to attribute. v2 covers a case that does not occur.
- **Write-then-delete re-collision.** A foreign session Writes a root entry and deletes it, both
  in-window; the suite then leaks a file of the SAME NAME. The name matches an in-window record, so
  the entry is suppressed — a false green. Repairable in principle by binding the record to the file's
  birthtime rather than its name, but moot given the fatal break.

### The pattern across five deaths, which is the lap's real finding

Dead design 1 established that **post-hoc file→writer attribution is unavailable**. Designs 3, 4 and
5 were each an attempt to *proxy* for it — by liveness, by activity overlap, by tool input — and each
proxy failed in the same direction: it either could not see the real writer, or it excused an entry
without having established who wrote it.

**So the teardown's question may be the wrong question.** The producer is now known and measured: an
agent session's `cmd.exe` redirect, from a command string that carries the shell's own grammar. That
is a defect with a SOURCE, and the repo already guards that class at the source
(`shell-trap-guard.mjs`, and the standing rule to route through argv — `resolveExecArgv` /
`parseCommandString`, never `shell: true`). A sixth attempt aimed at *attribution* should be regarded
as the fourth proxy for something already proven unavailable. **The open direction is prevention at
the producing boundary, not attribution at the consuming one** — and per the repo's own rule that a
gate states the boundary it OWNS, the teardown is not that boundary.

### The assumption every design shared, and the direction it opens

The owner rejected BOTH options offered after the fifth death — prevention at the producer, and
de-pinning — and paused. Restating the situation surfaced an assumption that all five designs, and
both of those options, had accepted without examining it.

**Every design assumed the check must run inside the suite, across a `[setup, teardown]` window.**
The window is what creates the attribution problem. A window forces the guard to ask *who wrote this
entry*, and that is precisely the fact dead design 1 proved unobtainable.

The property actually wanted is not *"this run added nothing"*. It is **"the repo root holds no
undeclared entry"** — a snapshot predicate with no baseline, no window and no writer:

> Is there an entry in the root that is neither tracked by git nor listed in `RUN_OWNED_ROOT_ENTRIES`?

At the COMMIT boundary that question is always answerable. A foreign artifact still blocks, but the
refusal becomes TRUE and actionable — *the root holds an undeclared entry, delete it* — instead of
the false and unactionable *this run ADDED 1 entry*. It also satisfies the repo's own rule that a
gate states the boundary it OWNS: the commit boundary owns "the tree is clean", and a test run
does not.

Costs, stated because none has been weighed: it stops catching a suite that leaks then cleans up
after itself (measurement says that case does not occur); it moves root cleanliness out of what
`npm test` certifies, which is what constraint (i) protects, so the property needs a restated owner;
and it needs the declaration list rather than `.gitignore`, because an ignore rule HIDES a leak.

**Unapproved and undesigned.** Recorded as an open track in
[`forward-tracks.md`](../backlog/forward-tracks.md), not started.

### What this lap did NOT do

**No failing test was written, and no code changed.** The design gate's step 4 asks for the failing
test next, and writing it requires creating the seam in `tests/helpers/global-setup.ts` described
above — that is implementation, and the lap was approved to end at a refuted proposal. The decision
to implement is the owner's and is stated in the hand-back rather than taken here.
