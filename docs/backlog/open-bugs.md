# Open bugs & frictions

> Fixable defects and friction. Fix in tooling — never "the host remembers".
>
> Part of the split backlog — index: [`docs/backlog.md`](../backlog.md).
> A living to-do list, not a status log. Remove an entry once it ships; record durable
> contracts and rationale in project memory or `CLAUDE.md`, never "where the code is today".


- **A contract change swept `tests/` and missed the PRODUCERS in `scripts/` — caught only by CI
  (2026-07-25, medium, friction: inefficient-feeding).** Adding `reviewed_clean`, the fixture sweep
  globbed `tests/**` and went green four ways locally; two synthetic-result generators lived in
  `scripts/audit/smoke-{packaged,linked}-audit-code.mjs`, so `verify:checks` — which the pre-commit hook
  does NOT run — failed release CI ([[lap-green-must-match-ci-evidence]]). **Narrowed 2026-07-25:** the
  two generators are now ONE, in `scripts/audit/smoke-audit-flow.mjs`, whose docblock states the rule at
  the construction site. What stays open is the general property: the files a contract sweep must cover
  are derivable from the contract (every construction site of the type), not from where tests live — and
  nothing enforces that. Until then run `verify:checks`, not `check`, before pushing a validated-shape
  change.

- **Backlog prose paraphrased an incident in a way that INVERTED its mechanism, costing a wrong
  implementation (2026-07-24, medium, friction: ambiguous-direction).** The partial-wave entry said
  "M dispatched-but-in-flight" and asserted entanglement with the claim-lease machinery; the primary
  record ([`re-dogfood-2026-07-21.md`](reviews/re-dogfood-2026-07-21.md) #14 + the run-state section)
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

- **CLI-worker write-scope — four accepted residuals of the SHIPPED review-snapshot worktree
  (2026-07-22, low, revisit on live evidence only).** The enforcement itself is closed and
  single-homed: mechanism + rationale live in `src/shared/providers/reviewSnapshot.ts`'s docblock and
  [`re-dogfood-friction-2026-07-22.md`](reviews/re-dogfood-friction-2026-07-22.md) #8, contract-tested
  in `tests/shared/review-snapshot.test.mjs`. What stays open: (a) git REFS are shared through the
  worktree link — a hostile worker can still `branch -D` / `push` / `gc` shared state (git refuses
  deleting a branch checked out in any worktree and push needs creds, so this is far narrower than the
  checkout-to-main incident class); (b) on a DIRTY tree workers review HEAD while `file_line_counts`
  hints are stamped from the real tree, and the ingest net is TWO-tier, not a flat reject: only a
  divergence past BOTH `LINE_COUNT_DIVERGENCE_ABS_FLOOR` and `_RATIO` hard-rejects
  (`auditResults.ts:29-43,:820-844`); a smaller one is an advisory warning +
  `coverage_total_lines_mismatch` friction and the result IS ingested
  (`mergeAndIngestCommand.ts:539-560`), leaving HEAD-vs-dirt drift to be caught only by quote
  grounding — which runs against the real root (`:784`) and marks such findings `ungrounded`, i.e.
  surfaced, not dropped. Accepted because audits normally run on committed state; (c) a transient
  `worktree add` failure on a genuine git root degrades identically to the non-git case (same stderr +
  high-severity `write_scope_degraded` record) — `createReviewSnapshot` already runs the git-root probe
  separately, so a discriminated reason is available if it ever fires live; (d) one `git worktree add`
  per dispatching drive (memoized per dispatcher, removed in the drive's `finally`) — reuse keyed on
  HEAD sha if the cost ever bites on a large repo.

- **FLW-COR-003 claim-release livelock — SHIPPED except one low residual (2026-07-22; downgraded from
  HIGH after a 2026-07-24 code trace).** The in-process rolling driver sweeps its claims at drive end
  and on the empty-plan round (`releaseOwnedTaskClaims`, commit `681df1f5`).
  ⚠ **The "release on EVERY path that claims" property is REFUTED at HEAD (2026-07-25) — do NOT
  implement it.** The shared claim site already sweeps the over-claim (`dispatch.ts:481-492`), leaving
  only the EMITTED in-flight set — which is exactly what the lease is FOR (`dispatch.ts:129-135`: the
  claim spans an out-of-process worker run with no heartbeat, and `prepare-dispatch` returns before the
  workers run, so "the workers all died" is never observable host-side). And merge already releases the
  whole `failing` set including attempted-but-missing (`mergeAndIngestCommand.ts:885-909`); only
  `deferred` is deliberately retained. Same inversion this file recorded at its 2026-07-18 friction walk.
  **What remains (low):** an attempted-and-dead host round holds its emitted claims until a merge runs,
  bounded by the lease — designed behaviour; revisit only on live evidence of the lease outliving a dead
  round. The "zero-granted round pauses the drain" half is VERIFIED HOLDING; nothing open. Record:
  [`re-dogfood-endgame-2026-07-22.md`](reviews/re-dogfood-endgame-2026-07-22.md).

- **LEAD (2026-07-23, low, surfaced by the shipped worker-kind × pool-class rule): a
  `burst_limited` proxy contributes NOTHING — populate/expansion should emit single-shot lanes
  instead of agentic ones that all drop.** The rule itself SHIPPED 2026-07-23 (declared
  `burst_limited` on sources + proxy block; `laneWorkerKindConflict` enforced per-lane in
  `resolveAmbientSources` and at the `collectDispatchableSources` chokepoint; `deriveWorkerKind`
  fixed-kind transports made override-proof; LiteLLM same-tier `router_settings.fallbacks`
  configured — mechanism + review record:
  [`worker-kind-pool-class-rule-2026-07-23.md`](reviews/worker-kind-pool-class-rule-2026-07-23.md)).
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
  decay into boilerplate (`validateResultFindings`; pinned in `validation-remediation.test.mjs`). That
  separates a BROKEN lane from a weak one — what made the agy 0-for-2 unreadable. (2) **A2 oracle
  UNPARKED** so yield can gate eligibility against ground truth ([`deferred.md`](deferred.md)).
  (3) **Widen the deepening net** to low-priority zero-finding results — OPEN, wants (2)'s calibration
  for the threshold. Record:
  [`re-dogfood-friction-2026-07-22.md`](reviews/re-dogfood-friction-2026-07-22.md) #4c/#4d.
- **RESIDUAL of the shipped DD-9 + charter slice-staleness pair (2026-07-23, low, accepted —
  revisit on live evidence).** The pair itself SHIPPED (intent-equivalence gate wired as the
  `intent_equivalence_current` obligation — `nextStep.ts` PRIORITY slot between
  `intent_checkpoint_current` and `charter_extraction_current` — with
  `artifact_metadata.intent_baseline` as the intent entry's revision authority; per-edge dependency
  slices for `charter_register.json` in `src/audit/orchestrator/dependencySlices.ts`; mechanism
  record: [`intent-gate-charter-slice-design-2026-07-23.md`](reviews/intent-gate-charter-slice-design-2026-07-23.md)).
  Accepted residuals:
  (a) over-stale: `charter_clarification` / `systemic_challenge` keep WHOLE-ARTIFACT
  `repo_manifest` edges (`dependencyMap.ts:119,:131`; `DEPENDENCY_SLICE_PROJECTIONS` registers
  `charter_register.json` alone) — a member slice was REFUTED for challenge at HEAD (it consumes the
  total file count and grounds against the complete path set) and clarification's consumption is
  unverified; they still re-fire on unrelated manifest churn (cheap steps). Slicing them needs a
  verified consumption trace first. (b) under-stale, and NARROWER than the first draft of this entry
  claimed: `charterReadFileSlice` compares content for consensus members ∪ every `isDocIntentFile`
  path (`doc_only` status **OR** `.md/.markdown/.adoc/.rst/.txt` — single-sourced at
  `buildStructureDecomposition.ts:31` so it can never be narrower than the decomposition's own doc
  universe; pinned by `tests/audit/dependency-slices.test.mjs`), PLUS the complete sorted path list,
  so every add / delete / rename fires regardless of classification. What stays outside is a
  content-only edit to a file that is neither a consensus member nor doc-extensioned nor `doc_only`
  — e.g. spec prose living inside a `.ts` the Stated pass reads. Widen `charterReadFileSlice` if a
  live run shows it. (c) over-cost: a revert pair (intent A→B judged, then B→A) re-pays one judge
  round — verdicts are materialized into the baseline (`intentEquivalenceExecutor.ts`), never cached
  per-pair.

- **⬇ LIVE (re-dogfood 2026-07-22, medium): a worker self-reported "valid, verified" on a
  malformed-JSON result file — result validity must be checked mechanically, never trusted from
  the worker's claim.** The merge correctly rejected it, but the failure surfaced only as an
  unexplained same-packet re-grant. Properties: (a) results are parse- and
  AuditResult-contract-checked at result-write or pre-merge; (b) the merge's "missing or invalid"
  names WHICH per task (file absent vs parse error vs contract mismatch). Record:
  [`re-dogfood-friction-2026-07-22.md`](reviews/re-dogfood-friction-2026-07-22.md) #12.

- **⬇ LIVE (re-dogfood 2026-07-22, low): a json_schema-required array elicits FILLER entries from
  weaker models when the true answer is empty.** Two of four delta-mining calls (minimax-m3)
  emitted a "delta" whose summary literally said "genuinely agrees — surfaced to document the
  negative finding", despite an explicit skip instruction; pruned host-side before submit (host
  discretion). Delta ingest routes deltas as WORK, so a filler row becomes a dispatched no-op.
  ⚠ **The "negative-finding lint at ingest" candidate is REFUTED (built + reverted 2026-07-25).** A
  regex classifier over summaries measured 8 false DROPS and 5 false KEEPS on ~25 realistic inputs; a
  dropped delta never reaches synthesis, so it fails silently and worse than the filler it replaces.
  Take the mechanical route: **a schema-legal `no_deltas: true` / explicitly-empty submission path**,
  so a model can say "none" without inventing a row.
  ⚠ **The AUDIT-RESULT half of this shipped 2026-07-25** as `reviewed_clean` (see the success-shaped-empty
  entry above) and is the pattern to copy. The DELTA path is untouched and is the sharper case:
  `charterDeltaExecutor.ts:36-63` treats a MISSING submission and an explicitly-empty one identically
  ("no submission supplied; settled the register with no deltas"), so a dead miner and a clean one are
  indistinguishable. `CharterDeltaSubmissionSchema` is `.strict()`, so the affirmation must be added to
  the schema rather than passed through. Record:
  [`re-dogfood-friction-2026-07-22.md`](reviews/re-dogfood-friction-2026-07-22.md) #4.

- **⬇ LIVE (re-dogfood 2026-07-22, low, medium-difficulty — an ATTEMPTED fix was reverted 2026-07-25):
  completion cleanup removes the friction dir before the session stop-gate's close-out walk runs
  against it.** Ordering property: the close-out walk is part of run completion — cleanup preserves
  (or the close step completes) the friction record before archiving. Record:
  [`re-dogfood-friction-2026-07-22.md`](reviews/re-dogfood-friction-2026-07-22.md) #13.
  ⚠ **Three findings from the reverted attempt — a naive "exempt friction/ from the rm" does NOT work
  and introduces a regression.** (1) The audit half's completion cleanup is `promoteFinalAuditReport`
  (`src/audit/io/artifacts.ts:465`, called from `nextStepHelpers.ts:417` and
  `advanceAuditCommand.ts:69,105`), NOT `cleanupStaleArtifactsDir` — the latter runs at the START of
  the next advance, so patching it changes nothing at completion. (2) The remediate half's stop-gate is
  MARKER-gated: `.claude/hooks/friction-stop-gate.mjs` requires a recent `state.json` before it reads
  `friction/` at all, and a fully-green close deletes `state.json` — so preserving the record alone
  still leaves the gate skipping the area. (3) Preserving `friction/` across cleanups REGRESSES the
  audit side, where the run id is the hardcoded literal `"run"` (`nextStepHelpers.ts:416,:2696`,
  `executorRunners.ts:223`, `operatorHandoff.ts:381`): every run shares one `friction/run.json`, so a
  prior run's complete record permanently satisfies both the blocking close-out and the hook's
  `anyComplete` check. A real fix must address the run-id collision first.

- **LEAD (2026-07-22, low): does remediate's node-claim lifecycle share the merge-only-release
  defect the audit side just fixed?** Audit's completion livelock (claims released only at merge →
  failed rounds starve every later runId for the 20-min lease) is fixed by `releaseOwned` at drive
  end. Remediate claims implement nodes through its own registry (`rollingSession.ts`,
  `acceptNode.ts`) with ONE release site visible (`rollingSession.ts:494`); verify whether a failed
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
  and cost-first routing (λ=0) would send every packet to it. `tests/shared/cost-rank.test.mjs` caught
  this as 11 failures on CI shard 1 (both Node versions); the pre-collision snapshot happens to carry
  anthropic's own prices, which is why the stale file looked correct. **The refresh is therefore
  gated on the second-order mismatch, not merely followed by it:** `byProvider` is keyed by models.dev
  VENDOR ids while both pricing sites pass `sourceService(source)` (`identity.ts`), so any lane whose
  service string is not a models.dev provider id misses the index and lands on the cheapest-reseller
  price. Fix the mapping FIRST, then refresh. ⚠ Do not "fix" this by updating the cost-rank
  expectations — they encode real Anthropic list prices and are the thing that caught it.
  Both halves were attempted and reverted in this lap (`548380df` → restored); nothing is
  half-applied at HEAD.

