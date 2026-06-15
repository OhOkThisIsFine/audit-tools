# Handoff — make the audit/remediate workflow auditor-agnostic

> **Audience:** the next agent instantiation (no memory of the session that produced this).
> **Status:** the 452-finding self-audit remediation is DONE in-tree and green but **NOT
> committed/published** (held for review). The work described below — making the workflow
> robust for *any-strength auditor* — is the agreed next focus. This is the sanctioned single
> handoff doc (CLAUDE.md allows one for immediate next steps); delete or replace it once the
> work lands.

---

## 0. TL;DR

1. A 452-finding self-audit (run on auditor-lambda **0.21.2**, pre-fix) was remediated via the
   full contract pipeline. **17/17 blocks resolved, suite green (~4026 tests), build+check
   clean, nothing committed.** See §1.
2. Ethan gave a governing correction: **workflow correctness must be enforced by the tooling
   for any-strength auditor — never by host discretion.** Now a CLAUDE.md invariant. See §2.
3. Re-evaluated all observed friction through that lens. The dangerous failures are the
   **silent / fail-open** ones (green-but-wrong without a capable host). See §3.
4. Two decisions are pending from Ethan (ship the remediation? how to drive the robustness
   work?). See §5.

---

## 1. Where things stand — the completed remediation

`/remediate-code` ran against `.audit-tools/audit-findings.json` plus three memory-noted
workstreams. It went through the entire contract pipeline:

`synthesize_intake → confirm_intent → goal_normalization → context_collection →
module_decomposition (15 modules) → per-module seam contracts (5 parallel drafter agents) →
seam_reconciliation → contract_finalization → conceptual critique → obligation_ledger (186
obligations) → test_validator_plan → contract_assessment → adversarial critic → judge → 2
repair loops (counterexamples 15 → 3 → 1; repair cap is 2, so the last counterexample CE-P3-001
was carried as a residual covered by a node) → implementation_dag (17 nodes) → 6 dispatch
waves of subagents (merge per wave) → final clean-env green node → present_report.`

**Outcome:** 17/17 blocks `resolved`, 0 blocked. Suite green with `CLAUDECODE` unset — shared
550/0 (1 skip), audit-code 2121/0 (1 skip), remediate-code 1353/0. `build` + `check` zero
errors. `closing_action: none` (nothing committed). Artifacts:
`.audit-tools/remediation-report.md` and `.audit-tools/remediation-outcomes.json`.

**Ethan's three "still real?" flags were all NOT real in current source** → `resolved_no_change`
with evidence (the audit ran on 0.21.2; remediate-code was 0.18.1):
- **ARC-1fa005bb / -2** dependency cycle — false. `madge --circular` = 0 cycles;
  `io/toolingManifest.ts` imports only node builtins. An import-direction guard test was added.
- **COR-3410f5f6** — false. `deps` ARE `CP-BLOCK-` prefixed (`steps/contractPipeline.ts` ~1239);
  lookup is consistent.
- **DAT-d78de464** — no drift. Schema const == shared `CONTRACT_PIPELINE_VERIFICATION_REPORT_VERSION`.

**Real fixes that landed** (do not redo): contract_version mismatch → error not warning
(OBL-C002, `shared/src/validation/findingsReport.ts`); staleness collapsed to one canonical
`ARTIFACT_DEPENDS_ON_MAP` (`audit-code/src/orchestrator/dependencyMap.ts`; `ARTIFACT_DEPENDENTS_MAP`
derived via `invertDependencyMap`; `buildArtifactDependenciesMap` deleted); no-progress guard;
canonical narrative serialization (CE-005); schema_version guards (ARC-dd468422); top-level-await
guard (REL-c93bcf34); **workstream A** (shared `runTracked` strips `CLAUDECODE`/`CLAUDE_CODE_*`;
audit `runtimeValidationEnv` deleted); **workstream C** (real rolling-dispatch engine +
transient-429 re-queue + reroute no-stranding, atomic-replace of barrier-wave —
`shared/src/quota/rollingEngine.ts`, `shared/src/dispatch/rollingDispatch.ts`);
mergeImplementResults no-throw + single-commit (COR-7d68ea6a/f378135d); goal_id cross-check +
DAG referential/coverage integrity (ARC-86b18f1b/-2); single state-writer — deleted legacy
`remediate-code/src/phases/implement.ts`/`runImplementPhase` (CE-P3-001/CE-015); dedup category
gate (OBL-C003); split the 2838-line `remediate-code/tests/next-step.test.ts` into 6; PARITY-2/2b
de-vacuified. **Workstream B** (renderWorkerPrompt inline-vs-write) was already satisfied by
0.21.3 (`resolved_no_change`).

