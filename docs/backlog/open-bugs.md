# Open bugs & frictions

> Fixable defects and friction. Fix in tooling — never "the host remembers".
>
> Part of the split backlog — index: [`docs/backlog.md`](../backlog.md).
> A living to-do list, not a status log. Remove an entry once it ships; record durable
> contracts and rationale in project memory or `CLAUDE.md`, never "where the code is today".



- **`open-bugs.md` is still ~155KB / ~39k tokens — the split made three files a bounded read, not
  this one (2026-07-24, medium, friction: inefficient-feeding).** Splitting the single 1,706-line
  backlog by section fixed `forward-tracks` / `deferred` / `durable-traps`; this section is ~107
  entries and remains too large to read in one call, which is the condition that let ~21% of entries
  go stale unnoticed. `npm run check:backlog-budget` now records a per-file and per-entry ceiling in
  `docs/backlog/.size-baseline.json` and enforces SHRINK-ONLY, so this cannot regrow — but the
  ceiling is today's size, not the goal. 16 entries sit over the 2,600-char entry budget (~51KB
  total, the largest 6,261); condensing them is the bulk of the gap. Property: every backlog file is
  one bounded read. Mechanism is built and proven — condense an entry, re-run with
  `--update-baseline`, and the ceiling drops permanently. ⚠ Do NOT close this by raising the budget:
  the driver is post-mortem narrative accreting onto entries, so a budget that always passes measures
  nothing.

- **The offload lane's DEFAULT schema is unfit for its most common use, and every caller must
  hand-roll a replacement (2026-07-24, low, friction: inefficient-feeding).** `llm-call.mjs` enforces
  `{summary, findings[], open_questions[]}`. Asked for an adversarial code review, glm/deepseek
  returned `findings: [""]` — one empty string — under a `summary` that asserted "two concrete
  convergence bugs and one observable consistency failure" it then never named. `finish_reason=stop`,
  so this is the misfitting-schema failure `~/.claude/CLAUDE.md` already warns reads as model
  incapacity. Re-running the identical prompt against a task-shaped schema (typed findings with
  severity / location / mechanism / failing_scenario / confidence) produced 4 specific, citable
  findings, one of which was real and shipped. The warning exists but the ergonomics push the wrong
  way: getting a fit schema means abandoning the helper and writing a bespoke `node:http` POST per
  call. Property: the helper accepts a `--schema <file|json>` (and keeps the generic shape as the
  default only for recon/extraction), so a fit schema costs one flag rather than a throwaway script.

- **A full vitest run can exit 1 while reporting 7400 passed / 0 failed (2026-07-24, low,
  friction: trap).** Observed twice in one lap on the full three-area run: vitest reports
  `Errors 1 error` → `[vitest-worker]: Timeout calling "onTaskUpdate"` (an internal reporter RPC
  timeout under load), which sets a non-zero exit code even though every test passed. A green run
  therefore reads as red by exit code alone — the exact false-signal class
  [[lap-green-must-match-ci-evidence]] warns about, inverted. Property: distinguish a harness
  reporting failure from a test failure before treating a non-zero vitest exit as red — check the
  `Tests` line, not just `$?`. Fix candidate: raise the worker RPC timeout, or fail only on
  `Tests failed > 0` in the gate wrapper.

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

- **`verifySourceReach` demands `api_key_env` on every openai-compatible source, so a KEYLESS
  local endpoint cannot be declared honestly (2026-07-23, low, friction: tool-should-decide).**
  An unauthenticated local proxy (LiteLLM with no enforced master key, LM Studio, local vLLM)
  needs no credential, but the reach check hard-drops any openai-compatible source without
  `api_key_env` — the 2026-07-23 single-shot NIM-via-proxy lanes had to declare a semantically
  unrelated set var (`NVIDIA_API_KEY`) just to pass. Property: keyless should be declarable
  explicitly (e.g. `api_key_env: null` / a `no_auth: true` knob) so reach probes the endpoint
  instead of an env var; an OMITTED key field can stay a drop (forgetting the key is the common
  error — the explicit form is what says "deliberate").

- **The remediate suite writes scratch trees INSIDE the repo (`tests/remediate/.test-*/`), so a
  `git add -A` sweeps test residue into a commit (2026-07-23, low, hermeticity).** Fake HOMEs
  (`.test-home-postinstall-contract`), temp repos and artifact dirs land under `tests/remediate/`
  and are left behind after a run; one `git add -A` staged ten such files, and some were already
  `AD` (added, then deleted by a later run) — the exact shape that produces a phantom deletion in a
  commit. Stopgap shipped: a `tests/remediate/.test-*/` ignore rule. Real fix: these belong in
  `os.tmpdir()` like the rest of the suite's temp state — a test that writes into the source tree
  makes working-tree cleanliness a function of whether tests have run
  (same family as the `quota-command.test.mjs` real-repo-root assertion above).

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

- **FLW-COR-003 claim-release livelock — the IN-PROCESS half is SHIPPED; the HOST half is what
  remains (2026-07-22, downgraded from HIGH to medium 2026-07-24 after a code trace).** Original:
  with every NIM worker 429-failing, claims from a failed round sat live for the full 20-min lease
  (`AUDIT_TASK_CLAIM_LEASE_MS`, dispatch.ts:135); every interleaved next-step then saw all pending
  tasks peer-claimed → dispatch plan `[]` → obligation unsatisfied → drain re-selected it to
  `maxTransitions(100)`, exit 1, one empty run dir per ~10s (571 accumulated).
  **Already fixed for the in-process rolling driver** (commit `681df1f5`): `releaseOwnedTaskClaims`
  (dispatch.ts:149) is called at drive end (`rollingAuditDispatch.ts:675`) and on the empty-plan
  round (`:485`), so a failed/stranded round frees its claims immediately.
  **Still open — the HOST path never releases.** `prepareDispatchArtifacts` claims the candidate set
  for all three callers, but only the rolling driver sweeps; `prepareDispatchCommand.ts:36` (the
  `audit-code prepare-dispatch` CLI) and `semanticReviewStep.ts:119` claim and rely solely on merge's
  terminal `clear()` — so a host round whose workers all die still holds its claims for the lease.
  Property: claims release on worker failure, not only at merge, on EVERY path that claims.
  ⚠ The "zero-granted round pauses the drain" half is a SEPARATE property from claim release — verify
  it independently at HEAD (the per-packet pause wall and host-dispatch wall have both landed since
  this was written). Record:
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
  gemini-3.6-flash went 0-for-2 — an 11-task 6-lens security packet and an 8-entry
  maintainability/tests packet, both contract-valid with 0 findings, where fable/codex/sonnet
  packets on adjacent scope yielded 5-10 — and was benched from audit packets mid-run BY HAND,
  which is host discretion.
  ⚠ **The old "lens class belongs in the routing decision" framing is wrong at HEAD.** Lens class is
  already a routing input: `SENSITIVE_HINT_LENSES` (`security`/`data_integrity`/`reliability`)
  escalates a packet's tier floor to ≥`standard` in `resolveDispatchTier`
  (`src/audit/cli/dispatch/tierRouting.ts:21,:82`), which becomes `requiredTier` at the packet→pool
  capability floor (`dispatch.ts:593,:639` → `rollingDispatch.ts:1669`) — and the packet that failed
  WAS a security packet, so more of that axis would not have caught it.
  **The real gap is that the dispatch engine has no result-quality seam at all.** A pool is demoted
  or excluded only on cost drift, credit exhaustion, model-unavailable or 429 cooldown
  (`onCostDrift`/`onCreditExhausted`/`onModelUnavailable`/`onQuotaUnclassified`,
  `rollingDispatch.ts:361-412`); nothing observes what a worker RETURNED, and no declared source
  carries a lens/kind restriction, so "this lane under-reports" is inexpressible anywhere but by hand.
  ⚠ **The "counts as covered" half is also overstated.** Selective deepening already re-reviews clean
  results lens-agnostically for high-priority / `critical_flow` / external-analyzer scopes
  (`isHighRiskCleanResult` → `buildHighRiskCleanFollowupTask`, `selectiveDeepening/highRiskClean.ts`,
  wired at `selectiveDeepening/index.ts:168`) and builds a lens-steward verification task on
  `many_no_finding_results` / `high_risk_clean_result` (`lensVerification.ts:124,:127`) for the same
  three important lenses (`selectiveDeepening/shared.ts:22`). What has NO net is a low-priority
  zero-finding result on a non-important lens — exactly the 8-entry maintainability/tests packet.
  **Next move is an owner call, not code:** zero-finding rate is a noisy bench signal (a genuinely
  clean scope legitimately returns none), quality is already RESOLVED as a FLOOR rather than a
  tradeable axis (see the cost-speed-dial entry), and the ground truth that would calibrate a
  per-lane floor for finding work is the DEFERRED A2 finding-quality oracle. Decide between widening
  the deepening net to low-priority clean results and funding the oracle so finding-yield can gate
  eligibility mechanically. Record:
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
  Candidates: an explicit `no_deltas: true` escape hatch in the submission shape (a schema-legal
  way to say "none"), or a cheap negative-finding lint at ingest. Record:
  [`re-dogfood-friction-2026-07-22.md`](reviews/re-dogfood-friction-2026-07-22.md) #4.

- **⬇ LIVE (re-dogfood 2026-07-22, low): completion cleanup removes the friction dir before the
  session stop-gate's close-out walk runs against it.** After present_report,
  `.audit-tools/audit/` was cleaned to steps/ only; the stop-gate then demanded the walk and the
  record had to be recreated by hand. Ordering property: the close-out walk is part of run
  completion — cleanup preserves (or the close step completes) the friction record before
  archiving. Record:
  [`re-dogfood-friction-2026-07-22.md`](reviews/re-dogfood-friction-2026-07-22.md) #13.

- **LEAD (2026-07-22, low): does remediate's node-claim lifecycle share the merge-only-release
  defect the audit side just fixed?** Audit's completion livelock (claims released only at merge →
  failed rounds starve every later runId for the 20-min lease) is fixed by `releaseOwned` at drive
  end. Remediate claims implement nodes through its own registry (`rollingSession.ts`,
  `acceptNode.ts`) with ONE release site visible (`rollingSession.ts:494`); verify whether a failed
  or stranded implement node's claim is released at round end or leaks until lease expiry — one
  core, two draws: if the audit fix's property holds there too, wire the same `releaseOwned` sweep.

- **LEAD (re-dogfood 2026-07-22, low): NIM roster latency is bimodal — minimax-m3/nemotron-550b
  can exceed undici's default headers timeout on ~8k-token structured calls, presenting as a
  network failure rather than a slow success.** Fourth observation 2026-07-23: a glm-5.2
  review call over a ~900-line diff + 3 context files died `UND_ERR_HEADERS_TIMEOUT`;
  trimming the payload and retrying on deepseek-v4-pro succeeded — payload size, not model
  health, was the variable. A standalone-script call died with
  `UND_ERR_HEADERS_TIMEOUT` (same trap as the offload-lane fetch entry under Durable traps).
  Verify what timeout the openai-compatible provider lane sets before logging as a bug — if it
  shares undici defaults, a slow NIM model reads as a dead lane. Record:
  [`re-dogfood-friction-2026-07-22.md`](reviews/re-dogfood-friction-2026-07-22.md) #5.
  Fifth + sixth observations (2026-07-23, legibility lap): glm-5.2 died `UND_ERR_HEADERS_TIMEOUT`
  TWICE in one session — once on a ~55KB recon payload and once on a **16KB** review payload,
  while deepseek-v4-pro and nemotron answered comparable calls fine. The 16KB death weakens the
  "payload size is the variable" framing: the glm-5.2 lane itself goes bimodal-slow independent of
  size. Practical routing: on a glm headers-timeout, retry a DIFFERENT alias before trimming.
  **ROOT CAUSE FOUND + HELPER FIXED (2026-07-23, pause-wall lap): observations 7-9 — THREE
  different aliases (deepseek-v4-pro 37KB, nemotron-3-ultra-550b 30KB, qwen3.5-397b 26KB) died
  identically in one session while a tiny probe answered fine — resolved to the CALLER's
  transport, not lane bimodality: `~/.claude/llm-call.mjs` used global `fetch`, whose undici
  default headers timeout (~5 min) fires before a big model's FIRST byte on heavyweight
  analytical calls (no streaming). Helper now POSTs via `node:http` with a 30-min ceiling
  (`LLM_TIMEOUT_MS`); prior glm-only observations 5-6 are likely the same cause (unproven).**
  The in-repo half is **SHIPPED (v0.34.27, 2026-07-24)**: each launch now builds its own transport —
  an undici `Agent` whose `headersTimeout`/`bodyTimeout` follow the declared `input.timeoutMs` — so
  `globalThis.fetch`'s un-overridable ~5-min `headersTimeout` is no longer in play and the only
  timeout is the declared one. (`undici` added as a runtime dep: it IS Node's fetch implementation,
  pure JS, and transport is correctness-sensitive enough to acquire rather than own.) ⚠ A >5-min
  time-to-first-byte is not exercisable in a unit test; what is pinned is that the launch does not
  route through the global fetch. If a live NIM run still shows `UND_ERR_HEADERS_TIMEOUT` from the
  in-repo lane, the remaining suspect is the roster's genuine bimodal latency, not the transport.
  Second live observation (2026-07-22 review dispatch): a minimax-m3 structured 8k-token call ran
  >12 minutes and then returned an empty/error body while nemotron answered the identical prompt in
  ~2 min — and glm-5.2/deepseek-v4-pro were hard-429'd at the same moment (third observation for
  the roster-fallback entry above).

