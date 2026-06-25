# Backlog — open work, durable traps & future directions

A living **to-do list**, not a status log. Remove an entry once it ships — record durable
contracts/rationale in project memory or `CLAUDE.md`, never "where the code is today."

---

## Open bugs / frictions — fix in tooling (never "host remembers")

- **Meta-audit friction capture almost never happens — it's opt-in prompt text at every layer (root cause VERIFIED).**
  The auditor is supposed to log all friction under the meta-audit rubric; in practice the run's friction record is
  an empty `[]`. Verified causes: (1) **worker mid-run** — `renderWorkerPrompt.ts:74` asks "Optional … you MAY append
  one JSON reflection line" to `agent-feedback.jsonl`; optional + a competing extra file write → dropped. (2) **audit-code
  close-out** — `friction_capture_executor` (`executorRunners.ts:177-190`) is a DETERMINISTIC executor that persists
  `frictions: []` (`nextStep.ts:140-146`) and immediately satisfies the obligation; its own doc-comment (`nextStep.ts:129`)
  says "the host **should be prompted** to optionally enrich the record" but NO host-delegation step ever fires — the
  auditor is never asked, and progress falsely reports "Friction close-out captured." (3) **remediate-code** does prompt at
  `present_report` (`steps/nextStep.ts:1539-1550`) but explicitly "optional / leave empty if none" — still relies on
  remembering. Net: the whole pipeline only works if a capable host volunteers friction, violating *enforce-robustness-in-
  tooling, never host discretion*. **Live meta-meta evidence:** this 2026-06-24 session hit major friction (destructive
  staleness-cascade wipe, malformed steward output forcing full re-dispatch, wave-not-rolling dispatch, working-dir `cd`
  drift, next-step backgrounding via pipes, mid-run session-limit) — NONE auto-landed in the friction record; all reached
  this backlog only because Ethan prompted three times.
  **Enforcement — CONFIRMED direction (Ethan, 2026-06-24): "auto-capture + mandatory triage" (the most robust; the
  three parts compose, do all three):**
  (a) **Auto-capture mechanical friction with zero agent memory** — the tool already *observes* it: task re-dispatches,
  contract-validation rejects (the steward), 429/session-limit stalls, merge retries, recovery events. Append THOSE to
  the run's friction record directly as they happen.
  (b) **Mandatory host-delegation triage step** — replace audit-code's silent deterministic close-out with a blocking
  host step that surfaces the auto-captured mechanical events + the run's `agent-feedback.jsonl` reflections and makes
  the host triage each (keep/discard/annotate) — same shape as the remediation review-gate (tool surfaces, host judges).
  (c) **Drop the "persist empty `[]` up front = satisfied" degrade-clean** so the obligation can't false-green.
  Apply to BOTH orchestrators (parity). Implementation not yet started. (Diagnosis root cause verified against source.)

- **Ingested results must be an append-only evidence ledger that nothing can destroy; concurrent next-step must not race the artifact tree.**
  Ingested audit results are expensive, non-deterministic LLM output — they are *evidence*, not a deterministically
  re-derivable artifact, so the only safe model is one where no code path can ever delete or truncate them. The
  desired end-state has three parts:
  (1) **Append-only results ledger, re-associated by content key.** Results are immutable; a re-plan never deletes
  or overwrites the run dir / results file. When planning changes, results are re-associated to the new task ids by
  deterministic content key (e.g. `unit_id`/`lens`/task-content), not by truncate-and-regenerate. Results whose task
  no longer exists are retained as unassigned, never dropped. Re-association stays deterministic (key match) — never
  LLM-guessed remapping; some results landing "unassigned-but-retained" is acceptable, silent loss is not.
  (2) **Process lock on the advance/persist critical section.** `next-step` / `merge-and-ingest` take the shared
  file lock around state-derive-and-persist so two concurrent runs cannot race the artifact tree. The host must not
  have to "remember" not to run two at once — the tool serializes it.
  (3) **Semantic-equivalence gate replaces brittle exact-hash staleness on `intent_checkpoint`.** A hand-maintained
  strip-list of "non-semantic fields" is incomplete by construction (a maintainer must remember to register every
  new field — the must-remember anti-pattern). Instead: cheap deterministic normalization first, then a bounded LLM
  judge on any residual mismatch decides whether the *auditable* intent (scope / lenses / constraints) actually
  changed before cascading a re-derive. The gate is **fail-safe one direction only — uncertain ⇒ treat as changed
  ⇒ re-derive** — so an LLM false-negative can only cost churn, never wrongly retain stale state. Bounded (one cheap
  call, only on the rare mismatch) and recorded.
  Parts (1)+(2) remove the data-loss class entirely; part (3) removes the brittle determinism that triggered it.
  (Ethan, 2026-06-24.)

