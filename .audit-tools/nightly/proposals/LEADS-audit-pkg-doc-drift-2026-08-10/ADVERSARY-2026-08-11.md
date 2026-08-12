# ADVERSARY pass — 21 unverified `docs/audit-pkg/*` doc-drift findings (2026-08-11)

Independent re-verification of the 21 findings in `LEADS.md` that had no adversary pass. Every
CLAIM was re-read from the doc at HEAD (line numbers checked, not trusted) and every CODE citation
was opened and re-read myself — none of the lane's evidence was taken at face value. Working tree
was dirty per instructions; nothing was applied, this file is verification only.

**Tally: 17 CONFIRMED (4 with a nuance noted), 0 REFUTED, 3 NOT-A-FACTUAL-FIX (routing-removal
shape) + 1 borderline folded into CONFIRMED with a flag.**

Zero refutes is a real outcome, not a shortcut — every CODE citation below was independently
re-opened and re-read (file/line, not the lane's paraphrase) before verdict. This lane's 3/3 spot
check precedent held for the full batch.

---

## NOT-A-FACTUAL-FIX (routing-removal shape — do not rewrite, fold into `docs-1`)

These three match the caution in `LEADS.md` exactly: doc says provider ordering/failover is an
external-broker concern; code (`rollingDispatch.ts`) still does it locally. Per the 2026-08-09 cut,
the local behavior is scheduled for deletion, not something to document — rewriting the doc to
match code would document dead-man-walking logic.

| Finding | Code citation spot-checked | Verdict |
|---|---|---|
| `product.md:49` | `rollingDispatch.ts:829-881` sorts pools by health/capability-rank/load/headroom and returns a concrete `providerName`/`hostModel` — confirmed real, but out of scope for a doc fix | NOT-A-FACTUAL-FIX |
| `development.md:42` | `providerFactory.ts:171-219` `PROVIDER_PRIORITY_RULES` is a real ranked table (`opencode` → `codex` → `agy` → `vscode-task` → …); `tierRouting.ts` assigns tiers — confirmed real | NOT-A-FACTUAL-FIX |
| `operator-guide.md:186` | same `rollingDispatch.ts:829-881` local ranking — confirmed real | NOT-A-FACTUAL-FIX |

---

## CONFIRMED (real, code-anchored drift — minimal fix given for each)

### 1. `product.md:44` — worker handoff is a direct file write, not a "backend-owned command"
CLAIM: "Packet workers submit validated `AuditResult` objects through backend-owned commands."
Re-verified: `packetPrompt.ts:291-298` comment literally says *"No shell submit command"*; the
built prompt (`packetPrompt.ts:323-333`) instructs the worker to WRITE the array to `result_path`
with its Write tool. `mergeAndIngestCommand.ts:558-565` validates AFTER the write, not a submission
command. Pre-validation is explicitly optional ("You MAY validate... This is optional.").
**Minimal fix:** replace "through backend-owned commands" → "by writing the array directly to
`result_path`; there is no submit command."

### 2. `contracts.md:131` and 3. `development.md:103` — same drift, `submit-packet` is not in the worker flow
CLAIM (both): the packet flow includes a `submit-packet` step.
Re-verified: `tests/audit/dispatch-helpers.test.ts:115,135` asserts the generated prompt "must NOT
contain submit-packet" as a named regression test. The CLI command `submit-packet` still exists
(`src/audit/cli.ts:79,154`) for compatibility, but the current handoff never tells a worker to use
it.
**Minimal fix (`contracts.md:131`):** change the flow line `worker submits AuditResult[] through
submit-packet` → `worker writes AuditResult[] directly to result_path (the submit-packet command
is legacy/compat only)`.
**Minimal fix (`development.md:103`):** same substitution in the `prepare-dispatch → … → submit-
packet → merge-and-ingest` sequence.

### 4. `product.md:86` — semantic-affinity graph tier is not implemented (weakest of the CONFIRMED set — flagged)
CLAIM: lists "language-agnostic semantic affinity (shared unusual domain terms, nearby paths,
identifier overlap, embeddings)" as a tier of graph evidence, unhedged.
Re-verified: `taskAffinityGraph.ts:20-27` edge kinds are exactly `shared_file`,
`cross_lens_same_file`, `same_flow`, `same_unit`, `call_adjacent`, `same_dir` — all structural, no
term/identifier/embedding signal anywhere in the file. `reviewPacketGraphContext.ts:75-113`
confirms `boundary_files` comes from crossing graph edges, lexicographically sorted — no semantic
ranking.
Flag: `contracts.md:172` and `development.md:88-91` already hedge this exact feature as
conditional ("semantic-affinity ... if added, should default to low-authority"). `product.md:86`
is the one place stating it unhedged, which is the actual drift — the feature isn't fictional, just
undescribed-as-aspirational in this one spot.
**Minimal fix:** append "(not yet implemented — the current graph carries only structural edge
kinds; see `taskAffinityGraph.ts`)" to the bullet, matching the hedge already used elsewhere.

