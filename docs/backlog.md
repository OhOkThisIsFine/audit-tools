# Backlog — open work, durable traps & future directions

A living **to-do list**, not a status log. Remove an entry once it ships — record durable
contracts/rationale in project memory or `CLAUDE.md`, never "where the code is today."

---

## Live-validation guide — READ FIRST if you're running a live audit/remediate

Most open items below are **code-complete and only await a real run to confirm**. Each such item
carries a **⬇ Live-run watch** line: exactly what to observe during the run to confirm it validated —
or to catch it failing. Pick a run config from this matrix; watch the items it lights up.

| Run config | Items it exercises (watch their ⬇ lines) |
|---|---|
| **Any** live audit, any provider | Selective-deepening convergence · knip `files`/`dependencies` dead-code leads |
| **Metered provider + LARGE target**, ideally `AUDIT_TOOLS_LIVE_QUOTA=1` (forces the wall) | Quota-aware dispatch · M-QUOTA friction escalation · pre-wall pacing · retryable resume |
| **Codex backend** (`--provider codex`; Codex CLI is a nested-agent host) | Y-dispatcher driver selection · cross-provider quota (Codex live endpoint) |
| **openai-compatible / NIM backend** (`RUN_NIM_E2E=1` for the gated e2e) | openai-compatible dispatch pool · CE-004 emit-time-constraint build opportunity |
| **Rust or Ruby target repo** | clippy (cargo) + rubocop (bundle) live spawn |

**General fail-signals to log on ANY live run** (add a line under *Open bugs* if you hit one): a run
that wedges and needs `force-synthesis` to finish · orphaned pending `deepening:*` tasks · a *crash*
(not a graceful pause) when a rate limit is hit · an analyzer that silently skipped when it should have
spawned · knip dead-code leads that never reach the per-file lens. After a run, its findings are the
corpus to hand-label for the A2 oracle (see Deferred / waiting).

---

## Open bugs / frictions — fix in tooling (never "host remembers")

- **Max-sweep remediation run COMPLETE (2026-07-06).** The operator-approved 10-node
  `backlog-handoff-max-sweep-2026-07-06` plan is fully landed and green — completed via manual node-by-node
  recovery after a tool worktree-wipe / state-desync incident (see the worktree-wipe bug below). All 10 nodes
  shipped; durable design/status lives in project memory [[remediate-max-sweep-run-2026-07-06]].

- **Remediate contract/implement pipeline — dogfood frictions (fix in tooling).**
  Five open frictions surfaced driving one large `/remediate-code` run:
  - **Contract-pipeline re-validation is grossly inefficient — a localized fix re-runs the WHOLE downstream chain.**
    This was the dominant cost of the run (a 10-node plan took ~40 `next-step` round-trips + ~20 subagent dispatches,
    the large majority pure churn). Facets:
    - **Full cascade re-run on any localized change.** Each of the 3 small contract repairs (widen one module's file
      scope; pin one PRIORITY slot; fix one disclaimer sentence) invalidated and re-ran the ENTIRE downstream chain:
      critique → counterexample → judge → **full re-author of `test_validator_plan` (114 specs) + `contract_assessment_report`
      (123 findings)**. The adversarial *review* is diff-based (the reviewer re-examines only the diff) but the
      host-authored artifacts are re-materialised in full every time. Re-validation should be scoped to the changed
      module's obligations, not the whole plan.
    - **`test_validator_plan` ↔ `contract_assessment_report` ping-pong.** Their mutual dependency + the
      consume-`.input.json`-into-envelope model caused repeated oscillation — re-emitting one invalidated the other,
      several round-trips each cycle, re-writing byte-identical content.
    - **Structural gates surface failures across successive round-trips, not all-at-once.** The positive/negative
      pairing gate and the CE-006 negative-scoping gate flagged different specs on separate `next-step` calls (fix a
      batch → re-run → new batch), and the polarity vs scoping issues surfaced in different passes. Batch every gate
      failure the plan currently has into one report.
    - **Re-emit is re-author, not copy-forward** — no "re-affirm unchanged / copy-envelope-payload-forward" fast path,
      so an unchanged 123-finding verdict is re-materialised verbatim repeatedly. (Host lesson also logged: I initially
      dispatched heavyweight subagents — 80-130k tokens — to do pure verbatim copy-forward before switching to
      deterministic prior-verdict extraction; a copy job must never be an LLM dispatch.)
    Net: the full adversarial contract pipeline is far too expensive to run on a large mixed plan without a cheaper
    re-convergence path — reinforces [[risk-tier-loop-laps-cheap-vs-heavy]] and the self-scaling-pipeline direction
    [[self-scaling-pipeline-not-forked-paths]].
  - **Coverage gate not exposed in `validate-artifact`.** The positive+negative pairing + CE-006 negative-scoping gate
    fires only at `next-step`, so an authoring agent self-validates "ok" then fails the gate → round-trips. Expose it
    in `validate-artifact`. Also the polarity classifier keyword-heuristic misreads a satisfied-path assertion whose
    success case is a block/exit-2 action as "no positive" → the gate error should hint the explicit `POSITIVE:`/
    `NEGATIVE:` label escape hatch.
  - **Source-grounded citation gate mangles dotfile + bare-filename citations.** M-B3 strips the leading dot from
    `.claude`/`.github` paths and doesn't resolve bare filenames (`advance.ts` vs the full path), rejecting citations
    that point at real tracked files; nodes touching only dotfile dirs were un-groundable until a non-dotfile path
    was added. Handle dotfile dirs + basename resolution.
  - **`--input` last-wins silently drops earlier inputs.** `next-step --input a --input b` kept only `b`, silently
    dropping `a` from the source manifest (had to hand-edit `source-manifest.json`). Accept multiple `--input`
    (union) or error on the extra.
  - **Module decomposition can scope a module to the wrong files.** opencode-union-ceiling's `file_scope` was assigned
    to the thin `providers/opencodeProvider.ts` re-export shims (no logic) instead of the real installers
    (`opencodePermissions.ts` + `scripts/{audit,remediate}/postinstall.mjs` + `src/remediate/index.ts` + the two
    `wrapper/*-opencode.mjs`); only caught when the drafting agent read source. Decomposition should verify where
    named logic actually lives before assigning scope. Reinforces [[front-load-broad-search-before-contract-authoring]].

