# Minor open bugs (low severity)

> The LOW-severity tail of [`open-bugs.md`](open-bugs.md), split out 2026-08-28 when that file
> reached its 120,000-byte ceiling and every new entry had to be paid for by condensing another.
>
> Same rules, same lifecycle, same sweeps — this is a size split, not a lower standard. An entry
> here is still a fixable defect that is fixed in tooling and DELETED once it ships. Severity is
> the only thing that decides which file an entry lives in, so re-tagging one moves it.
>
> Part of the split backlog — index: [`docs/backlog.md`](../backlog.md).
> A living to-do list, not a status log. Remove an entry once it ships; record durable
> contracts and rationale in project memory or `CLAUDE.md`, never "where the code is today".

- **The backlog's `friction:` tags are unchecked, and seven of them are not in the canonical
  vocabulary (2026-08-30, low, friction: tool_should_decide).** `FRICTION_CATEGORIES` names exactly
  three — `ambiguous_direction`, `tool_should_decide`, `inefficient_feeding` — and
  `check:friction-categories` only reconciles the generated module against its TypeScript source.
  Nothing reads the tags in `docs/backlog/`, so `false_green`, `false_red`, `hermeticity`,
  `inefficient`, `tool`, `tooling_gap` and `ambiguous` have accumulated there, several of them
  synonyms of each other and of the canonical three. The tag is the field a closeout or a sweep
  would group by, so an unchecked vocabulary makes any such grouping silently incomplete.
  **Property:** a `friction:` tag in the backlog is drawn from the same canonical list the renderer
  uses, and a tag outside it is red.

- **`check:backlog-budget` reports the overage but nothing about what to cut, so satisfying it is a
  guess-and-rerun loop (2026-08-30, low, friction: inefficient_feeding).** Editing one already-near-
  budget entry cost SEVEN full re-runs this lap: the gate prints the entry's total bytes and the
  ceiling, so each attempt is a blind trim followed by a whole-file re-scan, and the last three
  rounds moved 11, 2 and 1 bytes. It already knows the per-entry byte count and the recorded
  baseline, so it can report how much THIS edit added and which of the entry's own paragraphs are
  largest — the two facts that collapse the loop into one edit. **Property:** the refusal carries
  enough to act on in a single pass, not only the fact that a limit was crossed.

- **`question-philosophy-gate` challenges the `/start-lap` approval question, which a skill MANDATES
  and philosophy cannot settle (2026-08-30, low, friction: false_red).** Step 8 of `/start-lap`
  requires ending the turn with a direct request to approve the lap plan. The gate fired on it and
  asked whether a standing conviction already answers it. None can: the question asks for scope
  AUTHORIZATION, not for how to proceed, and the brief it prints is about the latter. The gate is
  self-clearing — it states that a surviving question goes through on a re-ask, and it spends only
  one slot per session — so the cost is one wasted round trip, not a wedge. That is why this is low
  and not medium. **Property:** the gate does not challenge a question whose asking is itself
  required by an invoked skill. The same signal the closeout gate now uses is available here —
  `.claude/lap-start.json` present with no commit at or after the session's `registered_at` is a lap
  that has not begun, and the only question at that boundary is the approval request.

- **Empty repo-root files named backtick and node.id appeared during vitest/build runs, producer
  unlocated (2026-08-29, low, friction: hermeticity).** Both zero bytes, timestamped during
  targeted vitest invocations in a live session, deleted by hand; the suite's added-root-entry
  teardown attributed nothing. The redirect-artifact CLASS is a known durable trap — what is new
  is an apparent in-repo producer during test/build spawns. A lead, not a verdict: watch for
  recurrence before hunting.

- **A refactor that deletes a symbol NAMED in an escalate-only constitutional doc leaves the doc
  citing a dead symbol, and no gate notices the dangling state (2026-08-29, low, friction:
  tool_should_decide).** The frontier unification (`f9c736c8`) deleted
  `dependencyAwaitingClarification`; `spec/remediate/remediation-goals.md` names that symbol as the
  held-pending mechanism. The constitutional-doc gate correctly refused the mechanical rename
  without an owner decision (working as designed), so the spec now cites a symbol absent from the
  tree while the escalation is open — and `check:doc-code-citations` stayed green on it, so nothing
  tracks that the dangling reference exists or that an escalation is pending. **Property:** a
  backticked symbol citation in `spec/**` that resolves to nothing in the tree is surfaced by a
  gate (as a warning or a tracked escalation), so a constitutional doc cannot silently drift from
  the code it measures while an owner decision is outstanding.

- **The release pre-tag CI-green gate fails hard on an IN-FLIGHT run instead of watching it
  (2026-08-29, low, friction: tool_should_decide).** `release:patch:publish` minutes after a push
  died at `ensureCiGreenOnHeadSha` (`scripts/release-and-publish.mjs`) with "no completed run with
  conclusion=success" while both CI runs for that exact SHA were `in_progress`; the recovery was a
  hand-built `gh run watch <id> --exit-status && npm run release:patch:publish` chain — agent prose
  re-implementing a wait the script already knows how to do (its own await-run phase polls a run to
  completion). **Property:** when the gate finds an in-flight run for the HEAD SHA it waits for that
  run's conclusion (bounded, with the existing profile phase) instead of refusing, and refuses only
  on absent or red runs.

