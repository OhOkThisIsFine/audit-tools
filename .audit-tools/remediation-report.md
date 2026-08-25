# Remediation Report

## Review

All code changes were accepted through the provider-neutral host handoff and corroborated as landed commits reachable from the repository HEAD. Review the resulting diff and commit history.

## Resolved — Changed Files

- **CP-NODE-1**: Settle shared-core seam expectations
- **CP-NODE-10**: Hoist Path-A source_finding_ids validation
- **CP-NODE-11**: Guard runSample against overwriting a live bundle
- **CP-NODE-13**: Content-derived pair keys in weightedGraph
- **CP-NODE-14**: Bounded runCommand wait + PRIORITY-registration test
- **CP-NODE-16**: Validate cleanup target before every recursive delete
- **CP-NODE-17**: Admit reviewed_lines in both AuditResult schemas
- **CP-NODE-19**: Make side_effects a derivable projection field
- **CP-NODE-21**: Fix dc3/dc5 constant shadowing and hand-copies
- **CP-NODE-22**: Add liveness signal to agent-slot GC
- **CP-NODE-23**: Wrapper accepts equals-form flags; explicit wins over defaults
- **CP-NODE-24**: Fault the gate on failed porcelain parse
- **CP-NODE-25**: Coordinated fileLock rewrite (sole editor)
- **CP-NODE-26**: Close-gate async migration + shape gate + evidence
- **CP-NODE-27**: Rebuild cyclic-seam fixture; assert triage failure context
- **CP-NODE-28**: Pin commandLeavesDeclaredShape with direct tests
- **CP-NODE-29**: Wire AuditCodeResponseSchema into the repo's contract surface
- **CP-NODE-3**: Settle remediate-side seam expectations
- **CP-NODE-30**: Direct unit tests for canonicalizeFilePath (pathIdentity)
- **CP-NODE-4**: Settle wrapper/template/test-fixture seam expectations
- **CP-NODE-5**: Analyzer spawns through admitSpawn on the async exec boundary
- **CP-NODE-6**: Extract shared host-handoff core; reduce both twins
- **CP-NODE-7**: Single-source bounded-call invariant; auto-fix opt-out/dry-run
- **CP-NODE-8**: Loud-fail installer for missing host assets
- **CP-NODE-9**: Promote parser deps; surface Tier-S degradation loudly

## Verified Already Correct (no changes made)

- **CP-NODE-12**: Fix sameLensDedupe survivor conservation
  - *Verification*: Requested mid-scan conservation guard already present in baseline HEAD 708b8003448a54b8e237653846b8a9cc4cf9a9e3 at src/shared/findings/dedupe.ts:555 ('if (removed.has(group[i])) break;' plus its comment block at :549-554) inside sameLensDedupe; union members merged into a dropped duplicate are conserved because absorbFinding unions into the survivor before removed.add.
  - *Verification*: Provenance: finding.hash_at_plan_time 72e3aabf353fd3f6964dbda9fb90795360d731f23d890db28fb3000b259e20a3 equals the sha256 of git blob 62af2c8d^:src/shared/findings/dedupe.ts (verified via git cat-file | sha256sum) ΓÇö the item was planned against the PRE-FIX file.
  - *Verification*: Commit 62af2c8d 'remediate(CP-BLOCK-CP-NODE-1): CP-NODE-1' landed exactly this change (git diff = +7 lines: comment + break guard); CP-NODE-12 duplicates CP-NODE-1, so re-applying would be a no-op on identical code.
  - *Verification*: Verification on the untouched worktree (git status clean, HEAD = baseline before and after): npm run build OK; npm run check OK; npx vitest run tests/shared = 148 files / 1965 passed / 0 failed / 4 skipped; npm run check:lint OK.
- **CP-NODE-15**: Route clarification resolution through the INV-RS-10 funnel
  - *Verification*: Finding's demanded end-state already exists at baseline_commit 708b8003: applyPlanClarificationResolution (src/remediate/steps/nextStep.ts:2525-2529) lands the terminal branch in status "implementing" (or "waiting_for_clarification"), never "closing", so the all-terminal derive fires and handleAllTerminalTransition runs the INV-RS-10 gate on the post-resolution state.
  - *Verification*: The direct write was already removed by commit 708b8003 (CP-NODE-3 remediation): its diff against parent babcefec changed `: "closing"` ΓåÆ `: "implementing"` and deleted `state.closing_plan ??= { action: "none" }`, adding the comment naming the single all-terminal ΓåÆ closing funnel.
  - *Verification*: grep over src/remediate + src/shared finds exactly one remaining `status = "closing"` write ΓÇö nextStep.ts:3310 inside handleAllTerminalTransition itself, strictly downstream of the tool-owned final gate; triage.ts only emits closing intent via the prepared-status seam (nextStep.ts:2954).
  - *Verification*: Verified green on the untouched tree (working tree clean, nextStep.ts blob 6462c5998f34e66dc2399ed2531cb76f8a89d34b = HEAD): npm run build exit 0; npm run check exit 0; npx vitest run tests/remediate exit 0 (1698 passed, 0 failed); npm run check:lint exit 0.
