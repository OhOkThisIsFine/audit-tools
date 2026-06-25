# Backlog — open work, durable traps & future directions

A living **to-do list**, not a status log. Remove an entry once it ships — record durable
contracts/rationale in project memory or `CLAUDE.md`, never "where the code is today."

---

## Open bugs / frictions — fix in tooling (never "host remembers")

- **Friction DETECTION is mechanical-only — no LLM judgement reviews the run, so semantic/process friction goes uncaptured (VERIFIED, this 2026-06-25 session).** The O1 fix added auto-capture + mandatory triage, but capture is fed by exactly two instrumented call sites (`intentCheckpointGate.ts` semantic-gate, `emitValidateRepair.ts` repair seam) plus the opt-in `agent-feedback.jsonl` worker channel. `decideFrictionTriage` (`src/shared/friction/triage.ts`) only *dispositions* that pre-populated set and **`EMPTY SET → trivially disposed`**. Nothing applies LLM judgement over the conversation/run history to *find* friction. Proof: the rolling-dispatch run was friction-heavy (≈3 silent re-emit rounds fighting the CE-006 anchor-token gate; the merged-main integration-guard trap — unregistered `INV-SOO`, either-or `.toContain` — needing two post-merge fixes; the stale-handoff detour) yet the friction record came up **empty** because neither instrumented source fired. Mechanical capture is incomplete by construction (only catches pre-instrumented events). This is exactly *Right tool, not deterministic dogma* rule (2): friction detection is semantic → wants bounded, recorded LLM judgement. **Tension:** the CLI backend has no transcript (it lives in the host), and host-volunteering is the forbidden *host-remembers* anti-pattern — so the fix must be tool-ENFORCED, not opt-in. **Direction:** (1) drop `empty set → trivially disposed` (a friction-heavy run must not self-certify friction-free); (2) make the close-out a tool-enforced host-delegation step (same shape as the review-gate) that MANDATES a structured friction-review artifact, non-skippable, requiring ≥N considered entries. The named dimensions (gate re-loops, integration-guard failures, re-scopes, surprises, manual out-of-band interventions) are PROMPTS/SEEDS, not an exhaustive schema — the artifact MUST also carry a free-form/open-ended channel for friction that fits no named dimension (most real friction is unanticipated; a fixed taxonomy would silently drop it, recreating the empty-record failure in a subtler form). So: named dimensions to jog the review + an always-present open-ended capture, both feeding one record. (3) mechanical events seed/prior that pass rather than being the whole input. Apply to BOTH orchestrators (parity). Generalizes *enforce-robustness-in-tooling, never host discretion*. (Ethan, 2026-06-25.)
- **Selective-deepening tasks never converge — packet result task_id ≠ assigned `deepening:*` id.** Repro
  (run `20260622T023504252Z_audit_tasks_completed_001`): after the base pass, `deepening:finding:*` /
  `deepening:steward:*` tasks are created and counted pending, but the dispatch packager re-emits *base-unit*
  packets whose worker results carry packet-style task_ids (e.g. `flow:...:reliability:packet-3-…`) that don't
  match the assigned `deepening:finding:e0e34e19f3`. merge-and-ingest reports "Missing audit result for
  assigned task", spawns *more* deepening tasks, and loops forever — never reaching synthesis. Two sub-bugs:
  (1) packager dispatches wrong task_ids for deepening follow-ups; (2) workers omit `findings[].lens` (validator
  requires it) — only the top-level `AuditResult.lens` is set, so every deepening result is rejected until the
  per-finding lens is backfilled. Fix in tooling: deepening packet prompts must bind the worker output to the
  exact assigned `deepening:*` task_id, and the renderer/validator must force `findings[].lens` (default from the
  AuditResult lens). Until fixed, recovery = quarantine the orphan pending `deepening:*` tasks to let synthesis
  run (loses only second-pass verification of already-recorded findings). (Ethan, 2026-06-22.)
