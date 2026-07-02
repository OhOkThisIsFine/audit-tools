# Remediation Report

## Review

All code changes were applied on the dedicated branch `remediation/t5-forward-tracks-2026-07-02` — your base branch was left untouched. Review the diff and merge `remediation/t5-forward-tracks-2026-07-02` into your base branch (or re-run with the `merge-to-base` closing action to land it automatically).

## Resolved — Changed Files

- **CP-NODE-1**: Register clippy/rubocop/hadolint/actionlint/type-coverage external analyzers
  - *Verification*: Verified claim: candidates.ts already registers gitleaks/semgrep/eslint/knip/jscpd/osv-scanner; none of clippy/rubocop/hadolint/actionlint/type-coverage existed. Claim holds — 5 analyzers added.
  - *Verification*: Added 5 defaultRun:false ExternalAnalyzerCandidate entries in src/audit/extractors/analyzers/candidates.ts: clippy (cargo, --message-format=json, NDJSON parse, no --fix), rubocop (bundle exec, --format json, no autocorrect), hadolint (binary, --format json), actionlint (binary, -format {{json .}}), type-coverage (npx, --json --detail). Each has detect() ecosystem marker + degrade-to-[] parser + read-only argv.
  - *Verification*: Grounded parsers against real tool JSON: clippy cargo message stream (reason:compiler-message, message.level/spans[].file_name/line_start, code.code); rubocop files[].offenses[]{severity,message,cop_name,location}; hadolint flat array {file,line,code,level,message}; actionlint array {message,filepath,line,kind}; type-coverage {anys:[{file,line,text}]}.
  - *Verification*: Emitted ONLY the generic item shape (id/category/severity/path/line_start/line_end/summary/rule) — no classification field; test 'new analyzers emit ONLY the generic item shape' asserts every emitted key is in the allowed set and classification is never present (ExternalAnalyzerResultItemSchema is .strict()).
  - *Verification*: Added dedicated severity adapters src/audit/adapters/clippy.ts (normalizeClippyJson/parseClippy) + src/audit/adapters/rubocop.ts (normalizeRubocopJson/parseRubocop), both routing through normalizeGenericExternalResults; candidates import parseClippy/parseRubocop. hadolint/actionlint/type-coverage normalize through the generic passthrough.
  - *Verification*: Added HADOLINT_BINARY (archived:false — raw executable assets hadolint-linux-x86_64 etc, pinned v2.14.0, per-asset <asset>.sha256 checksum file) + ACTIONLINT_BINARY (archived:true — actionlint_1.7.12_<os>_<arch>.tar.gz/.zip, release-wide actionlint_1.7.12_checksums.txt). Asset names + versions verified live against hadolint v2.14.0 and rhysd/actionlint v1.7.12 GitHub releases; hadolint .sha256 format confirmed as '<sha256> *<asset>'.
  - *Verification*: Extended BinarySpec.checksumsAsset to string | ((assetName)=>string) in binaryAcquisition.ts (single consumer updated) so hadolint's per-asset checksum file is derivable OS-agnostically — kept the ideal contract rather than baking a platform-specific string.
  - *Verification*: Added detectRustEcosystem/detectRubyEcosystem/detectDockerEcosystem/detectGithubActionsEcosystem to acquisitionEngine.ts (marker-file based, no language->tool table).
  - *Verification*: Tests added: tests/audit/analyzer-candidates.test.mjs (parse normal/malformed/empty + detect + buildArgv read-only + assetFor platform/arch->real asset incl unsupported->null for hadolint & actionlint); tests/audit/adapters-remediation.test.mjs (clippy/rubocop severity mapping + malformed-downgrade, schema-enum severity assertions); tests/audit/analyzer-acquisition-engine.test.mjs (each new id consent-gated: skipped + zero subprocess spawn without token).
  - *Verification*: COMMAND: npm run check => clean (tsc --noEmit, 0 errors).
  - *Verification*: COMMAND: node --import tsx/esm --test tests/audit/analyzer-candidates.test.mjs tests/audit/adapters-remediation.test.mjs tests/audit/analyzer-acquisition-engine.test.mjs => 87 pass / 0 fail.
  - *Verification*: COMMAND: node --import tsx/esm --test tests/audit/binary-acquisition.test.mjs => 12 pass / 0 fail (verified the checksumsAsset interface change did not regress existing binary acquisition).
