# Open bugs & frictions

> Fixable defects and friction. Fix in tooling — never "the host remembers".
>
> Part of the split backlog — index: [`docs/backlog.md`](../backlog.md).
> A living to-do list, not a status log. Remove an entry once it ships; record durable
> contracts and rationale in project memory or `CLAUDE.md`, never "where the code is today".


- **`render-digest.mjs --open` discards the URL of the server it starts (2026-07-29, low, friction:
  missing-affordance).** It spawns `serve.mjs` `detached` with `stdio: 'ignore'`, and `serve.mjs` binds
  port 0, so the one line carrying the ephemeral URL goes to a closed pipe. The nightly run that starts
  the review therefore cannot tell the owner where it is; recovering it means finding the pid and
  reading its listening socket. **Property to hold:** the process that starts the answerable surface
  knows its URL — have `serve.mjs` write the URL to a file the caller reads (or pass a port in), rather
  than printing to a stream the caller threw away. ⚠ Not `stdio: 'inherit'`: the launcher is itself
  detached from the nightly run, so there is no stream to inherit.

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

- **LEAD (2026-07-23, low, surfaced reviewing the shipped DEFECT-2 design-review object
  envelope): a `json_object` worker that adds a SIBLING key beside `findings` is quarantined,
  not unwrapped.** The design-review prompt now instructs `{ "findings": [ ... ] }`, and the ingest
  (`consumeArrayIncoming` → `unwrapIncomingArray`, `nextStepHelpers.ts`) accepts an object with
  EXACTLY ONE array-valued property. A chatty lane that emits `{ "findings": [...], "reasoning": "..." }`
  (two keys) trips that rule → loud quarantine + resubmit (not silent loss), but it defeats the very
  json_object-NIM-lane case DEFECT 2 exists to unblock. Property if it bites live: the design-review
  ingest should prefer a named `.findings` key when present (ignoring extra sibling keys), rather than
  requiring a sole array property. Deferred because (a) the instructed example is clean single-key so a
  compliant worker never hits it, (b) `unwrapIncomingArray` is SHARED with edge-reasoning (`.rewrites`),
  so a named-key preference needs a design-review-specific accessor, not a change to the shared unwrap.
  Revisit if a live NIM design-review run shows chatty-lane quarantines.

- **CLI-worker write-scope — four accepted residuals, revisit on live evidence only (2026-07-22,
  low).** The review-snapshot worktree SHIPPED; the enforcement itself is closed and
  single-homed: mechanism + rationale live in `src/shared/providers/reviewSnapshot.ts`'s docblock and
  [`re-dogfood-friction-2026-07-22.md`](../reviews/re-dogfood-friction-2026-07-22.md) #8, contract-tested
  in `tests/shared/review-snapshot.test.ts`. What stays open: (a) git REFS are shared through the
  worktree link — a hostile worker can still `branch -D` / `push` / `gc` shared state (git refuses
  deleting a branch checked out in any worktree and push needs creds, so this is far narrower than the
  checkout-to-main incident class); (b) on a DIRTY tree workers review HEAD while `file_line_counts`
  hints are stamped from the real tree, and the ingest net is TWO-tier, not a flat reject: only a
  divergence past BOTH `LINE_COUNT_DIVERGENCE_ABS_FLOOR` and `_RATIO` hard-rejects
  (`auditResults.ts`); a smaller one is an advisory warning +
  `coverage_total_lines_mismatch` friction and the result IS ingested
  (`mergeAndIngestCommand.ts`), leaving HEAD-vs-dirt drift to be caught only by quote
  grounding — which runs against the real root (`:784`) and marks such findings `ungrounded`, i.e.
  surfaced, not dropped. Accepted because audits normally run on committed state; (c) a transient
  `worktree add` failure on a genuine git root degrades identically to the non-git case (same stderr +
  high-severity `write_scope_degraded` record) — `createReviewSnapshot` already runs the git-root probe
  separately, so a discriminated reason is available if it ever fires live; (d) one `git worktree add`
  per dispatching drive (memoized per dispatcher, removed in the drive's `finally`) — reuse keyed on
  HEAD sha if the cost ever bites on a large repo.

- **FLW-COR-003 claim-release livelock — one low residual (2026-07-22; downgraded from HIGH after a
  2026-07-24 code trace).** The fix SHIPPED: the in-process rolling driver sweeps its claims at drive end
  and on the empty-plan round (`releaseOwnedTaskClaims`, commit `681df1f5`).
  ⚠ **The "release on EVERY path that claims" property is REFUTED at HEAD (2026-07-25) — do NOT
  implement it.** The shared claim site already sweeps the over-claim (`src/audit/cli/dispatch.ts`), leaving
  only the EMITTED in-flight set — which is exactly what the lease is FOR (`src/audit/cli/dispatch.ts`: the
  claim spans an out-of-process worker run with no heartbeat, and `prepare-dispatch` returns before the
  workers run, so "the workers all died" is never observable host-side). And merge already releases the
  whole `failing` set including attempted-but-missing (`mergeAndIngestCommand.ts`); only
  `deferred` is deliberately retained. Same inversion this file recorded at its 2026-07-18 friction walk.
  **What remains (low):** an attempted-and-dead host round holds its emitted claims until a merge runs,
  bounded by the lease — designed behaviour; revisit only on live evidence of the lease outliving a dead
  round. The "zero-granted round pauses the drain" half is VERIFIED HOLDING; nothing open. Record:
  [`re-dogfood-endgame-2026-07-22.md`](../reviews/re-dogfood-endgame-2026-07-22.md).

- **LEAD (2026-07-23, low, surfaced by the shipped worker-kind × pool-class rule): a
  `burst_limited` proxy contributes NOTHING — populate/expansion should emit single-shot lanes
  instead of agentic ones that all drop.** The rule itself SHIPPED 2026-07-23 (declared
  `burst_limited` on sources + proxy block; `laneWorkerKindConflict` enforced per-lane in
  `resolveAmbientSources` and at the `collectDispatchableSources` chokepoint; `deriveWorkerKind`
  fixed-kind transports made override-proof; LiteLLM same-tier `router_settings.fallbacks`
  configured — mechanism + review record:
  [`worker-kind-pool-class-rule-2026-07-23.md`](../reviews/worker-kind-pool-class-rule-2026-07-23.md)).
  What remains is the productive endpoint for the proxy lane: when the proxy declares
  `burst_limited`, its expanded claude-worker (agentic) lanes are correctly refused with reasons —
  so the lane yields zero capacity until the operator hand-declares single-shot
  `openai-compatible` sources onto the same proxy (done for the live box). Populate/expansion
  emitting single-shot lanes for a burst-limited proxy would keep the capacity in the safe class
  with zero operator work; it is a deliberate populate-contract change, not smuggled into the rule
  lap. Two accepted residuals in the record: `burst_limited` is not yet a scheduler pacing input
  for single-shot lanes (declared `quota` rpm/max_concurrent covers the observed failure mode);
  `collectDispatchableSources` filtered-lane reporting is stderr-only (ambient path carries the
  structured `dropped[]`).

- **⬇ LIVE (re-dogfood 2026-07-22, medium, LEAD — mechanism RESTATED 2026-07-24 after a HEAD trace):
  a lane can return success-shaped EMPTY results and nothing in routing notices.** agy
  gemini-3.6-flash went 0-for-2 (an 11-task 6-lens security packet and an 8-entry
  maintainability/tests packet, both contract-valid with 0 findings, where fable/codex/sonnet packets
  on adjacent scope yielded 5-10) and was benched mid-run BY HAND — host discretion.
  ⚠ Two framings this entry used to carry are REFUTED at HEAD — lens class is already a routing input
  (`resolveDispatchTier`), and selective deepening already re-reviews high-risk clean results
  (`isHighRiskCleanResult`); neither would have caught this packet.
  **The gap: the dispatch engine has no result-QUALITY seam.** A pool is demoted only on cost drift,
  credit exhaustion, model-unavailable or 429 (`rollingDispatch.ts`); nothing observes what a worker
  RETURNED, so "this lane under-reports" is inexpressible except by hand.
  **Owner call TAKEN 2026-07-25 — three legs.** (1) **AFFIRMATION — SHIPPED:** a zero-finding
  `AuditResult` must set `reviewed_clean: true`, and the flag is refused alongside findings so it cannot
  decay into boilerplate (`validateResultFindings`; pinned in `validation-remediation.test.ts`). That
  separates a BROKEN lane from a weak one — what made the agy 0-for-2 unreadable. (2) **A2 oracle
  UNPARKED** so yield can gate eligibility against ground truth ([`deferred.md`](deferred.md)).
  (3) **Widen the deepening net** to low-priority zero-finding results — OPEN, wants (2)'s calibration
  for the threshold. Record:
  [`re-dogfood-friction-2026-07-22.md`](../reviews/re-dogfood-friction-2026-07-22.md) #4c/#4d.
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
  (2026-07-28, low, RESOLVED; the open half is the class).** `spec/audit/artifact-contract.md` labelled both
  `critical-flow-fallback.json` and `intent-equivalence-verdict.json` `Durable host input:`, though
  only the first is registered and a staleness-DAG leaf; the second is staged under `incoming/`,
  consumed, deleted, and materialized into `artifact_metadata.intent_baseline`. Nightly `docs-3`
  correctly inferred "register it for consistency" from the shared label, colliding with DD-9's
  deliberate no-verdict-pair-cache retirement. FIXED by relabelling the row **Transient host
  submission** and making the durable row state its registry+DAG membership explicitly (owner-approved,
  attested — `artifact-contract.md` is constitutional); no runtime or registry change. Both endpoint
  traces: `docs/reviews/intent-equivalence-verdict-endpoint-trace-2026-07-28.md`.
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

- **⬇ LIVE (re-dogfood 2026-07-22, low): a json_schema-required array elicits FILLER entries from
  weaker models when the true answer is empty.** Two of four delta-mining calls (minimax-m3)
  emitted a "delta" whose summary literally said "genuinely agrees — surfaced to document the
  negative finding", despite an explicit skip instruction; pruned host-side before submit (host
  discretion). Delta ingest routes deltas as WORK, so a filler row becomes a dispatched no-op.
  ⚠ **The "negative-finding lint at ingest" candidate is REFUTED (built + reverted 2026-07-25).** A
  regex classifier over summaries measured 8 false DROPS and 5 false KEEPS on ~25 realistic inputs; a
  dropped delta never reaches synthesis, so it fails silently and worse than the filler it replaces.
  ⚠ **The mechanical route SHIPPED (both halves).** `reviewed_clean` on zero-finding AuditResults
  (2026-07-25), and the DELTA path: `CharterDeltaSubmissionSchema` requires `no_deltas: true` on a
  zero-delta submission (refused alongside deltas), and a `deltas_pending` register settled with NO
  submission is marked UNMINED via a register validation issue — a dead miner and a clean mine are
  now distinct events. What this LIVE watch still covers: whether the affirmation path actually
  stops weaker models from inventing filler rows on a real run. Record:
  [`re-dogfood-friction-2026-07-22.md`](../reviews/re-dogfood-friction-2026-07-22.md) #4.

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

- **LEAD (2026-07-22, low): does remediate's node-claim lifecycle share the merge-only-release
  defect the audit side just fixed?** Audit's completion livelock (claims released only at merge →
  failed rounds starve every later runId for the 20-min lease) is fixed by `releaseOwned` at drive
  end. Remediate claims implement nodes through its own registry (`rollingSession.ts`,
  `acceptNode.ts`) with TWO release sites visible (`rollingSession.ts` and `:744`); verify whether a failed
  or stranded implement node's claim is released at round end or leaks until lease expiry — one
  core, two draws: if the audit fix's property holds there too, wire the same `releaseOwned` sweep.

- **Regenerating the price snapshot INVERTS host tier cost order — the refresh is blocked on the
  service→vendor-id mapping, not merely followed by it (2026-07-24, medium, ATTEMPTED AND REVERTED).**
  `src/shared/data/model-statics.generated.json` predates `__by_provider`, so `resolveModelStatics(m, p)`
  finds the index empty and falls through to the flat table — the known inert-path defect. Running
  `npm run update-models` does populate it (2794 models, 2945 collisions, 146 providers) but ALSO
  rewrites the flat table, whose entry for a colliding id is the CHEAPEST across providers by
  construction. Measured at HEAD, blended $/Mtok:

  | model | flat (no provider) | `anthropic`-scoped |
  |---|---|---|
  | `claude-haiku-4-5` | 2.00 | 2.00 |
  | `claude-sonnet-5` | 2.88 | 4.00 |
  | `claude-opus-4-8` | **0.85** | 10.00 |

  So after a refresh the flat table ranks **opus as the cheapest model in the roster**, below haiku —
  and cost-first routing (λ=0) would send every packet to it. `tests/shared/cost-rank.test.ts` caught
  this as 11 failures on CI shard 1 (both Node versions); the pre-collision snapshot happens to carry
  anthropic's own prices, which is why the stale file looked correct. **The refresh is therefore
  gated on the second-order mismatch, not merely followed by it:** `byProvider` is keyed by models.dev
  VENDOR ids while both pricing sites pass `sourceService(source)` (`identity.ts`), so any lane whose
  service string is not a models.dev provider id misses the index and lands on the cheapest-reseller
  price. Fix the mapping FIRST, then refresh. ⚠ Do not "fix" this by updating the cost-rank
  expectations — they encode real Anthropic list prices and are the thing that caught it.
  Both halves were attempted and reverted in this lap (`548380df` → restored); nothing is
  half-applied at HEAD.

