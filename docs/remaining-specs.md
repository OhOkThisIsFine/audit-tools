# Remaining specs — audit-tools

Design-level specs for every open item in [`docs/backlog.md`](backlog.md), written
2026-06-19. Scope: **everything** still open; ordered roughly as the backlog lists
it; depth is **design-level** (problem → approach → decisions → tradeoffs →
acceptance criteria → effort), not file-level implementation. Each section links
back to its backlog entry. Decisions Ethan settled on 2026-06-19 are marked
**DECIDED**; smaller open choices are marked **DECISION** with a recommendation.

Effort key: **S** = <½ day, **M** = 1–3 days, **L** = a multi-session track.

> When an item ships, delete its backlog entry AND collapse its section here to a
> one-line "shipped (commit)" pointer — keep this a spec doc, not a changelog.

---

## A7 — Multi-host install/integration validation  · **L**

**Problem.** The package deploys host assets (slash command / skill / agent /
permissions) to Claude Code, Codex, OpenCode, and Antigravity via
`scripts/postinstall.mjs`, and Ethan runs it daily in all four — but only Claude
Code is validated end-to-end. The other three can silently break on a release
(asset path drift, a host that renders the command differently, a dispatch that
never reaches a worker) and we'd never know until a live run fails.

**Approach (DECIDED: automated CI checks + a manual GUI checklist).** Split
validation by what CI can actually exercise:

1. **Automated (CI, every host, every release).** A `verify:hosts` script that, per
   host, runs `postinstall.mjs` against a temp `$HOME`, then asserts the deployed
   artifacts exist, parse, and match the single canonical source body (reuse the
   existing no-drift guard that already proves every IDE asset derives from one
   body). Covers: asset presence + path correctness, command/skill/agent manifest
   shape, permission scoping. Add it to `verify:release` so a drifted host asset
   fails the gate pre-publish (same class of bug as the A6 `requiredPackagedPaths`
   miss).
2. **Manual GUI checklist (release-time, GUI hosts).** A `docs/host-validation.md`
   checklist for the things CI can't reach — actually invoking `/audit-code` inside
   Antigravity / OpenCode / Codex and confirming a real dispatch round-trips. One
   row per host: install → command appears → run one bounded audit step →
   result lands. Ethan runs it at release; failures become backlog items.

**Key decisions.**
- Single-source the per-host asset expectations from the same table
  `postinstall.mjs` deploys from, so the automated check can't drift from the
  deploy (enforce-in-tooling, not a hand-maintained list).
- Codex is a headless CLI → its live dispatch *can* be automated (treat like the
  Claude path); only Antigravity (agentic IDE) and the OpenCode GUI are
  checklist-only.

**Tradeoffs / risks.** The manual checklist is host-discretion by nature — mitigate
by keeping it short and making the automated half cover everything mechanizable.
GUI hosts may change asset formats out from under us; the no-drift guard catches
*our* drift, not the host's — the checklist is the only catch for that.

**Acceptance criteria.**
- `npm run verify:hosts` (and `verify:release`) fails if any host's deployed asset
  is missing, unparseable, or diverges from the canonical body.
- Codex live-dispatch e2e exists (gated like the NIM e2e).
- `docs/host-validation.md` exists with a per-host manual row covering install →
  command-visible → one live dispatch.

---

## A8 — Hybrid spill topology + live cross-provider run  · **M**

> **✓ SHIPPED — `audit-tools@0.28.10` (2026-06-20).** Every acceptance criterion below is met, BOTH orchestrators
> live-validated (gated `RUN_NIM_E2E=1`): the coordinator single-claims + proactively splits the frontier
> host-vs-NIM, both pools receive nodes, the gated live e2es land work via each pool (remediate `hybrid-nim-e2e`
> + audit `hybrid-nim-audit-e2e`), silent-signal pools fall back to byte-estimate+margin, and
> `a8-rolling-cutover-plan.md` §Step 7 records it. Memory: `a8-hybrid-full-scope`, `dispatchable-sources-generic`.
> Design rationale retained below.