- **Layered emit→validate→repair seam, single-sourced over every emitter.** Any agent emitting a structured
  contract (AuditResult[], findings, plans, ItemSpec, design-review findings, steward verification) can trip one
  schema error; today audit re-dispatches the whole task from scratch, and remediate's only repair is a
  heavyweight full-artifact re-emit limited to contract-pipeline artifacts. Replace both with ONE shared seam in
  `audit-tools/shared` that every emitter funnels through after writing, applied cheapest-first:
  (1) **deterministic coercion** of malformed *optional* sub-objects — drop/empty them and backfill tool-owned
  identity, **recording each drop as a warning** (never silent), re-validate;
  (2) **bounded errors-only LLM patch** for surviving *required*-field failures — feed back ONLY the validation
  errors + the worker's prior output (the failure delta, no re-derivation), capped (≈1 attempt), re-validate;
  (3) **re-dispatch** only as last resort once the patch budget is exhausted.
  Single-sourcing the seam gives audit a repair path it lacks, collapses remediate's bespoke full-regenerate
  repair into the shared mechanism (parity), and covers ItemSpec/structural emits that have none today.
  Re-dispatching a whole task on a fixable shape error is pure waste. Generalizes *enforce-robustness-in-tooling,
  never host discretion*. (Prevention — making malformed output impossible to emit in the first place — is a
  separate entry under Forward tracks; this seam is the recovery layer for whatever still slips through.)
  (Ethan, 2026-06-24.)