### 5. `contracts.md:32` — findings promotion is best-effort, can silently fail, and cleanup proceeds anyway
CLAIM: "the canonical outputs are `.audit-tools/audit-report.md` and
`.audit-tools/audit-findings.json`" (stated unconditionally).
Re-verified: `artifacts.ts:458-473` wraps the findings copy in try/catch — a failure only logs a
warning, never throws — and `artifacts.ts:484-486` removes the intermediate artifacts directory
regardless of whether that copy succeeded. A completed run can therefore end with the report
promoted but no `audit-findings.json` anywhere.
**Minimal fix:** add "`audit-findings.json` promotion is best-effort; a failure is logged but does
not block cleanup of `.audit-tools/audit/`, so a completed run can end without a promoted findings
file."

### 6. `contracts.md:45` — `file_coverage` accepts more than the assigned files
CLAIM: "`file_coverage` is required and must include assigned files only."
Re-verified: `auditResults.ts:93-107` (`boundaryPaths` option) and `auditResults.ts:792-803`
(`inBoundary`/`acceptedPath`) widen the hard-reject gate to any file assigned to a *sibling* task
in the same packet, not just the task's own assigned set.
**Minimal fix:** "…must include assigned files, or any file assigned to a sibling task in the same
packet (`boundaryPaths`)."

### 7. `contracts.md:46` — `total_lines` mismatch is tolerant, not exact-match
CLAIM: "`file_coverage[].total_lines` must match the current file line count."
Re-verified: `auditResults.ts:30-43` (`isSignificantLineCountDivergence`) and `auditResults.ts:826-
850` — a mismatch is only a hard error past BOTH a 2-line absolute floor AND a 5% ratio; smaller
mismatches are `warning` severity and `mergeAndIngestCommand.ts:566-585` still ingests them.
**Minimal fix:** "…must match the current file line count within a small tolerance (±2 lines or
5%, whichever is larger); smaller mismatches are advisory warnings, not rejected."

### 8. `contracts.md:80` — artifacts aren't all JSON, and `validate` doesn't shape-check them
CLAIM: "Consumers should treat these as versioned JSON artifacts and validate them with
`audit-code validate`."
Re-verified: `artifacts.ts:194-210,281,287` — `audit_results.jsonl` is registered as NDJSON
(`ndjsonArtifact`), and `audit_report`/`audit-report.md` as `textArtifact`, not JSON.
`validation/artifacts.ts:26-72` (`validateTopLevelShapes`) has no branch for `audit_results`,
`audit_findings`, `audit_report`, or `synthesis_narrative` — confirmed by reading the full function.
**Minimal fix:** "…treat the JSON-typed artifacts in this list as versioned; `audit_results.jsonl`
is NDJSON and `audit-report.md` is text, and `audit-code validate` does not shape-check audit
results, findings, the report, or the synthesis narrative today."

### 9. `contracts.md:106` — the "hybrid" engine branch is unreachable, not "still routing"
CLAIM: "`self.can_dispatch_subagents` still routes ENGINE selection (hybrid vs headless in-process
dispatch)."
Re-verified independently (grepped every assignment): `nextStepHelpers.ts:2420` initializes
`auditSourcePools = []`; it is reassigned ONLY inside `if (!hostCanDispatch)` at line 2436. The
hybrid branch at line 2575 is gated on `engineEnabled && auditSourcePools.length > 0` with no other
assignment site anywhere in the function (confirmed by grep across the whole file for
`auditSourcePools`). So when `hostCanDispatch` is true, `auditSourcePools` is permanently `[]` and
the hybrid branch can never fire — this is a real dead branch, not just doc imprecision.
**Minimal fix:** "`self.can_dispatch_subagents` selects the headless in-process branch when false;
the hybrid branch is currently unreachable when it is true, because the source-pool set it requires
is only ever populated in the headless path (`nextStepHelpers.ts:2420-2436` vs. `2575`)." — worth
flagging to the owner as a possible latent bug, not just a doc fix, since the doc is *describing
what the code was intended to do*, and the code doesn't do it.