**Problem.** The rolling engine, in-process provider driver, `openai-compatible`
2nd pool, and per-slot provider resolution are all built and individually
validated. The unbuilt residual (FINDING-020 capstone) is the **hybrid topology**:
the Claude host-subagent driver and an in-process NIM pool running *concurrently*,
with work spilling from the primary pool to the secondary, plus a real live
cross-provider run proving it.

**Approach.** Two pools advertised at once; the quota scheduler's existing
INV-QD-14 spill routes a node to the secondary pool when the primary is saturated
or rate-limited. The hard part is that the two drivers are structurally different
(host-subagent = turn-based `accept-node` callbacks; in-process = the tool owns the
dispatch loop). Spec: a thin **coordinator** that owns the frontier + quota
accounting and feeds *both* drivers — the host-subagent driver pulls nodes it
should spawn (returned in the step contract), the in-process driver pulls nodes it
runs itself, and `acceptNodeWorktree` (already shared) merges both identically.

**DECIDED — proactive spill.** The coordinator distributes the frontier across BOTH
pools *continuously* by available capacity, not only when the primary is blocked: as
long as both pools have headroom, nodes flow to both concurrently to maximize
throughput. This makes a trustworthy per-pool capacity estimate (INV-2 below) a hard
dependency — proactive balancing is only as good as the capacity signal it reads, so
it must degrade safely (byte-estimate + safety margin) when a pool's signal is
silent, never over-committing on a confidently-wrong number.

**Pool discovery (folded in from FINDING-020 / former INV-2).** A8 also owns
detecting the host's own models to stand up additional pools and per-packet provider
assignment — the coordinator + claim registry (A10) + per-slot provider resolution
ARE heterogeneous dispatch, so it is built here, not as a separate track. The only
distinct residual is host-model detection feeding the pool set, specced as part of
A8's pool setup.

**Tradeoffs / risks.** Concurrent drivers sharing one frontier is the genuinely new
coordination surface — race on "who claims node X." Mitigate by making the
coordinator the single claimant (a node is assigned to exactly one pool before
either driver sees it). Proactive balancing on a wrong capacity number over-commits
to a pool that's actually blocked — the safe-degradation floor (below) is the guard.
The live run needs both a Claude session AND a NIM key present at once — gate it like
the existing NIM e2e (`RUN_NIM_E2E=1`).

**Acceptance criteria.**
- One coordinator assigns each frontier node to exactly one pool; no double-claim.
- With both pools healthy, work is distributed across BOTH concurrently (proactive),
  proven by a test that asserts both pools receive nodes when each has capacity.
- A gated live e2e runs an audit (or remediate) with both pools active and asserts
  nodes land via each pool — never false-resolved, write-scope still enforced.
- A pool with a silent/absent capacity signal falls back to byte-estimate + margin,
  never over-committed (test).
- `docs/a8-rolling-cutover-plan.md` updated to mark the hybrid done.

**Depends on:** INV-2 (cross-provider quota detection) — proactive balancing reads a
trustworthy per-pool capacity estimate; sequence INV-2 first/alongside.

---

## A2 — Falsifiable finding-quality oracle  · **L**

**Problem.** There is no objective measure of audit output quality — precision
(are findings real?), recall (did we miss known issues?), hallucination rate. We
can't tell if a change improves or regresses the audit, only that tests pass.

**Approach (DECIDED: hand-label past audit runs).** Build the golden corpus from
our own `audit-findings.json` outputs:

