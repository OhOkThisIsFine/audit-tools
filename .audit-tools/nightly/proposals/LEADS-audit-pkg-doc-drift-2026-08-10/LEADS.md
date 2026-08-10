# LEADS — 24 unverified doc-drift findings across `docs/audit-pkg/*` (2026-08-10 nightly, leg 1)

**These are LEADS, not verdicts, and NONE was applied.** They come from a single Codex reviewer
lane that had repo access and read the five package docs against source. The lane then wedged on
its own agent-spawn router before any adversary pass ran, so **21 of the 24 have had no independent
verification at all**. Treat every one at the same bar as a backlog entry claiming to be shipped:
re-verify the anchor against HEAD before touching a doc.

Why they are held rather than applied: the routine's safety gate is reviewer -> independent
adversary -> judge, and only the reviewer ran. Applying 21 unverified LLM claims to five docs is
exactly the failure the gate exists to prevent.

## The three that WERE verified this run (spot-check, to gauge the lane's precision)

| Finding | Verdict | Evidence |
|---|---|---|
| `release.md:167` — "Routine CI exercises the Node majors matrixed in `.github/workflows/*.yml`" | **CONFIRMED** | `ci.yml:63` `CI_NODE_VERSION: "22.14.0"`, `publish-package.yml:33` `RELEASE_NODE_VERSION: "22.14.0"`, `audit-code-test-suite.yml:115` `"22.14.0"`. Every workflow pins one Node version; the matrices are test shards, not Node majors. |
| `contracts.md:38` — workers submit `AuditResult[]` "shaped by `schemas/audit_result.schema.json`" | **CONFIRMED** | `schemas/audit_result.schema.json` has root type `object`; the array submission schema is the separate `schemas/audit_results.schema.json`, root type `array`. |
| `operator-guide.md:170` — 'Use `ui_mode: "visible"` when debugging provider stdout/stderr' | **CONFIRMED WITH NUANCE** | Both dispatch launch sites hard-code headless (`src/audit/cli/rollingAuditDispatch.ts:329`, `src/remediate/phases/workerTasks.ts:61`), so the advice cannot take effect on a dispatch launch. But `uiMode` IS honoured downstream (`src/shared/providers/opencodeProvider.ts:47`, `providerFactory.ts:117`), so the field is not dead — the guidance is unreachable, not the mechanism. A blunt "this is stale" edit would be wrong. |

Three for three on the sample, with one needing correction in the writing — which is why the
remaining 21 are worth working and still must not be applied unread.

## A caution that applies to several of them

At least three findings (`product.md:49`, `development.md:42`, `operator-guide.md:186`) say the same
thing: the docs claim provider ordering, ranking, cooldowns and failover belong to an external
broker, while `src/shared/dispatch/rollingDispatch.ts` does that work locally. That is real, but it
is **not** a simple factual fix — it is the routing-removal tension, and it is already the subject of
this run's `docs-1`. Do not "fix" those three by rewriting the docs to describe the local behaviour;
the owner's 2026-08-09 cut deletes the local behaviour. Fold them into whatever `docs-1` is answered.

---

## The raw lane output, verbatim

FINDING: docs/audit-pkg/product.md:44
CLAIM: “Packet workers submit validated `AuditResult` objects through backend-owned commands.”
CODE: `src/audit/cli/dispatch/packetPrompt.ts:293-337` requires workers to write `AuditResult[]` directly to `result_path`, explicitly uses no shell submit command, and makes pre-validation optional; `src/audit/cli/mergeAndIngestCommand.ts:558-585` validates afterward.
CONFIDENCE: high

FINDING: docs/audit-pkg/product.md:49
CLAIM: “Concrete provider/model ordering and failover belong to the external dispatch broker.”
CODE: `src/shared/types/sessionConfig.ts:446-540` defines concrete transport, endpoint, model, quota, and cost sources; `src/shared/dispatch/rollingDispatch.ts:829-881` locally orders pools and selects `providerName`/`hostModel`; `src/audit/cli/rollingAuditDispatch.ts:287-329` resolves and launches that provider.
CONFIDENCE: high