**Coverage caveat:** the run tracked **17 DAG nodes, not 452 per-finding dispositions** — the
findings were folded into module blocks at decomposition. There is no per-finding ledger.

---

## 2. The governing principle (Ethan's correction)

I initially dismissed several issues as "pure habit fix on my side / no tooling change needed."
**That framing is wrong.** Ethan: *"You are not going to be the only auditor. This is not a
'habit fix' — this is an explicitly-enforce-workflow fix… permanent and robust fixes that make
the process clearer, simpler, and with fewer failure modes, for any strength of auditor."*

Now encoded as the **lead CLAUDE.md invariant** ("Auditor-agnostic robustness — enforce in
tooling, never host discretion") and memory `enforce-robustness-in-tooling-not-host-discretion`.

The rule: **the host/auditor agent is a variable of any strength, not a constant.** Every
correctness property must be guaranteed by the tool (CLI option shape, contract validator,
renderer template, dispatch-prompt text, scheduler, merge tolerance, write-scope enforcement) —
never by the host *remembering*, *noticing*, or *reasoning*. The test to apply to any fix:
**"would this still be correct if a weaker host ran it?"** If it only works because a capable
host intervened, the fix belongs in the tool. "Be careful" / "habit fix" is never a fix; prefer
changes that make the process *simpler*, not ones that add a step the host must remember.

**Sharpest framing:** loud failures *fail closed* (any host sees the error and stops). The
dangerous ones *fail open into green-but-wrong*. The real invariant is **"green must imply
correct without host intervention."**

---

## 3. The re-evaluation — every friction item as an enforced fix

The detailed enforced-fix list is in `docs/backlog.md` → *"Auditor-agnostic robustness —
enforce-in-tooling fixes (2026-06-14)"* plus the three Known-friction bullets just above it.
Summarized here, grouped by danger.

### 3a. FAIL-OPEN (silent → green-but-wrong) — highest priority

These produced a *correct* result this run **only because a capable host intervened**. A weaker
host yields green-but-wrong.

- **Upstream evidence not auto-threaded.** The still-real verification node produced the
  import-graph / COR-3410f5f6 / version verdicts; *the host manually relayed them* into the
  dependent workers' dispatch prompts. Without that, a weak host dispositions ARC-1fa005bb as
  `resolved_no_change` with no import-graph proof. **Enforce:** a node's result is automatically
  threaded into the dispatch prompts of nodes that depend on it (the DAG already has the
  verification/dependency edges — the dispatcher must ingest the upstream result, not the host).
- **Write-scope trusted, not enforced.** Two audit-code workers edited `shared` out of scope
  (for `stripClaudeCodeEnv`); it converged green *this time*. **Enforce:** `merge-implement-results`
  validates each worker's actual file edits against its declared write-scope and rejects
  out-of-scope writes (relates to ARC-f378135d; an `OwnershipRegistry` exists but only routes
  self-reported `amended_files`).
- **Cross-block break propagation.** An OBL-C002 behavior change red-lit a sibling seam test
  (SEAM-8c in audit-code) in a different block; only because the host noticed did the tree stay
  honest. **Enforce:** paired positive+negative obligations (already a backlog commitment) +ile a
  a cross-block reconciliation pass so a behavior change derives the dependent expectations to
  update — no host mop-up.

### 3b. FAIL-CLOSED (loud errors) — important but self-revealing

- **`finding_id` / result-shape errors.** Workers emit the `FND-*`/`OBL-*` obligation id (and one
  `item_result` per obligation) instead of the `N-*` node id → `merge-implement-results` throws.
  Hit this run (shared-quota emitted `OBL-WS-C` + 17 entries; result file was patched by hand).
  **Enforce:** (1) renderer emits the exact node id + a "one item_result per node" rule into the
  template; (2) **make merge tolerant** — map an unknown `finding_id` that IS a known obligation
  id back to its owning node and collapse multi-entry; (3) write-time schema validation a worker
  runs before emitting. Lives in `remediate-code/src/steps/dispatch.ts`
  (`prepareImplementDispatch` renders, `mergeImplementResults` ingests).
- **`--host-can-dispatch-subagents` documented as boolean but defined with `<value>`.** Passing
  it bare swallows the next flag. **Enforce:** define it as a true boolean commander option (or
  fix the loader docs). Better long-term: auto-detect host capability so these flags aren't
  hand-passed at all (cf. "Conversation-first / a needed manual flag is a bug signal").

### 3c. Efficiency / clarity (still tool fixes, lower risk)

- **`conversation-start.md` not registered as an intake source.** When `/remediate-code` gets
  conversational/memory guidance alongside `--input`, `synthesize_intake`'s source-manifest
  lists only the `--input` doc; the host had to fold the guidance in by hand. **Enforce:** intake
  discovers `intake/conversation-start.md` (and any `intake/*.md`) and adds it as a supplementary
  `conversation` source (`remediate-code/src/intake.ts`).
- **Two-step bootstrap** (write `conversation-start.md`, then call `next-step`). **Enforce:** a
  single entry op (`next-step --guidance-file`, or one loader command).
- **Ad-hoc findings digest (overflow-prone).** Reading scope from the 742 KB findings JSON was
  hand-rolled PowerShell. **Enforce:** intake emits a **bounded findings-digest artifact**
  (counts; by severity/lens/package; top findings; work-block map) the step prompt points to.
  (NB: this is also a roundtrip/efficiency win.)
- **Worker verify commands declared, not improvised.** Build-race safety — never two
  `npm run build` on one package; verify via `npm run check` + package `npm test` (tsx/vitest do
  not emit `dist`, so they don't race); rebuild `shared` between dependency levels — was host
  reasoning. **Enforce:** the dispatch plan/worker prompt states the exact verify commands per
  node; the scheduler owns `shared` rebuilds between levels.
- **Rolling per-node dispatch + scheduler-owned concurrency.** The host hand-grouped/paced 6
  waves. **Enforce:** backend dispatch-when-verified-complete with a quota-driven concurrency
  pool + incremental merge (already in backlog → *Design commitments not yet built → Rolling
  per-node dispatch*). The engine exists (`shared/src/quota/rollingEngine.ts`, hardened this run);
  remediate-code's node dispatch (`steps/dispatch.ts`, `waveScheduler.ts`, `nextStep.ts`) still
  builds one wave per `next-step` gated on item *status*, not verified-complete.
- **Repair loop re-ran all four adversarial phases.** **Enforce:** re-run only phases downstream
  of the repaired artifact.
- **Mid-edit typecheck-hook false alarms.** The async PostToolUse hook (`.claude/hooks/`) fired
  3× on transient mid-edit states during concurrent waves; the authoritative `npm run check` was
  green every time. **Enforce:** debounce / scope to the final edit, and define the final-green
  node as the authoritative gate, so a weaker host isn't derailed.
- **Model tier flat.** `model_hint.tier` was "standard" for every node; the host hand-upgraded 4
  architecture-heavy nodes to opus. **Enforce:** the planner sets tier by node complexity.
- **Per-finding coverage ledger.** Tracked 17 blocks, not 452 findings. **Enforce:** a per-finding
  ledger so every source finding has an auditable terminal disposition (closes CE-007 /
  OBL-GOAL-COVERAGE).
- **Generator↔fixture drift.** `remediate-code/scripts/generate-auditor-contract-fixture.mjs`
  hardcoded a stale `contract_version` that would re-break the suite on regeneration. It now
  imports `AUDIT_FINDINGS_CONTRACT_VERSION` (fixed this run). **Enforce:** add a test asserting
  regenerated output == committed fixture so the generator can never silently drift again.

---

## 4. Prioritized plan

1. **Fail-open killers first** (§3a): auto-thread upstream evidence into dependent dispatch
   prompts; enforce write-scope at merge; cross-block reconciliation (+ paired obligations).
2. **Rolling per-node dispatch + scheduler-owned concurrency/verify-commands** (the big
   architectural one; subsumes the build-race and wave-pacing fixes).
3. **Fail-closed cleanups** (§3b/§3c): tolerant merge + write-time validation; single bootstrap;
   bounded findings-digest artifact; conversation-start auto-registration;
   `--host-can-dispatch-subagents` boolean; planner-set model tiers; repair-loop scoping;
   hook debounce; per-finding ledger; generator↔fixture drift test.

Note: several of these (rolling dispatch, write-scope, parallel module contracts, evidence
threading) are the same gaps already in `docs/backlog.md → Design commitments not yet built`.

---

## 5. Open decisions for Ethan (ask before acting)

1. **The completed remediation is uncommitted.** Ship it now via the `/ship` skill (verify green
   → commit → push → merge → publish → reinstall global bins), or hold while the robustness work
   is folded in? Per memory, the prior self-audit remediation was also held per Ethan.
2. **How to drive the robustness work** — as its own audit→remediate pass (dogfood the very gaps),
   or implement the §3a fail-open killers directly first?

---

## 6. Key code locations (entry points)

- **Loaders / CLI options:** the `/remediate-code` + `/audit-code` skill loaders (host-integration
  assets); commander option defs for `next-step` (where `--host-can-dispatch-subagents` etc. live).
- **Intake / source manifest / findings digest:** `remediate-code/src/intake.ts` (the
  `synthesize_intake` step + source manifest).
- **Dispatch renderer + merge (finding_id, write-scope, evidence threading):**
  `remediate-code/src/steps/dispatch.ts` (`prepareImplementDispatch`, `mergeImplementResults`,
  `OwnershipRegistry`); node dispatch sequencing in `steps/nextStep.ts`,
  `steps/waveScheduler.ts`, `steps/contractPipeline.ts`.
- **Rolling engine (exists, hardened):** `shared/src/quota/rollingEngine.ts`,
  `shared/src/dispatch/rollingDispatch.ts`.
- **Obligation/test-spec derivation (paired obligations, model tier):** the contract-pipeline
  phases in `remediate-code/src/steps/contractPipeline.ts` + validation in
  `remediate-code/src/validation/contractPipeline.ts` / `contractPipelineGates.ts`.
- **Hook:** `.claude/hooks/` (async PostToolUse typecheck; PreToolUse commit gate).
- **Fixture generator + guard:** `remediate-code/scripts/generate-auditor-contract-fixture.mjs`
  (+ a new test in `remediate-code/tests/`).

---

## 7. Operational notes & traps for the next instance

- **Build order:** `npm run build -w @audit-tools/shared` first, then `npm run build`, then
  `npm run check`. Green-at-every-commit is hook-enforced.
- **Always run tests with `CLAUDECODE` unset** (PowerShell: `$env:CLAUDECODE=$null; npm test …`).
  A Claude session sets `CLAUDECODE=1`, which hard-fails a provider test and poisons runtime
  grading — this was the root of the whole audit's `not_confirmed` noise.
- **Concurrency safety (until the scheduler owns it):** never run two `npm run build` on the same
  package concurrently (corrupts `dist`). Workers should verify via `npm run check` + package
  `npm test` (tsx/vitest don't emit `dist`). Rebuild `shared` between dependency levels.
- **The async typecheck Stop-hook lies during concurrent edits** — it snapshots mid-edit states.
  Trust the authoritative `npm run check`, not the hook feedback (verify from disk).
- **Capability handshake (current shape, until auto-detected):**
  `remediate-code next-step --input <path> --host-can-dispatch-subagents true --host-max-concurrent 4 --host-models '<json-roster>'`
  (single-quote the JSON in PowerShell; the boolean flag needs an explicit `true`).
- **Backend commands (`next-step`, `merge-implement-results`) must run un-wrapped** (no
  token-compression wrapper — their JSON output is parsed verbatim).
- **Parse `next-step` output** by slicing first `{` to last `}` — a `[remediate-code] …` log line
  precedes the JSON.
- **Delegate adversarial phases to independent subagents** (critic, judge, counterexample) — not
  the author marking its own homework (memory `delegate-adversarial-phases-to-separate-agent`).
- **Resume:** the remediation state machine is resumable; `remediate-code next-step` derives the
  current step. The run is at `present_report`/`complete` — do not re-run it; the deliverables are
  on disk.

---

## 8. References

- **Artifacts:** `.audit-tools/remediation-report.md`, `.audit-tools/remediation-outcomes.json`,
  `.audit-tools/audit-findings.json` (the 452-finding source), `.audit-tools/remediation/` (full
  contract-pipeline artifacts: intake/, intake/contract/, runs/).
- **CLAUDE.md:** the new lead invariant (Conventions & invariants), plus existing
  "Conversation-first", "A needed manual flag is a bug signal", "Atomic-replace ordering",
  "Green-at-every-commit", split design-assessment modes.
- **docs/backlog.md:** *Auditor-agnostic robustness — enforce-in-tooling fixes (2026-06-14)* +
  three new Known-friction bullets; *Design commitments not yet built* (rolling dispatch, parallel
  module contracts, provider Gate-0, paired obligations).
- **Memory:** `self-audit-452-remediation-2026-06-14`,
  `enforce-robustness-in-tooling-not-host-discretion`, `delegate-adversarial-phases-to-separate-agent`,
  `remediate-code-host-dispatch-end-to-end`, `audit-tools-release-publish-flow`,
  `audit-code-0.21.3-process-fixes`, `in-tree-wip-is-own-compacted-work`.
