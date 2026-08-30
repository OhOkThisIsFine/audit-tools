# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- **v0.50.15 is live, and this lap published nothing** — no file in the package's `files` list
  changed, so a release would ship an identical artifact under a new version.
- **The vitest gate now has exactly ONE success exit (`e7a8c559`).** Its reporter-transport
  tolerance path printed "Treating as PASS" and exited before `writeSuiteGreenStamp`, so the one run
  class the gate goes out of its way to call green was the one class leaving no evidence it was.
  Found at this lap's own baseline: a green run left the declared green mechanism pointing at a tree
  13 hours old. The contract test in `tests/shared/suite-green-stamp.test.ts` pins the property and
  states its uncovered structural half; the backlog entry is deleted rather than restated.
- **A lap worktree is NOT the empty-state-dir checkout two backlog entries assumed (`1484c895`).**
  The harness worktree mechanism COPIES the gitignored `.claude/hooks/.state`, so this worktree held
  121 session records byte-identical to the main checkout's and `enforcementArmed` returned TRUE.
  `git worktree add` leaves it empty; the harness does not. Both entries reasoned from one case.
- **Two gates that keyed on the CHECKOUT now key on the REPOSITORY.** `check:memory-citations` was
  inert in every lap worktree and ticked the skip; the session registry's arming was a property of
  how the worktree was made. Both resolve through the common git dir now, and contract tests state
  each trap.
  ⚠ **Cutover, stated because it is silent:** a session that registered in a worktree BEFORE this
  change has no record in the repository store and is classified an unregistered child until it
  re-registers — `node scripts/shared/sessionRegistry.mjs --register <session-id>`. This session did
  exactly that. The copied records left in a worktree's own `.claude/hooks/.state/sessions/` are now
  read by nothing; they are gitignored, so they are litter rather than a hazard.
- **A lap that opened BEHIND main used to red `npm test` once, then pass — and eat the guard that
  warned it.** `tests/shared/hook-trap-guards.test.ts` aimed source-shaped payloads at the REAL
  repository, so `tool-input-guard` rule 3 (stale-main deny-once) refused where rule 1 was under
  test, and `rmSync`-CONSUMED `.claude/hooks/.state/stale-main.json` on the way out. The guard is
  deny-ONCE, so the suite silently spent the lap's only warning. Both halves are measured, not
  inferred: under the original root AND paths a planted marker came back CONSUMED; under the fix it
  SURVIVED. Found at this lap's own baseline.
- **That fix binds ONE hook, and the asymmetry is the whole point.** `runInputGuard` pins a
  per-invocation temp root; `runHook`'s default stays `REPO_ROOT`. `tool-input-guard.mjs` spawns no
  git, so a temp root is exactly equivalent there. `shell-trap-guard.mjs` resolves the repo family
  with `git rev-parse --git-common-dir` at `cwd: ROOT` and is FAIL-OPEN — measured with one payload
  and two roots: real root exit 2, temp non-git root exit 0. A shared temp default would therefore
  have turned that guard's negative cases into false GREENs, which is worse than the false RED it
  would have fixed. That measurement is why the obvious fix was rejected.
- **The owner-approved session-registry liveness sketch is DEAD (`6e4b0f12`).** See *Immediate next*.

## Immediate next

**Nothing is pinned, by owner decision 2026-08-30.** The empty roadmap below was reviewed and chosen
at the hand-back, against pinning either the fresh-worktree disarm or the session-registry liveness
signal. It is a statement, not an omission — the next session picks from the backlog on its own
judgement.

Of the three residuals this section used to list, ONE remains in
[`open-bugs.md`](backlog/open-bugs.md), unpinned: the lane-DETECTION half, still open under the
abstention above. The child-session refusal's arming-by-worktree-provenance defect is closed, and
its entry was deleted rather than restated — after the fix its property was word-for-word the
detection entry's, and two entries stating one property is the duplication this repo bans.
⚠ **The mid-lap PAUSE-versus-END residual LEFT this repo** (owner ruling 2026-08-30: it is a global
issue, not an audit-tools one). Its home is now the machine-wide backlog, `C:\Code\docs\backlog.md`,
created that day because the machine-wide scope had no work tracker at all. `~/.claude/CLAUDE.md`
carries the pointer and the belongs-here test.