FINDING: docs/audit-pkg/product.md:86
CLAIM: “language-agnostic semantic affinity (shared unusual domain terms, nearby paths, identifier overlap, embeddings)”
CODE: `src/audit/orchestrator/taskAffinityGraph.ts:20-27,169-240` implements only structural task-affinity signals and no term, identifier, or embedding analysis; `src/audit/orchestrator/reviewPacketGraphContext.ts:75-113` derives `boundary_files` from crossing graph edges and sorts them lexicographically.
CONFIDENCE: high

FINDING: docs/audit-pkg/contracts.md:32
CLAIM: “the canonical outputs are `.audit-tools/audit-report.md` and `.audit-tools/audit-findings.json`.”
CODE: `src/audit/io/artifacts.ts:458-486` treats findings promotion as optional and non-blocking, then removes the intermediate artifact directory even if the findings copy failed. A completed audit can therefore lack the promoted `.audit-tools/audit-findings.json`.
CONFIDENCE: high

FINDING: docs/audit-pkg/contracts.md:38
CLAIM: “Workers submit `AuditResult[]` shaped by `schemas/audit_result.schema.json`.”
CODE: `src/audit/contracts/workerSchemas.ts:106-126` defines the full array submission as `WorkerAuditResultsSchema` and registers it as `audit_results.schema.json`; `schemas/audit_result.schema.json` has root type `object`, while `schemas/audit_results.schema.json` has root type `array`.
CONFIDENCE: high

FINDING: docs/audit-pkg/contracts.md:45
CLAIM: “`file_coverage` is required and must include assigned files only”
CODE: `src/audit/validation/auditResults.ts:93-107,784-803` deliberately widens accepted coverage to any file assigned to a sibling task in the same packet through `boundaryPaths`.
CONFIDENCE: high

FINDING: docs/audit-pkg/contracts.md:46
CLAIM: “`file_coverage[].total_lines` must match the current file line count”
CODE: `src/audit/validation/auditResults.ts:30-43,826-850` makes mismatches errors only when they exceed both two lines and 5%; smaller mismatches are warnings, and `src/audit/cli/mergeAndIngestCommand.ts:566-585` ingests results with warnings.
CONFIDENCE: high

FINDING: docs/audit-pkg/contracts.md:80
CLAIM: “Consumers should treat these as versioned JSON artifacts and validate them with `audit-code validate`”
CODE: `src/audit/io/artifacts.ts:194-210,281-289` classifies `audit_results.jsonl` as NDJSON and `audit-report.md` as text, not JSON; `src/audit/validation/artifacts.ts:26-72,351-374` has no artifact-shape checks for audit results, findings, the report, or synthesis narrative.
CONFIDENCE: high

FINDING: docs/audit-pkg/contracts.md:106
CLAIM: “`self.can_dispatch_subagents` still routes ENGINE selection (hybrid vs headless in-process dispatch)”
CODE: `src/audit/cli/nextStepHelpers.ts:2420-2454` populates source pools only when the host cannot dispatch and immediately enters the headless branch; the purported hybrid branch at `src/audit/cli/nextStepHelpers.ts:2562-2575` requires those same nonempty pools, making attended hybrid selection unreachable.
CONFIDENCE: high

FINDING: docs/audit-pkg/contracts.md:131
CLAIM: “worker submits AuditResult[] through submit-packet”
CODE: `src/audit/cli/dispatch/packetPrompt.ts:323-337,386-390` requires direct writing to `result_path` and forbids shell submission; `tests/audit/dispatch-helpers.test.ts:125-135` explicitly asserts that generated worker prompts contain no `submit-packet` command.
CONFIDENCE: high

FINDING: docs/audit-pkg/development.md:42
CLAIM: “Provider/model ordering is an external broker concern, not an audit obligation.”
CODE: `src/audit/cli/dispatch/tierRouting.ts:31-99` assigns packet model tiers; `src/shared/dispatch/rollingDispatch.ts:829-881` locally orders and chooses concrete pools; `src/shared/providers/providerFactory.ts:165-215` contains an internal ranked provider-resolution table.
CONFIDENCE: high

FINDING: docs/audit-pkg/development.md:103
CLAIM: “`prepare-dispatch` → worker reviews each packet → `submit-packet` → `merge-and-ingest`”
CODE: `src/audit/cli/dispatch/packetPrompt.ts:323-337,386-390` defines the current worker handoff as a direct write to `result_path`, and `tests/audit/dispatch-helpers.test.ts:125-135` prohibits `submit-packet` in generated worker prompts.
CONFIDENCE: high