- **Stale agent worktrees are never pruned (2026-07-24, low, friction: tool-should-decide).**
  Worktrees survive from prior agent runs, plus unregistered orphan dirs. **Cleared by hand 2026-07-24 —
  the MECHANISM is still missing**, so it recurs on the next agent run.
  Property: a completed worktree is reaped by whatever created it, or by a periodic prune over those whose
  HEAD is an ancestor of `main` with a clean tree.
  ⚠ **Not every stale worktree is a duplicate**, so a blanket `git worktree remove` without the
  ancestor+clean check silently destroys work: of four cleared by hand three were ancestors of `main`,
  the fourth a superseded ALTERNATIVE kept as `archive/nodehttpfetch-alternative-9820b7e9`.
  ⚠ The entry's original "their `dist/` pollutes every repo-wide grep" clause was **FALSIFIED**
  (2026-07-24, two probes): those paths are all gitignored, so `rg`/`git grep` cannot see them. The
  surviving lesson is a search-tool trap, now in [`durable-traps.md`](durable-traps.md).

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
- **⬇ LIVE-CONFIRMED (re-dogfood 2026-07-21): the proxy-lane drop reason names an internal function,
  and no populate command exists (medium, friction: tool-should-decide).** First `next-step` of the
  v0.34.6 self-audit dropped the proxy lane with "run the populate (populateProxyCatalog)" — not a
  runnable command (`audit-code --help` lists none). Confirms the existing freshness/refresh entry's
  (b) verbatim. NEW second finding: the cache was INVALIDATED BY THE IDENTITY MIGRATION — the on-disk
  v1 cache carried the pre-rename `provider` field, the shape-version bump correctly degraded it to
  absent, but nothing regenerates it and the operator remedy was importing `populateProxyCatalog`
  from dist by hand. Property: a tool-written, fully-regenerable cache that shape-degrades must be
  REGENERATED by the tool at the next natural boundary (Gate-0 build), not reported as the operator's
  problem. (The third observation from this call — `api_key_env` accepting `"NAME=value"` — is
  SHIPPED: `apiKeyEnvReachReason` now owns the name-shape + env-is-set pair for every reader.)

- **⬇ LIVE (re-dogfood): token_usage stamping asks for a split real harnesses cannot supply
  (2026-07-21, low).** The dispatch prompt wants per-result `{input_tokens, output_tokens}`; Claude
  Code's subagent tool reports only a TOTAL. An honest host must skip the stamp, so calibration
  stays at cold-start batches (3, then 2, of 62 — observed). Accept `{total_tokens}` and calibrate
  on it. Record: [`re-dogfood-2026-07-21.md`](reviews/re-dogfood-2026-07-21.md).

