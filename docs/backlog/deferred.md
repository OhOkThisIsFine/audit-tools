# Deferred / waiting

> Real work blocked on data, a live run, credentials or a toolchain not on this box.
>
> Part of the split backlog — index: [`docs/backlog.md`](../backlog.md).
> A living to-do list, not a status log. Remove an entry once it ships; record durable
> contracts and rationale in project memory or `CLAUDE.md`, never "where the code is today".



- **A2 finding-quality oracle — REDIRECTED (owner 2026-07-22): base the corpus on SMALL, PUBLIC,
  PINNED git repos, not on labeled self-audit runs.** The `score-audit` scorer is built; the prior
  plan (hand-label a live run's findings into `corpus/<run-id>.labels.json`) has two structural
  flaws the redirect fixes: (a) labels against our own moving tree ROT — findings reference
  file:lines that drift within days, so a labeled run is a one-shot number, never a regression
  gate; (b) labeling only what the tool FOUND measures precision only — misses are invisible, so
  recall is unmeasurable without ground truth the tool didn't author.
  **SPEC:** `corpus/` becomes a manifest of pinned public repos — `{repo_url, commit_sha,
  labels[]}`, each label a ground-truth defect (file, region, kind, evidence — ideally the upstream
  FIX commit that proves it). Ground truth comes from someone-else-maintained inventories where
  possible (bugs fixed in later upstream commits; CVE-tagged pre-fix versions; suites like
  Defects4J / BugsInPy) per the synced-not-forked table principle; hand-authored labels are a
  bounded one-time cost per repo and never rot (the SHA is pinned). `score-audit` gains a
  corpus-repo mode: clone at the pinned SHA (hermetic state via `AUDIT_CODE_STATE_DIR`), run the
  audit ($0 NIM lanes make this per-release cheap), match findings against labels → precision AND
  recall as a repeatable release-time gate. Prefer small-but-REAL repos (real libraries at pre-fix
  commits) over purely synthetic bug suites — synthetic-only corpora overestimate transfer. Rust /
  Ruby pins double as clippy/rubocop analyzer targets (toolchain availability still gates the live
  spawn). **Scope honesty:** this measures finding QUALITY; pipeline-at-scale behavior (charters
  over 1000+ components, quota walls, deepening) stays validated by dogfood runs. The re-dogfood
  run's 1480-finding hand-label is DEMOTED from oracle-blocker to optional large-target
  calibration.

- **A7 multi-host validation — automated half green, manual GUI half never run.** Both no-drift gates
  are in `verify:release` and pass: `npm run verify:hosts` (`scripts/audit/verify-hosts.mjs`) and
  `npm run verify:remediate-hosts`, each deploying every host in `INSTALL_HOST_ORDER`
  (codex/opencode/vscode/antigravity) into an isolated temp `$HOME` and re-running that host's own
  `verify()` from the same `INSTALL_HOST_DEFINITIONS` table the deploy uses. Live headless dispatch is
  the `RUN_PROVIDER_MATRIX_E2E=1` e2e, which covers `codex`/`opencode`/`openai-compatible` only — `agy`
  and `claude-worker` still have no live-dispatch row. **Remaining (a human at a GUI host, not code):**
  run the release-time checklist in [`host-validation.md`](../spec/host-validation.md) — three GUI rows
  (Antigravity / OpenCode / VS Code), now for BOTH `/audit-code` and `/remediate-code`. Every checkbox
  is still unticked and both Notes sections are empty, so no release has recorded a pass.

- **Manual real-OpenCode validation** that agent-scoped permission allowances propagate to spawned
  subtasks. Folds into the A7 checklist.

- **Gated live e2es — the current flag set.** `RUN_PROVIDER_MATRIX_E2E=1`
  (`tests/audit/provider-matrix-dispatch-e2e.test.mjs`) and `AUDIT_TOOLS_LIVE_QUOTA=1` (the live Claude
  `/usage` probe in `tests/audit/inv2.test.mjs`) gate on the **flag alone** — creds only decide which
  matrix rows are reachable / whether the probe gets a snapshot. `RUN_NIM_E2E=1`
  (`tests/audit/hybrid-nim-audit-e2e.test.mjs`, `tests/remediate/nim-rolling-e2e.test.ts`,
  `tests/remediate/hybrid-nim-e2e.test.ts`), `RUN_AUTONOMY_E2E=1` (`tests/audit/a9.test.mjs`) and
  `RUN_CLAUDE_WORKER_SMOKE=1` (`tests/shared/claude-worker-provider.test.mjs`) additionally require a key
  (`NVIDIA_API_KEY`/`LLM_BACKEND_API_KEY`) or `claude` on `PATH`, and skip cleanly without it. None run in CI.

- **Prose-heavy staleness narrowing — the bounded semantic gate SHIPPED for the artifact that drove
  it; what stays deferred is the cascade-cost measurement and the remaining prose artifacts
  (2026-07-24, low).** Content-hash staleness still means a cosmetic reword can cascade an expensive
  re-emit, but the class is far narrower at HEAD than "nothing has been built": provenance fields are
  stripped from the canonical hash per artifact and the narrative arrays are canonicalized
  (`NON_SEMANTIC_FIELDS_BY_ARTIFACT` / `canonicalizeNarrativeArrays`, `artifactFreshness.ts:23`);
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