FINDING: docs/audit-pkg/operator-guide.md:120
CLAIM: “`audit-code validate` checks … explicit provider readiness.”
CODE: `src/audit/cli/validateCommand.ts:15-54` reads only persisted session intent and has no auditor-descriptor input; `src/shared/validation/sessionConfig.ts:957-990` rejects provider/source inventory from that file, and an invalid explicit inventory suppresses the provider probe. Valid persisted intent falls back to `worker-command` in `src/audit/validation/sessionConfig.ts:53-64`.
CONFIDENCE: high

FINDING: docs/audit-pkg/operator-guide.md:170
CLAIM: “Use `ui_mode: "visible"` when debugging provider stdout/stderr.”
CODE: `ui_mode` is only typed and validated in `src/shared/types/sessionConfig.ts:780-782` and `src/shared/validation/sessionConfig.ts:806-815`; audit and remediation launches hard-code `uiMode: "headless"` in `src/audit/cli/rollingAuditDispatch.ts:317-330` and `src/remediate/phases/workerTasks.ts:51-62`.
CONFIDENCE: high

FINDING: docs/audit-pkg/operator-guide.md:186
CLAIM: “Concrete candidates, ranking, cooldowns, and failover belong to the external broker.”
CODE: `src/shared/dispatch/rollingDispatch.ts:829-881,1818-1948` locally filters and ranks pools, selects a concrete provider, and redispatches around unavailable pools; `src/shared/types/sessionConfig.ts:446-540` permits concrete transports, endpoints, and models.
CONFIDENCE: high

FINDING: docs/audit-pkg/operator-guide.md:220
CLAIM: “Prefer command arrays over shell strings in `session-config.json` … prefer `{workerCommandJson}`”
CODE: `src/shared/types/sessionConfig.ts:856-870` classifies every command-bearing backend block, including subprocess and VS Code templates, as dispatch inventory; `src/shared/validation/sessionConfig.ts:967-990` rejects that inventory from persisted `session-config.json`.
CONFIDENCE: high

FINDING: docs/audit-pkg/release.md:51
CLAIM: “For live child-process output while debugging smoke tests: `AUDIT_CODE_VERBOSE=1`”
CODE: `scripts/audit/smoke-packaged-audit-code.mjs:44-45,64-81` uses the variable only for npm log level and streams installation unconditionally; `scripts/audit/smoke-linked-audit-code.mjs:22-40` never reads it. `scripts/shared/smoke-process.mjs:69-95` streams only calls explicitly given `liveOutput`, which the audit-flow child calls omit.
CONFIDENCE: high

FINDING: docs/audit-pkg/release.md:64
CLAIM: “it deploys every host surface … from the same `INSTALL_HOST_DEFINITIONS` table the postinstall deploy uses.”
CODE: `wrapper/audit-code-wrapper-install-hosts.mjs:137-144,770-805` verifies only Codex, OpenCode, VS Code, and Antigravity through repo-local bootstrap. The actual npm postinstall is the separate `scripts/audit/postinstall.mjs`, which does not use that table and additionally installs Claude Desktop assets at lines 288-320.
CONFIDENCE: high

FINDING: docs/audit-pkg/release.md:84
CLAIM: “no headless backend has live-dispatch e2e coverage … local stubs only”
CODE: `tests/audit/a9.test.ts:34-39,74-99` defines an opt-in headless end-to-end run against live NVIDIA NIM, and `tests/audit/hybrid-nim-audit-e2e.test.ts:15-42,112-125` defines another live NIM dispatch test.
CONFIDENCE: high

FINDING: docs/audit-pkg/release.md:111
CLAIM: “Checklist (one row per GUI host)”
CODE: `scripts/audit/postinstall.mjs:288-320` installs a Claude Desktop plugin, command, and skill specifically so `/audit-code` appears in that GUI host, but the checklist contains no Claude Desktop row.
CONFIDENCE: high

FINDING: docs/audit-pkg/release.md:125
CLAIM: “Codex / `agy` are headless CLIs and are automated the same way”
CODE: `wrapper/remediate-code-wrapper-install-hosts.mjs:139-146,764-800` defines and iterates only `codex`, `opencode`, `vscode`, and `antigravity`; `agy` is absent from the remediation host verifier.
CONFIDENCE: high