1. **Corpus.** Collect prior real audit runs (self-audits + dogfood runs already in
   the repo's history / artifact dirs). For each finding, a human applies one label:
   `true_positive` / `false_positive` / `hallucinated` (cited code doesn't exist or
   says otherwise). Store as a versioned `corpus/<run-id>.labels.json` keyed by a
   stable finding identity (reuse `findingIdentitySignature`), decoupled from the
   raw run so re-running the auditor can be scored against the same labels.
2. **Scorer.** A deterministic `score-audit` tool: given a fresh audit over a corpus
   repo + the labels, compute precision, recall (against the labeled
   true-positive set), and hallucination rate (findings the grounding pass should
   have caught). Output a JSON scorecard + a human summary.
3. **Recall ground truth.** Recall needs known-issues the auditor *should* find.
   Bootstrap from the labeled true-positives of prior runs (did this run re-find
   them?); note this is recall-against-known, not absolute recall.

**Key decisions.**
- **DECISION — CI gating.** Recommend **track, don't gate, initially**: emit the
  scorecard in CI and fail only on a hallucination-rate regression (the one metric
  that's unambiguous and already half-enforced by grounding). Precision/recall
  thresholds are tuned after a few runs establish a baseline — gating on them
  prematurely makes the suite flaky on legitimate finding-set changes.
- Labels live in-repo (small JSON), corpus *repos* referenced by pinned commit /
  fixture, not vendored wholesale.

**Tradeoffs / risks.** Labeling is real human effort and the corpus is only as good
as the labels; start with ONE well-labeled run and grow. Findings drift (reworded
titles) — the stable-identity keying mitigates but cross-run matching is imperfect;
the scorer must report "unmatched" findings rather than silently scoring them.

**Acceptance criteria.**
- `corpus/` holds ≥1 fully-labeled real run.
- `score-audit` produces precision / recall-against-known / hallucination-rate for
  a fresh run vs. the labels, deterministically.
- CI emits the scorecard; hallucination-rate regression fails the build.

---

## A9 — Single autonomy acceptance test  · **M**

**Problem.** No single test proves the whole audit→remediate loop runs unattended
to a green, sensible end state. We validate pieces; nothing asserts the composed
autonomous run.

**Approach.** One gated, end-to-end acceptance test over a fixed target (a small
seeded fixture repo, or a pinned commit of a real one): drive `audit-code`
next-step to completion, promote findings, drive `remediate-code` next-step to
completion, assert: the run reaches `complete` with no host intervention, the
remediation branch exists with landed commits, the final gate is green, and every
source finding has a terminal disposition in the coverage ledger (no silent drops).

**DECISION — does it create a PR?** Recommend **stop at the remediation branch**
for A9 (assert the branch + outcomes contract), and treat PR creation as part of
the scheduled-autonomy loop (a separate, later piece) — A9 proves the *engine* runs
unattended, not the delivery mechanism. Keeps the test hermetic (no GitHub).

**Tradeoffs / risks.** A real LLM in the loop makes it non-deterministic / slow /
quota-bound → gate it (`RUN_AUTONOMY_E2E=1`) and run it against the cheapest
viable provider (the NIM pool) so it's affordable to run on demand. The seeded
fixture must contain findings the lean/contract path will actually act on.

**Acceptance criteria.**
- Gated `autonomy-e2e` test: audit→remediate over the fixture reaches `complete`
  with zero host prompts, a non-empty remediation branch, a green final gate, and a
  fully-reconciled coverage ledger.

---

## A10 — Multi-process coordination primitive  · **M**

**Problem.** Vague until A8 makes it concrete. The real scenario: multiple
in-process dispatch workers (and eventually multiple CLI-agent processes) operating
against one run, plus the future "many CLI agents at once" quota vision. Today the
only coordination primitive is `withFileLock` on `state.json`.

**Approach.** Spec the primitive A8's hybrid coordinator actually needs: a **claim
registry** — a lock-guarded, on-disk record of which node is claimed by which
pool/process, with a heartbeat + stale-claim reclamation (mirror the existing
`withFileLock` 30s stale-lock cleanup). This is the generalization of "the
coordinator assigns each node to exactly one pool" from A8 to N processes. Defer
cross-*machine* coordination — out of scope until there's a concrete need.

**Tradeoffs / risks.** Easy to over-build into a distributed scheduler; keep it to
single-machine, file-backed, reusing the proven lock + stale-cleanup pattern.

**Acceptance criteria.**
- A `ClaimRegistry` (file-backed, lock-guarded, heartbeat + stale reclaim) that two
  concurrent dispatch loops use to claim nodes without double-dispatch, proven by a
  concurrency test.
- A8's coordinator is built on it (not a parallel one-off).

---

## Design commitments recorded but unbuilt

The docs commit to these; the code hasn't implemented them. (From backlog
*Design commitments not yet built*.)

### DC-1 — `free_form_intent` clause escalation (audit) + remediate interpretation  · **M**

**Problem.** Two halves remain after the 2026-06-13 partial. (a) Audit:
`interpretFreeFormIntentForAudit` (`intentInterpreter.ts`) produces
`checkpoint_questions` / `has_unencodable` but **nothing reads it**, so an
unencodable intent clause is silently dropped instead of becoming a blocking
confirm-intent question. (b) Remediate: still threads `free_form_intent` verbatim
into worker prompts instead of interpreting it into priority / lens weighting.

**Approach.** (a) Wire the audit interpreter into the confirm-intent path: its
`checkpoint_questions` feed the existing `unresolvedConstraintClauses` blocking
mechanism (already rendered by `confirmIntentStep` and gated in `nextStep`) — so an
unencodable clause hard-gates planning exactly like the headless path already
records. This reuses machinery that exists; the gap is purely the missing caller.
(b) Remediate: run the shared `interpretFreeFormIntent` at intake, fold the lens
weights into block prioritization / finding ordering, and STOP putting the raw
string in worker prompts (mirror audit's `no-verbatim-free-form-intent` guard +
add the same guard test on the remediate side).

**Tradeoffs / risks.** Remediate "interpret for priority" is fuzzy — keep it to
ordering/weighting, never to *dropping* a finding (that's the review/clarification
gate's job). Resolve toward the docs (interpret + escalate), the durable direction.

**Acceptance criteria.**
- An unencodable audit intent clause produces a blocking confirm-intent question
  (test); none are silently dropped.
- Remediate no longer threads `free_form_intent` verbatim into worker prompts
  (guard test, mirroring audit); intent shifts block/finding priority instead.

### DC-2 — Provider confirmation Gate-0 (shared session)  · **M**

**Problem.** The design wants ONE provider confirmation spanning an audit→remediate
run; today each tool resolves its provider independently and remediate has no
`provider_confirmation` state at all.

**Approach.** A shared, session-scoped `provider_confirmation` artifact in
`.audit-tools/` (not per-tool): the first tool to run writes the confirmed
provider/pool decision; the second reads and honors it unless explicitly
overridden. "Session" = the shared `.audit-tools` dir for that repo+run — no new
identity scheme needed. Audit already has the concept; lift it to a shared artifact
both orchestrators read, and give remediate the read.

**DECISION — staleness.** Recommend the confirmation carries a timestamp + the
discovered roster snapshot; a stale/changed roster re-confirms. Keeps it from
pinning a provider that's since disappeared.

**Tradeoffs / risks.** Must not block remediate when run standalone (no prior
audit) — absence of the artifact = resolve independently, exactly as today.

**Acceptance criteria.**
- A shared `provider_confirmation` artifact written by audit is read + honored by a
  subsequent remediate run; remediate standalone still self-resolves; a changed
  roster forces re-confirmation (tests).

### DC-3 — Parallel module-contract phases (remediate)  · **S–M**

**Problem.** `buildParallelModuleWaveStep` (`contractPipeline.ts`) dispatches a
single sequential agent over all modules — "parallel" in name only.

**Approach.** Fan out one agent per module through the existing `waveScheduler`
(the same concurrency-capped wave mechanism implement dispatch already uses), then
merge per-module contract results. The merge + staleness machinery already exists;
this is a dispatch-shape change, not new contract logic.

**Tradeoffs / risks.** Per-module agents may produce inconsistent cross-module
contract assumptions — keep the existing reconciliation/critique pass after the
merge as the consistency gate.

**Acceptance criteria.**
- N modules dispatch as N concurrency-capped agents (not one sequential pass);
  results merge into the same module-contract artifact; reconciliation unchanged.

### DC-4 — audit-code mid-run pause + scope annotation + folded ingestion  · **M**

**Problem.** Three sub-gaps: (1) `waiting_for_provider` / `advancePausedState`
(`shared/src/rolling/pausedState.ts`) is built but `rollingDispatch.ts` doesn't use
it — it only detects stranded packets *post*-run; (2) design-review prompts don't
annotate units `[in scope]` / `[excluded: …]`; (3) ingestion is a separate
`audit_results_ingested` obligation rather than folded into the dispatch turn.

**Approach.** Three independent, separately-shippable fixes:
(1) Wire `advancePausedState` into the rolling audit driver so a quota-exhausted
run *pauses* (resumable) mid-run instead of stranding packets — symmetric with the
remediate rolling path. (2) Thread the intent-checkpoint scope into the
design-review prompt rendering so each unit shows its disposition. (3) Fold
ingestion into the dispatch turn (the rolling driver already calls `mergeAndIngest`
internally for the in-process path — extend that so the standalone
`audit_results_ingested` obligation is no longer a separate host round-trip).

**Tradeoffs / risks.** (3) changes the obligation chain — verify the staleness DAG
stays correct (ingestion folded ≠ ingestion skipped). Ship the three separately;
(2) is the cheapest and most user-visible.

**Acceptance criteria.**
- A quota-exhausted rolling audit pauses to a resumable `waiting_for_provider`
  state, not a post-hoc strand (test).
- Design-review prompts annotate each unit's scope disposition.
- Ingestion folds into the dispatch turn; no separate ingest round-trip on the
  happy path; staleness DAG still correct.

### DC-5 — Paired obligations (positive + negative test specs)  · **M**

**Problem.** A behavior-*change* obligation should derive BOTH a positive test (new
invariant holds) and a negative test (old behavior absent everywhere), so a partial
implementation can't satisfy it. The no-prose-closure half shipped
(`mergeImplementResults` gates `resolved_no_change` on executable evidence); the
paired-*derivation* half remains.

**Approach.** At obligation / test-spec derivation in the contract pipeline, when an
obligation is classified as a behavior *change* (vs. pure addition), emit a paired
`TestSpec`: positive (assert new) + negative (assert old-behavior-absent, ideally a
repo-wide check). The implement worker must satisfy both; the verify gate fails if
only one is present.

**DECISION — classification.** Recommend a deterministic heuristic first (obligation
text / diff touches an existing symbol's behavior → "change"), LLM-confirmed —
mirrors the note-3 ambiguity-gate pattern (deterministic candidate → LLM review).

**Tradeoffs / risks.** Negative ("absent everywhere") tests are hard to make
non-vacuous — scope the negative assertion to the changed surface, not a global
grep that rots. Risk of over-pairing pure additions; the change-vs-add classifier
gates that.

**Acceptance criteria.**
- A behavior-change obligation derives a positive + a negative TestSpec; the verify
  gate rejects satisfying only one (test).
- Pure-addition obligations are not paired (no vacuous negatives).

### DC-6 — Rolling per-node dispatch for the remediate host-subagent path  · **M**

**Problem.** The in-process / NIM path rolls (dispatch-when-verified-complete), but
the **host-subagent** remediate path still builds one wave per `next-step`, waits
for all results, merges, then re-enters — batch-then-merge, not rolling.

**Approach.** Extend the host-subagent driver to the same rolling shape the
in-process driver already has: emit the eligible frontier, and as each
`accept-node` lands, re-check newly-unblocked nodes and emit the next dispatch into
freed quota — rather than gating the whole wave. The `acceptNodeWorktree` core +
the dispatch-next-on-complete bookkeeping already exist for the in-process driver;
this is making the host-subagent driver consume the same coordinator (ties into A8 /
A10).

**Tradeoffs / risks.** Host-subagent dispatch is turn-based (the host spawns
subagents between tool calls), so "rolling" here means the step contract returns the
next node(s) on each `accept-node`, not a tool-owned loop. Don't regress the
first-class conversation-first path.

**Acceptance criteria.**
- A host-subagent remediate run dispatches the next eligible node on each
  `accept-node` completion (not a full wave barrier), proven by a dispatch test.
- Shares A8's coordinator / A10's claim registry, not a parallel implementation.

---

## Known friction / smaller fixes

### F-1 — BUG Y: narrow staleness projection of prose-heavy artifacts  · **M, conditional**

**Problem.** The staleness projection deliberately does NOT strip prose fields
(design_spec narrative, obligation/dag/assessment descriptions, rationales) because
those feed downstream LLM prompts — stripping them would under-fire staleness (a
prose edit must still re-run the LLM phase whose input changed). Efficiency-only.

**Approach.** Only safe per-field: for each prose field, PROVE the downstream's
*prompt* input (not just its deriver code) doesn't read it, then exclude that field
from the semantic projection. This is a field-by-field audit, not a sweep.

**DECISION — defer unless it bites.** Recommend leaving as-is; revisit only if
contract-pipeline re-emit churn from prose edits is measured as a real cost. The
2026-06-19 fix (whitespace-normalize + intermediate `module_contracts` narrowing)
already cut the worst of it.

**Acceptance criteria (if taken).** Per excluded prose field, a test proving the
downstream prompt doesn't read it; staleness still fires when a *load-bearing* field
changes.

### F-2 — Release `waitForRunCompletion` selects by run identity, not tag name · **shipped (5c2568b5)** — pure selectReleaseRun keyed on head_sha + post-push time.

### F-3 — `quota` command drops the capability-handshake flags · **shipped (057e5146)** — quota parses host-* flags through buildDispatchPool read-only preview.

### F-4 — Provider `queryLimits`  · **note, deferred-by-design**

The canonical call site already treats absent-method and null-return identically
(`await provider.queryLimits?.(…).catch(() => null) ?? null`), so null stubs change
nothing. **No action** until a provider gains a real proactive rate-limit endpoint;
belongs with the cross-provider quota work (F/9c). Kept here so it's not mistaken
for a gap.

### F-5 — `phase-plan.test.ts` hermeticity flake · **shipped (9e9f1f2c)** — scoped per-describe state kills the cross-describe afterEach dir-deletion race.

### F-6 — Allow in-boundary, unassigned files as `affected_files` evidence · **shipped (f0a30ceb)** — packet/unit boundary widens file_coverage + followup_tasks reject gates via submit-packet.

### F-7 — Read-tool >2000-char line truncation · **shipped (2e640a57)** — writeJsonFile container-wraps; added bounded-accessor read path (readJsonStringScalar/Chunks) for over-cap scalars.

---

## Deferred product bugs

### PB-1 — OpenCode launches unprompted on Windows · **shipped (1a2ea2d7)** — bare-PATH opencode opt-in at chooseAutoProvider/discoverProviders; headless launch gate in OpenCodeProvider.launch.

### PB-2 — Manual real-OpenCode scoped-permission validation  · **note, user-owned**

Can't be unit-tested: confirm agent-scoped allowances propagate to spawned subtasks
in real OpenCode. Fold into the A7 manual GUI checklist (one row). Revert path if
audits start hitting ask-prompts: re-add the broad rule or rerun an older
postinstall.

---

## Later-feature investigations (plans, not committed specs)

### INV-1 — More deterministic analysis  · **L, investigation**

**Goal.** Shift audit signal from LLM judgment to deterministic static analysis
(cheaper, reproducible, grounded by construction) — extends `src/extractors/` +
`src/adapters/`.

**Plan.** Survey levers, decide build-vs-defer per lever: AST/structural matching
(tree-sitter, ast-grep); promote `madge` (already shelled in `anchorGrounding`) to a
real graph-edge extractor; dead-code/unused-export (knip, ts-prune);
complexity/duplication metrics; type-coverage; broader semgrep rulepacks; CodeQL for
dataflow. **Constraint:** each new analyzer enriches the shared language-neutral
graph/risk artifacts and routes through the adapter-normalize pattern — never fork
planning per ecosystem (CLAUDE.md invariant). Prefer in-process pure-JS adapters
(reproducible, OS-agnostic, no network); reserve MCP for engines that need it
(CodeQL). Mine ralph-architecture-sweep's *heuristics* re-expressed as graph queries
(deletion test → low-in-degree nodes; seam detection → repeated call-site
signatures; vertical-slice packaging ≈ work-blocks).

**Acceptance criteria (of the investigation).** A short decision memo: per lever,
build / defer / reject + rationale; the committed ones become their own specs.

> **Heterogeneous multi-agent dispatch (former INV-2 / FINDING-020) is folded into
> A8 + A10** — the coordinator, claim registry, per-slot provider resolution, and
> host-model pool discovery ARE heterogeneous dispatch; it is not a separate track.

### INV-2 — Cross-IDE/provider quota detection  · **L**

**Goal.** A trustworthy capacity/limit estimate for every provider+IDE+model triple,
degrading safely (byte-estimate + 429/TPM learning + safety margin) when a source is
silent — never confidently wrong. Today it's unreliable across Claude / Codex /
Copilot / Antigravity / OpenCode / Gemini.

**Plan.** The per-provider HTTP quota sources are built on `BaseHttpQuotaSource`
(Claude OAuth usage source is live + wired). Remaining: validate each provider's
source against the *real* endpoint (not just unit fixtures), wire learned-limit
feedback + the capability handshake into one capacity picture per triple, and prove
the safe-degradation path. This is the trustworthy per-pool capacity signal A8's
**proactive** balancing reads — **sequence INV-2 before / alongside the A8 live
run.** Red line (quota-dispatch vision): self-monitoring own-provider-only, never IDE
GUI automation.

**Acceptance criteria.** Each provider source validated live; one capacity estimate
per triple that degrades to byte-estimate+margin when silent; A8 proactive balancing
consumes a real per-pool capacity signal.

---

## Suggested sequencing (derived; "clear the backlog" has no single driver)

Roughly dependency-ordered, cheap-and-safe first:

1. **Quick wins (S):** F-2 (release waiter), F-3 (quota flags), F-5 (flake),
   F-6 (in-boundary evidence), F-7 (wide-JSON), PB-1 (OpenCode defensive fix).
2. **Self-contained DCs (S–M):** DC-3 (parallel module phases), DC-1 (free-form
   intent), DC-4 (audit pause/scope/ingest — ship the three sub-fixes separately).
3. **Quality track:** A2 (oracle) + DC-5 (paired obligations) — raise output trust.
4. **Dispatch track (the big interlock):** INV-2 (per-pool quota signal) → A10
   (claim registry) → A8 (proactive hybrid spill + heterogeneous-dispatch /
   host-model pools, former INV-2-FINDING-020 folded in) → DC-6 (host-subagent
   rolling) → DC-2 (Gate-0).
5. **Validation track:** A7 (multi-host) — independent, do whenever; PB-2 rides its
   checklist.
6. **Autonomy capstone:** A9 (end-to-end acceptance) — last, once the dispatch track
   is solid.
7. **Investigation:** INV-1 (more deterministic analysis) — own track, anytime.


