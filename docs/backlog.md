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

- **Remediate contract/implement pipeline — dogfood frictions (fix in tooling).**
  Five open frictions surfaced driving one large `/remediate-code` run:
  - **Contract-pipeline re-convergence must be incremental — a localized change must not re-author the whole
    downstream chain.** Today a single small upstream edit re-stales and fully re-materialises every downstream
    contract/review artifact (a whole test-validator plan + a whole assessment report, etc.); on a large mixed plan
    this whole-artifact re-author was the dominant cost of a real run (dozens of full rewrites across many
    round-trips). Staleness is whole-artifact, and re-emit is always a fresh full author — even when the payload is
    byte-identical. Three invariants the tool must hold:
    - **Item-scoped re-validation (fail-closed).** A localized upstream change must re-validate and re-emit only the
      downstream *items* (obligations / specs / findings) that actually derive from the changed upstream item — not
      the entire artifact. Where per-item provenance can't be established for a given item (e.g. a finding that
      reasons across modules), that item falls back to full re-validation, so scoping never *under*-invalidates and a
      real staleness is never silently missed. (The observed "plan ↔ assessment ping-pong" is *not* a dependency
      cycle — the edge is one-way; the churn was whole-artifact restaling off shared upstreams, which item-scoping
      dissolves.)
    - **Empty-delta re-emit is a deterministic copy-forward, never an LLM dispatch.** When an artifact's (or an
      item's) upstream semantic-projection delta is empty, the tool re-envelopes the prior payload forward
      deterministically with zero worker dispatch. A verbatim carry-forward must never cost an LLM round-trip (a copy
      job is never a dispatch).
    - **Batch all gate failures into one report.** Every structural-gate failure currently present in the plan
      surfaces in a single report at once, not one-batch-per-round-trip (no fix→re-run→new-failure thrash).
    Reinforces [[risk-tier-loop-laps-cheap-vs-heavy]] and the self-scaling-pipeline direction
    [[self-scaling-pipeline-not-forked-paths]]; the copy-forward invariant extends [[deterministic-contract-finalization]].
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

- **Regen-drain must be safe and active on the primary path — not a dormant, unsafe opt-in.** Collapsing a
  chain of consecutive deterministic regen steps into one host round-trip + one consolidated staleness record
  (instead of N of each) is a real recurring win on the conversation-first path — every cold start and every
  migration-triggered staleness cascade. Today it ships as an opt-in (`advanceAudit` drain) that **no production
  caller enables**, and it is *unsafe* to enable as-is: its stop-gate reads executor-registry granularity, but
  two host-input pauses — analyzer-install consent and low-confidence edge-reasoning — live *inside* a
  deterministic executor and are invisible to that gate, so a naive drain silently skips operator consent (a
  latent correctness footgun, not merely efficiency). Invariants to hold:
  - **A drain must stop at EVERY host-input pause**, including the sub-executor interactive folds not
    distinguishable at executor-registry granularity. The fold that owns a pause is the single authority on where
    a host-stop belongs — surface that signal so the drain (and the primary step loop) always halt there.
  - **The safe drain is the default behavior of the primary path — no opt-in flag** (a needed manual flag is a
    bug signal). Any future autonomy driver is merely a *consumer* of the same fold-aware stop signal, never a
    second code path that re-implements the fold boundaries.

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

- **Pipeline profiling is now standing (2026-07-06).** Always-on timing across test + release/publish,
  single-sourced in `scripts/shared/profile.mjs`; ledgers land in `.audit-tools-profile/` (gitignored) +
  a CI job-summary table. `verify:checks` runs its sub-steps through `scripts/shared/profile-run.mjs`;
  `scripts/shared/vitest-timing-reporter.mjs` is wired into `vitest.config.ts`; `release-and-publish.mjs`
  writes a `release` phase profile + a `publish-ci` per-job/per-step profile from the publish run's API.
  Use the `*-history.ndjson` trend line to catch time regressions. Durable how-to in `CLAUDE.md` →
  Release & publish → Pipeline profiling.

- **Top gate optimization lead (measured 2026-07-06, was the "vitest collect" item).** First profiled
  numbers (win32, Node 26 local; CI Linux will differ but the shape holds):
  - **`verify:checks` gate = 95.8s, of which `smoke:packaged-audit-code` alone is 70.2s (73%).**
    `smoke:packaged-remediate-code` is 13.2s; everything else (check 3.6 / deadcode 2.1 / doc-manifest 0.5 /
    build 5.0 / hosts 0.5+0.6) is ~12s combined. The `check`→`build` double-`tsc` (~8.6s) is minor next to
    the packaged smokes. **→ The highest-leverage gate win is the packaged-audit-code smoke** (npm pack +
    global install + next-step round-trips); investigate trimming the install/round-trip cost or caching the
    packed tarball rather than chasing the tsc/collect items.
  - **Full vitest suite = 307s wall (452 files), `collect≈211s`** (confirms the old ~186s estimate), run
    time dominated by audit integration tests that spawn real subprocesses: `audit-code-completion` 285s,
    `audit-code-wrapper` 237s, `next-step` 165s, `cli-remediation` 111s. area:audit ≈ 1905s summed across
    workers vs remediate 451s / shared 62s. `pool: 'threads'` / `isolate: false` won't help the run-time
    tail (it's subprocess wall, not isolation overhead); the real lever is the sharding already shipped +
    possibly splitting the few 100s+ integration files across more shards. Only pursue collect/pool changes
    with per-file verification (many tests mutate fs / spawn subprocesses → isolation-off risks bleed).

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
    run shows the alternation is the bottleneck).

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

- **Codex CLI is a poor executor for large read-heavy audit packets under a wall-clock budget.** Observed
  2026-07-04: 2 concurrent codex executors ran 5+ min with zero results and 8k+ lines of echoed reasoning.
  Route only small / low-line packets to the codex pool, or drop it from the audit executor pool for
  read-heavy work. (Durable routing lesson from the admission-control rework.)

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