- **META — the friction-capture mechanism did not capture the run's real friction (2026-07-06).** The close-out
  walk exists, but *detection* under-delivered: the run's biggest friction (the process inefficiency above) was
  invisible to the tool's own capture and had to be hand-authored — and even then I under-captured it on the first
  pass. The capture mechanism is really host-attestation wearing a detection label. Specifics:
  - **What it DID capture:** the tool auto-wrote ~7 per-contract-step `.audit-tools/remediation/friction/CONTRACT-*.json`
    records, each a single-line `frictions[]` entry with category `"trap"` (e.g. "implementation_planning re-emitted:
    a promoted-plan finding cited a component absent from the tree — M-B3 citation grounding"). Narrow, mechanical,
    per-event.
  - **What it did NOT capture:** (a) the DOMINANT friction — pervasive process inefficiency (full-cascade re-run on
    localized fixes, `test_plan`↔`assessment` ping-pong, re-author-not-copy-forward, ~40 round-trips) — never
    detected; (b) the implement-dispatch false-resolve (surfaced only as terse stdout log lines, never a friction);
    (c) host-side waste (dispatching agents for copy jobs — outside the tool's view).
  - **The meta-failure modes:**
    1. **Gate-invisible shape.** Auto-capture writes `frictions[]`/`"trap"`; the close-out gate counts only
       `open_observations[]`/`category_attestations[]` over the three categories — so the tool's OWN capture doesn't
       satisfy the tool's OWN gate, and the host starts from a blank record.
    2. **Per-event, never aggregated.** N identical re-emit events were logged as N isolated traps; the AGGREGATE
       ("re-emit churn is the run's biggest cost") is the real friction and is never recognized. The raw signal
       existed (7 trap files) — the loss was between events-logged and friction-recognized.
    3. **Blind to cost/inefficiency.** It fires only on discrete failure events (a mis-ground, a re-emit) and has no
       notion of measuring round-trip count / verbatim re-author count / tokens — so the most important friction
       class, "a run that is mostly overhead," is exactly what it cannot see.
    4. **Capture is host-attestation, not detection.** The stop-gate forces the HOST to walk the categories and
       hand-write observations; the tool detects almost nothing IN those categories, so a rushed host under-captures.
       This is the enforce-in-tooling gap under [[meta-audit-friction-must-be-tool-enforced]]: detection is near-empty
       and the substantive capture is left to host discretion (which under-delivered here — twice: an empty first
       pass, then a too-thin re-emit-churn bullet).
  - **What SHOULD happen:** (a) auto-capture emits into the SAME `open_observations[]` shape (with a real category)
    the gate reads, so tool detection SEEDS the walk instead of the host starting from nothing; (b) AGGREGATE repeated
    events (N re-emits of one artifact → one `inefficient_feeding` observation "re-emit churn, cost N round-trips");
    (c) measure + surface COST signals (per-phase round-trip count, verbatim re-author count, token spend) so
    inefficiency is DETECTED, not just discrete failures; (d) pre-populate the host's category walk with the detected
    observations so the host CONFIRMS/augments rather than authoring from a blank record. Generalizes
    [[meta-audit-friction-must-be-tool-enforced]] from "enforce the walk happens" to "detect the substance the walk
    is supposed to surface — especially cost/inefficiency, not just discrete traps."

- **HIGH — remediate dispatch worktree-wipe + state-desync (concurrent `accept-node` corrupts sibling
  in-flight nodes; 2026-07-06).** Driving implement waves through `remediate-code accept-node` while sibling
  nodes are still in flight triggers two coupled failure modes: **(1) worktree-wipe** — a concurrent stale-sweep
  prunes / `git reset`s sibling per-node worktrees under `.audit-tools/worktrees/`, wiping uncommitted work; a
  fully-emptied worktree resolves up to MAIN so the build-free per-node verify **false-greens** against unrelated
  code; **(2) state-desync** — `accept-node` reports nodes `accepted`/`resolved` that never landed on the run
  branch (their worktree branch refs were clobbered to a sibling's commit), so `state.json` says resolved while
  git says missing → the run **false-closes** with work absent. Fixes to build: (a) isolate/lock each node's
  worktree so no node's `accept` can touch a sibling ref; (b) build-free verify must **fail-loud** when the git
  toplevel ≠ the node's worktree root (never resolve up to MAIN); (c) reconcile accept-disposition vs
  run-branch ancestry before trusting `resolved` (`git cat-file -e HEAD:<expected-file>`); (d) never let a
  concurrent stale-sweep prune a worktree with in-flight/uncommitted work. Recovery procedure preserved in
  [[remediate-max-sweep-run-2026-07-06]]. Relates [[implement-dispatch-strands-nodes]].

- **Staleness regen-drain shipped opt-in — benefit dormant on the conversation-first path (efficiency-only,
  2026-07-06).** Node-5's `advanceAudit` drain loop (`AdvanceAuditOptions.drain`) defaults false and no
  production caller opts in, because the drain crosses interactive / host-input FOLD boundaries
  (`provider_confirmation` / `analyzer_install` / `edge_reasoning` / `confirm_intent`) its executor-registry
  stop-gate can't see. So the regen-chatter reduction it was meant to deliver is inert on the primary path. A
  **fold-aware drain** (stops at host-input folds) or an **autonomy driver that opts in** would land it.
  Efficiency-only, not a correctness bug.

- **Shipping from a linked worktree forces a manual FF + rebuild dance (observed 2026-07-05).** The release
  script (`scripts/release-and-publish.mjs`) hard-guards on being ON the default branch (`git branch
  --show-current` must equal `main`), but laps run on a `claude/<name>` feature-branch worktree while `main`
  is checked out in the PRIMARY worktree. So a ship = push the feature branch to `main` (FF), then manually:
  update the primary worktree's `main` (`git -C <primary> merge --ff-only`), **rebuild its stale `dist/`**
  (else `npm run check`'s pre-tag gate fake-fails on "missing export" — the worktree trap), then run the
  release from the primary worktree. `/ship` doesn't automate this. Follow-up: teach `/ship` (or the release
  script) to accept a linked-worktree/feature-branch state — e.g. release straight from the current worktree
  when its HEAD already equals `origin/main`, or auto-FF+rebuild the primary worktree — so a ship from a lap
  worktree is one command, not a five-step hand dance.

- **Backlog mechanism sub-items can drift from code reality — verify before implementing (2026-07-05).** The
  defect-1 "mechanism sub-defects" were partly over-stated vs the code: sub-2 claimed `selectProvider` does
  "no multi-pool fan-out" but the rolling engine already spills off SATURATED pools (the real gap was only
  UNBOUNDED-pool front-loading → a least-loaded tiebreak, not a rewrite); sub-3's "route file contents to
  NIM" already existed (`gatherReferencedFiles`) — the real bug was the single-shot output-contract leak.
  Reinforces [[backlog-item-states-invariant-not-fix-mechanism]]: read the named mechanism against source
  before building it, and prefer the narrowest correct fix over the backlog's prescribed rewrite.

- **Optional: cut vitest `collect` (~186s) / per-file isolation overhead (noted 2026-07-04).** Full-suite
  `collect` is ~186s of module load/transform for 430 files; default `pool: 'forks'` adds per-file process
  startup. `pool: 'threads'` and/or `isolate: false` could help, but many audit/remediate tests mutate fs
  and spawn subprocesses → isolation-off risks cross-test bleed. Only pursue with per-file verification.
  Lower priority than the sharding already shipped.

- **Dispatch admission-control rework — residual (env-bound / deeper, not blocking).** Shipped in full
  (commits 1/2a/2b-AUDIT/2b-REMEDIATE/driver-unification/commit-3/defect-1 — see `docs/HANDOFF.md` T5-3 /
  `git log` for what landed). Design of record
  [`spec/audit/dispatch-admission-control.md`](spec/audit/dispatch-admission-control.md);
  [[capability-is-per-auditor-not-per-audit]] / [[dispatch-admission-control-design]].
  - (a) **live validation** of the real host+codex+NIM concurrent run — a metered multi-pool run confirming
    the demoted backend actually fans out alongside the host (folds into the quota-aware-dispatch live-run
    watch below). (b) **Deeper simultaneity:** the audit hybrid path drives the in-process (codex/NIM)
    partition to completion within a `next-step` turn, THEN hands the complement to the host — so host and
    backend alternate ACROSS turns, not simultaneously WITHIN one. True within-turn simultaneity would need
    a detached background driver spanning host turns (architectural; only pursue if wall-clock on a real
    run shows the alternation is the bottleneck). (c) **Executor routing lesson (durable):** codex CLI is a
    poor fit for large read-heavy audit packets under a wall-clock budget (observed 2026-07-04: 2 concurrent
    ran 5+ min with zero results, 8k+ lines of echoed reasoning) — route only small/low-line packets to it,
    or drop it from the audit pool.

- **Quota-aware dispatch — live validation env-bound.** Still open: live validation of the token-budget
  dispatch gate (per-`(pool,window-label)` learned tokens-per-percent slope, budget = MIN across a
  pool's windows, quota-death = retryable pause preserving worktrees) on a real rate-limited
  multi-worker run — cold-start calibration slope + the resume path especially want a live check.
  Relates to [[claude-usage-endpoint-body-shape]] / [[claude-quota-credential-resolution]] /
  [[cross-provider-quota-matrix]] / [[quota-dispatch-vision]].
  - **⬇ Live-run watch** (metered provider + large target; `AUDIT_TOOLS_LIVE_QUOTA=1` to force it): at the
    rate wall the run must **pause gracefully, not crash**, and leave every in-flight worktree intact; on
    resume it continues from the pause with no lost/redone work. Early on, the tokens-per-percent slope
    should *learn* (dispatch pacing adjusts after the first window reading) rather than stay at the
    cold-start default. FAIL = crash/stall at the wall, discarded worktrees, or a resume that re-does or
    drops packets.

- **Friction detection — M-QUOTA escalation chain: live validation env-bound.** The
  `recordLimit → escalate → strand → quota_escalation friction` chain is unit-tested end-to-end on both
  drivers (`tests/shared/rollingDispatch.test.mjs`; `tests/audit/rolling-audit-dispatch.test.mjs` §5).
  **Still open:** live validation on a real rate-limited run. [[meta-audit-friction-must-be-tool-enforced]]
  - **⬇ Live-run watch** (same wall run as quota-aware dispatch): when a packet escalates across pools at
    the wall, a **`quota_escalation` friction event** must be captured at the step boundary — check the
    run's friction log / meta-audit surface after the run and confirm the event is present with the
    escalated packet id. FAIL = wall hit but no friction event recorded (the chain didn't fire live).

- **Selective-deepening convergence — live validation env-bound.** Both known convergence loops
  (packet-result `task_id` mismatch; idempotency_key collision across rounds) have shipped fixes and need
  a real deepening-capable run to confirm. Recovery until validated: quarantine orphan pending
  `deepening:*` tasks.
  - **⬇ Live-run watch** (any audit whose findings trigger deepening — i.e. low-confidence/high-risk areas
    that spawn `deepening:*` tasks): every `deepening:*` task must **converge and complete** within a bounded
    number of rounds; the run reaches synthesis on its own. FAIL = orphaned pending `deepening:*` tasks, the
    same finding re-deepened every round (idempotency collision), or the run only finishing via
    `force-synthesis`. If you hit it, quarantine the orphan `deepening:*` tasks and note the round count here.

## Forward tracks

- **Cost-first routing — collision-price preference (carried from W1, open).** Design of record
  [`spec/cost-first-routing.md`](../spec/cost-first-routing.md), durable design in memory [[cost-first-routing-design]].
  W2 core + interactive Gate-0 (host-prompt visibility, operator reorder, host-roster-at-Gate-0) are shipped —
  see `docs/HANDOFF.md` T5-0. `resolveModelStatics` dedupes a model id served by multiple providers
  first-sorted-provider-wins, so a reseller markup could win over the native/cheapest price. Prices
  largely agree across providers, so this is an approximation, not a bug — revisit only if per-provider
  pricing matters (would need (provider, model) keying in the snapshot).
- **models.dev static window can over-state a specific deployment (carried from W1).** The snapshot lists e.g.
  `claude-opus-4-7` at 1M context; a real headless run serving a 200k variant with discovery absent would over-size
  work blocks off the static rung. Mitigated by `BLOCK_SAFETY_MARGIN` 0.7 + discovered-capability always overriding —
  watch on a real headless metered run.
- **Minor provider/dispatch cleanups (low-pri, bundle opportunistically).**
  ~~providerFactory Rule 6 (`hasClaudeCodeConfig && claudeAvailable`) is a provable strict subset of Rule 9
  (`claudeAvailable`) — delete the redundant rung~~ — **FALSIFIED 2026-07-05 (verify-before-implementing).**
  Not a no-op: the opencode/codex *config-gated* rungs sit BETWEEN Rule 6 (claude config-gated) and Rule 9
  (claude bare-availability tie-break) and resolve to *different* providers. For a dual-configured operator
  (`hasClaudeCodeConfig && claudeAvailable && hasOpenCodeConfig && opencodeAvailable`), Rule 6 makes explicit
  claude config win; deleting it lets the opencode config-gated rung fire first → resolution flips
  claude-code→opencode. Rule 6 is a predicate-subset of Rule 9 but NOT redundant in the ordered table. Leave it.
  Remaining (still valid): inline `makeProviderKeyedFactory` (19 LOC, 2 sites — but it's a cross-area generic
  with its own dedicated test `tests/shared/provider-keyed-factory.test.mjs`; inlining loses cohesion,
  marginal — low value).
  Do NOT delete working proactive quota sources (`BaseHttpQuotaSource` + one-array register is already clean);
  `copilot` is correctly broker-only.

- **Systemic reviewers must be pushed adversarially for improvement, not just correctness (owner,
  2026-07-05).** Two audit tiers exist and both are wanted: unit auditors that structurally can't see the
  whole corpus, and systemic auditors that review the entire corpus as one artifact. The gap is **not
  scope** — the systemic auditors already have whole-corpus reach — it is that they **under-extract**: they
  produce a competent first-pass answer and stop, yet cave immediately when a human pushes ("are you sure
  there isn't a better way to do any of this?"), instantly surfacing numerous improvements they'd first
  missed. The end-goal makes that pushing intrinsic to the review:
  - **Improvement-seeking challenge loop.** After the first systemic pass, a second-order adversary
    re-interrogates the output with human-grade pressure — what's redundant, serial-that-could-be-parallel,
    duplicated, over-built; what assumption went unquestioned; is there a categorically better approach —
    and folds newly-surfaced improvements back in. The review is done only when a challenge round yields
    **nothing new (loop-until-dry)**, not when it first has an answer.
  - **The mandate is optimization / better-way, not only defect-finding.** The systemic pass must actively
    seek superior alternatives to things that currently *work* — the class no correctness lens flags because
    nothing is broken. Motivating evidence: ~a dozen dogfooding runs never surfaced that the release suite
    re-ran identical tests multiple times per release and ran serially what could have been parallelized;
    the slow (~186s) suite was the *symptom*, the redundant/serial execution was the catchable finding.
  - **Feed aggregate metrics into the systemic context** — complexity/duplication/churn rollups plus an
    operational digest of suite/build/config shape — expressed as a **language-neutral** contract (abstract
    counts/timeouts/fan-out, never ecosystem-specific like a vitest collect time). Necessary supporting
    evidence, explicitly **not sufficient** on its own.
  - **Conceptual/systemic findings carry their true lens**, not a hardcoded `architecture` tag — a
    test-parallelization finding is `tests`/`performance`, an ops finding is `operability`.
  Relates to the two design-review modes ([[contract-authoring-determinism-direction]]: contract vs
  conceptual critique) and the self-detection theme in [[meta-audit-friction-must-be-tool-enforced]].
  - **Design of record for the conceptual half:** [`spec/conceptual-design-review-design.md`](../spec/conceptual-design-review-design.md)
    — the operator (overlay-and-delta at structure + charter layers), node discovery (agreement=nodes /
    disagreement=findings, multi-resolution stability for emergent depth), the four charters + delta routing
    (Stated/Inferred/Revealed/True; True gated to human-only provocations), blast-radius ranking, and the
    three-dial control surface (intensity=compute / ceiling=premise-height at `intent_checkpoint` /
    attention=the VOI-ranked triangulation loop; attention 0 = the autonomous mode). The "improvement-seeking
    challenge loop" above is the *intensity* dial + loop-until-dry in that doc's terms.
  - **Implementation phasing (owner opted in 2026-07-05 — conceptual + systemic-adversarial = ONE build):**
    - **Phases A–C — ✅ SHIPPED (v0.32.17–v0.32.19).** Data-model spine (four charters + goal DAG, `Ceiling`
      consent dial, `CharterDelta`, `src/shared/validation/charterGate.ts` gates) → overlay-and-delta structure
      operator (`src/shared/decompose/modularity.ts`/`consensus.ts`, `structure_decomposition.json`, obligation
      `structure_decomposition_current`) → charter extraction (`src/shared/decompose/charterExtraction.ts`,
      obligation `charter_extraction_current`, `charter_register.json`, ceiling-gated LLM prompt
      `src/audit/cli/charterExtractionPrompt.ts`). Design of record
      [`spec/conceptual-design-review-design.md`](../spec/conceptual-design-review-design.md). The extracted
      charters are threaded into the `design_review_conceptual` prompt so the generative pass opines per-charter.
    - **Phase D — ✅ SHIPPED.** Charter-delta → clarification/triangulation loop: audit-side `ClarificationRequest`
      (charter-keyed, ported from remediate), VOI-ranked question queue, the three dials
      (ceiling@intent_checkpoint defaulted, attention loop, intensity auto), attention-0 = autonomous,
      blast-radius ranking + risk gate. Obligation `charter_clarification_current`.
    - **Phase E — ✅ SHIPPED.** Systemic improvement-seeking challenge loop: second-order adversary (SEPARATE agent,
      [[delegate-adversarial-phases-to-separate-agent]]) loop-until-dry; mandate = optimization/better-way; feeds
      language-neutral aggregate metrics; findings carry their true lens (not a hardcoded `architecture` tag).
      Obligation `systemic_challenge_current` (true-lens seam).

- **Schema-enforced generation — CE-004 residual (env-bound only).** The always-on conversation host
  (`claude-code`) advertises no API-level constraint mechanism → on the primary path this reduces to the
  repair floor (no emit-time prevention). Unblocks only on a provider gaining a constraint endpoint.
  - **⬇ Build lever (openai-compatible / NIM path):** NIM/vLLM/OpenAI-compatible endpoints *do* support
    guided decoding (`guided_json` / `response_format: json_schema`). Plumbing the AuditResult schema into
    that provider's request is a real, contained build that gives emit-time constraint on that path (the
    claude-code host stays repair-floor — genuinely host-blocked, not a defect). **⬇ Live-run watch** on an
    openai-compatible run: results conform on first emit (repair rounds for schema-shape errors drop to ~0).

- **Tool-enforced dispatch broker with capability-tiered driver.** Desired end-state: (1) a gated
  primitive set as the single dispatch chokepoint (read quota, estimate tokens locally, dispatch/await);
  (2) a capability-tiered driver — Y-dispatcher (thin agent, no judgment) where the host supports nesting,
  slot-pull where it can't; (3) classify agent hosts off the cold-start floor. The single-source
  classifier, broker primitive, `HostSessionQuotaSource`, and driver selection/prompt rendering are
  **shipped**. **Open (env-bound):** live Y-dispatcher validation (needs a nested-agent host + live run)
  + proactive pre-wall quota-aware pacing.
  - **⬇ Live-run watch** (Codex backend, which nests agents): the driver-selection step must pick the
    **Y-dispatcher** path (thin dispatcher agent, no judgment) rather than slot-pull — confirm from the
    run's driver-selection log. Separately, on a metered run, pacing should slow *before* the wall (proactive)
    rather than only reacting after a 429. FAIL = slot-pull chosen on a nesting-capable host, or pacing that
    only ever reacts post-wall.

- **Deterministic analyzers: own-vs-acquire engine.** **Open:** clippy/rubocop landed fixture-only (no
  Rust/Ruby repo → live spawn unvalidated). *(Mutation testing was
  considered and dropped 2026-07-03: it doesn't fit the acquire+scan model — Stryker must run the full
  test suite per mutant and needs a per-repo test-runner config we don't own, so it either no-ops or is
  its own subsystem. Not an analyzer-registry add. Re-file as a scoped forward track only if a lightweight
  mutation signal appears.)* **Forward constraint:** if a future LLM-proposal channel is built for analyzer ids beyond
  the static registry, it must route through the same `admitSpawn` chokepoint; and
  `ExternalAcquisitionConfig.consent_token` must be stripped/redacted before any persistence of
  `SessionConfig` to a shared artifact. [[deterministic-analyzers-own-vs-acquire]]
  - **⬇ Live-run watch** (audit a **Rust** repo for clippy / a **Ruby** repo for rubocop, with the per-run
    consent token so the gate admits the non-default tool): the tool must actually **spawn and normalize**
    output into leads (cargo-clippy / bundle-rubocop), not skip. FAIL = "skipped" status when the ecosystem
    is present + consent given, or a parse that drops all output. (No Rust/Ruby toolchain on the box →
    install `rustup` / `ruby`+`bundler` first, or point at a repo that vendors them.)

- **Cross-provider quota — live-endpoint confirmation.** Per-provider mappings validated against
  live-shaped fixtures; confirming each source against its **real** endpoint (Claude/Codex live; Copilot/
  Antigravity gated→degrade) is environment-bound. Per-provider recipes:
  [`cross-provider-quota-matrix.md`](../spec/cross-provider-quota-matrix.md). Red line: self-monitoring
  own-provider only, never IDE-GUI automation.
  - **⬇ Live-run watch** (run under each provider whose IDE/CLI you have — Codex CLI is available now):
    the provider's `QuotaSource` must return **live numbers off its real endpoint**, not the fixture/degrade
    fallback — confirm the quota reads are non-empty and move as the run consumes budget. Codex + Claude are
    reachable now; Copilot/Antigravity need those IDEs running. FAIL = a source stuck on degrade when its
    real endpoint is reachable.

- **Low-pri UX: surface `intent_checkpoint` reuse to the host.** When a run reuses an existing
  `intent_checkpoint.json`, the host gets no visible notice. Reuse is by design (`conceptualDispatch.ts`:
  `intent_checkpoint.design_review` = source of truth); the only gain is transparency — surface
  "reusing intent from <ts>: <lenses/depth>" so the host knows intake was intentionally skipped. Not a bug.
  [[guidance-discovery-contextualizes]]

## Deferred / waiting

- **A2 finding-quality oracle** — the `score-audit` scorer is built; needs operator-authored
  `corpus/<run-id>.labels.json` (hand-labeled real audit runs) before it can score precision/recall.
  - **⬇ To close (after any live audit):** take that run's findings, hand-label each true-positive /
    false-positive into `corpus/<run-id>.labels.json`, then run `score-audit` → precision/recall. The
    labeling is ground-truth human judgment (can't be automated); one solid labeled run unblocks the oracle.
- **A7 multi-host validation** — `npm run verify:hosts` (automated, in `verify:release`) is built and
  green; the provider-matrix e2e is gated behind `RUN_PROVIDER_MATRIX_E2E=1`. **Remaining:** the
  release-time manual GUI checklist ([`host-validation.md`](../spec/host-validation.md)) for GUI-only
  hosts (Antigravity/OpenCode).
- **Manual real-OpenCode validation** that agent-scoped permission allowances propagate to spawned
  subtasks. Folds into the A7 checklist.
- **`/remediate-code` GUI-host manual checklist (parity with `/audit-code`).** `spec/host-validation.md` is
  a manual GUI-host live-dispatch checklist for `/audit-code` only; `/remediate-code` has the automated
  no-drift gate (`verify:remediate-hosts`) but no equivalent manual GUI-host checklist, which the
  "keep orchestrators in parity" convention says it should have. Add a sibling `/remediate-code` checklist
  (or extend `host-validation.md`). Folds into the A7 release-time GUI checklist work.
- **Gated live e2es** skip without creds: `RUN_PROVIDER_MATRIX_E2E=1`, `RUN_NIM_E2E=1`,
  `AUDIT_TOOLS_LIVE_QUOTA=1`, `RUN_AUTONOMY_E2E=1`.
- **Provider `queryLimits`** deferred — revisit if a provider gains a real proactive rate-limit endpoint.
- **Doc-manifest scope for non-`docs/` host assets (doc-review D-45(a), owner call).** `.github/prompts/audit-code.prompt.md`, `.agent/skills/audit-code/SKILL.md`, and ~15 other un-manifested `*.md` outside `docs/` are not covered by `check-doc-manifest.mjs` (it scopes to `docs/**`). Now that a renderer drift guard pins the two audit host assets, the only residual is whether these should be *formally* listed in `doc-review-guidelines.md`'s routing table — a low-value owner judgment call, not code work.
- **Narrow staleness on prose-heavy artifacts via bounded semantic judgment.** Prose-heavy fields feed
  downstream LLM prompts; a cosmetic edit forces wasteful re-emit. The narrowing = bounded judgment on
  meaning change, fail-safe to re-derive. Efficiency-only; defer until re-emit churn is measured.

## Doc-set hygiene (enforced)

- **Canonical doc set is mechanically reconciled.** `scripts/check-doc-manifest.mjs`
  (in `verify:release`) fails the build if any tracked `docs/**/*.md` is absent from the
  routing table in [`doc-review-guidelines.md`](doc-review-guidelines.md), or a row points
  at a deleted file. A stray/dated doc can no longer accumulate silently — it must be
  registered (type + reason) or deleted. The doc-review routine adds the soft layer:
  existence-review every run + version/date/status strings are escalate-not-auto-bump
  (a doc whose only diffs are version bumps is a status doc → propose generate-or-retire).
  Durable design captures go to a canonical design doc or backlog/HANDOFF, **never** a
  dated `*-plan-of-record.md` in the tracked tree (the gate now rejects the latter).

## Durable traps (environment / tooling reference)

Standing gotchas worth keeping for any agent (strong or weak):

- **Before starting ANY lap in a worktree, sync with remote main — landed work may be missing.** A worktree
  can be branched from a *stale* local main and miss commits that already landed on `audit-tools/main`. This
  session branched 4 commits behind and **re-implemented a full commit (admission-control 2a) already on
  main**, plus built 2b blind to a pinned design section it lacked — then had to `git reset --hard
  audit-tools/main` + cherry-pick + reconcile. First action of every lap:
  `rtk git fetch audit-tools main && git log --oneline HEAD..audit-tools/main` — if that lists commits,
  rebase/reset onto main BEFORE writing code. (Strengthens [[audit-tools-worktree-traps]].)

- **Remediate-code worktree branches strand commits off main.** Remediate runs on isolated git worktree branches; landed work accumulates on `remediation/<runId>` and the host is left checked out there. By DEFAULT those branches are never auto-merged — the base branch is left untouched for review. Any doc or code fix applied inside a remediate run never reaches main unless explicitly merged. Effect: the doc-review nightly routine (which reviews main) keeps re-surfacing the same findings indefinitely. **Opt-in fix (B5, shipped):** select the `merge-to-base` closing action at the confirm step — the tool then `--no-ff` merges `remediation/<runId>` into your launch branch at close (aborts safely on conflict). Otherwise, after a run that touches docs/code you want on main, merge `remediation/<runId>` manually before the next nightly run.

- **`.gitignore` artifact-tree re-include structure (don't flatten it).** The managed block ignores the
  `.audit-tools/` runtime tree at the CONTENTS level (`.audit-tools/*`, `.audit-tools/*/*`) and re-includes the
  tracked deliverables + `*/agent-feedback.jsonl` — never as a blanket `.audit-tools/` dir-ignore, because git
  cannot re-include a file under an excluded directory. Private ⇒ deliverables tracked; public ⇒ blanket-ignore.
  Single-sourced in `src/shared/io/gitignoreArtifacts.ts` (`renderGitignoreBlock`), idempotent against the
  committed block. If you ever see deliverables un-trackable, it's a stray blanket `.audit-tools/` line OUTSIDE
  the managed markers — delete it, the managed block owns the tree.
- **Tool-managed ignore patterns for runtime artifact dirs MUST be anchored to `.audit-tools/`**, never a
  bare `**/<name>/` — an unanchored glob (e.g. `**/friction/`) regenerates on every `ensure`/postinstall and
  can shadow a same-named SOURCE dir (`src/shared/friction/`), which a file-level edit can't fix. (`.audit-code/`
  is fine — distinct name, no source collision.)
- **Wall-clock peak-concurrency tests are latency-fragile.** The rolling-driver integration tests assert
  `peak == N` by dispatching N nodes with a short `setTimeout` and reading the max simultaneous in-flight
  count. Any change that adds per-dispatch latency on the dispatch path (e.g. the reservation-ledger's
  reserve-before-dispatch file-lock) can push admission past the delay window so peak reads `< N` on a slow
  FS (Windows), a green-on-Linux / red-on-Windows or intermittent failure. When you touch the dispatch path,
  expect these and either keep the added latency off the hot path (the finite-budget gate that keeps the
  ledger unwired on the claude-code path) or widen the test's delay well past worst-case admission latency.
  (`tests/remediate/rolling-dispatch-file-ownership-ordering.test.ts` §INV-SOO-03/05.)
- **CLAUDECODE** is set in-session → UNSET for true-green gate runs (`env -u CLAUDECODE …`; set = one
  audit-code provider test fails).
- **Fresh git worktree lacks `node_modules`** → `audit-tools/shared` resolves a stale `dist/` (spurious
  "no exported member") → run `npm install` in the worktree first.
- **One test runner: vitest** (all three areas — `tests/audit`, `tests/shared`, `tests/remediate`).
  Run a single file with `npx vitest run <path>`. `node:assert/strict`
  is still permitted as an assertion lib (runs under vitest) for the control-flow assertions
  (`assert.throws`/`rejects`/`doesNotThrow`/`doesNotReject`) that have no clean `expect` equivalent; value
  assertions are `expect`. Vitest `testTimeout` is raised to 120s in `vitest.config.ts`
  because audit integration tests spawn real subprocesses.
- **Don't mask the test exit code.** `npm test > out; echo done` reports the *trailing* command's exit, not the
  suite's — and piping through `grep`/`rm` in the same Bash call races the output file, so a real failure reads
  as "green." Capture the suite's own status: `npm test > out 2>&1 && echo PASS || echo "FAIL=$?"`.
- **Global `-g` install defers `postinstall`** (npm allow-scripts) → the host-integration deploy silently
  skips; finish with `npm i -g --allow-scripts=audit-tools` or `node "$(npm root -g)/audit-tools/scripts/postinstall.mjs"`.
- **A global junction to a LIVE working tree silently shadows a registry install.** If the global
  `audit-tools` is a `Junction` → the working tree (from a prior `npm link`), `npm i -g audit-tools`
  does NOT replace it, and bins run your working-tree dist; invoking a bin *through* the junction path
  can also produce odd artifacts. Fix: `npm rm -g audit-tools` FIRST, then reinstall, and verify
  `(Get-Item <globaldir>).LinkType` is empty before trusting the smoke. (See [[audit-code-global-bin-traps]].)
- **A NEW `.claude/hooks/*.mjs` needs an explicit `!.claude/hooks/<name>` re-include in `.gitignore`.**
  `.gitignore` ignores `.claude/hooks/*` then allowlists each tracked hook by name (deliberate — never ship
  arbitrary `.claude` files). Adding a hook and committing WITHOUT the `!` exception silently drops the file
  from the commit; if `.claude/settings.json` (committed) references it, main now points at an untracked hook
  = broken state. Add the `!.claude/hooks/<name>` line in the same commit as the hook + its settings.json
  registration. (Bit once 2026-07-05: `friction-stop-gate.mjs`.)

- **A `\0` in a Write-tool template literal lands as a RAW NUL byte → binary-flags the source file.** Writing
  `` `${a}\0${b}` `` (a NUL pair-key separator) via the Write tool put a literal 0x00 in the `.ts` source, so git
  treated it as **binary** (`git diff` shows `Bin`/`- -`, grep-hostile) even though tsc/vitest read it fine. Same
  for an in-comment control char. Detect with `python -c "print(open(p,'rb').read().count(0))"`; fix by using a
  text-safe escape that stays a source escape (`U+001F` unit separator) or a printable delimiter. Never embed a
  raw control byte in source — prefer a `\uXXXX` escape the compiler resolves at runtime. (Bit once 2026-07-05:
  `src/shared/decompose/consensus.ts` pairKey.)
- **The Bash tool mangles Windows backslash paths** (`C:\a\b` → `C:ab`) → use forward slashes or the
  PowerShell tool for absolute-path commands.
- **PowerShell**: assign `foreach` output to a var before piping to `ConvertTo-Json`; `-Filter` is not regex
  (use `Where-Object -match`); single-element arrays unwrap in `ConvertTo-Json` (bracket-wrap the payload).
- **When you delete a *shipped* file, grep the smoke/verify scripts** for a `requiredPackagedPaths`-style list
  (the packaged-smoke gate asserts specific tarball files).
- **A production runtime `import` declared as a `devDependency` ships a broken packaged/global install** —
  local dev + the vitest suite still pass (devDeps are present there), so ONLY `smoke:packaged-*`
  (`verify:release`) catches the `ERR_MODULE_NOT_FOUND`. When you add an `import` to any `src/` module that
  lands in `dist/` on a production path, confirm the package is under `dependencies`, not `devDependencies`.
  (Bit once 2026-07-04: `zod-to-json-schema`, used by `src/audit/contracts/workerSchemas.ts`.)
- **Async typecheck hook = stale-dist false alarm** after a shared-source edit (it runs `tsc` before the
  central rebuild); the authoritative gate is `npm run check` after `npm run build`.
- **Prefer a dependency-injection seam over module mocking** in tests. Under vitest, `vi.spyOn`/`vi.mock`
  and fake timers (`vi.useFakeTimers({ toFake: [...] })`) are available, but the codebase's established
  pattern is injectable deps (`WorkerRunDeps`, `createWriteStream`/`spawn` seams) — keep using those.
- **Front-load a broad "does this already exist" sweep BEFORE authoring goal_spec/context_bundle/
  module_decomposition, not just a targeted one.** A narrow Explore before contract authoring is the top
  repair-round-churn driver — search the WHOLE repo for equivalent logic AND independently re-verify the
  target symbol's own type/shape against source at least once per contract. The cost of one broader Explore
  call or one grep is far lower than a full adversarial repair round or an implement-time revert.
  [[front-load-broad-search-before-contract-authoring]]
- **Don't fan out a large mechanical edit across parallel subagents that spawn their OWN grandchildren.**
  For a broad mechanical sweep over a shared file set, run it as ONE serial agent (or partition by
  NON-overlapping files), never an uncoordinated fan-out; and never hand-edit the same files while a
  background agent is live on them.
- **`rtk` compresses files you need verbatim.** When reading the `audit-code` skill body or `docs/backlog.md`
  through `rtk read`, content gets partially summarized with retrieval hashes → not exact. For any file you must
  act on verbatim, use raw `Get-Content -Raw` (or the Read tool), not `rtk read`.
- **`rtk proxy` runs executables, not PowerShell cmdlets.** `rtk proxy Get-Content` / `rtk proxy Get-ChildItem`
  fail (cmdlets aren't standalone exes). Working form: `rtk proxy powershell -NoProfile -Command "..."`.
- **`rtk proxy rg` fails with `Access is denied`** (Codex/win32). Fallback: PowerShell `Select-String` (or the
  Grep tool).
- **Never pass `isolation: "worktree"` to the Agent tool when dispatching a remediate-code/audit-code implement
  node.** The tool's own dispatch plan already creates and names the node's worktree; adding the Agent tool's
  OWN `isolation: "worktree"` spawns a second, unrelated git worktree and the subagent edits source files there
  instead of the tool-designated one — `accept-node`'s cherry-pick then sees no diff.
  [[no-agent-isolation-worktree-for-dispatch-nodes]]
- **No host-side unblock for a wedged audit run — use `audit-code force-synthesis`.** Host-side attempts to
  unblock a stuck audit (pending tasks that won't clear) do NOT work and actively corrupt gitignored
  run-state: marking `status:complete` in `audit_tasks.json` is ignored; writing
  `partial_completion_terminal.stranded_ids` is overwritten; appending results with unique idempotency keys
  clears the obligation but cascades stale `planning_artifacts`. The only clean recovery is the tool-owned
  affordance — `audit-code force-synthesis` stamps an `operator_forced` partial-completion terminal over the
  pending task ids (durable direct write to `active-dispatch.json`, the special-loaded artifact
  `writeCoreArtifacts` doesn't own) and drives the synthesis executor from the intact ledger on partial
  coverage, with no hand-editing of gitignored run-state. (`src/audit/cli/forceSynthesisCommand.ts`;
  `buildOperatorForcedTerminal` in shared; e2e in `tests/audit/audit-code-completion.test.mjs`.)