- **⬇ LIVE-CONFIRMED (re-dogfood 2026-07-21): the proxy-lane drop reason names an internal function,
  and no populate command exists (medium, friction: tool-should-decide).** First `next-step` of the
  v0.34.6 self-audit dropped the proxy lane with "run the populate (populateProxyCatalog)" — not a
  runnable command (`audit-code --help` lists none). Confirms the existing freshness/refresh entry's
  (b) verbatim. NEW second finding: the cache was INVALIDATED BY THE IDENTITY MIGRATION — the on-disk
  v1 cache carried the pre-rename `provider` field, the shape-version bump correctly degraded it to
  absent, but nothing regenerates it and the operator remedy was importing `populateProxyCatalog`
  from dist by hand. Property: a tool-written, fully-regenerable cache that shape-degrades must be
  REGENERATED by the tool at the next natural boundary (Gate-0 build), not reported as the operator's
  problem. Third observation, same call: the declared `api_key_env` field accepted `"NAME=value"`
  silently and reported the whole string as an unset var — worth a shape validation (a `=` in an env
  NAME is never right).

- **LEAD (2026-07-23, low, surfaced by the pause-wall recon — out-of-repo resolvers only):
  `window_uncalibrated` ledger blocks are a fixed-state 50ms-poll livelock if a custom
  `resolvePoolConstraints` emits unpriced windows.** The forced anti-deadlock retry unbounds
  budgets only, so an uncalibrated window refuses the forced admit too and the packet re-enters
  the 50ms branch with nothing that can change (`rollingDispatch.ts` forced-retry path; traced by
  Codex recon 2026-07-23 with citations). Not reachable from shipped wiring — the in-repo
  producer omits unpriceable windows from `window_budgets` (`scheduler.ts:573,:586,:617`).
  Property if it ever bites: an uncalibrated-window block with `anyOutstanding:false` should
  strand loudly (or pause) rather than poll. Record:
  [`pause-wall-per-packet-strand-2026-07-23.md`](reviews/pause-wall-per-packet-strand-2026-07-23.md).
  (The zero-spill entry's companion pause-wall LEAD — deep packet spinning the wait tick on a
  paused best pool — SHIPPED 2026-07-23 as the per-packet pause wall; same record. The adjacent
  legibility fact — 144 granted with leases/explains empty — stays carried by the
  dispatch-legibility entry below.)

