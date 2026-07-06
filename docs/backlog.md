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

- **Adding one PRIORITY-chain obligation ripples through ~10 fixture tests (friction, 2026-07-05, Phase B).**
  Inserting `structure_decomposition_current` at PRIORITY idx 9 broke ~10 audit test files whose fixtures build
  a bundle "advanced to `design_assessment`" and then assert the NEXT step / a hardcoded priority index. Each
  needed the new artifact pre-satisfied (or an extra `advanceAudit` step) — a broad, mechanical, per-file churn
  every time a phase is added. Fix in tooling: a SHARED "advanced-bundle" fixture builder (one place that seeds a
  bundle satisfied through phase N) + priority assertions keyed by `PRIORITY.indexOf(id)` relationships, not
  literal integers, so a new obligation is a one-line fixture edit, not a 10-file sweep. Low-pri (test ergonomics)
  but recurs on every new phase (C/D/E are coming).


- **Commit-gate hook validates the WORKING TREE, not the staged snapshot (hit 2026-07-05).** The
  green-at-every-commit PreToolUse hook runs `npm run check` against the working tree/dist, so a *partial-stage*
  commit that is internally broken can still pass: shipping a dead-module deletion as two commits, the first
  `git add <one file> && git commit` bundled the already-`git rm`-staged deletions but left the compensating
  barrel edit (`src/shared/index.ts`) unstaged → that commit in isolation deleted `rollingEngine.ts` while still
  re-exporting it (red), yet the hook greenlit it because the *working tree* (barrel edit present) was green.
  Caught by eye (file-count in the commit confirmation), not the gate. Real gap in the invariant: a split/partial
  commit can violate green-at-every-commit undetected. Fix: have the gate check the *staged* tree (e.g. `git
  stash -k --include-untracked` → build+check → pop, or a temp-index checkout) so the committed snapshot is what's
  validated, not the working tree. (Note: `git rm` stages deletions immediately — a subsequent scoped `git add`
  does NOT isolate them.)

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

- **CI test redundancy: the vitest suite runs ~3× per push across workflows (observed 2026-07-04).** After
  sharding `ci.yml` + `publish-package.yml` (vitest = ~93% of the release gate; now sharded 4 ways → ~2×
  faster gate), `audit-code-test-suite.yml` still runs the *full* `npm test` on Node 20 **and** 22 (its
  distinct value is Node-20 type-stripping coverage `ci.yml` lacks). Net: a normal `src/` push runs the
  suite in `ci.yml` (Node 22) + `audit-code-test-suite.yml` (Node 20 + 22) = 3 full runs. Follow-up:
  shard `audit-code-test-suite.yml` too, and/or fold the Node-20 line into a single sharded matrix so the
  suite runs once per Node line, sharded — not 3× whole. Deferred (not on the release-blocking path; only
  `publish-package.yml` gates the `/ship` wait).

- **Optional: cut vitest `collect` (~186s) / per-file isolation overhead (noted 2026-07-04).** Full-suite
  `collect` is ~186s of module load/transform for 430 files; default `pool: 'forks'` adds per-file process
  startup. `pool: 'threads'` and/or `isolate: false` could help, but many audit/remediate tests mutate fs
  and spawn subprocesses → isolation-off risks cross-test bleed. Only pursue with per-file verification.
  Lower priority than the sharding already shipped.

- **Dispatch admission-control rework — ✅ COMPLETE (founding bug commit 3 + defect-1, 2026-07-05).** The
  whole rework shipped: commits 1 + 2a + 2b-AUDIT + 2b-REMEDIATE + rolling-driver unification + the founding
  capability-inheritance bug (host-review pool keyed to the driver via `resolveHostDispatchProviderName`;
  `HostDispatchDescriptor` rides every continue-command) + **defect-1 (host + codex + NIM CONCURRENT
  fan-out)**. Defect-1: an attended host (`host_can_dispatch_subagents` default true) resuming a
  backend-configured run now DEMOTES the configured in-process backend (codex/opencode/openai-compatible) to
  a *source* pool so host + backend + NIM fan out concurrently; the in-process whole-frontier driver fires
  only when headless (`host_can_dispatch_subagents:false`). Discriminator reuses the existing boolean (no new
  field — driver identity already ships on `HostDispatchDescriptor`); both orchestrators gated in parity;
  `buildConfirmedPools` decouples host-pool identity (claude-code when demoting) from the source provider
  (the actual backend). Sub-2: `selectProvider` breaks equal-rank ties by least in-flight load so
  same-complexity packets balance across equal pools instead of front-loading one. Sub-3: the single-shot
  openai-compatible (NIM) worker gets an output-contract override (no "reply valid: …" leak into `result`),
  read-neutral referenced-files framing, and operator-tunable inline caps for read-heavy packets. See
  [[capability-is-per-auditor-not-per-audit]] / [[dispatch-admission-control-design]] / design of record
  [`spec/audit/dispatch-admission-control.md`](spec/audit/dispatch-admission-control.md).
  - **Residual (env-bound / deeper, not blocking):** (a) **live validation** of the real host+codex+NIM
    concurrent run — a metered multi-pool run confirming the demoted backend actually fans out alongside the
    host (folds into the quota-aware-dispatch live-run watch below). (b) **Deeper simultaneity:** the audit
    hybrid path drives the in-process (codex/NIM) partition to completion within a `next-step` turn, THEN
    hands the complement to the host — so host and backend alternate ACROSS turns, not simultaneously WITHIN
    one. True within-turn simultaneity would need a detached background driver spanning host turns
    (architectural; only pursue if wall-clock on a real run shows the alternation is the bottleneck).
    (c) **Executor routing lesson (durable):** codex CLI is a poor fit for large read-heavy audit packets
    under a wall-clock budget (observed 2026-07-04: 2 concurrent ran 5+ min with zero results, 8k+ lines of
    echoed reasoning) — route only small/low-line packets to it, or drop it from the audit pool.

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