### 10. `operator-guide.md:120` — "explicit provider readiness" is really always the disk default
CLAIM: "`audit-code validate` checks … explicit provider readiness."
Re-verified: `validateCommand.ts:15-54` takes no `--auditor`-style explicit descriptor — it reads
only `readSessionConfigFile` from disk. `validateRepoSessionIntent`
(`src/shared/validation/sessionConfig.ts:967-993`) rejects `provider` as one of
`DISPATCH_INVENTORY_FIELDS` (`sessionConfig.ts:856-870`) with an `error` severity issue when
present on disk. In `validateCommand.ts:34-40`, any session-config `error` (which a persisted
`provider` field always is) sets `providerIssues = []`, suppressing the probe entirely; when no
error, `resolveFreshSessionProviderName` falls back to `sessionConfig.provider ?? "worker-command"`
— and since `provider` can never legitimately be on disk, that's always `"worker-command"`, which
has no CLI-binary check in `validateConfiguredProviderEnvironment`'s `cliProviderCommands` row list
(`sessionConfig.ts:68-88`, no `worker-command` row).
**Minimal fix (nuance, same shape as the already-verified `operator-guide.md:170`):** "…checks
artifact shape, cross-artifact consistency, and session config. The provider-readiness check reads
only the persisted (never explicit) session config; since a persisted `provider` field is now
rejected as dispatch inventory, this check is effectively a no-op against the `worker-command`
default in normal usage."

### 11. `operator-guide.md:220` — Windows guidance points at fields the doc's own architecture rejects
CLAIM: "Prefer command arrays over shell strings in `session-config.json` … prefer
`{workerCommandJson}`."
Re-verified: `subprocess_template` and `vscode_task` are both listed in `DISPATCH_INVENTORY_FIELDS`
(`sessionConfig.ts:856-870`), which `validateRepoSessionIntent` rejects as an `error` when found on
persisted `session-config.json` (`src/shared/validation/sessionConfig.ts:967-993`) — the same
mechanism `operator-guide.md`'s own "Dispatch capability is NOT configured here" callout (line 141)
describes. `workerCommandJson` is a real token (`subprocessTemplateProvider.ts`), just not one that
belongs in `session-config.json` anymore.
**Minimal fix:** redirect this Windows guidance to `sources-declared.json` / the per-auditor
`--auditor` descriptor (per the doc's own line 141-151 callout), not `session-config.json`.

### 12. `release.md:51` — `AUDIT_CODE_VERBOSE=1` doesn't get you live audit-flow child output
CLAIM: "For live child-process output while debugging smoke tests: `AUDIT_CODE_VERBOSE=1`."
Re-verified: `smoke-packaged-audit-code.mjs:44-45` reads the var only into `NPM_CONFIG_LOGLEVEL`
(npm's own log verbosity); `smoke-linked-audit-code.mjs` never reads it at all (grepped, zero
matches). The wrapper-install commands in both files hardcode `liveCommandOutput = true`
unconditionally. The actual audit-flow child calls in `smoke-audit-flow.mjs` (`ensure`, `install`,
`verify-install`, the audit-flow driver) never pass `liveOutput` at all (grepped every
`runCommand(` call site) — `smoke-process.mjs:90,94` only streams when `options.liveOutput` is
truthy, so these default to silent regardless of the env var.
**Minimal fix:** "`AUDIT_CODE_VERBOSE=1` raises npm's own log level during the smoke's install
step; it does not control live streaming of the audit-flow child commands (`ensure`/`install`/
`verify-install`), which never stream today."

### 13. `release.md:64` and 14. `release.md:111` — Claude Desktop is deployed outside `INSTALL_HOST_DEFINITIONS`, and the checklist omits it
CLAIM (`:64`): "it deploys every host surface … from the same `INSTALL_HOST_DEFINITIONS` table the
postinstall deploy uses."
CLAIM (`:111`): checklist header "one row per GUI host" with no Claude Desktop row.
Re-verified: `wrapper/audit-code-wrapper-install-hosts.mjs:137-142` `INSTALL_HOST_ORDER` is exactly
`['codex', 'opencode', 'vscode', 'antigravity']` — no Claude Desktop entry anywhere in
`INSTALL_HOST_DEFINITIONS`. `scripts/audit/postinstall.mjs:288-324` installs the Claude Desktop
plugin (manifest/command/skill) as its own hand-written block, calling `writeGeneratedFile`
directly — not through `runInstalls`/`INSTALL_HOST_DEFINITIONS`. So `verify:hosts` (which iterates
`INSTALL_HOST_ORDER`) cannot and does not catch Claude Desktop drift, and it's a real GUI host with
no checklist row.
**Minimal fix (`:64`):** "…deploys the four hosts in `INSTALL_HOST_DEFINITIONS` (codex, opencode,
vscode, antigravity). Claude Desktop is installed by a separate hand-written block in
`postinstall.mjs` and is NOT covered by this table or by `verify:hosts`."
**Minimal fix (`:111`):** add a Claude Desktop row to the checklist table.