- **LEAD (low): NIM roster latency is bimodal — a slow model can read as a DEAD lane.** Root cause of
  the observed `UND_ERR_HEADERS_TIMEOUT` storm (9 observations across glm-5.2, deepseek-v4-pro,
  nemotron-3-ultra-550b, qwen3.5-397b) was the CALLER's transport, not lane health: global `fetch`
  rides undici's ~5-min `headersTimeout`, which fires before a big model's FIRST byte on heavyweight
  analytical calls (no streaming). Both halves are FIXED — `~/.claude/llm-call.mjs` POSTs via
  `node:http` (`LLM_TIMEOUT_MS`, 30-min default), and the in-repo lane builds a per-launch undici
  `Agent` bound to the declared `input.timeoutMs` (v0.34.27).
  **What stays open:** a >5-min time-to-first-byte is not exercisable in a unit test — only
  "does not route through global fetch" is pinned. If a live NIM run STILL shows
  `UND_ERR_HEADERS_TIMEOUT` from the in-repo lane, the remaining suspect is genuine roster bimodality
  (one unexplained case stands: minimax-m3 ran >12 min then returned an empty body while nemotron
  answered the identical prompt in ~2 min). Practical routing: on a headers-timeout, retry a
  DIFFERENT alias before trimming payload.
  ⚠ **Rule out the obvious first — 2026-07-24 the proxy was simply DEAD** and 15/15 calls failed
  behind one truncated error that looked exactly like this class. Probe `/v1/models` before
  diagnosing a model. Records: [`re-dogfood-friction-2026-07-22.md`](../reviews/re-dogfood-friction-2026-07-22.md) #5,
  [`pause-wall-per-packet-strand-2026-07-23.md`](../reviews/pause-wall-per-packet-strand-2026-07-23.md).
  [[offload-lane-failures-are-usually-the-caller]]

- **⬇ LIVE (re-dogfood): token_usage stamping asks for a split real harnesses cannot supply
  (2026-07-21, low).** The dispatch prompt wants per-result `{input_tokens, output_tokens}`; Claude
  Code's subagent tool reports only a TOTAL. An honest host must skip the stamp, so calibration
  stays at cold-start batches (3, then 2, of 62 — observed). Accept `{total_tokens}` and calibrate
  on it. Record: [`re-dogfood-2026-07-21.md`](../reviews/re-dogfood-2026-07-21.md).

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