- **`next-step` emits repeated `staleness` chatter while regenerating artifacts.** Harmless but noisy — many
  `staleness` records surfaced to host during artifact regen. **Retargeted 2026-07-04:** this is NOT a
  `nextStepCommand`-layer aggregation — the CLI layer surfaces no staleness-record list; the "chatter" is a
  cross-invocation phenomenon (each `next-step` during regen emits its own step). A real fix eagerly drains
  regen inside one `advanceAudit` pass — an **orchestrator-level** change (`advance.ts`/`nextStep.ts`), not a
  bounded CLI fix. Codex run 2026-07-03.

- **Reconcile the shared `opencode.json` via a union permission ceiling; regen-guard the remediate side
  (2026-07-04).** Both installers (`audit-code ensure`, `remediate-code ensure`) write one shared repo-root
  `opencode.json` carrying a top-level `permission` default plus per-agent blocks. Today top-level is treated
  as the *auditor's* private policy and a parity invariant (INV-RCI-16) pins it byte-equal to the auditor
  block — so when the remediate installer regenerates the file, its commands land at top-level and break that
  parity, which is why the remediate-side asset can't yet be renderer-gated like the audit side. **Desired
  end-state:** top-level `permission.bash` becomes the deterministic **union** of every agent's bash rules —
  a true global privilege *ceiling* — and the parity invariant is reframed from "top-level equals the auditor
  block" to "each agent's rules are a subset of top-level, and top-level introduces no command no agent
  needs." Both installers may then regenerate the shared file in any order, idempotently. Two hard
  requirements: (1) widening the ceiling must **not** silently grant a read-only agent another tool's
  mutating commands — a wildcard `*: allow` must be matched by explicit per-agent denies so least-privilege
  still holds; (2) both installers' verifiers must accept each other's keys in the shared blocks (today
  they're **mutually blind** — one greenlights exactly the state the other rejects), so either side is
  independently regen-guardable. **Direction this serves:** the auditor/remediator distinction is a vestigial
  holdover from when they were two separate projects and should be dissolved wherever possible
  ([[dissolve-auditor-remediator-distinction]]). As it dissolves, the two agent blocks collapse toward a
  single unified policy and the union degenerates to that one policy — build the union model so it lands
  cleanly on one agent, not so it entrenches two.

## Forward tracks

- **Cost-first routing follow-ups (W2 core + interactive Gate-0 SHIPPED).** Real models.dev price drives `costRank`
  (decoupled from `capabilityRank`) via the shared 3-rung engine, and Gate-0 is now an **interactive
  `provider_confirmation` step** on the audit CLI path. Design of record
  [`spec/cost-first-routing.md`](../spec/cost-first-routing.md), durable design in memory [[cost-first-routing-design]].
  - **(a) Host-prompt visibility — ✅ SHIPPED.** `renderProviderConfirmationPrompt` (`src/audit/cli/providerConfirmationStep.ts`)
    surfaces the priced pool (model + blended $/Mtok + suggested cost order + status) to the host.
  - **(b) Interactive operator REORDER — ✅ SHIPPED.** The host writes `provider-confirmation.input.json`
    (`provider-confirmation-input/v1`: `cost_order`/`exclude`/`include`/`host_models`); the tool promotes it into both
    canonical artifacts (per-tool seam + shared confirmation). Input/envelope split ([[contract-pipeline-input-vs-envelope-paths]]);
    presence flips the gate from emit→consume. Fires on EVERY interactive run (even one/zero detected providers — the
    operator may want to add a provider discovery missed); headless auto-completes.
  - **(c) Host-roster-at-Gate-0 — ✅ SHIPPED.** `host_models` in the input reports the host's roster; those tiers are
    priced (models.dev) + ordered at Gate-0 and thread to dispatch by `model_id` via `host_model_cost_order` (a separate
    list on the shared confirmation, merged into the model-keyed positions map — zero blast radius to `provider_pool`).
  - **(d) Collision-price preference (carried from W1) — OPEN.** `resolveModelStatics` dedupes a model id served by
    multiple providers first-sorted-provider-wins, so a reseller markup could win over the native/cheapest price. Prices
    largely agree across providers, so this is an approximation, not a bug — revisit only if per-provider pricing matters
    (would need (provider, model) keying in the snapshot).
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
  Remaining (still valid): split remediate `dispatch.ts` (now ~4,590 LOC; ~60-85% is
  git-worktree/write-scope/merge machinery, misfiled not duplicated — audit's dispatch is far smaller, zero git);
  inline `makeProviderKeyedFactory` (19 LOC, 2 sites — but it's a cross-area generic with its own dedicated test
  `tests/shared/provider-keyed-factory.test.mjs`; inlining loses cohesion, marginal — low value).
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
    - **Phase A — data-model spine — ✅ SHIPPED v0.32.17.** `src/shared/types/charter.ts` (four charters + goal DAG
      w/ integer `premise_height`, never a mandated L-enum + `Ceiling` consent dial + symmetric-pair `CharterDelta`);
      `src/shared/validation/charterGate.ts` (`applyTrueCharterGate` True falsifiable-or-drop; `charterReviewDisposition`
      low-confidence→flag-for-human; `gateCharterDelta` low-confidence-side→human); `intent_checkpoint.design_review`
      upgraded additively (goal_graph/charters/ceiling); `blast_radius` optional on shared `Finding` + mergeFindings
      priority tiebreaker. Deterministic/tool-owned, no LLM. `gateCharterDelta`/`CharterDelta` are test-covered only
      until Phase C produces deltas (intentional intermediate state, not dead code).
    - **Phase B — ✅ SHIPPED.** Overlay-and-delta operator `decompose(sources,target)→{consensus,contested}`
      (deterministic), all sources in one build. Pure primitives in `src/shared/decompose/` (resolution-swept
      Louvain `modularity.ts`; co-association ensemble + two orthogonal scores `consensus.ts`). Sources:
      call/import (`allGraphEdges`), git co-change, NEW data/state coupling (`extractors/dataStateCoupling.ts`,
      bibliographic/shared-out-neighbor), NEW comment-decomposition (`extractors/commentDecomposition.ts`,
      language-neutral extension-keyed lexer → intent cross-refs + `deriveDocGroups`), directory-depth intent.
      Multi-resolution stability + agreed-across-source scoring; the two non-co-localization findings
      (`decompose/findings.ts`, deterministic leads, confidence low). Persisted `structure_decomposition.json`
      (new obligation `structure_decomposition_current` @ PRIORITY idx 9, deterministic executor, dep-map node,
      findings surfaced through mergeFindings/synthesis). Full `src/shared`+`tests/audit` suite green.
    - **Phase C — ✅ SHIPPED v0.32.19.** Charter extraction + conceptual prompts (LLM judgment, grounded+gated).
      Deterministic ENFORCEMENT half `src/shared/decompose/charterExtraction.ts` (`assembleCharterRegister`: id
      assignment, the design's routing table, Phase-A gates, deltas→Finding leads). host_delegation obligation
      `charter_extraction_current` (PRIORITY idx 11) + `src/audit/orchestrator/charterExtractionExecutor.ts`
      (ceiling-gated — `shallow` omits deterministically, `deep`/`deepest` emits the LLM charter-extraction prompt
      `src/audit/cli/charterExtractionPrompt.ts`, grounded in the Phase-B consensus scaffold + /init anti-slop
      discipline). Persists `charter_register.json` (OUTPUT artifact — off the intent checkpoint it depends on, no
      cycle); routed charter-delta leads surface via mergeFindings/synthesis. **Phase-C residual (small):** the
      extracted charters are NOT yet threaded into the `design_review_conceptual` prompt — that pass stays
      charter-unaware; deltas `routed_to:"clarification"` surface as findings until Phase D's loop. Fold into D or
      do standalone.
    - **Phase D (NEXT)** — charter-delta → clarification/triangulation loop: audit-side `ClarificationRequest` (port from
      remediate, charter-keyed not finding-keyed); VOI-ranked question queue; the three dials (ceiling@intent_checkpoint
      defaulted, attention loop, intensity auto); attention-0 = autonomous; blast-radius ranking + risk gate.
    - **Phase E** — systemic improvement-seeking challenge loop: second-order adversary (SEPARATE agent,
      [[delegate-adversarial-phases-to-separate-agent]]) loop-until-dry; mandate = optimization/better-way; feed
      language-neutral aggregate metrics; findings carry their true lens (not a hardcoded `architecture` tag).

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