- **HANDOFF's hand-written Immediate-next can claim work that already landed, and nothing checks it
  (2026-08-29, low, friction: ambiguous_direction).** The §6 sync-children migration landed
  (`55f9b06d`) with its pinned backlog entry and the HANDOFF Immediate-next unchanged; the next lap
  spent its opening recon re-deriving from `git log` that the named work was already done, and the
  entry's supporting claims had also drifted (one cited call chain never existed at HEAD). The
  generated roadmap block is gate-checked against the backlog pins, but the hand-written
  Immediate-next paragraph and the pinned entry's PROSE are not checked against anything.
  **Property:** a landed fix updates its backlog home in the same stretch that lands it — or a
  gate/challenge surfaces the drift; a hand-written HANDOFF claim naming a specific decided change
  should not survive the closeout of the sprint that shipped that change.

- **A re-entered `commitFold` can still append ONE duplicate `accepted` event when
  `recordLaneOutcome` throws after its durable append (2026-08-28, low).** The resumable commit
  (`69613c68`) drops an entry only after `recordLaneOutcome` RETURNS, and that call is two effects:
  `appendSubmissionEvent`, then the expected-set store mutate (`src/audit/cli/laneSubmissions.ts`).
  A throw between them — the mutate's lock/write failing, or `withFileLock` surfacing a release
  error after success — leaves the entry in `tx.staged`, and the catch-path re-commit re-appends.
  Every mechanical consumer tolerates the duplicate (last-event-per-id, signature dedupe,
  set-membership), so the damage is archived-ledger fidelity; in the same window a second mid-loop
  throw can leave an accepted event recorded with its expected-set drop unrun (the lane lingers
  owed until a later event clears it). The window is untested. **Property:** an `accepted` event
  appends at most once per staged submission across commit re-entries — dedupe-on-append via the
  existing eventSignature machinery, or an entry sub-state recorded between the two effects.

- **The obligation engine's bound doc is off by one against its own comparison (2026-08-28, low).**
  `obligationEngine.ts` documents `maxTransitions` as stopping "after that many consecutive
  transitions"; `if (++transitions > maxTransitions)` fires on N+1. Nothing counts executions
  against the bound, and CX-02 re-specifies the cap on this exact point. **Property:** doc and
  comparison agree, and a test pins which transition stops the loop.

- **The backlog size baseline holds amnesties for entries that no longer exist, and its file ceiling
  never ratchets down (2026-08-27, low).** `docs/backlog/.size-baseline.json` grandfathers two
  `forward-tracks.md` entries — the quota-arbitrage dispatch tier and the Slice-3 heartbeat item —
  that were deleted with the retired execution substrate; `grep` finds neither. A stale amnesty
  never matches, so the dead data is invisible rather than red. The same file caps `open-bugs.md` at
  129,162 bytes against a file well under 90,000, so the gate permits roughly 48% growth before it
  fires. **Property:** an amnesty naming an entry that no longer exists is a red, not a silent
  no-op, and the recorded ceiling follows the file down.

- **`InputResolution` is declared twice, under one name, with two different shapes (2026-08-27,
  low).** `src/remediate/steps/intakeResolver.ts` exports an `InputResolution` carrying `discovered`;
  `src/remediate/steps/nextStep.ts` declares a private one of the same name that has `allExisting`
  and no `discovered`. `RemediateCtx.inputResolution` binds the LOCAL one, so a caller reading the
  exported declaration writes a literal the typechecker rejects — which is how this surfaced, while
  building a ctx for the new priority-coverage contract test. Neither declaration references the
  other, so nothing keeps them in step and the divergence is already real. **Property:** one
  declaration of a name, or two names — the shared shape single-sourced and the per-site extras
  stated as extensions, so a reader cannot pick the wrong one.

- **The release script's await-run timeout (10 min) is shorter than a GitHub `release`-event
  delivery delay it then misreads as "no run" (2026-08-26, low, friction: tool_should_decide).**
  For v0.49.0 the release event fired ~13 minutes after `gh release create`; the script timed out
  at 10 and exited 1 with "no run matched", the operator dispatched recovery runs by hand — and
  then the DELAYED canonical run (32990705280) arrived, went green, and published, turning the
  manual dispatches into harmless collisions (a live `workflow_dispatch` publish is refused from
  a non-`main` ref, and npm refuses publish-over). v0.48.0 triggered within seconds the same
  morning, so the delay is upstream weather, not a workflow defect.
  **Property:** the await-run phase outlasts plausible event-delivery delay (or keeps polling
  with a "still waiting, the tag and release exist — do NOT re-dispatch yet" message), so a slow
  event never reads as a missing one and never invites a duplicate publish attempt. Note: a
  duplicate dispatch can never go green at an already-published version (`npm publish` refuses
  publish-over even under `--dry-run`), so each one parks a permanent red as the workflow's
  latest run; the three v0.49.0 duplicates were deleted (`gh run delete`) so the banner carries
  the canonical green run 32990705280 — their gate/test jobs had each passed, only the refused
  publish step failed.