- **Window-scope validation at the PRODUCER boundary — designed for step 2, deferred with reason
  (2026-07-19).** The design of record (Residual 1) says to validate scope once where a snapshot is
  created, so consumers are safe by construction. Attempted and REVERTED — it is not a drop-in: every
  production caller swallows a throw from `probeQuotaSource` into `status: "degraded"` (`apiPool.ts`'s
  two `.catch`es plus the `queryCurrentUsage` branch's own try), so an assert there turns the loudest
  possible bug into the quietest possible symptom; and `compositeQuotaSource` bypasses the probe
  entirely, so "safe by construction" would be false regardless. Adding a third assert site repeats it —
  WHERE the check runs was never the problem.
  **SPEC — return the violation IN-BAND as a typed failure result, not a throw.** The distinction the
  code cannot express is "the remote is unreachable" (expected → degrade) versus "the producer emitted
  something structurally invalid" (a bug → must surface). A distinct error class that every degrade-catch
  agrees to re-throw would also work, but it stays vulnerable one refactor later — it relies on each catch
  site continuing to make an exception for it, the remember-to-be-careful shape this project rejects. A
  typed result never travels as an exception, so no catch can swallow it and a caller must handle the
  variant to compile. Producer validation can then live wherever is natural, including paths that bypass
  the probe.
  **Property to hold:** a structurally invalid producer emission is always loud and never presents as a
  network degrade. ⚠ The persisted READ path must still skip-and-warn rather than throw — old artifacts
  predate the field, and refusing to load them would turn a historical gap into an outage. Meanwhile
  `scheduleWave` asserts (live path, throws) and `quotaSnapshotWindowPctMap` skips-and-warns.
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

- **SPEC — the proxy catalog's freshness rule gates the WRITE but not the READ, and the lane has no
  operator-runnable refresh.** A 10-minute TTL exists but gates only whether populate re-fetches; the
  read path accepts cached data of ANY age, so the freshness concept is applied on exactly the wrong
  side. ⚠ **Half SHIPPED 2026-07-25, WRITE-ONLY:** `readProxyCatalog` derives `age_ms`/`stale`/
  `stale_reason`, but nothing branches on the verdict — `populateProxyCatalogIfMissing`
  (`auditorSources.ts`) still short-circuits on any age and `resolveProxyLane` (`:641`) folds
  sources in without surfacing `stale_reason` ([[write-only-data-looks-authoritative]]).
  **Properties to hold:**
  (a) the age rule applies where staleness does damage — the read path revalidates against the live
  roster, or surfaces the cache's age rather than presenting stale data as current;
  (b) every drop reason names an action the operator can actually take, which requires that such an
  action EXIST — no populate/refresh command is reachable from the CLI at all, so the reason has nothing
  true to name. Fix the missing command first; the reason text is downstream of it;
  (c) a tool-written, fully-regenerable cache that SHAPE-DEGRADES (the identity migration left a v1
  cache carrying the pre-rename `provider` field) must be REGENERATED by the tool at the next natural
  boundary (Gate-0 build), never reported as the operator's problem;
  (d) the cache is machine-global while its populate trigger is per-repo-confirmation-keyed, so starting
  work in repo B rewrites the expansion repo A is resolving mid-run (additions gate-caught; removals
  silent by design).
  Same family as the `dropped[]`-not-surfaced entry below; the stale-read path is also what recreated
  the zero-spill state (host-only pools while glm cooled). Observed on the same call: the engine's drain
  re-stormed cooling glm to 143 consecutive 429s — wave-3 pre-wall pacing from learned limits still is
  not happening on a single-model pool.
  Records: re-dogfood 2026-07-21 (drop reason named an internal function) and 2026-07-22 (cache served
  3.5h past TTL; an operator `top_k` change had zero effect until `populateProxyCatalog` was
  hand-imported from dist with `force:true`).

- **Ranked-pool composition — live-wave watch + the absolute-floor question.** ⬇ **Blocked on a real
  wave.** The mechanism shipped R3-3 (`c0cf7e9b`, 2026-07-21); what follows is residue.
  (a) The composition prediction
  that started this — free/unranked pools preferentially drawing `deep` packets — has never been
  observed live: watch that every pool arrives ranked at Gate-0, that `deep` routes by band, and that
  the autonomous ranker step round-trips in a real headless lap (emit branch
  `nextStepHelpers.ts` `provider_confirmation` → promotion via `intakeExecutors.ts`'s `authoredByLlm`,
  which sanitizes an LLM submission to `capability_order` alone and fails reach closed regardless).
  (b) **Open design, and it wants (a)'s data first:** the capability floor is RELATIVE by construction —
  `band <= Math.max(FLOOR_MAX_BAND[tier], bestAvailableBand())` in `src/shared/dispatch/admissionLoop.ts`
  — so if every pool is weak, `deep` routes to the least-weak. An ABSOLUTE floor re-manufactures the
  `no_capable_pool` wall the relative rule exists to prevent (step E calls it structural/permanent →
  livelock), so it is only worth deciding against a ranked run's numbers. (c) Ranker freshness is
  Track 2's cache-age rule (hand-run generation, ages silently) — not tracked separately here.
  Records: [`capability-evidence-salvage-2026-07-20.md`](../reviews/capability-evidence-salvage-2026-07-20.md)
  (landing gate MET carries the full mechanism),
  [`nim-dispatch-single-pool-2026-07-19.md`](../reviews/nim-dispatch-single-pool-2026-07-19.md).

- **H2+H4 collapse residual pins (2026-07-18, low, from review h2c3).** (a) The attended same-agent
  SPLIT semantics (blessed in the plan record: engine partition + host-subagent remainder on one meter,
  replacing HEAD's whole-frontier monopoly) is pinned only at pool-composition level — add a
  decision-point-level test asserting where the frontier is actually driven; fold the DC-4
  settled-pool `poolsOverride` filter into the same harness. (b) The env-DETECTED same-agent path
  (`CODEX_THREAD_ID` → `resolveConversationHostProvider` → dedup) lost its end-to-end pin when
  `demote-same-agent-guard.test.mjs` died; the new D1 tests use explicit `host_provider` only.

- **Pre-existing back-compat fold survives, now against standing policy (2026-07-18; re-verified at HEAD 2026-07-26 — NOT low).** `src/shared/quota/apiPool.ts` (`openAiCompatibleSource` + the fold below it) and `src/shared/types/sessionConfig.ts` (the `sources` doc comment) fold in a "legacy `openai_compatible` block ... for back-compat". Deliberately kept OUT of the swap commit to preserve the atomic replace. Property: under the no-legacy rule this fold should be deleted and the block treated as a plain source declaration. ⚠ Re-tagged from `low`: deleting the fold RETIRES the `openai_compatible` config block as a declaration surface, which is an operator-facing config change plus two bridge legs (`sourceProviderConfig` and the block→source fold) that must keep carrying `no_auth` — run `/design-check` first, and expect the same silent-ignore hazard the inline-`api_key` retirement hit ([[deleting-a-field-is-not-retiring-it]]): the validator passes unknown keys, so a deleted block goes silently ignored unless it is explicitly refused.

- **"The free model can't handle reasoning work" is a MYTH built from unset request parameters — check
  `finish_reason` before diagnosing a model (friction: tool-should-decide, medium-high).** Two apparent
  capability failures in one session, both traced to the caller:
  (a) asked to enumerate defects in a 94-line review record under `strict: true` with a generic
  `{summary, findings[], open_questions[]}` shape, the lane returned schema-VALID output whose every
  finding was the literal string `FAILED_TO_EXTRACT`. Cause: constrained decoding into a container that
  cannot hold the answer. The same model, same document, given a schema shaped to the task (an array of
  typed defect records) with `strict` off, produced a correct classification matching an independent hand
  analysis. The tell was present in the bad run — the summary was accurate and every defect id was named,
  so comprehension was never in question, only the container;
  (b) a 12-item batch returned 5 items with the last one degenerating into nonsense tokens, which read as
  the model falling apart under load. Measured cause: `finish_reason=length`, `completion_tokens=1024` —
  **no `max_tokens` was ever set**, so a default cap truncated the array mid-flight and the "gibberish"
  was the model closing valid JSON against the wall.
  **Properties to hold:** (i) an offload caller sets `max_tokens` deliberately and treats
  `finish_reason !== "stop"` as a failure, not a result — neither of these misdiagnoses survives one line
  of response inspection; (ii) the output schema is part of the prompt, not packaging, and `strict: true`
  is a quality risk to justify rather than a safe default; (iii) a structurally-conformant response with
  placeholder or missing content is a failure wearing a success shape and must be detectable as such.
  ⚠ **Re-examine the inherited belief before acting on it.** Earlier records of this lane "timing out past
  120s" and "not matching its own read schema" came from a retired wrapper with a hardcoded timeout and a
  single fixed schema — the same two failure classes. The standing assumption that reasoning-heavy work
  cannot be offloaded here shaped routing decisions and is not currently supported by evidence.

- **A nightly item is PRESENTED for an answer without its premise being re-checked, so settled subjects
  keep getting asked (2026-07-25, medium, friction: inefficient-feeding).** Walking the 21 open items with
  the owner, 15 were already fixed at HEAD — docs-13, 16, 17, 18, 21, 24, 25a/b/d, backlog-2, 3, 5, 6,
  sol-1, sol-2 — several by the same day's laps. An item stays open until it is ANSWERED, and nothing
  re-tests the premise between generation and presentation, so the queue reports work that no longer
  exists and the owner pays the reading cost. ⚠ **A nightly re-verification pass does NOT fix this** (owner,
  2026-07-25): these were created and resolved on the same day, so a nightly sweep never sees the window.
  Property: an item's premise is re-checked at PRESENTATION time — when it is surfaced or answered — and an
  item whose premise no longer holds is closed as resolved rather than asked. Same class as
  [[insights-report-recommended-a-retired-fix]], one layer earlier: that one generated a stale
  recommendation, this one keeps serving stale recommendations after the fact.

> **Friction-walk entry template:** one line per friction — a bold title + the `[[memory-tag]]` for the
> durable lesson + only the still-OPEN tool sliver(s). No shipped-work narrative or changelog prose (that
> lives in git log / memory). Condense at write time, not in a later doc-review pass. The `[[memory-tag]]`
> appears only where a durable memory concept was actually captured for that item — by design, not every
> entry has one.

- **Friction walk (determinations-execution lap, 2026-07-29):** (1) **ambiguous-direction:** none —
  the 16 nightly-ledger answers were executable as written; the two left unexecuted (premise probe
  `ea4e616f`, guard-reach-as-declared-data `ec64d159`) are full-lap builds awaiting a design pass,
  not ambiguities, and stay visible via `answer.mjs --list`. (2) **tool-should-decide (small):**
  the Bash tool's `$TMPDIR` is unset under Git Bash on win32, so `> "$TMPDIR/x.log"` degrades to
  `/x.log` → permission denied; `/tmp` works. (3) **inefficient-feeding:** none new — the offload
  tier path carried 9 subagents (six doc edits, condensation draft, adversarial verify, loop-core
  review) with zero relay-side failures; per-agent pin paths remain dead through the harness
  (memory: subagent-offload-tier-path-works-pool-pin-broken).

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

- **Friction walk (backlog triage + clearance lap, 2026-07-25):** (1) **inefficient-feeding (medium,
  the lap's biggest cost):** the offload triage was first run on `glm-5.2` — rank 1, a heavy reasoning
  model — for a mechanical classification, at ~4 min/entry (~7h for the file) before the alias was
  changed to the flash tier, which answered in seconds. Nothing in the lane's interface expresses "this
  is mechanical, pick down the roster", so alias choice is host discretion on every call. Property: an
  offload caller declares the WORK CLASS and the lane picks the alias, rather than the caller guessing
  rank. [[offload-lane-failures-are-usually-the-caller]]
  (2) **tool-should-decide (medium):** `deepseek-v4-flash` prepends prose before the JSON despite
  `response_format: json_schema` — 11 of 14 calls unparseable, which reads exactly like model incapacity
  and is not. `scripts/shared/triage-backlog.mjs` now salvages the object between the first `{` and last
  `}`, but ONLY after `finish_reason === "stop"`, so a truncated body cannot be laundered into a
  valid-looking record. The general property is unbuilt: schema non-adherence is a per-alias trait the
  roster does not record, so every new caller rediscovers it.
  (3) **ambiguous-direction (low):** three entries worked this lap had premises already fixed at HEAD
  (`api_key_env` type narrowing, the leaked tool-call XML, the doc-path typo) — the standing
  verify-against-HEAD rule caught them, but only after each was opened. The triage lane cannot check
  HEAD, so its `actionable_now` verdict is a routing signal and never a work order.
  [[backlog-prose-decays-verify-against-head]]

- **Friction walk (backlog clear-out lap, 2026-07-24):** (1) **ambiguous-direction (medium, two
  instances, same class):** two entries had paraphrased their own incident until the MECHANISM
  inverted, and each would have produced a wrong fix if worked from the entry alone — FLW-COR-003
  prescribed "release claims on every path that claims" when the lease must SPAN out-of-process
  workers (`src/audit/cli/dispatch.ts`), and the `analyzerDeps` entry reported a live `npm install` that
  no test makes (stub `run`; the E404 is stub-authored text). Both were caught only by tracing
  source. The template already says to link the primary record rather than retell it; what is still
  missing is anything that ENFORCES it. [[backlog-prose-decays-verify-against-head]]
  (2) **inefficient-feeding (medium, two instances):** the Claude subagent pool hit its session
  limit mid-run and killed 44 of 55 condense agents (11 usable, 0 verified — none applied), and a
  Codex recon spent its full budget on file enumeration and timed out before writing conclusions.
  Both were caller/environment, not model capability, and neither lane is probed for remaining
  capacity or bounded in scope before a batch is committed to it
  ([[offload-lane-failures-are-usually-the-caller]]). Primary record:
  [`backlog-clearance-2026-07-24.md`](../reviews/backlog-clearance-2026-07-24.md).


- **Every step prompt's trailing "Then run: … next-step" makes any DELEGATED step executor a second driver (claude-worker dogfood 2026-07-16, tool-should-decide, medium).** A Haiku subagent handed one bounded step (charter_extraction) with an explicit "do NOT run next-step" instruction obeyed the step prompt's own embedded advance command instead and drove the workflow forward — the parent lost the step boundary. This generalizes the existing "design-review worker prompts FOLLOW-UP" entry from one branch to EVERY step prompt: the advance command belongs to the DRIVER, not the step executor, and prompt text cannot enforce that split (host/worker discretion). Property to hold: a step prompt handed to a non-driving executor must not carry the advance command — e.g. emit it only in the step JSON (driver-facing), not in the worker-facing prompt md, or gate next-step on the driving agent-id. **Recurrence 2026-07-17 (design-review re-dogfood):** a `systemic_challenge` adversary subagent, handed its step-prompt path to follow, executed the prompt's embedded `next-step` and advanced the loop from round 7→8 — even convergence-loop worker prompts carry the advance command, so this is not branch-specific. Mitigation used the rest of the lap: the dispatch message explicitly overrides ("do NOT run next-step; the parent owns advancement"), which held — but that is host-discretion, exactly what the property says to remove. [[enforce-robustness-in-tooling-not-host-discretion]] [[delegate-adversarial-phases-to-separate-agent]]
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

- **The `charter_delta` step defaults its miner to the same host that merged `charter_extraction` — no mechanical author/critic split (2026-07-17 re-dogfood, tool-should-decide, medium).** `charter_extraction` instructs the host to author via blind subagents AND merge/trim their output into the submission; the very next `charter_delta` step then hands that same host the job of mining deltas over the charter set it just curated — the "independent delta-miner" is independent of the blind authors but NOT of the merger, so the host grades homework it helped assemble. Prompt text alone cannot enforce the split (host discretion; caught this lap only because the owner flagged it — I had started mining in-context before re-dispatching to a fresh agent reading `charter_register.json` cold). Property to hold: the delta-miner must be a mechanically distinct agent from whoever assembled the charters — e.g. the step dispatches the miner itself, or binds next-step acceptance to a delta submission authored under a different agent-id than the extraction merge. Same family as the executor-second-driver entry above. [[delegate-adversarial-phases-to-separate-agent]] [[enforce-robustness-in-tooling-not-host-discretion]]
  **SPEC — bind acceptance to AUTHORSHIP: record who submitted, and refuse a critique from that identity.**
  The tool records the agent identity that submits each artifact set, and the step that accepts a
  critique refuses one carrying the same identity. Independence then holds regardless of how careful the
  host is, which is the requirement — prompt text asking an agent to be independent of itself has never
  been enforceable, and this was caught only because a human noticed.
  ⚠ Worth knowing before building: an auditor-identity field already exists and is currently WRITE-ONLY —
  parsed, persisted, and read at one site purely as a non-empty check. It was previously assessed as dead
  because nothing needed it. This is the reader that justifies it, so settle the two together rather than
  adding a parallel identity channel beside a dormant one.

- **Self-audit dogfood loop: fixing the tool mid-run invalidates the run (claude-worker dogfood 2026-07-16, ambiguous-direction, low-medium).** The dispatch-blocking defect was found BY the run, and committing its fix changed the audited tree → staleness cascade correctly marked the whole planning chain stale → the 313-packet run regressed to charter_extraction, so every LLM planning step re-runs before dispatch is reattempted. Semantics are right (DAG is truth); the cost is structural to dogfooding-by-self-audit. One tool sliver worth considering: an active run whose frontier goes stale could say so explicitly ("run X invalidated by upstream staleness: <artifacts>") instead of silently re-planning from charter_extraction with run_id null.
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

- **`AGENTIC_WORKER_HARNESS_OVERHEAD_TOKENS = 15_000` is an unmeasured estimate, and the lane cannot currently measure it (low, live-gated; the rest of the 2026-07-17 feedback-gap residuals are closed — plan `docs/reviews/claude-worker-feedback-gaps-plan-2026-07-17.md`).** The constant (`src/shared/quota/capacity.ts`) is added to every packet estimate at all three fit gates (`src/shared/dispatch/coordinator.ts`, `rollingDispatch.ts` partition + selection, `cli/dispatch.ts` budget clamp), so a wrong value silently mis-sizes every agentic pool in both directions. The measurement basis now exists — per-packet `input_tokens` in `token-usage.jsonl` (`src/shared/io/tokenUsageLedger.ts`) minus the packet's local `estimateTokensFromBytes` — but `ClaudeWorkerProvider.launch` spawns `claude -p --model <alias>` with no `--output-format json` and never populates `LaunchFreshSessionResult.observedUsage`, so every claude-worker line records `input_tokens: null` ("unmeasured", deliberately not 0). Two moves to close: teach the lane to report usage (parse the CLI's JSON envelope into `observedUsage`; the stdout failure-classification scan must keep matching through the envelope), then calibrate the constant against a real run. Still true from the same lap: a worker retries 429s inside its own lifetime (dogfood: 307 proxy-side vs 29 surfaced) — invisible to the parent; terminal classification → `cooldown_until` paces ACROSS workers only. Two former residuals are now closed and should not be re-derived — declared `quota.max_concurrent` IS consumed per-pool (`apiPool.ts` → `CapacityPool.concurrencyCap` → the engine's in-flight cap; no learned/free-tier default is wanted, [[concurrency-is-declared-or-absent-never-learned]]), and context caps are never absent (`resolveSourceContextWindowTokens` returns declared stamp → models.dev window → `DEFAULT_CONTEXT_TOKENS`, never null), so registry stamp coverage no longer gates anything — this box's LiteLLM registry advertises `capability_rank` and no context field, and populate's proxied lane fits correctly regardless. The old watch's run dir (`20260717T062404401Z…`) no longer exists; a fresh dogfood run is the evidence base. [[external-audit-catalogs-are-leads]]

- **claude-worker lane residuals — two symptoms of ONE defect: identity is decided somewhere other
  than where it is known (2026-07-16, low-medium, deferred deliberately).**
  (a) **Account axis unstampable.** `expandSources` (`proxyCatalog.ts`) stamps no `account`, and
  `ProxyDeclaration` has no field to add one, so an operator declaring `account` on a direct lane merely
  splits `nim#X/m` vs `nim/m` into two pools to one backend — reopening the double-grant boundary for
  that model. Needs a per-backend account map on the declaration.
  (b) **Intra-declaration duplicates.** `collectDispatchableSources` spreads `sessionConfig.sources`
  verbatim, so two hand-declared sources with one resolved identity yield two same-id pools and
  `sourceByPoolId` arbitrates the transport by silent clobber.
  **SPEC / resolution:** the producer that knows an identity stamps it and it travels on the wire — the
  rule the account-metering work reached after five refused rounds. Dedup once, over the full source set,
  keyed on resolved identity rather than declaration origin; and never rewrite a machine-global cache
  under a run that is reading it (snapshot the read, or scope the rewrite).
  **Property:** one pool identity ⇒ exactly one launchable source, everywhere, and no in-flight run sees
  its own source set change underneath it.
  ⚠ (c) is the bounded half and can land alone: dedup by `dispatchableSourceId` across the whole assembled
  set in `collectDispatchableSources` (`src/shared/quota/apiPool.ts` — loop-core, needs attestation),
  first-wins, loser reported rather than dropped.

- **A doc-lint hook rewrites prose between Read and Edit, so exact-match edits fail on text the agent never wrote (2026-07-16, inefficient-feeding, low).** Mid-lap an `Edit` on `docs/backlog.md` failed with "String to replace not found" on a paragraph I had authored minutes earlier — a hook had normalized `vs` → `vs.` in it. The Edit tool's own hint ("tried swapping \uXXXX escapes") points at encoding, not at a hook rewrite, so the natural next move is re-reading the whole file to hunt an invisible character. Cost a re-read + a retry. Property to hold: a hook that rewrites a file the agent is mid-edit on should announce the rewrite (or the tool should re-anchor), rather than presenting as a mysterious mismatch. Cheap mitigation until then: after a "not found" on text you just wrote, suspect a normalizer and `grep` the anchor before re-reading the file.
  **⚠ The SPEC that stood here is UNBUILDABLE AS WRITTEN — premise falsified at HEAD 2026-07-25.** It said
  "a hook that rewrites a file must announce the rewrite", but no such rewriter exists: nothing in
  `.claude/hooks/` (nor the single global hook) writes into `docs/` — every hook write is a state
  marker/journal under the state dir, and the one tree-rewriting mechanism, the pre-commit gate's
  staged-snapshot round-trip, restores byte-identically and already announces an interrupted one. So the
  observed mismatch has no hook to announce it, and the remaining suspect is the editing tool's own
  matching, which this entry correctly says is not ours to change. **Before rebuilding this: name the
  process that rewrote the bytes, or close the entry.** ⚠ Still standing: do not pursue lint-aware patch
  semantics inside the editor, and do not "fix" it by disabling a gate during agent edits. Working
  mitigation: after a "not found" on text you just wrote, `grep` the anchor instead of re-reading the file.
  **Property to hold:** a file mutated underneath an agent mid-edit is announced, never silent.

- **Neither new test guards the WIRING — only the mechanism and the loader (2026-07-16, low).** `tests/remediate/session-config-load.test.ts` red-greens `loadRemediateSessionConfig`, and every remediate site routes through it today, but a FUTURE call site that inlines `resolveSessionConfig(intent, null)` instead of using the loader fails no test (verified by experiment: reverting a call site to `null` left both files green). Same for audit's two ambient sites. The loader makes the right thing the easy thing; it does not make the wrong thing impossible. Property to hold: a production caller cannot resolve a session config without a descriptor — e.g. make the descriptor a required parameter and give the two legitimate "resolve no pool" callers an explicit `noPoolDescriptor()`, so `null` stops being the path of least resistance.

- **A post-worker LANDING stage is still misfiled as dispatch — 2,845 of 5,978 lines under `src/remediate/steps/dispatch/`, plus marshal's merge half (owner question 2026-07-16, re-verified at HEAD 2026-07-24, medium).** `acceptNode.ts` (962) / `worktreeLifecycle.ts` (923) / `writeScope.ts` (496) / `verifyCommands.ts` (274) / `acceptReconcile.ts` (190) are not dispatch: `executeNodeInWorktree` (`acceptNode.ts`) is called only by the **driver** `driveRollingImplementDispatch` (`nextStep.ts`, call at `:1346`), never by `prepareImplementDispatch` (`marshal.ts`), which ends having written `dispatch-plan.json` (`:426`) + `dispatch-quota.json` (`:510`). ⚠ Correcting the old entry's absolute: prepare is not worktree-*free* — it reaches two landing symbols, `ensureRemediationBranchCheckedOut` (`:342`) and `worktreePath` (`:405`, prompt rooting) — but it creates, verifies and merges nothing, so the stage boundary holds and those two imports are exactly what an import-graph test would catch. They live under `dispatch/` only because the barrel (`dispatch.ts`) aggregated them; `acceptNodeWorktree` even takes a base-branch lock (`acceptNode.ts`) — pure serialization, zero dispatch content. `marshal.ts` itself fuses two stages: prepare (`:234-513`) and the landing merge `mergeImplementResults` (`:596-1561`). Symmetrically on the audit side, `prepareDispatchArtifacts` (`src/audit/cli/dispatch.ts`) both *decides* and *renders the prompt* — lens defs (`:293-294`), knip/analyzer anchor indices (`:517`,`:524`), source-reading anchor extraction (`:560` → `src/audit/cli/dispatch/packetPrompt.ts`), `buildPacketPrompt` + `writeFile` (`:580-581`). **Property to hold: dispatch is three stages — select/pack, size/admit, launch/land — and the name covers only the middle. Each stage is separately nameable and testable.** The assembly-unification lap this was told not to bundle with has SHIPPED (shared `buildHostPoolPreamble`, `src/shared/quota/hostPool.ts`, consumed by `quotaPool.ts` + `waveScheduling.ts`), so the re-home is unblocked. ⚠ Loop-core: `src/remediate/steps/dispatch/` is a `LOOP_CORE_PATTERNS` directory prefix (`src/shared/loopCorePaths.ts`) — a new `steps/land/` prefix must land in the canonical list with `.claude/hooks/loop-core-patterns.mjs` regenerated in the same commit (`npm run check:loop-core-patterns`), or the parity test goes red. Record: [`dispatch-fork-assessment-2026-07-16.md`](../reviews/dispatch-fork-assessment-2026-07-16.md) §3.


- **Two dispatch entry points disagree on fail-closed and on driver identity (owner question 2026-07-16, medium).** (a) `prepareDispatchCommand.ts` and `quotaCommand.ts` swallow an invalid session-config to `{}` ("using defaults") while `src/audit/cli/dispatch.ts` documents fail-closed as the invariant *precisely because* a permissive default builds dispatch against an attacker-influenced config. (b) `prepareDispatchCommand.ts` uses `resolveFreshSessionProviderName` where the host path (`semanticReviewStep.ts`) uses `resolveHostDispatchProviderName` — the exact founding-bug shape the latter exists to prevent (`provider: codex` would key the pool to codex, not the conversation host). Property to hold: every dispatch entry point carries the same guards, or there is only one entry point.

- **G4 reduces to ONE narrow bug: `block_quota.host_model` is auditor IDENTITY persisted in the repo,
  and it outranks the descriptor (2026-07-16, medium).** `resolveHostModel` (`limits.ts`)
  resolves `explicit ?? block_quota.host_model ?? env`, then `hostPool.ts` keys
  `quotaModelKeySegment = hostModel ?? input.hostModelId` — so a repo-committed field beats the
  descriptor's `self.model_id` and **auditor B keys its quota to auditor A's model**. Violates
  [[capability-is-per-auditor-not-per-audit]], and the shared-assembly lift moved that precedence into
  `hostPool.ts`, so it now affects both draws.
  **SPEC — settled, and the distinction is what each field is keyed BY.** A repo-committed host-model
  field is IDENTITY (who is driving) → a second auditor inherits the first's identity and meters a
  window it does not own. **Fix = move `block_quota.host_model` → `self.model_id` only**, and narrow
  the `RepoSessionIntent` HALF-type note (`src/shared/types/sessionConfig.ts`).
  **Property:** anything naming WHO is running belongs to the auditor and is never persisted in the
  shared repo; anything keyed by a model NAME is shared config and is.
  **⚠ The rest of the original claim is REFUTED — do NOT "fix" it.** Nothing writes
  `quota`/`block_quota`; they are operator-authored (`packetFilter.ts` documents `quota.models` as
  the override mechanism). `quota.models[<model>]` is keyed by model NAME, so every auditor on that
  model shares the window by design — inheriting is CORRECT, and `limits.ts` beating discovery is
  the intended escape hatch. It only ever looked wrong because the identity above it resolved wrongly.
  `quota.default_context_tokens` / `reserved_output_tokens` and the `block_quota` context/output fields
  (`plan.ts`) are policy → stay on intent. Also stale: G4's "may fold into G2" — G2 shipped and
  did not fold it.
  **⚠ Separately real, still open, and NOT a gate on the above:** `resolveSessionConfig.ts` maps
  none of the `self.*` capability fields; they reach dispatch hand-threaded through
  `nextStepCommand.ts`, `prepareDispatchCommand.ts` and `quotaCommand.ts` — a parallel
  channel worth collapsing on its own merits. An earlier claim that this "MUST collapse in the same
  commit as any shared-assembly lift" was WRONG and the 2026-07-16 lift shipped without it.
  Detail: [`g4-g5-g6-premise-check-2026-07-16.md`](../reviews/g4-g5-g6-premise-check-2026-07-16.md).

- **A declared source that verified reach and then lies at dispatch is never ejected — the reactive
  `lies reachably` quarantine has no catcher (found G4/G5 premise-check 2026-07-16, low).**
  `verifySourceReach`'s own comment names that quarantine as the catcher the reach gate does not have
  (`src/shared/providers/auditorSources.ts`) — the catcher does not exist. Retiring inline
  `api_key` closed the always-passes lane that used to be refused here, but not this one. A lane whose key was
  revoked or whose endpoint died still verifies (env var present, launcher on PATH) and is re-admitted
  every run; under cost-first routing (λ=0) a stale free-tier declaration then takes EVERY packet first
  and fails them all. Open property: a source that fails reactively (oversize / 402 / tool-corruption)
  leaves the pool for the rest of the run. This is what remains of G5 — its other two clauses were
  already dead when it was triaged, and that disposition lives in
  [`g4-g5-g6-premise-check-2026-07-16.md`](../reviews/g4-g5-g6-premise-check-2026-07-16.md).

- **A ROTATING set of heavy suite tests fails only under parallel load — hermeticity, not regression
  (2026-07-16, tool-should-decide, low-medium).** `tests/audit/linux-cycle-regression.test.ts` fails in a
  full `vitest run` and passes alone; a second failure ROTATES between runs (seen: `wave-scheduler`,
  `next-step`, `quota-state` — all heavy, all pass alone). Per the test-failure protocol these are test
  bugs (timeout under worker contention / shared state dirs), not code regressions. ⚠ The 2026-07-16
  failure count pre-dates the `INV-shared-core-14` fix — re-measure before relying on it.
  **The real cost is the is-it-mine investigation:** every dispatch-touching lap re-derives the same
  answer by stashing and running the full suite on main (~2×260s) to prove parity.
  **SPEC — persist the known-state baseline so parity is a LOOKUP, not a re-run.** At green baseline,
  record each test's deterministic-or-parallel-flaky status ANNOTATED with the environment it was measured
  in (parallelism, OS, core count) — the phenomenon is load-dependent, so a status measured under
  different concurrency means nothing. A branch failure then classifies against that record; **unrecognized
  failures stay RED** — the classifier may only downgrade a failure it has a matching record for.
  ⚠ Not an ignore-list: suppressing these tests destroys the signal, and the hermeticity defects remain
  worth fixing on their own merits. This removes the investigation tax, not the flakes.

- **No read-only surface shows the built dispatch pools — an exclusion rule is unverifiable until a live dispatch (G3 A″ lap 2026-07-16, tool-should-decide, medium).** Verifying "operator excludes one NIM model ⇒ siblings still route" end-to-end, I could observe the operator half at the real CLI (Gate-0 prompt → persisted `policy`) but **not the routing half**: `buildSourcePools` is reachable only from a live dispatch wave. Checked every read-only surface — `audit-code quota` reports only the host pool (`claude-code/*`) and reports the SAME with no exclusion at all, so it never builds source pools; `validate` surfaces none either. So an operator authors a rule and cannot see which pools resulted. NARROWED: the two sub-claims that made this acute are closed — an ungrammatical rule is now refused at authorship, and a zero-match rule is now reported by an advisory at Gate-0 promotion. What remains is the surface itself: both of those fire only along the promotion path, so there is still no READ-ONLY way to ask "what pools would this produce" without committing to a dispatch. Property to hold: the operator can see the resolved dispatch pool set (and any zero-match rule) WITHOUT committing to a dispatch. Would also give the A″ routing filter a runtime surface to verify at, which it currently lacks.

- **Gate-0 display never reflects an exclusion for a SOURCE — no status column, and the endpoint tier can't mark a provider entry (G3 A″ lap 2026-07-16, tool-should-decide, low).** Two halves of one gap, both display-only (routing is correct — `buildSourcePools` honors every tier): (a) the Gate-0 **sources table** (`providerConfirmationStep.ts`, `| id | provider | model | $/Mtok |`) carries **no status column at all**, so NO exclusion tier is ever shown for a source — pre-existing for provider-name rules, but total for A″'s model/endpoint tiers, which can only ever match sources; (b) `provider_pool` is provider-granular and its entries carry no endpoint, so an **endpoint-host rule can never mark one** (`ruledOut` in `sharedProviderConfirmation.ts` evaluates `{provider, model}` only) — the Gate-0 table renders the backend "included" while dispatch correctly drops it. Property to hold: what the operator is shown as excluded is exactly what dispatch drops, at EVERY grammar tier. Direction is fail-safe (under-reports, never over-routes), which is why it is low. NOTE: `excluded` leaves the persisted shape in **B+D**, so fix the RENDER path, not the artifact field.

- **The per-tool seam artifact marks `excluded` at provider granularity only — inert today (G3 A″ lap 2026-07-16, low).** `confirmProviders` (`src/audit/orchestrator/providerConfirmation.ts`) still does `excludeSet.has(provider.name)` on what is now a **pattern** list, so a `provider:model` rule marks nothing in the per-tool `provider_confirmation.json`. Verified inert: the only reader of `.excluded` anywhere is the Gate-0 renderer, which reads the SHARED artifact. Cleanup, not a defect — but it is a latent trap the moment anything reads the seam's `excluded`.

- **SPEC — split the two things currently merged into one "excluded" set; then host exclusion has an obvious
  meaning.** An operator excluding the host or primary provider is not honored: host/primary pools are built
  unfiltered while only source pools get the exclusion set. This was deferred as needing "a decision about
  what excluding your own driver should even mean," because the exclusion set always contains the
  conversation host in-session, so handing it to the host-pool builder would zero out dispatch.
  **That dilemma is an artifact of conflating two different concepts under one set:** (a) OPERATOR POLICY —
  "do not use this backend", a deliberate instruction; and (b) SELF-SPAWN BLOCK — "this backend is me, I
  cannot spawn myself", a mechanical fact about the current process. Merging them is why applying the set
  to host pools looks catastrophic: it is the self-spawn fact, not the operator's intent, that would zero
  dispatch.
  **Resolution:** separate them at the source. Operator policy applies EVERYWHERE, host pools included.
  Self-spawn blocking applies only where spawning is what happens. Then "exclude your own host" means
  exactly what it says, and an operator who excludes every pool gets a loud, correct "you have excluded
  all dispatch capacity" rather than a silently-ignored instruction. No new decision is owed once the two
  concepts stop sharing a container.
  **Remaining residue on the same surface, each smaller:** (a) an absent or unparseable confirmation still
  fails OPEN — no policy read as no exclusions, which is the wrong default for a gate whose purpose is
  withholding approval; (b) part of the artifact's reach half is still persisted but read by nothing at
  dispatch — write-only data that looks authoritative; (c) the self-spawn signal covers some host
  environments but not all, so a source running inside its own host is not always blocked — a gap in (b)
  above, and it closes when the self-spawn concept is separated and made to enumerate its environments.

- **The reconciliation gate is silently disabled if the two confirmation artifacts split (G3 A′ review 2026-07-16, tool-should-decide, low).** The obligation gates on the per-tool SEAM (`has(bundle.provider_confirmation)`, `state.ts`) while the gate's delta early-outs on the SHARED artifact (`readSharedProviderConfirmation(root)`, `nextStepCommand.ts`). They are written together only under `if (root)`, so seam-present + shared-absent (a root-less promotion, or an operator deleting the shared file) ⇒ obligation satisfied AND delta `[]` ⇒ the gate never fires for the run, and `resolveExcludedProviders` also finds no policy ⇒ a newly-reachable backend routes unconfirmed. Narrow (needs the pair to split) but silent. Property to hold: the gate's CONFIRMED operand and the obligation's presence check must key on the same artifact, or a split must be loud. [[dispatch-policy-vs-reach-cut]]

- **Loop-core gate covers `src/audit/orchestrator/` but NOT the audit cli dispatch step-emitters (2a-ii lap, tool-should-decide, low-medium) [[loop-core-enforcement-layer]].** `LOOP_CORE_PATTERNS` includes `src/audit/orchestrator/` (so 2a-ii's Finding-A fix in `advanceTypes.ts`/`executorRunners.ts`/`intakeExecutors.ts` correctly demanded attestation) but NOT `src/audit/cli/nextStepCommand.ts` / `semanticReviewStep.ts` / `prompts.ts` — where the CORE 2a-ii dispatch-inventory READ switch lives. A dispatch-substrate edit confined to those cli emitters (plausible for 2a-iii's loader wiring) would ship WITHOUT the attestation backstop. Endpoint (owner call): either add the audit cli dispatch-emitters to `src/shared/loopCorePaths.ts` (`.mjs` list is generated), or accept them as cli-glue and rely on the reviewer catching it. Not auto-expanded — widening the set makes every edit to the big `nextStepCommand.ts` require attestation, a real friction tax to weigh. **G1 (`e7b593ac`) is a concrete SECOND instance:** a breaking dispatch-handshake transport change spanning `args.ts`/`prompts.ts`/`nextStepCommand.ts`/`semanticReviewStep.ts`/`prepareDispatchCommand.ts`/`quotaCommand.ts` shipped attestation-free (none are loop-core by path). An independent review WAS done by discipline (and caught a real roster-validation-drop regression) — so the reviewer-catches-it fallback held, but only because the author chose to run it. Reinforces the owner-call endpoint above.
  **SPEC — move the CODE, do not widen the pattern list. The owner call dissolves.** The choice was framed
  as "add the CLI dispatch emitters to the attested path set (and tax every edit to a huge, constantly-
  edited CLI file) or accept them as glue and hope a reviewer catches it." Both options are bad because
  both accept the real problem: **dispatch-substrate logic is living inside a CLI command file.** The path
  list is not mis-scoped — the code is misfiled. The core dispatch read-switch belongs in the substrate,
  where the existing pattern already covers it and where it is independently testable; what stays behind
  is genuine CLI glue that correctly needs no attestation, and the friction tax never materializes because
  the file that gets edited constantly no longer contains anything load-bearing.
  **Property to hold:** the attested set is defined by what the code IS, not by remembering to list where
  it happens to live. Any file whose path escapes the pattern while its contents are substrate is the same
  defect recurring. Same class as the landing-stage-misfiled-as-dispatch entry — both are module boundaries
  drawn by history rather than by role, and both are fixed by moving code rather than by tuning a list.

- **Doc/lint gaps exposed by the G3 re-plan lap (2026-07-16) — three standing asks, all unbuilt at HEAD.** (1) **ambiguous-direction (HIGH):** a spec stating an ENDPOINT without marking what GATES it reads as a flat contradiction of the code, and invites a later agent to "fix" the spec to match the implementation (one G3 draft proposed striking an owner-approved decision on exactly that basis). The one instance is phase-qualified by hand (`spec/unified-dispatch-worker-model.md`); nothing enforces it. The only spec-prose lint, [`design-docs-declarative.test.ts`](../../tests/audit/design-docs-declarative.test.ts), covers two design docs and BANS the status vocabulary a phase marker needs, so this cannot be another banned-phrase row. Owner call: a marker grammar a lint can check (a required `gated by:` clause on any endpoint statement?) that does not re-admit status prose, and whether the lint's doc set widens. [[spec-degradation-and-doc-staleness]] (2) **inefficient-feeding (HIGH):** dated `docs/reviews/*.md` plans read as self-sufficient, so an agent entering from HANDOFF's ▶ section plans from the PLAN and never opens the design of record — the plan carries the mechanism, the spec carries the GOAL (owner, of prior laps: *"agents keep forgetting the actual goals"*). Fix direction: a mandatory goal-restatement header on dated plan docs (checkable in `scripts/check-doc-manifest.mjs`), or spec-first pointer ordering in HANDOFF. (3) **tool-should-decide (medium):** three of four G3 drafts specced a gate that would never fire, each caught only by an agent tracing the call path. Neighbouring lints exist (`executor-registry-sync.test.ts`, `audit-orchestrator-invariants.test.ts` INV-03) but the two reachability properties are unchecked: a satisfy-predicate with no transition back to unsatisfied, and an executor consuming an input without invalidating it. Both are predicates over opaque `derive`/`execute` closures, so the open question is a checkable encoding (declared `consumes`/`invalidates` fields?) before any lint can exist. [[gate-must-be-traced-not-designed]]
  ⚠ **OWNER DECISION 2026-07-25 on (1):** require a **`gated by:` clause** on any spec statement of an
  ENDPOINT — a marker grammar a lint can check that names the GATE rather than the progress, so it does
  not re-admit the status vocabulary `design-docs-declarative.test.ts` bans. The lint's doc set widens
  to the spec files carrying endpoint statements. (2) and (3) are unchanged and still open.

- **Friction walk (repair-proxy dogfood lap, 2026-07-15):** (1) **tool-should-decide (medium), overlaps [[quota-before-cost-ordering]]:** the cost ordering shows models.dev **LIST price** ($1.92 for nim/glm-5.2), but the operator pays **$0** for it (NVIDIA NIM free tier). Free-to-operator vs metered is a per-`(operator,backend)` fact the catalog can't know; discovered pools default to list price, so a genuinely-free backend sorts as if expensive and a paid one (openrouter) can hide mid-list. Today's only lever is hand-declaring `cost_per_mtok:0` / `enabled:false` per backend in `repair_proxy.providers` (done for this run) — the tool should let the operator classify a backend's cost-relationship once, not re-price every model. (2) **tool-should-decide (low):** no way to mark a whole discovered transport's sub-provider as paid→excluded at Gate-0 itself; had to edit session config + re-run next-step. (3) **tool-should-decide (medium), = [[per-model-tiering]]:** owner reinforced that capability/tier is assigned per PROVIDER, not per (provider, model, effort). Concrete: Codex (`~/.codex/config.toml` model=`gpt-5.6-sol`, effort `high`, but `-m/--model` + `-c model=` take any model per-call) renders at Gate-0 as ONE `capable`/`resolved at dispatch` row because the legacy `codex` block has a single `model` field — its multiple models at different capability tiers collapse to one. The tool's own workaround (pin `sources[]` `{provider:codex, model, parameters:{extra_args}}` per model/effort) puts the burden on the operator; the tiering should be per-(provider,model,effort) natively, sourced from models.dev / declared config. (4) **env-var trap (low):** repair-proxy `mistral` provider hardcodes `authEnv: "MISTRAL_API_KEY"`, but the operator's Mistral La Plateforme key lived in `CODESTRAL_API_KEY` (Codestral and La Plateforme share one key but the env-var name differs) → pool silently `has_key=false`/excluded until the authEnv was repointed. A reachability probe that reports "keyed but wrong-env-var" vs "no key" would cut the diagnosis.

- **Contract-pipeline planning bills HOST quota only — no route to a $0 pool (inefficient-feeding, medium, two OWNER CALLS).** Every planning phase that still needs judgment is authored by the host conversation: `buildParallelModuleWaveStep` (`src/remediate/steps/contractPipeline.ts`) calls `scheduleWave` for a fan-out *cap only* (`capacity_pools` never reaches `buildDispatchQuota` from here — see the comment at `:1669`), so even the per-module drafting wave renders a prompt asking the HOST to dispatch. Determinism already trimmed it to ~9-11 round-trips, but all of them bill before the first implement dispatch, so routing fixes on the implement half never touch the planning bill. Separately, a validation failure archives the host's artifact and `rejectionRewriteInstruction` (`:457`) demands a fresh complete rewrite, so a one-field schema error costs a whole re-author — deliberate, not accidental. Owner calls: (a) should planning phases become dispatchable to a non-host pool (they are the only half that cannot be)? (b) is a targeted in-place repair worth admitting for a single-field rejection, against the whole-artifact-rewrite invariant that makes re-emission trivially correct? ⚠ The companion `implementation_dag` citation-grounding claim was REFUTED at HEAD and dropped — grounding tries `affected_files` first and prose tokens last, and `deriveNodeFiles` gives every DAG node a file scope. [[synth-scopeless-nodes-doomed-run]]
  ⚠ **OWNER DECISION 2026-07-25 — BOTH calls answered YES.** (a) Planning phases BECOME dispatchable to
  a non-host pool; it is the only half that cannot currently route to a $0 pool, and every one of its
  ~9-11 round-trips bills before the first implement dispatch. (b) A targeted in-place repair IS admitted
  for a single-field rejection. ⚠ (b) narrows the whole-artifact-rewrite invariant, so scope it to a
  rejection whose issue set names specific fields — a rewrite stays the fallback whenever the repair
  target is not unambiguous, or the invariant erodes into "patch whatever looks wrong".

- **A stale-artifact re-extraction `next-step` runs >2min with no progress signal, silently blowing a caller timeout (live dogfood 2026-07-17, inefficient-feeding, low).** After the design-review passes, the drain re-extracting 11 stale artifacts (repo_manifest/graph over 1250 components / 8466 edges, invalidated by a docs commit) exceeded a 2-minute command timeout with no heartbeat — forcing a blind retry at a longer timeout to see if it was wedged or working. Property to hold: a long deterministic drain should emit a progress/phase heartbeat so a caller can distinguish "working" from "wedged" without a retry. Minor; the retry succeeded.

- **⬇ LIVE-run watch only — unified routing A–G.** The routing work shipped 2026-07-17 across 6
  attested loop-core commits; only the live evidence is outstanding.
  On a fresh conversation-first self-audit, watch: small pools take fitting packets; an oversized packet
  SKIPS (no 413); a 429 on pool A leaves pool B dispatchable; a zero-grant renders its honest cause.
  Mechanism and the refuted "HOST-ONLY" premise live in
  [`host-fanout-premise-refuted-2026-07-17.md`](../reviews/host-fanout-premise-refuted-2026-07-17.md) +
  [`unified-dispatch-routing-design-2026-07-17.md`](../reviews/unified-dispatch-routing-design-2026-07-17.md),
  not here. [[grep-the-writers-before-believing-inheritance]]

- **SPEC — probe the local OpenAI-compatible ENDPOINT, the way CLI providers are probed on PATH.** The
  original framing ("NIM should auto-detect like the CLI providers") has a false premise: CLI providers
  are discovered by probing PATH for a binary, and a hosted API has no binary to find. An endpoint plus a
  credential genuinely cannot be guessed, so "detect NIM with no configuration" is not a coherent goal
  and should not be pursued as stated.
  What IS discoverable is a **locally running proxy**. When an OpenAI-compatible endpoint is listening at
  a well-known local address, its roster can be fetched and its liveness checked — exactly the evidence a
  PATH probe provides for a CLI, obtained a different way. That makes the lane appear without the
  operator hand-writing a declaration, which is the real want behind the original expectation.
  **Property to hold:** a backend the tool can PROVE is reachable appears in the pool without hand
  declaration, whatever the proof mechanism is for that backend class. A backend whose endpoint or
  credential cannot be discovered stays operator-declared — that is correct, not a gap.

- **agy quota may reuse the wrong credential store (unverified, live-check).** agy is aliased into AntigravityQuotaSource (`src/shared/quota/antigravityQuotaSource.ts`, `ANTIGRAVITY_PROVIDER_NAMES`) which reads the IDE's `state.vscdb`/`ANTIGRAVITY_ACCESS_TOKEN`. Unverified whether the agy CLI shares that IDE credential store; if not, agy quota reads silently return null (degrade). ⬇ Live-run watch (agy install): confirm agy quota reads are non-null off its real endpoint.

- **Dispatch routing: JIT reservation on the HOST path + the headless/hybrid branch collapse — the remaining two thirds of the pool-agnostic-claims design (2026-07-13; concept spec 2026-07-16; re-verified against HEAD 2026-07-24).** Design of record: [`spec/dispatch-quota.md`](../../spec/dispatch-quota.md) (claim = exclusivity not routing; planner = live capability feed; quota reserved at the launch moment); build sequencing in [`docs/reviews/unified-dispatch-routing-design-2026-07-17.md`](../reviews/unified-dispatch-routing-design-2026-07-17.md). **The claim leg is effectively satisfied and its old framing ("drop `poolId` from claims") is now WRONG** — `ClaimRegistry.claim` decides exclusivity on presence+staleness alone and never consults `poolId` (`src/shared/quota/claimRegistry.ts`), no consumer reads the stored value (`partitionByOwnership` reads only `ownerToken`), and the field has since become the DRIVER identity that `claimMany`'s same-owner re-grant (`:152-176`) and `releaseOwned`'s owner-scoped release (`:210-224`) depend on, so deleting it would regress the completion-livelock fix. What is left there is naming hygiene only: rename `poolId` → `ownerId` and have `src/shared/dispatch/coordinator.ts` pass a driver id instead of `pool.id` (today a write-only value). **Genuinely open:** (a) **JIT reservation on the HOST path** — the in-process engine already reserves at launch (`src/shared/dispatch/rollingDispatch.ts` `admitAgainstLedger` immediately before `dispatchOnePacket`), but the host path still grants a whole wave's leases at plan time (`finalizeDispatchQuota({ grantLeases: true })`, `hostFanoutGate.ts`; the two-mode split is documented at `admissionLoop.ts`), so a host grant can go stale between plan and launch; (b) **host-path convergence** — the headless (`nextStepHelpers.ts`) and A-8 hybrid (`:2419`) arms are still a branch pair (routing-design H2; H4's `shouldDemotePrimaryInProcess` is already gone from `src/`). [[relax-dispatch-source-forcing]]

- **Accept-latch — two low residuals stay open.** The family SHIPPED 2026-07-23. Mechanism, the
  REFUTED "rollback to session-recorded base" premise, and the disposition of a/c/d live in
  [`accept-latch-family-mechanisms-2026-07-23.md`](../reviews/accept-latch-family-mechanisms-2026-07-23.md).
  Open: (1) a rolling-dispatched node whose accept sidecar is ABSENT at merge (runId-mismatch chaos) is
  indistinguishable from the interim main-tree path and closes unverified — needs a rolling-path marker
  independent of sidecar presence; (2) the sidecar's monotonic `merged:true` guard still blanket-preserves
  stale records — the ancestry probe is the corrective, so revisit only if a case escapes it.

- **Node-worktree guard — accepted residuals only (each low, on-evidence-only).** The guard itself shipped v0.34.19. Mechanism, refuted alternatives, and review disposition: `docs/reviews/node-worktree-guard-mechanisms-2026-07-23.md`. Deny-by-default CLI refusal (`assertCliCommandAllowedFromCwd`, `src/shared/io/nodeWorktreeGuard.ts`) is wired at both CLI chokepoints (`src/audit/cli.ts`, `src/remediate/index.ts`) over caller cwd + wrapper-stamped `AUDIT_TOOLS_CALLER_CWD` + raw `--root`, with remediate-side writer asserts (`state/store.ts`, `steps/rollingSession.ts`) behind it. What stays open: audit-side session writers have no writer assert and rely on the CLI guard alone (add one only if a non-CLI clobber shape ever fires); a worker that both `cd`s out of its worktree AND passes explicit targets can still reach shared state (containment, not authority — the `implementPrompt` "Standing rules" section is the remaining layer); a failed review-snapshot degrades spawned audit workers to the REAL checkout (`src/audit/cli/rollingAuditDispatch.ts`, `resolveReviewRoot`), where the cwd predicate cannot fire and write-scope is prompt-only for that run — loud (stderr + a high-severity `write_scope_degraded` friction event) but unguarded; dist-dependent verify commands deferred by `partitionDistDependentVerifyCommands` are subsumed by the close gate's full-suite run rather than individually re-run.

- **Test-tree `.mjs`→`.ts` conversion: COMPLETE at its floor (2026-07-29).**
  `check:tests` reaches 563 of 564 test files (`find tests -name "*.test.*"`). The one `.mjs`
  remaining is deliberate and permanent: `tests/shared/shared-tests-invariants.test.mjs` (a `.ts`
  guard cannot detect its own exclusion). No config ratchet exists; the vitest `include` globs stay
  single-sourced in `tests/helpers/testFileContract.ts`, enforced by
  `tests/shared/test-suite-visibility.test.ts`. The ratchet's yield across the tranches: dozens of
  real fixture-drift repairs (missing required fields, stale field names, enum values that never
  existed — `status: "planning"`, `"passed"`, `"audit"`), six types-only src/scripts widenings
  where a declared type undersold a tested tolerance, and one real loop-core defect
  (the dead `buildAccountScopedQuotaSource` claude arms — settled 2026-07-29, exhaustive switch +
  §5b contract pins in `tests/shared/dispatchable-sources.test.ts`). Per-lap semantics check for any
  future conversion: `node scripts/shared/conversion-assertion-parity.mjs` after `git mv`+edits,
  before commit — review ONLY the files it flags.
  ⚠ Converting a file named in `scripts/shared/test-flake-baseline.json` (charter-extraction,
  handoff-roadmap) must move its baseline key in the same commit, or the flake record orphans.
  ⚠ **MEASURED and REJECTED (2026-07-28): flipping `checkJs: true` with an exclude list** — the flip
  yields 8,903 errors across essentially every `.mjs` file, so the exclude list would cover the whole
  tree, buy zero coverage, and leave a 451-entry config to rot (it also dirties 28 `.ts` consumers).
  **Property:** the gate's reach is stated as a number wherever it is claimed, so "the test tree is
  typechecked" can never again read as covering the whole tree
  ([`durable-traps.md`](durable-traps.md) carries the narrowed claim).

- **Friction walk (buildAccountScopedQuotaSource lap, 2026-07-29):**
  (1) **tool-should-decide (low):** the Grep tool's content output rendered `/**` and `//` comment
  markers as `\**` / `\ ` in `apiPool.ts`, indistinguishable from real file corruption — cost a
  verification Read. Display artifact of the harness Grep tool, not the repo; logged in
  [`durable-traps.md`](durable-traps.md).
  (2) **inefficient-feeding (low):** the nightly surface presented all 18 items as open while the
  owner was answering them in a parallel session on the shared checkout — the stale-at-presentation
  class already answered as the sol-2 probe (re-check the ledger at presentation).
  (3) **ambiguous-direction:** none — the backlog entry stated its open property even-handedly
  ("or the fallback must be shown deliberate"), which is exactly what let recon settle it without an
  owner round-trip.

- **Friction walk (loop-core `.ts`-conversion tranche lap, 2026-07-28):**
  (1) **tool-should-decide (medium):** the closeout-challenge Stop gate fired twice MID-LAP while 15
  background agents were live on the tree — it reads uncommitted paths as an unclean close and cannot
  see in-flight background work, so a deliberate wait state consumed both of the session's challenges
  before the real closeout. The gate needs a live-background-work signal before spending a challenge.
  (Reproduced identically on the 2026-07-28 conversion fleet lap: both challenges again spent on
  deliberate mid-fleet pauses, zero left for the actual close.)
  (2) **inefficient-feeding (low):** `.audit-tools/nightly/open-items.json` was STALE at
  presentation — all 17 surfaced items were already answered AND recorded done in the decisions
  ledger (`answer.mjs --list` had the truth); the surface artifact predated the answering commits.
  `nightly-surface.mjs` should re-check the ledger at presentation and suppress settled items —
  the [[queue-items-must-be-rechecked-at-presentation]] class, now on the surface artifact itself.
  (3) **environment (memory, not repo):** the offload agent-type path (`pool/<name>` frontmatter)
  404s through the harness while tier-mapped offload works — host-level (llm-relay/headroom),
  tracked in project memory.

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
  (3) **ambiguous-direction (low):** the backlog-17 answer folded an OPEN actionable property (the
  offload lane states its concurrency nowhere a caller reads it, and returns an empty document instead
  of refusing) into `durable-traps.md`, whose own header says it is standing reference and NOT work —
  so consolidating it dropped it off the generated roadmap. Executed as answered; flagged because the
  destination silently changes an item's status.
  (4) **tool-should-decide (low):** a delegated Codex worker, asked to make one type change, also
  appended an unrelated `durable-traps.md` entry about an `rtk` binary this project retired 2026-07-22.
  Reverted. **Property:** offloaded work needs its DIFF scope-checked, not just its result verified —
  a worker's out-of-scope edit lands silently in a doc nobody diffs.
  (5) **tool-should-decide (medium, fixed this lap):** the remediation worktree test pinned “no global
  `git worktree prune`” in ONE lifecycle file, while `reviewSnapshot.ts` still executed the same
  sibling-clobbering command. Replaced it with path-scoped removal and widened the source invariant over
  all tracked `src/` files. **Property:** a cross-cutting forbidden command is scanned across its whole
  production reach, not asserted at the first file where the incident happened.

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
  (3) **inefficient-feeding (low):** the offload lane's design-refutation call returned correct SHAPE
  with fabricated CONTENT (a `root.buildConfig` flag that does not exist, and a `.md` doc named as the
  failing test file) — the known fabrication trap, but it costs most in exactly this call, where the
  whole point is an independent verdict. Refutation-shaped offload output needs its citations
  mechanically resolved before it is read, or it is worse than no second lane.

- **Friction walk (inline-api_key retirement lap, 2026-07-26):** (1) **tool-should-decide (medium):**
  a test fixture declaring `api_key_env` whose env var is UNSET drops the lane silently, and the drop
  reason never reaches the assertion — six tests across three files failed as
  `expected 0 to be greater than 0` and "no API key" on a config-shape migration, with nothing pointing
  at the unset var. The lane drop is correct behaviour; the friction is that a test-time drop is
  indistinguishable from the defect under test. Open property: a source dropped for an unresolvable
  credential should surface its reason where the assertion can see it.
  (2) **inefficient-feeding (low):** the retirement's real hazard (unknown config keys pass the
  validator untouched, so deleting a field leaves a pasted key SILENTLY dropped) is a property of
  `validateSessionConfig` that no doc states — both review lanes had to rediscover it from source.
  The validator's own contract is the place to say it.

