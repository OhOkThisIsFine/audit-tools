# Doc-review findings

Machine-readable block for the SessionStart hook is delimited below. FYI (what was auto-applied) is
outside the block, after it.

<!-- DOC-REVIEW-OPEN:START -->
### Proposed instruction-file edits (approve to apply)
None this run — no CLAUDE.md/AGENTS.md findings surfaced.

### Design decisions for you
- [DD-1] `docs/backlog-remediation-design.md` — still open from a prior run: verbatim, *"The sole
  genuinely-open item from this doc (D8 prose-staleness narrowing) is tracked as open work in
  `backlog.md`."* `docs/backlog.md` still has zero literal "D8" occurrences anywhere; the matching item
  ("Narrow staleness on prose-heavy artifacts via bounded semantic judgment," Deferred/waiting section)
  remains unlabeled. Label the backlog.md bullet "D8", or have `backlog-remediation-design.md` stop
  naming a backlog id it can't guarantee stays synced?
- [DD-2] `spec/self-scaling-pipeline-design.md` — the "Problem" section narrates the retired
  `leanFastPath` mitigation's history in past tense (tried → too trusting → softened → too narrow →
  "shipped (`docs/backlog.md` doc-review D-68)"), matching `documentation-philosophy.md`'s forbidden
  "changelog/progress creep" smell almost verbatim (its own listed examples: "former X inlined", "A12
  collapsed…") — despite the doc's own preamble declaring "Durable conceptual design; no dated status
  here." Restate timelessly (state the current dial-based architecture directly, drop the tried/failed/
  fixed narrative), or is this history load-bearing context worth keeping?
- [DD-3] `spec/multi-ide-concurrent-runs-design.md` — the sentence "concrete values set in slice 2" (near
  the "No TTL/heartbeat as run-liveness" line) is residual slice-numbering/changelog-creep AND now
  half-wrong: `taskLeaseMs` shipped (`AUDIT_TASK_CLAIM_LEASE_MS=20*60_000`, `src/audit/cli/dispatch.ts:135`)
  but no `heartbeatMs` was ever paired with it — `withClaimHeartbeat` is wired only to the short
  bundle-mutation/phase mutexes, never to the long-lived task/node claims — directly contradicting the
  doc's own next paragraph ("no live heartbeat" for these claims). A prior doc-review pass (DD-17/DD-18,
  commit `251b9689`) trimmed the surrounding shipped-status paragraph but left this sentence standing.
  Drop or rewrite the "slice 2" sentence to match the doc's own next paragraph?
- [DD-4] `spec/host-validation.md` — only has GUI-host live-dispatch checklist rows for `/audit-code`.
  `verify:remediate-hosts` (`scripts/remediate/verify-hosts.mjs`) exists and mirrors `verify:hosts`
  exactly, and remediate-code targets the identical four hosts (codex/opencode/vscode/antigravity) — so
  the same three GUI hosts (Antigravity/OpenCode/VS Code) need the same manual "confirm real
  `/remediate-code` dispatch" row this doc gives audit-code. Add a sibling remediate-code checklist
  section, or explicitly scope the doc's title/intro to audit-code-only?
- [DD-5] `docs/backlog.md` — dedup candidate, partial overlap only (don't merge wholesale): the "ad-hoc
  Agent fan-out has no per-agent ledger" sliver appears both folded into the "Tool-prescribed host Agent
  fan-out is quota-INVISIBLE" entry and as sub-bullet (b) of the older "Untracked-exclusion scope rule"
  entry. The older (b) additionally names "recon/review/compaction" as fan-out sites the newer entry
  never mentions or evidences (no "compaction" fan-out site was found anywhere in source). Narrow (b) to
  flag only the recon/charter-extraction + compaction categories as still-uncovered, pointing to the
  newer entry for the design-review/systemic-challenge slice — or is the overlap acceptable as-is?
- [DD-6] `docs/backlog.md` — the 2026-07-11 friction-walk entry (top of *Open bugs / frictions*) uses
  inline `(category, severity)` tags for items (2) and (3) instead of the `[[memory-tag]]` form the
  template two lines above it prescribes (item (1) does use a proper `[[...]]` tag) — internally
  inconsistent within the same entry. Is `(category, severity)` an acceptable alternate form for a
  one-off friction note, or should these route through real memory tags?
- [DD-7] `docs/backlog.md` — a pointer reads "see `docs/HANDOFF.md` T5-3 for what landed," but
  `HANDOFF.md` has no literal "T5-3" label anywhere — only a single "T5 forward tracks" bullet whose
  third clause is admission control. Low-confidence, low-severity: add an anchor to HANDOFF.md, or just
  say "the T5 bullet's admission-control clause"?
- [DD-8] `.claude/skills/ship/SKILL.md` — re-surfaced from a prior run, unchanged: verbatim, *"the local
  preflight is a quick fast-fail, not the full run"* (CI-staging split). Both this run's reviewer and
  adversary again concluded this likely sits outside A6's scope (Part B dev-ops CI staging, not Part A's
  product review-pipeline conviction) — flagging only for your confirmation; no change proposed unless
  you disagree.

### Doc-set condensation
- [CX-1] `spec/audit/artifact-contract.md` + `spec/audit/dependency-map.md` + `spec/audit/executor-catalog.md`
  — still open from prior runs, re-affirmed this run with sharper evidence: `dependency-map.md` already
  correctly documented that `result_ingestion_executor` writes `access_memory.json`, while
  `executor-catalog.md`'s row for the *same executor* omitted that exact artifact from its own Produces
  column (now fixed as a stale-factual-fix this run) — a live instance of the same fact drifting between
  two independently hand-maintained docs over the same `EXECUTOR_REGISTRY`/`ARTIFACT_DEPENDS_ON_MAP`
  source pair. Should "which executor produces which artifact" have exactly one home (fold
  executor-catalog.md's Produces column into dependency-map.md's per-artifact rows, or vice versa)
  rather than being hand-maintained independently in two places?