- **The nightly clean-tree rule does not say which writes it blocks (2026-08-22, low, friction: ambiguous_direction).** `docs/nightly-routine.md` says a dirty tree means the run "applies **nothing**". But the same run must still write its own tracked output — `.audit-tools/nightly/open-items.json`, `docs/nightly-inbox.md`, the leg-3 proposal records, and the regenerated `docs/HANDOFF.md` live-state block, which the commit gate independently REQUIRES to be current. The 2026-08-22 run had to decide for itself that emitting the queue is not an "apply", which is the host-discretion shape the repo bans. **Property:** the rule names the blocked class (doc edits derived from the review) and the always-written class (the routine's own generated output), so no run has to judge it.

- **The backlog triage sweep needs a second manual invocation to reach its real coverage (2026-08-22, low, friction: tool_should_decide).** `scripts/shared/triage-backlog.mjs` errored on 22 of 96 entries in one pass — the lane returned no parseable JSON object, or output that missed the triage schema. Its documented recovery is a plain re-run, which re-queues exactly the failures; that second run recovered 20 of the 22. The recovery works, but it is the operator's to remember, and a run that stops after one pass writes a coverage stamp reporting 74/96 as if that were the ceiling. **Property:** the sweep retries its own transport-level failures within one invocation before writing the stamp, so the stamp reports the coverage the tool can actually reach.
- **No native way to draw a subset of a large findings file into a remediation run (2026-08-22, low, friction: tool_should_decide).** The first draw of the 2,712-finding self-audit (all 40 high + the 3 top-risk medium findings) had to be built outside the tool: a hand-filtered copy fails `work_blocks must project exactly one block per coherence component`, the tool's own `projectAuditFindingsReportSubset` is unreachable from `--input`, and the intent checkpoint's `filters` cannot express 'the findings the top risks name'. **Property:** the operator can name a draw (a severity set and/or finding ids) at intake and the tool projects it with the same function the review gate uses.

- **A transition that ends the call drops the fold's carried advisories (2026-08-22, low).** After e72a06bb, a fold's validation warnings and classified ingest issues survive the result-ingestion transition and reach the NEXT emission within the same `next-step` call — but a transition that ENDS the call still drops them: the carry is fold-local state on the ctx ref and is never persisted, so nothing survives into the next call. Advisory-only (the ledger record is unaffected); what is lost is the prompt statement of what the ledger already recorded. **Property:** every classified ingest issue and validation warning is stated on exactly one emitted step, whichever call emits it.

- **A release version bump trips the path-A seed-drift alarm (2026-08-23, low, friction:
  tool_should_decide).** `package.json` changed only its `version` and the contract pipeline blocked
  until the seed was deleted (option 3). **Property:** drift in a non-finding field never raises the
  alarm, or the alarm carries a one-command "accept this drift" path.

- **The step prompt's "Result status requiring attention" lists MISSING results with the same shape
  as rejections (2026-08-23, low).** A host parser had to special-case "no result file exists".
  **Property:** missing and rejected are distinct machine-readable statuses (or absent items are not
  listed).

- **Dispatch-lane children still answer the Stop "closeout challenge" despite
  `AUDIT_TOOLS_CHILD_SESSION=1` (2026-08-23, low).** Implementer and reviewer children ended with
  "Closeout challenge addressed…" prose; once it displaced a reviewer's final JSON verdict and the host
  had to retry the review. **Property:** the closeout-challenge gate honors the child marker.

- **The phase-boundary repository gate re-runs on EVERY `next-step` at the boundary (2026-08-23,
  low).** `phase_boundary_gate` (build + vitest, 2–5 min) ran on each of several consecutive
  `next-step` calls while the run sat at phase 1. **Property:** the gate runs once per boundary and
  its verdict is cached against the tree hash.

- **Reviewer minors carried from the first-draw landings (2026-08-23, low).** `collectPathARefusals`
  duplicates the promoter's Path-A membership logic and `FINALIZED_MODULE_CONTRACT_FIELDS` is a third
  hand-written field list beside `derive.ts` (`src/remediate/contractPipeline/`); `renderMembers`'
  `includeBodies` knob in `scripts/shared/generate-filelock-export-surface.mjs` is a no-op;
  `hostHandoffCore.ts` exports `idsAreUnique`/`absoluteHostHandoffResultPath` with no production
  caller and `resultPathFor` in the remediate adapter re-derives `runDir` by slicing the workload path.
  **Property:** each is pinned or deleted; none blocks.

- **The friction close-out walk must be written twice under two different names (2026-08-21, low, friction: tool_should_decide).** The Stop backstop (`.claude/hooks/friction-stop-gate.mjs`) scans every `*.json` under `<artifacts>/friction` and accepts the run-id-keyed record, while the close step demands the walk specifically at `<artifacts>/friction/run.json`. A complete walk recorded against the real run id satisfies the backstop and still leaves the close gate reporting all three categories MISSING. **Property:** one run has one friction record path, and both gates read it.

- **Acquisition of `actionlint` fails on extract (2026-08-21, low).** `external_analyzer_acquisition.json` recorded `actionlint` as `not_resolved` with `extract failed: tar exit 128`, so the workflow linter silently never ran although `.github/workflows` exists. **Property:** a tool that resolves and then fails to unpack is distinguishable from one that is not applicable to the repo.

- **Writing the nightly queue desyncs HANDOFF's generated live-status block (2026-08-20, low,
  friction: tool_should_decide).** The block derives from the queue and the decision ledger, but the
  nightly run contract does not list regenerating it as a run step, so the desync is caught only
  afterwards by the Stop closeout gate (hit and repaired 2026-08-20 via
  `node scripts/shared/generate-handoff-roadmap.mjs`). **Property:** a run that writes the queue leaves
  `check:handoff-roadmap` green — the regeneration belongs to `writeOpenItems` or the run contract,
  not to the operator noticing.

- **recover-ingest / recover-submission leave the last step contract on disk after mutating state
  (2026-08-19, low).** A recovery that resolves items (or clears `host_handoff`) leaves the last
  persisted step contract and prompt document — current-step.json plus current-prompt.md — as a
  live-looking instruction for work that no longer exists; next-step has
  `runWithBlockedStepBackstop` for the class. **Property:** any verb that mutates run state either
  refreshes or invalidates the persisted step contract.