FINDING: docs/audit-pkg/release.md:160
CLAIM: “the `gate`/`test` jobs already ran the full verify chain”
CODE: `package.json:51-52` defines the full `verify:release` chain as checks, Vitest, and both linked-install smokes. `.github/workflows/publish-package.yml:46-116` runs checks in `gate` and Vitest shards in `test`, but neither linked smoke.
CONFIDENCE: high

FINDING: docs/audit-pkg/release.md:164
CLAIM: “verifies that the published version resolves from the registry”
CODE: `.github/workflows/publish-package.yml:311-350` retries `npm view`, but after 24 failures emits a warning and exits successfully with status “propagation-verify timed out”; resolution is not required to be verified.
CONFIDENCE: high

FINDING: docs/audit-pkg/release.md:167
CLAIM: “Routine CI exercises the Node majors matrixed in `.github/workflows/*.yml`”
CODE: `.github/workflows/ci.yml:63,98-102`, `.github/workflows/audit-code-test-suite.yml:107-115`, and `.github/workflows/publish-package.yml:33,58,84-92` all use Node `22.14.0`; the matrices are test shards, not Node-major matrices.
CONFIDENCE: high

FINDING: docs/audit-pkg/release.md:232
CLAIM: “If a GitHub Actions run fails: 1. download the uploaded `*-npm-logs` artifact”
CODE: `.github/workflows/publish-package.yml:126-131,351-358` uploads npm logs only from the `publish` job. A failed prerequisite `gate` or `test` job skips `publish`, and those jobs do not upload an npm-log artifact.
CONFIDENCE: high
tokens used
768,590
FINDING: docs/audit-pkg/product.md:44
CLAIM: “Packet workers submit validated `AuditResult` objects through backend-owned commands.”
CODE: `src/audit/cli/dispatch/packetPrompt.ts:293-337` requires workers to write `AuditResult[]` directly to `result_path`, explicitly uses no shell submit command, and makes pre-validation optional; `src/audit/cli/mergeAndIngestCommand.ts:558-585` validates afterward.
CONFIDENCE: high

FINDING: docs/audit-pkg/product.md:49
CLAIM: “Concrete provider/model ordering and failover belong to the external dispatch broker.”
CODE: `src/shared/types/sessionConfig.ts:446-540` defines concrete transport, endpoint, model, quota, and cost sources; `src/shared/dispatch/rollingDispatch.ts:829-881` locally orders pools and selects `providerName`/`hostModel`; `src/audit/cli/rollingAuditDispatch.ts:287-329` resolves and launches that provider.
CONFIDENCE: high

FINDING: docs/audit-pkg/product.md:86
CLAIM: “language-agnostic semantic affinity (shared unusual domain terms, nearby paths, identifier overlap, embeddings)”
CODE: `src/audit/orchestrator/taskAffinityGraph.ts:20-27,169-240` implements only structural task-affinity signals and no term, identifier, or embedding analysis; `src/audit/orchestrator/reviewPacketGraphContext.ts:75-113` derives `boundary_files` from crossing graph edges and sorts them lexicographically.
CONFIDENCE: high

FINDING: docs/audit-pkg/contracts.md:32
CLAIM: “the canonical outputs are `.audit-tools/audit-report.md` and `.audit-tools/audit-findings.json`.”
CODE: `src/audit/io/artifacts.ts:458-486` treats findings promotion as optional and non-blocking, then removes the intermediate artifact directory even if the findings copy failed. A completed audit can therefore lack the promoted `.audit-tools/audit-findings.json`.
CONFIDENCE: high

FINDING: docs/audit-pkg/contracts.md:38
CLAIM: “Workers submit `AuditResult[]` shaped by `schemas/audit_result.schema.json`.”
CODE: `src/audit/contracts/workerSchemas.ts:106-126` defines the full array submission as `WorkerAuditResultsSchema` and registers it as `audit_results.schema.json`; `schemas/audit_result.schema.json` has root type `object`, while `schemas/audit_results.schema.json` has root type `array`.
CONFIDENCE: high

FINDING: docs/audit-pkg/contracts.md:45
CLAIM: “`file_coverage` is required and must include assigned files only”
CODE: `src/audit/validation/auditResults.ts:93-107,784-803` deliberately widens accepted coverage to any file assigned to a sibling task in the same packet through `boundaryPaths`.
CONFIDENCE: high

