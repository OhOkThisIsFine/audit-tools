# Doc-review findings — 2026-07-01 (run 10)

Reviewed against main HEAD `bfe15b9`→`b675150` (186 files, ~16k lines changed since last run) → pushed to
`42f03cb` after applying 12 commits.

---

## FYI — auto-applied this run (12 commits, discrete and revertible)

| Commit | Summary |
|---|---|
| `6bec6d2` | `docs/audit-pkg/contracts.md` — fixed stale schema list (3 phantom schemas removed, real ones added) and phantom `synthesis_report.json` → real terminal artifacts. |
| `35a961b` | `docs/audit-pkg/operator-guide.md` — added `codex`/`openai-compatible`/`antigravity` to the supported-providers list. |
| `d6f41f1` | `docs/audit-pkg/release.md` — "upgrades npm to `>=11.5.1`" → "pins npm to `11.5.1`" (publish-package.yml does an exact-version install). |
| `8da5b90` | `docs/glossary-ids.md` — `INV-O3`→`INV-o3` casing; `CE-005` row removed (wrong site, concept already covered by `INV-GND`); `CE-206` redirected to its real site/meaning; `SEAM-ACL-*` site corrected. |
| `2fefdea` | `docs/backlog.md` — deleted 3 standalone shipped-status entries (Node verify scope guard, Intake stale-redelivery, web-tree-sitter); trimmed the knip entry to its genuinely-open slice 3 remainder. |
| `cea9945` | `docs/HANDOFF.md` — cleared "not yet committed/published" (work shipped as v0.30.56) and the T2#5 "DESCOPED... zero production callers" claim (two live call sites now exist). |
| `fd9c527` | `src/audit/README.md` — fixed adapters/ gitleaks overclaim and providers/ module-index overclaim (only claude-code+opencode wired locally; rest live in shared). |
| `06a67ef` | `.claude/skills/ship/SKILL.md` — fixed release-and-publish.mjs gate claim (local pre-tag gate is `check` only, not the full `verify:release`). |
| `2b552c2` | `spec/dispatch-token-budget-gate.md` — fixed `upcoming_tokens` shape (wave-level, not per-target) and the quota-death worktree-preservation mechanism name. |
| `a043a55` | `spec/cross-provider-quota-matrix.md` — fixed superseded 0.1/0.3 throttle-before-429 claim. |
| `1f3406a` | `spec/audit/audit-goals.md` — qualified the cleanup-on-completion claim (available via CLI, not auto-triggered). |
| `42f03cb` | `spec/remediate/remediation-goals.md` — fixed per-item state list (no `documented` state; missing terminal/side states) and schema list (only `finding.schema.json` is real JSON Schema). |

Green gate before push: `npm install && npm run build && npm run check && npm test` — build/check clean,
audit suite 3373/0, remediate suite 2103/0, zero failures.

**Previously-open items from run 9 — confirmed resolved on main, no longer escalated:**
- N-3 — `spec/audit-workflow-design.md` date-stamped section headers: confirmed removed.
- N-4 — `docs/HANDOFF.md` "Prior lap" changelog creep: confirmed trimmed (0 occurrences).
- MISSED-B — `src/audit/README.md` stale scaffold placeholder: confirmed replaced with an accurate module index (though two of its lines had gone stale again since — fixed this run, see `fd9c527` above).

**Docs reviewed, no issues found:**
`AGENTS.md`, `README.md`, `docs/audit-pkg/{product,development}.md`, `docs/documentation-philosophy.md`,
`docs/end-of-sprint-report-template.md`, `spec/audit/{state-machine,orchestration-policy}.md`,
`spec/host-validation.md`, `spec/self-scaling-pipeline-design.md`, `spec/remediation-workflow-design.md`
(structural claims clean; see escalated systemic-drift finding below for prose-level drift),
`spec/audit-workflow-design.md` (structural claims clean; see escalated systemic-drift finding below),
`skills/audit-code/{SKILL,audit-code.prompt}.md`, `skills/remediate-code/{SKILL,remediate-code.prompt}.md`,
`.agent/skills/audit-code/SKILL.md`, `.github/agents/auditor.agent.md`, `.github/prompts/audit-code.prompt.md`,
`.github/copilot-instructions.md`, `.claude/skills/disambiguate-backlog/SKILL.md`,
`src/audit/adapters/README.md`, `tests/audit/fixtures/simple-app/README.md`, `docs/reviews/*.md` (both
excluded-row rationales still hold).

