# Backlog — open work, durable traps & future directions

A living **to-do list**, not a status log. Remove an entry once it ships — record durable
contracts/rationale in project memory or `CLAUDE.md`, never "where the code is today."

---

## Open bugs / frictions — fix in tooling (never "host remembers")

- **Contract-pipeline host-friction inventory — points where the tool makes the HOST decide / feeds ambiguous direction / orders work inefficiently.** Each a "fix in tooling, never host-remembers" item. **(A) Ambiguous backend direction — ALL SHIPPED (A3 pinned: `mergedBaseCheckArgv` in `src/remediate/steps/gateCommands.ts` derives the merged-base check from the gate's `check`-layer argv; no hardcoded `npm run check`).** **(B) Tool should decide FOR the host:** (B2) **SHIPPED** — `buildImplementationDagScaffold` now groups a finalized module's obligations into ONE DAG node (a `module` field threaded onto each design_spec-sourced obligation at derive time; obligations with no module home fall back to one node each), so a 1-module change derives 1 node instead of N the host must merge; coverage preserved; (B3) **SHIPPED** — advisory conceptual-critique items now have a first-class carrier: `ImplementationDagScaffoldNode.addressed_critique_items` (blank slot per node) + `advisoryCritiqueItems()` reader surfaces them in the implementation-DAG skeleton prompt; (B4) **SHIPPED** — `created_at` is now tool-stamped (`stampToolCreatedAt` in `contractPipeline/artifactStore.ts`, injected at `ingestContractArtifacts` + the `validate-artifact` self-check before validation); dropped from every host-facing contract-pipeline schema. NOTE: the lean-light-review verdict (`nextStep.ts`) still asks the host for `created_at` — separate artifact/read-path, not yet stamped; (B5) **SHIPPED** — opt-in `merge-to-base` closing action kills the [[audit-tools-worktree-traps]] strand-trap: `ensureRemediationBranchCheckedOut` records the launch branch in a `remediation-base-branch.json` sidecar on first creation; `executeClosingAction` (close.ts) checks out that base and runs `git merge --no-ff remediation/<runId>` (one revertable merge commit), aborts+restores the remediation branch on any conflict (base untouched), skips with a manual-merge note when no base was recorded. Default posture unchanged — the action must be selected at the confirm step. **(C) Inefficient order / feeding:** (C2) `goal_spec`/`context_bundle`/`module_decomposition`/etc. are host-authored boilerplate for a one-file fix the tool could mostly pre-derive (→ subsumed by T1); (C3) **SHIPPED** — test-plan diff-carry: `captureTestPlanCarry` (`contractPipeline/testPlanCarry.ts`) snapshots each authored spec's identity (`name`+`scope_anchors`) + assertions keyed by obligation_id on ingest; `buildTestValidatorPlanScaffold(ledger, prior)` pre-fills assertions for every obligation whose premise is unchanged, blanks a renamed/re-scoped one (fail-safe toward re-author). **(D) Gate/RMW frictions:** (D1) **SHIPPED** — per-spec `scope_anchors` in the test-plan skeleton; (D3) **SHIPPED** — host-authored INPUT path separated from the tool-derived envelope path. The host now writes its plain payload to `<name>.input.json` (`contractInputFilePath`) and reads upstreams from the same input files — the host's world is entirely plain `.input.json`, it never sees an envelope. `ingestContractArtifacts` reads the input, validates, and derives the canonical content-hash envelope at `<name>.json` (`contractArtifactFilePath`, tool-owned bookkeeping for the staleness DAG); the on-disk file the host wrote is never mutated in place. Ingest is idempotent via semantic-projection hash (the persistent input file is not re-ingested unless its meaning changed — no re-fired snapshots). `archiveContractArtifact` now preserves the host input (the LLM emission) AND clears the canonical envelope so the completion gate re-fires. `detectStaleArtifacts` hardened against a partial envelope. Every host-facing path (the prompt artifactPaths, the scaffold self-checks, the cyclic-seam prompt + its manual-rewrite hatch) points at the input path.
- **Friction DETECTION is mechanical-only — semantic/process friction goes uncaptured; close-out recall UNDER-captures.** Proven repeatedly: the close-out named-dimensions recall prompt does not force a transcript/run-log WALK, so the host logs a few and misses many real frictions; "no friction" satisfies the gate. A host-kept journal does NOT fix this (same host-discretion anti-pattern). **Enforceable direction: the backend already OBSERVES most friction at its own step boundary — no transcript needed.** Nearly every friction is a backend-side event (a phase re-emitting the same gate errors N×, a judge repair round + back-half re-derive, an artifact rejected/archived, an obligation-ledger renumber, a no-change merge). Fix = (1) **auto-capture at the step boundary** (zero host discretion) for every such event; (2) **close-out becomes per-event RECONCILIATION not recall** — surface the backend-counted event list and force the host to disposition EACH (keep/annotate/dismiss-with-reason), like the review-gate; a blanket "no friction" is impossible because the tool already knows the phase fired N×; (3) keep an always-present **free-form channel** for transcript-only friction the backend can't see. The shared step-boundary chokepoint (`stepBoundaryCapture.ts`) + the named emitters + per-event reconciliation triage are shipped; **remaining: the M-QUOTA bounded-escalation event is not yet wired to the chokepoint, and a live run must confirm the emitters actually populate the close-out.** ROOT CAUSE found 2026-06-26: `HostSessionQuotaSource.recordLimit` (the method that drives the bounded escalation) has **ZERO production callers** — only the unit tests call it. So the *entire* `recordLimit → escalate → strand (rollingDispatch.ts:510 `isPacketEscalated`) → quota_escalation friction` chain is unwired end-to-end, not merely the friction tap: nothing records a host-session re-limit during the in-process rolling dispatch, so `isEscalated` is always false, the strand guard never fires, and there is no event to capture. The friction tap (`onEscalation → captureStepBoundaryFriction`) is the LAST link; before it, a correct fix must (1) call `recordLimit(packet.id, …)` at the rate-limit observation point in `createRollingDispatcher.handleResult` (`result.outcome === "rate_limited"`), which requires threading the SAME `HostSessionQuotaSource` instance through `buildConfirmedPools` → `driveRollingDispatch` → `createRollingDispatcher` (today buildConfirmedPools constructs a throwaway instance with no `onEscalation` and never exposes it); (2) derive `isPacketEscalated` from that instance; (3) route `onEscalation` to the chokepoint with the driver's artifactsDir/runId. Multi-seam integration gated on a live rate-limited multi-worker run to validate — fits the **dispatch capability-tiered driver** forward track (which owns the same instance-threading), not a blind batch landing. [[meta-audit-friction-must-be-tool-enforced]]
- **Selective-deepening tasks never converge — packet result task_id ≠ assigned `deepening:*` id.** Workers returned packet-style task_ids instead of the assigned `deepening:finding:*`, so merge-and-ingest never matched results to tasks and looped. The prompt-side fix (explicit task_id binding in `buildTaskSections`) is in place but **needs live validation** — can't be verified without a real deepening-capable run. Recovery until validated: quarantine orphan pending `deepening:*` tasks to let synthesis run.
- **Dispatch capability-tiered driver on top of the (shipped) host-quota wiring.** `HostSessionQuotaSource` is wired first-class into the scheduler (graduated `remaining_pct`, pre-wall LOW/CRITICAL bands, escalation-stranding) and the `rate_limited` non-consuming re-queue is in place. **Remaining:** the capability-tiered *driver* (Y-dispatcher vs slot-pull selection) on top of it — see the broker-driver forward track below.

- **Unwired-but-tested extractor is invisible dead code (friction, 2026-06-27).** F6 git-history mining shipped with
  a full extractor + 27 passing unit tests but was NEVER called by an executor — green tests + green build, yet the
  feature did nothing in a real run (caught only by reading the executor). Unit tests at the seam don't prove the seam
  is *invoked*. Enforceable direction: a mechanical guard that flags an exported extractor entry-point
  (`build*`/`mine*Artifact` in `src/audit/extractors/`) with zero non-test importers — an instance of the deferred
  dead-code detection (knip/ts-prune territory, see *own-vs-acquire* / [[graph-signals-thin-substrate-extraction-persist]]).
  Until then: when adding an extractor, the wiring into `runStructureExecutor` (or its executor) is part of "done", not a
  follow-up.

## Forward tracks

- **Content-addressed, granular staleness — kill whole-artifact re-derive churn.** Staleness today is
  whole-artifact: changing one unit's intent re-stales an entire downstream artifact (e.g. the coverage
  matrix), which re-runs *all* of planning and re-touches *all* results, even for units that didn't change.
  Desired: staleness keyed at the granularity of the actual unit of work (per-unit / per-task, content-addressed
  by a stable content hash) so only the work whose inputs genuinely changed re-derives; unchanged work is skipped
  by construction, not re-run-then-deduped. This is the natural partner to the append-only results ledger
  (results keyed by content hash → an unchanged task keeps its result at zero recompute), but it stands alone as a
  general DAG-model change applying to every derived artifact, not just results. The **per-result path is shipped**
  (O3 re-dispatch attempt-counter → distinct `idempotency_key` → ledger appends fresh findings; record-on-ingest
  baseline refresh + consume-in-derive single-sourced across gate/dispatch; supersession via `selectCurrentResults`).
  **Still open: the general DAG-model extension** — per-file coverage-matrix elements + per-element baselines for
  *every* derived artifact, which needs an **incremental planning executor** (`runPlanningExecutor` rebuilds+rewrites
  `coverage_matrix` whole today), not just a staleness gate. (Ethan, 2026-06-24.)