FINDING: docs/audit-pkg/contracts.md:46
CLAIM: “`file_coverage[].total_lines` must match the current file line count”
CODE: `src/audit/validation/auditResults.ts:30-43,826-850` makes mismatches errors only when they exceed both two lines and 5%; smaller mismatches are warnings, and `src/audit/cli/mergeAndIngestCommand.ts:566-585` ingests results with warnings.
CONFIDENCE: high

FINDING: docs/audit-pkg/contracts.md:80
CLAIM: “Consumers should treat these as versioned JSON artifacts and validate them with `audit-code validate`”
CODE: `src/audit/io/artifacts.ts:194-210,281-289` classifies `audit_results.jsonl` as NDJSON and `audit-report.md` as text, not JSON; `src/audit/validation/artifacts.ts:26-72,351-374` has no artifact-shape checks for audit results, findings, the report, or synthesis narrative.
CONFIDENCE: high

FINDING: docs/audit-pkg/contracts.md:106
CLAIM: “`self.can_dispatch_subagents` still routes ENGINE selection (hybrid vs headless in-process dispatch)”
CODE: `src/audit/cli/nextStepHelpers.ts:2420-2454` populates source pools only when the host cannot dispatch and immediately enters the headless branch; the purported hybrid branch at `src/audit/cli/nextStepHelpers.ts:2562-2575` requires those same nonempty pools, making attended hybrid selection unreachable.
CONFIDENCE: high

FINDING: docs/audit-pkg/contracts.md:131
CLAIM: “worker submits AuditResult[] through submit-packet”
CODE: `src/audit/cli/dispatch/packetPrompt.ts:323-337,386-390` requires direct writing to `result_path` and forbids shell submission; `tests/audit/dispatch-helpers.test.ts:125-135` explicitly asserts that generated worker prompts contain no `submit-packet` command.
CONFIDENCE: high

FINDING: docs/audit-pkg/development.md:42
CLAIM: “Provider/model ordering is an external broker concern, not an audit obligation.”
CODE: `src/audit/cli/dispatch/tierRouting.ts:31-99` assigns packet model tiers; `src/shared/dispatch/rollingDispatch.ts:829-881` locally orders and chooses concrete pools; `src/shared/providers/providerFactory.ts:165-215` contains an internal ranked provider-resolution table.
CONFIDENCE: high

FINDING: docs/audit-pkg/development.md:103
CLAIM: “`prepare-dispatch` → worker reviews each packet → `submit-packet` → `merge-and-ingest`”
CODE: `src/audit/cli/dispatch/packetPrompt.ts:323-337,386-390` defines the current worker handoff as a direct write to `result_path`, and `tests/audit/dispatch-helpers.test.ts:125-135` prohibits `submit-packet` in generated worker prompts.
CONFIDENCE: high

FINDING: docs/audit-pkg/operator-guide.md:120
CLAIM: “`audit-code validate` checks … explicit provider readiness.”
CODE: `src/audit/cli/validateCommand.ts:15-54` reads only persisted session intent and has no auditor-descriptor input; `src/shared/validation/sessionConfig.ts:957-990` rejects provider/source inventory from that file, and an invalid explicit inventory suppresses the provider probe. Valid persisted intent falls back to `worker-command` in `src/audit/validation/sessionConfig.ts:53-64`.
CONFIDENCE: high

FINDING: docs/audit-pkg/operator-guide.md:170
CLAIM: “Use `ui_mode: "visible"` when debugging provider stdout/stderr.”
CODE: `ui_mode` is only typed and validated in `src/shared/types/sessionConfig.ts:780-782` and `src/shared/validation/sessionConfig.ts:806-815`; audit and remediation launches hard-code `uiMode: "headless"` in `src/audit/cli/rollingAuditDispatch.ts:317-330` and `src/remediate/phases/workerTasks.ts:51-62`.
CONFIDENCE: high

FINDING: docs/audit-pkg/operator-guide.md:186
CLAIM: “Concrete candidates, ranking, cooldowns, and failover belong to the external broker.”
CODE: `src/shared/dispatch/rollingDispatch.ts:829-881,1818-1948` locally filters and ranks pools, selects a concrete provider, and redispatches around unavailable pools; `src/shared/types/sessionConfig.ts:446-540` permits concrete transports, endpoints, and models.
CONFIDENCE: high