- **`StateStore.mutate` cannot skip the write — a no-op recovery rewrites an identical state file
  (2026-08-19, low).** The locked store's `SKIP_WRITE` sentinel (`lockedJsonStore.ts`) is not
  plumbed through `StateStore.mutate`, so a nothing-to-recover run still replaces the file.
  **Property:** a mutation that returns the input unchanged writes nothing.

- **Recovery phase-binding residuals from the adversarial review (2026-08-19, low, one entry —
  three verified residuals):** (1) the two recovery phases are bound by HEAD, not state identity —
  a concurrent state writer between phases yields a spurious `required_test_failed` (safe
  degradation: refuse, never spawn, never accept); the symmetric fix is comparing the phase-1
  pending-id set / workload sha like HEAD is compared. (2) `recovery.requiredTestVerdicts` enforces
  table-SUPPLIED, not tests-RAN — an untyped JS caller can fabricate a table; a `typeof` narrow
  and/or minting the table type from `precomputeRecoveryTestVerdicts` would close it. (3)
  `gitCommitIsOrphaned` cannot see a detached HEAD in a LINKED worktree (`for-each-ref` does not
  enumerate it) — such a baseline misreports orphaned. All three documented in code comments at the
  guard sites.

- **recover-ingest's commander action branch is untested (2026-08-19, low).** The entry-point test
  reaches `recoverIngestHostResults`; `recoveredNothing`, the two `process.exit(1)` sites, and
  `resolveArtifactsDirOption` are covered only by a manual smoke log.

- **CP-NODE-10 residuals (2026-08-19, low, one entry):** (1) the staleness third-state (`partial`)
  check exempts the 9 map-declared leaves — including `audit-findings.json` — so a truncated leaf
  body is caught only via dependents (choice-vs-forced split documented at
  `classifyArtifactPresence`); (2) `StaleArtifactSet`'s `instanceof` discriminator is dropped by
  `Set.prototype.union`/`structuredClone` (no caller does either today); (3)
  `computeArtifactMetadata`'s producer-side affinity hash is unguarded — a malformed affinity body
  dies loudly at restamp (pre-existing, loud, not a livelock).

- **recover-ingest exits 1 when the only issues are `submission_missing` for genuinely-pending
  work items (2026-08-19, low).** An expected-pending item is not a recovery failure; the exit
  code should distinguish expected-pending from a real issue so operators can script on it.

- **The citation gate's verdict depends on transient untracked files (2026-08-19, low, friction:
  tool_should_decide).** The resolution universe deliberately includes untracked non-ignored files
  (staged-new files must resolve), but the bare-name EXTENSION-SKIP set is built from that same
  universe — so an untracked scratch log at the repo root added a new extension to the set and
  flipped an unrelated durable-traps doc line from skipped to failing: the release gate refused a
  tree whose identical docs had passed the commit gate minutes earlier. **Property:** the
  extension-skip set (and any rule that widens/narrows what gets CHECKED) derives from tracked +
  staged files only; untracked files may join the resolution universe as targets but must not
  change which citations are examined. [[a-gate-must-not-ask-the-local-disk]]

- **`writeOpenItems` accepts an item with no `subject_key` and persists it; the refusal lands two
  steps later in the HANDOFF generator (2026-08-14, re-hit 2026-08-19, low, friction:
  tool_should_decide).** `scripts/nightly/items.mjs` consumes `item.subject_key` for carry-forward
  and settled-lookup, and the writer validates probes exhaustively — four distinct refusals — yet
  never checks the field the whole durable-answer mechanism keys on. A missing `subject_key` is
  written to `.audit-tools/nightly/open-items.json`, and only `generate-handoff-roadmap.mjs` refuses
  it, as a BLOCKED COMMIT naming `items[N]` and HANDOFF rather than the item that is malformed. The
  writer already imports `subjectKey`, and every item carries the `subject` it is computed from.
  **Property:** the writer that reads a field either derives it or refuses at write, so the refusal
  names the real defect where it is introduced ([[validator-guards-every-field-caller-reads]]); a
  persisted item missing it is unreachable for [[settled-subject-slips-through-a-reword]] and cannot
  be re-asked correctly.

- **Modularity refinement is superlinear on one large component and unpinned at scale (2026-08-19,
  low).** Measured 78ms at 200 members → 726ms at 800, with Louvain's pass bound at `n + 8`; the
  promoted run's largest component was 33, so nothing exercises the tail. **Property:** refinement
  cost on the largest single component is bounded by a test, or the partition has a latent stall on a
  repo that produces one big eligible component.