- **CP-NODE-18**: Verify the fileLock rewrite interior (tests/shared only)
  - *Verification*: Assignment summary itself orders 'NO src edit': CP-NODE-25 is the sole editor of src/shared/io/fileLock.ts; the 278-after-1274 order rides the DAG edge over artifact:filelock-rewrite, not prose.
  - *Verification*: HEAD d339f02a equals baseline_commit d339f02a; working tree clean; src/shared/io/fileLock.ts byte-identical (empty git diff).
  - *Verification*: Torn/partial-write pin present and green: tests/shared/locked-json-store.test.ts:108,:138 assert prior content intact with no partial/temp file; tests/shared/json-io.test.ts pins the shared temp-then-rename writer.
  - *Verification*: Stat-then-read stale-adoption TOCTOU pinned behaviorally: tests/shared/fileLock.test.ts:588 (FND-TST-a50db947) holds maxConcurrent===1 through a concurrent stale-steal; INV-SCC-08 live-holder non-steal at :772.
  - *Verification*: Exported-surface pin landed by baseline commit d339f02a: tests/shared/filelock-export-surface.test.ts generated snapshot plus rename/retype/remove/add mutation controls all pass against the live source.
  - *Verification*: Sole-owner conflicting-write refusal at ingestion is pinned remediate-side via the hash_at_plan_time binding (tests/remediate/file-integrity.test.ts and related suites).
  - *Verification*: Required tests all passed on the unmodified tree: npm run build exit 0; npm run check exit 0; npx vitest run tests/shared -> 151 files, 1994 passed / 0 failed / 4 skipped; additional npm run check:lint exit 0.
- **CP-NODE-2**: Settle audit-side seam expectations
  - *Verification*: All 43 allowed_files sha256-match their hash_at_plan_time values on baseline de388be3 - no drifted or half-applied seam work exists.
  - *Verification*: CP-NODE-2 is a seam-prep shard whose deliverable is artifact:seam-audit-config (already emitted in finalized_module_contracts.json). Its own side_effects line: 'Writes only this shard JSON - owner: contract-drafting wave; packaging/tsconfig/schema edits belong to their own impl blocks, not this wave.'
  - *Verification*: Every invariant site has a named owner block per the shard's coordination notes plus extracted-plan.json ownership: both schema envelopes -> CP-BLOCK-CP-NODE-17; package.json dep move + registry loud refusal ('one coordinated change') -> CP-BLOCK-CP-NODE-9; cleanup validation-before-delete -> CP-BLOCK-CP-NODE-16; runtime timeout vs drain accounting -> CP-BLOCK-CP-NODE-14. The shard's failure_modes forbid double-editing these.
  - *Verification*: Schemas are GENERATED from src/audit/contracts/workerSchemas.ts (scripts/audit/generate-schemas.mjs) and pinned by tests/audit/worker-schema-generation.test.ts; the zod source is outside allowed_files, so a schema edit here could only be a hand-edit that trips the drift guard.
  - *Verification*: Verified green with zero edits: npm run check exit 0; npm run check:lint exit 0; working tree clean.
- **CP-NODE-20**: Correct the OpenCode template's emitted keys
  - *Verification*: The finding is already satisfied at baseline 708b8003: commit 5fbcc56e (remediate CP-NODE-4) replaced the stale step-2 wording with 'Read the returned JSON far enough to find `prompt_path`, then read and follow the prompt file it points to.' ΓÇö file blob ea25f5f9, matching the finding's target text exactly.
  - *Verification*: grep across the repo finds no remaining `prompt_content` producer-reference: hits are only historical renders (.audit-tools/audit-report.md, remediation-report.md) and tests/shared/wrapper-quote-parity.test.ts:83, which ASSERTS its absence ('template must not name a field no producer emits'). The contract key is `prompt_path` (StepArtifactSchema.prompt_path, src/audit/cli/steps.ts:74).
  - *Verification*: The mechanical guard pinning this property passes: npx vitest run tests/shared/wrapper-quote-parity.test.ts ΓåÆ 5 passed / 0 failed, exit 0.
  - *Verification*: Working tree left clean (git status --porcelain empty); no edits landed, per resolved_no_change.
  - *Verification*: Closeout-challenge pass 1: nothing outstanding to fix. Sprint diff is zero (no edits landed), so there is no dead code / stray debug / orphaned helper to scan out and no deliberate intermediate state to flag; build + check + check:lint ran green on the already-clean tree at 708b8003. No rendered closeout was written because this session is a dispatched child (AUDIT_TOOLS_CHILD_SESSION=1, explicitly not registered for Stop-gate recruitment) whose host overrides bar every write outside allowed_files and require a JSON-only hand-back ΓÇö an in-tree render would contaminate the exact changed-file set the orchestrator verifies against result_path. Remaining steps live in the orchestrator's run ledger and result ingestion, not in chat; no owner-only decision arises (the only candidate ΓÇö whether CP-NODE-20 should have been deduplicated against the already-shipped CP-NODE-4 fix upstream ΓÇö belongs to the orchestrator's triage, and the evidence lines above give it everything needed).

