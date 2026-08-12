# Codebase simplification review — 2026-08-04

Whole-tree quality review (`/simplify`, scope widened to the entire codebase by the owner):
four parallel review agents, one per angle — reuse, simplification, efficiency, altitude —
over `src/audit` (272 files / ~53k lines), `src/remediate` (74 / ~33k), `src/shared`
(173 / ~37k). Quality only; correctness bugs were out of scope. Findings below were
agent-reported and the top tier re-verified against HEAD (`c4b953df`, v0.35.0) by the
coordinating session; per-finding verification status is marked.

**Outcome (2026-08-04, all tiers + deferred worked):** applied in three commits —
`0796a359` (Tier 1+3), `0dbd3e61` (Tier 2 + gemini sunset), and the descriptor
consolidation. Per-item dispositions:
- **Applied:** items 1, 2, 5 (Tier 1); 6, 7, 9-command-validation, 9-asset-mappers
  (Tier 2, shapes per design-check); 10–14 (Tier 3); the OrchestratorDescriptor
  consolidation including the hostLimits twins (item 3); the full 2026-07-18 gemini
  sunset (grew out of item 7's map widening).
- **Declined after verification:** item 4 (staleness boundary recompute — the comment at
  advance.ts documents recompute-from-returned-bundle as the deliberate emit-consistency
  guarantee); item 8's validation-predicate half (design-check found the "transport
  inference" is the deliberate retired-field refusal + H3 claude-worker guard — false
  positive); item 9's ensureGlobalAssets half (already table-driven; the two non-table
  blocks are genuinely different operations); friction back-compat fields (optionality is
  load-bearing for persisted records in audited repos; removal = schema-version bump,
  disproportionate); OpenCode renderer interface (primitives already single-sourced in
  shared; one consumer — speculative abstraction); acceptNode param consolidation (each
  optional is a deliberate, documented test-injection seam with type-enforced production
  behavior).
- **Item 8's classification-registry half narrowed to nothing:** the worker Sets ARE the
  H3 single-source classifier; a registry would re-fragment it.
- **New defect found en route:** a dedup survivor can belong to multiple blocks
  (first-wins now pinned in `blockIdsByFinding`; root question in open-bugs).

## Tier 1 — verified, high payoff, low risk

1. **Triple `resolveManifestSources` + duplicate audit-source read** —
   [nextStep.ts:3309](../../src/remediate/steps/nextStep.ts) (also 3353, 3504; reads at
   3314/3359). VERIFIED. The same manifest resolution runs three times and the same
   audit-findings file is read+parsed twice inside the ready-intake pipeline step.
   Fix: resolve once at the top of the function, cache the parsed audit source alongside.

2. **O(M×N) block lookup beside an existing O(1) helper** —
   [nextStep.ts:1657](../../src/remediate/steps/nextStep.ts) (`saveStateForPlan`; also
   ~2813). VERIFIED. `plan.blocks.find(b => b.items.includes(finding.id))` per finding,
   while `blockIdsByFinding(plan)` (line 1707) already builds the Map and is used at 1728.
   Fix: use the helper at both loops.

3. **`hostLimits.ts` twin files** — historical paths `src/audit/quota/hostLimits.ts` /
   `src/remediate/quota/hostLimits.ts`. VERIFIED — `diff` shows the only
   delta is `ENV_PREFIX` (`AUDIT_CODE` vs `REMEDIATE_CODE`). Fix: one shared function
   taking `envPrefix`; both orchestrators call it. Reuse agent's broader sweep found the
   rest of the audit/remediate wrapper pairs to be legitimate policy draws — this is the
   one true fork it found.

4. **Doubled staleness pass per advance step** —
   [advance.ts:230, 544](../../src/audit/orchestrator/advance.ts). Agent-verified.
   `computeStaleArtifacts` runs in `deriveAuditState` and again on the final bundle —
   a full dependency re-hash twice per drained step, on the hot path. Fix: capture the
   stale set from the derivation and reuse it for the emit.

5. **`EXECUTOR_REGISTRY` linear scans per drain step** —
   [nextStep.ts:141](../../src/audit/orchestrator/nextStep.ts),
   [executors.ts:13](../../src/audit/orchestrator/executors.ts). Agent-verified. Registry
   rescanned per obligation decision. Fix: build `Map<obligationId, executor>` /
   `Map<executorId, executor>` once at module init. Small constant (~25 entries) — payoff
   is clarity as much as speed.

## Tier 2 — altitude: name-inference and per-provider special cases (verified direction, loop-core adjacent — run /design-check before touching)

