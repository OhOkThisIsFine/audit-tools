# Drift consolidation plan — unite the reinvented pieces

A cross-package map of code that is **duplicated or reinvented** across
`@audit-tools/shared`, `audit-code`, and `remediate-code` and should instead be
programmatically connected (single-sourced in `shared`, or generated from one
authority). Produced 2026-06-15 by a 6-way parallel recon sweep; every `file:line`
and zero-importer claim was grep/Read-verified against current `src`.

> **Status — landed 2026-06-15 (the "quick and easy" hand-batch):** the live merge-trap
> bug (R2 bug part — `idRegistry.ensureNodeId`, +regression test), `AccessDeclaration`
> dedup (P3), `mintUniqueId` extraction (P5), and the CLAUDE.md lock doc-fix. All green
> (shared / remediate 1524 / audit). **Everything else below remains** for a later
> session — the finding-identity *authority* (R2 authority part), R1/R3, E1–E5, G1, and
> primitives P1/P2/P4/P6/P7/P8/P9.

This is the standing failure mode the repo keeps hitting: a concept gets extracted
to `shared`, then a second copy is hand-written in an orchestrator and the two
silently diverge. The governing invariant (CLAUDE.md): *genuinely shared logic →
`@audit-tools/shared`; keep the orchestrators in parity; enforce correctness in
tooling, never host discretion.* Each item below is a place that invariant is
currently violated.