- **RESIDUAL of the partial-wave deferral (shipped v0.34.27, 2026-07-24, low) — two accepted
  residuals, no open work.** Both dispatch paths record their attempted packet set into the
  run-scoped `dispatch-attempted.json` (`src/audit/cli/dispatchAttempted.ts`): the host path records
  `admission.granted_packet_ids` (`dispatch.ts:688`), the in-process driver opts out
  (`recordAttemptedGrant: false`) and records the packets the engine actually drove
  (`rollingAuditDispatch.ts:667`), so a stranded packet stays unattempted. Merge defers a missing
  result whose packet is not in that set (`partitionUnattemptedMissing`), keeps its claim, skips
  retry-dispatch and suppresses the completion marker — pinned by three tests in
  `tests/audit/merge-ownership-gate.test.mjs`. Residuals, revisit on live evidence: (a) a `null`
  attempted set deliberately preserves the pre-fix classification (an unrecorded round must not
  swallow failures), so any FUTURE third dispatch path must record its attempted set or its partial
  waves regress to the exit-code lie — nothing enforces that mechanically; (b) the record is a
  monotonic union per run id and never pruned, so a long-lived run id accumulates packet ids
  (bounded by the run's plan, not unbounded).
  ⚠ **The companion FLW-COR-002 "idempotent REPLAY of a completed merge flips the exit code" claim is
  REFUTED at HEAD** — a replay returns `has_failures:false` → exit 0, and `merge-complete.json` is
  written only by a zero-failure merge that also exits 0. The observed 2→1 instability was the
  partial-wave re-run above. The mechanism post-mortem (claims are taken at PLAN time, so claim
  liveness is not an in-flight signal) lives in [[claim-liveness-is-not-an-inflight-signal]].

- **⬇ LIVE (re-dogfood): token_usage stamping asks for a split real harnesses cannot supply
  (2026-07-21, low).** The dispatch prompt wants per-result `{input_tokens, output_tokens}`; Claude
  Code's subagent tool reports only a TOTAL. An honest host must skip the stamp, so calibration
  stays at cold-start batches (3, then 2, of 62 — observed). Accept `{total_tokens}` and calibrate
  on it. Record: [`re-dogfood-2026-07-21.md`](reviews/re-dogfood-2026-07-21.md).

- **LEAD (re-dogfood): systemic-challenge round counter + banked improvements carry across RUNS
  (2026-07-21, low).** This run's challenge arrived as "round 10" with 11 prior improvements from
  earlier sessions' artifacts. Verify intended (cross-run loop state vs per-run reset). Record:
  [`re-dogfood-2026-07-21.md`](reviews/re-dogfood-2026-07-21.md).

- **`tests/audit/quota-command.test.mjs` "nothing is written to disk" asserts on the REAL repo
  root, so dogfood residue turns it red (2026-07-21, low, friction: hermeticity).** The test's
  regression guard `!existsSync(<repoRoot>/.audit-tools/audit/session-config.json)` fails whenever
  a live/paused self-audit run has legitimately created that file in this checkout (exactly the
  paused re-dogfood state) — a working-tree-cleanliness dependency, not a cmdQuota behavior check.
  Property: the guard must distinguish a file cmdQuota WROTE (e.g. mtime/absence delta across the
  command, or run cmdQuota under a temp cwd) from one that pre-existed. Until fixed, this test is
  red on any checkout with dogfood artifacts; CI's fresh clone is the real signal.
  **Upgraded by the 2026-07-22 endgame: this defect polluted a live audit.** The runtime_validation
  phase ran `npm test` in the live-audited working copy, this one assertion failed → ALL 39 runtime
  units marked not_confirmed → 29 reconcile deepening tasks spawned for one hermeticity bug
  (captured as finding RTV-TST-001). Cost is no longer "a red on dogfood checkouts" — it fans out
  into real dispatched work. Record:
  [`re-dogfood-endgame-2026-07-22.md`](reviews/re-dogfood-endgame-2026-07-22.md).

- **agy's headless lane still has no `permissions.allow` rules, so `-p` auto-denies `read_file`/`command`
  (2026-07-23, low, friction: tool-should-decide).** Headless `agy -p` denies its own tool permissions and
  exits 0 with only a "jetski: no output produced" line, so the lane is prompt-inlined content only
  (≲30KB argv). ⚠ **Correcting this entry's own "the settings file could not be located" claim — it IS
  located.** The agy binary carries the literal path `~/.gemini/antigravity-cli/settings.json`
  (string scan of `%LOCALAPPDATA%\agy\bin\agy.exe`); that directory is agy's real state home on this box
  (`installation_id`, `brain/`, `cache/`, `updater/`) and simply has no `settings.json` yet.
  `~/.gemini/config/config.json` is a different file and holds only `userSettings` — which is why the
  original search came up empty. `agy --help` exposes no allow-rule flag and no `config` subcommand, so
  that file is the only lever. Remaining step: author `~/.gemini/antigravity-cli/settings.json` with a
  read-only `permissions.allow` block, then probe with a trivial `agy -p` read and confirm the
  "no output produced" symptom clears — the rule GRAMMAR (tool names, argument matching) is still
  unverified and needs that live probe. The `--dangerously-skip-permissions` workaround stays refused by
  `shell-trap-guard.mjs` (prompt-derail trap, with the three agy headless traps). Delete this entry once
  the probe is green.

- **`[analyzerDeps] npm install typescript@5.8.0 failed (exit 1): E404 not found` during `tests/shared` runs (2026-07-20, low, LEAD — check the consequence).** A shared-area test (the acquired-analyzer dep path) attempts a live `npm install typescript@5.8.0` mid-suite and 404s twice; the suite still passed (1715 green), so it degrades rather than fails. But a test reaching for the network at all is a hermeticity smell, and a pinned `typescript@5.8.0` that 404s suggests either a bad version pin or a test that should stub the install. Confirm whether the analyzer-deps path is meant to hit the network in tests; if not, stub it.

- **`tests/shared/rollingDispatch.test.mjs` "re-dispatches immediately on result arrival" is
  timing-flaky on loaded runners (2026-07-23, low, hermeticity).** First observation: CI shard 2 of
  the v0.34.23 publish run — the 50ms `setTimeout` at rollingDispatch.test.mjs:268-269 lost the
  race on a busy runner ("expected 2 to be 3"); passed locally alone (72/72) and in the same-day
  full local run; CI rerun green. Same class as the linux-cycle entry below: the fix is an
  event-driven wait (poll for `dispatchOrder.length === 3` with a generous deadline), not a fixed
  sleep. One observation — fix if it recurs.

- **`tests/audit/linux-cycle-regression.test.mjs` fails under full-suite load but passes alone (2026-07-19, low, hermeticity).** ~30s alone; exceeds the 120s `testTimeout` when the whole suite runs in parallel. Per the test-failure protocol this is a hermeticity/load bug in the test, not a regression — it needs an explicit longer timeout or isolation from the parallel pool, not a code fix. Noted because a full-suite run currently reports "1 failed" and that failure is this, every time.

- **The vendored price snapshot predates the collision index, so the provider-scoped price path is inert at HEAD (2026-07-19, settled 2026-07-24, low).** `src/shared/data/model-statics.generated.json` carries 2630 models and no `__by_provider` key — but that is PROVENANCE, not a signal about models.dev. The file has exactly one commit ever (`82352712`, 2026-07-05 16:35), while `__by_provider` first entered the generator two days later (`f15a85fa`, 2026-07-07 10:42): the snapshot was written by the pre-collision `flatten()` and has never been regenerated since. Both original hypotheses are refuted — `flatten()`'s collision path is unit-green on colliding input (`tests/shared/update-models-collision.test.mjs:84-115` pins a 3-provider collapse → cheapest default plus a full `byProvider` index), and `stableStringify` emits the key only when a collision populated it (`scripts/shared/update-models.mjs:167-173`), so no upstream shape change is needed to explain a key the generating run could not have written. **Consequence (real):** `resolveModelStatics(model, provider)` finds `snapshot.byProvider[provider]` empty for every provider string and falls through to the flat table (`src/shared/quota/modelStatics.ts:142-149`), so every price is the cheapest-collision default and the service-vs-transport axis fix above stays inert. **Fix:** run `npm run update-models` (live fetch of models.dev, rewrites the vendored asset) and commit the refreshed snapshot — no code change, and not red-green testable since the generator's own logic is already pinned. **Then settle the second-order mismatch before calling the path live:** `byProvider` is keyed by models.dev VENDOR ids while both pricing sites pass `sourceService(source)` — a declared `service`, else the transport name (`src/shared/providers/identity.ts:67-72`) — so a refreshed index is load-bearing only for service strings that happen to equal a models.dev provider id.

- **CLAUDE.md overstates the `admitSpawn` consent gate (2026-07-19).** *Own-vs-acquire analyzer
  engine* states every acquired-tool spawn "routes through the single `admitSpawn` chokepoint and
  requires the per-run `ExternalAcquisitionConfig.consent_token`." Verified against HEAD:
  `defaultRun` **bypasses** the token requirement — only non-default tools require it
  (`src/audit/extractors/analyzers/acquisitionEngine.ts:216-224`); `admitSpawn` is at `:304,:478`.
  SPEC: decide which is the intended invariant, then make doc and code agree — either the curated
  default set is legitimately exempt (say so explicitly in CLAUDE.md, since "every spawn requires the
  token" is currently false) or `defaultRun` must also pass through the token check. Surfaced by the
  memory-consolidation verification pass, `docs/reviews/memory-consolidation-2026-07-19.md`.

- **Memory/doc claims of "open item" decay exactly like backlog prose (2026-07-19).** The memory
  consolidation found a memory listing 4 open items of which 3 were long done (audit's symmetric
  `runRollingDispatch` wiring, INV-QD-14 spill, `rate_limited` handling). Same class as
  [[backlog-prose-decays-verify-against-head]] but in the memory store, where nothing ever forces a
  re-read. SPEC: treat any "open"/"remaining"/"TODO" claim in a memory or spec as a LEAD requiring a
  HEAD check before it becomes work — never as a work order. No tooling fix proposed yet; if this
  recurs, the mechanical form is a lint that greps memory/spec for open-item phrasing and reports
  the ones whose named symbols now exist.

- **The TEST TREE IS NOT TYPECHECKED AT ALL — `.ts` tests included (2026-07-19).** `tsconfig.json`
  is `include: ["src"]` and vitest has no `typecheck` configured, so no test file is typechecked.
  This keeps defeating "make the field required so `tsc` enumerates the sites": that guarantee is
  real for production (`CapacityPool.accountKey` correctly enumerated its 2 producers) and worth
  ZERO over fixtures. Concretely, three `.mjs` fixtures built pools without the new required field
  and failed at RUNTIME rather than at compile time, and two more (`tests/audit/inv2.test.mjs`,
  `tests/remediate/inv2.test.ts`) produced `account_key: undefined` through
  `summarizeDispatchCapacityPools` and PASSED because nothing schema-parsed there. This is the same
  class as the scope-less-window fixture problem. **Property to hold:** a fixture that omits a
  required contract field fails loudly — either the test tree is typechecked, or the wire crossing
  schema-validates on every path a fixture can reach.
  Two more symptoms of the same root, worth knowing because each costs time on its own: (a) making a
  field required *because omission is a defect* enforces nothing in tests — the compiler correctly
  sweeps production call sites while every test call site silently keeps getting `undefined`, so a
  green suite reads as "every call site swept" when it cannot be; (b) a large `Edit` that breaks brace
  balance in a `.test.mjs` is invisible to the typecheck and surfaces only as vitest failing to
  transform the whole FILE — one opaque "Failed Suites" entry naming no test, masking every real
  assertion in it. Candidate mechanisms: a `tsconfig.test.json` wired into `verify:checks`, or
  `vitest --typecheck`.

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
  created so consumers are safe by construction, "when step 2 touches this code". Attempted and
  REVERTED: it does not work as a drop-in. Every production caller swallows a throw from
  `probeQuotaSource` into `status: "degraded"` (`apiPool.ts`'s two `.catch`es, plus the
  `queryCurrentUsage` branch's own try), so asserting there converts a contract violation into a
  quiet `quotaSignalDegraded` pool rather than a loud failure — and `compositeQuotaSource` bypasses
  `probeQuotaSource` entirely, so "safe by construction" would be false regardless. **Property to
  hold:** a scope violation from a live producer is distinguishable from a network degrade and
  surfaces loudly — which needs a distinct error class that the degrade catches deliberately
  re-throw, not another assert call. Meanwhile `scheduleWave` still asserts (live path, throws) and
  `quotaSnapshotWindowPctMap` skips-and-warns (persisted path, must not throw).
  **SPEC — a contract violation needs its own ERROR CLASS, not another assert at another site.** The
  revert was correct and its lesson is that WHERE the check runs is not the problem: every production
  caller wraps the probe in a catch that converts any throw into a degraded status, so an assert
  anywhere inside that boundary is swallowed into a quiet degraded pool — the loudest possible bug
  becomes the quietest possible symptom. Adding a third assert site repeats it.
  The distinction the code cannot currently express is **"the remote is unreachable" versus "the
  producer emitted something structurally invalid."** The first is expected and degrades; the second is
  a bug and must surface.
  **Return the violation IN-BAND as a typed failure result rather than throwing.** A distinct error class
  that every degrade-catch agrees to re-throw would also work, but it stays vulnerable to the same defect
  one refactor later — it relies on each catch site continuing to make an exception for it, which is the
  remember-to-be-careful shape this project rejects. A typed result cannot be swallowed by a catch at all,
  because it never travels as an exception: a caller must handle the variant to compile, and a scope
  violation stops being confusable with a network degrade by construction rather than by convention.
  Producer validation can then live wherever is most natural, including on paths that bypass the probe
  entirely — which is why "safe by construction at one boundary" was never achievable here.
  **Property to hold:** a structurally invalid producer emission is always loud and never presents as a
  network degrade. ⚠ The persisted read path must still skip-and-warn rather than throw — old artifacts
  predate the field, and refusing to load them would turn a historical gap into an outage.

- **`tests/audit/linux-cycle-regression.test.mjs` times out under full-suite parallel load
  (2026-07-19).** Passes alone in ~29s; exceeded its 120s timeout when run as part of `vitest run`
  over the whole suite, then passed alone immediately after. Load-sensitivity, not a regression —
  but it makes a full-suite run non-deterministically red, which is exactly the condition that
  trains a reader to wave at "known flaky" instead of resolving failures to names. **Property to
  hold:** the test's cost does not scale with unrelated suite concurrency (raise its timeout, or
  make it not contend on whatever shared resource slows it).

- **A per-site pinning gate would make "red-green validated" mechanically checkable — UNBUILT on main.**
  The idea: revert each site of a change individually and require each reversion to turn the suite red,
  so "every changed site is pinned by a test" stops being a claim the author makes about their own work.
  A prototype (`assert-sites-pinned.mjs`) existed on an unmerged branch — it is in NO ref reachable at
  HEAD — and the independent review that exercised it named the shape that makes a naive version
  worthless ([`account-metering-round2-independent-review-2026-07-19.md`](reviews/account-metering-round2-independent-review-2026-07-19.md),
  *The evidence apparatus is itself fail-open*): it measured *"the suite went red"*, not *"a test
  asserting THIS behavior went red"* — renaming the `resolvePoolAccountKey` export so importers crash
  produced `71 failed` and the gate reported `PINNED … All 1 site(s) individually pinned.` That is the
  same fail-open the tool exists to catch, relocated one level up. A hand-written site list has the
  mirror problem: 7 sites declared against ≥11 substantive src hunks, so "all N sites pinned" is
  literally true and materially misleading — there, the two hunks that ARE the fix's core claim
  (`capacity.ts` / `apiPool.ts` stamps) sat outside the author's own denominator.
  Nothing stands in for it at HEAD: the loop-core gate checks attestation existence, staged-tree
  binding and verdict only (`.claude/hooks/pre-commit-gate.mjs`), and `--checked` is recorded as free
  text with a ≥20-char floor (`.claude/hooks/attest-loop-core-review.mjs`) — so "red-green validated by
  mutation" in a handoff or attestation is still the author's word about their own work.
  **Properties to hold:** each spec site binds to the NAME(s) of the test(s) expected to fail, and the
  site list is DERIVED from the diff so an omitted hunk is impossible. Until both hold, no such gate's
  output is admissible as attestation evidence. **Owner call before any build:** whether the second
  property is even reachable — expected-failing test NAMES are themselves author-supplied, so the gate
  may only relocate the claim again unless the names are derived (e.g. from a baseline coverage/ownership
  map) — and whether N full-suite runs per commit is a cost worth paying.

- **⚠ Two concurrent `vitest run` invocations corrupt each other's results (2026-07-19, medium,
  friction: inefficient-feeding).** Running a targeted suite while a full-suite run was still going in
  the background produced 61 failures across 6 files in areas the diff never touched
  (`inferRepairTarget`, `archiveContractArtifact`); both areas passed cleanly on a serial re-run, twice.
  The tests share on-disk fixture dirs under `tests/remediate/.test-*`, so concurrent runs race. This
  cost a full stash-and-baseline cycle to attribute, and would read as a damning regression to anyone
  who did not re-run serially. **Property to hold:** either test fixture dirs are per-invocation
  (`AUDIT_CODE_STATE_DIR`-style, per [[state-dir-env-override-hermeticity]]) or a second concurrent
  vitest refuses to start. Same family as the other three known full-suite-only failures.
  Same family, third observation (2026-07-23, blocked-step lap): an `npm run build` (dist rewrite)
  DURING a background full-suite run produced 10 failures in 3 files (wrapper tests spawn dist
  mid-rewrite; next-step collected mid-edit source); all green on serial re-run. A dist rebuild is a
  concurrent mutator of the suite's fixture surface exactly like a second vitest — the same
  property (per-invocation isolation or refuse-to-race) covers it.

- **Nothing derives "collapse a shared-budget roster to its best member" (low).** The selection rule
  itself is settled and already falls out of the cost-first comparator: a free pool's costs all tie so
  capability decides, and a metered pool sorts on price with the capability floor gating eligibility.
  What is missing is that the operator still expresses the collapse by hand as a `top_k: 1` on the
  proxy declaration. **Property to hold:** when several models share one budget, restricting the roster
  to the member that best serves the work is derived, not hand-declared.

- **SPEC — the proxy catalog's freshness rule gates the WRITE but not the READ, and the lane has no
  operator-runnable refresh.** A day-old cache whose roster no longer matched the running proxy was
  served silently, and deleting the cache dropped the whole proxy lane with a reason naming an internal
  FUNCTION rather than any command the operator could run. ⚠ Correcting this entry's earlier claim that
  there is "no TTL": a 10-minute TTL DOES exist, but it only decides whether the populate step re-fetches.
  The read path deliberately accepts cached data of any age. So the freshness concept is present and
  applied on exactly the wrong side.
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

- **`top_k` truncates ALPHABETICALLY when nothing is ranked, silently dropping the frontier tier
  (2026-07-19, medium, now mitigable).** With all `score` undefined, `expandSources`
  (`proxyCatalog.ts:327-335`) falls through to `a.alias.localeCompare(b.alias)` — so `top_k: 3` over
  the NIM roster kept a *flash* model and dropped every frontier one. Mechanism (3) of the
  unranked+free composition entry, now observed directly. **Mitigated** now that
  `model_info.capability_rank` is populated (see below), but the fallback remains
  silently-wrong-by-default for any unranked proxy. **Property to hold:** truncating a roster with no
  ranking signal must be loud, not alphabetical.

- **A DEADLINE must drive λ from measured progress, never become a second operator knob — and nothing
  measures progress yet (blocked on an owner call, not on code).** At HEAD the dial is exactly one durable
  operator scalar: `dispatch_bias` (λ ∈ [0,1]) captured at Gate-0
  (`ProviderConfirmationInput.dispatch_bias`, `src/shared/types/providerConfirmation.ts`), clamped in
  `admitBatch` and applied at the single ordering chokepoint `orderCandidates`
  (`src/shared/dispatch/admissionLoop.ts`). The speed axis it blends against is
  `deriveThroughputConcurrency` — declared source `max_concurrent` else `+Infinity`, host subagent budget
  else `1`. So throughput is a DECLARED-CONCURRENCY ordinal, not a measured rate: no elapsed-time,
  tokens/sec, or progress-to-completion quantity is recorded per run anywhere (`RunLogger` carries
  `duration_ms` on step/executor spans only; the `provider_done` diagnostic carries no duration at all),
  and every `deadline` in `src/` is a file-lock or HTTP timeout. "Finish within an hour" is a CONSTRAINT,
  so it belongs as something that drives λ — a manual deadline flag is a bug signal, and a guessed
  controller wired into the dial is WORSE than the flag (it hunts and overshoots with no dataset to debug
  against).
  **Property to hold:** no control law reaches the dial before it has been fitted to measured runs and
  validated, and the absence of a law is never filled by an operator knob in the meantime. **Both hold
  today** — there is nothing here to close, only to decide.
  **The owner call that gates any move:** the proposed intermediate (a passive observer recording elapsed
  time, measured throughput and progress-to-completion per run, with a deadline acting only as a hard stop
  plus a persisted trace) introduces a MEASURED dispatch signal, which the dial's own invariant forbids
  ("never learned, measured, or hand-declared" — `spec/dispatch-cost-speed-dial.md`) and which the
  STOP-HUNTING ruling pushes back on ([[concurrency-is-declared-or-absent-never-learned]]). Decide whether
  a measure-but-never-route observer is admissible under those rules — and whether deadline support is
  wanted at all — before any code is written.
  Adjacent, same family: [[quota-before-cost-ordering]] (Gate-0 suggests cost order on
  $/Mtok alone, never demoting a quota-saturated pool).

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

- **Are `dropped[]` reasons actually SURFACED to the operator at Gate-0? (2026-07-18, medium,
  from the LiteLLM live-validation lap.)** The whole declared-reach design leans on "never silently
  discarded — every drop carries an operator-facing reason", and the reasons are good. But this lap
  hit the retired-`repair_proxy` rejection and an unset-key drop, and in both cases the *operator-visible*
  symptom was simply "the proxy lane isn't there" — the reason was only observable by calling
  `resolveAmbientSources()` directly. **Property to hold:** every `dropped[]` entry reaches the operator
  in the Gate-0 render, not just the return value. NOT yet traced — verify the Gate-0 rendering path
  before designing a fix; the reasons may already be displayed and this may be a non-issue.
  [[write-only-data-looks-authoritative]] (a reason nobody renders is write-only).

- **H2+H4 collapse residual pins (2026-07-18, low, from review h2c3).** (a) The attended same-agent
  SPLIT semantics (blessed in the plan record: engine partition + host-subagent remainder on one meter,
  replacing HEAD's whole-frontier monopoly) is pinned only at pool-composition level — add a
  decision-point-level test asserting where the frontier is actually driven; fold the DC-4
  settled-pool `poolsOverride` filter into the same harness. (b) The env-DETECTED same-agent path
  (`CODEX_THREAD_ID` → `resolveConversationHostProvider` → dedup) lost its end-to-end pin when
  `demote-same-agent-guard.test.mjs` died; the new D1 tests use explicit `host_provider` only.

- **Non-hermetic test: `tests/audit/quota-command.test.mjs` "nothing is written to disk" reads the box's real `.audit-tools/audit/session-config.json` (2026-07-18, low).** A leftover gitignored local artifact makes the test fail on a clean checkout of main; it presents as a regression from whatever diff is in flight. Property: the test must resolve repo-root state through the `AUDIT_CODE_STATE_DIR` hermeticity override like its neighbours, never the real repo path. Same box-dependence family as `INV-shared-core-14`.

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

- **`docs/backlog.md` exceeds a single-read budget, so every pass navigates it blind (friction:
  inefficient-feeding, medium).** 1,706 lines / 203KB / ~52k tokens at HEAD — twice a 25k-token read
  cap — so working on it means paged reads plus grep-by-anchor, and line numbers shift under every
  edit. It is also the document most likely to be scanned by an agent with no prior context:
  `.claude/skills/disambiguate-backlog/SKILL.md` step 1 instructs "Read `docs/backlog.md` in full",
  which no longer executes in one call.
  **Property to hold:** the open-work record is navigable in bounded reads.
  ⚠ **Splitting along the existing `##` boundaries does NOT satisfy it** — *Open bugs / frictions* is
  1,109 of the 1,706 lines (143KB, ~37k tokens) by itself, so the obvious split leaves the same defect
  in the biggest piece. The open question is therefore what sub-axis divides *Open bugs* (by area? by
  severity? one file per entry? a generated index that makes the whole thing seekable without
  splitting), and that is an owner call for two reasons: `docs/documentation-philosophy.md` §*The
  condensation bias* says **split only when one doc genuinely carries two unrelated durable concepts*
  * — splitting for size is what it argues against — and every file a split creates must earn a
  routing row in `docs/doc-review-guidelines.md` or `check:doc-manifest` fails the release.
  ⚠ Do not solve it by pruning aggressively: the entries earn their length, and the 2026-07-19
  classification showed the risk runs the other way — stale entries survive because nobody can hold
  the whole file at once.

- **Durable trap — never delete from `docs/backlog.md` by LINE NUMBER.** Entries can span two physical
  lines while being one logical bullet, because a hook may embed a literal newline inside a code span. A
  line-keyed delete then removes half an entry and leaves an orphaned fragment that reads as corruption.
  Bit this file during the 2026-07-19 classification pass. Delete by matching the entry's text, and after
  any scripted edit scan for orphans — lines not starting with `-`, `>`, `#`, a space, `|`, or a backtick.

> **Friction-walk entry template:** one line per friction — a bold title + the `[[memory-tag]]` for the
> durable lesson + only the still-OPEN tool sliver(s). No shipped-work narrative or changelog prose (that
> lives in git log / memory). Condense at write time, not in a later doc-review pass. The `[[memory-tag]]`
> appears only where a durable memory concept was actually captured for that item — by design, not every
> entry has one.

- **Friction walk (H2+H4 collapse lap, 2026-07-18):** (1) **ambiguous-direction (medium):** my own plan doc asserted "the host-vs-source dedup already exists" from a docblock's phrasing — the adversarial plan review refuted it against the writers (dedup was source-vs-source only, the new rule was new code); and the reviewer's own proposed fix for the display filter was itself a gate-that-never-fires (relative floor can't refuse every pool) — caught only by re-deriving at implementation time. Both are the standing lesson: every causal claim, including a REVIEWER's fix, gets verified against source before building. [[gate-must-be-traced-not-designed]] (2) **tool-should-decide (low):** the pre-commit loop-core gate evaluates a CHAINED `attest && commit` command before the inner attest has run, so the legitimate one-shot form is blocked — attest must be its own Bash call first; either the hook could ignore commits preceded by an attest in the same chain, or document the split as the required shape. (3) **inefficient-feeding (medium, recurrences):** NIM `llm read` lane 503-saturated ("Worker local total request limit 163/32") after ONE call in its session — recon fell back to targeted greps; and a delegated implementer died mid-task on the Claude session limit, with its partial recon unrecoverable (clean tree, redone in-context). Both argue for the standing pattern: main context implements from subagent recon it can verify, not the reverse.

- **Remediate hybrid frontier still sizes with a FLAT per-node estimate (step-G remediate half, medium).** `HYBRID_NODE_TOKEN_ESTIMATE` (`src/remediate/steps/nextStep.ts:1441`) makes the claim-time fit gate blind for implement nodes (audit's half fixed 2026-07-17 with real `token_estimate`s). Property: derive per-node estimates from the node's `affected_files` sizes (`estimateTokensFromBytes`) so a chronically-413ing (node,pool) pair is pre-skipped, not re-claimed each cycle.

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

- **A stale prior-run shared confirmation suppresses the proxy populate trigger while Gate-0 still pends (claude-worker dogfood 2026-07-16, tool-should-decide, medium).** The 3c populate trigger (`nextStepCommand.ts:381`) keys on `readSharedProviderConfirmation(root) === null`, but the Gate-0 obligation keys on the per-tool seam — so a leftover `.audit-tools/provider-confirmation.json` from an ABANDONED prior run (yesterday's dogfood) silently skipped populate on a fresh run whose Gate-0 was still being emitted, and the lane dropped as "cache absent". Same split-artifact class as the reconciliation-gate entry below. Property to hold: the populate trigger and the Gate-0 obligation must key on the same confirmation artifact (or a fresh run must not inherit an abandoned run's confirmation). Diagnosis cost: the populate's `.catch(() => null)` is silent AND the skip-branch prints nothing, so "cache absent" pointed at the wrong half.

- **`AGENTIC_WORKER_HARNESS_OVERHEAD_TOKENS = 15_000` is an unmeasured estimate, and the lane cannot currently measure it (low, live-gated; the rest of the 2026-07-17 feedback-gap residuals are closed — plan `docs/reviews/claude-worker-feedback-gaps-plan-2026-07-17.md`).** The constant (`src/shared/quota/capacity.ts`) is added to every packet estimate at all three fit gates (`dispatch/coordinator.ts`, `rollingDispatch.ts` partition + selection, `cli/dispatch.ts` budget clamp), so a wrong value silently mis-sizes every agentic pool in both directions. The measurement basis now exists — per-packet `input_tokens` in `token-usage.jsonl` (`src/shared/io/tokenUsageLedger.ts`) minus the packet's local `estimateTokensFromBytes` — but `ClaudeWorkerProvider.launch` spawns `claude -p --model <alias>` with no `--output-format json` and never populates `LaunchFreshSessionResult.observedUsage`, so every claude-worker line records `input_tokens: null` ("unmeasured", deliberately not 0). Two moves to close: teach the lane to report usage (parse the CLI's JSON envelope into `observedUsage`; the stdout failure-classification scan must keep matching through the envelope), then calibrate the constant against a real run. Still true from the same lap: a worker retries 429s inside its own lifetime (dogfood: 307 proxy-side vs 29 surfaced) — invisible to the parent; terminal classification → `cooldown_until` paces ACROSS workers only. Two former residuals are now closed and should not be re-derived — declared `quota.max_concurrent` IS consumed per-pool (`apiPool.ts` → `CapacityPool.concurrencyCap` → the engine's in-flight cap; no learned/free-tier default is wanted, [[concurrency-is-declared-or-absent-never-learned]]), and context caps are never absent (`resolveSourceContextWindowTokens` returns declared stamp → models.dev window → `DEFAULT_CONTEXT_TOKENS`, never null), so registry stamp coverage no longer gates anything — this box's LiteLLM registry advertises `capability_rank` and no context field, and populate's proxied lane fits correctly regardless. The old watch's run dir (`20260717T062404401Z…`) no longer exists; a fresh dogfood run is the evidence base. [[external-audit-catalogs-are-leads]]

- **claude-worker lane residuals from the 3c adversarial review (2026-07-16, each low-medium, deferred deliberately).** (a) **Account axis:** the populate expansion stamps no `account` (`expandSources`, `proxyCatalog.ts`) and the `proxy` declaration block has no hook to add one (`ProxyDeclaration` carries `endpoint` / `top_k` / `cost_per_mtok` / `api_key_env` / `burst_limited` and nothing else) — so an operator declaring `account` on a direct lane only splits `nim#X/m` vs `nim/m` into two pools to one backend, reopening the double-grant boundary for that model (the declared-wins dedup in `resolveProxyLane` covers the same-model case; the split needs a per-backend account map on the declaration). ⚠ NOT part of this any more: `buildSourcePool` handing `resolveAccountIdSafe` a TRANSPORT-shaped key while the pool keys on the backend is settled as deliberate — see `identity.ts` `quotaPoolKey`, "that value only resolves an account id; the pool's real key is `dispatchableSourceId`. Not a ledger key, so not a divergence." (b) **No READ-side TTL / no refresh command:** a populate-side freshness throttle DID ship (`POPULATE_CACHE_FRESH_TTL_MS`, 10min, same-endpoint short-circuit inside `populateProxyCatalog`), but it only skips refreshes — `readProxyCatalog` still accepts `catalog-cache.json` at any age, `populateProxyCatalogIfMissing` is still missing-only, and the "explicit refresh" the plan names still does not exist as a command. Cross-repo: the cache is machine-global (`~/.audit-code`, `resolveAuditCodeStateDir`) while audit's populate trigger is per-repo-confirmation-keyed (`nextStepCommand.ts`, `readSharedProviderConfirmation(root) === null`), so starting repo B rewrites the expansion repo A resolves mid-run (additions gate-caught; removals silent-by-design). (c) **Intra-declaration duplicates:** `collectDispatchableSources` spreads `sessionConfig.sources` verbatim and `pushUnique`s only the primary + legacy `openai_compatible` folds, so an operator hand-declaring two sources with one resolved identity still produces two same-id pools, and `sourceByPoolId`'s `map.set(pool.id, …)` then arbitrates the transport by silent clobber (the ambient path dedups declared-vs-expanded; the operator-error case remains). Property to hold: one pool identity ⇒ exactly one launchable source, everywhere.
  **SPEC — all three are one defect: identity is being decided somewhere other than where it is known.**
  (a) the expansion stamps no account and the declaration cannot supply one, so a backend that IS one
  account splits into two pools; (b) the cache is machine-global while the trigger that rewrites it is
  keyed per-repository, so a run in one repo can rewrite the roster another repo is resolving mid-run;
  (c) sources are deduplicated across declared-vs-expanded but never WITHIN one declaration, so two
  entries naming one backend produce two pools with the same identity and whichever writes last silently
  wins.
  **Resolution:** the producer that knows an identity stamps it and it travels on the wire — the same rule
  the account-metering work arrived at after five refused rounds. Concretely: the expansion stamps account
  identity rather than leaving a hole for a later stage to guess; deduplication happens once, over the
  full source set, keyed on resolved identity rather than on declaration origin; and a machine-global
  cache is never rewritten out from under a run that is reading it — either the read is snapshotted for
  the run's lifetime, or the rewrite is scoped so it cannot affect an in-flight resolve.
  **Property to hold:** one pool identity ⇒ exactly one launchable source, everywhere, and no in-flight
  run observes its own source set changing underneath it.
  ⚠ (c) is the bounded half and can land alone: dedup by `dispatchableSourceId` over the whole assembled
  set inside `collectDispatchableSources` (`src/shared/quota/apiPool.ts` — loop-core, needs attestation),
  first-wins, with the loser reported rather than dropped silently.

- **A doc-lint hook rewrites prose between Read and Edit, so exact-match edits fail on text the agent never wrote (2026-07-16, inefficient-feeding, low).** Mid-lap an `Edit` on `docs/backlog.md` failed with "String to replace not found" on a paragraph I had authored minutes earlier — a hook had normalized `vs` → `vs.` in it. The Edit tool's own hint ("tried swapping \uXXXX escapes") points at encoding, not at a hook rewrite, so the natural next move is re-reading the whole file to hunt an invisible character. Cost a re-read + a retry. Property to hold: a hook that rewrites a file the agent is mid-edit on should announce the rewrite (or the tool should re-anchor), rather than presenting as a mysterious mismatch. Cheap mitigation until then: after a "not found" on text you just wrote, suspect a normalizer and `grep` the anchor before re-reading the file.
  **SPEC — a hook that rewrites a file must announce the rewrite; the editing tool is not ours to change.**
  Recurred again this session, on this very entry: an exact-match edit failed while a full re-read showed
  byte-identical text, so the mismatch was invisible and the only escape was shrinking the anchor until it
  matched. The cost is never the retry — it is that the failure impersonates an encoding problem, and the
  tool's own hint points at character escapes, sending the agent hunting for something that is not there.
  The fix belongs in the hook, which we own: when it rewrites a file, it says so, so the next mismatch is
  self-explaining. ⚠ Do not pursue lint-aware patch semantics inside the editor — that is someone else's
  tool and a large mechanism to avoid a one-line announcement. ⚠ And do not "fix" it by disabling the hook
  during agent edits: suppressing enforcement to make editing convenient is the wrong direction and
  teaches the same workaround on every other surface.
  **Property to hold:** a file mutated underneath an agent mid-edit is announced, never silent.

- **Release gate: add `check:doc-manifest` to the pre-commit hook (open remainder, medium).** The durable lesson — a lap cannot report green on evidence weaker than what CI runs; end a lap by checking CI on `main` (the per-workflow runs endpoint is the reliable one), and run `npm run verify:release` before any "this is shippable" claim — is homed in `docs/HANDOFF.md` → "Release gate — the durable lesson" + [[lap-green-must-match-ci-evidence]]. Sole open action: `.claude/hooks/pre-commit-gate.mjs` gates `npm run check` (always) plus `test:doc-contract` and loop-core attestation (each conditionally, when staged files touch the relevant paths) — but never `check:doc-manifest`, so consider adding it (~2s, and it is the check that fired on EVERY push). [[enforce-robustness-in-tooling-not-host-discretion]] **Billed once, 2026-07-18** (a new dated plan doc committed fine locally and blocked `verify:release` afterwards).

- **Neither new test guards the WIRING — only the mechanism and the loader (2026-07-16, low).** `tests/remediate/session-config-load.test.ts` red-greens `loadRemediateSessionConfig`, and every remediate site routes through it today, but a FUTURE call site that inlines `resolveSessionConfig(intent, null)` instead of using the loader fails no test (verified by experiment: reverting a call site to `null` left both files green). Same for audit's two ambient sites. The loader makes the right thing the easy thing; it does not make the wrong thing impossible. Property to hold: a production caller cannot resolve a session config without a descriptor — e.g. make the descriptor a required parameter and give the two legitimate "resolve no pool" callers an explicit `noPoolDescriptor()`, so `null` stops being the path of least resistance.

- **A post-worker LANDING stage is still misfiled as dispatch — 2,845 of 5,978 lines under `src/remediate/steps/dispatch/`, plus marshal's merge half (owner question 2026-07-16, re-verified at HEAD 2026-07-24, medium).** `acceptNode.ts` (962) / `worktreeLifecycle.ts` (923) / `writeScope.ts` (496) / `verifyCommands.ts` (274) / `acceptReconcile.ts` (190) are not dispatch: `executeNodeInWorktree` (`acceptNode.ts:883`) is called only by the **driver** `driveRollingImplementDispatch` (`nextStep.ts:1130`, call at `:1346`), never by `prepareImplementDispatch` (`marshal.ts:234-513`), which ends having written `dispatch-plan.json` (`:426`) + `dispatch-quota.json` (`:510`). ⚠ Correcting the old entry's absolute: prepare is not worktree-*free* — it reaches two landing symbols, `ensureRemediationBranchCheckedOut` (`:342`) and `worktreePath` (`:405`, prompt rooting) — but it creates, verifies and merges nothing, so the stage boundary holds and those two imports are exactly what an import-graph test would catch. They live under `dispatch/` only because the barrel (`dispatch.ts:49-136`) aggregated them; `acceptNodeWorktree` even takes a base-branch lock (`acceptNode.ts:434`) — pure serialization, zero dispatch content. `marshal.ts` itself fuses two stages: prepare (`:234-513`) and the landing merge `mergeImplementResults` (`:596-1561`). Symmetrically on the audit side, `prepareDispatchArtifacts` (`src/audit/cli/dispatch.ts:187-881`) both *decides* and *renders the prompt* — lens defs (`:293-294`), knip/analyzer anchor indices (`:517`,`:524`), source-reading anchor extraction (`:560` → `dispatch/packetPrompt.ts:123-161`), `buildPacketPrompt` + `writeFile` (`:580-581`). **Property to hold: dispatch is three stages — select/pack, size/admit, launch/land — and the name covers only the middle. Each stage is separately nameable and testable.** The assembly-unification lap this was told not to bundle with has SHIPPED (shared `buildHostPoolPreamble`, `src/shared/quota/hostPool.ts:149`, consumed by `quotaPool.ts:135` + `waveScheduling.ts:160`), so the re-home is unblocked. ⚠ Loop-core: `src/remediate/steps/dispatch/` is a `LOOP_CORE_PATTERNS` directory prefix (`src/shared/loopCorePaths.ts:41`) — a new `steps/land/` prefix must land in the canonical list AND both `.mjs` hook copies in the same commit or the parity test goes red. Record: [`dispatch-fork-assessment-2026-07-16.md`](reviews/dispatch-fork-assessment-2026-07-16.md) §3.

- **`withinRoot` — a root-containment SECURITY guard — is reimplemented 5× (owner question 2026-07-16, medium).** `dispatch/paths.ts:10`, `openAiCompatibleProvider.ts:763`, `extractors/graph.ts:520`, `analyzers/typescript.ts:122`, partially `worktreeLifecycle.ts:91`. Five copies of a containment check = five chances for one to be subtly wrong, and a security guard is exactly the class where that matters. Single-source it.

- **Two dispatch entry points disagree on fail-closed and on driver identity (owner question 2026-07-16, medium).** (a) `prepareDispatchCommand.ts:17-23` and `quotaCommand.ts:25` swallow an invalid session-config to `{}` ("using defaults") while `dispatch.ts:219-230` documents fail-closed as the invariant *precisely because* a permissive default builds dispatch against an attacker-influenced config. (b) `prepareDispatchCommand.ts:28` uses `resolveFreshSessionProviderName` where the host path (`semanticReviewStep.ts:117`) uses `resolveHostDispatchProviderName` — the exact founding-bug shape the latter exists to prevent (`provider: codex` would key the pool to codex, not the conversation host). Property to hold: every dispatch entry point carries the same guards, or there is only one entry point.

- **Dead code: `src/audit/quota/headerExtraction.ts` + `headerExtractors/` have zero production consumers (owner question 2026-07-16, low).** Only the `index.ts` re-export + `tests/audit/header-extraction.test.mjs` reference them — the tested-but-unwired class that default-mode knip cannot catch. Delete symbol + orphaned tests per the periodic manual-audit recipe. [[knip-deadcode-gate-default-mode]]

- **G4 reduces to ONE narrow bug: `block_quota.host_model` is auditor IDENTITY persisted in the repo, and it outranks the descriptor (found G4 premise-check 2026-07-16, corrected same-day during implementation, medium).** `resolveHostModel` (`limits.ts:56-71`) resolves `explicit ?? block_quota.host_model ?? env`; `hostPool.ts:156` then does `quotaModelKeySegment = hostModel ?? input.hostModelId` — so the repo's `block_quota.host_model` beats the descriptor's `self.model_id` and **auditor B keys its quota to auditor A's model**. Violates [[capability-is-per-auditor-not-per-audit]]. **⚠ The rest of the original claim is REFUTED: nothing writes `quota`/`block_quota`** — they are operator-authored, and `packetFilter.ts:259` documents `quota.models` as the operator's override mechanism. So `quota.models[<model>]` is keyed BY MODEL NAME (same window for every auditor) → inheriting it is CORRECT, and `limits.ts:115` beating discovery is the intended escape hatch, **not a bug — do not "fix" it** (it only misfires because `hostModel` was mis-resolved upstream; fix the identity and it's right). `quota.default_context_tokens`/`reserved_output_tokens` and `block_quota.context_tokens`/`reserved_output_tokens` (`plan.ts:47-51`) are policy → stay on intent. **Fix = move `block_quota.host_model` → `self.model_id` only**; narrow the `RepoSessionIntent` HALF-type note (`src/shared/types/sessionConfig.ts:772-779`) accordingly. Also stale: G4's "may fold into G2" — G2 shipped and did not fold it. Separately real (and still open): `resolveSessionConfig.ts:86-116` maps none of the `self.*` capability fields; they reach dispatch hand-threaded through three audit CLI commands (`nextStepCommand.ts:130-133`, `prepareDispatchCommand.ts:43-48`, `quotaCommand.ts:38`) — a parallel channel bypassing the one seam. **⚠ Correcting this entry's own earlier claim that the channel "MUST collapse in the same commit as any shared-assembly lift": that premise did NOT apply and the 2026-07-16 lift shipped without it.** The constraint assumed shared assembly would take the DESCRIPTOR and read the resolved config; `buildHostPoolPreamble` instead takes already-resolved scalars (`providerName` / `explicitHostModel` / `hostModelId` / `hostContextTokens` / …), so the channel now hand-threads into ONE function rather than two — strictly better, and not a correctness coupling. The collapse remains worth doing on its own merits (one seam, not two channels), but it does not gate the lift. **Also note the lift moved the `hostModel ?? hostModelId` precedence INTO shared (`hostPool.ts`), so if G4 IS a bug its blast radius is now both draws — which is an argument for settling the owner call, not for reverting.** Detail: `docs/reviews/g4-g5-g6-premise-check-2026-07-16.md`.
  **SPEC — settled: it IS a bug, and the fix is to move the IDENTITY field only.** The distinction that
  makes this decidable is what each field is keyed BY. A repo-committed host-model field is auditor
  IDENTITY — it says which model is driving — so a second auditor working in the same repo inherits the
  first one's identity and keys its quota to a window it does not own. That is the per-auditor rule
  violated directly, and it now affects both draws.
  The sibling field is different in kind and must NOT be touched: operator quota overrides are keyed BY
  MODEL NAME, so every auditor using that model shares the window by design. Inheriting those is correct,
  and the override beating discovery is the intended escape hatch. It only ever looked wrong because the
  identity above it was resolved wrongly — fix the identity and the override behaves.
  **Resolution:** the host-model identity moves onto the per-auditor descriptor and stops being readable
  from repo-committed config; model-name-keyed operator overrides and the policy fields stay exactly
  where they are. **Property to hold:** anything naming WHO is running belongs to the auditor and is
  never persisted in the shared repo; anything keyed by a model name is shared config and is.
  ⚠ Separately real and still open: the auditor descriptor's capability fields reach dispatch
  hand-threaded through three CLI commands rather than through the one resolution seam — a parallel
  channel worth collapsing on its own merits, but it does not gate this fix.

- **G5's premise is 2/3 DEAD — narrow the spec before laying it out (found G4 premise-check 2026-07-16, low).** (a) `declared ∩ ambient-verifiable` SHIPPED as G2.5 (`resolveAmbientSources`). (b) The **auditor-id stamp is dead as specced** — `auditor_id`/`resolved_at` are parsed (`args.ts:348-349`) and read at exactly ONE site (`prompts.ts:61-62`) purely as an is-non-empty test: a write-only field ([[write-only-data-looks-authoritative]]). G2.5 established each IDE spawns its own process → own env → nothing shared to contaminate, and the spec's own Honest-residuals says the `(provider, account)` ledger — not auditor identity — is the load-bearing double-grant boundary. Before building a stamp, name the transient cross-auditor-shared run-state and re-derive whether an id is the fix. (c) Only the **lies-reachably quarantine** survives (`auditorSources.ts:147-148`); it is the sole catcher for G2.5's inline-`api_key` refusal. **G5 ≈ clause (c) alone.**

- **A ROTATING set of heavy suite tests fails only under parallel load — hermeticity, not regression (re-measured G3 A′ lap 2026-07-16, tool-should-decide, low-medium).** `tests/audit/linux-cycle-regression.test.mjs` fails in a full `vitest run` but passes alone (35s), and a **third failure rotates** between runs — observed as `tests/remediate/wave-scheduler.test.ts`, `tests/audit/next-step.test.mjs`, `tests/shared/quota-state.test.mjs` (all heavy, all pass alone). **Measured baseline (as of the 2026-07-16 lap, pre-dating the 2026-07-19 `INV-shared-core-14` fix): clean `main` failed `linux-cycle-regression` + one rotating mover** — re-measure before relying on this count; `INV-shared-core-14` no longer belongs in it. Also timed `linux-cycle-regression` mine-vs-main: 35s both. Per the test-failure protocol these are test bugs (timeout under worker contention / shared quota-state dirs), not code regressions. **The real cost is the is-it-mine investigation** — every dispatch-touching lap pays a full-suite baseline run on stashed main (~2×260s) to prove parity. Property to hold: a green branch must be distinguishable from a flaky one WITHOUT re-running the suite on main. Fix the hermeticity/timeouts, or quarantine the known-flaky set into a separate serial shard.
  **SPEC — persist the known-state baseline so parity is a LOOKUP, not a re-run.** The cost here is not the
  flakes, it is that every dispatch-touching lap re-derives the same baseline by stashing and running the
  full suite on main to prove innocence. The missing thing is a recorded answer to "what does main do under
  these conditions": store, at green baseline, each test's deterministic-or-parallel-flaky status annotated
  with the environment it was measured in (parallelism, OS, core count), since the whole phenomenon is
  load-dependent and a status measured under different concurrency means nothing.
  A branch failure then classifies against that record: a test that passes alone, fails under load, and is
  recorded parallel-flaky on main for the same environment is reported as parity with an annotation rather
  than as red. **Unrecognized failures stay red** — the classifier may only downgrade a failure it has a
  matching record for, never wave through one it does not recognize.
  **Property to hold:** a green branch is distinguishable from a flaky one without re-running the suite on
  main. ⚠ Not to be confused with an ignore-list: suppressing these tests everywhere destroys the signal
  permanently, and the hermeticity defects remain worth fixing on their own merits — this removes the
  investigation tax, it does not make the flakes acceptable.

- **No read-only surface shows the built dispatch pools — an exclusion rule is unverifiable until a live dispatch (G3 A″ lap 2026-07-16, tool-should-decide, medium).** Verifying "operator excludes one NIM model ⇒ siblings still route" end-to-end, I could observe the operator half at the real CLI (Gate-0 prompt → persisted `policy`) but **not the routing half**: `buildSourcePools` is reachable only from a live dispatch wave. Checked every read-only surface — `audit-code quota` reports only the host pool (`claude-code/*`) and reports the SAME with no exclusion at all, so it never builds source pools; `validate` surfaces none either. So an operator authors a rule and cannot see which pools resulted, and a typo'd rule (`openai-compatible:model-typo`) persists happily and matches nothing, silently. The grammar is OPEN by design so it can't be validated at parse time — but nothing reports "this rule matched zero backends". Property to hold: the operator can see the resolved dispatch pool set (and any zero-match rule) WITHOUT committing to a dispatch. Would also give the A″ routing filter a runtime surface to verify at, which it currently lacks.

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

- **The reconciliation gate is silently disabled if the two confirmation artifacts split (G3 A′ review 2026-07-16, tool-should-decide, low).** The obligation gates on the per-tool SEAM (`has(bundle.provider_confirmation)`, `state.ts:98`) while the gate's delta early-outs on the SHARED artifact (`readSharedProviderConfirmation(root)`, `nextStepCommand.ts`). They are written together only under `if (root)`, so seam-present + shared-absent (a root-less promotion, or an operator deleting the shared file) ⇒ obligation satisfied AND delta `[]` ⇒ the gate never fires for the run, and `resolveExcludedProviders` also finds no policy ⇒ a newly-reachable backend routes unconfirmed. Narrow (needs the pair to split) but silent. Property to hold: the gate's CONFIRMED operand and the obligation's presence check must key on the same artifact, or a split must be loud. [[dispatch-policy-vs-reach-cut]]

- **Loop-core gate covers `src/audit/orchestrator/` but NOT the audit cli dispatch step-emitters (2a-ii lap, tool-should-decide, low-medium) [[loop-core-enforcement-layer]].** `LOOP_CORE_PATTERNS` includes `src/audit/orchestrator/` (so 2a-ii's Finding-A fix in `advanceTypes.ts`/`executorRunners.ts`/`intakeExecutors.ts` correctly demanded attestation) but NOT `src/audit/cli/nextStepCommand.ts` / `semanticReviewStep.ts` / `prompts.ts` — where the CORE 2a-ii dispatch-inventory READ switch lives. A dispatch-substrate edit confined to those cli emitters (plausible for 2a-iii's loader wiring) would ship WITHOUT the attestation backstop. Endpoint (owner call): either add the audit cli dispatch-emitters to `src/shared/loopCorePaths.ts` (+ the `.mjs` hook parity list), or accept them as cli-glue and rely on the reviewer catching it. Not auto-expanded — widening the set makes every edit to the big `nextStepCommand.ts` require attestation, a real friction tax to weigh. **G1 (`e7b593ac`) is a concrete SECOND instance:** a breaking dispatch-handshake transport change spanning `args.ts`/`prompts.ts`/`nextStepCommand.ts`/`semanticReviewStep.ts`/`prepareDispatchCommand.ts`/`quotaCommand.ts` shipped attestation-free (none are loop-core by path). An independent review WAS done by discipline (and caught a real roster-validation-drop regression) — so the reviewer-catches-it fallback held, but only because the author chose to run it. Reinforces the owner-call endpoint above.
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

- **Doc/lint gaps exposed by the G3 re-plan lap (2026-07-16) — three standing asks, all unbuilt at HEAD.** (1) **ambiguous-direction (HIGH):** a spec that states an ENDPOINT without marking what gates it reads as a flat contradiction of the code and of any memory describing the current phase, and invites a later agent to "fix" the spec to match the implementation (one G3 draft proposed striking an owner-approved decision on exactly this basis). The one instance is phase-qualified BY HAND — `spec/unified-dispatch-worker-model.md:201-206` ("Policy's home is PHASED, and the phase gate is real… They are phases of one design, not rivals") — but nothing enforces the marking. The only doc-lint over spec prose is [`design-docs-declarative.test.mjs`](../tests/audit/design-docs-declarative.test.mjs), which covers only `spec/audit-workflow-design.md` + `spec/remediation-workflow-design.md` and BANS status vocabulary (`currently`, `not yet`) — the very words a phase marker needs — so endpoint-vs-phase cannot be another banned-phrase row. Owner call: choose a marker grammar a lint can check (e.g. a required `gated by:` clause on any endpoint statement) without re-admitting status prose, and decide whether the lint's doc set widens past the two design docs. [[spec-degradation-and-doc-staleness]] (2) **inefficient-feeding (HIGH):** dated `docs/reviews/*.md` plan docs read as self-sufficient (verified ground-truth tables, owner decisions, scope), so an agent entering from `docs/HANDOFF.md`'s "▶ IMMEDIATE NEXT" plans from the PLAN and never opens the design of record — the plan carries the mechanism, the spec carries the GOAL (owner, of prior laps: *"agents keep forgetting the actual goals"*). Unbuilt: no doc under `docs/` contains a "Goal (from spec …)" restatement, and HANDOFF's ▶ section plus the Open-tracks "Full pickup" pointers name backlog entries and dated review records, never the spec first. Fix direction: a mandatory goal-restatement header on dated plan docs (mechanically checkable in `scripts/check-doc-manifest.mjs`, which already reconciles the review-doc set), or spec-first pointer ordering in HANDOFF. Cf. [[front-load-broad-search-before-contract-authoring]] (3) **tool-should-decide (medium):** three of four G3 drafts specced a gate that would never fire, each caught only by an adversarial agent tracing the call path. The neighbouring lints exist — `tests/audit/executor-registry-sync.test.mjs` (every `PRIORITY` obligation has exactly one executor and a `buildAuditObligations()` fold entry) and `audit-orchestrator-invariants.test.mjs` INV-03 (every executor write-set artifact sits in `ARTIFACT_DEPENDENTS_MAP`, so staleness can reach it) — but the two reachability properties themselves are unchecked: a satisfy-predicate with no transition back to unsatisfied, and an executor that consumes an input without invalidating it. Both are predicates over opaque `derive`/`execute` closures on `ObligationDef`, so the open question is what a checkable encoding looks like (declared `consumes`/`invalidates` fields the lint can cross-check against the dependency DAG?) before any lint can be written. [[gate-must-be-traced-not-designed]]

- **Friction walk (repair-proxy dogfood lap, 2026-07-15):** (1) **tool-should-decide (medium), overlaps [[quota-before-cost-ordering]]:** the cost ordering shows models.dev **LIST price** ($1.92 for nim/glm-5.2), but the operator pays **$0** for it (NVIDIA NIM free tier). Free-to-operator vs metered is a per-`(operator,backend)` fact the catalog can't know; discovered pools default to list price, so a genuinely-free backend sorts as if expensive and a paid one (openrouter) can hide mid-list. Today's only lever is hand-declaring `cost_per_mtok:0` / `enabled:false` per backend in `repair_proxy.providers` (done for this run) — the tool should let the operator classify a backend's cost-relationship once, not re-price every model. (2) **tool-should-decide (low):** no way to mark a whole discovered transport's sub-provider as paid→excluded at Gate-0 itself; had to edit session config + re-run next-step. (3) **tool-should-decide (medium), = [[per-model-tiering]]:** owner reinforced that capability/tier is assigned per PROVIDER, not per (provider, model, effort). Concrete: Codex (`~/.codex/config.toml` model=`gpt-5.6-sol`, effort `high`, but `-m/--model` + `-c model=` take any model per-call) renders at Gate-0 as ONE `capable`/`resolved at dispatch` row because the legacy `codex` block has a single `model` field — its multiple models at different capability tiers collapse to one. The tool's own workaround (pin `sources[]` `{provider:codex, model, parameters:{extra_args}}` per model/effort) puts the burden on the operator; the tiering should be per-(provider,model,effort) natively, sourced from models.dev / declared config. (4) **env-var trap (low):** repair-proxy `mistral` provider hardcodes `authEnv: "MISTRAL_API_KEY"`, but the operator's Mistral La Plateforme key lived in `CODESTRAL_API_KEY` (Codestral and La Plateforme share one key but the env-var name differs) → pool silently `has_key=false`/excluded until the authEnv was repointed. A reachability probe that reports "keyed but wrong-env-var" vs "no key" would cut the diagnosis.

- **Friction walk (force-synthesize→remediate dogfood lap, 2026-07-12) — item (2) refuted at HEAD, item (1) restated:** **inefficient-feeding (medium):** every contract-pipeline phase that still needs judgment is authored by the HOST conversation, and there is no route to a $0 pool. `buildParallelModuleWaveStep` (`src/remediate/steps/contractPipeline.ts:1634`) calls `scheduleWave` for a fan-out *cap only* — the comment at `:1663` states outright that `capacity_pools` never reaches `buildDispatchQuota` from here — so the per-module drafting wave, like every other phase step, renders a prompt asking the HOST to dispatch sub-agents (`:1705`). Determinism has already trimmed the count (`obligation_ledger` `:1968`, `contract_finalization` `:2014`, the single-module `seam_reconciliation` no-op `:1984` and the no-cycles `cyclic_seam_resolution` `:2349` are tool-derived; `FRAMING_COLLAPSE_GROUP` `:164` folds goal→context→decomposition into one round-trip at the low tier), so the true figure is ~9-11 host round-trips, not the ~15 first logged — but every one of them bills host quota BEFORE the first implement dispatch, so routing fixes on the implement half never touch the planning bill. The second half is real but DELIBERATE, not accidental: a validation failure moves the host's `<name>.input.json` into `contract/history/` (`archiveContractArtifact` `:409`, archived rather than deleted so no LLM output is destroyed) and `rejectionRewriteInstruction` `:457` instructs "Write a fresh complete artifact at its original path — do NOT Edit the previous file", so a one-field schema error costs a whole re-author. **Both remaining halves are owner calls, not bounded fixes:** (a) should the planning phases become dispatchable to a non-host pool (they are the only pipeline half that cannot be), and (b) is a targeted in-place repair path worth admitting for a single-field rejection, against the whole-artifact-rewrite invariant that currently makes re-emission trivially correct? **Dropped — the implementation_dag citation-grounding claim does not describe the gate at HEAD.** `validateContractCitationGrounding` grounds `affected_files` FIRST via `groundDesignFinding` (`src/remediate/validation/contractPipelineGates.ts:1198`), then path-shaped tokens against the tracked-path set *plus* real parent directories so a not-yet-created file still grounds (`:1222`); prose tokens are the last resort, not the gate. `normalizeRepoPath` preserves a dotfile-dir leading dot by invariant (INV-B3-1, `src/shared/validation/findingGrounding.ts:46`, pinned red-green by `tests/remediate/source-grounded-citation.test.ts:87`), and `deriveNodeFiles` (`contractPipeline.ts:2947`, `c60eb73f`, landed three hours after this entry was written) gives every DAG node a file scope, so a scope-less node can no longer fall through to prose-token grounding at all. [[synth-scopeless-nodes-doomed-run]]

- **CI coverage gap: a docs-only commit skips the vitest suite, so a doc-lint / staleness-parity regression lands on main UNCAUGHT (2026-07-15, tool-should-decide, medium).** `audit-code-test-suite.yml`'s release-bump/docs skip guard skipped the vitest suite for commit `016d5945` (an owner-approved doc-review resolution touching `spec/audit-workflow-design.md` + `spec/audit/dependency-map.md`), so its two deterministic failures (design-docs-declarative banned-status-language at :85; staleness F1 inv-6 dep-map parity, where a producer-table row bled into the naive `.md` edge parser) sat red on main until the next CODE push re-ran the suite. Both were cheap, deterministic, doc-derived checks. Endpoint: run the doc-lint + dep-map-parity tests (design-docs-declarative, the staleness literal-parity guards) in the cheap `ci.yml` chain which does NOT skip on docs commits — a doc commit that breaks a doc-derived invariant should fail its own push, not the next unrelated code push. (Both failures fixed in `5c9edcb2`; the skip guard itself is the open item.)

- **Exact key-set leak-guards name the offending field in the diff but not in the failure headline (2026-07-15 friction walk, tool-should-decide, low).** `tests/audit/review-packets.test.mjs:1071` asserts `Object.keys(plan[0]).sort()` against a literal key list — an additive-hostile leak-guard by design, so ANY new field on `DispatchPlanEntry` (`src/audit/cli/dispatch/types.ts:144`) reds it. When it fires the headline is `expected [ 'access', 'complexity', …(6) ] to deeply equal [ 'access', 'complexity', …(5) ]` — those counts are "N more items", not key counts, and no field name appears; the key is named only in the +/- diff the default reporter prints below it (`vitest.config.ts:29` keeps `"default"` in `reporters`, so the diff is never lost). So a log tail, a job-summary line, or a truncated CI excerpt reads as an opaque count mismatch. Endpoint: a shared `expectExactKeys(actual, expected, label)` helper under `tests/helpers/` that asserts on the sorted unexpected/missing delta, putting the field name in the headline itself; low value while the diff is right there. The one concrete instance is CLOSED — `DispatchPlanEntry.file_paths` was added by an adversarial-review HIGH-fix AFTER the full-suite run, only targeted tests were re-run, release CI shard 1/4 caught it, fixed in `85593e05` (one forward-bump). Standing rule from that miss: a post-review change to a CONTRACT SHAPE (a new field on a persisted/asserted type) forces a full-suite rerun — the blast radius is every exact-shape assertion, not the changed module.

- **A stale-artifact re-extraction `next-step` runs >2min with no progress signal, silently blowing a caller timeout (live dogfood 2026-07-17, inefficient-feeding, low).** After the design-review passes, the drain re-extracting 11 stale artifacts (repo_manifest/graph over 1250 components / 8466 edges, invalidated by a docs commit) exceeded a 2-minute command timeout with only a flood of identical `{"kind":"staleness",...}` lines and no heartbeat — forcing a blind retry at a longer timeout to see if it was wedged or working. Property to hold: a long deterministic drain should emit a progress/phase heartbeat (or the staleness spam should collapse to one line) so a caller can distinguish "working" from "wedged" without a retry. Minor; the retry succeeded.

- **RESOLVED 2026-07-17 (with a corrected root cause): "Conversation-first dispatches HOST-ONLY".** The premise "resolved pools never fan into the wave" was REFUTED by the run's own artifacts — the pools WERE folded in and driven; the real chain was null `contextCapTokens` (fit gates silently no-op) → 413/429 → ANY-non-complete-drive settles ALL pools → frontier collapses onto the walled host → false "exhausted" wall. Fixed as unified-routing steps A–G (never-null windows, one fit predicate, per-pool reason-aware settle, honest wall, capability floor, packer/fit consistency) — 6 attested loop-core commits, records `docs/reviews/host-fanout-premise-refuted-2026-07-17.md` + `unified-dispatch-routing-design-2026-07-17.md`. ⬇ Live-run watch (fresh conversation-first self-audit): small pools take fitting packets; an oversized packet SKIPS (no 413); a 429 on pool A leaves pool B dispatchable; a zero-grant renders its honest cause. [[grep-the-writers-before-believing-inheritance]] [[repair-proxy-dispatch-unblocked-probe-fix]]

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

- **Gate-0's quota-demotion primitive (`CostCandidate.saturated`) is unwired — and the real question is whether Gate-0 is the right layer at all (2026-07-13 audit-gate review; re-verified against HEAD 2026-07-24).** `suggestCostOrdering` (`src/shared/dispatch/costRank.ts:216-256`) stably partitions `saturated` candidates below healthy ones, but nothing in `src/` ever sets the flag — the only writers in the tree are `tests/shared/cost-rank.test.mjs`; `annotateConfirmedPool` (`src/shared/providers/providerConfirmation.ts:352-410`) builds every provider / host-model / source candidate with no quota query. **Two facts make the obvious "probe quota at the candidate-building site" fix wrong-shaped, and they ARE the open decision:** (1) `provider_confirmation` is `PRIORITY[0]`, so Gate-0 runs before any dispatch in the run — `quota-state.json` normally carries no live cooldown at that moment and a local probe would be inert in the common case; (2) the suggestion IS the persisted order — with no operator `cost_order`, `resolveFinalCostOrder` returns `suggested_order` verbatim (`providerConfirmation.ts:296`), `readConfirmedCostPositions` reads it back off disk, and `deriveCostRank` treats it as rung 1, authoritative OVER price — so a transient 60s cooldown observed at Gate-0 would demote that pool for the entire run. Meanwhile dispatch already gates on LIVE headroom (`admissionPoolsFromSummaries` budget from `remaining_token_budget`; `computeWaveSchedule` sets `binding_cap: "cooldown"` / waveSize 1), so costRank is a sort key, not the admission gate — the unwired flag costs ordering fidelity, not admission safety. Mapping is also non-trivial: three candidate keyspaces (provider NAME, bare host `model_id`, `source::<id>`) must reach `quotaPoolKey`'s `provider[#account]/model`, and account resolution is async while `annotateConfirmedPool` is sync. **Owner decision before any wiring:** (a) probe local cooldown at Gate-0 and accept a frozen, usually-empty snapshot; (b) probe live quota per source at Gate-0 (N network calls, still frozen); (c) move the demotion to the dispatch read-back, where quota is live per wave; or (d) delete `saturated` + its partition + tests as a primitive at the wrong layer. [[quota-before-cost-ordering]]

- **agy quota may reuse the wrong credential store (unverified, live-check).** agy is aliased into AntigravityQuotaSource (`src/shared/quota/antigravityQuotaSource.ts`, `ANTIGRAVITY_PROVIDER_NAMES`) which reads the IDE's `state.vscdb`/`ANTIGRAVITY_ACCESS_TOKEN`. Unverified whether the agy CLI shares that IDE credential store; if not, agy quota reads silently return null (degrade). ⬇ Live-run watch (agy install): confirm agy quota reads are non-null off its real endpoint.

- **Dispatch routing: JIT reservation on the HOST path + the headless/hybrid branch collapse — the remaining two thirds of the pool-agnostic-claims design (2026-07-13; concept spec 2026-07-16; re-verified against HEAD 2026-07-24).** Design of record: [`spec/dispatch-jit-claims.md`](../spec/dispatch-jit-claims.md) (claim = exclusivity not routing; planner = live capability feed; quota reserved at the launch moment); build sequencing in [`docs/reviews/unified-dispatch-routing-design-2026-07-17.md`](reviews/unified-dispatch-routing-design-2026-07-17.md). **The claim leg is effectively satisfied and its old framing ("drop `poolId` from claims") is now WRONG** — `ClaimRegistry.claim` decides exclusivity on presence+staleness alone and never consults `poolId` (`src/shared/quota/claimRegistry.ts:123-136`), no consumer reads the stored value (`partitionByOwnership` reads only `ownerToken`), and the field has since become the DRIVER identity that `claimMany`'s same-owner re-grant (`:152-176`) and `releaseOwned`'s owner-scoped release (`:210-224`) depend on, so deleting it would regress the completion-livelock fix. What is left there is naming hygiene only: rename `poolId` → `ownerId` and have `coordinator.ts:227` pass a driver id instead of `pool.id` (today a write-only value). **Genuinely open:** (a) **JIT reservation on the HOST path** — the in-process engine already reserves at launch (`rollingDispatch.ts:1741` `admitAgainstLedger` immediately before `dispatchOnePacket`), but the host path still grants a whole wave's leases at plan time (`finalizeDispatchQuota({ grantLeases: true })`, `hostFanoutGate.ts:226-236`; the two-mode split is documented at `admissionLoop.ts:887-896`), so a host grant can go stale between plan and launch; (b) **host-path convergence** — the headless (`nextStepHelpers.ts:2309`) and A-8 hybrid (`:2419`) arms are still a branch pair (routing-design H2; H4's `shouldDemotePrimaryInProcess` is already gone from `src/`). [[relax-dispatch-source-forcing]]

- **Accept-latch family — SHIPPED 2026-07-23 (a/c/d fixed, b REFUTED at HEAD); two low residuals stay open here.** Mechanism record: `docs/reviews/accept-latch-family-mechanisms-2026-07-23.md`. (a) a failed accept now records `session.accept_failed` (terminal-with-signal, never latched-accepted; directive surfaces the ids and the dispatch prompt routes them to `reverify-node`); (b) the "rollback to session-recorded base" mechanism does not exist at HEAD — `baseOid` is tip-at-accept-start under the base lock; the live sibling-drop is attributed to mixed-version/mixed-lock-path operation during recovery chaos; (c) resolved via (a) + signposting (worktree removal pre-gate is by design; recovery is `reverify-node`, which builds a fresh worktree); (d) a `resolved_no_change` closure whose sidecar records a landing is now ancestry-adjudicated (reachable landing → genuine "already satisfied"; unreachable or unverifiable → blocked to triage). Residuals (low): a rolling-dispatched node whose accept sidecar is ABSENT at merge (runId-mismatch chaos case) is indistinguishable from the interim main-tree path and closes unverified — needs a rolling-path marker independent of sidecar presence; the sidecar's monotonic `merged:true` guard still blanket-preserves stale records (the ancestry probe is the corrective; revisit only if a case escapes it).

- **Node-worktree guard — accepted residuals only (each low, on-evidence-only; the guard itself shipped v0.34.19).** Mechanism, refuted alternatives, and review disposition: `docs/reviews/node-worktree-guard-mechanisms-2026-07-23.md`. Deny-by-default CLI refusal (`assertCliCommandAllowedFromCwd`, `src/shared/io/nodeWorktreeGuard.ts`) is wired at both CLI chokepoints (`src/audit/cli.ts`, `src/remediate/index.ts`) over caller cwd + wrapper-stamped `AUDIT_TOOLS_CALLER_CWD` + raw `--root`, with remediate-side writer asserts (`state/store.ts`, `steps/rollingSession.ts`) behind it. What stays open: audit-side session writers have no writer assert and rely on the CLI guard alone (add one only if a non-CLI clobber shape ever fires); a worker that both `cd`s out of its worktree AND passes explicit targets can still reach shared state (containment, not authority — the `implementPrompt` "Standing rules" section is the remaining layer); a failed review-snapshot degrades spawned audit workers to the REAL checkout (`src/audit/cli/rollingAuditDispatch.ts`, `resolveReviewRoot`), where the cwd predicate cannot fire and write-scope is prompt-only for that run — loud (stderr + a high-severity `write_scope_degraded` friction event) but unguarded; dist-dependent verify commands deferred by `partitionDistDependentVerifyCommands` are subsumed by the close gate's full-suite run rather than individually re-run.

- **Branch-strand trap has bitten THREE times — needs a tool-enforced fix, not a HANDOFF warning (2026-07-22, tool-should-decide, medium).** `ensureRemediationBranchCheckedOut` silently switches the primary checkout onto `remediation/<runId>` at implement-dispatch prepare, and any subsequent `git commit` from that checkout (docs, closeouts) strands off main — HANDOFF has warned since the second bite and the warning did not prevent the third (recovered same-session via branch reset + temp-worktree cherry-pick; the very next doc edit then nearly landed on the run-base version of this file). "Verify HEAD before committing" is host discretion, which this project bans as a fix. Candidate mechanisms: the dispatch/accept flow operates the remediation branch through a dedicated linked worktree (primary checkout stays on main), or a repo-local pre-commit guard refuses a commit on a `remediation/*` branch whose staged set is docs/spec-only (almost certainly meant for main). Either makes the strand impossible rather than remembered-about.

- **`tests/shared/rollingDispatch.test.mjs` is a genuine timing flake (2026-07-12, tool-should-decide, medium).**
  "second dispatch should start after first completes: expected 1 to be 2" — a wall-clock/ordering assertion
  that flakes under full parallel load; passes in isolation. It flaked the v0.32.62 publish CI (shard 2/4;
  the CI test suite has no `--retry`, unlike the now-hardened remediate gate) → re-run cleared it. De-flake the
  test itself (deterministic scheduling/fake timers), per test-failure-protocol "passes alone = hermeticity/
  timing bug → fix the test." Until then, a publish may need one CI re-run.

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

- **openai-compatible content-inlining — residuals (each low, documented at the code site) ([[openai-compatible-content-inlining]]).**
  (a) **large-packet hard-refuse** — a review packet whose `file_paths` exceed the default caps
  (64KiB/file, 256KiB total, 24 files) REFUSES on a single-shot worker rather than silently
  half-reviewing (intended: loud > fabricated coverage; operator raises `openai_compatible.referenced_*`
  caps or routes to a file-reading provider). (b) The stat-error branch refuses on a non-ENOENT error
  (EACCES/ELOOP) for an existing granted file — correct, but untested (hard to simulate portably).

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
  Owner's spec: when dispatching up to quota with tokens estimated a-priori, the ONLY legitimate reasons to
  hold a packet for a later dispatch are (1) a non-parallelizable predecessor finishes and UNLOCKS the task,
  (2) the quota window refreshes, (3) the pool is RATE-limited (RPM/TPM) — not budget-limited. Any other
  hold is pure latency. Mapping onto audit-code:
  - Base review packets are embarrassingly parallel (read-only, no write conflict, no ordering) → they
    should ALL dispatch the instant they fit budget+rate; the `next-step → dispatch → merge-and-ingest →
    next-step` barrier on the host path is an artificial wave, NOT one of (1)/(2)/(3).
  - The IN-PROCESS rolling engine (codex/NIM via `driveRollingAuditDispatch`) ALREADY implements the correct
    model — continuous slot-pull, dispatch-to-capacity, refill-on-completion, pace-on-rate. The host path is
    the deviation.
  - Legitimate (1) DOES apply to ONE layer: selective-deepening tasks are derived from completed packets'
    findings (`+N deepening` per merge), so a merge must precede them — the barrier is correct for the
    deepening layer, artificial for the base frontier.
  **SPEC — delete "wave" as a concept; express the one legitimate barrier as a DEPENDENCY.** The layer
  that genuinely needs a merge first needs it because its work does not exist until earlier results land —
  that is precisely a task unlock, which is already reason (1) on the owner's own list. Modelling it as a
  global phase boundary is what forces every unrelated packet to wait for it, so the barrier and the
  artificial latency are the same mechanism.
  Once the deepening layer's prerequisite is a dependency edge rather than a phase, there is nothing left
  for "wave" to mean: everything is gated by budget, rate, and dependency unlock, uniformly, and the
  in-process engine's continuous slot-pull becomes the only model. **The host path converges onto that
  engine rather than keeping a second scheduler** — the deviation is the host path, not the engine, and
  maintaining both is the fork this project's one-core rule exists to prevent.
  **Property to hold:** a packet is held for exactly three reasons — its dependencies are unmet, the pool
  is rate-limited, or the budget will not admit it. No fourth reason exists, and "the previous phase has
  not finished" is not one of them.
  - The calibration cap (below) is a FOURTH, illegitimate hold: it throttles on not-knowing-quota-in-tokens,
    which is neither budget, rate, nor unlock — and never resolves. Endpoint: host admission should grant the
    full budget-and-rate-fitting independent set at once (like the in-process engine), reserving merge-gated
    re-grants for the deepening layer only. Realizes [[self-scaling-pipeline-not-forked-paths]] on the host path.

- **Host fan-out quota gate — residual: AD-HOC host Agent spawns sit outside every ledger (re-verified 2026-07-24, low, [[host-fanout-quota-gate]]).** The prescribed half is SHIPPED: `gateHostFanout` (`src/audit/cli/dispatch/hostFanoutGate.ts`) runs at the five fan-out emitters in `nextStepCommand.ts` (four `design_review`, one `systemic_challenge`), granting a panel all-or-nothing through the same `buildDispatchPool` → `finalizeDispatchQuota` → `detectHostDispatchWall` primitives as packet dispatch, with per-family leases under `fanout-quota/<family>/`. What remains is every OTHER host Agent spawn — the recon/review/compaction subagents the conversation host launches on its own initiative, with no tool call in between: no admission, no lease, and no per-agent record, so nothing names what was in flight when a session limit lands (contrast remediate-code's per-node worktrees + claims). Their spend is not wholly invisible — it moves the account percent, so it arrives as unattributed pct drift in the merge-time slope fold (`tokenUsageObservation.ts` C5 note: understated slope, the safe direction) — but drift is not accounting.
  **This is an owner call, not a bounded fix:** the tool cannot gate a dispatch it never sees, and both mechanical routes are barred by standing rules — a `note-fanout`-style CLI the host must remember to call is host discretion, and a PreToolUse Agent hook is a host-IDE coupling. Decide the shape first: (i) every fan-out routes through a prescribed step so "ad-hoc" stops existing as a category, (ii) ad-hoc spend is explicitly accepted as unmetered account drift the pre/post attribution already absorbs, or (iii) an IDE-hook accounting layer is accepted as a deliberate, documented exception to IDE-agnostic. (Absorbs sliver (b) of the "ledger-writer / acceptNode-inert-clean lap" entry below — drop that half when this lands so the item has one home.)

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

- **Friction-walk lesson (ledger-writer / acceptNode-inert-clean lap):** `[[spec-degradation-and-doc-staleness]]`
  (verify premises before building; a pause/interrupt is not a content-veto) — see memory. Open tool slivers:
  (a) NIM `llm read` going down silently degrades the "route review to free NIM" plan to paid subagents with no
  signal — a health-probe-then-route would remove the guesswork; (b) ad-hoc Agent fan-out (recon/review)
  still has no per-agent ledger for a session-limit mid-edit death, unlike remediate-code's per-node
  worktrees + claims.

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

- **Friction-walk lesson (D-66/67 slice-1 ownership-gate lap):** design-level adversarial review pays for
  itself before a line is written, and review depth should scale with delicacy
  (`[[delegate-adversarial-phases-to-separate-agent]]`) — see memory. Open tool sliver (low value): the
  PreToolUse commit-gate fires on the whole Bash call before a chained `attest && git commit` runs, so the
  attestation half hasn't executed when the gate checks (workaround = attest as its own call); a gate that
  recognized the attest step in the same chain would remove the trap.

- **Friction-walk lesson (backlog-clearance lap):** a backlog item / chosen option / design memory is a
  point-in-time proposal — verify its premises against current code AND a real measurement before building
  (`[[spec-degradation-and-doc-staleness]]`) — see memory. Open tool sliver: the pre-commit gate that
  silently failed-open in linked worktrees is FIXED (scratch index → `os.tmpdir()`), but the durable
  improvement — make a fail-open on infra fault OBSERVABLE (a one-line stderr when the staged-snapshot path
  bails) rather than silent — is not yet done.

- **Top gate optimization lead (measured 2026-07-06, was the "vitest collect" item).** First profiled
  numbers (win32, Node 26 local; CI Linux will differ but the shape holds):
  - **`verify:checks` gate = 95.8s, of which `smoke:packaged-audit-code` alone is 70.2s (73%).**
    `smoke:packaged-remediate-code` is 13.2s; everything else is ~12s combined. **→ The highest-leverage gate
    win is the packaged-audit-code smoke.** Internal breakdown (measured): `next-step ×~7 to dispatch_review`
    = 35.9s (53% — the real audit-flow round-trips, inherent coverage), `npm install from tarball` 9.3s,
    `next-step to present_report` 10.1s, `npm pack` 7.2s (incl. a prepack rebuild). The next-step round-trips
    are fresh-process pipeline runs — cutting them cuts coverage, so this needs a real design (e.g. an
    in-process multi-step driver for the smoke, or packing once and sharing the tarball across both smokes
    since they build the identical `audit-tools` package), not a quick trim.
    **SPEC — build the tarball ONCE, assert many. Do not build an in-process smoke driver.** The two
    candidates are not equivalent: an in-process driver consolidates ORCHESTRATION, but the duplicated
    work is the REBUILD, so it optimizes the wrong axis and additionally weakens the smoke — the entire
    point is exercising the real packaged/global-install path, which nothing else catches, and running it
    in-process erodes exactly that. Meanwhile both smokes pack the identical package.
    Resolution: one build phase produces the tarball, and every packaged smoke installs from that same
    artifact into its own fresh sandbox and runs its own assertions. Smoke semantics are unchanged and
    coverage is untouched — only the redundant rebuild is removed. ⚠ The next-step round-trips are NOT a
    target: they are fresh-process pipeline runs and cutting them cuts real coverage.
  - **Full vitest suite = 307s wall (452 files), `collect≈211s`** (confirms the old ~186s estimate), run
    time dominated by audit integration tests that spawn real subprocesses: `audit-code-completion` 285s,
    `audit-code-wrapper` 237s, `next-step` 165s, `cli-remediation` 111s. area:audit ≈ 1905s summed across
    workers vs remediate 451s / shared 62s. `pool: 'threads'` / `isolate: false` won't help the run-time
    tail (it's subprocess wall, not isolation overhead); the real lever is the sharding already shipped +
    possibly splitting the few 100s+ integration files across more shards. Only pursue collect/pool changes
    with per-file verification (many tests mutate fs / spawn subprocesses → isolation-off risks bleed).

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
