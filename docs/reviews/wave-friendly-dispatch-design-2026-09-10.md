# Design gate — wave-friendly host dispatch (2026-09-10)

Packet P26b, design lane. Closes the forward-track entry *"Wave-friendly host dispatch: run identity
survives partial ingest"* and narrows the durable-trap entry *"Each `dispatch_review` `next-step`
re-mints EVERY outstanding binding (measured 2026-08-21)"*.

This record is a **pre-implementation** artefact: it states the problem, the options, the choice, the
invariants the choice must keep, the exact files and symbols, and the tests that are red at HEAD and
green once the build lands. It does not itself change any file under `src/`.

> **§5 and §6 were amended by the build lane (2026-09-10) after the independent refutation (job-0085)
> returned *design stands with amendments*.** The amendments are marked **[AMENDED]** where they
> change what was originally written; the problem, the options and the choice in §1–§4 stand as
> decided, with the identity grain narrowed in §5.

---

## 1. The problem, with the measured evidence

A semantic-review wave publishes one work item per pending audit task. Two measured costs:

- **2026-08-21 (durable trap).** One partial ingest published a new run directory and changed
  `prompt_sha256` for **494/494** carried-over items and `result_path` for **494/494**; only
  `work_item_id` stayed stable. A host holding bindings from before that call had **100 % stale
  identity**, so every result it was still writing was refused.
- **2026-08-12 (forward track).** A worker still writing into the prior run's `host-results/` is
  silently orphaned — ingest reads only the current run id — and the per-run accepted ledger does not
  carry forward.

The mechanism, in source:

- `materializeReviewRun` (`src/audit/cli/reviewRun.ts`) mints the run id with
  `buildRunId(obligationId, 1)` = `<UTC-timestamp>_<obligation>_001` (`src/audit/io/runArtifacts.ts`).
  **The identity carries a clock.**
- `resolveReviewRun` reuses the active run only when `sameTaskIds(existingPending, currentPending)` —
  exact set equality of pending task ids. Ingesting ONE accepted result shrinks the pending set, so
  the equality fails and the next pause mints a new run id.
- The run id is the run **directory**, and everything the host binds through hangs off it:
  `host-workload.json`, `host-result-map.json`, `host-task-bindings.json`, the accepted pair, and —
  through `hostHandoffResultPath` (`src/shared/submission/hostHandoffCore.ts`) — every bound
  `result_path`. The prompt embeds `result_path`, so the prompt digest moves with it.