⚠ **That "approved as a lap of its own" liveness signal is DEAD as sketched (2026-08-30).** It was
put through the design gate and stopped there before any code: `pid` cannot live on the session
record, because only hooks write it and a hook is dead before anything reads its pid. The owner
STOPPED the lap rather than substitute a design, so the replacement shape is UNCHOSEN and is the
next decision on that entry. The dead sketch and the storage prior art
(`tests/helpers/suiteLock.ts`) are recorded in [`open-bugs.md`](backlog/open-bugs.md).

The standing program direction remains *redesign before scheduled autonomy* → the autonomous
audit→remediate→PR capstone once the architecture items are worked off.


## Deliberate state, not bugs

- `tests/audit/host-delegation-fold-carries-advisories.test.ts` remains deliberately unbaselined:
  its parallel-load timeout passes alone and is tracked as a known flake, so rebaselining it would
  hide a real regression.
- The detached host runner is intentionally not running.
- The tracked decision-queue snapshot STILL disagrees with the ledger that settles it, and it will
  keep doing so: its writer refuses a batch that drops a record-path item on its own, so no lap can
  quietly true it up. What changed is the consumer, not the artifact — `start-lap` step 5 now asks
  the decision ledger (`answer.mjs --list`) and treats it as the authority (`0ada039a`), because
  trusting the snapshot cost a lap four questions the ledger had already recorded settled AND landed.
  **Ask the ledger. Never read the snapshot for what is open.** The artifact's own freshness gate
  remains the real fix and is stated in full in its [`open-bugs.md`](backlog/open-bugs.md) entry,
  which is its home.
- The item-6 checkJs sweep remains type-only by contract; behavioral changes are bugs, not part of
  that refactor.
- The added-root-entry teardown false red is LEFT OPEN on purpose. Two adversarial rounds killed
  both candidate mechanisms by measurement — writer attribution is unavailable in ESM, and no
  exclusivity predicate exists — so nothing was changed rather than shipping a false green. The
  entry in [`open-bugs.md`](backlog/open-bugs.md) carries the dead designs and the three constraints
  a third attempt must satisfy, so the next try starts ahead rather than repeating these two.
- The attest preflight now ABSTAINS whenever the worktree and staged trees differ. That is a
  deliberate coverage reduction, not an oversight: it trades unreliable refusals for a recorded
  abstention, and its three uncovered halves are stated in the backlog entry and as `uncovered` data
  in the guard-reach registry.

<!-- BEGIN GENERATED LIVE STATUS — scripts/shared/generate-handoff-roadmap.mjs — DO NOT EDIT BY HAND -->
<!-- END GENERATED LIVE STATUS -->

<!-- BEGIN GENERATED ROADMAP — scripts/shared/generate-handoff-roadmap.mjs — DO NOT EDIT BY HAND -->

> **This list is GENERATED from [`docs/backlog/`](backlog/) — do not hand-edit it.**
> It is the IMMEDIATE NEXT work only, never the full open set. Prefix an entry's bold title with
> `▶` in the backlog file that owns it and it appears here; empty means nothing is
> pinned, which is a statement rather than an omission.
> **Every open item lives in [`docs/backlog/`](backlog/)**, reachable by the seek index in
> [`backlog.md`](backlog.md) — this block is not a second index of it.
> Every line is a POINTER: the backlog entry's own title, verbatim, and a link to the file that
> holds its spec. Nothing here restates a spec, so this list and the backlog cannot drift.
> Regenerate: `node scripts/shared/generate-handoff-roadmap.mjs` (`--check` gates it in
> `verify:checks` and at commit). 0 pinned item(s).

### ▶ Next up — pinned in the backlog

*(nothing pinned — no immediate next step is set. Every open item is in [`docs/backlog/`](backlog/).)*

<!-- END GENERATED ROADMAP -->