- **Rolling-dispatch same-file merge serialization starves throughput + can deadlock unique downstream nodes (VERIFIED, Consumers-phase run 2026-06-24).** When many bounded test-nodes append to the SAME file (e.g. all F1 nodes → `tests/audit/staleness.test.mjs`), three mechanics compound into a pathological tail: (1) `merge-implement-results`' lost-update guard blocks every same-file sibling but one *per merge batch*, so a wave of N same-file nodes lands exactly 1 and rejects N-1; (2) the rolling dispatcher orders eligible nodes **numerically**, so it offers same-file clusters together (all F1 before any F3), preventing the "one-per-distinct-file per wave" parallelism that would avoid the guard — the host is forced into ~1-node-per-merge cycles; (3) a node that legitimately needs **no source edit** (its boundary test already landed via a sibling) produces no diff → `verify_passed=false/merged=false` → it never reaches verified-complete → its downstream nodes are blocked forever by `INV-RS-01`, and *resolving the duplicate prereqs as `ignore` deadlocks the genuinely-unique downstream nodes* (had to implement those 5 directly on the branch out-of-band). Also observed: a worker that changed `broker()` to `async` to persist cooldown silently broke a sibling's synchronous `estimatedWaveTokens` test (cross-node API drift the per-node verify can't catch). All of this is squarely the **dispatch-broker + capability-tiered driver** track below — the fixes that subsume it: (a) the broker/driver should schedule by **file-ownership disjointness** (one writer per file in flight), not numeric order, so same-file nodes serialize *across* merges automatically while different-file nodes parallelize; (b) a no-source-change node whose obligation is already satisfied by a merged sibling must reach a **verified-complete "no-op satisfied"** disposition (not rejected-for-no-diff) so it never blocks downstream; (c) cross-node public-API changes (sync→async signatures on a shared seam) need a contract/boundary guard, since per-node isolated verify passes while the integrated tree breaks. Generalizes *enforce-robustness-in-tooling, never host discretion*. (Ethan, 2026-06-24.)

## Forward tracks

- **Remediator must mechanically decompose + boundary-enforce arbitrary multi-goal scope — stop forcing the host to phase by hand (Ethan, 2026-06-24, VERIFIED recurring).** When `/remediate-code` is pointed at a large multi-item input (e.g. the whole backlog), the contract pipeline produces a correct reconciled design but then expects the host to execute all tracks as ONE run; the independent design-critique repeatedly returns *blocking over-scoping* and the host has to manually re-scope to a phase. This keeps happening and shouldn't — it is the tool's core job, not the host's. The remediator must, by construction: (1) break an arbitrary number of goals/changes into well-defined, well-bounded tasks; (2) **strongly define the boundaries between tasks and write boundary tests that mechanically enforce them** (not prose `seam_adjustments` notes — review concern C-002: edit-order DAGs asserted in prose over shared files like `staleness.ts`/`dispatch.ts` are a host-discretion anti-pattern + latent merge-break); (3) separate the bounded tasks into **parallel work units with mechanical scheduling dependencies** (block A blocks-on block B) so the wave scheduler honors ordering without the host remembering; (4) derive phasing itself (foundations → consumers → review/slivers) from the dependency DAG rather than emitting one monolithic run the critique then rejects. Generalizes *enforce-robustness-in-tooling, never host discretion* and the *no monolithic change* / failure-isolation principles. Consumer modules (F1/F3/F4/F5/F6) shipped 0.30.5; the **foundations remain unshipped** — O1 friction-capture, O2 append-only-ledger+lock, O3 repair-seam (the first three Open-bugs entries above). The full module map, reconciled seams, and verified design invariants (CE-001…006, FC blocking concerns) are the canonical design doc [`backlog-remediation-design.md`](backlog-remediation-design.md).

- **Content-addressed, granular staleness — kill whole-artifact re-derive churn.** Staleness today is
  whole-artifact: changing one unit's intent re-stales an entire downstream artifact (e.g. the coverage
  matrix), which re-runs *all* of planning and re-touches *all* results, even for units that didn't change.
  Desired: staleness keyed at the granularity of the actual unit of work (per-unit / per-task, content-addressed
  by a stable content hash) so only the work whose inputs genuinely changed re-derives; unchanged work is skipped
  by construction, not re-run-then-deduped. This is the natural partner to the append-only results ledger
  (results keyed by content hash → an unchanged task keeps its result at zero recompute), but it stands alone as a
  general DAG-model change applying to every derived artifact, not just results. (Ethan, 2026-06-24.)

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
  enforcement capability per backend, never hardcode it. (Ethan, 2026-06-24.)

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
  (Ethan, 2026-06-24.)

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

- **Git-history mining as an owned, language-agnostic extraction source.** Mine `git log` (not the AST) for
  signals static analysis structurally cannot see: co-change coupling (files that change together = hidden coupling
  the dependency graph misses), churn × complexity hotspots (the real risk concentration), and author concentration
  / bus-factor. Language-agnostic by nature, purely mechanical, feeds architecture (coupling), maintainability
  (churn) and the risk register at once. A distinct extraction source (a new input, not just another analyzer behind
  the adapter seam) — hence its own track. (Ethan, 2026-06-24.)

_The 2026-06-22 forward-track batch shipped 2026-06-23 in `backlog-actionable-2026-06-23`:
autonomous audit→remediate→PR capstone (unattended mode + fail-closed non-destructiveness
allowlist gate), the external deterministic analyzers behind the adapter seam (ast-grep /
semgrep-dataflow / CodeQL-SARIF, degrade-to-empty), cross-provider quota real-shape
validation, mandatory independent-critic dispatch, and tool-emitted friction-capture
close-out in both orchestrators. Durable design captured in memory + CLAUDE.md._

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
  evidence task, not a code gate. Per-provider recipes: [`cross-provider-quota-matrix.md`](cross-provider-quota-matrix.md).
  Red line: self-monitoring own-provider only, never IDE-GUI automation.

## Deferred / waiting

- **A2 finding-quality oracle** — the `score-audit` scorer is built; it needs operator-authored
  `corpus/<run-id>.labels.json` (hand-labeled real audit runs) before it can score precision/recall/hallucination.
- **A7 multi-host validation** — `npm run verify:hosts` (automated, in `verify:release`) is built; remaining is
  the release-time manual GUI checklist run ([`host-validation.md`](host-validation.md)) + a gated Codex
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
