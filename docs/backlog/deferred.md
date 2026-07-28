# Deferred / waiting

> Real work blocked on data, a live run, credentials or a toolchain not on this box.
>
> Part of the split backlog — index: [`docs/backlog.md`](../backlog.md).
> A living to-do list, not a status log. Remove an entry once it ships; record durable
> contracts and rationale in project memory or `CLAUDE.md`, never "where the code is today".



- **A7 multi-host validation — automated half green, manual GUI half never run.** Both no-drift gates
  are in `verify:release` and pass: `npm run verify:hosts` (`scripts/audit/verify-hosts.mjs`) and
  `npm run verify:remediate-hosts`, each deploying every host in `INSTALL_HOST_ORDER`
  (codex/opencode/vscode/antigravity) into an isolated temp `$HOME` and re-running that host's own
  `verify()` from the same `INSTALL_HOST_DEFINITIONS` table the deploy uses. Live headless dispatch is
  the `RUN_PROVIDER_MATRIX_E2E=1` e2e, which covers `codex`/`opencode`/`openai-compatible` only — `agy`
  and `claude-worker` still have no live-dispatch row. **Remaining (a human at a GUI host, not code):**
  run the release-time checklist in the *Host validation* section of [`release.md`](../audit-pkg/release.md) — three GUI rows
  (Antigravity / OpenCode / VS Code), now for BOTH `/audit-code` and `/remediate-code`. Every checkbox
  is still unticked and both Notes sections are empty, so no release has recorded a pass.

- **Manual real-OpenCode validation** that agent-scoped permission allowances propagate to spawned
  subtasks. Folds into the A7 checklist.

- **Prose-heavy staleness narrowing — the cascade-cost measurement and the remaining prose artifacts
  stay deferred (2026-07-24, low).** The bounded semantic gate SHIPPED for the artifact that drove it.
  Content-hash staleness still means a cosmetic reword can cascade an expensive
  re-emit, but the class is far narrower at HEAD than "nothing has been built": provenance fields are
  stripped from the canonical hash per artifact and the narrative arrays are canonicalized
  (`NON_SEMANTIC_FIELDS_BY_ARTIFACT` / `canonicalizeNarrativeArrays`, `artifactFreshness.ts`);
  `charter_register.json` compares per-EDGE dependency slices instead of whole upstream hashes
  (`dependencySlices.ts`); and the bounded semantic judgment itself is the DD-9 intent-equivalence
  gate — `intent_equivalence_current` in `PRIORITY`, `intentEquivalenceExecutor.ts` +
  `intentCheckpointGate.ts`: a structured delta resolves deterministically as CHANGED (an LLM never
  arbitrates a numeric/list delta), a prose-only delta goes to a bounded host judge, and headless
  resolves CHANGED — fail-safe to re-derive. It was justified by live-observed churn (re-dogfood
  2026-07-22) rather than by instrumentation, which is why the old "measure first or guess" framing
  no longer describes the decision that was actually made.
  **What remains:** (a) the charter family and `design_assessment.json` still key their downstreams
  on the whole content hash, so a semantically-identical re-derivation that only rewords re-stales
  `charter_clarification` / `systemic_challenge` / `audit-report.md`; (b) nothing measures the
  cascade — the sole staleness telemetry is the `{kind:"staleness", stale_artifacts:[…]}` stderr
  record (`staleness.ts:emitStalenessRecord`), which names WHICH artifacts staled but not the
  triggering edge, the size/nature of the source change, or the downstream token cost.
  **Property to hold:** an efficiency mechanism is justified by a measured cost or a live-observed
  incident, never by an estimate of one. Extend the gate to a second artifact only when one of those
  exists for it; if the choice is ever genuinely undecidable, the cheap move is edge attribution +
  cost on the existing staleness record, not a second classifier.