- **LEAD (re-dogfood): systemic-challenge round counter + banked improvements carry across RUNS
  (2026-07-21, low).** This run's challenge arrived as "round 10" with 11 prior improvements from
  earlier sessions' artifacts. Verify intended (cross-run loop state vs per-run reset). Record:
  [`re-dogfood-2026-07-21.md`](reviews/re-dogfood-2026-07-21.md).

- **SPEC — delete inline `api_key` support; a credential must be named, never pasted.** Account identity
  compares `(endpoint, credential REFERENCE)`, so a source naming its key through an env var and a
  sibling pasting that same key inline resolve to two accounts and each meters a full allowance — a 2×
  over-admission of the main metering defect's class. Hashing the credential VALUE to unify them is
  refused on purpose: identity would then change on every key rotation, orphaning ledger state and
  learned slopes for what is still one account. An explicit operator-declared `account` on both siblings
  already overrides the derivation and unifies them, but that is a workaround the operator must know to
  apply — the wrong thing stays possible.
  **The resolution is to remove the second way of expressing a credential.** Inline `api_key` is already
  documented as discouraged, there are no external consumers, and under the no-legacy rule a discouraged
  duplicate path is simply deleted rather than defended. With one representation, two references to one
  credential cannot disagree — the defect becomes unrepresentable rather than detected.
  **Property to hold:** a credential is identified by reference only, and there is exactly one way to
  declare one. Secrets also stop landing in declaration files as a side effect.

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
  ([`account-metering-round2-independent-review-2026-07-19.md`](reviews/account-metering-round2-independent-review-2026-07-19.md),
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
  operator-runnable refresh.** A day-old cache whose roster no longer matched the running proxy was
  served silently, and deleting the cache dropped the whole proxy lane with a reason naming an internal
  FUNCTION rather than any command the operator could run. ⚠ Correcting this entry's earlier claim that
  there is "no TTL": a 10-minute TTL DOES exist, but it only decides whether the populate step re-fetches.
  The read path deliberately accepts cached data of any age. So the freshness concept is present and
  applied on exactly the wrong side.
  ⚠ **Half SHIPPED 2026-07-25 and the shipped half is WRITE-ONLY.** `readProxyCatalog` derives
  `age_ms`/`stale`/`stale_reason` and refuses an unparseable `fetched_at`, but nothing branches on the
  verdict: `populateProxyCatalogIfMissing` (`auditorSources.ts:354`) still short-circuits on a cache of
  ANY age and `resolveProxyLane` (`:653`) folds sources in without surfacing `stale_reason`. Give the
  follow-up `auditorSources.ts`, or this reads closed while unchanged
  ([[write-only-data-looks-authoritative]]).
  **Two properties to hold:** (a) the age rule applies where staleness does damage — the read path either
  revalidates against the live roster or surfaces the cache's age rather than presenting stale data as
  current; (b) every drop reason names an action the operator can actually take, which requires that such
  an action EXIST — today no populate/refresh command is reachable from the CLI at all, so the reason has
  nothing true to name. Fix the missing command first; the reason text is downstream of it.
  Same family as the `dropped[]`-not-surfaced entry below.
  **Live-reconfirmed 2026-07-22 (00:4x):** the cache sat 3.5h past its 10-min TTL and was served
  stale on every pool build (1 source, glm-5.2 only); an operator `top_k` change had zero effect
  until `populateProxyCatalog` was hand-imported from dist with `force:true` — (a)+(b) verbatim.
  New data point: this stale-read path is what recreated the zero-spill state (host-only pools
  while glm cooled) — the two entries share a mechanism. Also observed on the same call: the
  engine's drain re-stormed cooling glm to 143 consecutive 429s, so wave-3 pre-wall pacing from
  learned limits is still not happening on a single-model pool.

- **Ranked-pool composition — live-wave watch + the absolute-floor question (mechanism shipped R3-3
  `c0cf7e9b` 2026-07-21; residue only).** ⬇ **Blocked on a real wave.** (a) The composition prediction
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
  Records: [`capability-evidence-salvage-2026-07-20.md`](reviews/capability-evidence-salvage-2026-07-20.md)
  (landing gate MET carries the full mechanism),
  [`nim-dispatch-single-pool-2026-07-19.md`](reviews/nim-dispatch-single-pool-2026-07-19.md).

- **H2+H4 collapse residual pins (2026-07-18, low, from review h2c3).** (a) The attended same-agent
  SPLIT semantics (blessed in the plan record: engine partition + host-subagent remainder on one meter,
  replacing HEAD's whole-frontier monopoly) is pinned only at pool-composition level — add a
  decision-point-level test asserting where the frontier is actually driven; fold the DC-4
  settled-pool `poolsOverride` filter into the same harness. (b) The env-DETECTED same-agent path
  (`CODEX_THREAD_ID` → `resolveConversationHostProvider` → dedup) lost its end-to-end pin when
  `demote-same-agent-guard.test.mjs` died; the new D1 tests use explicit `host_provider` only.

- **Pre-existing back-compat fold survives, now against standing policy (2026-07-18, low).** `src/shared/quota/apiPool.ts` (~370-371, ~497-498) and `src/shared/types/sessionConfig.ts` (~700-701) fold in a "legacy `openai_compatible` block ... for back-compat". Deliberately kept OUT of the swap commit to preserve the atomic replace. Property: under the owner's no-legacy rule this fold should be deleted and the block treated as a plain source declaration.

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

- **The open-work record is navigable in bounded reads via a GENERATED seek index — the remaining sliver is the skill that still says "read it in full" (2026-07-25, low).** The size question is SETTLED: owner chose a generated index over a split, because `docs/documentation-philosophy.md` §*The condensation bias* argues against splitting for size and every split file would owe a routing row in `docs/doc-review-guidelines.md`. `scripts/shared/generate-backlog-index.mjs` now emits a `file:line` anchor per entry into `docs/backlog.md`, gated by `check:backlog-index` in `verify:checks` AND at commit (anchors move under every backlog edit, and a stale anchor sends the reader to confidently wrong prose). **What stays open:** `.claude/skills/disambiguate-backlog/SKILL.md` step 1 still instructs "Read every file under `docs/backlog/` in full", which no longer executes in one call — it should read the index and then seek. Pruning aggressively is still the wrong fix: entries earn their length, and the 2026-07-19 classification showed stale entries survive precisely because nobody can hold the file at once.

> **Friction-walk entry template:** one line per friction — a bold title + the `[[memory-tag]]` for the
> durable lesson + only the still-OPEN tool sliver(s). No shipped-work narrative or changelog prose (that
> lives in git log / memory). Condense at write time, not in a later doc-review pass. The `[[memory-tag]]`
> appears only where a durable memory concept was actually captured for that item — by design, not every
> entry has one.

- **Friction walk (duplicated-guard lap, 2026-07-25):** (1) **inefficient-feeding (medium):** the
  triage's per-entry `Paths:` are MODEL-INVENTED for entries whose prose names no file —
  `src/scheduler/populate.ts`, `src/review/mapCache.ts`, `src/pinning-gate.ts` and others do not exist —
  so a path column that reads like evidence is a routing guess. Two of the three entries worked this lap
  had to be located by grep anyway. Property: a generated triage should emit a path only when it can be
  resolved against the tree, and mark the rest `unresolved`. (2) **tool-should-decide (low):** the
  backlog seek-index and the HANDOFF roadmap are two separate generators, each with its own commit-gate
  refusal, so a single backlog edit costs two blocked commits to learn both are stale. One `npm run
  regen:docs` (or one gate naming both) would make it one round-trip. (3) **ambiguous-direction:** none
  this lap.

- **Friction walk (smoke-dedup lap, 2026-07-25):** (1) **tool-should-decide (medium):**
  `smoke:linked-audit-code` is in no gate — `verify:checks` runs only the packaged smokes — so it had
  drifted BROKEN at HEAD unnoticed: its finalize loop returned at `present_report` status `ready` and
  then asserted `complete`, because the friction-attestation branch was added to the packaged copy only.
  A script that is never run is not a gate; it is a doc that claims to be one. Property: every
  `smoke:*` npm script belongs to some gate, or is deleted. (2) **inefficient-feeding (low):** the two
  audit smokes were 1,910 lines at ~90% duplication, so answering "what does the smoke flow assert"
  cost two full-file reads of near-identical text. Now single-homed in
  `scripts/audit/smoke-audit-flow.mjs` (+ `scripts/shared/{smoke-process,spawn-shell}.mjs`); the win32
  spawn shim went from FIVE identical copies to one. (3) **ambiguous-direction:** none this lap.

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
  (3) **tool-should-decide (guard defect) — FIXED, mechanism in the code + `hook-trap-guards.test.mjs`.**
  A guard's advertised escape must work in the form it advertises: all three `shell-trap-guard` bypasses
  read the HOOK's env, so an inline prefix never reached them. Now one `bypassEnabled` helper. The fix's
  live check then found the sharper half — the guard's own harness inherited `process.env`, so a bypass
  exported in the shell disabled the rule under test; the harness scrubs them now. Same class as the
  ambient-`PATH` red in [`durable-traps.md`](durable-traps.md).
  (4) **ambiguous-direction (low):** three entries worked this lap had premises already fixed at HEAD
  (`api_key_env` type narrowing, the leaked tool-call XML, the doc-path typo) — the standing
  verify-against-HEAD rule caught them, but only after each was opened. The triage lane cannot check
  HEAD, so its `actionable_now` verdict is a routing signal and never a work order.
  [[backlog-prose-decays-verify-against-head]]

- **Friction walk (backlog clear-out lap, 2026-07-24):** (1) **ambiguous-direction (medium, two
  instances, same class):** two entries had paraphrased their own incident until the MECHANISM
  inverted, and each would have produced a wrong fix if worked from the entry alone — FLW-COR-003
  prescribed "release claims on every path that claims" when the lease must SPAN out-of-process
  workers (`dispatch.ts:129-136`), and the `analyzerDeps` entry reported a live `npm install` that
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

- **Self-audit dogfood loop: fixing the tool mid-run invalidates the run (claude-worker dogfood 2026-07-16, ambiguous-direction, low-medium).** The dispatch-blocking defect was found BY the run, and committing its fix changed the audited tree → staleness cascade correctly marked the whole planning chain stale → the 313-packet run regressed to charter_extraction, so every LLM planning step re-runs before dispatch is reattempted. Semantics are right (DAG is truth); the cost is structural to dogfooding-by-self-audit. Two tool slivers worth considering: (a) the resume emitted ~30 identical `{"kind":"staleness",...}` lines in one invocation (recompute spin — dedupe the log line per drain); (b) an active run whose frontier goes stale could say so explicitly ("run X invalidated by upstream staleness: <artifacts>") instead of silently re-planning from charter_extraction with run_id null.
  **SPEC — keep the cascade, ANNOUNCE it. Do not narrow staleness to make dogfooding cheaper.** The
  regression to first-planning-step is correct: the audited tree changed, so the planning derived from it
  is genuinely invalid, and the dependency graph is the source of truth. Any mechanism that spares a
  self-audit run from its own cascade would be special-casing the tool's convenience against the
  correctness rule the whole design rests on.
  What is actually wrong is that a large, expensive, correct action happens SILENTLY and looks like
  malfunction. The run should state that it was invalidated, by which upstream artifacts, and what it is
  therefore re-deriving — one message, at the moment it happens. The duplicated staleness log lines are
  the same defect in miniature: repeated identical output in place of one clear statement.
  **Property to hold:** an expensive automatic recovery explains itself at the moment it triggers. A user
  who cannot tell a correct cascade from a wedge will eventually defeat the cascade.

- **A stale prior-run shared confirmation suppresses the proxy populate trigger while Gate-0 still pends (claude-worker dogfood 2026-07-16, tool-should-decide, medium).** The 3c populate trigger (`nextStepCommand.ts:430`) keys on `readSharedProviderConfirmation(root) === null`, but the Gate-0 obligation keys on the per-tool seam — so a leftover `.audit-tools/provider-confirmation.json` from an ABANDONED prior run (yesterday's dogfood) silently skipped populate on a fresh run whose Gate-0 was still being emitted, and the lane dropped as "cache absent". Same split-artifact class as the reconciliation-gate entry below. Property to hold: the populate trigger and the Gate-0 obligation must key on the same confirmation artifact (or a fresh run must not inherit an abandoned run's confirmation). Diagnosis cost: the populate's `.catch(() => null)` is silent AND the skip-branch prints nothing, so "cache absent" pointed at the wrong half.

- **`AGENTIC_WORKER_HARNESS_OVERHEAD_TOKENS = 15_000` is an unmeasured estimate, and the lane cannot currently measure it (low, live-gated; the rest of the 2026-07-17 feedback-gap residuals are closed — plan `docs/reviews/claude-worker-feedback-gaps-plan-2026-07-17.md`).** The constant (`src/shared/quota/capacity.ts`) is added to every packet estimate at all three fit gates (`dispatch/coordinator.ts`, `rollingDispatch.ts` partition + selection, `cli/dispatch.ts` budget clamp), so a wrong value silently mis-sizes every agentic pool in both directions. The measurement basis now exists — per-packet `input_tokens` in `token-usage.jsonl` (`src/shared/io/tokenUsageLedger.ts`) minus the packet's local `estimateTokensFromBytes` — but `ClaudeWorkerProvider.launch` spawns `claude -p --model <alias>` with no `--output-format json` and never populates `LaunchFreshSessionResult.observedUsage`, so every claude-worker line records `input_tokens: null` ("unmeasured", deliberately not 0). Two moves to close: teach the lane to report usage (parse the CLI's JSON envelope into `observedUsage`; the stdout failure-classification scan must keep matching through the envelope), then calibrate the constant against a real run. Still true from the same lap: a worker retries 429s inside its own lifetime (dogfood: 307 proxy-side vs 29 surfaced) — invisible to the parent; terminal classification → `cooldown_until` paces ACROSS workers only. Two former residuals are now closed and should not be re-derived — declared `quota.max_concurrent` IS consumed per-pool (`apiPool.ts` → `CapacityPool.concurrencyCap` → the engine's in-flight cap; no learned/free-tier default is wanted, [[concurrency-is-declared-or-absent-never-learned]]), and context caps are never absent (`resolveSourceContextWindowTokens` returns declared stamp → models.dev window → `DEFAULT_CONTEXT_TOKENS`, never null), so registry stamp coverage no longer gates anything — this box's LiteLLM registry advertises `capability_rank` and no context field, and populate's proxied lane fits correctly regardless. The old watch's run dir (`20260717T062404401Z…`) no longer exists; a fresh dogfood run is the evidence base. [[external-audit-catalogs-are-leads]]

- **claude-worker lane residuals — three symptoms of ONE defect: identity is decided somewhere other
  than where it is known (2026-07-16, low-medium, deferred deliberately).**
  (a) **Account axis unstampable.** `expandSources` (`proxyCatalog.ts`) stamps no `account`, and
  `ProxyDeclaration` has no field to add one, so an operator declaring `account` on a direct lane merely
  splits `nim#X/m` vs `nim/m` into two pools to one backend — reopening the double-grant boundary for
  that model. Needs a per-backend account map on the declaration.
  (b) **No READ-side TTL and no refresh command.** The populate-side throttle shipped
  (`POPULATE_CACHE_FRESH_TTL_MS`), but `readProxyCatalog` accepts `catalog-cache.json` at any age,
  `populateProxyCatalogIfMissing` is missing-only, and the explicit refresh still is not a command. The
  cache is machine-global while the populate trigger is per-repo-confirmation-keyed, so starting repo B
  rewrites the expansion repo A is resolving mid-run (additions gate-caught; removals silent by design).
  (c) **Intra-declaration duplicates.** `collectDispatchableSources` spreads `sessionConfig.sources`
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

- **A post-worker LANDING stage is still misfiled as dispatch — 2,845 of 5,978 lines under `src/remediate/steps/dispatch/`, plus marshal's merge half (owner question 2026-07-16, re-verified at HEAD 2026-07-24, medium).** `acceptNode.ts` (962) / `worktreeLifecycle.ts` (923) / `writeScope.ts` (496) / `verifyCommands.ts` (274) / `acceptReconcile.ts` (190) are not dispatch: `executeNodeInWorktree` (`acceptNode.ts:883`) is called only by the **driver** `driveRollingImplementDispatch` (`nextStep.ts:1130`, call at `:1346`), never by `prepareImplementDispatch` (`marshal.ts:234-513`), which ends having written `dispatch-plan.json` (`:426`) + `dispatch-quota.json` (`:510`). ⚠ Correcting the old entry's absolute: prepare is not worktree-*free* — it reaches two landing symbols, `ensureRemediationBranchCheckedOut` (`:342`) and `worktreePath` (`:405`, prompt rooting) — but it creates, verifies and merges nothing, so the stage boundary holds and those two imports are exactly what an import-graph test would catch. They live under `dispatch/` only because the barrel (`dispatch.ts:49-136`) aggregated them; `acceptNodeWorktree` even takes a base-branch lock (`acceptNode.ts:434`) — pure serialization, zero dispatch content. `marshal.ts` itself fuses two stages: prepare (`:234-513`) and the landing merge `mergeImplementResults` (`:596-1561`). Symmetrically on the audit side, `prepareDispatchArtifacts` (`src/audit/cli/dispatch.ts:187-881`) both *decides* and *renders the prompt* — lens defs (`:293-294`), knip/analyzer anchor indices (`:517`,`:524`), source-reading anchor extraction (`:560` → `dispatch/packetPrompt.ts:123-161`), `buildPacketPrompt` + `writeFile` (`:580-581`). **Property to hold: dispatch is three stages — select/pack, size/admit, launch/land — and the name covers only the middle. Each stage is separately nameable and testable.** The assembly-unification lap this was told not to bundle with has SHIPPED (shared `buildHostPoolPreamble`, `src/shared/quota/hostPool.ts:149`, consumed by `quotaPool.ts:135` + `waveScheduling.ts:160`), so the re-home is unblocked. ⚠ Loop-core: `src/remediate/steps/dispatch/` is a `LOOP_CORE_PATTERNS` directory prefix (`src/shared/loopCorePaths.ts:41`) — a new `steps/land/` prefix must land in the canonical list with `.claude/hooks/loop-core-patterns.mjs` regenerated in the same commit (`npm run check:loop-core-patterns`), or the parity test goes red. Record: [`dispatch-fork-assessment-2026-07-16.md`](reviews/dispatch-fork-assessment-2026-07-16.md) §3.


- **Two dispatch entry points disagree on fail-closed and on driver identity (owner question 2026-07-16, medium).** (a) `prepareDispatchCommand.ts:17-23` and `quotaCommand.ts:25` swallow an invalid session-config to `{}` ("using defaults") while `dispatch.ts:219-230` documents fail-closed as the invariant *precisely because* a permissive default builds dispatch against an attacker-influenced config. (b) `prepareDispatchCommand.ts:28` uses `resolveFreshSessionProviderName` where the host path (`semanticReviewStep.ts:117`) uses `resolveHostDispatchProviderName` — the exact founding-bug shape the latter exists to prevent (`provider: codex` would key the pool to codex, not the conversation host). Property to hold: every dispatch entry point carries the same guards, or there is only one entry point.

- **G4 reduces to ONE narrow bug: `block_quota.host_model` is auditor IDENTITY persisted in the repo,
  and it outranks the descriptor (2026-07-16, medium).** `resolveHostModel` (`limits.ts:56-71`)
  resolves `explicit ?? block_quota.host_model ?? env`, then `hostPool.ts:156` keys
  `quotaModelKeySegment = hostModel ?? input.hostModelId` — so a repo-committed field beats the
  descriptor's `self.model_id` and **auditor B keys its quota to auditor A's model**. Violates
  [[capability-is-per-auditor-not-per-audit]], and the shared-assembly lift moved that precedence into
  `hostPool.ts`, so it now affects both draws.
  **SPEC — settled, and the distinction is what each field is keyed BY.** A repo-committed host-model
  field is IDENTITY (who is driving) → a second auditor inherits the first's identity and meters a
  window it does not own. **Fix = move `block_quota.host_model` → `self.model_id` only**, and narrow
  the `RepoSessionIntent` HALF-type note (`src/shared/types/sessionConfig.ts:772-779`).
  **Property:** anything naming WHO is running belongs to the auditor and is never persisted in the
  shared repo; anything keyed by a model NAME is shared config and is.
  **⚠ The rest of the original claim is REFUTED — do NOT "fix" it.** Nothing writes
  `quota`/`block_quota`; they are operator-authored (`packetFilter.ts:259` documents `quota.models` as
  the override mechanism). `quota.models[<model>]` is keyed by model NAME, so every auditor on that
  model shares the window by design — inheriting is CORRECT, and `limits.ts:115` beating discovery is
  the intended escape hatch. It only ever looked wrong because the identity above it resolved wrongly.
  `quota.default_context_tokens` / `reserved_output_tokens` and the `block_quota` context/output fields
  (`plan.ts:47-51`) are policy → stay on intent. Also stale: G4's "may fold into G2" — G2 shipped and
  did not fold it.
  **⚠ Separately real, still open, and NOT a gate on the above:** `resolveSessionConfig.ts:86-116` maps
  none of the `self.*` capability fields; they reach dispatch hand-threaded through
  `nextStepCommand.ts:130-133`, `prepareDispatchCommand.ts:43-48` and `quotaCommand.ts:38` — a parallel
  channel worth collapsing on its own merits. An earlier claim that this "MUST collapse in the same
  commit as any shared-assembly lift" was WRONG and the 2026-07-16 lift shipped without it.
  Detail: [`g4-g5-g6-premise-check-2026-07-16.md`](../reviews/g4-g5-g6-premise-check-2026-07-16.md).

- **A declared source that verified reach and then lies at dispatch is never ejected — the reactive
  `lies reachably` quarantine has no catcher (found G4/G5 premise-check 2026-07-16, low).**
  `verifySourceReach` refuses an inline `api_key` because possession is not reach, and its own comment
  names that quarantine as the only catcher for the always-passes lane it is refusing
  (`src/shared/providers/auditorSources.ts:448-452`) — the catcher does not exist. A lane whose key was
  revoked or whose endpoint died still verifies (env var present, launcher on PATH) and is re-admitted
  every run; under cost-first routing (λ=0) a stale free-tier declaration then takes EVERY packet first
  and fails them all. Open property: a source that fails reactively (oversize / 402 / tool-corruption)
  leaves the pool for the rest of the run. This is what remains of G5 — its other two clauses were
  already dead when it was triaged, and that disposition lives in
  [`g4-g5-g6-premise-check-2026-07-16.md`](../reviews/g4-g5-g6-premise-check-2026-07-16.md).

- **A ROTATING set of heavy suite tests fails only under parallel load — hermeticity, not regression
  (2026-07-16, tool-should-decide, low-medium).** `tests/audit/linux-cycle-regression.test.mjs` fails in a
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

- **The reconciliation gate is silently disabled if the two confirmation artifacts split (G3 A′ review 2026-07-16, tool-should-decide, low).** The obligation gates on the per-tool SEAM (`has(bundle.provider_confirmation)`, `state.ts:142-143`) while the gate's delta early-outs on the SHARED artifact (`readSharedProviderConfirmation(root)`, `nextStepCommand.ts`). They are written together only under `if (root)`, so seam-present + shared-absent (a root-less promotion, or an operator deleting the shared file) ⇒ obligation satisfied AND delta `[]` ⇒ the gate never fires for the run, and `resolveExcludedProviders` also finds no policy ⇒ a newly-reachable backend routes unconfirmed. Narrow (needs the pair to split) but silent. Property to hold: the gate's CONFIRMED operand and the obligation's presence check must key on the same artifact, or a split must be loud. [[dispatch-policy-vs-reach-cut]]

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

- **Doc/lint gaps exposed by the G3 re-plan lap (2026-07-16) — three standing asks, all unbuilt at HEAD.** (1) **ambiguous-direction (HIGH):** a spec stating an ENDPOINT without marking what GATES it reads as a flat contradiction of the code, and invites a later agent to "fix" the spec to match the implementation (one G3 draft proposed striking an owner-approved decision on exactly that basis). The one instance is phase-qualified by hand (`spec/unified-dispatch-worker-model.md:201-206`); nothing enforces it. The only spec-prose lint, [`design-docs-declarative.test.mjs`](../tests/audit/design-docs-declarative.test.mjs), covers two design docs and BANS the status vocabulary a phase marker needs, so this cannot be another banned-phrase row. Owner call: a marker grammar a lint can check (a required `gated by:` clause on any endpoint statement?) that does not re-admit status prose, and whether the lint's doc set widens. [[spec-degradation-and-doc-staleness]] (2) **inefficient-feeding (HIGH):** dated `docs/reviews/*.md` plans read as self-sufficient, so an agent entering from HANDOFF's ▶ section plans from the PLAN and never opens the design of record — the plan carries the mechanism, the spec carries the GOAL (owner, of prior laps: *"agents keep forgetting the actual goals"*). Fix direction: a mandatory goal-restatement header on dated plan docs (checkable in `scripts/check-doc-manifest.mjs`), or spec-first pointer ordering in HANDOFF. (3) **tool-should-decide (medium):** three of four G3 drafts specced a gate that would never fire, each caught only by an agent tracing the call path. Neighbouring lints exist (`executor-registry-sync.test.mjs`, `audit-orchestrator-invariants.test.mjs` INV-03) but the two reachability properties are unchecked: a satisfy-predicate with no transition back to unsatisfied, and an executor consuming an input without invalidating it. Both are predicates over opaque `derive`/`execute` closures, so the open question is a checkable encoding (declared `consumes`/`invalidates` fields?) before any lint can exist. [[gate-must-be-traced-not-designed]]
  ⚠ **OWNER DECISION 2026-07-25 on (1):** require a **`gated by:` clause** on any spec statement of an
  ENDPOINT — a marker grammar a lint can check that names the GATE rather than the progress, so it does
  not re-admit the status vocabulary `design-docs-declarative.test.mjs` bans. The lint's doc set widens
  to the spec files carrying endpoint statements. (2) and (3) are unchanged and still open.

- **Friction walk (repair-proxy dogfood lap, 2026-07-15):** (1) **tool-should-decide (medium), overlaps [[quota-before-cost-ordering]]:** the cost ordering shows models.dev **LIST price** ($1.92 for nim/glm-5.2), but the operator pays **$0** for it (NVIDIA NIM free tier). Free-to-operator vs metered is a per-`(operator,backend)` fact the catalog can't know; discovered pools default to list price, so a genuinely-free backend sorts as if expensive and a paid one (openrouter) can hide mid-list. Today's only lever is hand-declaring `cost_per_mtok:0` / `enabled:false` per backend in `repair_proxy.providers` (done for this run) — the tool should let the operator classify a backend's cost-relationship once, not re-price every model. (2) **tool-should-decide (low):** no way to mark a whole discovered transport's sub-provider as paid→excluded at Gate-0 itself; had to edit session config + re-run next-step. (3) **tool-should-decide (medium), = [[per-model-tiering]]:** owner reinforced that capability/tier is assigned per PROVIDER, not per (provider, model, effort). Concrete: Codex (`~/.codex/config.toml` model=`gpt-5.6-sol`, effort `high`, but `-m/--model` + `-c model=` take any model per-call) renders at Gate-0 as ONE `capable`/`resolved at dispatch` row because the legacy `codex` block has a single `model` field — its multiple models at different capability tiers collapse to one. The tool's own workaround (pin `sources[]` `{provider:codex, model, parameters:{extra_args}}` per model/effort) puts the burden on the operator; the tiering should be per-(provider,model,effort) natively, sourced from models.dev / declared config. (4) **env-var trap (low):** repair-proxy `mistral` provider hardcodes `authEnv: "MISTRAL_API_KEY"`, but the operator's Mistral La Plateforme key lived in `CODESTRAL_API_KEY` (Codestral and La Plateforme share one key but the env-var name differs) → pool silently `has_key=false`/excluded until the authEnv was repointed. A reachability probe that reports "keyed but wrong-env-var" vs "no key" would cut the diagnosis.

- **Contract-pipeline planning bills HOST quota only — no route to a $0 pool (inefficient-feeding, medium, two OWNER CALLS).** Every planning phase that still needs judgment is authored by the host conversation: `buildParallelModuleWaveStep` (`src/remediate/steps/contractPipeline.ts:1634`) calls `scheduleWave` for a fan-out *cap only* (`capacity_pools` never reaches `buildDispatchQuota` from here — see the comment at `:1663`), so even the per-module drafting wave renders a prompt asking the HOST to dispatch. Determinism already trimmed it to ~9-11 round-trips, but all of them bill before the first implement dispatch, so routing fixes on the implement half never touch the planning bill. Separately, a validation failure archives the host's artifact and `rejectionRewriteInstruction` (`:457`) demands a fresh complete rewrite, so a one-field schema error costs a whole re-author — deliberate, not accidental. Owner calls: (a) should planning phases become dispatchable to a non-host pool (they are the only half that cannot be)? (b) is a targeted in-place repair worth admitting for a single-field rejection, against the whole-artifact-rewrite invariant that makes re-emission trivially correct? ⚠ The companion `implementation_dag` citation-grounding claim was REFUTED at HEAD and dropped — grounding tries `affected_files` first and prose tokens last, and `deriveNodeFiles` gives every DAG node a file scope. [[synth-scopeless-nodes-doomed-run]]
  ⚠ **OWNER DECISION 2026-07-25 — BOTH calls answered YES.** (a) Planning phases BECOME dispatchable to
  a non-host pool; it is the only half that cannot currently route to a $0 pool, and every one of its
  ~9-11 round-trips bills before the first implement dispatch. (b) A targeted in-place repair IS admitted
  for a single-field rejection. ⚠ (b) narrows the whole-artifact-rewrite invariant, so scope it to a
  rejection whose issue set names specific fields — a rewrite stays the fallback whenever the repair
  target is not unambiguous, or the invariant erodes into "patch whatever looks wrong".

- **A stale-artifact re-extraction `next-step` runs >2min with no progress signal, silently blowing a caller timeout (live dogfood 2026-07-17, inefficient-feeding, low).** After the design-review passes, the drain re-extracting 11 stale artifacts (repo_manifest/graph over 1250 components / 8466 edges, invalidated by a docs commit) exceeded a 2-minute command timeout with only a flood of identical `{"kind":"staleness",...}` lines and no heartbeat — forcing a blind retry at a longer timeout to see if it was wedged or working. Property to hold: a long deterministic drain should emit a progress/phase heartbeat (or the staleness spam should collapse to one line) so a caller can distinguish "working" from "wedged" without a retry. Minor; the retry succeeded.

- **⬇ LIVE-run watch only — unified routing A–G (shipped 2026-07-17, 6 attested loop-core commits).**
  On a fresh conversation-first self-audit, watch: small pools take fitting packets; an oversized packet
  SKIPS (no 413); a 429 on pool A leaves pool B dispatchable; a zero-grant renders its honest cause.
  Mechanism and the refuted "HOST-ONLY" premise live in
  [`host-fanout-premise-refuted-2026-07-17.md`](reviews/host-fanout-premise-refuted-2026-07-17.md) +
  [`unified-dispatch-routing-design-2026-07-17.md`](reviews/unified-dispatch-routing-design-2026-07-17.md),
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

- **Dispatch routing: JIT reservation on the HOST path + the headless/hybrid branch collapse — the remaining two thirds of the pool-agnostic-claims design (2026-07-13; concept spec 2026-07-16; re-verified against HEAD 2026-07-24).** Design of record: [`spec/dispatch-jit-claims.md`](../spec/dispatch-jit-claims.md) (claim = exclusivity not routing; planner = live capability feed; quota reserved at the launch moment); build sequencing in [`docs/reviews/unified-dispatch-routing-design-2026-07-17.md`](reviews/unified-dispatch-routing-design-2026-07-17.md). **The claim leg is effectively satisfied and its old framing ("drop `poolId` from claims") is now WRONG** — `ClaimRegistry.claim` decides exclusivity on presence+staleness alone and never consults `poolId` (`src/shared/quota/claimRegistry.ts:123-136`), no consumer reads the stored value (`partitionByOwnership` reads only `ownerToken`), and the field has since become the DRIVER identity that `claimMany`'s same-owner re-grant (`:152-176`) and `releaseOwned`'s owner-scoped release (`:210-224`) depend on, so deleting it would regress the completion-livelock fix. What is left there is naming hygiene only: rename `poolId` → `ownerId` and have `coordinator.ts:227` pass a driver id instead of `pool.id` (today a write-only value). **Genuinely open:** (a) **JIT reservation on the HOST path** — the in-process engine already reserves at launch (`rollingDispatch.ts:1741` `admitAgainstLedger` immediately before `dispatchOnePacket`), but the host path still grants a whole wave's leases at plan time (`finalizeDispatchQuota({ grantLeases: true })`, `hostFanoutGate.ts:226-236`; the two-mode split is documented at `admissionLoop.ts:887-896`), so a host grant can go stale between plan and launch; (b) **host-path convergence** — the headless (`nextStepHelpers.ts:2309`) and A-8 hybrid (`:2419`) arms are still a branch pair (routing-design H2; H4's `shouldDemotePrimaryInProcess` is already gone from `src/`). [[relax-dispatch-source-forcing]]

- **Accept-latch residuals (family SHIPPED 2026-07-23; two low items stay open).** Mechanism, the
  REFUTED "rollback to session-recorded base" premise, and the disposition of a/c/d live in
  [`accept-latch-family-mechanisms-2026-07-23.md`](reviews/accept-latch-family-mechanisms-2026-07-23.md).
  Open: (1) a rolling-dispatched node whose accept sidecar is ABSENT at merge (runId-mismatch chaos) is
  indistinguishable from the interim main-tree path and closes unverified — needs a rolling-path marker
  independent of sidecar presence; (2) the sidecar's monotonic `merged:true` guard still blanket-preserves
  stale records — the ancestry probe is the corrective, so revisit only if a case escapes it.

- **Node-worktree guard — accepted residuals only (each low, on-evidence-only; the guard itself shipped v0.34.19).** Mechanism, refuted alternatives, and review disposition: `docs/reviews/node-worktree-guard-mechanisms-2026-07-23.md`. Deny-by-default CLI refusal (`assertCliCommandAllowedFromCwd`, `src/shared/io/nodeWorktreeGuard.ts`) is wired at both CLI chokepoints (`src/audit/cli.ts`, `src/remediate/index.ts`) over caller cwd + wrapper-stamped `AUDIT_TOOLS_CALLER_CWD` + raw `--root`, with remediate-side writer asserts (`state/store.ts`, `steps/rollingSession.ts`) behind it. What stays open: audit-side session writers have no writer assert and rely on the CLI guard alone (add one only if a non-CLI clobber shape ever fires); a worker that both `cd`s out of its worktree AND passes explicit targets can still reach shared state (containment, not authority — the `implementPrompt` "Standing rules" section is the remaining layer); a failed review-snapshot degrades spawned audit workers to the REAL checkout (`src/audit/cli/rollingAuditDispatch.ts`, `resolveReviewRoot`), where the cwd predicate cannot fire and write-scope is prompt-only for that run — loud (stderr + a high-severity `write_scope_degraded` friction event) but unguarded; dist-dependent verify commands deferred by `partitionDistDependentVerifyCommands` are subsumed by the close gate's full-suite run rather than individually re-run.

- **Friction walk (touched_files load-gate lap, 2026-07-25):** (1) **tool-should-decide (medium):** a
  fixture helper ending in `as RemediationState` (`tests/remediate/helpers/nextStepHarness.ts:109`)
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
  ratcheting mid-lap and then deleting more entries turns `backlog-budget-unit.test.mjs` RED in a way
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
  (2) **tool-should-decide (low):** `check-backlog-budget --update-baseline` will happily RAISE a
  grown file's ceiling — the exact move the gate exists to prevent, one flag away from the legitimate
  ratchet. It should refuse to raise, or require an explicit `--raise-ceiling`.
  (3) **inefficient-feeding (low):** a background `npm test … | tail -N` writes NOTHING to its output
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

- **Branch-strand trap has bitten THREE times — needs a tool-enforced fix, not a HANDOFF warning (2026-07-22, tool-should-decide, medium).** `ensureRemediationBranchCheckedOut` silently switches the primary checkout onto `remediation/<runId>` at implement-dispatch prepare, and any subsequent `git commit` from that checkout (docs, closeouts) strands off main — HANDOFF has warned since the second bite and the warning did not prevent the third (recovered same-session via branch reset + temp-worktree cherry-pick; the very next doc edit then nearly landed on the run-base version of this file). "Verify HEAD before committing" is host discretion, which this project bans as a fix. Candidate mechanisms: the dispatch/accept flow operates the remediation branch through a dedicated linked worktree (primary checkout stays on main), or a repo-local pre-commit guard refuses a commit on a `remediation/*` branch whose staged set is docs/spec-only (almost certainly meant for main). Either makes the strand impossible rather than remembered-about.

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
  the in-process rolling engine reconciles per packet on success OR failure (`rollingDispatch.ts:1209`),
  so the leak class is host-path only. Release is wired at every normal exit — merge
  (`mergeAndIngestCommand.ts:667`, ahead of the idempotency replay), the dispatch wall/pause
  (`dispatch.ts:807`), and the fan-out chokepoints (`hostFanoutGate.ts`, which additionally
  reconciles-before-regrant so a re-run next-step can't orphan the prior family's lease ids). A wave
  KILLED mid-flight (stopped drain, dead dispatcher, fleet session-death) reaches none of them, so its
  leases free only via `DISPATCH_LEASE_TTL_MS` (20 min) while `admitBatch` keeps counting them:
  `countByPool` is seeded from the ledger's distinct live lease ids (`admissionLoop.ts:669-686`) and
  `:741` refuses `cap_reached` with `headroom_before: null` — the ledger is never reached, which is why
  the wall reads as phantom. Sharper than when logged: the uncalibrated cold-start cap is now
  `COLD_START_PROBE_BATCH = 1` (`scheduler.ts:353`), so ONE orphaned lease walls a calibrating pool.
  Residual (open, low): a startup sweep releasing leases whose owning run is demonstrably dead. Blocked
  on the DISCRIMINATOR, not the code — `ReservationLease` carries no owner (leaseId/cost/poolId/
  expiresAt; the pid inside `mintLeaseId` is incidental and is *always* dead on the host path, since the
  granting CLI exits before the workers run), and "a newer run exists" is not death under co-located /
  multi-agent runs that JOIN one run. Safe-by-construction shape: sweep only lease ids readable from
  this artifact dir's own `dispatch-quota.json` files, keyed on a run-terminal signal.
  `reclaimExpired()` (`reservationLedger.ts:403`) is unwired and only drops already-expired leases, so
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

- **Design-review independence — solo `design_review_contract` is the one pass the host judges itself
  (2026-07-24, low; the old "second-driver hazard" framing is REFUTED).** ⚠ The prior prose called the
  advance command in the solo branch the same double-driver bug fixed for `design_review_parallel` in
  `e6b580d0`. It is not, and acting on it would strand the run: that prompt is the HOST's own step
  prompt (`writeCurrentStep` at `nextStepCommand.ts:766` → `steps/current-prompt.md`, no packet file,
  no `access` block), so `Then run: <next-step>` at `:745` is CORRECT — `e6b580d0`'s own message says
  so verbatim ("the solo design_review_contract branch keeps its advance ... not a dispatched packet").
  The hazard is specific to the parallel branch's real worker packet
  (`incoming/design-review-contract-prompt.md`, `:659`), which is advance-free and pinned by
  `tests/audit/next-step.test.mjs:167`.
  **What is actually open is independence.** `design_review_parallel` dispatches the contract review to
  a subagent (`:667`) and solo `design_review_conceptual` dispatches through `prepareConceptualDispatch`
  (`:806`), but solo `design_review_contract` (`:723-782`, reached whenever only the contract pass is
  missing or re-staled — `nextStepHelpers.ts:1017`) has the host run the adversarial contract review
  itself, over artifacts the host drove — vs [[delegate-adversarial-phases-to-separate-agent]].
  Property: no design-review pass is judged by the agent that drove the work under review, on any of the
  three branches. Mechanism: mirror the parallel branch — write the `renderContractReviewPrompt` body
  (advance-free) to the contract prompt path, keep the advance in the host's dispatch instruction, add
  the `contract_prompt` artifact path and the `access` read/write paths, and extend the existing
  parallel-branch assertion to the solo step.

- **Untracked-exclusion scope rule — residuals (shipped 2026-07-10; each low-severity, documented at the
  code site).** The scratch-pollution bug is FIXED in tooling: `buildFileDisposition` now runs an `untracked`
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
  - (d) **Grounding corpora still use `ls-files` without `-z`** (`findingGrounding.ts:108`,
    `contractPipelineGates.ts` ~1034): non-ASCII tracked paths arrive C-quoted (`core.quotePath`), so citations
    to such paths fail grounding while the disposition (which uses `-z`) keeps them in scope.
  - (e) The audit `renderEdgeReasoningStepPrompt` single-agent dispatch carries no scratch-dir note (params
    lack run context; one bounded agent writing one results file — lowest-risk path, add if it ever litters).

- **Ad-hoc Agent fan-out has no per-agent ledger, so a session-limit mid-edit death is unrecoverable
  (low).** Unlike remediate-code's per-node worktrees + claims, a recon/review Agent that dies
  mid-edit leaves nothing to resume from. Property: every dispatched unit of work is recoverable from
  a record outside the dying context. (Harness/workflow property — no single file owns it.)
  ⚠ The former sliver (a) of this entry is CLOSED and its premise was stale twice over: `llm read` is
  RETIRED, and the health probe it asked for shipped — `.claude/hooks/session-start-guards.mjs:110-138`
  probes the lane and prints `OFFLOAD LANE DOWN` with the restart command at lap start. Only the
  *then-route* half was never built, and nothing has asked for it since.

- **External shared-logic audit V1–V7 residuals** (each deliberate, low-severity, documented at the code
  site):
  - **(from V3) postinstall agent-scope legacy-wildcard migration gap.** Both postinstall scripts preserve
    an EXISTING legacy agent-scope bash `'*':'allow'` in an already-deployed
    `~/.config/opencode/opencode.json` on upgrade (the wrapper/install path DOES migrate it → `'ask'`;
    pinned deliberate by remediate's COR-fc1f12a6 tests). Full closure: mirror the wrapper's
    `withoutManagedBroadBashWildcard` migration into `scripts/{audit,remediate}/postinstall.mjs`.
  - **(from V5) path-guard blind spots.** `tests/shared/audit-tools-path-guard.test.mjs` cannot see
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
  [`spec/audit/dispatch-admission-control.md`](../spec/audit/dispatch-admission-control.md)
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
  `src/audit/cli/rollingAuditDispatch.ts:453` and `src/remediate/steps/nextStep.ts:1212-1229` both route
  `onEscalation` into the single `captureStepBoundaryFriction` chokepoint. Coverage is ASYMMETRIC, not
  end-to-end on both: the shared engine half (recordLimit → escalate → early strand, pool N+1 never
  attempted) is pinned in `tests/shared/rollingDispatch.test.mjs:979` with NO friction assertion, and only
  the AUDIT driver's full chain through to the written `friction/<runId>.json` record is pinned
  (`tests/audit/rolling-audit-dispatch.test.mjs` §5). Nothing under `tests/remediate` asserts a
  `quota_escalation` friction — `tests/remediate/quota-scheduler.test.ts:483` pins only the
  `HostSessionQuotaSource` escalation unit. Two open halves: **(a) bounded** — add the remediate parity
  test (`driveRollingImplementDispatch` with `poolsOverride` of ≥4 pools and a `dispatchNode` returning
  `rate_limited` with a parseable session-limit string; assert a `quota_escalation:` friction in
  `friction/<runId>.json`), red-green by deleting the `onEscalation` block at `nextStep.ts:1214`;
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
  `tests/audit/content-key-seam.test.mjs`, `tests/audit/ledger.test.mjs`,
  `tests/audit/idempotency-sibling-collision.test.mjs`. **Still open:** confirmation on a real
  deepening-capable run. If a run wedges, the recovery is `audit-code force-synthesis` (stamps a
  tool-owned `operator_forced` terminal over the pending ids and synthesizes from the intact ledger) —
  never hand-edit gitignored run state, which the state machine overwrites and which cascades stale
  `planning_artifacts`.
  - **⬇ Live-run watch** (any audit whose findings trigger deepening — i.e. low-confidence/high-risk areas
    that spawn `deepening:*` tasks): every `deepening:*` task must **converge and complete** within a bounded
    number of rounds; the run reaches synthesis on its own. FAIL = orphaned pending `deepening:*` tasks, the
    same finding re-deepened every round (idempotency collision), or the run only finishing via
    `force-synthesis`. If you hit it, run `force-synthesis` to unwedge and note the round count here.
- **The offload lane is SINGLE-CONCURRENCY and fails soft, so a fan-out reads as model incapacity
  (2026-07-24, medium, friction: inefficient-feeding).** Dispatching 12 LiteLLM calls at once did not
  queue: some returned a schema-valid `{"entries": []}`, others never returned — an empty result that
  reads exactly like a weak model — the shape [[offload-lane-failures-are-usually-the-caller]]
  warns about, at a NEW cause: concurrency, not `max_tokens`/schema. Serializing fixed it.
  Separately `glm-5.2` (roster rank 1) returned NOTHING on two large analytical calls after >15min each
  while `deepseek-v4-flash` answered the same prompt in seconds — rank is not a latency ordering, and
  rank-1 is no default for a blocking call. Property: the lane states its concurrency (1) where a
  caller reads it, and a call it cannot serve refuses loudly rather than returning an empty document.

- **A design-review pass can auto-complete EMPTY, and nothing distinguishes that from a real review
  finding nothing.** `runDesignReviewAutoComplete` (`src/audit/orchestrator/structureExecutors.ts`) can
  mark a pass `contract_reviewed: true` / `conceptual_reviewed: true` with `contract_findings` /
  `conceptual_findings: []` and no LLM call ever having run. A vacuous green and a genuine clean bill are
  indistinguishable downstream. **Property to hold:** a review pass is satisfiable only by evidence a real
  review ran — require a non-fallback finding set, or block synthesis on an auto-completed-empty pass.
  Lifted from `spec/contract-authoring-determinism-design.md`; its S8 section states the design.

- **ID minting is not routed through the one registry — RESIDUAL only (re-verified at HEAD 2026-07-25).**
  Obligation ids now mint through `obligationId`/`moduleSlug` in
  `src/remediate/contractPipeline/idRegistry.ts` (the encoder and its phase/write-scope decoders were two
  identical implementations plus a "MUST stay in lockstep" comment), and uniqueness is the shared
  `mintUniqueId`. What is left: `goal_id` is not minted at all — it is read verbatim off the LLM envelope
  (`derive.ts`), so its FORMAT is unvalidated. **Property to hold:** an id the tool relies on is either
  minted by the registry or validated on the way in.