- **Dispatch is not aware of the host's own session/usage quota — hits the wall instead of adapting.** This run
  hit the Claude Code host session limit twice mid-dispatch (`You've hit your session limit · resets 10:30pm`,
  then `1:30pm`). Each time the in-flight workers returned a limit message instead of results (0 tokens, wasted
  dispatch), and the *only* adaptation was the operator (me) noticing the reset time and manually re-firing after
  it cleared. That is a tool defect, not an environmental fact: the auditor/remediator advertise quota-awareness
  (learned RPM/TPM, sliding window, 429/524 parsing, cross-provider `QuotaSource`), and the host session is the
  host provider's *own* quota — squarely inside the self-monitoring red line (own-provider-only; never IDE GUI
  automation). Expected behavior: (1) track the host session/usage budget (fixed-window reset, not just
  per-minute RPM/TPM) as a first-class `QuotaSource`; (2) pace/throttle concurrency *before* the wall and, when a
  worker returns a session-limit message, parse the reset timestamp, automatically pause, and resume at reset —
  no operator in the loop; (3) treat a limit-message worker result as a re-queue, not a consumed packet. The
  current `merge-and-ingest` "re-derive remaining from disk" path is reactive recovery, not the quota-aware
  adaptation the design promises. Extends the cross-provider quota matrix / quota-dispatch vision to the host's
  own session budget. (Ethan, 2026-06-22.)
- **Final-report promotion path mismatch — ENOENT on synthesis.** At synthesis the orchestrator logs
  `completed audit but could not promote final report to ...\.audit-tools\audit-report.md: ENOENT ... lstat
  '...\.audit-tools\audit\audit-report.md'`. Synthesis writes the promoted deliverables directly to
  `.audit-tools/audit-report.md` + `.audit-tools/audit-findings.json` (the documented final location), but the
  promote step — and the `present_report` step prompt — look for the source at `.audit-tools/audit/audit-report.md`,
  which is never written there. Harmless this run (deliverables exist at the right place) but the warning is noise
  and the `present_report` prompt points the host at a nonexistent path. Fix: single-source the promote source/dest
  and the prompt's report path off one path module. (Ethan, 2026-06-22.)
- **Fallback race in `merge-and-ingest` — wrong inline-result wins when multiple files claim the same `task_id`.** `scanTaskResults` scans all JSON files in `task-results/` not in `expectedPaths` and uses first-match-wins (`!fallbackByTaskId.has(tid)`). Files are sorted alphabetically, so a packet that INCIDENTALLY contains a result for a task_id (because the agent reviewed more files than assigned) beats the canonical packet file when it sorts earlier. Repro (2026-06-23): `flow-flow-surface-src-audit-cli-advanceAuditCommand-ts_...inline-result.json` claimed `src-audit:tests:part-11` with 12 files (no `stewardFollowup.ts`); the canonical `src-audit_tests_packet-1-b37a9a2fd9_...inline-result.json` had 13. Alphabetical 'f' < 's' → bad result won → "Missing stewardFollowup.ts" error on every retry. Fix: prefer the entry whose `packet_id` matches the dispatch-result-map entry for that task, or use the packet-result file as primary and inline-only as last resort. Workaround used: write the individual task file (`write_paths` path) directly so merge-and-ingest reads it as a first-class entry, bypassing the fallback scan. (Ethan, 2026-06-23.)
- **Subagent spawning nested background sub-tasks instead of writing inline results.** When the host dispatches a packet agent that internally forks work (e.g. splits 12-file review into 12 parallel sub-agents via TaskCreate/background spawn), the host receives TaskNotification pings but no inline-result.json. Recovery requires collecting all notification outputs, continuating the agent via SendMessage, waiting for it to consolidate and write its result — a manual multi-step process that defeats the "agent writes result, host continues" contract. Fix: packet prompt should state explicitly that the agent must write one `AuditResult[]` JSON file to the assigned `result_path` and NOT spawn further background tasks. Consider adding a contract-level check: if the result file is absent after the agent completes and no inline text JSON was emitted, treat as a re-queue. (Ethan, 2026-06-23.)
- **Gitignore generated skills + host assets (always-ignore).** `audit-code ensure` / install-hosts emit
  generated skill files (generated audit-code & remediate-code skills, host renderer outputs, etc.) into the
  working tree; these are build/install artifacts, not source — always add them to `.gitignore` so they don't
  show up as tracked/dirty state. (Ethan, 2026-06-22.)