- **Friction walk (touched_files load-gate lap, 2026-07-25):** (1) **tool-should-decide (medium):** a
  fixture helper ending in `as RemediationState` (`tests/remediate/helpers/nextStepHarness.ts`)
  makes `check:tests` inert for that fixture — it hid blocks missing a REQUIRED contract field from the
  gate added to catch exactly that. Property: a fixture must not be able to cast away a contract's
  required keys — `satisfies`, or a builder that cannot omit them.
  (2) **ambiguous-direction (medium):** the offload refutation INVENTED a retirement collision (read the
  plan's edit-site list as a "hand-maintained table", cited `KNOWN_MODEL_LIMITS`) despite a prompt
  saying "default to clean unless you can quote evidence". An adversarial prompt biases toward finding
  something — budget a verification pass per lead
  ([[verify-delegated-findings-mechanism-not-just-citation]]).
  (3) **inefficient-feeding (low):** `llm-call.mjs --schema <file>` was accepted but the reply came back
  in the DEFAULT container shape, so a task-shaped schema silently degrades to prose. Unverified whether
  the helper or the proxy drops it.

- **Friction walk (fourth backlog-clearance lap, 2026-07-24):** (1) **inefficient-feeding (medium):**
  `llm-call.mjs` takes `--schema`, and the DEFAULT container silently flattened a six-part lettered
  question into one `summary` with `findings: []` — which reads as model incapacity and is not. The
  helper can detect this: an instruction containing enumerated sub-questions (`A.`/`B.`/`1.`) under the
  default schema should warn (or refuse) at call time, since the shape mismatch is decidable from the
  prompt. (2) **tool-should-decide (medium):** the backlog budget baseline is bound to the LIVE file, so
  ratcheting mid-lap and then deleting more entries turns `backlog-budget-unit.test.ts` RED in a way
  that reads as a code regression — it cost a full-suite investigation here. Either ratchet only at
  commit time (a hook), or have the test compare against the COMMITTED file rather than the worktree.
  (3) **ambiguous-direction (low):** a backlog entry can name a property whose honest implementation is
  a contract change the entry never mentions — the keyless-endpoint item reads knob-sized but needs a
  sync→async ripple through session-config resolution. Entries should state the cost when the mechanism
  is known to be structural ([[backlog-item-states-invariant-not-fix-mechanism]]).
  (4) **ambiguous-direction (HIGH — nearly cost the whole task):** the sweep was first sized at "222
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

- **▶ ⬇ LIVE-run watch ONLY — the per-node token estimate is WIRED (2026-07-25, loop-core).** Both fit
  gates now read `DispatchPlanItem.estimated_input_tokens`, stamped once in `prepareImplementDispatch`
  at the point the rendered prompt exists; `HYBRID_NODE_TOKEN_ESTIMATE` and `driveRollingDispatch`'s
  `() => 2000` default are DELETED, and `estimateTokens` is a required option so no caller can silently
  restore the blindness. The field is required and validator-enforced for implement dispatch.
  ⚠ **This is the first change that makes the `no_capable_pool` structural-refusal pause REACHABLE in
  real use, and it has no live evidence yet.** Watch a real frontier: an unplaceable node must reach a
  RESUMABLE pause naming the real cause (split it, or declare a larger `context_tokens`) — never
  `empty_pool`, and never a terminal strand. If a large node now refuses everywhere, that is the honest
  estimate working; check the pool's declared `context_tokens` before treating it as a regression.

- **Remediation must never switch the primary checkout off its base branch (2026-07-22, medium; product fix planned).**
  `ensureRemediationBranchCheckedOut` currently checks the primary checkout out at
  `remediation/<runId>` during implement-dispatch, so later main-bound work can strand on the run branch.
  Commit `a7bc93fc` added a useful **Claude-only** refusal in `.claude/hooks/pre-commit-gate.mjs`: a
  docs/spec-only commit on `remediation/*` is blocked. That closes the three observed Claude-shell
  incidents, but it is not the host/IDE-agnostic endpoint — Codex, an IDE, or direct Git bypasses the
  Claude `PreToolUse` registration, and the primary checkout still moves.

  **Plan — remove the state transition instead of adding another guard.** Give each remediation run a
  locked, run-level **landing worktree** checked out at `remediation/<runId>`. Prepare/accept merges node
  commits into that landing root; the primary checkout remains on its original base branch for the whole
  run. Close merges the run ref from the primary root, then removes the landing worktree path-scoped.
  Keep the landing root outside the per-node `.audit-tools/worktrees` namespace (or teach
  `nodeWorktreeGuard` its distinct role), and hold a run lock so the session-start reaper cannot mistake a
  clean, landed-but-not-closed root for garbage. Never substitute a real Git hook: it is install-state,
  bypassable, and still only catches the bad transition after it happened.

  **Red-first contract:** in a real temporary repo starting on `main`, prepare implement dispatch; assert
  the primary root is still on `main`, `remediation/<runId>` is checked out only in the landing worktree,
  accepted node commits reach that ref, and close merges it from the unchanged primary root. This is a
  loop-core atomic replacement (new landing lifecycle + deletion of the primary-checkout switch in one
  commit), with the normal independent review/attestation gate.

- **"Delegate the rolling loop" dispatcher pattern breaks on notification routing (2026-07-11 live run, tool-should-decide, medium).**
  The step prompt tells the host to hand the rolling loop to one dedicated dispatcher subagent, but worker
  completion notifications deliver to the MAIN session (the dispatcher idles between events), so the host
  must manually relay every completion to the dispatcher — the exact per-node tracking the delegation was
  meant to remove. Either the prompt's model is wrong for hosts with this notification topology, or the
  worker prompts should instruct workers to message the dispatcher directly.
  **SPEC — the prompt's model is wrong; drive fan-out from the session that OWNS the notifications.**
  Completion notifications route to the top-level session, and that routing is host-harness behavior this
  project does not control. So a delegated dispatcher is structurally the wrong shape: it idles between
  events it will never receive, and every workaround reintroduces the manual per-node relay the delegation
  existed to remove.
  Resolution: the step prompt stops instructing a delegated dispatcher and describes flat fan-out driven by
  the session that owns the notification channel. Delegation stays available for bounded units of WORK; it
  is driving a completion-event loop that does not survive delegation. ⚠ Do not resolve it by having
  workers message the dispatcher directly — that builds a second, parallel completion channel alongside
  the harness's own, which then has to be kept correct in cases (crash, timeout, partial result) where the
  harness channel already is.
  **Property to hold:** the agent that awaits completions is the agent that receives them. Generalizes
  beyond this prompt: any instruction to delegate an event loop across a boundary the events do not cross
  is the same defect.

- **NIM in-process worker: one packet failed with "empty completion (no choices[0].message.content)" (2026-07-11 live run, watch).**
  Hybrid partition (3 packets): 2 returned results inline, 1 errored empty. If it recurs on a specific
  model (ultra vs nano), demote that source or add a bounded same-packet retry on a sibling $0 pool.

- **Abandoned HOST-path grants hold reservation leases to the 20-min TTL, walling a fresh grant (2026-07-11 live run, low — backstop works; not a release bug).**
  Only the host-subagent grant PERSISTS leases (`grantLeases:true` → `runs/<runId>/dispatch-quota.json`);
  the in-process rolling engine reconciles per packet on success OR failure (`src/shared/dispatch/rollingDispatch.ts`),
  so the leak class is host-path only. Release is wired at every normal exit — merge
  (`mergeAndIngestCommand.ts`, ahead of the idempotency replay), the dispatch wall/pause
  (`dispatch.ts`), and the fan-out chokepoints (`hostFanoutGate.ts`, which additionally
  reconciles-before-regrant so a re-run next-step can't orphan the prior family's lease ids). A wave
  KILLED mid-flight (stopped drain, dead dispatcher, fleet session-death) reaches none of them, so its
  leases free only via `DISPATCH_LEASE_TTL_MS` (20 min) while `admitBatch` keeps counting them:
  `countByPool` is seeded from the ledger's distinct live lease ids (`admissionLoop.ts`) and
  `:741` refuses `cap_reached` with `headroom_before: null` — the ledger is never reached, which is why
  the wall reads as phantom. Sharper than when logged: the uncalibrated cold-start cap is now
  `COLD_START_PROBE_BATCH = 1` (`scheduler.ts`), so ONE orphaned lease walls a calibrating pool.
  Residual (open, low): a startup sweep releasing leases whose owning run is demonstrably dead. Blocked
  on the DISCRIMINATOR, not the code — `ReservationLease` carries no owner (leaseId/cost/poolId/
  expiresAt; the pid inside `mintLeaseId` is incidental and is *always* dead on the host path, since the
  granting CLI exits before the workers run), and "a newer run exists" is not death under co-located /
  multi-agent runs that JOIN one run. Safe-by-construction shape: sweep only lease ids readable from
  this artifact dir's own `dispatch-quota.json` files, keyed on a run-terminal signal.
  `reclaimExpired()` (`reservationLedger.ts`) is unwired and only drops already-expired leases, so
  it does not close this.

- **A2b unmatched-quota fallback — two residuals (each low, documented at the code site).**
  - (a) **`pausedPoolResetAt` + `quotaUnclassifiedPoolIds` are not injected across sub-waves** the way
    `costDemotedPoolIds` is (`rollingDispatch.ts` state ctor + `unifiedRolling.ts`), so within a multi-sub-wave
    drive the reversible pause + the harvest-once gate reset at each sub-wave boundary — a chronically
    quota_unclassified pool is re-attempted once per sub-wave (bounded; friction dedup collapses the repeat
    harvest). Fix = thread both through the dispatcher options like `costDemotedPoolIds`. Efficiency-only.
  - (b) **The A-8 hybrid `executeInProcessPartition` (direct `Promise.all`) never invokes the rolling engine's
    hooks**, so the VERBATIM harvest (`captureQuotaUnclassifiedFriction` / `captureCreditExhaustionFriction`)
    does not fire there — a settled node surfaces only as a `quota_escalation` friction (no verbatim text).
    Affects `credit_exhausted` identically (pre-existing, not new to A2b). Fix = thread verbatim capture into
    `executeInProcessPartition`. The pool IS now settled there (no unbounded re-offer), so this is harvest-signal
    completeness, not a safety gap.

- **Design (remove-waves track): dispatch should be gated ONLY by token-budget, rate, and true task-unlocks — the host merge/re-grant barrier is artificial for independent review packets (2026-07-11 live run, owner design statement, forward-track).**
  Owner's spec: the ONLY legitimate reasons to hold a packet are (1) a non-parallelizable predecessor
  UNLOCKS it, (2) the quota window refreshes, (3) the pool is RATE-limited (RPM/TPM, not budget). Any
  other hold is pure latency. On audit-code: base review packets are embarrassingly parallel (read-only,
  no write conflict, no ordering), so the host path's `next-step → dispatch → merge-and-ingest →
  next-step` barrier is an artificial wave, none of (1)/(2)/(3). The IN-PROCESS rolling engine already
  implements the correct model (continuous slot-pull, refill-on-completion, pace-on-rate) — the host path
  is the deviation. Reason (1) genuinely applies to ONE layer: selective-deepening tasks do not exist
  until earlier findings land.
  **SPEC — delete "wave" as a concept; express that one barrier as a DEPENDENCY EDGE.** The deepening
  layer needs a merge first precisely because its work does not exist yet — already reason (1). Modelling
  it as a global phase is what makes every unrelated packet wait, so the barrier and the latency are one
  mechanism. With it as an edge, nothing is left for "wave" to mean, and the host path CONVERGES onto the
  in-process engine rather than keeping a second scheduler (the fork the one-core rule exists to prevent).
  The calibration cap is a FOURTH, illegitimate hold — it throttles on not-knowing-quota-in-tokens, which
  is neither budget, rate, nor unlock, and never resolves.
  **Property to hold:** a packet is held for exactly three reasons — unmet dependency, rate limit, or
  budget. "The previous phase has not finished" is not one of them.
  Realizes [[self-scaling-pipeline-not-forked-paths]] on the host path.
- **Host fan-out quota gate — residual: AD-HOC host Agent spawns sit outside every ledger (re-verified 2026-07-24, low, [[host-fanout-quota-gate]]).** The prescribed half is SHIPPED: `gateHostFanout` (`src/audit/cli/dispatch/hostFanoutGate.ts`) runs at the five fan-out emitters in `nextStepCommand.ts` (four `design_review`, one `systemic_challenge`), granting a panel all-or-nothing through the same `buildDispatchPool` → `finalizeDispatchQuota` → `detectHostDispatchWall` primitives as packet dispatch, with per-family leases under `fanout-quota/<family>/`. What remains is every OTHER host Agent spawn — the recon/review/compaction subagents the conversation host launches on its own initiative, with no tool call in between: no admission, no lease, and no per-agent record, so nothing names what was in flight when a session limit lands (contrast remediate-code's per-node worktrees + claims). Their spend is not wholly invisible — it moves the account percent, so it arrives as unattributed pct drift in the merge-time slope fold (`tokenUsageObservation.ts` C5 note: understated slope, the safe direction) — but drift is not accounting.
  **This is an owner call, not a bounded fix:** the tool cannot gate a dispatch it never sees, and both mechanical routes are barred by standing rules — a `note-fanout`-style CLI the host must remember to call is host discretion, and a PreToolUse Agent hook is a host-IDE coupling. Decide the shape first: (i) every fan-out routes through a prescribed step so "ad-hoc" stops existing as a category, (ii) ad-hoc spend is explicitly accepted as unmetered account drift the pre/post attribution already absorbs, or (iii) an IDE-hook accounting layer is accepted as a deliberate, documented exception to IDE-agnostic. (Absorbs sliver (b) of the "ledger-writer / acceptNode-inert-clean lap" entry below — drop that half when this lands so the item has one home.)
  ⚠ **OWNER DECISION 2026-07-25 — option (i): route every fan-out through a prescribed step, so
  "ad-hoc" stops existing as a category.** Options (ii) accept-as-drift and (iii) an IDE-hook accounting
  layer are both REFUSED — (ii) because drift is not accounting, (iii) because it buys per-agent records
  with a documented breach of IDE-agnosticism. This is now a bounded design task, not an open question.
  It also subsumes the "Ad-hoc Agent fan-out has no per-agent ledger" entry below — close that one with
  this.

- **Design-review independence — the solo contract branch is pinned by a shared helper, not by a test
  (2026-07-24, low).** ⚠ BOTH of this entry's earlier framings are FALSIFIED at HEAD and must not be
  acted on: the "second-driver hazard" reading (that the solo branch's advance is the same double-driver
  bug fixed for `design_review_parallel` in `e6b580d0`), and the "the host judges itself" reading (that
  solo `design_review_contract` renders the adversarial review into the host's own step prompt with no
  packet file and no `access` block). Solo and parallel now dispatch through ONE helper,
  `prepareContractDispatch` (`src/audit/cli/nextStepCommand.ts`), whose docblock states both
  properties — INDEPENDENCE (the pass is always dispatched to a subagent) and ADVANCE-FREE (the packet
  carries no `next-step`, so no worker becomes a second driver). The solo branch calls it at `:801` and
  writes the packet/results artifact paths plus the `access` read/write paths at `:841-846`.
  Property: no design-review pass is judged by the agent that drove the work under review, and no
  dispatched packet carries the orchestrator advance — on any of the three branches.
  What is open is only the PIN: `tests/audit/next-step.test.ts` asserts the advance-free worker
  packet and the host-side advance for `design_review_parallel` ONLY; the `design_review_contract` case
  (`:183-189`) writes the findings file and asserts nothing, so a future rewrite of that branch off the
  shared helper would not be caught. Extend the parallel-branch assertion to the solo step.

- **Untracked-exclusion scope rule — residuals only (each low-severity, documented at the code
  site).** Shipped 2026-07-10; the scratch-pollution bug is FIXED in tooling: `buildFileDisposition` now runs an `untracked`
  scope rule (one batched `git ls-files -z`; still-included files absent from the index → `excluded/untracked`,
  guards mirror the gitignore rule) so untracked litter can never enter the auditable scope, plus a
  single-sourced `renderHostScratchNote`/`hostScratchDir` prompt line directing host scratch into
  `.audit-tools/<area>/scratch/<run-id>/`. The unsound bounded/aggregate exclusion representation was deleted
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
  - (e) The audit `renderEdgeReasoningStepPrompt` single-agent dispatch carries no scratch-dir note (params
    lack run context; one bounded agent writing one results file — lowest-risk path, add if it ever litters).

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
  - **(from V2) conversation-first mid-run dirt is indistinguishable.** A declared-but-unedited file the
    USER dirties during the run window can still be staged in the `merge-implement-results` flow —
    `run_start_dirty` fences only pre-run dirt; full closure needs per-edit git ground truth that flow
    lacks. Documented at `collectStagingFiles`. ⬇ Live-run watch (conversation-first run on a dirty repo):
    `leftover_files` in the report must list untouched dirt; nothing outside the run's surface committed.

- **Top gate optimization lead — both packaged smokes REBUILD the identical package (measured 2026-07-06).**
  `verify:checks` was 95.8s, of which `smoke:packaged-audit-code` alone was 70.2s; inside it the next-step
  round-trips were 35.9s (real audit-flow coverage, explicitly NOT a target) and `npm pack` 7.2s including
  a prepack rebuild.
  **SPEC — build the tarball ONCE, assert many; do NOT build an in-process smoke driver.** The duplicated
  work is the REBUILD, so an in-process driver optimizes the wrong axis AND erodes the one thing the smoke
  exists to exercise (the real packaged/global-install path). One build phase produces the tarball; every
  packaged smoke installs THAT artifact into its own fresh sandbox and runs its own assertions — semantics
  and coverage unchanged, only the redundant rebuild removed.
  Suite side: the tail is subprocess wall in a few audit integration files, not isolation overhead, so
  `pool:'threads'` / `isolate:false` will not help — the lever is the sharding already shipped, plus
  possibly splitting the 100s+ files across more shards (verify per-file: many tests spawn/mutate fs, so
  isolation-off risks bleed). Live numbers are in `.audit-tools-profile/*-history.ndjson`, never here.

- **Dispatch admission-control rework — two residuals (env-bound / architectural, not blocking).** The
  rework shipped; the design of record is
  [`spec/dispatch-quota.md`](../../spec/dispatch-quota.md)
  ([[capability-is-per-auditor-not-per-audit]] / [[dispatch-admission-control-design]]) — read it for
  what landed, not `docs/HANDOFF.md` (immediate-next-only by design; the "T5 forward tracks" section
  this entry used to point at is long gone).
  - (a) **live validation** of a real host+codex+NIM concurrent run — a metered multi-pool run
    confirming the folded-in backend source pools actually fan out alongside the conversation host.
    ⚠ Correcting this entry's own wording: there is no "demoted backend" any more. The H2+H4 collapse
    retired the demote flag — the configured primary in-process backend is ALWAYS folded in as an
    ordinary source pool (`primaryInProcessSource`, `src/shared/quota/apiPool.ts`;
    `buildAuditSourcePools`, `src/audit/cli/hybridDispatch.ts`). Folds into the quota-aware-dispatch
    live-run watch below.
  - (b) **Deeper simultaneity — verified at HEAD, architectural.** The audit hybrid path AWAITS the
    in-process (codex/NIM) partition to completion inside one `next-step` turn
    (`driveRollingAuditDispatch` in `runHostDelegationObligation`,
    `src/audit/cli/nextStepHelpers.ts`), and only then emits the host-review packet over the
    coverage-driven complement (`ensureSemanticReviewRun`, same function) — so host and backend
    alternate ACROSS turns, never simultaneously WITHIN one. True within-turn simultaneity needs a
    detached background driver spanning host turns; only pursue if wall-clock on a real run shows the
    alternation is the bottleneck.

- **Quota-aware dispatch — live validation env-bound.** Still open: live validation of the token-budget
  dispatch gate (per-`(pool,window-label)` learned tokens-per-percent slope, budget = MIN across a
  pool's windows, quota-death = retryable pause preserving worktrees) on a real rate-limited
  multi-worker run — cold-start calibration slope + the resume path especially want a live check.
  Relates to [[claude-usage-endpoint-body-shape]] / [[claude-quota-credential-resolution]] /
  [[cross-provider-quota-matrix]] / [[quota-dispatch-vision]].
  - **⬇ Live-run watch** (a metered provider + large target is the exerciser — the run itself hits the
    wall; `AUDIT_TOOLS_LIVE_QUOTA=1` only enables the live-credential test probe, it does not force a
    production wall): at the
    rate wall the run must **pause gracefully, not crash**, and leave every in-flight worktree intact; on
    resume it continues from the pause with no lost/redone work. Early on, the tokens-per-percent slope
    should *learn* (dispatch pacing adjusts after the first window reading) rather than stay at the
    cold-start default. FAIL = crash/stall at the wall, discarded worktrees, or a resume that re-does or
    drops packets.

- **SPEC — a ledger-blocked retry must back off, reusing the ONE backoff the project already owns.** A
  crashed sibling's orphan lease can block a packet for the full lease TTL (20 min). Waiting is CORRECT —
  it never double-grants — but the run loop retries on a fixed interval throughout, hammering the ledger's
  read-modify-write under a file lock once per pending packet (~24k lock cycles worst case). ⚠ Correcting
  this entry's earlier attribution: the retry interval is a bare `50` literal in the dispatch loop, not
  the named lease-TTL constant, so it is invisible to anyone grepping for a tuning knob.
  **Property to hold:** a retry blocked on a resource nobody has released does not poll at a fixed rate.
  Reuse the existing exponential backoff already single-sourced in the file-lock helper rather than
  introducing a second backoff implementation — the project's rule is one core, not two mechanisms that
  drift. Efficiency-only; never trade away the wait-rather-than-double-grant property to get it.
  ⚠ Heartbeat-renewed short leases would also solve it and restore fast crash recovery, but that is the
  long-claims heartbeat design, which carries its own unresolved question about who beats during an
  out-of-process worker run. Do not couple this to it — backoff stands alone and is strictly simpler.

- **Friction detection — M-QUOTA escalation chain: remediate-side friction assertion missing; live validation env-bound.** The
  `recordLimit → escalate → strand → quota_escalation friction` chain is WIRED on both drivers —
  `src/audit/cli/rollingAuditDispatch.ts` and `src/remediate/steps/nextStep.ts` both route
  `onEscalation` into the single `captureStepBoundaryFriction` chokepoint. Coverage is ASYMMETRIC, not
  end-to-end on both: the shared engine half (recordLimit → escalate → early strand, pool N+1 never
  attempted) is pinned in `tests/shared/rollingDispatch.test.ts` with NO friction assertion, and only
  the AUDIT driver's full chain through to the written `friction/<runId>.json` record is pinned
  (`tests/audit/rolling-audit-dispatch.test.ts` §5). Nothing under `tests/remediate` asserts a
  `quota_escalation` friction — `tests/remediate/quota-scheduler.test.ts` pins only the
  `HostSessionQuotaSource` escalation unit. Two open halves: **(a) bounded** — add the remediate parity
  test (`driveRollingImplementDispatch` with `poolsOverride` of ≥4 pools and a `dispatchNode` returning
  `rate_limited` with a parseable session-limit string; assert a `quota_escalation:` friction in
  `friction/<runId>.json`), red-green by deleting the `onEscalation` block at `nextStep.ts`;
  **(b) live validation** on a real rate-limited run stays env-bound. [[meta-audit-friction-must-be-tool-enforced]]
  - **⬇ Live-run watch** (same wall run as quota-aware dispatch): when a packet escalates across pools at
    the wall, a **`quota_escalation` friction event** must be captured at the step boundary — check the
    run's friction log / meta-audit surface after the run and confirm the event is present with the
    escalated packet id. FAIL = wall hit but no friction event recorded (the chain didn't fire live).

- **Selective-deepening convergence — live validation env-bound.** Both known convergence loops have
  shipped tool-side fixes. (1) *Round collision:* a deepening/steward result folds its `task_id` into the
  content discriminator (`src/shared/contentKey.ts#baseDiscriminator`) — an absent task_id THROWS rather
  than minting the colliding bare `deepening` key, and the union type requires it at compile time — so
  each round gets a distinct `idempotency_key` while a genuine same-task_id replay still no-ops (INV-2).
  (2) *Packet-keyed answer:* a worker that stamps the synthetic packet_id is rebound MECHANICALLY at
  ingest (`rebindPacketIdKeyedResult`, `src/audit/cli/mergeAndIngestCommand.ts`), which forces all four
  identity fields from the assigned member and refuses to guess when ≠1 member is outstanding — the
  `packetPrompt.ts` "MUST be exactly … do NOT use the packet_id" directive is now the belt, not the
  braces. A third variant (worker omits per-finding `lens` → hard reject → re-queue forever) is closed by
  `defaultFindingLensFromResult` (`src/audit/validation/auditResults.ts`). Unit-covered:
  `tests/audit/content-key-seam.test.ts`, `tests/audit/ledger.test.ts`,
  `tests/audit/idempotency-sibling-collision.test.ts`. **Still open:** confirmation on a real
  deepening-capable run. If a run wedges, the recovery is `audit-code force-synthesis` (stamps a
  tool-owned `operator_forced` terminal over the pending ids and synthesizes from the intact ledger) —
  never hand-edit gitignored run state, which the state machine overwrites and which cascades stale
  `planning_artifacts`.
  - **⬇ Live-run watch** (any audit whose findings trigger deepening — i.e. low-confidence/high-risk areas
    that spawn `deepening:*` tasks): every `deepening:*` task must **converge and complete** within a bounded
    number of rounds; the run reaches synthesis on its own. FAIL = orphaned pending `deepening:*` tasks, the
    same finding re-deepened every round (idempotency collision), or the run only finishing via
    `force-synthesis`. If you hit it, run `force-synthesis` to unwedge and note the round count here.
- **A design-review auto-complete is now RECORDED but not yet CONSUMED — the stamped half shipped,
  the acting half is open.** An auto-completed/quota-skipped pass stamps
  `contract_auto_completed`/`conceptual_auto_completed` on the assessment (cleared on genuine ingest,
  carried across re-extraction), so a vacuous green is distinguishable ON THE ARTIFACT. Still open:
  no consumer reads the stamp — synthesis and obligation derivation act only on the `*_reviewed`
  booleans, so an auto-completed-empty pass still flows downstream silently. **Property to hold:**
  synthesis blocks or loudly annotates when a pass it consumes carries the auto-completed stamp.
  Lifted from `spec/contract-authoring-determinism-design.md`; its S8 section states the design.

- **`goal_id` is read verbatim off the LLM envelope, so its format is unvalidated (re-verified at HEAD
  2026-07-25).** The rest of ID minting is routed through the one registry:
  obligation ids now mint through `obligationId`/`moduleSlug` in
  `src/remediate/contractPipeline/idRegistry.ts` (the encoder and its phase/write-scope decoders were two
  identical implementations plus a "MUST stay in lockstep" comment), and uniqueness is the shared
  `mintUniqueId`. What is left: `goal_id` is not minted at all — it is read verbatim off the LLM envelope
  (`derive.ts`), so its FORMAT is unvalidated. **Property to hold:** an id the tool relies on is either
  minted by the registry or validated on the way in.