## Ungrounded Evidence

24 planned finding(s) carried no evidence citing a real repo path and were downgraded to low confidence:
- **ARC-2d5421de**: Phase-1 auto-fix rewrites the user's working tree roughly nine obligations before the operator confirms anything, with no opt-out or dry-run anywhere in the surface
- **ARC-305e7ec5**: Closing-gate spawnSync starves the phase-lock heartbeat, recreating the double-hold the recovery path explicitly engineered away
- **ARC-3152b5c6**: Consent machinery is inconsistent end to end: read-only analyzers are gated, tree-mutating formatters and an npx --yes fetch are not, and the executor doc states the opposite of the enforced decline-first order
- **ARC-5dc13564**: Submission bookkeeping bypasses the repo's own LockedJsonStore: unlocked read-modify-write, corrupt-read-truncates-set, and an unlocked append-only ledger
- **ARC-656bd795**: One hung analyzer spawn freezes the event loop: liveness heartbeat dies, live file locks get stolen, and the operator sees a dead CLI
- **ARC-b7728381**: expected:false perspective lanes sit entirely outside the fail-closed acceptance seam - a poisoned perspective reaches the judge with no refusal or ledger trace
- **ARC-cc6091dd**: The central bounded-call invariant is enforced three different ways - and remediate inherits the variant that crashes instead of pausing
- **ARC-e96acb7e**: Two 1,195- and 2,132-line hostHandoff modules re-implement one pipeline with zero shared core - 'one core, two draws' is unrealized at the seam where divergence costs most
- **CFG-eaffc6ab**: Tier-S parser analyzers are dead on every packaged install: web-tree-sitter and tree-sitter-wasms sit in devDependencies, so npm consumers always get the silent regex floor
- **CFG-eefa6f69**: A missing REQUIRED host-asset source skips deployment and forces exit code 0
- **COR-114e4941**: Path-A promotion throws on source_finding_ids violations after every gate has passed, wedging subsequent next-steps
- **COR-4db6ff5a-2**: weightedGraph joins edge endpoints with a space separator, corrupting nodes for paths containing spaces
- **COR-ccf4eccd**: Deepening verdict: F-1 STANDS (high/high) - sameLensDedupe lacks the mid-scan removed(group[i]) guard, so an already-absorbed finding can win as survivor again and every finding unioned into it is silently dropped by the final filter
- **COR-dad3c544**: runCommand spawns with no timeout, so one hung validation command pends the drain forever
- **COR-e362503b**: Clarification-resolution path transitions straight to closing, bypassing the all-terminal INV-RS-10 final-gate funnel
- **OBS-341efec2**: Agent-slot GC silently rm -rf's other processes' step slots after a 60-minute mtime with no log
- **REL-4742dfbb**: A successful git run whose porcelain output fails to parse is indistinguishable from a clean tree
- **REL-f3d81e3f**: Replace the interior of the hand-rolled file lock with a vetted pure-JS lock library behind the identical exported surface
- **SEC-00c31ecc**: resolved_no_change decision path bypasses every write-scope corroboration check
- **SEC-305e7ec5**: Declared-command-shape gate covers triage and required-test spawns but not the closing gate's test/e2e spawns
- **SEC-6377cd3f**: Normal-lane required-test rerun spawns blocking subprocesses while the remediation state lock is held
- **SEC-d142de22**: Non-git roots with no persisted host_handoff accept landed results on host attestation alone
- **TST-c86ecc0f**: Cyclic-seam integration fixture contains no cycle, so the test cannot catch a broken cycle detector
- **TST-d1d47352**: collect_triage test never asserts the failure_context whose propagation is its stated purpose

## Closing Action

Action: none
Status: skipped

## Repository Gate

Outcome: executed — the repository build/typecheck/test floor RAN (4 command(s)) and PASSED.
Scope: all-terminal final gate

## Remediation Outcomes

Of 30 finding(s): 25 resolved, 5 verified already correct, 0 deemed inappropriate, 0 ignored, 0 blocked.

By lens:
- security: resolved 25, verified_no_change 5