### 15. `release.md:84` — opt-in live e2e coverage against a real backend does exist (nuance)
CLAIM: "no headless backend has live-dispatch e2e coverage … local stubs only."
Re-verified: `tests/audit/a9.test.ts:34-99` — `RUN_AUTONOMY_E2E=1` + `NVIDIA_API_KEY`, provider
`openai-compatible`, `host_can_dispatch_subagents: false` — a genuinely headless backend driven
against the live NVIDIA NIM endpoint end-to-end (audit → remediate → complete). Also
`hybrid-nim-audit-e2e.test.ts:15-42` (`RUN_NIM_E2E=1`) hits the same live endpoint. Both are real,
not stubs.
Nuance (same shape as the already-verified `operator-guide.md:170`): both are `skip: !RUN`-gated
and never run in CI or the default suite — so "no coverage runs today" is roughly true in practice,
but "no coverage exists / local stubs only" is factually wrong; the coverage exists and is opt-in,
not absent.
**Minimal fix:** "…no headless backend has live-dispatch e2e coverage **in CI or the default
suite** — `tests/audit/a9.test.ts` and `hybrid-nim-audit-e2e.test.ts` provide opt-in live coverage
against NVIDIA NIM (`RUN_AUTONOMY_E2E=1`/`RUN_NIM_E2E=1` + a key), never run automatically. Absent
that, coverage is unit tests over local stubs."

### 16. `release.md:125` — `agy` is absent from the remediate table, and asymmetrically so vs. `codex`
CLAIM: "Codex / `agy` are headless CLIs and are automated the same way."
Re-verified: `wrapper/remediate-code-wrapper-install-hosts.mjs` — grepped for `agy`, zero matches
anywhere in the file. `codex` IS a full entry in `INSTALL_HOST_DEFINITIONS` (with a
`global-skill+instructions` setup and a real `verify()`), confirmed identically on the audit side
(`audit-code-wrapper-install-hosts.mjs:137-142` `INSTALL_HOST_ORDER`, no `agy` entry there either).
So `codex` gets automated install/verify coverage despite being headless; `agy` gets none at all —
"automated the same way" is false, they're not symmetric.
**Minimal fix:** "Codex is a headless CLI but still gets automated install/verify coverage via
`INSTALL_HOST_DEFINITIONS` (global skill + AGENTS fallback). `agy` has no entry in that table on
either the audit or remediate side and is not automated at all — it is simply out of scope for host
verification."

### 17. `release.md:160` — `gate`/`test` did not run "the full verify chain"
CLAIM: "rebuilds `dist/` for packing (the `gate`/`test` jobs already ran the full verify chain)."
Re-verified: `package.json:51-52` — `verify:checks` (run by `gate`) ends with
`smoke:packaged-audit-code smoke:packaged-remediate-code`, but `verify:release` (the actual "full"
chain) is `verify:checks && vitest && smoke:linked-audit-code && smoke:linked-remediate-code`.
`publish-package.yml:46-73` (`gate`) runs only `npm run verify:checks`; `test` (74-124) runs vitest
shards. Neither job runs the two linked smokes. So "the full verify chain" already ran is
overstated — the packaged smokes ran, the linked smokes did not.
**Minimal fix:** "…rebuilds `dist/` for packing (the `gate`/`test` jobs already ran `verify:checks`
+ vitest; the linked-install smokes are not part of CI and only run in local
`npm run verify:release`)."

### 18. `release.md:164` — "verifies" overstates a step that treats timeout as success
CLAIM: "verifies that the published version resolves from the registry."
Re-verified: `publish-package.yml:311-350` — the step polls `npm view` up to 24 times (240s), and
on exhaustion emits `::warning::` and `exit 0` — "published successfully but was not yet visible…
treated as success — npm has no rollback." Resolution is attempted, not required; a failure to
resolve never fails the workflow.
**Minimal fix:** "…attempts to verify that the published version resolves from the registry,
retrying for up to 4 minutes; a timeout is logged as a warning and does not fail the workflow (npm
has no rollback once published, so slow propagation is not treated as a publish failure)."

### 19. `release.md:232` — the npm-logs artifact only exists for `publish`-job failures
CLAIM: "If a GitHub Actions run fails: 1. download the uploaded `*-npm-logs` artifact."
Re-verified: grepped every `upload-artifact` step in `publish-package.yml` — exactly two exist:
`Upload vitest shard ledger` (in `test`, uploads a JSON ledger, not npm logs) and
`Upload npm debug logs` (`publish-npm-logs`, in `publish` only, line 351-358). The `gate` job has no
`upload-artifact` step at all. A `gate` failure (e.g. `verify:checks` red) — the far more common
failure mode — produces no `*-npm-logs` artifact to download.
**Minimal fix:** "…1. if the failure was in the `publish` job, download the uploaded
`publish-npm-logs` artifact (gate/test failures do not upload one — read the job log directly)."

---

## Already-verified (skipped, per instructions)
`release.md:167`, `contracts.md:38`, `operator-guide.md:170` — see `LEADS.md`'s own table.