6. **`isCapableAgentHost` name-check** —
   `src/shared/quota/scheduler.ts:224`. VERIFIED. Hardcodes
   `claude-code || vscode-task`; sits right beside the INV-BROKER-CLASSIFY-SINGLE-SOURCE
   classify struct. Deeper fix: a declared `fansOutToSubagents` capability on the provider
   contract, folded into `classifyProvider`. Same defect class as the pool-class repair
   the dispatch-inversion commit already made (classification = construction-time data,
   never name inference).

7. **`isSelfSpawnBlocked` special-cases beside its own data map** —
   `src/shared/providers/providerPathGuard.ts:88–107`.
   Agent-verified. `codex`/`agy` env-signal checks are hardcoded if-blocks while
   `SELF_SPAWN_ENV_SIGNAL` holds only `claude-code`. Fix: widen the map to multi-env
   arrays and iterate.

8. **Provider classification Sets as literals** —
   `src/shared/providers/inProcessWorkers.ts:26–41`, plus the
   manual `transport === undefined && typeof provider === "string"` inference in
   `src/shared/validation/sessionConfig.ts:235,766`. Agent-verified.
   Classification scattered across sets/factory/validation; validation re-derives what the
   provider predicates already know. Fix: single provider registry declaring worker class;
   validation imports the predicates.

9. **Per-provider copy-paste blocks** — provider command validation
   (`src/audit/validation/sessionConfig.ts:65–132`),
   global-asset install ([remediate/index.ts:742–823](../../src/remediate/index.ts)),
   platform→asset mapping repeated per external binary
   ([candidates.ts:32–55 and 423–679](../../src/shared/analyzers/candidates.ts)).
   Agent-verified. Each is N near-identical blocks iterable from one data table; the
   candidates case duplicates the win32→windows mapping five times. Fix: registry/table +
   one loop; extract `platformToAssetOs` / `archToAssetCpu` helpers.

## Tier 3 — mechanical cleanups, small

10. **Merge the re-export + re-import pair** —
    [nextStepCommand.ts:64–85](../../src/audit/cli/nextStepCommand.ts). VERIFIED, with a
    correction to the agent's fix: `export { … } from` creates no local bindings, so the
    import at 81–85 is load-bearing — the cleanup is import-once-then-export, not deleting
    the import.

11. **1,400-char single import line** —
    [nextStep.ts:13](../../src/remediate/steps/nextStep.ts). Split into grouped imports.

12. **Nested ternary path fallback** —
    [sessionConfigLoad.ts:56–60](../../src/remediate/steps/sessionConfigLoad.ts). Build the
    candidate-path array first, then one first-hit read loop.

13. **`stableStringify` for sorted-array equality** —
    [staleness.ts:109–110](../../src/audit/orchestrator/staleness.ts). Direct array
    comparison; skips serialization per artifact.

14. **Double walk in the contract-pipeline gate** —
    [contractPipelineGates.ts:62–86](../../src/remediate/validation/contractPipelineGates.ts).
    Collect issues in one pass; hoist the `modules` vs `module_contracts` field-name pick
    into one helper.

## Deferred / declined by the review itself

- **Back-compat optional friction fields**
  ([frictionRecord.ts:71–73, 105–107](../../src/shared/friction/frictionRecord.ts)) — only
  worth removing after confirming no persisted records lack them; "deleting a field is not
  retiring it" applies (validator needs the refusal, not just the deletion).
- **OpenCode permission renderer generalization** (remediate/index.ts:654–741) — a second
  IDE with the same shape doesn't exist yet; generalizing now is speculative.
- **Provider wrapper shims → one descriptor object per orchestrator** — the
  audit/remediate provider factory pairs (`agyProvider`, `claudeCodeProvider`,
  `claudeWorkerProvider`, `providers/index.ts`) read as ~95% twins, but the diff shows
  they are the *deliberate* drift-plan E4 endpoint: class bodies live in shared, each
  file carries only its orchestrator's deltas (session-config path, slash command,
  `skipPermissionsDefault`, orchestrator name). The only further consolidation is one
  `OrchestratorDescriptor` per side feeding shared factories — collapses ~4 shim files
  each, at the cost of revisiting a settled design. Requires the /design-check
  retirement-collision pass before pursuing; not a plain dedup win.
- **Reuse sweep otherwise clean**: shared helpers (path, token-estimate, JSON IO, lock,
  spawn) are consistently used; step-contract wrappers are correct one-core-two-draws
  policy shims.
- **acceptNode interdependent optional params / always-`undefined` options plumbing** —
  real but low-payoff signature hygiene; fold into whichever Tier 1/2 item touches those
  files rather than standalone passes.