- **CP-NODE-2**: knip graph cross-check: render-time join (normalized index + per-file fidelity gate)
  - *Verification*: Verified the claim: deriveGraphSignals (src/audit/extractors/graphSignals.ts:345) keys fanIn by RAW edge.to; render site dispatch.ts:365 has the full ArtifactBundle in scope with graph_bundle/surface_manifest/critical_flows/external_analyzer_results — all threadable. Claim holds.
  - *Verification*: Added pure render-time classifier src/audit/orchestrator/knipGraphCrosscheck.ts: normalizeNodeKey (backslash->/, strip ./, lowercase); buildKnipGraphIndex (normalized in-degree over allGraphEdges, entrypoints from surface_manifest.surfaces[].entrypoint + critical_flows.flows[].entrypoints only, analyzers_used set); analyzerIdForFile (reuses ANALYZER_REGISTRY.supports); classifyKnipLead → HAS-IMPORTERS/ENTRYPOINT/UNVERIFIED/LIKELY-DEAD. No new executor/obligation/schema field/persistence.
  - *Verification*: Wired render-time only: packetPrompt.ts renderTaskAnalyzerSignals tags knip leads (rule prefix 'knip-') inline as {graph-crosscheck: <TAG>}; buildTaskSections takes optional KnipGraphIndex; dispatch.ts builds the index once from bundle before the packet loop and passes it at the buildTaskSections call (formerly line 365). Degrades to un-annotated on missing artifacts.
  - *Verification*: tests/audit/knip-graph-crosscheck.test.mjs — pure classifier: CE-001 backslash/mixed-case → HAS-IMPORTERS; CE-003 analyzers_used=[typescript]+non-ts lead → UNVERIFIED; empty analyzers_used → UNVERIFIED; INV-K3 surface + critical-flow ENTRYPOINT-exempt; LIKELY-DEAD happy path; HAS-IMPORTERS beats entrypoint; degrade-to-empty (no throw).
  - *Verification*: tests/audit/dispatch-helpers.test.mjs — extended: buildTaskSections renders the {graph-crosscheck: LIKELY-DEAD} tag inline for a knip-exports lead.
  - *Verification*: Command: npm run check → clean (tsc --noEmit, zero errors).
  - *Verification*: Command: node --import tsx/esm --test tests/audit/knip-graph-crosscheck.test.mjs tests/audit/dispatch-helpers.test.mjs → tests 30, pass 30, fail 0.
- **CP-NODE-3**: remediate-code SKILL.md no-drift guard test
  - *Verification*: Verified claim: both .agent/skills/remediate-code/SKILL.md and skills/remediate-code/SKILL.md exist in the worktree and are byte-identical after LF-normalization (test passes GREEN on current tree).
  - *Verification*: Appended one vitest case to tests/remediate/install-repo-assets.test.ts (new describe block 'committed host-asset no-drift guard') asserting the committed installed .agent/skills/remediate-code/SKILL.md is byte-identical (LF-normalized via .replace(/\r\n/g,'\n')) to canonical skills/remediate-code/SKILL.md, both resolved from the existing PKG_ROOT = join(__dirname,'..','..'). Reads the committed installed asset directly via readFileSync (no ensureGlobalAssets/temp-dir render). expect(installed, <remedy message>).toBe(canonical) — RED on drift with a failure message naming the remedy ('Re-run remediate-code install (or regenerate the asset)'), mirroring audit-code's tests/audit/host-asset-renderer-drift.test.mjs installed-asset no-drift check.
  - *Verification*: npx vitest run tests/remediate/install-repo-assets.test.ts => PASS (1 file, 8 tests passed)
- **CP-NODE-4**: Validator: intra-result duplicate finding-id hard-reject
  - *Verification*: Verified claim: validateResultFindings (src/audit/validation/auditResults.ts ~865) had no intra-result finding.id dedup; only cross-packet warnOnDuplicateFindings and coverage-path dedup existed. Claim holds.
  - *Verification*: Added result-scoped seenFindingIds Set<string> seeded per result (mirroring seenCoveragePaths). Hard-rejects (severity error, field findings[<j>].id) a finding.id already seen among earlier siblings in the same result; compares only isNonEmptyString ids; message parity with the coverage-path dup hard error. No new exported symbol.
  - *Verification*: npm run check → clean (tsc --noEmit, zero errors).
  - *Verification*: node --import tsx/esm --test tests/audit/validation-remediation.test.mjs → tests 40, pass 40, fail 0. Includes 3 new CP-NODE-4 tests: distinct ids → zero issues; shared id in one result → exactly one error at findings[1].id; same id across different results → not flagged.
- **CP-NODE-5**: Churn/context/enforce review pass (discovery-only, serialize-last)
  - *Verification*: Discovery-only pass; no source edits applied (sole writes: docs/reviews/churn-context-enforce-pass-2026-07-02.md + docs/backlog.md follow-on lines).
  - *Verification*: Output existence check: `node -e "require('fs').accessSync('docs/reviews/churn-context-enforce-pass-2026-07-02.md')"` -> OUTPUT_EXISTS_OK.
  - *Verification*: N1 VERIFIED (churn): analyzerSignalAnchorsForPath re-flattens+filters full externalAnalyzerResults set (src/audit/orchestrator/fileAnchors.ts:150-169); called per-path in renderTaskAnalyzerSignals (src/audit/cli/dispatch/packetPrompt.ts:176-178) and per-task in buildTaskSections (packetPrompt.ts:207,220) -> O(tasks x files x results); no per-dispatch path index present.
  - *Verification*: N4 VERIFIED (context): renderTaskAnalyzerSignals emits all signal lines uncapped/full-detail (packetPrompt.ts:182-194) vs sibling anchor preview .slice(0,24) (packetPrompt.ts:28); upgraded PLAUSIBLE->VERIFIED on post-merge tree.
  - *Verification*: Grounded against churn-context-enforce-pass-2026-06-27.md and backlog remainder entry (backlog.md:200-209); did not re-surface C3/C5/C6/E4/E5 or X-cluster.
  - *Verification*: Two actionable follow-ons appended to docs/backlog.md as separately-scoped one-liners.

## Closing Action

Action: none
Status: skipped

## Remediation Outcomes

Of 5 finding(s): 5 resolved, 0 verified already correct, 0 deemed inappropriate, 0 ignored, 0 blocked.

By lens:
- security: resolved 5
