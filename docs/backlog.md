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

- **Friction (ambiguous-direction): a backlog item that prescribes the *fix mechanism* over-reaches; state
  the invariant/bug, not the implementation (observed 2026-07-04).** The now-fixed cwd-drift bullet
  prescribed "anchor `repo_root` by walking up to the git root (or nearest `.audit-tools` marker)". Taken
  literally that re-homes legitimate sub-project / temp roots to an ancestor repo — the implementer's first
  cut did exactly that and broke `cli-remediation` tests. The correct fix was narrower: *climb out of
  `.audit-tools` only*, never trust a cwd inside it. Lesson for backlog hygiene: an item states the
  invariant to hold ("`repo_root` must never resolve inside `.audit-tools`; never nest the tree") and the
  bug, and leaves the mechanism to the implementer — over-specifying the fix smuggles in an untested design.

- **Friction (inefficient-feeding): concurrent agents share one working tree with no per-agent doc-staging
  lane (observed 2026-07-04).** Two agents worked `main` in the same checkout simultaneously; the second
  couldn't touch shared docs (`docs/backlog.md`, `docs/HANDOFF.md`) held uncommitted by the first without
  risking a clobber, so it deferred every doc update via a handoff message. There is no mechanism for
  parallel agents to stage doc edits independently (per-agent worktree, doc-fragment files merged later, or
  an advisory doc lock). Until there is, cross-agent doc updates serialize through hand-back prose.

- **No tool affordance to re-verify/re-accept a QUARANTINED implement node after fixing the cause
  (observed 2026-07-04).** When a node's accept-verify fails, its commit is preserved at
  `refs/remediation-quarantine/<run>/<block>` but there is no `remediate-code reverify-node --id … --run-id …`
  (or `accept-node --retry`) to re-run verify against that preserved commit once the failure cause is fixed.
  Recovery is manual `git cherry-pick -x` of the quarantine refs + a hand-run whole-suite verify, and the
  gitignored run-state stays permanently marked "failed" (branch becomes the only source of truth). Add a
  re-verify/re-accept path so a fixed verify environment can cleanly re-drive quarantined nodes.

- **Contract-pipeline `contract_finalization` re-dispatches 12 heavyweight per-module agents for what is
  mostly a deterministic transform (inefficient-feeding, observed 2026-07-04).** Finalization = the draft
  module contract + the seam-reconciliation decisions attached as `seam_adjustments`; it needs no fresh
  source read. Fanning out 12 sub-agents to re-read every file scope again costs ~1.4M tokens for a merge a
  deterministic step could do (attach each module's seam adjustments from `seam_reconciliation_report`,
  coerce `inputs`/`outputs` to `string[]`). Make finalization a deterministic attach step (LLM only where a
  seam decision genuinely needs judgment). Related shape bug: draft shards may emit `inputs`/`outputs` as
  arrays of objects, but the finalized schema requires `string[]` — single-source the field type across the
  draft and finalized contracts so no coercion is needed.