- **Conditionally gitignore the canonical audit/remediation deliverables + meta-audit reflections — by repo
  visibility.** The process-conclusion documents — `audit-report.md`, `audit-findings.json`,
  `remediation-report.md`, `remediation-outcomes.json`, and the **meta-audit reflections** file — are NOT
  build artifacts; whether they belong in VCS depends on the repo's visibility:
  - **Private repo → do NOT gitignore** (keep them tracked; they're a useful in-repo record).
  - **Public repo → gitignore by default** (don't publish internal audit findings/reflections unless opted in).
  Detect visibility at install/ensure time (e.g. `gh repo view --json isPrivate`, fall back to a config flag /
  prompt when `gh` or remote is absent) and write the `.gitignore` rule accordingly — never hardcode either way,
  and make it overridable. This is distinct from the always-ignore build artifacts above. (Ethan, 2026-06-22.)

## Forward tracks

- **Remediator must mechanically decompose + boundary-enforce arbitrary multi-goal scope — stop forcing the host to phase by hand (Ethan, 2026-06-24, VERIFIED recurring).** When `/remediate-code` is pointed at a large multi-item input (e.g. the whole backlog), the contract pipeline produces a correct reconciled design but then expects the host to execute all tracks as ONE run; the independent design-critique repeatedly returns *blocking over-scoping* and the host has to manually re-scope to a phase. This keeps happening and shouldn't — it is the tool's core job, not the host's. The remediator must, by construction: (1) break an arbitrary number of goals/changes into well-defined, well-bounded tasks; (2) **strongly define the boundaries between tasks and write boundary tests that mechanically enforce them** (not prose `seam_adjustments` notes — review concern C-002: edit-order DAGs asserted in prose over shared files like `staleness.ts`/`dispatch.ts` are a host-discretion anti-pattern + latent merge-break); (3) separate the bounded tasks into **parallel work units with mechanical scheduling dependencies** (block A blocks-on block B) so the wave scheduler honors ordering without the host remembering; (4) derive phasing itself (foundations → consumers → review/slivers) from the dependency DAG rather than emitting one monolithic run the critique then rejects. Generalizes *enforce-robustness-in-tooling, never host discretion* and the *no monolithic change* / failure-isolation principles. Consumer modules (F1/F3/F4/F5/F6) shipped 0.30.5; the **foundations O1/O2/O3 are also shipped** (merged `cd089066`, content-key seam + append-only idempotent ledger + friction triage + repair seam, with tests — verified 2026-06-25, see `.audit-tools/phase-status-investigation.md`); the prior "foundations remain unshipped" claim was stale handoff drift. The rolling-dispatch same-file merge-serialization fix (a)+(c) shipped 2026-06-25 (file-ownership-disjoint scheduling + cross-node seam-signature guard; (b) no-op-satisfied was already shipped). This forward track (mechanical multi-goal decomposition + boundary-enforce) itself **remains unshipped** — the host still hand-scopes large inputs to one phase. The full module map, reconciled seams, and verified design invariants (CE-001…006, FC blocking concerns) are the canonical design doc [`backlog-remediation-design.md`](backlog-remediation-design.md).

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

- **Remediate-code worktree branches strand commits off main.** Remediate runs on isolated git worktree branches; those branches are never auto-merged. Any doc or code fix applied inside a remediate run lives on a branch like `remediate-CP-BLOCK-IMPL-*` and never reaches main unless explicitly cherry-picked or merged. Effect: the doc-review nightly routine (which reviews main) keeps re-surfacing the same findings indefinitely. Symptom: same doc-review items reappear every run, including items you believe were already fixed. Fix: after a remediate run that touches docs or code you want on main, merge or cherry-pick the relevant commits before the next nightly run.

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
