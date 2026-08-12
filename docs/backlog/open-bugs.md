# Open bugs & frictions

> Fixable defects and friction. Fix in tooling — never "the host remembers".
>
> Part of the split backlog — index: [`docs/backlog.md`](../backlog.md).
> A living to-do list, not a status log. Remove an entry once it ships; record durable
> contracts and rationale in project memory or `CLAUDE.md`, never "where the code is today".

- **`shell-trap-guard` misses `git stash push <pathspec>` eating uncommitted work (2026-08-12, medium).**
  The guard DENIES a `git checkout --`/`git restore` that would eat unstaged edits, but a pathspec'd
  `stash push` removes them just as silently (hit live: it swept a 200k-line uncommitted retirement
  edit of the named file into the stash; recovered by `stash pop`). **Property:** any git verb that
  removes unstaged edits from the working tree gets the same deny-once as `checkout --`/`restore`.

- **Contract-pipeline fan-out names a mechanism the host may not have (2026-08-08, medium).**
  `module_contract_drafting` says "dispatch ONE sub-agent PER MODULE"; where in-process subagents are
  unavailable the only route is a shell-out lane the tool neither knows nor sizes for (2 of 9 such
  dispatches died mid-output; only the step's presence check caught it). **Property:** a fan-out step
  states what it NEEDS (N independent contexts, no shared authorship), not a mechanism; an
  absent-after-dispatch shard reports as TRANSPORT failure, not a refusal. Uncovered half: nothing
  carries the Stop-gate kill-switches into a shell-out child, so it hangs.

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

- **Sweep the test tree for tests that re-implement their subject (2026-08-08, medium).** One live
  instance found and fixed in `c791df49` (see git log). **Why no gate catches it:** such a test is
  green, typechecks, has no unused exports, and coverage counts the replica's lines — knip, eslint and
  the red-green rule all pass a test that pins nothing. **The tell:** a function declared in a test file
  that mirrors production control flow (a `for` over step kinds, a switch over cases) instead of calling
  into `src/`. **Property:** every test either calls production code or is deleted; where a replica
  exists because the subject is undrivable, fix the *untestability* (inject the dependency), not the
  test. Scope: `tests/**`, starting with the harness-heavy audit suites. [[test-must-reach-the-code-it-claims]]

- **Regex-perf triage tail from the analyzer sweep (2026-08-07, low).** The verified-real subset of the
  sonarjs regex findings — six sites processing unbounded audited-repo content — needs per-pattern
  backtracking analysis (atomic groups / restructuring where real); the rest of the family was verified
  false-positive. Sites and triage in
  [`reviews/analysis-tools-plan-2026-08-07.md`](../reviews/analysis-tools-plan-2026-08-07.md) §4/§5.
  **Property:** no regex over audited-repo content is super-linear on adversarial input.

- **`ensureCleanWorktree` blocks a release on sibling UNTRACKED files (2026-08-07, low, friction).**
  Bare `git status --porcelain` counts `??` rows, so owner-run Codex tooling's analyzer droppings at
  repo root refused `release:patch:publish` from the primary checkout; the sanctioned lap-worktree
  release path worked unchanged. **Property:** the guard should refuse on tracked dirt (the thing a
  release could actually absorb) and at most WARN on untracked files — npm pack ships by allowlist
  and the bump commit stages only package.json/package-lock.

- **Vitest worker RPC starvation — the false-RED exit is CLOSED at the gate; the >60s blocking
  worker is unlocated (recharacterized 2026-08-07; was "full-suite exits 1 while every test
  passes", 2026-08-06).** The exit-code half is a non-issue through the sanctioned path:
  `npm test`/CI route through `scripts/shared/run-vitest-gate.mjs` (since `605fe61e`), which converts
  exit-1 + 0-failed + the `[vitest-worker]: Timeout calling "onTaskUpdate"` stderr marker into a loud
  PASS — the 2026-08-06 red exits were raw `npx vitest run` invocations that bypass it. What stays open
  is the starvation itself: the worker-side birpc reply timeout is a hard 60s
  (`rpc.-pEldfrD.js` onTimeoutError), so the error means ONE continuous ≥60s sync stretch in some
  worker. `audit-code-completion.test.ts` is ruled out as sole cause — a solo run does not reproduce and
  an event-loop stall probe recorded ZERO stalls during a full run in which the error fired. Candidate
  sweep: [`reviews/rpc-starvation-candidates-2026-08-07.md`](../reviews/rpc-starvation-candidates-2026-08-07.md)
  — its one confirmed instance (sync full-CLI `next-step` children in
  `next-step-pipeline-dispatch.test.ts`) was converted to async spawn; gate-script spawns in
  `tests/shared/*-gate.test.ts` are the next leads. ⚠ Standing trap from the reverted 2026-08-06 attempt: `projects:`
  at the TOP LEVEL of `vitest.config.ts` is silently ignored and voids the whole test config
  (false GREEN); any config split must nest under `test.projects` and prove both exit
  polarities. **Property:** no test worker blocks its event loop ≥60s continuously; until then
  the vitest-gate tolerance is the guard, and raw `npx vitest run` full runs still read red.

- **Remediation pause/recovery is not durable (2026-08-03, medium).** A plan-only stop left
  `.audit-tools/remediation/state.json` at `status: implementing`; the host work and its worktree
  had to be found and reconciled manually, while the worktree survived only because the operator
  knew its path. The primary record is
  [`graph-derived-findings-remediation-process-review-2026-08-03.md`](../reviews/graph-derived-findings-remediation-process-review-2026-08-03.md).
  **Property:** `plan_only`, pause, cancel, and resume persist the work item, workload binding,
  worktree outcome, and exact continuation action; resume must not re-run or discard accepted work.

- **Graph heuristics are promoted to findings without a semantic lead boundary (2026-08-03, medium).**
  Generic cut-edge detection labels ordinary test/asset/manifest bridges as systemic fragility; absolute
  co-change counts overstate broad migration commits; and whole-document file co-mentions masquerade as
  declared module boundaries. The sixteen declined items are the negative/corroboration corpus. **Property:**
  deterministic graph output is a generation/provenance-bound lead, not an approved finding, until semantic
  confirmation; report promotion must preserve producer, source hash, and evidence lineage.

- **Phase-boundary gate false abandonment (2026-07-30, HIGH).** The whole-repo gate runs on the LIVE
  tree; during the 2026-07-30 remediation run, driver-side uncommitted dirt failed it twice and the
  no-human backstop ABANDONED all 13 items, closing the run "complete" with no gate output persisted
  (`final-gate.json` holds only a count). Three properties failed: (1) the gate attributed dirt it did
  not cause to the run; (2) no failing output persisted, so abandonment was undiagnosable from the
  record; (3) an unattributable all-items abandonment got a terminal close rather than a resumable
  pause. Primary record:
  [`meta-review-remediation-run-2026-07-30.md`](../reviews/meta-review-remediation-run-2026-07-30.md).
  **Property:** attribute a red to the run only for paths it touched; persist the failing output; an
  unattributable all-items abandonment pauses resumably, never closes terminal.

- **A contract change swept `tests/` and missed the PRODUCERS in `scripts/` — caught only by CI
  (2026-07-25, low, friction: inefficient-feeding).** Adding `reviewed_clean`, the fixture sweep globbed
  `tests/**`; the synthetic-result generators in `scripts/` are reached only by `verify:checks`, which
  the pre-commit hook does NOT run, so it failed release CI ([[lap-green-must-match-ci-evidence]]).
  **Narrowed 2026-07-26 (AuditResult is CLOSED):** `scripts/` is covered by neither tsconfig, so the
  producer could not fail on a contract it never consulted. `buildSyntheticResults` now validates its own
  output through `validateAuditResults` and throws on any error, and
  `tests/audit/smoke-producer-contract.test.ts` gates both that refusal and the single-construction-site
  claim its docblock used to merely assert. What stays open is the GENERALIZATION to the other validated
  contract types: coverage should be derivable from the contract (every construction site of the type),
  not from where tests live. Not yet designed — the doc-manifest data+refusal shape (`2adc716c`) is the
  precedent to follow, and a typecheck gate is NOT (a cast makes it inert,
  [[test-tree-typecheck-gate-and-its-cost]]).

- **Backlog prose paraphrased an incident in a way that INVERTED its mechanism, costing a wrong
  implementation (2026-07-24, medium, friction: ambiguous-direction).** The partial-wave entry said
  "M dispatched-but-in-flight" and asserted entanglement with the claim-lease machinery; the primary
  record ([`re-dogfood-2026-07-21.md`](../reviews/re-dogfood-2026-07-21.md) #14 + the run-state section)
  says the tasks were **undispatched** — never granted. Reading the backlog entry first produced a
  claim-liveness discriminator that was wrong and had to be replaced after existing tests refuted it.
  Same family as [[backlog-prose-decays-verify-against-head]] but sharper: the decay was not staleness
  but a paraphrase that changed the mechanism. Property: an entry that reinterprets an incident must
  quote or link the primary record's own words for the mechanism, not restate them.

- **DD-9 + charter slice-staleness — residual only, revisit on live evidence (2026-07-23, low,
  accepted).** The pair itself SHIPPED (intent-equivalence gate wired as the
  `intent_equivalence_current` obligation — `nextStep.ts` PRIORITY slot between
  `intent_checkpoint_current` and `charter_extraction_current` — with
  `artifact_metadata.intent_baseline` as the intent entry's revision authority; per-edge dependency
  slices for `charter_register.json` in `src/audit/orchestrator/dependencySlices.ts`; mechanism
  record: [`intent-gate-charter-slice-design-2026-07-23.md`](../reviews/intent-gate-charter-slice-design-2026-07-23.md)).
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
  TRANSIENT host submission (`intent-equivalence-verdict.json`) the same `Durable host input:` prefix as
  a registered staleness-DAG leaf, so nightly `docs-3` correctly inferred "register it for consistency"
  and collided with DD-9's deliberate no-verdict-pair-cache retirement. Fixed by relabelling the row and
  making the durable row state its registry+DAG membership explicitly; endpoint traces in
  `docs/reviews/intent-equivalence-verdict-endpoint-trace-2026-07-28.md`.
  **Open property (the class, not this instance):** a category prefix in a normative table is read as
  a contract, so two files sharing one must share its lifecycle. Nothing enforces that. Worth a check
  only if a second instance appears — one occurrence is not yet a pattern.

- **⬇ LIVE (re-dogfood 2026-07-22, medium): a worker self-reported "valid, verified" on a
  malformed-JSON result file — result validity must be checked mechanically, never trusted from
  the worker's claim.** The merge correctly rejected it, but the failure surfaced only as an
  unexplained same-packet re-grant. Properties: (a) results are parse- and
  AuditResult-contract-checked at result-write or pre-merge; (b) the merge's "missing or invalid"
  names WHICH per task (file absent vs parse error vs contract mismatch). Record:
  [`re-dogfood-friction-2026-07-22.md`](../reviews/re-dogfood-friction-2026-07-22.md) #12.

- **⬇ LIVE (re-dogfood 2026-07-22, low, medium-difficulty — an ATTEMPTED fix was reverted 2026-07-25):
  completion cleanup removes the friction dir before the session stop-gate's close-out walk runs
  against it.** Ordering property: the close-out walk is part of run completion — cleanup preserves
  (or the close step completes) the friction record before archiving. Record:
  [`re-dogfood-friction-2026-07-22.md`](../reviews/re-dogfood-friction-2026-07-22.md) #13.
  ⚠ **Three findings from the reverted attempt — a naive "exempt friction/ from the rm" does NOT work
  and introduces a regression.** (1) The audit half's completion cleanup is `promoteFinalAuditReport`
  (`src/audit/io/artifacts.ts`, called from `nextStepHelpers.ts` and
  `advanceAuditCommand.ts`), NOT `cleanupStaleArtifactsDir` — the latter runs at the START of
  the next advance, so patching it changes nothing at completion. (2) The remediate half's stop-gate is
  MARKER-gated: `.claude/hooks/friction-stop-gate.mjs` requires a recent `state.json` before it reads
  `friction/` at all, and a fully-green close deletes `state.json` — so preserving the record alone
  still leaves the gate skipping the area. (3) Preserving `friction/` across cleanups REGRESSES the
  audit side, where the run id is the hardcoded literal `"run"` (`nextStepHelpers.ts`,
  `executorRunners.ts`, `operatorHandoff.ts`): every run shares one `friction/run.json`, so a
  prior run's complete record permanently satisfies both the blocking close-out and the hook's
  `anyComplete` check. A real fix must address the run-id collision first.

- **LEAD (re-dogfood): systemic-challenge round counter + banked improvements carry across RUNS
  (2026-07-21, low).** This run's challenge arrived as "round 10" with 11 prior improvements from
  earlier sessions' artifacts. Verify intended (cross-run loop state vs per-run reset). Record:
  [`re-dogfood-2026-07-21.md`](../reviews/re-dogfood-2026-07-21.md).

- **Review rounds re-derive the same file map every time (inefficient-feeding, 2026-07-19).** Step 2
  ran 4 adversarial rounds; each spawned FRESH agents that re-grepped the same `tokens_per_pct` /
  `admit` / `reconcile` call-site map from scratch (~135k subagent tokens per round, much of it
  identical recon). Continuing a prior reviewer preserves its context but forfeits independence,
  which is the whole point of the round — so the two goals are in tension and the fix is not "reuse
  the agent". **Property to hold:** a review round receives the verified call-site map as INPUT
  (cheap, mechanical, produced once) and spends its budget on judgment, not rediscovery — while still
  reaching its own verdict.
  **SPEC — the tension is false: it conflates independence of VERDICT with independence of INPUT.** What
  a review round must not do is judge work it authored. Being handed a factual call-site map it did not
  produce does not compromise that — the agent is still fresh and the verdict is still its own. Re-deriving
  the map from scratch was never carrying independence; it was carrying redundant derivation, and paying
  ~135k tokens per round for it.
  **Resolution:** the verified map is a read-only, provenanced input artifact. Each round receives it
  labelled as prior verified recon it did not author, and cannot write back to it — updates go through a
  separate recon step, so the map cannot silently absorb a reviewer's assumptions and then be handed to
  the next reviewer as fact. Rounds spend their budget on judgment.
  **Property to hold:** no review round re-derives a mechanical fact another round already established,
  and no round judges anything it authored. ⚠ Sharing an agent SESSION across rounds is the wrong version
  of this and forfeits exactly what the round is for.

- **A per-site pinning gate would make "red-green validated" mechanically checkable — UNBUILT on main.**
  The idea: revert each site of a change individually and require each reversion to turn the suite red,
  so "every changed site is pinned by a test" stops being a claim the author makes about their own work.
  A prototype (`assert-sites-pinned.mjs`) existed on an unmerged branch, reachable from NO ref at HEAD.
  The independent review that exercised it named both fail-open shapes
  ([`account-metering-round2-independent-review-2026-07-19.md`](../reviews/account-metering-round2-independent-review-2026-07-19.md),
  *The evidence apparatus is itself fail-open*): it measured *"the suite went red"*, not *"a test
  asserting THIS behavior went red"*; and a hand-written site list declared 7 sites against ≥11
  substantive hunks, so "all N pinned" was literally true and materially misleading.
  Nothing stands in for it at HEAD — the loop-core gate checks attestation existence, staged-tree
  binding and verdict only, and `--checked` is free text with a ≥20-char floor — so "red-green
  validated" in an attestation is still the author's word about their own work.
  **Properties to hold:** each site binds to the NAME(s) of the test(s) expected to fail, and the site
  list is DERIVED from the diff so an omitted hunk is impossible.
  ⚠ **OWNER DECISION 2026-07-25 — BUILD it, with a DIFF-DERIVED site list**, closing the denominator
  hole. ⚠ The second property is NOT thereby solved: expected-failing test names are still
  author-supplied, so a naive build relocates the claim instead of removing it. Derive the name binding
  (e.g. from a baseline coverage/ownership map), or the gate measures "the suite went red" again — the
  exact fail-open it exists to catch. Until then its output is not admissible as attestation evidence.

- **Friction walk (determinations-execution lap, 2026-07-29):** (1) **ambiguous-direction:** none —
  the 16 nightly-ledger answers were executable as written; the two left unexecuted (premise probe
  `ea4e616f`, guard-reach-as-declared-data `ec64d159`) are full-lap builds awaiting a design pass,
  not ambiguities, and stay visible via `answer.mjs --list`. (2) **tool-should-decide (small):**
  the Bash tool's `$TMPDIR` is unset under Git Bash on win32, so `> "$TMPDIR/x.log"` degrades to
  `/x.log` → permission denied; `/tmp` works. (3) **inefficient-feeding:** none new — the offload
  tier path carried 9 subagents (six doc edits, condensation draft, adversarial verify, loop-core
  review) with zero lane-side failures. (4) **tool-should-decide (small,
  cost: one burned tag v0.34.40):** a doc edit has no edit-time surface naming the TESTS that
  assert its content — `nightly-routine.md`'s approved lane swap was green through every local
  doc gate and failed release CI on `nightly-routine-prompt-gate.test.ts`, which pinned the
  retired helper invocation verbatim. Grep tests for a doc's path/content before shipping a
  contract-bearing doc edit; the durable fix would be a declared doc→test consumer map.

- **Friction walk (duplicated-guard lap, 2026-07-25):** (1) **inefficient-feeding (medium):** the
  triage's per-entry `Paths:` are MODEL-INVENTED for entries whose prose names no file —
  <!-- doc-citation-exempt: deliberate does-not-exist narrative — the entry records these paths as fabrications -->
  `src/scheduler/populate.ts`, `src/review/mapCache.ts`, `src/pinning-gate.ts` and others do not exist —
  so a path column that reads like evidence is a routing guess. Two of the three entries worked this lap
  had to be located by grep anyway. Property: a generated triage should emit a path only when it can be
  resolved against the tree, and mark the rest `unresolved`. (2) **tool-should-decide (low):** the
  backlog seek-index and the HANDOFF roadmap are two separate generators, each with its own commit-gate
  refusal, so a single backlog edit costs two blocked commits to learn both are stale. One `npm run
  regen:docs` (or one gate naming both) would make it one round-trip. (3) **ambiguous-direction:** none
  this lap.

- **Implementation workers are never given the contract they must satisfy (2026-08-09, high).** The
  implement-node prompt carries the DAG node's `description` and obligation ids but NOT the text of
  `finalized_module_contracts`. A host worker can therefore implement a locally plausible interface
  that contradicts an already-approved module contract. Build and targeted tests may stay green because
  the divergence is CONFORMANCE, not local correctness. Properties: the emitted host work item
  carries (or references by path) the contract for the module it implements, and a conformance check
  sits between "host result received" and "accepted", since a foundation divergence propagates to every node that
  imports it. Auditor-agnostic rule exactly — it worked only when the DAG author happened to restate
  every declared value in the node description. [[enforce-robustness-in-tooling-not-host-discretion]]

- **`obligation_ledger.input.json` is listed as a required input but never written (2026-08-09, low).**
  Every contract-pipeline step prompt lists it under Required Inputs; only the enveloped
  `obligation_ledger.json` exists on disk. Its five sibling artifacts each have both forms. A host
  following the prompt literally gets ENOENT. Either write the `.input.json` form like the siblings or
  point the prompt at the envelope.

- **A delegated step prompt can turn its executor into a second driver (2026-07-16,
  tool-should-decide, medium).** A host worker given one bounded `charter_extraction` prompt followed
  that prompt's embedded `next-step` command and advanced the workflow itself. The same happened in a
  later `systemic_challenge` round. The advance command belongs to the driver, not to the material a
  bounded executor receives. [[enforce-robustness-in-tooling-not-host-discretion]]
  **SPEC — the advance command goes in the DRIVER-facing artifact only, never in the worker-facing prompt.**
  Each step already emits two things: a machine step contract the driver consumes, and a prompt document
  the executor reads. The advance command belongs exclusively to the first. An executor handed a prompt
  with no advance command in it has nothing to obey — the failure stops being a matter of whether the
  worker follows instructions, which is the only way to fix it, since every attempted prompt-text
  mitigation has worked only for as long as someone remembered to write it. **Property to hold:** loop
  advancement is not expressible from the material a delegated executor is given. ⚠ Do not reach for an
  out-of-band control channel or an agent-identity check on the advance command — both are real designs,
  but they add a mechanism to defend a boundary that simply removing the text from one document already
  makes unreachable. Prefer the change that makes the process simpler.

- **Self-audit dogfood loop: fixing the tool mid-run invalidates the run (2026-07-16,
  ambiguous-direction, low-medium).** The defect was found BY the run, and committing its fix changed
  the audited tree → staleness correctly marked the planning chain stale and restarted from
  `charter_extraction`. Semantics are right (the dependency DAG is truth); the open sliver is that an
  active run should announce which upstream change invalidated it instead of silently re-planning.
  **SPEC — keep the cascade, ANNOUNCE it. Do not narrow staleness to make dogfooding cheaper.** The
  regression to first-planning-step is correct: the audited tree changed, so the planning derived from it
  is genuinely invalid, and the dependency graph is the source of truth. Any mechanism that spares a
  self-audit run from its own cascade would be special-casing the tool's convenience against the
  correctness rule the whole design rests on.
  What is actually wrong is that a large, expensive, correct action happens SILENTLY and looks like
  malfunction. The run should state that it was invalidated, by which upstream artifacts, and what it is
  therefore re-deriving — one message, at the moment it happens.
  **Property to hold:** an expensive automatic recovery explains itself at the moment it triggers. A user
  who cannot tell a correct cascade from a wedge will eventually defeat the cascade.

- **A stale-artifact re-extraction `next-step` runs >2min with no progress signal, silently blowing a caller timeout (live dogfood 2026-07-17, inefficient-feeding, low).** After the design-review passes, the drain re-extracting 11 stale artifacts (repo_manifest/graph over 1250 components / 8466 edges, invalidated by a docs commit) exceeded a 2-minute command timeout with no heartbeat — forcing a blind retry at a longer timeout to see if it was wedged or working. Property to hold: a long deterministic drain should emit a progress/phase heartbeat so a caller can distinguish "working" from "wedged" without a retry. Minor; the retry succeeded.

- **Friction walk (niggle-fix lap, 2026-08-07):**
  (1) **tool-should-decide (low):** a host worker landed sound edits but wrote no bound result, so the
  verify stage never ran and the driver re-verified by hand. A work item whose commit exists but whose
  result is missing should surface as explicit partial progress, never disappear as null.
  (2) **tool-should-decide (low):** both implement agents left ~16 stray `*.log` files in the repo
  ROOT despite prompts directing output elsewhere — the recorded offloaded-diff-scope class
  ([[parallel-dispatch-bounded-current-verified]]); driver swept them before commit.
  (3) **ambiguous-direction: none** — the two backlog entries stated their properties precisely
  enough that both fixes landed against them verbatim.
  (4) **tool-should-decide (low, observed post-fix):** the closeout-challenge gate cannot
  attribute tree dirt, so a CONCURRENT session's uncommitted WIP in the shared checkout re-fired
  the challenge after each of this session's commits (new stateKey, same foreign dirt) and spent
  the full cap on paths this session never touched. Property: the gate's dirty-tree evidence
  should exclude (or at least mark) paths whose dirt predates the session or is named deliberate
  in HANDOFF — same attribution principle as the phase-boundary-gate entry above.

- **Friction walk (loop-core `.ts`-conversion tranche lap, 2026-07-28):**
  (1) **tool-should-decide (medium):** the closeout-challenge Stop gate fired twice MID-LAP while 15
  background agents were live on the tree — it reads uncommitted paths as an unclean close and cannot
  see in-flight background work, so a deliberate wait state consumed both of the session's challenges
  before the real closeout. The gate needs a live-background-work signal before spending a challenge.
  (Reproduced identically on the 2026-07-28 conversion fleet lap: both challenges again spent on
  deliberate mid-fleet pauses, zero left for the actual close.)
  (2) **inefficient-feeding (low):** `.audit-tools/nightly/open-items.json` was STALE at
  presentation — all 17 surfaced items already answered and done in the ledger; the
  [[queue-items-must-be-rechecked-at-presentation]] class, since mechanized (premise probes +
  live-ledger partition).

- **Friction walk (queue-closeout + first `.ts`-conversion lap, 2026-07-28):**
  (1) **inefficient-feeding (medium):** execution state lived only in an untracked checkpoint
  (`.audit-tools/nightly/execution-checkpoint-2026-07-28.md`) while HANDOFF, the backlog entry and
  the answer queue all still said the opposite — reconciling cost a full re-verification of every
  claim against HEAD. Property: when a lap executes tracked work, the tracked record updates in the
  SAME commit, or the next reader re-derives everything.
  (2) **ambiguous-direction (low):** the nightly deletion item's "two durable rules would be
  orphaned" caveat named rules that did not map onto the three entries being deleted — each had to
  be independently located and verified untouched. Advisory imprecision, consistent with the
  standing "triage verdicts are advisory" rule.
  (3) **tool-should-decide: none this lap.**

- **Friction walk (nightly-determinations lap, 2026-07-26):**
  (1) **inefficient-feeding (medium):** `.audit-tools/nightly/open-items.json` is a single 659-line /
  26k-token document that exceeds the Read cap, so enumerating it needs a hand-written `node -e`. Worse,
  it is STALE by construction — `answer.mjs --list` correctly reported zero open while the file still
  listed all 22, because answering writes to `.claude/nightly-decisions.json` and never reconciles the
  queue file. **Property:** the queue's on-disk form is enumerable in one bounded read AND reflects the
  settled ledger, or the two disagree and the file is the one an agent finds first.
  (2) **tool-should-decide (medium):** an ANSWERED determination is free prose with no machine-readable
  work shape, so executing 22 of them meant re-reading each item's evidence to rediscover the target
  file and edit. The item already knows its `path` and its options; the answer should carry the
  actionable target, not require a second derivation from the eli5 text.

- **Friction walk (contract-sweep producer lap, 2026-07-26):** (1) **tool-should-decide (medium):**
  `scripts/` is a whole tracked tree covered by NO tsconfig — `tsconfig.json` includes `["src"]`,
  `tsconfig.test.json` includes `["src","tests"]` with `checkJs:false`. Nothing
  anywhere says "this tree is uncompiled and unchecked"; it is discoverable only by reading both
  configs and noticing an absence. Open property: the set of tracked source trees NOT reached by any
  typechecker should be stated mechanically, not inferred from what the include arrays omit.
  (2) **ambiguous-direction (low):** the backlog entry's own stopgap ("run `verify:checks`, not
  `check`, before pushing") steers the reader toward widening the pre-commit hook — the expensive wrong
  fix, since the legs that caught it repack the package. The cheap right fix was to validate at the
  construction site. A stopgap phrased as a habit reads as the intended remedy; entries should mark a
  stopgap as a stopgap.

- **Friction walk (touched_files load-gate lap, 2026-07-25):** (1) **tool-should-decide (medium):** a
  fixture helper ending in `as RemediationState` (`tests/remediate/helpers/nextStepHarness.ts`)
  makes `check:tests` inert for that fixture — it hid blocks missing a REQUIRED contract field from the
  gate added to catch exactly that. Property: a fixture must not be able to cast away a contract's
  required keys — `satisfies`, or a builder that cannot omit them.

- **Friction walk (fourth backlog-clearance lap, 2026-07-24):** (1) **tool-should-decide (medium):**
  the backlog budget baseline is bound to the LIVE file, so
  ratcheting mid-lap and then deleting more entries turns `backlog-budget-unit.test.ts` RED in a way
  that reads as a code regression — it cost a full-suite investigation here. Either ratchet only at
  commit time (a hook), or have the test compare against the COMMITTED file rather than the worktree.
  (2) **ambiguous-direction (HIGH — nearly cost the whole task):** the sweep was first sized at "222
  errors / 131 files" and deferred as multi-hour. Both numbers were wrong: `tsc` continuation lines were
  counted as filenames (real: 50 files), and `allowJs` erased 28 errors outright. Eight parallel agents
  cleared it in ~7 minutes. A mis-parsed tool report inflated the estimate 2.6× and the inflated estimate
  was then used to justify NOT doing the work. Parse a tool's output with its actual grammar before
  sizing anything from it. ⚠ Related measurement trap: `tsc` reports only ONE missing property per object
  literal, so an error count is a LOWER BOUND — every batch found 10-20% more once siblings unmasked.

- **Friction walk (second backlog-clearance lap, 2026-07-24):** (1) **ambiguous-direction (medium):**
  a backlog entry can name a fix whose PREMISE is sound and whose CONSEQUENCE is unshippable — the
  per-node token estimate entry described the defect correctly and the fix it prescribed would have
  regressed the run. An entry should state the property, not the mechanism, precisely because the
  mechanism is the part that does not survive contact ([[backlog-item-states-invariant-not-fix-mechanism]]).
  (2) **inefficient-feeding (low):** a background `npm test … | tail -N` writes NOTHING to its output
  file until the whole run ends, because `tail` buffers to EOF — so a long suite cannot be progress-
  monitored and looks hung. Redirect to a file and grep it instead of piping through `tail`.

- **Untracked-exclusion scope rule — residuals only (each low-severity, documented at the code
  site).** Shipped 2026-07-10; the scratch-pollution bug is FIXED in tooling: `buildFileDisposition` now runs an `untracked`
  scope rule (one batched `git ls-files -z`; still-included files absent from the index → `excluded/untracked`,
  guards mirror the gitignore rule) so untracked litter can never enter the auditable scope. A
  `renderHostScratchNote`/`hostScratchDir` pair (`src/shared/prompts.ts`,
  `src/shared/io/auditToolsPaths.ts`) never shipped: ZERO callers, only definitions plus a re-export
  in `src/shared/index.ts` (knip's default mode counts a re-export as a consumer), so it reaches no
  prompt — wiring it into the prompt below, or deleting it, is in scope. The unsound bounded/aggregate exclusion representation was deleted
  outright (a missing disposition record reads as *included* downstream, so aggregation silently un-excluded
  exactly the matched files — per-file records are now mandatory, validator-enforced). Residuals:
  - (a) **Submodule / nested-repo contents are now excluded as `untracked`** (parent `ls-files` lists only the
    gitlink). Consistent with citation grounding (which also can't ground them), but a silent scope change for
    repos with first-party submodules. Ideal fix = `--recurse-submodules` in BOTH the disposition rule and the
    grounding corpora (`findingGrounding.enumerateTrackedFilePaths`, M-B3 `enumerateRepoTreePaths`) as one
    atomic change — never one side alone (re-opens the asymmetry).
  - (b) **`file_disposition` now depends on git index state, which the dependency DAG doesn't track**
    (`dependencyMap.ts` keys it to `repo_manifest.json` only). An index-only change (committing a
    previously-untracked file) won't re-stale a persisted disposition until repo_manifest churns.
    ⬇ Live-run watch: after committing files mid-run-continuity, confirm they enter scope on the next audit.
  - (c) **Scope-rule guard decisions are invisible at the intent checkpoint** — `computeScopePreDigest` reads
    only per-file entries; a skipped rule (`root_untracked`/`share_exceeded`/git-absent fallback) never
    surfaces to the operator despite the summary existing for exactly that purpose.
  - (e) The audit `renderEdgeReasoningDispatchPrompt` (`src/audit/cli/prompts.ts`, `edge_reasoning`
    branch of `nextStepCommand.ts`) single-agent dispatch carries no scratch-dir note (params lack
    run context; one bounded agent writing one results file — lowest-risk path, add if it ever litters).

- **External shared-logic audit V1–V7 residuals** (each deliberate, low-severity, documented at the code
  site):
  - **(from V3) postinstall agent-scope legacy-wildcard migration gap.** Both postinstall scripts preserve
    an EXISTING legacy agent-scope bash `'*':'allow'` in an already-deployed
    `~/.config/opencode/opencode.json` on upgrade (the wrapper/install path DOES migrate it → `'ask'`;
    pinned deliberate by remediate's COR-fc1f12a6 tests). Full closure: mirror the wrapper's
    `withoutManagedBroadBashWildcard` migration into `scripts/{audit,remediate}/postinstall.mjs`.
  - **(from V5) path-guard blind spots.** `tests/shared/audit-tools-path-guard.test.ts` cannot see
    template-literal construction (no live occurrence today) and its allowlist honesty check is
    substring-only. Tighten if a violation ever sneaks past. Also low: `validateArtifacts`'s unused
    `root="."` default now yields an absolute (not relative) report path — no live call site hits it.

- **Top gate optimization — the suite-side tail is subprocess wall, not isolation overhead (measured
  2026-07-06).** It sits in a few audit integration files, so
  `pool:'threads'` / `isolate:false` will not help — the lever is the sharding already shipped, plus
  possibly splitting the 100s+ files across more shards (verify per-file: many tests spawn/mutate fs, so
  isolation-off risks bleed). Live numbers are in `.audit-tools-profile/*-history.ndjson`, never here.

- **Selective-deepening convergence — live validation env-bound.** The pending-task partition and
  prompt-bound audit ingestion now single-source the identity of every deepening task
  (`src/audit/orchestrator/pendingTasks.ts`,
  `src/audit/cli/dispatch/hostHandoff.ts#ingestAuditHostResults`). Missing or mismatched host results
  remain pending rather than being rebound heuristically. **Still open:** confirmation on a real run
  that every `deepening:*` task converges in bounded rounds and the audit reaches synthesis without
  `force-synthesis`.

- **`goal_id` is read verbatim off the LLM envelope, so its format is unvalidated (re-verified at HEAD
  2026-07-25).** The rest of ID minting is routed through the one registry:
  obligation ids now mint through `obligationId`/`moduleSlug` in
  `src/remediate/contractPipeline/idRegistry.ts` (the encoder and its phase/write-scope decoders were two
  identical implementations plus a "MUST stay in lockstep" comment), and uniqueness is the shared
  `mintUniqueId`. What is left: `goal_id` is not minted at all — it is read verbatim off the LLM envelope
  (`derive.ts`), so its FORMAT is unvalidated. **Property to hold:** an id the tool relies on is either
  minted by the registry or validated on the way in.

- **Incoming design-review/charter/challenge artifacts have no ingest/validation chokepoint.** 2026-08-05
  dogfood: 5 of 8 design-review agents drifted on the output contract (wrong filename ×2, wrong
  directory, invalid JSON ×2) and the host hand-repaired all of them; the charter delta-miner also
  returned invented node_id slugs the host had to remap. These lanes validate nothing on the way in.
  **Property to hold:** every incoming artifact rides a tool-validated
  write; an unknown node_id is refused loudly naming the valid set.
  ⬇ Reproduced 2026-08-08 at 9 of 10 lanes; the invented-node_id half did not. The repairs are invisible
  to the tool, so an uninstrumented run reads as clean (run record O2).

- **systemic_challenge findings ids are adversary-invented and round-colliding.** Rounds 3 and 4
  both minted SC-001..004 for different findings (host prefixed r4- to avoid accumulator clobber);
  convergence also rested on host prompt-craft (8/7/4/8→0 only after hardened dispatch framing).
  **Property to hold:** the tool namespaces challenge ids per round; the round prompt itself
  carries a covered-themes digest and an explicit variation bar.
  ⬇ Reproduced in full 2026-08-08 (O7 in the run record below).

- **The systemic_challenge loop has no ceiling — its only exit is a dry signal the host may have to
  fabricate.** `MAX_DRAIN_STEPS` bounds the deterministic drain; this loop has none, and
  `src/audit/orchestrator/state.ts` blocks planning until a round returns nothing-new. A fresh
  no-memory adversary structurally cannot judge "nothing new"; observed yield varied by host execution,
  not demonstrated exhaustion. **Property to hold:** a round ceiling ends the loop without a false dry signal, and a
  host-forced stop is recordable as such. Run record O7.

- **CI trigger paths omit `.claude/**`, which `check:guard-reach` INSPECTS.** `ci.yml`'s own path-filter
  comment states the invariant ("a gate's trigger paths must cover every path the gate INSPECTS", after
  a 2026-07-19 incident of this exact shape), yet `.claude/**` is absent — a hook-only push runs NO CI
  while `verify:checks` reconciles the guard registry against those files, so a hook missing its registry
  row or `.gitignore` re-include lands green and detonates on the next unrelated push. Seen 2026-08-08:
  `ce83638f` triggered zero runs. **Property to hold:** trigger paths cover every inspected path.

- **`ensure` writes opencode.json with unstable key order.** Pure key-reorder diff (edit-permission
  map) on every ensure — a generated config violating the stable content-derived ordering invariant,
  dirtying every tree it touches. **Property to hold:** generated host configs are byte-stable
  under repeated ensure.

- **Two run-id notions; friction record keyed both ways.** Step envelopes carried `run_id: null`
  all session (path resolves to `friction/run.json`) while host workload artifacts use timestamped run
  ids the shared friction substrate keys by — a substrate-keyed close-out walk was invisible to the
  present_report gate and had to be rewritten under "run". **Property to hold:** one run identity
  across step envelope, dispatch artifacts, and friction record.

- **Auditor severity calibration: 0 of 9 self-audit criticals survived mechanism verification
  (2026-08-06, lead, low).** 3 refuted / 6 downgraded — record in
  [`reviews/dogfood-run-2026-08-06.md`](../reviews/dogfood-run-2026-08-06.md). Open question:
  should synthesis demand mechanism-grounded (not flow-existence) evidence for `critical`?

- **`hostInputPause.ts` says analyzer consent lives in session config; it lives in
  `analyzer-policy.json` (2026-08-12, nightly, low).** `src/audit/orchestrator/hostInputPause.ts:31`
  documents `analyzerConsent` as "recorded per-candidate consent decisions (session config)". It
  cannot be: `SessionIntentV1Schema` is `.strict()` with exactly `review_mode` and `observability`.
  Consent persists via `AnalyzerPolicySchema` at `.audit-tools/audit/analyzer-policy.json`. The
  identical claim was corrected in `spec/mechanical-analyzer-layer-design.md` (`4d5987bf`); this is
  its code-comment sibling, left because the nightly's autonomy covers docs only.
  **Property to hold:** doc and code name the same persistence home for consent.