---

<!-- DOC-REVIEW-OPEN:START -->
### Proposed instruction-file edits (approve to apply)

- [R10-CLAUDE-1] `CLAUDE.md` — "**Entrypoint:** `audit-code.mjs` → `audit-code-wrapper-lib.mjs`." is wrong — the
  wrapper lib moved to `wrapper/audit-code-wrapper-lib.mjs` (confirmed: `audit-code.mjs:3` imports
  `"./wrapper/audit-code-wrapper-lib.mjs"`). Proposed: `**Entrypoint:** \`audit-code.mjs\` → \`wrapper/audit-code-wrapper-lib.mjs\`.`

- [R10-CLAUDE-2] `CLAUDE.md` — "**Providers** (`src/audit/providers/`): claude-code, codex, opencode,
  openai-compatible, subprocess-template, vscode-task, antigravity, local-subprocess. Auto-resolved
  (`src/audit/providers/index.ts`)" misattributes ownership. `src/audit/providers/` now only wires
  claude-code/opencode locally (`claudeCodeProvider.ts`, `opencodeProvider.ts`, `constants.ts`, `index.ts`); the
  other 6 backends + resolution logic live in `src/shared/providers/providerFactory.ts`. Proposed:
  `**Providers** (\`src/shared/providers/\`, thin per-orchestrator wrapper at \`src/audit/providers/\`): claude-code,
  codex, opencode, openai-compatible, subprocess-template, vscode-task, antigravity, local-subprocess.
  Auto-resolved (\`src/shared/providers/providerFactory.ts\`); implement \`FreshSessionProvider\` from shared.`

- [R10-CLAUDE-3] `CLAUDE.md` — "**Core types** (`src/remediate/state/types.ts`): Finding, RemediationPlan,
  RemediationBlock, ItemSpec, ClarificationRequest, RemediationItemState, TestSpec, VerificationResult,
  CoverageLedger." — `VerificationResult` no longer exists anywhere in `src/`/`tests/` (fully removed); `TestSpec`
  moved to `src/shared/types/contractPipeline.ts`. Proposed: drop `VerificationResult`, note `TestSpec`'s new
  home.

- [R10-CLAUDE-4] `CLAUDE.md` — "`npm run build && npx vitest run tests/remediate/next-step.test.ts`" — this exact
  file has never existed (confirmed via `git log --all`). Six real `next-step-*.test.ts` siblings exist
  (`next-step-lifecycle.test.ts` etc.) — pick one as the example, or generalize the line to a glob. Your call on
  which.

### Design decisions for you