- **The HANDOFF empty-queue projection contract is full-suite-only, so the commit gates pass a red
  against it (2026-08-18, low, friction; BIT 2026-08-27 — burned tag v0.50.0: a hand-written
  live-state edit using the word the contract bans passed every commit gate and failed only in the
  release run's test shard, exactly as this entry predicted).** `handoff-roadmap.test.ts`'s live-tree case (an empty
  nightly queue leaves no hand-written "nightly" text in HANDOFF) is not run by the staged-triggered
  `check:handoff-roadmap` leg — a HANDOFF edit landed through a green pre-commit gate and green
  targeted suites, and only a voluntary full-suite run caught it before push. **Property:** every
  live-tree doc contract either runs in the gate leg that its trigger paths fire, or the gap is a
  declared `uncovered` in guard-reach — never discoverable only by the full suite.

- **Diff-based re-review loses the verdict it must diff against (2026-08-08, low).** Repairing
  `finalized_module_contracts` deletes `conceptual_design_critique.*` as stale, then the re-review step
  says "diff against your prior verdict" — which survives only as prose in the step prompt, unreadable
  to the independent reviewer that step demands. **Property:** an artifact a step tells the host to diff
  against is readable when that step runs.

- **`free_form_intent` clause splitter shreds prose on bare `;` (2026-08-08, low).** Splits inside
  parentheticals and `(a) …; (b) …` lists, so fragments are unencodable *because* they are fragments.
  **Property:** split on sentence boundaries; report a count plus pointer, not shredded prose.

- **Answering an intake question at the checkpoint does not clear `open_questions` (2026-08-08, low).**
  `decideNextStep` gates on `intake-summary.json` (`ready` + `open_questions[]`), so resolving at
  `confirm_intent` still routes to `collect_intake_clarifications` until the host edits the summary.
  **Property:** resolved at the checkpoint is resolved everywhere, or confirm names the gate's input.

- **Regex-perf triage tail from the analyzer sweep (2026-08-07, low).** The verified-real subset of the
  sonarjs regex findings — six sites processing unbounded audited-repo content — needs per-pattern
  backtracking analysis (atomic groups / restructuring where real); the rest of the family was verified
  false-positive. Sites and triage in
  [`reviews/analysis-tools-plan-2026-08-07.md`](../reviews/analysis-tools-plan-2026-08-07.md) §4/§5.
  **Property:** no regex over audited-repo content is super-linear on adversarial input.

- **Contract-type coverage is derived from where TESTS live, not from the contract (2026-07-25, low,
  friction: inefficient-feeding).** `scripts/` was covered by no tsconfig at the time (closed
  2026-08-26 — `check:scripts` now typechecks it), so a producer there could not fail
  on a contract it never consulted — that is how adding `reviewed_clean` swept `tests/**`, missed the
  `scripts/` producers, and failed release CI ([[lap-green-must-match-ci-evidence]]). AuditResult is
  closed by a per-type gate written by hand for it. **Property:** for every validated contract type, the
  set of construction sites is derivable FROM THE CONTRACT, not from test placement. Not yet designed —
  the doc-manifest data+refusal shape (`2adc716c`) is the precedent to follow, and a typecheck gate is
  NOT (a cast makes it inert, [[test-tree-typecheck-gate-and-its-cost]]).

- **A deletion of a manifest-listed doc landed with the doc-manifest gate red (2026-08-26, low,
  <!-- doc-citation-exempt: the deleted file IS the subject — it no longer exists by design -->
  friction: tool-should-decide).** `a56f274d` deleted `GEMINI.md` and committed clean, leaving
  `check:doc-manifest` red on HEAD (plus a stale citation in a generated render) until `2a1faa1f` —
  the fails-only-in-release-CI class the pre-commit reach leg exists to stop. Unestablished which
  half failed: the reach leg not triggering on a staged DELETION, or the committing session running
  no hooks at all — establish that before designing a fix. **Property:** a staged deletion of a
  manifest-listed doc trips the manifest gate exactly as an edit does, whichever session commits.

- **DD-9 + charter slice-staleness — residual only, revisit on live evidence (2026-07-23, low,
  accepted).** The pair SHIPPED; its mechanism record is the single home —
  [`intent-gate-charter-slice-design-2026-07-23.md`](../reviews/intent-gate-charter-slice-design-2026-07-23.md).
  Accepted residuals:
  (a) over-stale: `charter_clarification` / `systemic_challenge` keep WHOLE-ARTIFACT
  `repo_manifest` edges (`dependencyMap.ts`; `DEPENDENCY_SLICE_PROJECTIONS` registers
  `charter_register.json` alone) — a member slice was REFUTED for challenge at HEAD (it consumes the
  total file count and grounds against the complete path set) and clarification's consumption is
  unverified; they still re-fire on unrelated manifest churn (cheap steps). Slicing them needs a
  verified consumption trace first. (b) under-stale, and NARROWER than the first draft of this entry
  claimed: `charterReadFileSlice` compares content for consensus members ∪ every `isDocIntentFile`
  path (`doc_only` status **OR** `.md/.markdown/.adoc/.rst/.txt` — single-sourced at
  `buildStructureDecomposition.ts` so it can never be narrower than the decomposition's own doc
  universe; pinned by `tests/audit/dependency-slices.test.ts`), PLUS the complete sorted path list,
  so every add / delete / rename fires regardless of classification. What stays outside is a
  content-only edit to a file that is neither a consensus member nor doc-extensioned nor `doc_only`
  — e.g. spec prose living inside a `.ts` the Stated pass reads. Widen `charterReadFileSlice` if a
  live run shows it. (c) over-cost: a revert pair (intent A→B judged, then B→A) re-pays one judge
  round — verdicts are materialized into the baseline (`intentEquivalenceExecutor.ts`), never cached
  per-pair.

- **A spec row's category prefix is load-bearing enough to manufacture work — and one was false
  (2026-07-28, low, RESOLVED; the open half is the class).** `spec/audit/artifact-contract.md` gave a
  TRANSIENT host submission (`intent-equivalence-verdict.json`) the same `Durable host input:` prefix as <!-- doc-citation-exempt: transient host submission, written and deleted at runtime -->
  a registered staleness-DAG leaf, so nightly `docs-3` correctly inferred "register it for consistency"
  and collided with DD-9's deliberate no-verdict-pair-cache retirement. Fixed by relabelling the row and
  making the durable row state its registry+DAG membership explicitly; endpoint traces in
  `docs/reviews/intent-equivalence-verdict-endpoint-trace-2026-07-28.md`.
  **Open property (the class, not this instance):** a category prefix in a normative table is read as
  a contract, so two files sharing one must share its lifecycle. Nothing enforces that. Worth a check
  only if a second instance appears — one occurrence is not yet a pattern.

- **⬇ Live-run watch (re-dogfood 2026-07-22, low, medium-difficulty — an ATTEMPTED fix was reverted 2026-07-25):
  completion cleanup removes the friction dir before the session stop-gate's close-out walk runs
  against it.** Ordering property: the close-out walk is part of run completion — cleanup preserves
  (or the close step completes) the friction record before archiving. Record:
  [`re-dogfood-friction-2026-07-22.md`](../reviews/re-dogfood-friction-2026-07-22.md) #13.
  ⚠ **Three findings from the reverted attempt — a naive "exempt friction/ from the rm" does NOT work
  and introduces a regression.** (1) The audit half's completion cleanup is `promoteFinalAuditReport`
  (`src/audit/io/artifacts.ts`, called only from `nextStepHelpers.ts`), NOT
  `cleanupStaleArtifactsDir` — the latter runs at the START of
  the next advance, so patching it changes nothing at completion. (2) The remediate half's stop-gate is
  MARKER-gated: `.claude/hooks/friction-stop-gate.mjs` requires a recent `state.json` before it reads
  `.audit-tools/audit/friction/` at all, and a fully-green close deletes `state.json` — so preserving the record alone
  still leaves the gate skipping the area. (3) Preserving `.audit-tools/audit/friction/` across cleanups REGRESSES the
  audit side, where the run id is the hardcoded literal `"run"` (`nextStepHelpers.ts`,
  `executorRunners.ts`, `operatorHandoff.ts`): every run shares one `friction/run.json`, so a
  prior run's complete record permanently satisfies both the blocking close-out and the hook's
  `anyComplete` check. A real fix must address the run-id collision first.

- **LEAD (re-dogfood): systemic-challenge round counter + banked improvements carry across RUNS
  (2026-07-21, low).** This run's challenge arrived as "round 10" with 11 prior improvements from
  earlier sessions' artifacts. Verify intended (cross-run loop state vs per-run reset). Record:
  [`re-dogfood-2026-07-21.md`](../reviews/re-dogfood-2026-07-21.md).

- **A stale-artifact re-extraction `next-step` runs >2min with no progress signal, silently blowing a caller timeout (live dogfood 2026-07-17, inefficient-feeding, low).** After the design-review passes, the drain re-extracting 11 stale artifacts (repo_manifest/graph over 1250 components / 8466 edges, invalidated by a docs commit) exceeded a 2-minute command timeout with no heartbeat — forcing a blind retry at a longer timeout to see if it was wedged or working. Property to hold: a long deterministic drain should emit a progress/phase heartbeat so a caller can distinguish "working" from "wedged" without a retry. Minor; the retry succeeded.

- **Auditor severity calibration: 0 of 9 self-audit criticals survived mechanism verification
  (2026-08-06, lead, low).** 3 refuted / 6 downgraded — record in
  [`reviews/dogfood-run-2026-08-06.md`](../reviews/dogfood-run-2026-08-06.md). Open question:
  should synthesis demand mechanism-grounded (not flow-existence) evidence for `critical`?

- **remediate-code step prompts drift from the validators that read their output (2026-08-19, low,
  friction: tool_should_decide).** Remaining instance (the `confirm_intent` `excluded_scope` shape
  is closed by P40's contract test, 2026-08-23; the `created_at` claim was REFUTED — the tool stamps
  it, so the sketches omit it correctly): the `synthesize_intake` prompt mandates checkpoint fields
  (`pre_draft_questions`, `closing_action`, `intent_interpretation`) the `.strict()`
  `IntentCheckpointSchema` does not admit, and the checkpoint read path is an unvalidated cast
  (`readOptionalJsonFile<IntentCheckpoint>` in `src/remediate/steps/nextStep.ts`) so prose strings
  crash `normalize()` deep in path matching. **Property:** a step prompt's schema sketch is derived
  from the same contract its reader enforces, and the checkpoint read path validates before use
  instead of casting.

- **The commit gate's doc-contract leg did not run check:doc-code-citations for a staged
  docs/backlog/durable-traps.md (2026-08-19, low) — verified NOT a trigger-set gap; the underlying
  premise dissolves on inspection.** `check:doc-code-citations` was reported red repo-wide over
  durable-traps.md's bare `` `server.log` `` citation. Re-run at HEAD: exits 0, "every one
  resolves" — and `git ls-tree` at the cited landing commit (`e38616f9`) shows no tracked `.log`
  file there either, so the bare-name rule's `trackedExtensions.has(ext)` guard has silently
  skipped this token all along, never failed it. That skip is not a fresh gap: it's the uncovered
  half `scripts/guard-reach-data.mjs`'s `check:doc-code-citations` row already states verbatim
  ("bare names whose extension no tracked file uses go unchecked"), and the row's `preCommit:
  'reach'` already unions `**/*.md` — so the doc-contract leg's trigger set does cover
  durable-traps.md; nothing narrower is in play. The separate, real 2026-08-19 incident (a stale
  glossary-ids.md citation invisible because it was never backticked) is already fixed by `fe48db4c`.
  The reworded token (this batch) sidesteps the loophole rather than leaving it live.
  **Property:** the extension-skip rule exists to exclude non-file tokens (`vi.spyOn`,
  `claude.exe`) but also hides genuinely file-shaped non-repo mentions like `server.log` — open
  question for the owner is whether that trade stays accepted as-is (reword such tokens out of
  backticks, as done here) or the rule should distinguish "no plausible non-file reading" before
  skipping; no trigger-set widening is needed either way.

- **On remediate the fully-green close walks a different friction record than the run wrote
  (2026-08-23, low).** `stateRunId` keys the record on `state.plan.plan_id`, falling back to
  `"run"` when the plan is absent — and a fully-green close DELETES the state after
  `runClosePhase` has archived every friction record and `rm -r`'d the whole artifacts dir, so
  `decideRemediateFrictionCloseout` does not merely read a different existing file: it
  materializes a fresh empty `friction/run.json` inside the just-deleted dir, in place of the
  plan-keyed record the run actually wrote. The by-reference join on `step_run_ids` /
  `dispatch_run_ids` cannot bridge it: the fallback record is materialized with both reference
  arrays empty, and an empty query matches nothing. The audit half of this class is closed — its
  fixed-literal key accumulates every round's review and dispatch run id. **Property to hold:** the record a
  run writes friction to is the record its close-out reads, whatever the state's lifecycle did in
  between.

- **A dated measurement sits inside durable routine prose (2026-08-23, low).**
  `docs/nightly-routine.md` and `docs/backlog.md` both carry the
  same "a 2026-07-19 pass found ~21% of entries stale or already closed" as the motivation for the
  re-check-at-presentation rule. The rule is durable; the measured share and its date are a status
  reading pinned into a concept doc, and it rots silently in three places at once. **Property to
  hold:** a concept doc states the invariant, and the measurement that motivated it lives in the
  review record or `git log`, in one place.

- **The repo-root artifacts have a mechanism and no producer (2026-08-24, low, friction:
  hermeticity).** Four so far — `o.testId)`, `60s`, `0)`, `entry.tool` — all empty and untracked, so
  a routine `git add -A` would commit them and no content-based clean-tree check ever sees them.
  Mechanism confirmed by reproduction: a command STRING reaching `cmd.exe` redirects at any `>` in
  the line — quoted source included — and ends the target token at whitespace, `;`, `,` or `=`, so
  `.map((o) => o.testId);` writes `o.testId)` and prose reading `the >60s blocking worker` writes
  `60s`. The `tests/remediate`+`tests/shared` sweep is NOT the producer: an instrumented run logging
  every `child_process` entry point saw 6,496 spawns, none carrying `>`, and left both checkout
  roots unchanged. Teardown now fails a run that ADDED a root entry it does not own, or that still
  owns a live child, naming either (`tests/helpers/global-setup.ts`, ledger in
  `tests/helpers/trackedSpawn.ts`). **Still open:** the producer is unnamed, and it is outside both
  checks — they bound what a vitest run can leave, not what an agent lane can. Measurement in
  project memory (memory: repo-root-empty-files-are-shell-redirect-artifacts). Producer lead
  (2026-08-27 lap): nine more appeared, each materializing DURING a codex-exec or delegated-agent
  run — one timestamped mid-run by the lane that saw it appear. Codex 0.150.0 runs its shell as
  `pwsh.exe -Command "<string>"` (observed in its transcripts), which is exactly the
  command-STRING surface the reproduction names, so the leading suspect is codex-exec's quoted
  command strings; unconfirmed by instrumentation.

- **The remediate loader pair restates what the audit pair now single-sources (2026-08-23, low).**
  `skills/remediate-code/SKILL.md` and `skills/remediate-code/remediate-code.prompt.md` each state
  the `--input` / `--guidance-file` argument-preservation rule, and the "Read the returned JSON only
  far enough…" paragraph is verbatim in ALL FOUR loader assets (both pairs) — the same two-copies
  shape the audit `--root` statement was collapsed out of, and all of them ship (`skills/**`), so an
  npm reader sees each copy as authoritative. **Property to hold:** across a loader pair, each instruction has
  one full statement and the other asset points at it, mechanically pinned rather than remembered.

- **The release-gate gloss table is required by a gate and rendered by no consumer (2026-08-27, from the philosophy audit, low).** `scripts/gate-enumeration-data.mjs` holds `STEP_GLOSS`, one human description per gate step, and `scripts/check-gate-enumeration.mjs` fails the build when a step has no gloss — but the single registered target renders step NAMES alone, so no gloss text reaches any reader. The descriptions are write-only data that every new gate step must pay for. **Property:** a human description is held only where a named consumer renders it; otherwise the presence requirement is dropped and the enumeration derives from the executable step list alone, or the shipping doc invokes that list directly instead of restating it. The adjacent guard-reach claim — that the `GUARDS` identity and wiring fields in `scripts/guard-reach-data.mjs` are recoverable from `package.json`, `.claude/settings.json` and the tracked tree — is NOT established here: those declared fields are what makes the reconciliation bidirectional, so deriving them would weaken the check that a new guard cannot land outside the registry. Establish that before deleting a field. [[write-only-data-looks-authoritative]]

- **HANDOFF's hand-written region and the closeout both re-narrate state the repository already holds (2026-08-27, from the philosophy audit, low).** `HANDWRITTEN_CREEP_RULES` in `scripts/shared/generate-handoff-roadmap.mjs` matches five narrative shapes and declares its uncovered half in `scripts/guard-reach-data.mjs` — but the uncovered half is any novel phrasing, so multi-commit consolidation narrative and repair history still pass into the live-state block that `docs/HANDOFF.md` declares to be immediate state only, and a human reading is what catches them. Separately, the session registry written by `.claude/hooks/session-start-guards.mjs` records a registration time and a tree-dirt baseline but no starting HEAD, so the closeout's commits, changed documents, cleanliness and pushed state stay author-supplied when they are derivable. **Property:** the generated projection covers every mechanically derivable fact and the hand-written region admits only what is not derivable, with the boundary enforced by what the projection already owns rather than by phrasing heuristics; author input is required only for verification claims absent from a trusted run record, deliberate intermediate state, friction and owner decisions. A tracked projection must not depend on a live registry query — `scripts/release-and-publish.mjs` shows registry observation is network- and latency-prone, so published availability is rendered best-effort at display time, never committed as canonical state.

- **Three governance vocabularies are copied per consumer instead of shared (2026-08-27, from the philosophy audit, low).** The friction taxonomy exists as three independent literals — the production tuple in `src/shared/friction/frictionRecord.ts`, an array in `.claude/hooks/friction-stop-gate.mjs`, and prose keys in `scripts/closeout-sections-data.mjs` — so a new category reaches one consumer and not the others. The host memory directory is derived twice with DIFFERENT rules: `scripts/check-memory-citations.mjs` replaces every non-alphanumeric character, `.claude/hooks/closeout-challenge-gate.mjs` replaces only colons and slashes; they agree on this repository's path and diverge on any path carrying other punctuation, and the failure mode is a silently empty directory rather than an error. `scripts/audit/postinstall.mjs` and `scripts/remediate/postinstall.mjs` separately implement wildcard migration and OpenCode configuration around the same shared installer — the V3 residual entry's migration gap is one instance of that split, not its cause. **Property:** each vocabulary and each derived path lives in one pre-build data module that TypeScript, hooks and scripts adapt to, and the two installers execute one declared host-asset plan whose per-tool differences are rows rather than code. The nightly-state half of this finding is spent: `scripts/nightly/answer.mjs`, `scripts/nightly/render-inbox.mjs`, `.claude/hooks/nightly-surface.mjs` and `scripts/shared/generate-handoff-roadmap.mjs` all already read `scripts/nightly/items.mjs`.

- **A pipeline warning names an internal record id as its resolution action (2026-08-27, from the philosophy audit, low).** `src/remediate/validation/contractPipelineGates.ts` emits "route to N-R21 for resolution" when it detects a circular interface-definition dependency. The issue is advisory — it is appended to the critic prompt rather than blocking — and `N-R21` is a design-record id in `docs/glossary-ids.md`, not a verb the pipeline implements, so the one reader that sees the message is told to consult a record it cannot resolve. Two neighbours are cosmetic beside it: `N-X06` survives only in comments and the glossary, and the dissolved `N-R13` document phase survives as a family name across `src/remediate/steps/nextStep.ts`, `spec/remediate/remediation-goals.md` and a test filename. **Property:** a message that reaches a prompt or an operator names the diagnostic and the action to take, never an internal record id; and a historical id that outlives the thing it named is renamed to what the code now does, atomically across producer, prompt and tests.

- **`check:memory-citations` gates two of the three citation directions, and its guard-reach row
  names the wrong uncovered half (2026-08-27, low, friction: tool_should_decide).**
  `scripts/check-memory-citations.mjs` resolves `memory: <name>` citations found in tracked docs, and
  also `[[name]]` cross-links between notes. The third direction — a memory note citing a repo PATH —
  is scanned by nothing: the store lives outside the tree, so no doc gate reaches it, and the script
  reads notes only for wikilinks. A scan of the store at entry time found dozens of cited
  `docs`/`src`/`spec`/`scripts`/`tests` paths that do not resolve at HEAD. Most are deliberate
  archaeology — a note whose whole point is that a subsystem was deleted — but not all:
  [[nightly-maintenance-routine]] presents an HTML digest renderer and a localhost review server as
  live surfaces when `scripts/nightly/render-inbox.mjs` records having REPLACED both, and
  [[a-gate-must-not-ask-the-local-disk]] pins its fix to a contract test under a pre-conversion `.mjs`
  name. That is the failure the script's own header describes, pointing the other way: a pointer
  nobody can follow re-asserting a retired design with the authority of a citation. Separately,
  `scripts/guard-reach-data.mjs`'s row for this gate still declares the `[[name]]` half uncovered,
  which the script now covers, and says nothing about the path direction — the registry is meant to be
  the authoritative statement of reach, so it overstates a gap it closed while hiding one it has not.
  **Property:** every repo path a memory note cites either resolves at HEAD or is explicitly marked
  retired-subsystem archaeology, and the guard-reach row states the direction that is actually
  uncovered. Any mechanism must absorb the archaeology class without a false red — an exemption marker
  of the kind the doc gates already use, never a bare existence check. Triage record for the prune
  that raised this: [`memory-cut-list-2026-08-25.md`](../reviews/memory-cut-list-2026-08-25.md).

- **`buildToolingManifest`'s dist walk is a TOCTOU against a concurrent rebuild (2026-08-28, low,
  friction: tooling_gap).** `src/audit/io/toolingManifest.ts` lists the package `dist/` tree and
  then hashes each listed file; a file that disappears between the listing and the read (a `tsc`
  re-emit racing a parallel vitest run, or a stale incremental dist) throws a bare
  `ENOENT: ... .d.ts.map` out of `loadArtifactBundle`, so unrelated fold tests fail with a message
  that points at the manifest hasher instead of the race. Hit twice this lap; a solo re-run after a
  clean rebuild was green both times. **Property:** the walk either snapshots list+read atomically
  per file (skip-on-ENOENT with the skip recorded in the hash input) or the failure names the
  actual condition — "dist changed during the walk; rebuild and re-run" — never a bare ENOENT from
  an internal path.