- **Codebase-wide review for churn / context / enforce-in-tooling — same lens, applied everywhere.** The
  append-only-ledger + granular-staleness + LLM-equivalence-gate work came from one perspective; run that same
  perspective over the *entire* codebase as a dedicated pass. Hunt for: (a) **unnecessary churn** — anywhere we
  recompute / re-derive / re-dispatch more than the actual delta demands (LLM judgment to gate expensive
  recompute is one tool among others); (b) **unnecessary context** — anywhere we ship or re-ship more than needed
  into a prompt or a step (diff-only / delta-only feeds are one strategy among others); (c) **enforce-via-tooling
  prevention** — anywhere a correctness property is currently held by host/maintainer discretion that could be
  made impossible-to-get-wrong at the abstraction so the issue never arises. Not limited to the named techniques —
  the goal is the perspective, applied broadly. (Ethan, 2026-06-24.)

- **Schema-enforced generation everywhere possible — make malformed output impossible, not merely repairable.**
  Strict output schemas already exist (e.g. the worker zod schemas) but are shipped to workers only as *advisory
  reference files*; nothing forces the provider to honor them at generation time, so malformed contracts get
  emitted and only caught after the fact. Desired end-state: every structured-contract emission in the project —
  every dispatch path, every emitting agent, both orchestrators — uses the provider's strongest available
  output-constraint mechanism (forced tool-call / JSON-schema-constrained generation / structured output) so the
  schema is enforced at emit time and the malformed-output class is prevented at the source. Apply it everywhere
  a provider supports it; where a provider cannot enforce a schema, that path degrades to the layered repair seam
  (above) as the fallback — prevention first, repair as backstop. Must stay provider-agnostic: discover the
  enforcement capability per backend, never hardcode it. The emit-time seam is **present** (provider-agnostic
  `discoverOutputConstraintCapability`, strongest-at-emit `enforceSchemaAtEmit`, degrade-to-`runEmitValidateRepair`,
  ONE-VALIDATOR re-validate floor). **Still open:** **CE-004** — the always-on conversation host (`claude-code`)
  advertises *no* API-level constraint mechanism, so on the primary path this reduces to the ONE-VALIDATOR repair
  floor (no emit-time prevention); and **CE-009** — semantically-wrong-but-schema-valid output (e.g. `total_lines`
  ≠ actual) is not schema-catchable. (Ethan, 2026-06-24.)