> **Overlap with `backlog.md`.** Three items here are already tracked there with
> decisions made — the dormant rolling engine (*Self-audit 2026-06-15 → "Dispatch
> is host-waved"*, decision: wire it in), the IDE-renderer drift (*".gemini toml
> continuation drops `--host-models`"* + memory `universal-host-prompts-single-source`),
> and the implement-worker `finding_id` trap. They are referenced here for a complete
> picture but owned by the backlog. **Everything else below is new** and not yet
> tracked.

## How to read this

Each finding: **locations** (verified), **what drifted**, **fix** (extract/connect),
**confidence**, **effort** (S ≈ <1h mechanical, M ≈ a focused session, L ≈ a redesign
slice). Findings the sweep *cleared* as legitimately-separate are listed at the end so
they are not re-investigated.

Atomic-replace invariant applies to every deletion: new shared mechanism + removal of
the copies ship in **one** commit, never add-then-delete across commits.

---

## Tier 1 — structural roots (fix these; they are why drift recurs)

### R1. Dispatch is reinvented as host-fanned waves; the shared rolling engine has zero `src` callers
- **Locations:** `shared/src/dispatch/rollingDispatch.ts` (`createRollingDispatcher`), `shared/src/quota/rollingEngine.ts`, `shared/src/rolling/pausedState.ts` — wrappers `audit-code/src/orchestrator/rollingDispatch.ts:59` (`runRollingDispatch`) and `remediate-code/src/steps/nextStep.ts:422` (`driveRollingDispatch`) — live paths `audit-code/src/cli/dispatch/quotaPool.ts:201-255` + `remediate-code/src/steps/dispatch.ts:1376`.
- **Drift:** A complete, tested, packet-agnostic rolling scheduler exists with a per-package adapter on each side — and **nothing in `src` calls any of it** (`createRollingDispatcher`/`runRollingDispatch`/`driveRollingDispatch` appear in `src` only at their own definition sites; `dropProvider`/`reroutePackets`/`advancePausedState` have zero `src` matches). The live path in *both* orchestrators instead computes a single `max_concurrent_agents` number via the shared quota layer, writes it to an artifact, and hands the concurrency loop to the host. So the *schedule* math is shared (good) but the *execution loop* (queue, in-flight tracking, dispatch-next-on-complete, 429 re-queue) is reinvented as host wave-fanning — the exact thing the unused engine implements.
- **Fix:** Already decided in backlog (wire the engine in, atomic-replace the host-wave fallback). Both adapters + the `computeDependencyLevels` level-builder already exist; this is wiring, not new design. Host-can't-spawn-subagents is handled by the engine's `maxConcurrentPerPool: 1` mode. See backlog *Self-audit 2026-06-15* for the full step plan.
- **Confidence:** high — **Effort:** L — **Owner:** backlog (ARC-f378135d)

### R2. No shared finding-identity authority — three divergent "same finding" rules + a live merge-trap bug
- **Locations:** canonical-by-doc but **unused** `shared/src/types/finding.ts:157` (`findingIdentity()`, exported at `index.ts`; imported by no orchestrator `src` — only shared tests). Three independent identity rules: audit `reporting/findingIdentity.ts:96` (`findingIdentitySignature`: 3-tier `anchor|rule|title` ladder → sha256 → `<LENS>-<8hex>`), remediate `dedup/crossLensDedup.ts:58` (group by path, then `category` eq + title Jaccard ≥0.4 + path overlap ≥0.5), remediate `coverage/findingLedger.ts` (bare `id` string as map key, no normalization).
- **Live bug (verified):** `remediate-code/src/steps/contractPipeline.ts` derives a node's id **three ways for the same node**. Finding id uses a fallback — `:1579` `const id = node.id ?? \`CP-${index+1}\``; `nodeIdSet` (`:1635`) and `traceability` (`:1641`) use it too. But the block built from the same node uses **raw** `node.id`: `:1658` `block_id: toBlockId(node.id)`, `:1659` `items: [node.id]`. `node.id` is typed `string` but comes from an unchecked `as` cast of an LLM envelope (`:1546`), so it can be `undefined` at runtime (the `?? CP-` fallbacks elsewhere prove the authors expect that). A missing id then yields finding `CP-001` but block `CP-BLOCK-undefined` / `items: [undefined]` → `fromBlockId` returns `"undefined"`, not in `knownFindingIds`, so the result lands in `unresolved`. This is a fresh instance of the finding↔block merge-trap class.
- **Fix:** (a) **Immediate bug fix (S):** mint the node id **once** at the top of the `.map()` and route that single value into the finding id, `nodeIdSet`, `traceability`, `toBlockId(...)`, and `items` — or, better, give `idRegistry.ts` an `ensureNodeId(node, index)` so the fallback rule lives beside `toBlockId`/`fromBlockId` it must stay consistent with; validate the `:1546` cast. (b) **Authority (M):** promote audit's `findingIdentitySignature` + `normalizeAnchorPath`/`normalizeTitle` into `shared` as the one identity-signature function; have remediate's dedup use that exact-match key (its Jaccard/overlap heuristic stays as a fuzzy layer on top); make `findingIdentity()` delegate to it or delete it as misleading dead code.
- **Confidence:** high — **Effort:** S (bug) + M (authority)

### R3. Step-contract writer duplicated across both orchestrators with real path-separator drift
- **Locations:** audit `audit-code/src/cli/steps.ts:50-119` (`StepArtifact` + `writeCurrentStep`) vs remediate `remediate-code/src/steps/stepWriter.ts:30-87` (`writeCurrentStep`) + `steps/types.ts:35` (`RemediationStep`). Shared owns only the `StepStatus` primitive (`shared/src/types/stepContract.ts`).
- **Drift:** Both independently define the same step-contract object and a writer doing the same six things (mkdir `steps/`, write `current-prompt.md`, build the contract object, `writeJsonFile` `current-step.json`), with the `stepsDir`/`currentStepPath`/`currentPromptPath` helpers duplicated verbatim. **Real behavioral divergence, not cosmetic:** remediate normalizes every host-facing path through `toPromptPathToken` (backslash→forward-slash, Windows-safe) for `prompt_path`/`repo_root`/`artifacts_dir`/all `artifact_paths`; audit writes them **raw**. So on Windows the two emit step contracts with different path conventions for the same fields — and audit's raw write violates the standing "host prompts are cwd-explicit / Windows-aware" invariant. Audit also has a "computed paths win" merge guard (`steps.ts:107`) that remediate lacks.
- **Fix:** Promote `BaseStepContract` + `writeStepContract(...)` to `shared` (beside `StepStatus`), owning the `steps/` filenames, the mkdir+prompt-write+`writeJsonFile` sequence, the `toPromptPathToken` normalization of all path fields, and the canonical-paths-win merge. Each package extends with its own `step_kind` enum / optional fields. This is the shared *product surface* — currently written by two drifting code paths.
- **Confidence:** high — **Effort:** M

---

## Tier 2 — clear extractions (single, well-scoped moves)

### E1. IDE host-asset renderers: 3-of-4 author bespoke drifting prose; remediate ships none
- **Locations:** `audit-code/audit-code-wrapper-install-renderers.mjs:20-77` (VSCode/Codex/Antigravity, bespoke prose) vs `:84-97` (`renderGeminiCommandToml`, derives from canonical body). Remediate: no per-IDE renderers at all (`scripts/postinstall.mjs` / `src/index.ts` write raw bodies only).
- **Drift:** Only the Gemini renderer derives from the one canonical prompt body; the other three hand-author per-IDE prose that has already drifted (omitting the next-step/capability handshake). Worse, the two orchestrators don't even agree on which host assets exist.
- **Fix:** Move host-asset rendering into `shared` as `renderHostAsset(kind, { promptBody, skillBody, toolName, root })`; every kind derives from the passed body (the VSCode/Codex/Antigravity bodies become thin frontmatter wrappers, like the Gemini TOML already is); parameterize the bin name so both orchestrators share renderers. Add a no-drift guard test (committed rendered asset == freshly rendered).
- **Confidence:** high — **Effort:** M — **Owner:** backlog (`.gemini toml` item) + memory `universal-host-prompts-single-source`

### E2. The allowlisted read-only command runner lives only in audit-code — but it is a tool-wide security policy
- **Locations:** `audit-code/src/validation/anchorGrounding.ts:33-156` (`ANCHOR_ALLOWLIST`, `GIT_READONLY_SUBCOMMANDS`, `isAllowedAnchorCommand`, `defaultAnchorRunner` with spawn + 60s timeout + SIGTERM/SIGKILL + bounded capture + env-strip). Shared has only generic `tooling/exec.ts:236` (`runTracked`, no allowlist); remediate has `utils/commands.ts` (no allowlist).
- **Drift:** "Run a model-authored command safely" is a **new trust surface** (ingest now executes model-authored commands). The security-critical allowlist/read-only-git gate/kill-switch exists in exactly one package. Per the repo's own "enforce in tooling, never host discretion" invariant, a security policy must not be re-decided (or absent) per package — remediate cannot safely ground a behavior claim today.
- **Fix:** Extract `shared/src/tooling/allowlistedExec.ts` owning the allowlist + the async spawn-with-timeout/kill runner (reusing shared `resolveExecArgv` + `stripClaudeCodeEnv`). audit's `verifyFindingAnchor` consumes it; remediate gains it for free.
- **Confidence:** high — **Effort:** M

### E3. Quote-and-verify grounding (re-read source, content-match `quoted_text`) lives only in audit-code
- **Locations:** `audit-code/src/validation/quoteGrounding.ts:25-86` (`normalizeForMatch`, `quoteMatches`, `verifyFindingGrounding`). The `FindingGrounding` type and the `FindingLocation.quoted_text` field with its JSDoc contract already live in `shared/src/types/finding.ts` — but only audit-code honors them. Remediate's `phases/grounding.ts` grounds by path-existence + evidence-citation only; it never reads `quoted_text`.
- **Fix:** Move `verifyFindingGrounding` + `normalizeForMatch` + `quoteMatches` to `shared/src/validation/findingGrounding.ts` (the type is already there). Remediate runs the same quote-verify before fixing; its phantom-path/evidence-citation pass stays as a free-form-only extension. (Naming nit: remediate's unrelated `contractPipelineGates.ts:813` also has a `normalizeForMatch` with *different* rules — rename one for intent so a reader can't assume they agree.)
- **Confidence:** high — **Effort:** M

### E4. `ClaudeCodeProvider` / `OpenCodeProvider` duplicated per-orchestrator with accidental drift
- **Locations:** `audit-code/src/providers/claudeCodeProvider.ts` ≈ `remediate-code/src/providers/claudeCodeProvider.ts` (and the two `opencodeProvider.ts`). ~90% identical.
- **Drift:** Three divergence axes, only one principled. (1) **Prompt delivery — drift:** audit passes the prompt as argv (`[promptFlag, prompt, …]`); remediate pipes via `stdinText`. (2) **skip-permissions default — legitimate:** audit opt-in, remediate opt-out (unattended). (3) **stderr diagnostics — drift:** audit emits `provider_launch`/`provider_done`, remediate emits nothing. Axes 1 and 3 are unjustified and are *pinned by two separate test suites*, cementing the divergence. Every heavy primitive these wrap (`spawnLoggedCommand`, `applyWorkerTaskLaunchSettings`, `resolveOpenCodeSpawnCommand`, plus `LocalSubprocessProvider`/`CodexProvider`) is already shared.
- **Fix:** Decide the intended prompt-delivery + diagnostics behavior (likely stdin + diagnostics for both), then promote both classes to `shared`, parameterized by `{ promptDelivery, skipPermissionsDefault, emitDiagnostics, sessionConfigPath }`. Each `providers/index.ts` already injects via factory deps, so call sites barely move; the per-orchestrator delta collapses to the one skip-permissions default.
- **Confidence:** high — **Effort:** M

### E5. audit-code `headerExtractors/*` reinvents shared `errorParsers/*`
- **Locations:** `audit-code/src/quota/headerExtractors/{index,genericHeaderExtractor,claudeCodeHeaderExtractor}.ts` mirror `shared/src/quota/errorParsers/{index,genericErrorParser,claudeCodeErrorParser}.ts` 1:1 (same provider-keyed-strategy family: `interface { name; op(text) }`, a generic delegating impl, a claude-code impl, a `Record<provider, T>` factory with generic fallback). Both claude-code variants scan stderr for claude-code JSON lines with near-identical loops.
- **Note:** The header *axis* staying audit-only is by design (seam-test-enforced). What drifted is the *pattern reinvention*.
- **Fix:** Extract a shared `makeProviderKeyedFactory<T>(record, fallback)` primitive both factories build on; and/or a shared `collectClaudeCodeJsonLines(stderr)` helper both claude-code strategies call (kills the most fragile copy — the JSON-line scan).
- **Confidence:** high — **Effort:** S

---

## Tier 3 — small primitives reinvented N times (cheap, high-certainty, kill latent divergence)

### P1. Model-tier ordinal `{ small, standard, deep }` reinvented 3–5×
- **Locations:** `remediate-code/src/steps/dispatch.ts:164` **and again** `:854` (local `rankOrder`); `audit-code/src/cli/dispatch/quotaPool.ts:224` (`rankOrder`); `shared/src/dispatch/rollingDispatch.ts:212` already has `DISPATCH_TIER_RANK`; `shared/src/quota/scheduler.ts` has `HOST_MODEL_RANKS`. The `DispatchModelTier` *type* is single-sourced; its *ordering* is not.
- **Fix:** Export `DISPATCH_TIER_RANK` / `compareTier(a,b)` / `mostCapableTier(tiers)` from `shared` beside the type; replace all local `{small:0,standard:1,deep:2}` maps and ad-hoc reducers. Serves the no-hardcoded-models invariant (tier ordering in one place).
- **Confidence:** high — **Effort:** S

### P2. Severity / confidence rank tables — 5 copies, 2 divergent value schemes (latent bugs)
- **Locations:** canonical `critical=5…info=1` in `audit-code/src/reporting/findingRanks.ts:3`, `audit-code/src/orchestrator/selectiveDeepening/shared.ts:22`, `remediate-code/src/dedup/crossLensDedup.ts:35`. **Divergent:** `shared/src/agentReflections.ts:43` uses `critical=4…info=0` (off-by-one); `remediate-code/src/intake.ts:301` uses an **inverted** `critical=0…info=4`. Confidence rank `{high:3,medium:2,low:1}` likewise duplicated 3×.
- **Fix:** Add `severityRank` / `confidenceRank` / `severityCompare` to `shared` beside `Finding`. Replace all sites; `intake.ts` sort becomes `severityRank(b) - severityRank(a)`. Confirm whether `agentReflections`' 0–4 scale is intentional (almost certainly not) — the value drift is a latent ordering bug.
- **Confidence:** high — **Effort:** S

### P3. `AccessDeclaration` type declared 3× identical; the shared export is unused
- **Locations:** canonical `shared/src/types/accessDeclaration.ts:1` (exported `index.ts:31`, **imported by no `src`**); re-declared byte-identically at `remediate-code/src/steps/types.ts:53` and `audit-code/src/types/workerSession.ts:4`; both packages import their *local* copy.
- **Fix:** Delete both local declarations; re-point to the shared type. Pure deletion + import change; the latent failure mode is the next time one side adds a field.
- **Confidence:** high — **Effort:** S

### P4. Atomic JSON write reinvented inline — and double-applied in the run ledger
- **Locations:** canonical `shared/src/io/json.ts:86` (`writeFileAtomic` / `writeJsonFile` = temp + `withFsRetry(rename)` + `rm` finally). Re-implemented inline at `remediate-code/src/state/store.ts:211` (`_writeStateLocked`, imports shared `withFsRetry` but not the write helper). **Double-applied** at `audit-code/src/supervisor/runLedger.ts:159` — calls `writeJsonFile(temp)` (which itself does temp+rename) then renames *again* onto the target. Three different temp-name schemes + a trailing-newline inconsistency (shared appends `\n`, store does not).
- **Fix:** Both call sites need write-while-holding-the-lock — which `writeJsonFile` already supports (its temp name is unique). Collapse both to a single `await writeJsonFile(path, value)`, deleting `tempStatePath`/`buildTempLedgerPath` and the inline rename/rm + the ledger double-rename.
- **Confidence:** high — **Effort:** S

### P5. `mintUniqueId` `-N` collision-suffix loop duplicated
- **Locations:** `audit-code/src/reporting/findingIdentity.ts:165` ≡ `remediate-code/src/contractPipeline/derive.ts:270` (`mintId`) — same `Set<string>`-backed, `-${n}`-starting-at-2 disambiguation.
- **Fix:** One `mintUniqueId(base, used)` in `shared`. Behaviorally identical today; the value is preventing future suffix-convention divergence (which would break round-trip parsing on one side).
- **Confidence:** high — **Effort:** S

### P6. Content hashing (`sha256`) in 3+ places with inconsistent slice lengths
- **Locations:** `audit-code/src/orchestrator/fileIntegrity.ts:16`, `audit-code/src/extractors/fsIntake.ts:52`; `remediate-code/src/utils/fileIntegrity.ts:38`, `remediate-code/src/intake.ts:136` (`.slice(0,16)`), `remediate-code/src/contractPipeline/artifactStore.ts:111` (8-hex). Two files literally named `fileIntegrity.ts` with overlapping logic; slice lengths full / 16 / 8.
- **Fix:** A shared `hashContent(content, { length? })` primitive — the obvious next member of the shared byte-utility surface alongside `estimateTokensFromBytes`.
- **Confidence:** med — **Effort:** S/M

### P7. Repo-path normalization triplicated
- **Locations:** `audit-code/src/validation/designFindingGrounding.ts:18` (`normalizeRepoPath`), `audit-code/src/orchestrator/fileAnchors.ts:119` (`normalizePath`, minus `.toLowerCase()`), and remediate's `resolveAffectedPath`. Same "trim, backslash→slash, strip `./`" intent, subtly different.
- **Fix:** One `normalizeRepoPath` in `shared`; all three call it. (Folds in nicely when E3's grounding moves to shared.)
- **Confidence:** high — **Effort:** S

### P8. `.audit-tools/<half>` path resolution duplicated — and audit-code's default ignores `--root`
- **Locations:** audit `audit-code/src/cli/args.ts:16,183` resolves `--artifacts-dir` (default `.audit-tools/audit`) and `--root` **independently against CWD** — so `audit-code --root /repo` (no `--artifacts-dir`) writes under **CWD**`/.audit-tools/audit`, not the repo. Remediate `src/index.ts:397` (`resolveArtifactsDirOption`) explicitly rebases its default onto `--root`. Sub-paths (`steps/`, `intake/`, `incoming/`) are assembled with raw `join` literals scattered across both.
- **Fix:** A shared path module (`auditToolsDir(root)`, `auditArtifactsDir(root)`, `remediationArtifactsDir(root)`, `stepsDir`/`incomingDir`). Both CLIs resolve through it → identical `--root`-rebasing + the `.audit-tools` literal lives once. Also fixes audit-code's likely-latent CWD bug under the conversation-first "no manual flags" invariant.
- **Confidence:** high (literals) / med (whether audit's non-rebasing is intended) — **Effort:** M

### P9. Dispatch-prompt tail + `model_hint.tier` mapping prose hand-duplicated
- **Locations:** tier-mapping instruction at audit `src/cli/prompts.ts:107,270` vs remediate `src/steps/nextStep.ts:1591`; the "read plan + maintain `max_concurrent_agents` + merge + next-step" tail re-authored in audit `renderRollingDispatchPrompt` / `renderDispatchReviewPrompt` and remediate's `dispatch_implement`. Two of the dispatch notes (`DISPATCH_PROMPT_HANDOFF_NOTE`, `DO_NOT_TOKEN_WRAP_NOTE`) are *already* shared — the pattern exists, just not extended here.
- **Fix:** Add `MODEL_HINT_TIER_NOTE` + `renderDispatchTail({ mergeCommand, continueCommand })` to `shared/src/prompts.ts`; both builders compose from these. Host-facing prose that must stay behaviorally identical (auditor-agnostic-robustness) → highest drift-risk of the small items. (Likely subsumed by R1 wiring.)
- **Confidence:** high — **Effort:** M

---

## Cross-tool contract gap (a seam drift, not a copy)

### G1. The remediator ignores the auditor's grounding/quarantine verdict
- **Locations:** producer `audit-code/src/cli/mergeAndIngestCommand.ts:334` sets `finding.grounding` and the report-level `grounding_status_breakdown`. Consumer `remediate-code/src/phases/plan.ts:933` runs grounding for LLM-extracted findings **only** — it imports the `FindingGrounding` type but never reads `finding.grounding` on the structured `audit-findings.json` path (no `grounding`/`quarantin` match in remediate intake).
- **Drift:** A finding the auditor explicitly quarantined as *ungrounded-but-surfaced* flows into remediation as if confirmed — the quarantine signal is silently dropped at the package boundary. The shared `FindingGrounding` / `grounding_status_breakdown` contract is written by one end and ignored by the other.
- **Fix:** Remediate intake reads `finding.grounding` (and/or re-runs shared `verifyFindingGrounding` from E3 against the working tree) so quarantined findings are visibly triaged, not fixed blindly.
- **Confidence:** high — **Effort:** S (surface) / M (re-verify)

---

## Proposed shared surface (the consolidated picture)

What `@audit-tools/shared` *should* own after this plan, grouped by concern:

- **IDs & identity:** `mintUniqueId` (P5), `severityRank`/`confidenceRank`/`severityCompare` (P2), `dispatchTierRank`/`compareTier` (P1), a finding-identity-signature authority + `findingIdentity()` delegating to it (R2), `ensureNodeId` beside `toBlockId`/`fromBlockId` (R2 bug).
- **IO & paths:** `writeJsonFile` as the *only* atomic writer (P4), `hashContent` (P6), `normalizeRepoPath` (P7), a `.audit-tools` path module (P8).
- **Grounding:** `verifyFindingGrounding` quote-verify (E3), the allowlisted command runner (E2) — both consumed by audit *and* remediate, with remediate also honoring `finding.grounding` (G1).
- **Step contract:** `BaseStepContract` + `writeStepContract` with path normalization (R3).
- **Host assets & prompts:** `renderHostAsset` family deriving from one body (E1), `MODEL_HINT_TIER_NOTE` + `renderDispatchTail` (P9).
- **Providers:** shared `ClaudeCodeProvider`/`OpenCodeProvider` parameterized by options (E4); a `makeProviderKeyedFactory` + `collectClaudeCodeJsonLines` (E5).
- **Dispatch execution:** wire the existing rolling engine into both live paths (R1).

## Suggested sequencing

1. **Wave 0 — mechanical, independent, low-risk (one session):** P3, P1, P2, P4, P5, P7, plus the R2 *bug* fix and the CLAUDE.md doc fix below. Pure extractions/fixes; each kills a latent divergence and has near-zero blast radius. Add a guard test per primitive (asserting the single source).
2. **Wave 1 — identity & grounding authority:** R2 (finding-identity authority), E2 + E3 + G1 (grounding moves to shared and both ends consume it), P6, P9.
3. **Wave 2 — product surfaces:** R3 (step writer), E1 (host renderers), E4 + E5 (providers), P8 (artifact paths).
4. **Wave 3 — architectural:** R1 (wire the rolling engine; biggest, atomic-replace, owned by backlog).

Each wave ends green (`npm run build -w @audit-tools/shared && npm run build && npm run check`) per the green-at-every-commit hook.

---

## Cleared — legitimately separate (do NOT re-investigate)

- **`providers/constants.ts` ×3 and `quota/hostLimits.ts` ×3** — already unified: re-export shims / 21-line adapters binding only a distinct `ENV_PREFIX` over a single shared definition. Seam-test-enforced. (`hostLimits` is *collapsible* to a `makeHostLimits(prefix)` factory but it's cosmetic, ~15 lines.)
- **File locking** — already unified: `remediate-code/src/state/store.ts` uses shared `withFileLock`/`STALE_LOCK_MS`; no hand-rolled backoff remains. The known stale-lock-steal race is tracked separately in backlog. **Doc fix:** CLAUDE.md still describes store.ts's lock as "20ms initial backoff, 250ms max, 20 retries" — stale; the live code is the shared 50ms→500ms backoff / `STALE_LOCK_MS=30s`.
- **Token estimation** — single-sourced `estimateTokensFromBytes` + constants; no ad-hoc `/4` math, no tokenizer dep. (`reviewPacketSizing.ts` re-exports the shared constants.)
- **Chunking** — `audit-code/src/orchestrator/chunking.ts` is audit-only line-range splitting; remediate operates on finding/block granularity. No second consumer → not worth pre-emptive hoisting.
- **`mapWithConcurrency`** — correctly shared and used at ingest/grounding; dispatch correctly needs the richer rolling engine (R1), not this primitive.
- **Prompt-scaffolding primitives** — `renderPromptCommand`, `buildCacheablePrompt`, the two dispatch notes, `renderProcessFeedbackSection` are all shared and consumed by both. Inline prompt *bodies* are content-specific, not duplicated helpers.
- **`designFindingGrounding.ts`** — despite the "S7 applied to the reviewer" framing, it is NOT a copy of `anchorGrounding.ts`: it runs no commands, just checks a conceptual finding's path against the manifest. Different mechanism per finding class; only the path normalizer overlaps (→ P7).