FINDING: docs/audit-pkg/operator-guide.md:220
CLAIM: “Prefer command arrays over shell strings in `session-config.json` … prefer `{workerCommandJson}`”
CODE: `src/shared/types/sessionConfig.ts:856-870` classifies every command-bearing backend block, including subprocess and VS Code templates, as dispatch inventory; `src/shared/validation/sessionConfig.ts:967-990` rejects that inventory from persisted `session-config.json`.
CONFIDENCE: high

FINDING: docs/audit-pkg/release.md:51
CLAIM: “For live child-process output while debugging smoke tests: `AUDIT_CODE_VERBOSE=1`”
CODE: `scripts/audit/smoke-packaged-audit-code.mjs:44-45,64-81` uses the variable only for npm log level and streams installation unconditionally; `scripts/audit/smoke-linked-audit-code.mjs:22-40` never reads it. `scripts/shared/smoke-process.mjs:69-95` streams only calls explicitly given `liveOutput`, which the audit-flow child calls omit.
CONFIDENCE: high

FINDING: docs/audit-pkg/release.md:64
CLAIM: “it deploys every host surface … from the same `INSTALL_HOST_DEFINITIONS` table the postinstall deploy uses.”
CODE: `wrapper/audit-code-wrapper-install-hosts.mjs:137-144,770-805` verifies only Codex, OpenCode, VS Code, and Antigravity through repo-local bootstrap. The actual npm postinstall is the separate `scripts/audit/postinstall.mjs`, which does not use that table and additionally installs Claude Desktop assets at lines 288-320.
CONFIDENCE: high

FINDING: docs/audit-pkg/release.md:84
CLAIM: “no headless backend has live-dispatch e2e coverage … local stubs only”
CODE: `tests/audit/a9.test.ts:34-39,74-99` defines an opt-in headless end-to-end run against live NVIDIA NIM, and `tests/audit/hybrid-nim-audit-e2e.test.ts:15-42,112-125` defines another live NIM dispatch test.
CONFIDENCE: high

FINDING: docs/audit-pkg/release.md:111
CLAIM: “Checklist (one row per GUI host)”
CODE: `scripts/audit/postinstall.mjs:288-320` installs a Claude Desktop plugin, command, and skill specifically so `/audit-code` appears in that GUI host, but the checklist contains no Claude Desktop row.
CONFIDENCE: high

FINDING: docs/audit-pkg/release.md:125
CLAIM: “Codex / `agy` are headless CLIs and are automated the same way”
CODE: `wrapper/remediate-code-wrapper-install-hosts.mjs:139-146,764-800` defines and iterates only `codex`, `opencode`, `vscode`, and `antigravity`; `agy` is absent from the remediation host verifier.
CONFIDENCE: high

FINDING: docs/audit-pkg/release.md:160
CLAIM: “the `gate`/`test` jobs already ran the full verify chain”
CODE: `package.json:51-52` defines the full `verify:release` chain as checks, Vitest, and both linked-install smokes. `.github/workflows/publish-package.yml:46-116` runs checks in `gate` and Vitest shards in `test`, but neither linked smoke.
CONFIDENCE: high

FINDING: docs/audit-pkg/release.md:164
CLAIM: “verifies that the published version resolves from the registry”
CODE: `.github/workflows/publish-package.yml:311-350` retries `npm view`, but after 24 failures emits a warning and exits successfully with status “propagation-verify timed out”; resolution is not required to be verified.
CONFIDENCE: high

FINDING: docs/audit-pkg/release.md:167
CLAIM: “Routine CI exercises the Node majors matrixed in `.github/workflows/*.yml`”
CODE: `.github/workflows/ci.yml:63,98-102`, `.github/workflows/audit-code-test-suite.yml:107-115`, and `.github/workflows/publish-package.yml:33,58,84-92` all use Node `22.14.0`; the matrices are test shards, not Node-major matrices.
CONFIDENCE: high

FINDING: docs/audit-pkg/release.md:232
CLAIM: “If a GitHub Actions run fails: 1. download the uploaded `*-npm-logs` artifact”
CODE: `.github/workflows/publish-package.yml:126-131,351-358` uploads npm logs only from the `publish` job. A failed prerequisite `gate` or `test` job skips `publish`, and those jobs do not upload an npm-log artifact.
CONFIDENCE: high