So **one content-derived, tool-owned fact — the pending set — silently invalidates the entire
in-flight wave.** The remedy in the entry ("publish the whole workload, execute all of it, then call
`next-step`; never call `next-step` with workers in flight") is a *host discipline*, and this project
bans host discipline as a correctness mechanism.

### The one existing reader of recency

`statusCommand` (`src/audit/cli/statusCommand.ts`) finds "the most recent run directory" by sorting
the `runs/` entries by NAME and reading the last one's `pending-audit-tasks.json`. The timestamp
prefix is the only thing making "newest name" mean "newest run". Any stable id has to replace that
inference with an explicit read of the active run — see §5, *adjacent strand*.

---

## 2. Retirement-collision check (design-check step 2)

Run before writing anything, off the repo rather than memory.

| Source | Finding |
|---|---|
| `git log --oneline -S'buildRunId'` | Introduced at `84ab9248` (monorepo collapse), reshaped at `467b1e8f` *"retire the execution substrate: zero adapters, host-owned execution"*. **Never removed.** The clock-minted id is the shape host-owned execution landed WITH, not a mechanism retired since. |
| `git log --oneline -S'formatRunTimestamp'` | Only `cece8276` (scaffold). Never removed. |
| `git log --oneline -S'sameTaskIds'` | Only `467b1e8f`. Never removed. |
| `git log --all -i --grep='re-mint\|remint\|stable run\|run identity'` | No hits. There is no commit that removed a stable-identity mechanism. |
| `docs/backlog/durable-traps.md` | The 2026-08-21 entry **describes this defect and asks for this change**. |
| `docs/backlog/forward-tracks.md` | The "Wave-friendly host dispatch" entry **names the two candidate remedies** and requires this gate before any build. |
| `docs/reviews/loop-silent-drop-design-gate-2026-09-06.md` | ⚠ The one real collision candidate — see below. |
| `docs/reviews/p25-design-check-2026-08-12.md` | Sets the migration rule for a contract-shape change: key on the **persisted contract version**, never a global flag, so an in-flight run keeps working. This change reuses that precedent rather than inventing one. |
| `spec/multi-ide-concurrent-runs-design.md` | Concurrency is a first-class case; no run-identity decision is stated there. |

**Verdict: no retirement collision.** Two adjacent decisions were checked and neither is violated:

1. **`loop-silent-drop` explicitly REFUTED "persist the fold's carried advisories"** on the grounds
   that it "adds a second durable store for a fact the submission ledger already holds" and reopens a
   boundary the code drew deliberately. **This design does not add a store.** The accepted pair
   already exists; the defect is that a re-mint makes it *unreachable* (its loader refuses a ledger
   whose `run_id` is not the current one). Making the identity stable makes the existing store
   reachable — a reader-side fix, which is exactly the corrected direction that record states.
2. **The clock in the run id was never a decision.** It is the shape that arrived with host-owned
   execution; nothing in the log argues for it.

### The precedent that decides it: the remediate draw already does this

`stateRunId` (`src/remediate/steps/nextStep.ts`) returns `state?.plan?.plan_id ?? "run"` — a **stable,
content-derived run id** — with the doc comment stating the determinism rationale outright ("so the
friction record path is deterministic across multiple next-step calls on the same run"). The
remediate host handoff takes its run id as a **caller-supplied parameter** and carries no clock at
all (`src/remediate/steps/dispatch/hostHandoff.ts`, `resolveHostHandoffPaths`).

So this is not two designs to weigh. It is **one core, two draws, with audit as the outlier**: audit
mints identity from a clock, its twin derives it from run state. The default is convergence on the
shared core, not a second identity system.

---

## 3. Options

### Option A — a stable, derivable run id (chosen)

The review run id becomes a pure function of the **review obligation** and the **audit run's durable
identity**, not of the clock and not of the pending set:

```
review-<slug(obligationId)>-<first 16 hex of sha256(stableStringify({ obligation_id, run_identity }))>
```

Same idiom as `mintSubmissionId` (`src/shared/submission/submissionIdentity.ts`): a human-readable
slug plus a digest that carries the identity, because the slug is lossy (`flow:auth/entry` and
`flow-auth-entry` collapse to one slug) and unbounded — the slug segment is capped at 48 characters
so the whole id clears the shared 128-character run-id grammar. `hashContent`/`stableStringify` are
the existing primitives (`src/shared/hash.ts`, `src/shared/stableStringify.ts`).

Consequences, in order of how much they matter:

- **Run directory, workload, result map, task bindings and every bound `result_path` are stable
  across a partial ingest**, because they are all derived from the run id. The prompt embeds
  `result_path`, so the prompt digest is stable too — for a task whose own content is unchanged. The
  measured 494/494 churn becomes 0/494.
- **The accepted pair stops being orphaned**: the ledger lives at `runs/<id>/`, so a stable id means
  `loadAcceptedResults` finds a document whose `run_id` still matches. Fixing the run id alone fixes
  the ledger carry-forward *with no ledger change at all*.
- The run id changes **only** when the review obligation changes — the semantic unit the run is
  named for. That is the identity a host is holding when it asks "which run am I answering?".

### Option B — an accepted ledger keyed by work item rather than by run

Re-key `AcceptedResultsLedger` on `work_item_id` alone (dropping `run_id` from the envelope and from
`loadAcceptedResults`' matching rule), and widen `AcceptedResultEntry` with the run context.

Rejected. It is **strictly less than A** — it does not fix the churn that is the measured harm:

- It does nothing for `result_path` (derived from the run dir) or `prompt_sha256` (embeds
  `result_path`). The 494/494 identity churn, which is the trap's actual evidence, survives intact.
- `bindingIdentity` is already `work_item_id × prompt_sha256`. Re-keying on the work item alone
  **loosens** that: a re-planned task whose ask genuinely changed (its file list moved) would read as
  satisfied, and a stale answer to the old ask would be accepted as the answer to the new one. A
  ledger that has forgotten what it asked cannot refuse an answer to the wrong question.
- It breaks *one home per fact*: the ledger is the run's accepted-results record, and its `run_id`
  field is what makes the strict loader refuse a document written for another run.

### Option C — A + classified re-mint refusal

A, plus a classified issue code that names a re-mint when one does happen. **Deferred, not
rejected.** Under A a partial ingest no longer re-mints anything, so the code would be needed only
for the identity changes that *should* orphan (a re-planned task whose ask genuinely moved). Whether
that residual deserves a new registered ingestion check is a question for the refutation lane (§7,
Q5) — it is not needed for the acceptance.

### Choice

**Option A.** It is the smallest change that satisfies the acceptance, it converges the audit draw
onto the identity model its twin already uses, and it fixes the measured harm at the root (the clock)
rather than compensating for it downstream. What it deliberately does **not** do is stated in §6.

---

## 4. Invariants the choice must keep

- **One core, two draws.** The derivation is audit-specific only because its *input* is (the review
  obligation); the property — *identity is content-derived, never clock-derived* — is the shared
  one, and it is already realized in the remediate draw by `stateRunId`. The shared path/containment
  substrate (`resolveHostHandoffPaths`, `hostHandoffResultPath`, `assertSubmissionRunId`) is
  untouched: the derived id must satisfy the **existing** shared run-id grammar, and a test now pins
  that the grammar admits the derived form (§5, `host-handoff-core.test.ts`).
- **Tool-owned identity.** The id is minted by the tool from run state and never supplied by a host
  or a model. Nothing new is asked of the host: it still reads `result_path` out of the published
  workload and writes there.
- **Atomic replace.** `buildRunId`, `formatRunTimestamp` and `pad` are *deleted* in the same change
  that introduces `deriveReviewRunId` — never added alongside. The `sameTaskIds` reuse rule is
  deleted in the same change that makes it dead, and the two lifecycle tests whose premise it was are
  rewritten in that commit (see §5).
- **Artifacts are continuity; dependency DAG is truth.** A stable run id makes the run directory
  *more* continuous, not less: one directory per review obligation instead of one per pause.
- **Conversation-first / no manual flag.** The host does not pass a run id; it never did.
- **Everything-agnostic.** No platform, shell, or clock-timezone assumption; the derivation is a
  pure function of strings.

---

## 5. Exact files, symbols and changes

### `src/audit/io/runArtifacts.ts`

- **Add** `deriveReviewRunId(params: { obligationId: string | null; waveGeneration: number | null }): string`
  — the obligation slug plus the 16-hex digest, built through `hashContent(stableStringify(...))`.
  **[AMENDED twice — the identity grain, and then its writer.]** The digest is salted with a **wave
  generation**, the tool's own durable record of which wave is open
  (`<artifactsDir>/runs/open-review-wave.json`). An id derived from the obligation alone is the same
  for two audits of one repo, and `runs/` is never pruned: the second audit would land on the first's
  directory, where the stale accepted pair withholds work and `loadAcceptedResults` throws on a
  foreign `run_id`.

  ⚠ **The first amendment salted with the run ledger's `run_id` and was WRONG — this is the
  correction.** That file has no writer in this package, so the salt was a constant `null` in every
  production run, and two waves of one artifacts dir resolved the SAME id and shared one accepted
  ledger. The ledger read is deleted with it (`loadRunIdentity`, and the malformed-ledger throw that
  reached the fold). The replacement respects the same rule the original should have: **the salt is
  a fact the TOOL writes in production.** `null` still means "no wave opened yet", which is also the
  generation every pre-generational artifacts dir reads from its run directories — the same grain
  the remediate twin's `stateRunId` derives at.
- **Add** `reviewWaveDigest(waveGeneration: number | null): string` — the generation's own
  fingerprint, a function of the generation ALONE. It is what makes the wave's run directory findable
  from the counter without knowing which obligation opened it. The digest is not salted with the
  obligation as well: that would make the counter's own question unanswerable.
- **Add** `openReviewWavePath`, `reviewWaveClosedPath` and their filename constants
  (`OPEN_REVIEW_WAVE_FILENAME`, `REVIEW_WAVE_CLOSED_FILENAME`) — both live under `runs/`, beside the
  directories they describe, so a counter and its runs are removed together and a closure marker is
  removed exactly with the run it describes.
- **Export** `RUN_ID_SLUG_MAX_LENGTH`, `RUN_ID_DIGEST_LENGTH` and `RUN_ID_PREFIX`, so the worst-case
  derived id is DERIVED in the test that pushes it through `assertSubmissionRunId` rather than
  transcribed (see §7).
- **Add** `isLegacyClockRunId(runId): boolean` — a FROZEN migration reader for the retired
  clock-minted form, used only by the adoption rule below. It describes an artefact of the past that
  can no longer change, so it has nothing to drift from; it is never used to mint an id.
- **Delete** `buildRunId`, `formatRunTimestamp`, `pad`. `normalizeRunIdSegment` stays (private), as
  the obligation segment's normalizer and now also the slug cap's home; the digest suffix means the
  id can never end in a trimmed `-`, which is the `assertSubmissionRunId` boundary case.
- **[AMENDED — cap the slug.]** `normalizeRunIdSegment` truncates to
  `RUN_ID_SLUG_MAX_LENGTH` (48) BEFORE the trailing-dash trim: the obligation id is the
  derivation's one unbounded input, and `assertSubmissionRunId` caps the whole id at 128
  characters, so an uncapped slug would mint a run id the shared boundary refuses.
- Keep `getRunPaths`, `ensureSupervisorDirs`, `writeReviewRunFiles` unchanged.

### `src/audit/cli/reviewRun.ts`

- `materializeReviewRun`: derive the id with `deriveReviewRunId` **after** `pendingTasks` is
  computed (the id no longer depends on it; the ordering is what makes that visible), reading the
  wave generation through `resolveWaveGeneration(artifactsDir)` — the counter file plus the run
  directories, never the run ledger.
- **Add** the wave bookkeeping around it: `resolveWaveGeneration` (which generation is open),
  `openedRunIdForGeneration` (the run directory a generation names, found by digest substitution),
  `isWaveClosed` (does that run's own directory say it drained), `countOpenedReviewRuns` (the
  directory-state fallback), `openReviewWave` (persist the counter), and — the writer that gives the
  whole identity a production source — the `wave-closed.json` publish in
  `src/audit/cli/dispatch/hostHandoff.ts`'s `prepareAuditHostHandoff`.
- `resolveReviewRun` + `sameTaskIds` + `sortedTaskIds`: **delete the reuse decision.** With the id
  derived from (obligation × generation), "reuse" and "re-materialize" produce a byte-identical
  manifest at byte-identical paths *for as long as the wave is open*, so the branch has no
  distinguishable behaviour left. The two functions collapse into `materializeReviewRun` plus the
  handoff write.
- **[AMENDED — the upgrade case.] Add the ADOPTION rule.** A run the previous build minted may be in
  flight when this lands: its published workload, every bound `result_path` and its accepted pair
  hang off the OLD id, and workers hold bindings derived from it. When the manifest at
  `dispatch/current-review-run.json` names a LEGACY-CLOCK run id (`isLegacyClockRunId`), that id is
  adopted and the run refreshed IN PLACE at it — the wave drains on the identity it was published
  under, and the next run (once the legacy file is gone) is derived. Serving the old id is preferred
  over migrating, because migrating either strands those workers or needs a cross-run copy of the
  accepted pair — a second durable store for a fact the run directory already holds. The adopted id
  clears `assertSubmissionRunId` before it becomes a directory segment, and `materializeReviewRun`
  takes a `runIdOverride` used by no other caller. The predicate is scoped to the transition by
  construction: it fires on the retired FORMAT, which this build never mints, so it cannot be
  confused with a second audit run's directory (two audits of one repo derive two DIFFERENT ids —
  the run-grain salt — and neither is legacy-shaped).
- ⚠ **Two existing tests state the retired semantics and must be rewritten in the same commit** —
  they are the *test* half of the atomic replace, and they go red the moment the id is derived:
  - `tests/audit/review-run-lifecycle.test.ts` › *"ensureSemanticReviewRunUnlocked reuses a run whose
    pending task identities still match"* — seeds run `SEEDED-RUN` and asserts the pause returns it.
    Replaced by the property that the id is a pure function of the obligation: two pauses over
    **different** pending sets under the same obligation return the **same** run id.
  - `tests/audit/review-run-lifecycle.test.ts` › *"ensureSemanticReviewRunUnlocked replaces a run
    whose pending manifest is stale"* — its premise ("stale manifest ⇒ new id") no longer holds;
    "stale" now means the manifest is rewritten in place. Keep the test as *the manifest is rewritten
    to the current pending set*, drop the run-id assertion.
- `tests/audit/io-remediation.test.ts` imports `buildRunId` and pins its timestamp format — it must
  retarget onto `deriveReviewRunId` (a test file the deletion forces; the only other consumer). The
  retargeted assertions pin the slug's CAP as well as its form.
- **[AMENDED]** `tests/audit/semantic-review-step.test.ts` — `renderSemanticReviewStep` gains a
  REQUIRED `bundle` parameter (see `src/audit/cli/semanticReviewStep.ts` below); its three call
  sites thread the fixture's bundle. A test file the signature change forces.

### `src/audit/cli/dispatch/hostHandoff.ts`

- **Delete the accepted-binding filter** in `prepareAuditHostHandoff`. **[AMENDED — there is no
  `backlogIds`.]** The filter is the `acceptedBindings` set, read inside `withAcceptedResultsLock`;
  no symbol of that name exists, and the design lane's name for it was a fiction. In production it is
  also INERT: `renderSemanticReviewStep` hands prepare only the run's own still-owed partition
  (`buildPendingAuditTasks`), so nothing it could suppress is ever passed in. It is deleted anyway,
  because a boundary whose publish is a function of the caller's partition must publish THAT
  partition: a filter here can only ever turn "the caller says this is owed" into silence.
- **Rewrite the two tests that pin the boundary's silence.**
  `tests/audit/host-handoff.test.ts` › *"publishes every pending task once and ingests only exact
  bound host results"* ended by passing the SETTLED task list and asserting `work_items: []` — a
  caller production never is. It now drives the still-owed partition (an empty one, and a one-item
  re-opened one) and pins the republish, which is the property the boundary actually owns.
  `tests/shared/submission-path-is-tool-owned.test.ts` › *"re-filters an already-satisfied lane out
  of the next prepared workload"* pinned the same retired rule through the shared surface (ingest
  T1, then hand prepare the FULL `["T1","T2"]` list and expect `["T2"]`) and goes red with the
  filter; it is rewritten to hand prepare the owed partition, and then the re-opened one.
- Everything else in the boundary (bindings, identity walk, ledger, ingest) is untouched by this
  design. In particular **the accepted-pair contract does not change**, which is why no ingestion
  check is added or removed and `src/shared/submission/ingestionChecks.ts` needs no edit.

### `src/audit/cli/semanticReviewStep.ts` — [AMENDED]

- **Add a REQUIRED `bundle` parameter**, and derive the completed count from it:
  `completed_tasks: derivePendingTaskPartition(params.bundle).completedTaskIds.size`.
  `tasks.length - handoff.workload.work_items.length` becomes a flat 0 once the filter above is gone
  — it measured how many items the boundary HID, which is now never any — so a run with accepted
  results would report zero completions. The count comes from the ONE pending-set partition instead,
  the same derivation the published task list is projected from. The bundle is threaded from the
  `semantic_review` result variant through the emission fallback in
  `src/audit/cli/nextStepCommand.ts`; the fold already carries it.
- The ingest-issue prose no longer says a re-mint moved the paths: a partial ingest does not re-mint
  anything now, and what still moves a bound path is a changed ASK, which the prose now says.

### `src/audit/cli/statusCommand.ts` — adjacent strand, same change

The "most recent run directory" inference (`readdir(runs/)` → sort by name → last) is only correct
because run ids begin with a UTC timestamp. With a stable id the sort is by obligation slug, so the
command would report an arbitrary obligation's pending count. Replace the scan with a read of the
**active** run: `loadCurrentActiveReviewRun(artifactsDir)` already exists and names the run the loop
is actually on. This is what makes the stable id safe — it removes the only place that read a
timestamp out of the name.

**[AMENDED — status must degrade.]** `loadCurrentActiveReviewRun` THROWS on a manifest that is
present but unreadable or the wrong shape. The old directory scan could not: it swallowed every read
error and reported "no run". So the load AND the manifest read are wrapped, and any failure degrades
to `pending_tasks: null` — which is the same true statement a missing manifest makes, and the only
one a status command is in a position to make. A stack trace out of `audit-code status` tells an
operator nothing they can act on.

### Files explicitly NOT changed

`src/shared/submission/hostHandoffCore.ts`, `src/shared/submission/submissionIdentity.ts`,
`src/shared/submission/ingestionChecks.ts`, `src/audit/cli/nextStepHelpers.ts`, and the
`ActiveReviewRun` schema (`src/audit/contracts/wrapperResponse.ts`) — the persisted manifest's SHAPE
is unchanged, so no contract version bump is needed and no in-flight run is invalidated.

**[AMENDED]** `src/audit/cli/semanticReviewStep.ts` IS changed (a required `bundle` parameter — see
above); it was listed here when the design did not yet touch it. `src/audit/cli/nextStepCommand.ts`
changes by one argument for the same reason.

### Atomic-replace list (one commit)

Introduced: `deriveReviewRunId`, `reviewWaveDigest`, `isLegacyClockRunId`, `openReviewWavePath`,
`reviewWaveClosedPath`, `resolveWaveGeneration`, `openedRunIdForGeneration`, `isWaveClosed`,
`countOpenedReviewRuns`, `openReviewWave`, `RUN_ID_SLUG_MAX_LENGTH`, `RUN_ID_DIGEST_LENGTH`,
`RUN_ID_PREFIX`, `runIdOverride`, the `wave-closed.json` publish inside `prepareAuditHostHandoff`.
Deleted in the same change: `buildRunId`, `formatRunTimestamp`, `pad`, `sameTaskIds`,
`sortedTaskIds`, the accepted-binding filter in `prepareAuditHostHandoff`, and `statusCommand`'s
`readdir(runs/)` name-sort scan. **Never introduced (the fix round's correction):** `loadRunIdentity`
— the run-ledger salt whose only writers were tests; the loop-core read of `run-ledger.json` is
deleted rather than moved, so a malformed ledger no longer throws out of the fold (`statusCommand`'s
own read of it is untouched). Tests rewritten in the same change:
`tests/audit/review-run-lifecycle.test.ts` (the reuse and stale-run tests, whose premise was the
retired rule; the run-grain and partial-ingest tests, retargeted from the run ledger onto the wave
generation), `tests/audit/io-remediation.test.ts` (retargeted off `buildRunId`, then off
`runIdentity`), `tests/audit/host-handoff.test.ts` (the settled-list assertion), and
`tests/shared/submission-path-is-tool-owned.test.ts` (the re-filter assertion). Tests added:
`tests/audit/semantic-review-step.test.ts` (the completed count), `tests/audit/status-command.test.ts`
(the active-run read, the malformed-manifest degradation, the no-run degradation),
`tests/audit/review-run-lifecycle.test.ts` (the wave boundary, the partial-ingest identity, the
cross-wave byte-identical binding, the adoption),
`tests/shared/host-handoff-core.test.ts` (the worst-case derived id, built from the derivation's own
constants).

---

## 6. What the design deliberately does NOT do

- **It does not make a changed ASK survive.** When a task is re-planned (file list, line counts, or
  lens changes), its prompt digest — and therefore its bound path — changes, and a worker still
  answering the old ask is correctly refused. The acceptance's escape clause ("or refused with a
  CLASSIFIED reason") is the behaviour here; today that refusal is the shared `identity_binding`
  diagnostic naming `prompt_sha256`, which is the classified reason.
- **[AMENDED — the acceptance's SECOND disjunct has no reachable case, and no check is added for
  it.]** The acceptance reads "either still accepted (its identity still binds) or refused with a
  CLASSIFIED reason that names the re-mint". The second branch is now empty, by construction rather
  than by omission: **a new wave opens only after the previous wave's pending set is fully
  accepted**, so no worker can still owe a result to a superseded run. The generation advances at
  exactly one moment — `resolveWaveGeneration` reads `closed: true` from the run the counter names —
  and that marker is written only by a publish over an EMPTY owed partition
  (`prepareAuditHostHandoff`, `closed: allWorkItems.length === 0`). Between the two, the run id is a
  constant, so every binding a worker holds is still current and the first disjunct is the one that
  holds.
  The case the second disjunct was written for — a result written into an EARLIER wave's run
  directory — is refused as **`submission_missing`** at the new bound path, and that is correct: the
  ingest reads `result_path` out of THIS run's result map, finds nothing at it, and classifies the
  absence (`scanBoundSubmission`, `src/shared/submission/submissionScan.ts`). It is not silence. No
  ingestion check is added for it: the shared classifier already names the failure, and a check here
  would be a second statement of a fact the boundary already reports.
- **It does not let a host keep writing into a superseded run.** A run directory is still per-run;
  this design does not add cross-run collection at ingest. What it removes is the *unnecessary*
  supersession.
- **[AMENDED] It does not MIGRATE an in-flight clock-minted run — it ADOPTS it.** At resolution,
  when the manifest names a legacy-clock id (`isLegacyClockRunId`), the pause serves that id and
  refreshes the run in place at it rather than moving the wave to the derived id. The rule is
  deliberately one-way and self-liquidating: it fires on a format this build never mints, so once the
  legacy manifest is gone it cannot fire again, and no host instruction is involved in either
  direction. The alternative — carrying the accepted pair forward into the derived run — is a
  cross-run copy of a fact the run directory already holds, which is the durable-store shape the
  `loop-silent-drop` gate refused.
- **[AMENDED — the identity grain is the WAVE, and the salt has a writer.]** It does not make a
  run id derived from the obligation ALONE. The digest is salted with a **wave generation** — a
  counter the tool itself persists at `<artifactsDir>/runs/open-review-wave.json` (written by
  `openReviewWave` in `src/audit/cli/reviewRun.ts`), next to the run directories it counts. The
  earlier draft salted with the run ledger's `run_id`; that file has **no writer in this package**
  (`src/audit/supervisor/runLedger.ts` exports only the loader), so the salt was a constant `null`
  in every production run and two waves of one artifacts dir resolved the SAME id and shared one
  accepted ledger. The ledger read is deleted (`loadRunIdentity` is gone) — and with it the
  malformed-ledger throw that reached the fold.

  **A wave ENDS when its pending set is fully accepted, and the tool now says so.** The publish
  writes `<runDir>/wave-closed.json` (`reviewWaveClosedPath`), carrying `closed: allWorkItems.length
  === 0` — the boundary is the one that HOLDS the run's still-owed partition, so it is the only
  place that can tell "one lane returned" from "the wave is done". `resolveWaveGeneration` reads the
  counter, confirms the run directory it names is on disk (by the digest's own substitution, since
  the digest is a function of the generation alone), and advances to the next generation exactly
  when that run's marker says `closed: true`. So a wave's identity is **immovable while any of its
  work is owed**, and **never carries into the next wave**: two waves never share a run directory,
  and neither do two audits of one repo (the second audit opens a generation the first never had).

  **Where the generation comes from when the record is missing.** The counter is an installation
  record, not the generation itself. An artifacts dir with no counter at all — every pre-generational
  one — reads its generation from the run directories (`countOpenedReviewRuns`), which are always
  present and never pruned. So the two states where the record and the runs disagree are both
  corrected by the same answer: an artifacts dir whose `runs/` was removed wholesale (the counter
  outlived the runs it named) and a `runs/` directory carried across an artifacts-dir RESET (a new
  audit reusing the directory — the runs outlived the counter).

  The consequence, stated plainly: a review obligation's directory is reused across the *rounds of
  one wave* — which is the whole point, and is what makes a partial ingest safe — and is NOT reused
  across sequential waves.
- **[AMENDED] It does not make `audit-code status` a validator.** A manifest the command cannot read
  degrades to "no run", exactly as an absent one does.
- **[AMENDED — the accepted ledger stays an ingest-only input.]** Deleting the filter removes the
  last place `prepareAuditHostHandoff` READ the ledger for a decision. It still takes the lock and
  rewrites the pair inside it (the pair's one writer-side serialization), so a concurrent ingest's
  additions are never replaced by a prepare that snapshotted earlier. The ledger's only remaining
  reader for a decision is the ingest's own dedupe.
- **It does not re-key or extend the accepted-pair contract**, so it needs no ingestion-check
  registry row and no ledger migration. An accepted pair written by the current build loads
  unchanged.
- **It does not touch the remediate draw.** That draw already derives its run id stably; the
  convergence is one-directional and requires no change there.
- **It does not add a persistent store of any kind.** The whole remedy is a derivation change plus
  the deletion of a filter — the reader-side shape the `loop-silent-drop` gate prescribed.

---

## 7. Failing tests (red at HEAD, green once built)

All three reach the production code they name and fail today. Run:
`npx vitest run tests/audit/review-run-lifecycle.test.ts tests/audit/host-handoff.test.ts tests/shared/host-handoff-core.test.ts`

| Test | Red message (verbatim) | Green because |
|---|---|---|
| `tests/audit/review-run-lifecycle.test.ts` › *"a partial ingest keeps every carried-over binding…"* | `a partial ingest must not re-mint the wave's run identity: the worker still writing task-a is holding a binding derived from it: expected '20260911T034432591Z_audit_tasks_compl…' to be '20260911T034432561Z_audit_tasks_compl…'` — the two timestamps are the two clock mints, and they differ **by 30 ms on every run**, which is the defect stated as an assertion | stable derived run id ⇒ stable `result_path` and `prompt.sha256` for the carried-over item |
| `tests/audit/review-run-lifecycle.test.ts` › *"the accepted ledger carries forward across a republication…"* | `an acceptance must not be forgotten by a republication: the set of work items this run has already accepted still names task-b: expected [] to include 'task-b'` | stable run dir ⇒ the accepted pair is still the run's own ledger |
| `tests/audit/host-handoff.test.ts` › *"never withholds a still-pending work item because an earlier acceptance of its binding is on the ledger"* | `a work item that is STILL PENDING must be published even though an earlier binding for it sits on the accepted ledger — the ledger records what arrived, it does not decide what is still owed: expected [] to deeply equal [ 'audit-reopen-a' ]` | the `backlogIds` suppression is deleted |

The second test asserts `accepted_count === 0` and `completed_work_item_ids` containing `task-b` —
the pair that pins *the ledger carried forward* rather than *the file was re-ingested*.

The fourth test (`tests/shared/host-handoff-core.test.ts` › *"accepts every run id the audit draw's
discovery grammar produces"*) is **green at HEAD**: it pins the shared grammar against the derived
form so the two rules cannot drift, and it is reported as such rather than claimed as a red proof.

### Tests the BUILD lane added (amendment items 2–6), each red-proved

| Test | Red proof (verbatim) | Green because |
|---|---|---|
| `tests/audit/review-run-lifecycle.test.ts` › *"two audits of one repository do not share a review run"* | `the derivation is salted with the audit RUN's durable identity: …: expected 'review-audit_tasks_completed-2ebedf20…' not to be 'review-audit_tasks_completed-2ebedf20…'` (salted with `null`) | the digest carries `run_identity` |
| `tests/audit/io-remediation.test.ts` › *"run artifact helpers persist only provider-neutral review identity and canonical pending tasks"* | `expected 424 to be 72` (cap removed from `normalizeRunIdSegment`) | the slug segment is truncated to 48 |
| `tests/audit/review-run-lifecycle.test.ts` › *"ensureSemanticReviewRunUnlocked ADOPTS an in-flight clock-minted run at the derived id"* | `…is ADOPTED, not abandoned: …: expected 'review-audit_tasks_completed-2ebedf20…' to be '20260910T120000000Z_audit_tasks_compl…'` (adoption disabled) | `isLegacyClockRunId` fires and the run is refreshed at its own id |
| `tests/audit/semantic-review-step.test.ts` › *"counts the completed tasks from the pending-set partition, not from what the publish hid"* | `expected +0 to be 1` (the subtraction restored) | the count comes from `completedTaskIds` |
| `tests/audit/status-command.test.ts` › *"cmdStatus degrades to no run when the active review-run manifest is malformed"* | `expected 1 to be +0` (guard removed — the load throws) | the guarded read degrades to `pending_tasks: null` |

The other additions in that list are property pins over behaviour the fixes above already cover
(the run's identity across a partial ingest, the active-vs-newest-directory read, the no-run
degradation), and are reported as such rather than as red proofs.

---

## 8. Questions the refutation lane should attack

1. **Is the obligation the right identity grain?** A run id derived from the obligation alone means
   two *sequential* review waves at the same obligation share one directory and one accepted pair.
   Name the operation that a per-wave directory was protecting, if one exists.
2. **`resolveReviewRun`'s deletion.** Does anything depend on a pause returning a *persisted* run
   object rather than a freshly derived one — ordering, write count, or a lock-hold budget?
3. **The `backlogIds` filter.** It is deleted on the argument that the fresh accepted set is the
   correct suppression set. Find the scenario where the historical set was load-bearing (a
   concurrency window between prepare and ingest, a writer that is not the ingest, a ledger reset
   that re-opens accepted work) — or confirm there is none.
4. **`statusCommand`'s repointing.** Is `loadCurrentActiveReviewRun` reachable on every path the
   command runs (before any run exists; after completion; with a corrupted manifest), and does its
   failure mode read as "no run" rather than as a crash?
5. **Should a *changed ask* be classified as its own refusal?** Today it is `identity_binding` on
   `prompt_sha256`. Is that enough, or does the vocabulary need a re-mint check — and if so, does
   that reopen the `loop-silent-drop` refusal to add a durable store? **Answered by the build lane:
   there is nothing to name a re-mint for.** A re-mint and a wave boundary are now the same event,
   and it is gated on the previous wave being fully accepted — so when a binding changes, what
   changed is the ASK, never the run. The refusal stays `identity_binding`; no re-mint check is
   added, and the `loop-silent-drop` question does not reopen. See §6 for the `submission_missing`
   answer to the cross-wave case the second disjunct would have covered.
6. **Is `sameTaskIds` genuinely dead, or merely unused at HEAD?** If some future re-plan path relies
   on the set-equality rule, deleting it removes a guard rather than a duplication.
7. **The two rewritten lifecycle tests.** Are they truly the test half of an atomic replace, or does
   rewriting them discard a property (`reuse`) that a different caller still needs?