- [R10-D1] `docs/quota-dispatch-design.md` §4 — "The scheduler consumes `remaining_pct` (throttle bands 0.1 /
  0.3) to slow/cool-down *before* a hard 429" describes a mechanism the new `spec/dispatch-token-budget-gate.md`
  replaced (concurrency now gated by a learned per-window token budget; the 0.1/0.3 constants are retained only
  as health classifiers, per `scheduler.ts`'s own comment). The doc also has zero cross-reference to the new
  spec despite covering the same area. Should §4 be rewritten to describe the token-budget-gate mechanism (with
  a pointer to `spec/dispatch-token-budget-gate.md`), or trimmed to drop "how concurrency is throttled" mechanics
  entirely and just point at the spec (keeping `quota-dispatch-design.md` scoped to the higher-level "who tracks
  which quota" model, which is still accurate)?

- [R10-D2] `spec/dispatch-token-budget-gate.md` — two wording-nuance questions, not narrow enough to auto-fix:
  (a) "Everything else the scheduler currently invents is deleted... the `applyQuotaSourceAdjustment` 0.1/0.3
  cliffs" overstates — the *behavior* is gone but the constants themselves survive, repurposed as health
  classifiers (`scheduler.ts:330-337`). (b) "Concurrency is limited by ONLY two things: 1. IDE/provider subagent
  allowance 2. Token budget" omits a third real mechanism — `scheduleWave` also applies a learned
  ramp-up/cooldown cap (`computeRampUpConcurrency`/`computeMaxSafeConcurrency`) not cleanly folded into either
  named thing. Tighten the wording, or is RPM/TPM/ramp-up meant to be understood as "token budget" already?

- [R10-D3] `docs/backlog-remediation-design.md` — its own `CE-001`..`CE-006`/`FC-*` id family collides with
  `docs/glossary-ids.md`'s `CE-*` family (different meanings) AND with source-code `CE-005`/`CE-206` comments
  (a third, unrelated set of meanings each — `stepBoundaryCapture.ts`, `scheduler.ts`, `clauseInterpreter.ts`).
  This is a genuine 3-way collision, not just a risk — `tests/shared/id-glossary.test.mjs`'s guard only scans
  `src/`, not `docs/`, so nothing catches it. Should `CE-*`/`FC-*` ids be explicitly scoped per-doc/session
  (current de facto behavior — fine as design-history, just needs the glossary to disclaim non-uniqueness), or
  does the glossary need a disambiguating suffix scheme?

- [R10-D4] `docs/HANDOFF.md` — 4 consecutive `**PUBLISHED v0.30.5X (...)**` bullets (lines ~11,19,27,29) are
  status-noise / changelog creep, in direct tension with the doc's own footer ("Per-lap shipped detail is not
  narrated here — that's changelog creep — see git log"). How many releases should the rolling "Live state"
  window keep — just the latest, or is a short window (how many?) intentional context for a human skimming?

- [R10-D5] `docs/backlog.md` — the "Friction detection — M-QUOTA escalation chain WIRED" entry's "Still open
  (env-bound)" list has 2 of 3 sub-items code-proven done (per commit `d39a678`), but sub-item 2's original
  framing ("wire the same escalation route" for the A-8 hybrid path) was actually supplanted by a different,
  deliberate design choice per a code comment at `nextStep.ts:1774-1779` (the hybrid path has its own
  settle/exhaust mechanism and intentionally doesn't route through `onEscalation`). Confirm before trimming:
  should sub-item 2 be marked done-as-designed (different from as-scoped), or does it need its own follow-up?

- [R10-D6] `docs/backlog.md` — the "Dead-code gate — SHIPPED (knip default-mode)" entry buries a durable
  technique/rationale ("why default-mode, not literal zero-consumers... the periodic manual `knip --production`
  audit process") inside a shipped-status note. Proposal: move the durable rule into `CLAUDE.md`'s Conventions
  section (candidate home: near the two-tier dependency policy, similar "own vs. tool" reasoning), then trim the
  backlog entry to just a one-line "re-run when worthwhile" pointer. Since this touches an instruction file it's
  escalate-only regardless — awaiting your call on wording/placement.

- [R10-D7] `spec/audit/dependency-map.md`, `spec/audit/artifact-contract.md`, `spec/audit/executor-catalog.md` —
  **systemic drift, confirmed by both reviewer and adversary, larger than a narrow fix.** All three describe a
  synthesis-output model that predates the current contract: phantom filenames (`synthesis_report.json`,
  `merged_findings.json`, `root_cause_clusters.json`, `audit_results.json` for `.jsonl`) appear throughout, real
  artifacts (`audit-findings.json`, `audit-report.md`, `synthesis-narrative.json`, `tooling_manifest.json`,
  `intent_checkpoint.json`, `audit_plan_metrics.json`, `task_affinity_graph.json`,
  `syntax_resolution_status.json`) are missing. `executor-catalog.md`'s drift is total — it splits
  `disposition_executor`/`coverage_initializer`/`task_generation_executor`/`requeue_executor` as separate
  executors that don't exist (real registry folds these into `intake_executor`/`planning_executor`), and is
  missing more than half the real 21-entry `EXECUTOR_REGISTRY`. This predates the last review checkpoint — these
  three files were last touched only by a directory-rename commit, never substantively updated. Recommend a
  coordinated rewrite pass across all three, sourced directly from `src/audit/orchestrator/dependencyMap.ts`
  (`ARTIFACT_DEPENDS_ON_MAP`), `src/audit/orchestrator/executors.ts` (`EXECUTOR_REGISTRY`), and
  `src/audit/io/artifacts.ts` (`ARTIFACT_DEFINITIONS`) — too large a rewrite (and requiring editorial judgment on
  organization) to auto-apply as a narrow fix.

- [R10-D8] `spec/audit/entrypoint-contract.md` — "Conceptually, the response should look like... `status`,
  `artifacts_marked_stale`: string[]..., `blockers`..." (hedged as conceptual/aspirational). The real
  `advanceAudit` return type (`AdvanceAuditResult`) has no `artifacts_marked_stale` field at all, and `status`/
  `blockers` aren't top-level either — they're nested inside an `audit_state` object. Since the doc explicitly
  hedges as "conceptual," is this intentional forward design (leave as-is), or should the shape be updated to
  match what's actually returned?

- [R10-D9] `spec/contract-authoring-determinism-design.md` — **needs a full rewrite pass, not a narrow fix.**
  Six of eight strategies (S1, S3, S4, S5, S6, S7) plus three of four S8 sub-fixes have already shipped
  (commits `d5fb1ab`, `2229f73`, `3b39377`, `94a2c33`, `3ebd4f0`, all predating the last review checkpoint), but
  the doc's "Current reality (grounded)" §1 and each strategy section still describe them as proposed/future
  work. Concretely: `src/remediate/contractPipeline/derive.ts` (S1's deriver) exists and is wired;
  `contractPipeline/idRegistry.ts` (S4) exists; the `validate-artifact` CLI (S3) is real; pre-critic gates (S5)
  are chained before `critic`; the stale `contract_pipeline.schema.json` (S6) was deleted, not left rotting;
  span-grounded findings (S7) are enforced at ingest — though S7's plug-in citations are also wrong
  (`orchestrator/fileAnchors.ts` is mischaracterized as a "total_lines remnant," it's actually an unrelated
  navigation-aid module; the real grounding chokepoint is `cli/mergeAndIngestCommand.ts`, uncited by the doc);
  and S8's checklist/judge-framing/ingestion-evidence fixes are all shipped (only "Gate it" — auto-complete-empty
  gating — remains open). This is the highest-priority doc-set item this run: recommend a dedicated
  rewrite/verification pass, not something safe to narrow-fix piecemeal.

- [R10-D10] `spec/audit-workflow-design.md` — a deeper independent pass (169 tool calls) found real prose-level
  drift this run's lighter spot-check missed, despite the doc's structural/pipeline-order claims checking out
  clean. Notable: Gate 1 (provider confirmation) is described as an interactive user gate but is actually a
  silent deterministic auto-complete (`provider_confirmation` never halts for host input despite being tagged
  `kind: "host_delegation"`); the built provider-quota-query + confirmation-display functions have zero call
  sites; "provider pool informs lens recommendations" is unwired; a **systemic "workers emit findings inline;
  skill writes to disk" claim recurs in 3 places** (design review, dispatch, synthesis narrative) but the real
  mechanism is a file write — a code comment documents that inline-emit was tried and reverted because it
  silently dropped results; prompt-caching claims are wrong/unwired in 2 places (`buildCacheablePrompt` has zero
  callers anywhere); planning's "frozen after one always-on LLM estimate review" step doesn't exist; "blast
  radius" is absent from the actual risk-estimate factors; the edge-kind weight ordering doesn't match code's
  actual descending order; and "remediation does not re-ask" Gate 1 is false — remediate-code has zero code
  paths reading the shared provider-confirmation artifact audit-code writes. This is prose-level drift across
  many small claims, not a handful of narrow swaps — recommend a dedicated rewrite/verification pass rather than
  piecemeal fixes.

- [R10-D11] `spec/remediation-workflow-design.md` — same deeper pass found real drift despite structural claims
  checking out clean. Most significant: **"Both paths run the pipeline"** (lines ~138-151, explicit rationale
  that a fast path implementing findings "because the auditor said so... cannot support confident parallel
  implementation") is misleading — `src/remediate/steps/leanFastPath.ts` exists and lets qualifying Path-A runs
  (≤5 findings, ≤5 files, grounded + high-confidence, non-systemic) skip the full `CONTRACT_PIPELINE_PHASE_ORDER`
  entirely; `spec/self-scaling-pipeline-design.md` (a newer doc) independently confirms this fast path is still
  present and calls it "too trusting." Also: `risk_preview` and `impl_preview_acknowledged.json` don't exist
  anywhere in code; `synthesize_intake`/"synthesize + draft" isn't a real pass name; `applyClarificationResolution`
  is the wrong symbol name (real: `applyPlanClarificationResolution`); `MAX_AUTO_RETRIES` isn't a single symbol
  (split into `_CONTRACT`/`_INFRA`). Recommend folding into the same rewrite pass as R10-D10/R10-D9 since all
  three top-level design docs need reconciliation against what's actually shipped.

- [R10-D12] `.agent/skills/remediate-code/SKILL.md` — byte-identical to `skills/remediate-code/SKILL.md`, but
  unlike its audit-code sibling (generated/maintained by `wrapper/audit-code-wrapper-install-hosts.mjs`), nothing
  generates or enforces sync for this file — no remediate-code equivalent installer exists. Currently matches by
  coincidence, not by mechanism. Is this an intentional manual mirror, or should it get a real generator
  (extending the audit-code pattern to remediate-code) or be deleted?

- [R10-D13] `examples/README.md` — lists "example review packets" as something the directory "should hold," but
  `CLAUDE.md` states review packets are "partitioned JIT at dispatch, never persisted" — structurally
  unfulfillable, not merely unfulfilled. A real `session-config/` subdirectory (9 provider config examples) is
  entirely undocumented. Drop the review-packets line and document session-config/, or leave the wishlist framing
  as intentionally aspirational?

- [R10-D14] `templates/AGENTS.remediate-code.md` — orphaned: no code anywhere (`scripts/`, `wrapper/`, `src/`)
  reads this file or the `templates/` directory at all, and `AGENTS.md`'s own hand-authored remediate-code block
  has drifted from this template's content (extra sentences in `AGENTS.md` not in the template). Ships as dead
  weight in the npm package regardless (`package.json` "files" includes `templates/**`). Delete it, or wire it
  into a real remediate-code installer (parity with audit-code's AGENTS.md templating) and reconcile the drift?

- [R10-D15] `tests/remediate/remediation-report.md` — unused stray fixture: no test references this literal
  path (all tests use dynamic temp paths), and its content predates the current renderer — `close.ts`'s
  `buildRemediationReportMarkdown` always emits a `## Review` section when `resolved.length > 0`, but this
  fixture has 1 resolved finding and no `## Review` section. Delete as an accidental artifact, or regenerate as
  an intentional golden example?

- [R10-D16] `.audit-tools/audit-report.md` — tracked in git (added at `b20c85c` alongside
  `.audit-tools/remediation-report.md`), but `docs/doc-review-guidelines.md`'s excluded row only lists the
  `remediation-report.md` sibling, not this one — despite `CLAUDE.md`'s Artifact layout describing both as
  structurally parallel "promoted on completion" outputs. `scripts/check-doc-manifest.mjs` only scopes
  `docs/*.md`, so this asymmetry is entirely outside the mechanical reconciliation gate's reach — not just
  unreviewed-but-listed, but structurally invisible to it. Cannot self-resolve (`doc-review-guidelines.md` is
  excluded from its own review). Proposed: add `.audit-tools/audit-report.md` to the excluded row for parity,
  same rationale template as its sibling.

### Doc-set condensation

- [R10-C1] `docs/quota-dispatch-design.md` ↔ `spec/dispatch-token-budget-gate.md` — not a merge/fold candidate
  (different altitudes: the first is "who tracks which quota," the second is "how concurrency is gated given
  that quota"), but they're now two halves of one mechanism with zero cross-reference between them (see R10-D1).
  Recommend adding a pointer, not merging.

- [R10-C2] `spec/cross-provider-quota-matrix.md` ↔ `spec/dispatch-token-budget-gate.md` — the matrix's one-line
  scheduler-behavior claim (fixed this run, see `a043a55`) was a duplicate/stale outpost of a mechanism the gate
  spec now owns. Propose either an explicit cross-reference from the matrix to the gate spec, or trimming the
  matrix's scheduler-behavior sentence entirely now that it's fixed but still redundant with the gate doc's
  fuller treatment. Ethan's call — not urgent, low-stakes duplication.
<!-- DOC-REVIEW-OPEN:END -->