- **Tool-enforced dispatch broker with a capability-tiered driver — rolling dispatch the host can't get wrong.**
  Observed 2026-06-24 (Claude Desktop, a known capable host, not first contact): the host ran review packets in
  fixed waves with a barrier between them rather than rolling, and `max_concurrent_agents` sat at the cold-start
  floor of 3. Root cause is host-discretion-via-prose: the contract hands the host the *entire* packet plan plus a
  prose request to "maintain N concurrent, refill as each completes," with no structural gating — and `claude-code`
  is classified as a `hosted` provider that, reporting no active-subagent capacity, falls through to the hosted
  first-contact default instead of the agent-host concurrency. Desired end-state:
  (1) **A tool-enforced dispatch broker as the single chokepoint.** One gated primitive set — read quota, estimate
  per-task tokens (deterministic + local, per standing policy — never API token-counting), dispatch-an-auditor
  (refuses if it would exceed slots / rate / token budget), await-next-completion. No dispatcher can over-dispatch
  because the broker is the only door and it counts. This is the enforcement layer and it is independent of who
  drives.
  (2) **A capability-tiered driver, Y-primary.** Where the host supports agent nesting, the orchestrator dispatches
  a single thin *dispatcher agent* (Y) that runs the rolling loop through the broker tools and spawns auditors up to
  the gated limit — keeping the orchestrator's own context uncluttered. Y performs **no judgment**: it only picks the
  next task and refills slots; it reads quota via tools, never decides the limits. Spin Y only above a task-count
  threshold (below it the overhead isn't worth it). Where the host can't nest, the top host drives directly through
  the *same* broker, which releases the next slot only on a completion callback (slot-pull) — same enforcement,
  humbler driver. The broker is the constant; the driver tiers by host capability (everything-agnostic).
  (3) **Classify capable agent hosts off the cold-start floor.** A host that runs parallel subagents (Claude Desktop
  / `claude-code` / `vscode-task`) must get agent-host concurrency, never the hosted-API first-contact cap. The
  broker's cap comes from proper host classification + learned per-(provider, account, model) quota, not the hosted
  default constant.
  Enforcement (broker), driving (Y / slot-pull), and judgment (the repair + staleness seams) are separate layers:
  Y never judges; bounded judgment lives at its own named seams; and when a judgment call costs a dispatch it flows
  through the same broker like any auditor task. See the enforcement/driving/judgment separation principle in memory.
  The single-source classifier + broker primitive are **shipped** (`classifyProvider` returns ONE
  `{hostClass, concurrencyFloor, driverMechanism}` struct, floor constants off the public surface;
  `computeDispatchCapacity` never-over-dispatch caps; `HostSessionQuotaSource` channel-isolated recordLimit +
  bounded escalation). **Still open:** the capability-tiered *driver* (Y-dispatcher vs slot-pull selection beyond
  mechanism-gating) and proactive pre-wall quota-aware pacing, to wire onto the hardened classifier. (Ethan, 2026-06-24.)

- **Deterministic analyzers: own-vs-acquire — build the agnostic acquisition engine, don't expand a fixed bundle.**
  A fixed bundle of analyzers fails the everything-agnostic test (it privileges whatever ecosystems we bundled
  for). The ideal end-state is a mechanism that **acquires and runs the right ecosystem-native mature tool on the
  fly** — also cheaper to own than a pile of per-language integrations (generalizes the two-tier dependency policy:
  don't hand-roll a Ruby analyzer, shell out to the mature one). Concretely:
  (1) **Own only truly-agnostic extractors** — signals with no ecosystem tool: git-history mining (its own track,
  below) and text/git-based secret scanning.
  (2) **Acquire everything ecosystem-specific on demand** (eslint, rubocop, clippy, mutation testing, hadolint,
  actionlint, type-coverage, jscpd, osv-scanner, …): detect ecosystem deterministically → capability-probe the
  runner (`npx`/`pipx`/`cargo`/`bundle`/…) → run ephemerally → normalize through the existing adapter seam →
  degrade-to-empty when runtime/tool is absent. The build is the *engine*; each tool is a registry entry + one
  normalizing adapter.
  (3) **Selection/safety gate without a maintained allowlist** — enforcement is mechanical run-safety written once
  (capability-probe, pin versions, sandboxed/read-only, degrade-to-empty, report-skipped-never-silently); a small
  value-curated DEFAULT set (high-likelihood × high-leverage × low-overhead — eslint/semgrep/gitleaks/git-mining/…)
  runs without asking; the LLM proposes ecosystem-appropriate tools for the repo; anything beyond the defaults needs
  per-run user consent (ephemeral, nothing persisted). No exhaustive allowlist to curate.
  (Ethan, 2026-06-24.)

- **Git-history mining — ✅ SHIPPED (wired 0.30.34).** Mines `git log` (not the AST) for signals static analysis
  structurally cannot see. The extractor (`src/audit/extractors/gitHistory.ts`) + shared miner (`src/shared/git.ts`
  `mineGitHistory`) existed and were unit-tested, but were **never wired into an executor** — `runStructureExecutor`
  now mines git history end-to-end: co-change coupling lands in its OWN `graph_bundle.graphs.co_change` bucket
  (`GIT_CO_CHANGE_CATEGORY`, deliberately NOT `references` — `allGraphEdges` skips it so temporal coupling never
  feeds cycle/hub/seam detection), `git-history` is recorded in `analyzers_used` (and `buildEnrichedGraph` now unions
  rather than replaces provenance so enrichment can't drop it), churn/authorship risk signals merge via
  `mergeAnalyzerRiskSignals`, and the churn × complexity compound — `risk_concentration`, the real risk
  concentration — is derived by `deriveRiskConcentration` (informational; never touches `risk_score`). Persisted as
  the first-class `git_history.json` artifact. The design-assessment **hidden-coupling** finding
  (`detectHiddenCoupling`, v0.30.35) consumes the `co_change` bucket: co-change pairs (confidence ≥ 0.5, i.e.
  ≥ 3 shared commits) with NO structural import/call/reference edge surface as `hidden_coupling` architecture
  findings (strongest-first, capped at 10) — the temporal coupling static analysis cannot see. _Nothing open on
  this track._

- **Secret scanning — ✅ SHIPPED (0.30.36).** The second OWN extractor (text/regex+entropy — no ecosystem tool to
  acquire). Pure detector in `src/shared/secrets.ts` (`detectSecrets(path, content)` + `shannonEntropy`): a curated
  set of high-signal provider-token formats (AWS/GitHub/GitLab/Slack/Stripe/Google/npm keys, private-key blocks,
  JWT, basic-auth URLs) plus one entropy-gated heuristic tier (credential-named LHS × long high-entropy RHS,
  placeholder-filtered). Masks every matched span so the committed `secrets.json` artifact can never itself leak a
  credential; pure, deterministic (sorted), never throws. The audit extractor `src/audit/extractors/secrets.ts`
  (`scanSecretsArtifact`) walks in-scope, non-binary, ≤512KB files, scoped to the audited set; `secretRiskSignals`
  raises `hardcoded_secret` on owning units (lifts the security lens); `secretFindings` projects grouped
  security-lens `Finding`s. Wired into `runStructureExecutor` (persists `secrets.json`, merges risk signals) and
  surfaced at synthesis via `mergeFindings` (new `secretFindings` param threaded through `buildAuditReportModel`)
  so secrets appear in `audit-findings.json` regardless of whether a security task ran. Registered in
  `dependencyMap.ts` + `spec/audit/dependency-map.md` ({repo_manifest, file_disposition} upstream; report
  downstream). Tests: `tests/audit/secret-scanning.test.mjs`. _Nothing open on this track._

- **Remaining deterministic-analyzer work (DEFERRED).** The external analyzers landed as
  fixture-validated **adapters** (parse + normalize + degrade-to-empty behind the seam); actually
  **spawning** a live native engine and wiring its real output is the acquisition engine specced under
  Forward tracks (own-vs-acquire) — the adapters are ready for it. **dead-code** stays deferred: a sound signal needs
  the full file universe (pure orphans emit zero edges) + entrypoint provenance — knip/ts-prune
  territory, not a hand-rolled edge query (the shipped `deletion_candidate` low-in-degree signal covers
  the cheap version). The graph-query heuristics (cycles / hub / orphans / deletion-test) and
  extraction-persisted complexity / duplication / seams remain DONE (`deriveGraphSignals` pure reader).
- **Cross-provider quota — LIVE-endpoint confirmation.** The per-provider mappings are validated against
  live-*shaped* fixtures and the capacity fold; confirming each source against its **real** endpoint
  (Claude/Codex live; Copilot/Antigravity gated→degrade) is environment-bound and still a recorded-
  evidence task, not a code gate. Per-provider recipes: [`cross-provider-quota-matrix.md`](../spec/cross-provider-quota-matrix.md).
  Red line: self-monitoring own-provider only, never IDE-GUI automation.

## Deferred / waiting

- **A2 finding-quality oracle** — the `score-audit` scorer is built; it needs operator-authored
  `corpus/<run-id>.labels.json` (hand-labeled real audit runs) before it can score precision/recall/hallucination.
- **A7 multi-host validation** — `npm run verify:hosts` (automated, in `verify:release`) is built; remaining is
  the release-time manual GUI checklist run ([`host-validation.md`](../spec/host-validation.md)) + a gated Codex
  live-dispatch e2e.
- **Manual real-OpenCode validation** that agent-scoped permission allowances propagate to spawned subtasks
  (can't be unit-tested; user-owned). Folds into the A7 checklist.
- **Gated live e2es** skip without creds: `RUN_NIM_E2E=1`, `AUDIT_TOOLS_LIVE_QUOTA=1`, `RUN_CODEX_E2E=1`,
  `RUN_AUTONOMY_E2E=1`.
- **Provider `queryLimits`** deferred — an absent method and a `null` return are handled identically, so stubs
  change nothing; revisit if a provider gains a real proactive rate-limit endpoint.
- **headroom proxy** — enable + validate the `headroom proxy` (auto-compresses tool-output traffic) in one
  opt-in session before any global env flip; delete the vestigial `DO_NOT_TOKEN_WRAP_NOTE` in `prompts.ts` if
  proxy traffic doesn't need it.
- **Narrow staleness on prose-heavy artifacts via bounded semantic judgment, not per-field proof.** Prose-heavy
  fields (design_spec narrative, rationales) feed downstream LLM prompts, so a cosmetic edit currently re-fires
  staleness and forces wasteful re-emit even when the meaning is unchanged. The desired narrowing is NOT a
  hand-maintained per-field rule that a maintainer must prove and re-prove safe every time a prompt changes — that
  is brittle and incomplete by construction. Instead: a bounded judgment that decides whether the *meaning* relevant
  to downstream consumers actually changed, fail-safe in one direction only — **uncertain ⇒ treat as changed ⇒
  re-derive** — so a wrong call can only cost churn, never silently retain stale state. Efficiency-only; defer until
  re-emit churn on these fields is measured as a real cost.

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
- **`node --test` needs the tsx loader**: `node --import tsx/esm --test <file>` (bare `node --test` can't
  resolve `audit-tools/shared` via tsconfig `paths`). Same for `npm run test:single`.
- **Don't mask the test exit code.** `node --test … ; echo "exit=$?"` and `npm test > out; echo done` report
  the *trailing* command's exit, not the suite's — and piping through `grep`/`rm` in the same Bash call races
  the output file, so a real failure reads as "green." Capture the suite's own status: `npm test > out 2>&1 &&
  echo PASS || echo "FAIL=$?"`. (Mis-reading a masked exit shipped a release whose CI then failed.)
- **Global `-g` install defers `postinstall`** (npm allow-scripts) → the host-integration deploy silently
  skips; finish with `npm i -g --allow-scripts=audit-tools` or `node "$(npm root -g)/audit-tools/scripts/postinstall.mjs"`.
- **The Bash tool mangles Windows backslash paths** (`C:\a\b` → `C:ab`) → use forward slashes or the
  PowerShell tool for absolute-path commands.
- **PowerShell**: assign `foreach` output to a var before piping to `ConvertTo-Json`; `-Filter` is not regex
  (use `Where-Object -match`); single-element arrays unwrap in `ConvertTo-Json` (bracket-wrap the payload).
- **When you delete a *shipped* file, grep the smoke/verify scripts** for a `requiredPackagedPaths`-style list
  (the packaged-smoke gate asserts specific tarball files).
- **Async typecheck hook = stale-dist false alarm** after a shared-source edit (it runs `tsc` before the
  central rebuild); the authoritative gate is `npm run check` after `npm run build`.
- **`t.mock.module` is unusable** under the tsx/esm loader → use a dependency-injection seam instead.