Canonical-manifest check: `scripts/check-doc-manifest.mjs` re-run clean this pass — 18 tracked docs all
registered, no strays.
<!-- DOC-REVIEW-OPEN:END -->

## FYI — what was auto-applied this run (stale-factual-fix, code-anchored, green-gated)

Full three-agent gate ran this run, scoped to everything changed since the last check (commit
`20c5347a` → `f7f89b7a`): 7 reviewer agents (quota/dispatch cluster; remediate architecture cluster;
audit architecture cluster; policy/instruction/philosophy cluster; package-docs + meta-tooling cluster;
`docs/backlog.md`; `docs/HANDOFF.md`) each examined every in-scope item against live code, re-verified
every previously-open escalation from the last run, and ran the existence/philosophy-conformance/
condensation smells. 7 independent adversary agents then re-checked every item (flagged AND
"accurate") from scratch. One contested item (reviewer said design-decision, adversary argued
stale-factual) went to a Judge agent, which sided with the adversary (auto-apply, narrow addition). All
other classifications agreed on first pass.

Of the 21 items escalated by the prior run (IF-1, DD-1..21, CX-1), 20 were confirmed already resolved by
subsequent commits (including owner-approved batch `251b9689`) and dropped; the sole still-open one
(D8 cross-reference) is carried forward as DD-1 above. CX-1's proposed "goals doc re-check on registry
change" process note was adopted verbatim into `doc-review-guidelines.md` itself.

9 commits landed on `main`, each a discrete stale-factual-fix:

- `spec/self-scaling-pipeline-design.md` + `spec/remediation-workflow-design.md` — fixed two stale
  `leanFastPath.ts` file references; that module was deleted this window (contents relocated to
  `riskSignal.ts` / `contractPipeline.ts`, gated by `runLeanLightReviewGate` in `nextStep.ts`).
- `spec/audit/executor-catalog.md` — fixed four Produces-column gaps (`result_ingestion_executor` missing
  `access_memory.json`; `structure_executor` missing `file_disposition.json`;
  `syntax_resolution_executor` missing `external_analyzer_results.json`; the runtime-validation
  executors' "only" framing not accounting for selective-deepening artifacts).
- `spec/audit-workflow-design.md` — the pipeline-order diagram omitted the shipped `charter_delta` step
  entirely (present in `PRIORITY` and `EXECUTOR_REGISTRY`, and already correct in `executor-catalog.md`).
- `.claude/skills/disambiguate-backlog/SKILL.md` — `meta-audit-log.md` isn't gitignored (no matching
  `.gitignore` pattern, not tracked) — just untracked by convention.
- `spec/audit/dispatch-admission-control.md` — "on the claude-code host path the slope never learns" (2
  occurrences) is now stale: `recordHostTokenUsageObservation` folds host-reported `token_usage` into
  the learned slope when the host stamps it.
- `spec/cost-first-routing.md` — the "three-rung resolution" section omitted `deriveCostRank`'s
  operator-declared-per-source-price sub-rung (rung 2a, authoritative over the models.dev catalog).
- `docs/quota-dispatch-design.md` — §5b's "account identity is read from the credential, never guessed"
  overclaimed universality; `openai-compatible` bare-API-key sources have no credential, so
  `accountId.ts`'s `deriveLocalAccountId` derives a local, credential-value-free id instead (Judge-decided
  contested item).
- `docs/backlog.md` — deleted three fully-shipped entries with no open remainder ("Charter-layer defects
  found + FIXED", "Charter extraction silently keeps one charter per kind", "Host pools calibrate
  FOREVER"); trimmed three partial entries to their open remainder ("Design-review worker prompts", the
  D-68/D-69 cadence-rules entry, the openai-compatible review-dispatch entry — its "defaults off" premise
  is moot, `include_referenced_files` already defaults true); fixed four stale line-number pointers, an
  internal 10-min/20-min TTL self-contradiction, a stale "unmerged" qualifier on an actually-merged
  commit, and two fabricated commit hashes.
- `docs/HANDOFF.md` — the risk-tier/friction-walk cadence bullets called tool-enforcement a "host
  workaround"/"forward-track", contradicted by `backlog.md`'s own D-68/D-69 record that both are now
  tool-enforced; the "Suggested ordering" intro re-narrated the same shipped-fix list already stated in
  "Live state" (changelog-creep duplication); a dangling "tracked in `docs/backlog.md`" CI-redundancy
  pointer matched no backlog entry — `ci.yml` already documents the redundancy was eliminated.

Green gate: `npm run build && npm run check && npm test` — 490 test files / 6418 tests, all green
(12 skipped, expected gated e2es). `check:doc-manifest` also re-verified clean. Each change above landed
as one discrete, revertible commit on `main`.

## Also found, out of this routine's scope (code, not docs)

`src/shared/quota/coverage.ts`'s `renderUnestablishedQuotaNudge` tells the host agent to consult
"`docs/cross-provider-quota-matrix.md`" — that path doesn't exist; the file lives at
`spec/cross-provider-quota-matrix.md`. A runtime string literal, not a `.md` doc claim, so out of this
routine's edit surface — noting for a future code fix.