- **Friction close-out — per-category WALK shipped; auto-seeding + bypass-backstop still open (2026-07-04).**
  The end-of-run friction triage now blocks until EVERY category in `FRICTION_CATEGORIES`
  (`ambiguous_direction` / `tool_should_decide` / `inefficient_feeding`) is covered by a category-tagged
  `open_observations[]` entry OR an explicit `category_attestations[]` "none", plus a `free_form_notes`
  channel (`src/shared/friction/triage.ts`, both orchestrators; shipped `054c9ef9`). **Still open, two
  parts:** (a) **step-boundary auto-seeding** — the walk still starts from a near-empty subject set because
  only ~2 sites feed `captureFrictionEvent`; instrument the `next-step`/`accept-node`/`validate-artifact`
  boundaries so re-emits, judge repair rounds, artifact rejects, obligation-renumbers, `resolved_no_change`
  merges, and node quarantines auto-seed the per-category walk (turns "recall" into "account for these N
  counted events"). (b) **session-level `Stop`-hook backstop** — the close gate only fires when a run cleanly
  CLOSES; a run that bypasses close (e.g. the 2026-07-04 verify-runner recovery that assembled the branch by
  hand) never hits it, so friction goes unlogged. A `Stop` hook that detects a remediate/audit run in the
  session with no friction entry and blocks stop with the walk closes that. See
  [[meta-audit-friction-must-be-tool-enforced]].

- **Capability handshake is inherited from the run/original auditor, not the current one.** When a
  different auditor resumes an audit (run started in Codex, resumed by Claude Code), a `next-step` that
  omits the capability flags resolves the dispatch pool from the **stored session config**
  (`resolveFreshSessionProviderName` → the pinned original provider) and sizes against *that* provider's
  quota — e.g. a Claude-driven host fan-out was sized to Codex's `provider_default` 2-slot window. Two
  defects: (1) step-prompt continue-commands omit the `--host-*` capability flags, so the handshake is
  silently lost on every step after the first — "works only because the host re-appends flags the prompt
  dropped" (auditor-agnostic-robustness violation); (2) dispatch quota/provider is keyed to the run's
  original auditor instead of whoever drives the current step. Fix: capability (concurrency / window /
  quota-key) must be discovered per-invocation from the **current** auditor and never inherited from the
  run — a host-subagent-driven dispatch must size to the host's own reported capability, not the stored
  provider pool; only per-`(provider,model)` *learned quota* persists (keyed by auditor identity). See
  [[capability-is-per-auditor-not-per-audit]]. **Not yet fixed** — design change touching
  `src/audit/cli/dispatch/quotaPool.ts` + `nextStepCommand.ts` + step-prompt rendering.
  - **Design of record: [`spec/audit/dispatch-admission-control.md`](spec/audit/dispatch-admission-control.md)** (status:
    proposed). The fix generalized past "capability" into a full dispatch rework: **concurrency is the
    wrong primitive** -> admit one task at a time on a live per-pool token budget (concurrency emergent);
    self-describing per-invocation pool descriptors; a shared, `withFileLock`-guarded, account-keyed
    (`provider#account/model`) **reservation ledger** to avoid clobbering the shared provider meter
    (proactive for co-located consumers, reactive shared-key backoff cross-machine). See
    [[dispatch-admission-control-design]]. **Owner not yet fully convinced** — the spec's *Open tensions*
    section holds the unresolved objections (output-token unknowability; ledger-is-a-proxy / possibly
    over-built vs reactive-only). Resolve those before building.
  - **Audit dispatch can't fan out across host + codex + NIM concurrently — parity gap with remediate
    (observed 2026-07-04).** On a Claude-driven host-subagent dispatch step, dispatch-quota established a
    *single* `codex` pool (slots:2, `binding_cap: token_budget` off codex's 45% quota) even though
    `provider_confirmation.json` lists `claude-code` (frontier) + `codex`. Two concrete defects beyond the
    capability-inheritance bug above: (1) **host pool excluded from the audit dispatch plan** — when a
    provider resolves to in-process (`resolvesToInProcessDispatchProvider`,
    `src/audit/cli/rollingAuditDispatch.ts:75-91`), pools are built only from configured backend sources
    (`buildAuditSourcePools`, `src/audit/cli/hybridDispatch.ts:57`); the `claude-code` host-subagent pool
    is never added. Remediate already builds host + source pools together (`buildConfirmedPools`,
    `src/remediate/steps/dispatch.ts:429`) — **bring audit to parity.** (2) `selectProvider`
    (`src/shared/dispatch/rollingDispatch.ts:345`) is sequential-per-packet + spill-on-degrade, not
    deliberate multi-pool fan-out; multi-pool capacity math already exists (`computeDispatchCapacity`,
    `src/shared/quota/capacity.ts:378`). (3) **NIM/openai-compatible can't take read-heavy audit packets
    single-shot** — packets require the worker to *open* granted repo files; a single-shot chat call has no
    file access, so NIM can only participate via the in-process wrapper that serves file bodies (or by
    inlining files into the prompt). Any deeper fix that adds NIM to the audit pool must route file
    contents to it, not just the prompt. **Workaround used this run:** drove the fan-out manually across
    Claude subagents + codex CLI (file-capable) + NIM (small inlined packets). **Observed executor
    fitness this run:** Claude subagents = reliable, ~90-210s/packet, valid JSON every time. NIM
    (deepseek-v4-pro, inlined) = worked for 2/3 small packets; 1 failed by emitting the packet's
    "reply one-line confirmation" instead of the JSON array (single-shot can't write result_path, so the
    reply convention leaked into output) → needs an output-contract override in the wrapper. Codex CLI
    (`codex exec --dangerously-bypass-approvals-and-sandbox`) = **too slow to be useful here**: 2
    concurrent ran 5+ min on the first 2 read-heavy packets with **zero** result files written, 8k+ lines
    of echoed reasoning → abandoned, its 10 packets reassigned to Claude subagents. Lesson for the real
    multi-pool fix: codex is not a good fit for large read-heavy audit packets under a wall-clock budget;
    route only small/low-line packets to it, or drop it from the audit pool.

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

- **Committed host assets drift from the renderer without a gate — AUDIT SIDE guarded (CP-NODE-10 merged);
  REMEDIATE-side opencode.json still unresolved (2026-07-04).** CP-NODE-10 (merged to `main`) extended
  `host-asset-renderer-drift.test.mjs` to assert the tool-owned block of `AGENTS.md` / `opencode.json` /
  `.github/copilot-instructions.md` (only `.gemini/*.toml` + `auditor.agent.md` were guarded before) —
  correctly guarding only the tool-owned portion, since those files are managed merge targets carrying
  intentional non-renderer content, so a byte-identity guard would be wrong. **Still open:** the
  **remediate-code** side of the shared root `opencode.json` still drifts ungated. Regenerating it via
  `remediate-code ensure` (attempted + reverted this run, `bdba4f02`→`b66731f7`) adds `remediate-code`
  commands to top-level `permission.bash` that are NOT mirrored into `agent.auditor.permission.bash`,
  breaking `INV-RCI-16` (audit-cli-invariants) — the two installers write one shared `opencode.json` and
  the auditor-agent parity invariant doesn't expect the remediate commands. Reconcile the two installers'
  ownership of `opencode.json` (or the INV-RCI-16 parity rule) before the remediate-side assets can be
  regen-guarded like the audit side.

## Forward tracks

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

- **Possibly bundle `headroom` and/or `rtk` into the shipped `audit-tools` install (owner, 2026-07-04).**
  Idea: make installing `audit-tools` also provide the headroom token-proxy and/or the rtk token-optimizer,
  so the token-efficiency tooling ships with the package instead of being set up separately per machine.
  Scope/shape undecided (bundled bin? optional postinstall? peer tool?) — revisit when it firms up. (This
  replaced the retired stale "Headroom over opentoken" CLAUDE.md bullet, whose orchestrator-internal
  `headroom-ai`/`wrapForOpenToken` swap already happened or never materialized.)

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
