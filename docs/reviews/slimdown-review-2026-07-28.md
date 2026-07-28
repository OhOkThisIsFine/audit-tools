# Codebase slim-down review — 2026-07-28

Subject: `audit-tools` @ 0.34.33, HEAD `63648eb2`.
Corpus: `src/` 128,872 lines / 522 `.ts`; `tests/` 13,843 lines / 587 files; `scripts/` 8,922 lines `.mjs`.
Method: 8 parallel dimensions (god-files, audit↔remediate duplication, dead code, over-abstraction,
knob sprawl, redundant guards, scripts/hooks/tests, legacy paths), each grep- and Read-verified
against source; a subset then re-checked by an adversarial verifier that corrected line estimates
downward and refuted several premises.

## Status vocabulary

Every item below carries one tag. The verifier pass did not reach every candidate.

| Tag | Meaning |
|---|---|
| **CONFIRMED** | Independently re-verified against source; mechanism and (corrected) size hold. |
| **PARTIAL** | Mechanism holds, but the verifier corrected the estimate, the endpoint, or the risk. Corrected numbers are used throughout. |
| **UNVERIFIED** | Author-verified by grep/Read against source, but no independent refutation pass ran. Treat the mechanism as a strong lead and re-confirm the greps before deleting. |

All line numbers below are **corrected** figures where a verifier shrank a claim. No claimed-but-shrunk
estimate survives in the totals.

---

## 1. Bottom line

**≈9,400 lines are genuinely removable — roughly 5,400 from `src/` + `scripts/` and ~4,000 from
`tests/` — against a ~151,600-line corpus, so about 6%.** That is a real number, not a rounding of
"this looks complicated": every line is attached to a named file, a named symbol, and a mechanism.

The bloat concentrates in three places, and they are not evenly sized:

1. **Parked infrastructure that was built, tested, exported, and never wired** — ~5,300 lines, 56% of
   the total. The F3/O3/F4 emit-validate-repair seam alone is ~2,200 lines (934 production + ~1,300
   test) with **zero** production callers. Six audit adapters, a whole `waveManifest.ts`, the
   contract-pipeline reconvergence cluster, the intake digest builders, and three superseded facades
   are the same story. `knip --production` cannot see any of it: its entry set is
   `src/audit/index.ts`, `src/remediate/index.ts` and `scripts/**`, and it reports unused *exports* —
   so a module whose every export is consumed by its own test, or by a sibling in the same dead
   subgraph, never surfaces. **Whole-file orphan detection over the relative-import graph, filtered
   to "referenced only from `tests/`", found all of it in one pass** and should become a periodic
   check beside the manual `knip --production` sweep CLAUDE.md already describes.
2. **The audit↔remediate provider/quota fork** — ~1,055 lines including the ~490 lines of parity
   tests that exist only to police it. There is no declared `OrchestratorMode` identity anywhere in
   the repo, so every per-mode constant (env prefix, session-config path, slash command,
   skip-permissions default) is re-declared at the site that needs it, and each site grew a shim
   module to hold it. This is the textbook case CLAUDE.md's *one core, two draws* rule names.
3. **Hand-restated tables and copy-pasted skeletons** — ~1,700 lines across six god-files and the
   validators. One concept, the six omittable host gates, is restated in **four** places. The artifact
   required-key list is a second hand-maintained copy of `ARTIFACT_DEFINITIONS`. The path-check
   provider guard is pasted three times and the missing fourth paste is a live coverage gap (`agy` is
   never PATH-validated).

The remaining ~1,300 is legacy paths past their own sunset dates, dead config knobs advertised to
operators in the guide, and scripts/tests substrate (17 inline `withTempDir` copies, ~20 hand-rolled
temp-git-repo scaffolds, two byte-identical `verify-hosts.mjs` files).

**One structural observation matters more than any single item:** at least four of the largest finds
are guarded by a *drift test* rather than by extraction —
`tests/audit/seam-provider-quota-instantiation-parity.test.mjs` (382 lines),
`tests/remediate/f4-brokered-core-parity.test.ts` (108),
`tests/audit/file-lock-doc-sync.test.mjs` (68), and the E1 block of
`tests/audit/host-asset-renderer-drift.test.mjs`. The repo's own memory
(`prefer-extraction-over-drift-tests`, `lockstep-comments-are-the-duplication-tell`) names this exact
pattern. Extracting the subject deletes the test as a side effect.

---

## 2. Do these first

CONFIRMED items only, ranked by value-to-risk. Every one is behavior-neutral unless marked.

### 2.1 — F3/O3/F4 emit-validate-repair seam: wire it or delete it (~2,200 lines) — **CONFIRMED**

**Owner decision required before any code moves.** This is 23% of the whole finding.

- Delete: `src/shared/repair/emitValidateRepair.ts` (358), `src/shared/repair/brokeredDispatch.ts`
  (332), `src/shared/repair/index.ts` (34), `src/audit/contracts/schemaEnforcedEmit.ts` (210) = **934
  production lines**; the re-export block at `src/shared/index.ts:715-742`; and ~1,300 test lines:
  `tests/audit/f3-schema-enforced-generation.test.mjs` (760),
  `tests/remediate/cross-node-seam-signature-guard.test.ts` (241),
  `tests/shared/emit-validate-repair.test.mjs` (276),
  `tests/shared/brokered-dispatch-no-disk-io.test.mjs` (73), plus ~25 broker-construction sites in
  `tests/remediate/wave-scheduler.test.ts:537-1490` (surgical edit — that file also covers `scheduleWave`,
  `classifyProvider` and the cold-start floor, which are live).
- **Mechanism:** `enforceSchemaAtEmit` (`schemaEnforcedEmit.ts:156`) is the only consumer of
  `runEmitValidateRepair` / `createBrokeredRepairDispatch`, and it has zero production callers.
  `estimateSlotTokens` and `classifyCapableHost` likewise. The live audit worker-result path uses
  `src/audit/contracts/workerSchemas.ts` directly (`src/audit/cli/rollingAuditDispatch.ts:69` →
  `renderWorkerJsonSchema`). Remediate has its own **live** repair loop that never touches this seam
  (`src/remediate/steps/contractPipeline.ts:1935`, `:2071`), so deleting removes no running capability.
- **Risk:** `docs/backlog/forward-tracks.md:213` names `enforceSchemaAtEmit` as the CE-004 "repair
  floor" for backends with no API-level constraint hook. That claim is **false against HEAD** and must
  be corrected either way. If the forward track is still wanted, the fix is the opposite of deletion —
  wire it into the rolling-dispatch emit path. The one state that should not persist is the current
  one: tested, documented, unreachable. Also correct the stale pointer at
  `src/shared/quota/scheduler.ts:179`.

### 2.2 — Collapse the two `providers/` directories onto one per-mode policy record (270 src + ~490 test) — **CONFIRMED**

- Delete: all 12 files under `src/audit/providers/` and `src/remediate/providers/` (verified 303 lines
  exactly: audit 32+38+25+5+45+6=151, remediate 33+39+26+1+47+6=152), plus
  `FreshSessionProviderDeps` (`src/shared/providers/providerFactory.ts:387-421`) and its four
  `deps.createX` branches (`:496,507,516,518`). Add back ~30 lines: one frozen `OrchestratorPolicy`
  record per mode.
- **Mechanism:** the entire information content of the injection is **four scalars** —
  `skipPermissionsDefault` (audit `false` / remediate `true`), `sessionConfigPath`, `slashCommand`,
  `orchestratorName`. Every provider *class* is already single-sourced in `src/shared/providers/`.
  `opencodeProvider.ts` is byte-identical on both sides and both `index.ts` wrap it in an identity
  closure `(config) => createOpenCodeProvider(config)` — an injection point with no injectable.
- **Test lines freed:** `tests/audit/seam-provider-quota-instantiation-parity.test.mjs` (382, loses its
  subject entirely — clauses 2/3/4/8/9/10), `tests/remediate/f4-brokered-core-parity.test.ts` (108),
  plus `tests/shared/shared-core-invariants.test.mjs` INV-shared-core-03 (:158) and -14 (:646).
  Retarget `tests/audit/providers-remediation.test.ts` / `tests/remediate/providers.test.ts` and the
  4 allowlist entries at `tests/shared/audit-tools-path-guard.test.mjs:82-97` (they collapse to 1).
- **Risk:** medium-mechanical, low-semantic. `skipPermissionsDefault`'s polarity is the one delta with
  runtime teeth and must be carried as data. No production module imports the per-orchestrator
  provider *class* re-exports, so no dangling imports. Two side-findings surfaced and must be
  **reported, not buried**: `FreshSessionProviderDeps.runLogger` (`:420`) is a fifth injection point
  neither wrapper supplies, so the structured `provider_launch` event at `:460` never fires in
  production; and both wrappers narrow `resolveFreshSessionProviderName`'s options type, silently
  barring the `uiMode` axis (see §5).

### 2.3 — One host-gate emit table in `nextStepCommand.ts` (~85) — **CONFIRMED**

- Merge six arms: `src/audit/cli/nextStepCommand.ts` charter_extraction 932-965, charter_delta
  967-999, charter_clarification 1001-1036, systemic_challenge 1038-1095, critical_flow_fallback
  1423-1464, synthesis_narrative 1467-1505 (242 lines).
- **Mechanism:** every arm runs the identical sequence — `mkdir(incoming)` → `nextStepCommand(root,
  artifactsDir, hostDescriptor)` → `submissionPath` join → `writeCurrentStep({... status:"ready",
  runId:null, allowedCommands:[continueCommand] ...})` → `console.log(JSON.stringify(step,null,2))` →
  `return`. Six data fields differ.
- **Endpoint:** `HOST_GATE_EMITS: Record<GateKind, {filename, artifactPathKey, stopCondition,
  readPaths, render}>` + one `emitHostGateStep(kind, result, ctx)`.
- **Risk:** **not** loop-core (verified against `LOOP_CORE_PATTERNS`) — no attestation needed. Two
  traps the verifier caught: `synthesis_narrative` (1489-1502) emits **no** `access` field while
  `critical_flow_fallback` (1458-1461) does, so the table must model `access` as genuinely optional or
  the emitted contract changes for one gate; and `systemic_challenge` carries an
  `aggregateMetricsDigest` + `gateHostFanoutOrPause` preflight (1047-1074) that must survive as a
  per-entry hook — convert it last, it is the only arm that can return early without writing a step.
  Diff a captured `current-step.json` before/after for `synthesis_narrative` and `systemic_challenge`.

### 2.4 — Delete `tests/audit/file-lock-doc-sync.test.mjs` and the millisecond values in CLAUDE.md (68) — **CONFIRMED**

- **Mechanism:** the backoff window and stale threshold exist in **three** places: the source constants
  (`src/shared/quota/fileLock.ts:5,21-22`), a prose restatement in `CLAUDE.md:131` ("exponential
  50ms→500ms backoff, token-checked 30s stale-lock cleanup"), and this test — which does not compare
  the first two but **independently pins the literals** at lines 44-46 (`toBe(50)`, `toBe(500)`,
  `toBe(30_000)`), making it the third copy. It regex-scrapes two module-private constants out of the
  source *text* and greps CLAUDE.md by content. `STALE_LOCK_MS` is already pinned better at
  `tests/shared/fileLock-clock-seam.test.mjs:19-20`, so it is really a fourth copy.
- **Endpoint:** strip the numbers from `CLAUDE.md:131`, keep the durable claim (single-sourced in
  `audit-tools/shared` `quota/fileLock`; `store.ts` adds none of its own). Delete the test file.
- **Risk:** this removes a passing guard, so it is a coverage change — state it as one. Land the
  CLAUDE.md edit in the **same commit** or the doc keeps stale values with nothing watching. Rehome
  line 66's assertion (CLAUDE.md still records "store.ts adds no backoff of its own") into the
  existing doc-contract gate first. Deleting does not orphan the shared `STALE_LOCK_MS` re-export —
  it has 8+ other consumers, so `check:deadcode` stays green.

### 2.5 — Inline `makeProviderKeyedFactory` (20 src + 58 test) — **CONFIRMED**

- `src/shared/providers/providerKeyedFactory.ts` (18 lines) is a generic factory whose body is one
  expression: `(providerName) => record[providerName] ?? fallback`. Exactly one production
  instantiation: `getErrorParserForProvider` at `src/shared/quota/errorParsers/index.ts:21`.
- Its docstring justifies the extraction by naming a second consumer — "the audit header-extractor
  factory (drift-plan E5)" — which **no longer exists anywhere in the repo**. The abstraction outlived
  its second consumer without anyone revisiting it.
- **Endpoint:** `export const getErrorParserForProvider = (name: string): ErrorParser => PARSERS[name] ?? GENERIC;`
  Delete the file, `src/shared/index.ts:885-886`, and `tests/shared/provider-keyed-factory.test.mjs`
  (collapse its unknown-key→fallback contract into one assertion in the errorParsers test).
- **Risk:** very low. Single call site, single bound type, no dispatch or re-export-alias wiring.

### 2.6 — One channel-error classifier registry (~75) — **CONFIRMED**

- `src/shared/quota/errorParsing.ts:154-296,384-393` + `src/shared/dispatch/providerLaunchFinalize.ts:56-146`.
- **Mechanism:** three duplications. (a) `detectModelUnavailableError` (216-227) and
  `detectRequestTooLargeError` (269-280) are byte-identical pattern loops modulo the array and the
  boolean key; credit-exhaustion and rate-limit are the same loop with a prologue. (b) All four
  `detectXFromChannel` are the identical `if (channel === "result") return <negative>; return detectXError(text)`
  — four hand-written copies of the CE-003 channel-isolation rule. (c) `classifyFailureChannels`
  writes the 2 channels × 4 classes cross-product as 8 near-identical 8-line blocks (61-131), whose
  **precedence is load-bearing** (the header comment at 42-52 says stderr-413 must precede stderr-429)
  and is encoded only as source-line order.
- **Endpoint:** one `CHANNEL_ERROR_CLASSES` array in scan order, each row `{outcome, detailKey, detect}`,
  plus one `classifyChannel(channel, text)` applying the result-channel guard once. `classifyFailureChannels`
  becomes a double `for`, ~20 lines, with precedence expressed as array order in one place.
- **Also dead here:** `classifyFailureChannels`'s first parameter `packet` (`:57`) is never referenced
  in the body, yet both call sites (`:196`, `:222`) pass it. **And the `<TPacket>` generic is
  vestigial too** — `Omit<RollingDispatchResult<TPacket>, "packet">` is TPacket-free, so drop both.
- **Risk:** loop-core (`src/shared/dispatch/`) → needs a fresh staged-tree review attestation. Keep the
  four `detectX` / `detectXFromChannel` named exports as thin delegations —
  `tests/shared/errorParsing.test.mjs:220-267` asserts them by name and by `is*` key. Per-class detail
  builders are **mandatory**: the `rate_limited` branches (93, 129) emit `{channel, text}` with no
  `rawMatch`, so a uniform builder would silently change the contract.

### 2.7 — Table-drive `validateConfiguredProviderEnvironment` (~45) — **CONFIRMED**

- `src/audit/validation/sessionConfig.ts:65-86` (claude-code), `88-109` (opencode), `111-132` (codex)
  are three structurally byte-identical 22-line blocks; only the tuple (provider, config key, default
  command) and one interpolated word vary.
- **Endpoint:** `PATH_CHECKED_CLI_PROVIDERS` table + one loop. Function drops 141 → ~95.
- **This duplication has already produced a live coverage gap:**
  `src/shared/validation/sessionConfig.ts:787-790` validates **four** agent-CLI sections
  (`claude_code`, `codex`, `opencode`, `agy`) and `src/shared/providers/providerFactory.ts:118-119,156-159`
  PATH-probes `agy` exactly like the others — but this file has **no `agy` branch**, because someone
  would have had to paste a fourth copy. An operator with a bogus `agy.command` passes environment
  validation silently.
- **Risk:** the collapse is behavior-neutral and `tests/audit/validation-remediation.test.mjs`
  (935/1048/1067/1085-1133) passes unchanged. **Adding the `agy` row IS a behavior change** (a
  previously-unvalidated config can now emit an issue) → ship it as a **separate commit**.
  Typing note: the table needs `as const` and a keyof-narrowed accessor for the indexed `?.command` read.

### 2.8 — Table-drive `validateDesignSpecGates` (~34) — **CONFIRMED**

- `src/remediate/validation/contractPipelineGates.ts` — six instances of one predicate:
  `modules[].inputs` (72-78), `modules[].outputs` (79-85), `side_effects[].owner` (92-98),
  `external_dependencies[].failure_semantics` (137-143), `trust_boundaries[].untrusted_inputs`
  (151-157), `trust_boundaries[].validation_ref` (158-164). Path and message-leading-clause are both
  mechanically derived from (collection, field); only the trailing reason is free text.
- **Endpoint:** a 6-row `REQUIRED_ENTRY_FIELDS` table + one ~18-line loop. 60 collapsible lines → ~26.
- **Risk:** low. Issues are accumulated, never short-circuited, so ordering is not load-bearing.
  Reproduce all six messages byte-identically — the design worker re-emits against these strings.
  Gate 3 (ledger cross-reference) and Gate 6 (Kahn topological sort) are genuinely different
  algorithms and stay. The Gate-1 rows need the `modules`/`module_contracts` alias resolved *before*
  the loop.

### 2.9 — Strip `RollingDispatchEngineContract`'s four dead fields (~25) — **CONFIRMED**

- `src/shared/types/rollingDispatch.ts:107-118`. `dispatchItems` appears **three times in the entire
  repo**: its own declaration and two doc comments — never read, written, or passed. `livelockGuard`,
  `consumerTerminal` and `onResult` are read only inside `runRollingDispatch`
  (`src/audit/orchestrator/rollingDispatch.ts:80,89,142,182,193`) and supplied only by
  `tests/audit/shared-api-integration.test.mjs`. The single production call site
  (`src/audit/cli/rollingAuditDispatch.ts:555-616`) passes only the eight friction hooks.
- **Endpoint:** delete all four fields and their guarded call sites; `detectLivelock` takes the literal
  `3` that is already the effective value (bit-identical — the call already passes
  `consecutiveNoProgressWaves === noProgressLimit === livelockLimit`). Drop the `Partial<>` and the
  `= unknown` default, and rename to `RollingDispatchFrictionHooks` — the current name asserts an
  engine contract the type no longer describes.
- **Risk:** loop-core → attestation. `tests/audit/rolling-dispatch-executor.test.mjs` and
  `tests/audit/audit-dispatch-observability.test.mjs` pass `{}` and are unaffected; only
  `tests/audit/shared-api-integration.test.mjs` needs trimming.

---

## 3. Worth doing

Grouped by theme. Corrected estimates. Every item names its files.

### 3.1 Dead code

| Item | Lines | Tag | Files |
|---|---|---|---|
| Six dead audit adapters — the live analyzer path re-implements their parsers inline | ~870 (416 src / 454 test) | UNVERIFIED | `src/audit/adapters/{semgrep,codeql,astGrep,eslint,npmAudit,coverageSummary}.ts` whole files; `clippy.ts:120-128`, `rubocop.ts:117-125` (`normalize*Json` only); `adapters/README.md:8-15`; `tests/audit/adapters-remediation.test.mjs` (most), `tests/audit/graph-external-analyzers.test.mjs:14-21` |
| Contract-pipeline incremental-reconvergence cluster (INV-IR-1/IR-2) | ~627 | UNVERIFIED | `src/remediate/contractPipeline/artifactStore.ts:245-296`; `derive.ts:575-728`; `tests/remediate/contract-pipeline-cp-node-2.test.ts` (421) |
| `waveManifest.ts` — `wave-manifest.json` is never written or read | 272 | UNVERIFIED | `src/audit/cli/waveManifest.ts` (88, whole file); `tests/audit/wave-manifest.test.mjs` (184) |
| Three superseded whole-file facades | ~555 | UNVERIFIED | `src/audit/orchestrator.ts` (105, superseded by `orchestrator/taskBuilder.ts`); `src/audit/orchestrator/chunking.ts` (25, superseded by `src/shared/chunkByBudget.ts`); `src/remediate/intent/intentOrdering.ts` (175); `tests/audit/orchestrator.test.mjs`, `tests/audit/chunking.test.mjs`, the intentOrdering cases in `tests/audit/dc1.test.mjs` |
| Intake findings-digest / enumeration builders — emit a shape the live reader rejects | ~312 | UNVERIFIED | `src/remediate/intake.ts:150-283` and the dead `findingsDigest` path at `:65,:79`; digest sections of `tests/remediate/intake-sources-and-digest.test.ts` |
| Five thin wrappers + superseded predicates kept alive by re-export chains | ~250 | UNVERIFIED | `src/remediate/steps/dispatch/waveScheduling.ts:113-124` (`resolveHostConcurrencyLimit`); `src/remediate/steps/stepUtils.ts:27-44` (`dependenciesSatisfied` — explicitly superseded per `nextStep.ts:526`); `src/audit/cli/nextStepHelpers.ts:1464-1518` (`HOST_GATE_DESCRIPTORS`, read only by a test asserting the registry covers what it lists); `src/audit/systemic/systemicChallengeLoop.ts:136-137` (`SYSTEMIC_HIGH_BLAST_THRESHOLD` = an alias of `DEFAULT_RISK_GATE_THRESHOLDS.highBlastThreshold`) |
| `src/shared/index.ts` — 270 of 1041 barrel re-exports have no consumer outside `src/shared` | ~280 | UNVERIFIED | `src/shared/index.ts:1-1532`; 44 export blocks become entirely empty |

Notes on the barrel: nothing inside `src/shared` imports from it (modules reach each other by relative
path), so these 270 lines serve no importer at all. `check:deadcode` (`knip --no-config-hints`) exits 0
while all 270 sit unconsumed — this is the one place in the repo where zero-consumer exports accumulate
silently. This narrows the published `./shared` subpath surface; CLAUDE.md's "one user, no external
consumers" makes that the intended direction, but it is the one judgment call. Do it **first and
independently** — it touches no logic. Textual scan → a computed/namespace access would be missed; the
typecheck catches that.

**Escalate, do not delete:** `src/audit/quota/discoveredLimits.ts:77-110`
(`writeDiscoveredLimitsCache` / `updateDiscoveredLimits`, ~190 lines with tests) is a **wiring bug, not
dead code**. The read half is live (`src/audit/cli/dispatch/quotaPool.ts:149,159`;
`src/audit/cli/quotaCommand.ts:36`) but the write half has no production caller, so
`discovered-limits.json` can never be produced and the learned-limits cache CLAUDE.md's quota policy
calls authoritative is **permanently empty**. Deleting is behavior-neutral today and forecloses the
feature; wiring it into the 429-parse / capability-handshake path is the likely correct fix.

### 3.2 audit↔remediate duplication

These are one defect wearing several hats: **there is no declared `OrchestratorMode` identity anywhere
in the repo.** See §4.1 for the combined endpoint.

| Item | Lines | Tag | Files |
|---|---|---|---|
| Quota layer: two pure re-export barrels + two shims differing in one string | ~200 | PARTIAL | `src/audit/quota/index.ts`, `src/remediate/quota/index.ts`, `src/audit/quota/hostLimits.ts`, `src/remediate/quota/hostLimits.ts` |
| Two `WorkerTask` interfaces are one contract; remediate's carries 4 provably dead fields | ~40 | UNVERIFIED | `src/audit/types/workerSession.ts:14-31`, `src/remediate/types/workerSession.ts:5-33` (dead: `audit_results_path`, `pending_audit_tasks_path`, `runtime_updates_path`, `external_analyzer_results_path` at `:13-16` — never set by the only builder `phases/workerTasks.ts:28-39`, never read) |
| `src/remediate/providers/constants.ts` has zero importers repo-wide | 7 | UNVERIFIED | plus `src/audit/providers/constants.ts:3-4` (`CODEX_PROVIDER_NAME`, `ANTIGRAVITY_PROVIDER_NAME` re-exports with no importers) |
| Worktree safety primitives duplicated, and the two `canonicalPathKey` copies already disagree | ~55 | UNVERIFIED — **behavior change** | `src/shared/providers/reviewSnapshot.ts:59-72,87-112,125-160`; `src/remediate/steps/dispatch/common.ts:55-61,89-98`; `src/remediate/steps/dispatch/worktreeLifecycle.ts:33-65,119-135` |

**The quota item's endpoint needs reshaping** — the verifier refuted three of its four premises
(see §5). Corrected: `src/audit/quota/hostLimits.ts` **does** have a production consumer via the barrel
(`src/audit/cli/quotaCommand.ts:7,29`); `src/remediate/quota/index.ts:66-69` exports **local**
prefix-bound functions, not the shared ones; and `src/audit/quota/index.ts:72-79` barrels the genuinely
audit-owned `discoveredLimits.ts`, whose consumers must repoint to `../quota/discoveredLimits.js`, not
to shared. If the `AUDIT_CODE` prefix is not re-bound at `quotaCommand.ts`,
`AUDIT_CODE_HOST_MAX_ACTIVE_SUBAGENTS` silently stops being honoured — and the only test that would
catch it is the parity suite the same commit deletes. **Correct endpoint: `envPrefix` becomes a scalar
on the per-mode policy record**, not an inline literal at three call sites.

**The worktree item changes behavior** and is the only one in this section that does. `canonicalPathKey`
exists twice and is **not** equivalent: shared's (`reviewSnapshot.ts:59-72`) case-folds only on win32,
remediate's (`common.ts:55-61`) routes through `normalizeRepoPath`, which `.toLowerCase()`s on every
platform. Unifying picks one policy → remediate's guard becomes stricter on Linux. The win32-only fold
is correct. The guard is load-bearing (it prevents a `git worktree add` walking up into an ancestor
repo — see HEAD~ commit `0ebaa20f`), so **land a red-green test before the merge**. The detached-HEAD
read-only snapshot vs `-b <branch>` writable node worktree distinction is a real per-draw difference and
**stays forked**.

### 3.3 Over-abstraction

| Item | Lines | Tag | Files |
|---|---|---|---|
| Five CLI provider classes repeat one launch skeleton; two duplicate the nested-session guard | ~70 | PARTIAL | `src/shared/providers/{claudeCodeProvider,agyProvider,codexProvider,opencodeProvider,claudeWorkerProvider}.ts` |

This is the one item that **adds** an abstraction in a review about over-abstraction, and net removal is
~70, not the ~158 gross duplicate surface — the argv builders, the shim-function choice
(`resolveWindowsShimSpawnCommand` vs `resolveOpenCodeSpawnCommand` vs none) and claude-worker's
config-dir lifecycle all stay per-provider. **Prefer a `launchStdinCliProvider(spec, input)` helper over
a `SpawnCliProvider` inheritance base** — same merge, no new hierarchy.
`claudeWorkerProvider.ts:112-117`'s `requireNonEmpty` triple is a documented **constructor invariant**
(`:88-96`) and must not become an optional base hook. Verifier corrections: the two nested-session
message builders differ on **two** axes, not one; the three constructors are **not** line-for-line
identical (ClaudeWorker's runs three validations and stores endpoint/model); `opencodeProvider.ts` is 86
lines, not 96.

### 3.4 Knobs

| Item | Lines | Tag | Files |
|---|---|---|---|
| Three session-config knobs with zero readers — two of them advertised to operators | ~50 | UNVERIFIED | `src/shared/types/sessionConfig.ts:135-136,778` (`ui_mode`, `SESSION_UI_MODES`), `:816` (`agent_task_batch_size`), `:683-684` (`GraphConfig.model`); `src/shared/validation/sessionConfig.ts:22,32,42,736-745`; `src/shared/index.ts:250,279`; `tests/shared/runtimeConstants.test.mjs:61-77` (tautological); `docs/audit-pkg/operator-guide.md:175-181` |
| `openai_compatible` back-compat fold is unreachable — the block has exactly one writer | ~55 | UNVERIFIED | `src/shared/quota/apiPool.ts:625-631` (the fold), `:180-196` (`sourceProviderConfig`, the only writer), docblocks at `:596-604` and `src/shared/types/sessionConfig.ts:807-814` |
| The validator's `required` mechanism is never operatively true | ~40 | UNVERIFIED | `src/shared/validation/sessionConfig.ts:395-437`, `:507-551`, and the four call sites at `:769-796` |
| Four base64 CLI escape-hatch flags the tool never emits, plus `--preferred-executor` | ~35 | UNVERIFIED — **behavior change** | `src/audit/cli/validateResultCommand.ts:18-30`; `src/audit/cli/submitPacketCommand.ts:18-22`; `src/audit/cli/dispatch/paths.ts:37-44` (`resolveRunScopedArg`); `src/audit/cli/advanceAuditCommand.ts:77-79` |
| Three byte-identical template provider config interfaces | 12 | UNVERIFIED | `src/shared/types/sessionConfig.ts:138-141,291-294,296-304` |
| `test:single` npm script is byte-identical to `test` and referenced nowhere | 1 | UNVERIFIED | `package.json:48` |

Notes:
- **`ui_mode` deletion collides with a live recommendation** — see §5. `ui_mode` is dead at *both* ends
  (no caller supplies `uiMode` to the resolver; the config field is validate-only), but the correct
  endpoint may be to **wire** it, not delete it. Decide that before touching either.
- Because the validator ignores unknown keys, follow the repo's own
  `[[deleting-a-field-is-not-retiring-it]]` pattern (`validation/sessionConfig.ts:141-155`,
  `refuseInlineApiKey`): add a **refusal** for `ui_mode` / `agent_task_batch_size`, which are the two an
  operator may plausibly have on disk today. `graph.model` needs none (undocumented). Bare deletion
  would stop `ui_mode: "bogus"` from erroring.
- `--preferred-executor` is the sole route by which a user-supplied executor name bypasses the
  obligation engine — the host-discretion pattern CLAUDE.md's *auditor-agnostic robustness* rule bans.
  Its single occurrence in the entire repo is its own parse. Keep `--results-b64` (it **is** exercised
  at `tests/audit/submit-packet-command.test.mjs:183,552,578`); check `wrapper/audit-code-wrapper-lib.mjs`
  before dropping the others.

### 3.5 Redundant guards

| Item | Lines | Tag | Files |
|---|---|---|---|
| `validateTopLevelShapes` is a second hand-maintained copy of the artifact registry | ~30 | PARTIAL | `src/audit/validation/artifacts.ts:27-73` (15 blocks, not 16); `src/audit/io/artifacts.ts:235+` (`ARTIFACT_DEFINITIONS`) |
| Path-normalization predicate ×3 + no-op `pushIssue` wrapper ×3 | ~27 | PARTIAL | `src/audit/validation/auditResults.ts:45-47`, `src/remediate/riskSignal.ts:174-176`, `src/audit/orchestrator/fileAnchors.ts:130-132`, `src/shared/validation/findingGrounding.ts:46-48`; wrappers at `src/audit/validation/artifacts.ts:11-17`, `src/audit/validation/sessionConfig.ts:15-21`, `src/shared/validation/sessionConfig.ts:339-345` |
| `host-asset-renderer-drift` E1 tests assert a tautology of an already single-sourced renderer | ~26 | PARTIAL | `tests/audit/host-asset-renderer-drift.test.mjs:47-96` |
| Repo-tree readability gate copy-pasted between the two grounding gates | ~8 | PARTIAL | `src/remediate/validation/contractPipelineGates.ts:1157-1180`, `:1346-1366` |

Corrections that matter before acting:
- **`validateTopLevelShapes` is mostly a relocation, not a deletion** — the required-key arrays are
  irreducible data; moving them into `jsonArtifact(...)` keeps them. An **optional** `requiredKeys?`
  field does **not** deliver the forcing function ("a new artifact must declare its shape"); only a
  required field with an explicit `null`/`[]` opt-out would. A real pre-existing defect sits underneath:
  `ArtifactPayloadMap` types `external_analyzer_results` as an **array** (`io/artifacts.ts:113`) while
  `requireKeys` → `isRecord` rejects arrays, so line 65 already emits a spurious "Expected an object,
  got array". Fix that deliberately; do not launder it through the refactor.
- **Only 3 of the 5 path copies collapse safely.** `src/audit/extractors/disposition.ts:192-194` and
  `src/audit/extractors/fsIntake.ts:29-31` are **slash-only** and do not strip `./` — folding them into
  a `./`-stripping helper is a behavior change. Export two primitives or leave those two alone. Do
  **not** swap the three case-preserving copies for the lowercasing `normalizeRepoPath` or path matching
  turns case-insensitive on Linux. The `pushIssue` rename touches **~90** call sites (29 + 10 + 56), not
  ~40 — semantically empty but a large diff, and some single-line calls will reflow.
- **The E1 replacement must not be a bare verbatim-embed assertion.** Those assertions double as content
  guards on the canonical prompt: `max_active_subagents` and the "`--auditor` inside the continuation
  block" regex (`:69-72`) exist **only** in this file. Assert content properties once against
  `canonicalBody`, plus one verbatim-embed assertion per asset. The file has **nine** tests, not six —
  the five after `.github/agents/auditor.agent.md` are all live no-drift guards.
- The readability-gate merge nets only ~6-8 lines; its value is **drift prevention on a
  correctness-sensitive severity policy**, not deletion. The two messages differ in three places, so the
  helper needs 3-4 string parameters. The two gates use different corpus sources
  (`enumerateRepoTreePaths` vs `enumerateTrackedFilePaths`) — the helper must return the raw set and let
  each gate decide.

### 3.6 Scripts, hooks, and test substrate

| Item | Lines | Tag | Files |
|---|---|---|---|
| 17 test files re-declare `withTempDir` inline while 19 import the shared helper | ~130 | UNVERIFIED | helper: `tests/audit/helpers/withTempDir.mjs` → move to `tests/helpers/`; copies in `tests/audit/{audit-cli-correctness,audit-dispatch-observability,dispatch-scripts,finalization-cycle-guard,next-step-helpers,observability-signals,provider-assisted-bridge,review-packets,seam-host-only-next-step,status-command,synthesis-narrative-convergence}.test.mjs`, `tests/shared/{analyzerDeps-injectable-log,analyzerDeps,repoConventions,runLog,schema-version-read-policy,testCommand}.test.mjs` |
| ~20 hand-rolled temp-git-repo scaffolds with no shared helper at all | ~200 | UNVERIFIED | 11 `initRepo()` in `tests/remediate/`, 9 `withTempRepo()` in `tests/audit/`, 14 inline `git(cwd,...)` wrappers — full list in the candidate set; endpoint `tests/helpers/tempRepo.mjs` |
| Four generator/gate scripts re-implement the same marker-splice + `--check`/`--write` protocol; two are the same program twice | ~150 | UNVERIFIED | `scripts/shared/generate-loop-core-patterns.mjs` (95) and `generate-constitutional-doc-paths.mjs` (101) are the same program; splice copies at `generate-backlog-index.mjs:152-163`, `generate-handoff-roadmap.mjs:244-255`, `scripts/check-philosophy-brief.mjs:76-88`, `scripts/check-doc-manifest.mjs:242-256` |
| `pinsLoopCore` copied into two hooks; nine files each declare their own `git()` spawn wrapper | ~75 | UNVERIFIED | `.claude/hooks/pre-commit-gate.mjs:69-79,286-302`, `.claude/hooks/attest-loop-core-review.mjs:64-74,43-51`; git wrappers in `closeout-challenge-gate.mjs:58`, `session-start-guards.mjs:18-29`, `shell-trap-guard.mjs:95`, `scripts/attest-constitutional-doc-change.mjs:47`, `scripts/check-control-bytes.mjs:17`, `scripts/check-doc-manifest.mjs:50` |
| `scripts/audit/verify-hosts.mjs` and `scripts/remediate/verify-hosts.mjs` — same 46-line script, three substitutions | ~45 | UNVERIFIED | both whole files; `package.json` `verify:hosts` / `verify:remediate-hosts` |
| Remediate's two smoke scripts fork substrate audit already single-sourced | ~130 | UNVERIFIED — **partly behavior change** | `scripts/remediate/smoke-linked-remediate-code.mjs` (148), `scripts/remediate/smoke-packaged-remediate-code.mjs` (182) vs `scripts/shared/smoke-process.mjs` |
| Audit/remediate postinstall pair forks the installs table and has drifted into two incompatible OpenCode-permission APIs | ~130 | UNVERIFIED — **behavior change** | `scripts/audit/postinstall.mjs` (328), `scripts/remediate/postinstall.mjs` (275), `scripts/shared/install-host-assets.mjs` (188) |

Notes:
- `pinsLoopCore` is the **data single-sourced, predicate forked** case. The sibling generator already
  solves it: `generate-constitutional-doc-paths.mjs` appends `isConstitutionalDocPath` to its generated
  module. `generate-loop-core-patterns.mjs` just never got the same tail. **Placement trap:**
  `.gitignore` re-includes `.claude/hooks/*` **by name**, so a new file there is silently dropped from
  commits — put the shared git helper under `scripts/shared/`. Keep `timeout` a parameter (session-start
  uses 25s deliberately, closeout 8s).
- The smoke item has two separable halves. Collapsing the duplicated substrate is behavior-preserving.
  **Making `smoke-linked-remediate-code.mjs` actually use the linked shape is a capability fix, not a
  simplification** — despite its name it spawns `node <repoRoot>/remediate-code.mjs` directly and never
  runs `npm link`. Decide that on its own merits. Extend
  `tests/audit/release-contract.test.mjs:249-257` to cover the remediate pair so the fork cannot regrow.
- **Postinstall is the highest-risk item in the whole review.** The two OpenCode merge functions are
  **not currently equivalent** (audit: `mergeOpenCodeAgentPermissionConfig(existing, generated)`;
  remediate: `renderOpenCodeAgentPermissionConfig(existing)` building from constants), so collapsing
  means *choosing* one merge semantics — which changes what an existing user's
  `~/.config/opencode/opencode.json` converges to on the next `npm install`. Establish equivalence
  first. One real per-tool behavior to preserve as a parameter: remediate strips frontmatter from the
  Claude command, audit does not. Leave `scripts/postinstall.mjs:70-76`'s local
  `resolveVisibilityOverride` alone — it is a deliberate fresh-`npm ci` fallback.

### 3.7 Legacy paths

| Item | Lines | Tag | Files |
|---|---|---|---|
| `maybeArchiveLegacyPendingResults` guards a filename with zero writers repo-wide | ~40 | UNVERIFIED | `src/audit/cli/auditStep.ts:49-69` and the two call sites at `:266-275`, `:291-300` |
| Two competing repair-target unions bridged by a cast | ~35 | UNVERIFIED — **behavior change** | `src/shared/types/contractPipeline/obligations.ts:209-213` (`JudgeRepairTarget`, still naming the retired `design_spec`); `src/remediate/steps/contractPipeline.ts:698-700,719,733,748,790-795`; `src/remediate/validation/contractPipeline.ts:500-506` |
| `agy` `gemini` binary fallback is past its own stated sunset (2026-07-18) | ~60 | UNVERIFIED — **behavior change** | `src/shared/providers/agyProvider.ts:66-93,101`; `auditorSources.ts:85-86,531-535`; `providerConfirmation.ts:118-124`; `providerFactory.ts:155-159,260`; `providerPathGuard.ts:96-102`; `src/shared/types/sessionConfig.ts:311-317` |
| `rejectionRewriteInstruction`'s `string \| undefined` back-compat overload only tests exercise | 8 | UNVERIFIED | `src/remediate/steps/contractPipeline.ts:457-460`; convert `tests/remediate/contract-pipeline-adversarial.test.ts:1373` and `contract-pipeline-cp-node-3.test.ts:129` |

Notes:
- `worker_results_pending.json` has **exactly one** hit in the tracked repo — the guard's own comparison
  at `auditStep.ts:52`. The condition is unsatisfiable.
- The `JudgeRepairTarget` merge changes behavior: `validateJudgeReport` would reject a report whose
  `repair_directive.target` is `design_spec` instead of silently remapping it. Exposure is a stale
  in-flight report on disk (no live prompt offers that value —
  `tests/remediate/n-r07-seam-negotiation.test.ts:257-259,636` pins it out). Delete
  `tests/remediate/validation.test.ts:584` in the same commit. Distinct from
  `ObligationEntry.source?: "design_spec"` (`obligations.ts:80`), which `derive.ts:108/119/132` actively
  writes — **that one is live**.
- The `agy` sunset **does** change behavior: a machine with only `gemini` on PATH stops auto-resolving
  to the agy provider, and an operator with `agy.command: "gemini"` would get modern flags on a legacy
  binary. That is the deliberate intent of the gate and the date has passed — but get a one-line
  confirmation that `agy` is installed before landing. Update
  `tests/shared/auditor-sources.test.mjs:210-212` and
  `tests/shared/codex-antigravity-providers.test.mjs:685-710`.

---

## 4. Structural

Multi-commit merges. **This repo treats refactor size as not-a-cost** — none of these is deprioritized
for being large. What gates them is correctness (green at every commit, no lossy intermediate states)
and, in two cases, an owner decision.

### 4.1 — One `OrchestratorMode` descriptor (~565 src + ~490 test)

The single highest-leverage structural change. `grep -rl "orchestratorName\|OrchestratorMode\|envPrefix" src/shared`
returns three files, **none of which owns a mode record**. Every per-mode constant is re-declared at the
site that needs it, and each site grew a shim module to hold it. The scattering has already produced
silent inconsistency a descriptor would surface: `hostLimits` uses `AUDIT_CODE_`/`REMEDIATE_CODE_`, but
dispatch-capability uses `AUDIT_CODE_HOST_CAN_DISPATCH` vs `REMEDIATE_HOST_CAN_DISPATCH` (no `_CODE`),
and rolling uses `AUDIT_CODE_ROLLING_ENGINE` vs `REMEDIATE_ROLLING_ENGINE`.

- **Endpoint:** one `src/shared/providers/orchestratorMode.ts` with two frozen descriptors carrying
  `{orchestratorName, sessionConfigPath, slashCommand, skipPermissionsDefault, envPrefix,
  hostDispatchEnvVar, rollingEngineEnvVar}`, plus `createModeProviders(mode)` and
  `resolveModeProviderName(mode, …)`. **Env var names copy verbatim** — the inconsistency is preserved,
  not fixed, or it becomes a behavior change.
- **Deletes:** both `providers/` directories (303), both `quota/hostLimits.ts` (54), both `quota/index.ts`
  barrels (~158, keeping audit's `discoveredLimits` re-export block as a direct import),
  `FreshSessionProviderDeps` (~28), and four env-var-currying wrappers
  (`src/audit/cli/args.ts:62-75`, `src/remediate/steps/nextStep.ts:181-197,210-221`,
  `src/audit/cli/rollingAuditDispatch.ts:108-119`). Inline `envPrefix` literals at
  `src/audit/cli/dispatch/quotaPool.ts:140` and `src/remediate/steps/dispatch/waveScheduling.ts:165`
  read from the descriptor.
- **Deletes as a consequence:** `tests/audit/seam-provider-quota-instantiation-parity.test.mjs` (382)
  and `tests/remediate/f4-brokered-core-parity.test.ts` (108) — both exist *only* to police these
  forks. `f4-brokered-core-parity.test.ts:83-85` literally regex-strips the `AUDIT_CODE`/`REMEDIATE_CODE`
  literal from both files and asserts the remainder is byte-identical. Preserve the one genuine
  behavior assertion (`getErrorParserForProvider` unknown-key → generic fallback, seam file `:372-381`)
  as a ~10-line test in `tests/shared`.
- **Sequencing:** land as **one atomic commit** (the atomic-replace ordering invariant forbids
  add-then-delete across commits). `src/audit/quota`, `src/remediate/quota` and the dispatch paths are
  loop-core → one fresh staged-tree review attestation covers the batch.

### 4.2 — One omittable-gate table (~215 + the fourth layer)

One concept — the six omittable host gates (`synthesis_narrative`, `charter_extraction`,
`charter_delta`, `charter_clarification`, `systemic_challenge`, `critical_flow_fallback`) — is
hand-restated in **four** places:

1. a descriptor inside a `handleXBranch` wrapper (`src/audit/cli/nextStepHelpers.ts:1155-1180,
   1238-1264, 1277-1302, 1315-1341, 1357-1396, 1412-1452`);
2. a per-gate result type alias (`:1067-1073`);
3. an obligation `execute` body that is **character-for-character identical across seven gates**
   (`:2016-2031, 2079-2091, 2097-2109, 2117-2129, 2151-2163, 2170-2182, 2199-2215`);
4. a CLI emit block (§2.3).

Plus `HOST_GATE_DESCRIPTORS.incomingFiles` (`:1475-1507`) restates each gate's filename a **fifth**
time as a hand-maintained array kept honest by a coverage test — precisely the "table we hand-maintain,
kept honest by remembering" pattern CLAUDE.md bans.

- **Endpoint:** one `OMITTABLE_GATES: Record<OmittableGateKind, OmittableGateDescriptor>`, one exported
  `runGate(kind, params, bundle, state)`, one `omittableGateObligation(obligationId, gateKind)` factory
  (each obligation entry becomes one line), and one `HOST_GATE_EMITS` table for the CLI side.
  `incomingFiles` derives from `OMITTABLE_GATES[kind].filename`.
- Adding a seventh gate becomes a **one-record edit** instead of four coordinated edits.
- `handleIntentEquivalenceBranch` (`:1193-1224`), `handleGraphEnrichmentBranch` (`:441`) and
  `handleDesignReviewBranch` (`:897`) genuinely deviate and stay custom — the section comment at
  `:1030-1060` documents why, and that reasoning must survive.
- `tests/audit/next-step-helpers.test.mjs` imports all six `handleXBranch` symbols by name (`:28-32`,
  `:1013-1033`); its own kind→handler table at `:1013-1033` collapses too. **Not loop-core.**

### 4.3 — Retire the legacy single-pass design review (~230 across 12 files) — UNVERIFIED

The design review was split into independent `contract` and `conceptual` passes. The pre-split combined
path survived intact and is unreachable **three independent ways**: `EXECUTOR_REGISTRY`
(`src/audit/orchestrator/executors.ts:17-192`) has no `design_review` entry; `kind: "design_review"` is
declared in the result union (`nextStepHelpers.ts:315,568`) but **constructed nowhere**; and the legacy
incoming file `design-review-findings.json` is named to the host only inside the dead arm.

Cascade: with no writer for `design_assessment.reviewed` / `.review_findings`, every reader is dead —
the `legacyReviewed` disjuncts (`src/audit/orchestrator/state.ts:388-400,408,419`), the carry-forward
and cleanup (`structureExecutors.ts:225-229,302-304`), the fallback merge
(`reporting/mergeFindings.ts:63-67`), the `@deprecated` fields
(`src/audit/types/designAssessment.ts:14,26-30`), `renderDesignReviewPrompt`
(`orchestrator/designReviewPrompt.ts:643-696`, 54 lines, one caller — inside the dead arm), the runner
entry (`executorRunners.ts:149-150`), and `"design_review"` in `StepKindSchema` (`cli/steps.ts:15`).

- **Keep:** `HostFanoutFamily = "design_review"` (`hostFanoutGate.ts:57`) is a **different** thing,
  shared by the live contract/conceptual dispatches.
- **Decide separately:** the legacy *consume* leg at `nextStepHelpers.ts:906-933` is still exercised by
  `tests/audit/next-step-helpers.test.mjs:308,657-675`, `next-step.test.mjs:156`,
  `linux-cycle-regression.test.mjs:111`. Deleting it stops consuming a stray legacy submission file and
  requires deleting those tests.
- **Risk:** a `design_assessment.json` written by a pre-split build would stop satisfying the two review
  obligations and both passes would re-run. Transient per-run artifacts; the split shipped long ago.
  Loop-core → attestation. Update `tests/audit/{design-review-parallel,audit-orchestrator-invariants,
  next-step-helpers,next-step,linux-cycle-regression,dc4,conceptual-fanout,executor-registry-sync}` in
  the same commit.

### 4.4 — Collapse remediate's `--host-*` scalar flags onto audit's `--auditor` descriptor (~320) — UNVERIFIED, **behavior change**

`src/shared/types/auditorDescriptor.ts:19-66` documents a 1:1 mapping for every one of these
(`model_id` "was `--host-model-id`", `roster` "was `--host-models`", …). Audit registers **none** of the
scalar flags; remediate registers five (`src/remediate/index.ts:162-181`, parsed at `:219-232`). The
fork is self-acknowledged at `tests/remediate/cli-host-capability-flags.test.ts:385-391`: "audit and
remediate deliberately DIVERGE on the handshake transport until the remediate `--auditor` round-trip
(G6)". The cost is not the flag block — it is the **431-line parity test** keeping 6 loader assets in
sync with a flag list audit no longer has (audit's equivalent is one 130-line descriptor round-trip).

- **Endpoint:** lift `getAuditorDescriptor` (`src/audit/cli/args.ts:245-354`) into `src/shared` — it
  already depends only on shared symbols — and have remediate's `next-step` take `--auditor <json>`,
  mapping `descriptor.self` onto the `hostMaxConcurrent`/`hostContextTokens`/… params it already
  threads. Internal remediate plumbing (~98 `hostX` references) is unchanged; only the entry seam
  collapses.
- **Atomic:** the 6 loader assets (`skills/remediate-code/remediate-code.prompt.md:63`,
  `.github/agents/remediator.agent.md:67`, `.github/prompts/remediate-code.prompt.md:63`,
  `.gemini/commands/remediate-code.toml:65`, `.remediate-code/install/antigravity/PLANNING-MODE.md:63`,
  `.remediate-code/install/remediate-code.import.md:63`) regenerate in the same commit, and the parity
  test collapses to a descriptor round-trip mirroring `tests/audit/host-descriptor-roundtrip.test.mjs`.
- This is the repo's own already-named **G6** work item — no retirement collision.

### 4.5 — God-file decompositions (~198, plus the enclosing structure)

Two bounded-repair skeletons and one dispatch tail, each copy-pasted:

- **`src/remediate/steps/contractPipeline.ts` (~100)** — `buildNextContractPipelineStep` spans
  1512-2816. Four bounded-repair blocks (2130-2166 integrity, 2169-2205 traceability, 2216-2252
  obligation gate, 2262-2320 citation grounding) run the identical
  `readRepairState` → `MAX_DAG_REGENERATION_ATTEMPTS` check → `dag_regenerations.push` →
  `writeRepairState` → `archiveContractArtifact(…, "implementation_dag", "invalid")` →
  `buildPhaseStep(…rejectionRewriteInstruction(archived))` sequence; only the violations array and four
  prose strings differ. The critique gate (1900-1961) and judge gate (2035-2101) are a second identical
  pair. Endpoint: `boundedDagRepair({…, before?, onReemit?})` + `convergenceGate({…})`; citation's
  `rm(extractedPlan)` and `captureStepBoundaryFriction` become explicit hook arguments. **Blocked prompt
  text is user-facing — the helper must take full prose strings as data, never template them.**
  Loop-core → attestation.
- **`src/shared/dispatch/rollingDispatch.ts` (~70)** — five quota-outcome arms (1353-1369, 1396-1414,
  1442-1457, 1541-1558, 1584-1601) end in the identical re-queue-and-log tail; three repeat the
  once-per-pool hook gate verbatim. Endpoint: `requeueAndLog(state, packet, providerSlot, logKind,
  poolField)` + `fireOncePerPool(seenSet, poolId, fire)`. **The stderr JSON lines are an observability
  contract** — keep the `kind` strings and the differing `exhausted_pool_id` vs `pool_id` field names as
  explicit arguments. Do **not** unify with the escalation-stranding path at 1342-1349, which is
  deliberately different. Loop-core → attestation.
- **`src/remediate/steps/nextStep.ts` (~28)** — `runPhaseBoundaryGate` (4181-4238) and the inner gate
  block of `handleAllTerminalTransition` (4247-4302) run the same 11-step sequence. **Lowest
  yield-per-unit-of-loop-core-risk in the set.** The helper must **not** absorb the two preconditions
  (`phaseBoundaryToGate(state) != null` vs `hasResolvedItems(state)`) — they share the `sidecar.count`
  counter, so merging them would let one path consume the other's bounded-terminate budget. The four
  `runLogger` note strings are consumed by pipeline profiling and must stay caller-supplied labels.

Batch the loop-core items **per file** into one attested commit each — cheaper than three separate
attestations.

### 4.6 — Ask first: the legacy host-fanned wave dispatch (~250) — UNVERIFIED, **behavior change**

Both orchestrators default `rolling_engine` to **true**, and the knob is already half-retired at the
persistence layer: it is stripped from `RepoDispatchConfig` (`src/shared/types/sessionConfig.ts:872`)
and `validateRepoSessionIntent` **rejects it as an error**
(`src/shared/validation/sessionConfig.ts:876`), so it is unrepresentable in `session-config.json`. The
only surviving reachable route to the legacy wave is `REMEDIATE_ROLLING_ENGINE=false` /
`AUDIT_CODE_ROLLING_ENGINE=false`. Deleting collapses the `if (rollingEngineEnabled)` fork
(`src/remediate/steps/nextStep.ts:1952`) to its taken arm and removes the `dispatch_implement` wave emit
(~2377-2560) plus that `StepKind`.

**This removes a real escape hatch, not dead code** — if the rolling engine hits a bad case in a live
run, this is the fallback. It is also entangled: `prepareImplementDispatch` / `mergeImplementResults`
are called by `src/remediate/index.ts:257,279` and `scheduleWave` by
`src/remediate/steps/contractPipeline.ts:1664`, so those helpers survive and the true count is lower
than the branch's raw size. Loop-core → attestation.

**If the hatch is kept, take the free win anyway:** `src/remediate/steps/nextStep.ts:160` still claims
"Defaults off (proven host-fanned wave path)" — the exact opposite of the actual default. That comment
will mislead the next reader regardless of the decision.

### 4.7 — Process, not code: add whole-file orphan detection

`knip --production` structurally cannot find the largest class of dead code here (see §1). A relative-import-graph
scan with `.js`→`.ts` rewriting and `index.ts` folding, filtered to "referenced only from `tests/`",
found `src/shared/repair/*`, the six adapters, `waveManifest.ts` and the three facades in **one pass**.
Wire it as a periodic manual check beside the `knip --production` sweep CLAUDE.md already describes.

---

## 5. Refuted / leave alone

Do not re-propose these. Each was investigated and found to be earning its keep, already
single-sourced, or a false positive of a specific detection method.

**Not god-files, despite size**
- `src/shared/providers/sharedProviderConfirmation.ts` (2,347 lines) — 53% comment, 1,015 code lines,
  **zero** repeated blocks ≥14 logical lines. A well-documented ~1,000-line module.
- `src/remediate/phases/close.ts` (1,269 code lines) — no block repeat above 14 lines. Its ~8 single-use
  helpers save ~3 lines each if inlined and cost readability.
- `src/shared/dispatch/rollingDispatch.ts` — 46% comment; its only real duplication is §4.5.

**Abstractions that earn themselves**
- `BaseHttpQuotaSource` (`src/shared/quota/httpQuotaSource.ts:70-185`) — 5 real subclasses, each with a
  genuinely different credential read + endpoint mapping.
- `SubprocessTemplateProvider` — one class serving three provider names. The correct direction.
- `isInProcessWorkerProvider` / `isHeadlessPrimaryProvider` (`src/shared/providers/inProcessWorkers.ts`)
  — two deliberately distinct predicates over one base set, replacing three drifted allowlists.
- `planHybridDispatch` (`src/shared/dispatch/hybridDispatch.ts`) — live in **both** orchestrators
  (`nextStepHelpers.ts:2426`, `remediate/steps/nextStep.ts:2075`).
- The `contractPipeline` barrel and `src/shared/index.ts` **as barrels** — navigability, not speculative
  generality. Only the 270 orphan *names* go (§3.1).

**Already correctly single-sourced — do not re-audit**
- Step-contract writing (`src/audit/cli/steps.ts:105-139`, `src/remediate/steps/stepWriter.ts:34-58`
  both delegate to shared `writeStepContract`; only the zod enums differ, which is real per-mode data).
- File integrity (`src/shared/fileIntegrity.ts:54-88` owns the classify-and-bucket loop).
- Access memory (`src/shared/accessMemory.ts`; the two adapters map genuinely different inputs).
- Prompt assembly (`src/audit/cli/prompts.ts` and `src/remediate/steps/prompts.ts` share no function).
- Dispatch quota emit — the fork memory flags as open was largely closed by the H5 lift into shared
  `assembleDispatchQuota`.
- `enumerateRepoTreePaths` already delegates to shared `enumerateTrackedFilePaths`;
  `validateAgentProviderSection` / `validateTemplateProviderSection` are already table-applied; the
  severity/confidence/lens vocabularies in `auditResults.ts` already import the shared canonical sets.

**Genuine category differences — forking is correct**
- Rolling/pause lifecycle full unification is recorded as a **VERIFIED-CLOSED wrong endpoint** in
  project memory (`rolling-lifecycle-unify-full-unification-wrong.md`): audit may abandon to
  partial-coverage synthesis, remediate must not abandon half-applied edits.
- Worktree lifecycle as a whole — remediate's 926-line write/commit/merge/quarantine machinery vs
  audit's read-only detached snapshot. Only the three safety primitives are shared logic (§3.2).
- `decideNextStep` — genuinely different state machines.
- `driveRollingDispatch` vs `driveRollingImplementDispatch` are **not** duplicates despite the naming —
  the latter *calls* the former at `nextStep.ts:1433`.
- `src/audit/validation/auditResults.ts` (1,141 lines) sitting beside a zod `AuditResultSchema` is
  **not** redundant: the hand-rolled pass produces per-worker, per-field remediation prose fed back to
  workers, and enforces cross-record semantics zod cannot express (coverage-vs-task identity, line-count
  divergence, followup-task path boundaries). Replacing it is a behavior change to the worker feedback
  surface.

**Verifier refutations of specific claims** (these premises are false — do not act on them)
- "`src/audit/quota/hostLimits.ts` has zero production consumers" — **false**.
  `src/audit/cli/quotaCommand.ts:7,29` reaches it through the barrel at `src/audit/quota/index.ts:66-70`.
  The original grep matched the file path and missed the re-export.
- "`src/remediate/quota/index.ts` contains zero non-re-export lines" — **false**. `:66-69` export the
  **local** prefix-bound functions, which have a different signature from the shared ones.
- "Delete all four quota files; the symbols are identical" — **false**. `src/audit/quota/index.ts:72-79`
  barrels the genuinely audit-owned `discoveredLimits.ts`, which has no shared equivalent.
- "The three constructors of ClaudeCode/Agy/ClaudeWorker providers are line-for-line identical" —
  **false**. ClaudeWorker's runs three `requireNonEmpty` validations and stores endpoint/model.
- "`normalizeCoveragePath` is dead" — **false**. It has six live in-file callers
  (`auditResults.ts:783,882,961,1021,1059,1068`). Only the `export` keyword is surplus.
- "`resolveFreshSessionProviderName` is dead" — the **audit** copy is live in 7-8 call sites; only the
  **remediate** twin is dead. Confirm which file before touching.
- "The last two tests in `host-asset-renderer-drift.test.mjs`" — the file has **nine** tests; five live
  no-drift guards sit after the two named.

**Detection false positives (dispatch / dynamic / spawned wiring)**
- `tests/audit/helpers/provider-assisted-bridge.mjs` looks dead to a symbol grep but is **executed as a
  spawned child** by `tests/audit/provider-assisted-bridge.test.mjs:9`. Same for
  `tests/audit/helpers/{validate,synthetic-results}.mjs`.
- `parseClippy` / `parseRubocop` are live via the `candidates.ts` dispatch table (`:561`, `:577`) — only
  the `normalize*Json` halves of those two files are dead.
- `src/audit/adapters/normalizeExternal.ts` **must stay** — `acquisitionEngine.ts:11,414` imports it.
  §3.1's adapter delete is a partial-directory delete.
- Every npm-script path in `package.json` resolves to a real file; `test:single` is the only orphan. The
  low-reference scripts are all live via non-obvious wiring: `triage-backlog.mjs`,
  `poll-log-throttle.mjs`, `ciRedWorkflows.mjs`, `attest-constitutional-doc-change.mjs`,
  `rebaseline-flakes.mjs`.

**"Legacy"-labelled but live**
- The `openai_compatible` config block is called "legacy" in ~15 comments but is
  `OpenAiCompatibleProvider`'s **primary** config (`openAiCompatibleProvider.ts:185-197`). Comment
  accuracy issue only.
- `ESTIMATED_TOKENS_PER_LINE` (`tokens.ts:29`) — live via `reviewPacketSizing.ts:23,56` and
  `reviewPackets.ts:14,41`.
- The `"agent"` executor registry entry (`executors.ts:175-181`) — live across `reviewRun.ts:149,206,232`,
  `workerRunCommand.ts:48-109`, `runArtifacts.ts:178`, `renderWorkerPrompt.ts:28`, `envelope.ts:89`.
- `conceptual_depth` — live via `conceptualDispatch.ts:70,90,183`.
- The `steps/current-step.json` "latest" slot — read by `remediate/validation/artifacts.ts:383`.
- `contentKey.ts`'s "legacy lone-base" references describe a byte-identity property of the *current*
  derivation. `METADATA_SCHEMA_VERSION` handling (`artifactMetadata.ts:82-113`) is a forward-safe `>=`
  guard, not a migration.

**Wire, don't delete**
- The `uiMode` / `AutoProviderContext.headless` axis (`providerFactory.ts:70-121,188,238,302-329`) is
  dead at **both** ends — no caller supplies `uiMode` (`createFreshSessionProvider` itself doesn't
  forward it, `:439-442`), and `SessionConfig.ui_mode` (`sessionConfig.ts:778`) is validated
  (`validation/sessionConfig.ts:736-742`) and **never read**. But deleting retires **INV-SCC-01**
  ("a provider whose launch deterministically rejects headless input must never be auto-selected for a
  headless run"), leaving only `OpenCodeProvider`'s launch-time throw — degrading the failure from
  "never selected" to "selected, then hard-fails after the packet is built". That contradicts
  *enforce-in-tooling*. Wiring is ~6 lines once §4.1 removes the wrappers' options narrowing; the two
  headless dispatch paths (`rollingAuditDispatch.ts:336`, `workerTasks.ts:61`) already know their mode.
  **This conflicts with the `ui_mode` deletion in §3.4 — resolve before acting on either.**
- `src/audit/quota/discoveredLimits.ts` write path — §3.1.
- `getTreeSitterDegradationCount` (`treeSitter.ts:58`) is write-only telemetry (`_degradationCount`
  incremented at `:99,126,176,203`, read only by this getter, called only by tests). Deleting is honest
  dead-code removal but costs the observable
  `tests/audit/tree-sitter-language-cache.test.mjs` uses. Plumb the count into the extraction artifact
  instead.
- `FreshSessionProviderDeps.runLogger` (`providerFactory.ts:420`) is never supplied, so the structured
  `provider_launch` event at `:460` never fires. Removing it in §2.2 is behavior-neutral but it is a
  **real observability gap** — report it, don't bury it.

**Test seams — deleting is a reshuffle or a coverage loss**
- `cliTestUtils` (`src/audit/cli.ts:52`), `__resetTreeSitterForTests` (a real hermeticity seam),
  `__resolveFromPathForTests`, `runInProcessAuditDispatch` (`nextStepCommand.ts:1548`, drives the
  provider-matrix e2e), `projectDesignReviewInputs`.
- `tests/audit/quota-*.test.mjs` (9 files) test `src/shared/quota/` and arguably belong under
  `tests/shared/` — but `tests/shared/errorParsing.test.mjs` covers tier-1 mutual-exclusivity and
  channel-isolation that the audit copies do not. Moving is a reshuffle; deleting either side drops real
  invariants.
- The control-byte predicate in both `scripts/check-control-bytes.mjs` and
  `.claude/hooks/tool-input-guard.mjs:87` is **deliberate** and documented in the hook ("the same rule
  moved to the keystroke that causes it").

**Clean already:** zero `TODO`/`FIXME`/`XXX`/`HACK` markers exist in `src/`. Only two "for now" comments
survive (`providerConfirmationStep.ts:347`, `derive.ts:263`).

---

## 6. Summary

| Dimension | Items (C / P / U) | Est. lines removable |
|---|---|---|
| Dead code | 8 (1 / 0 / 7) | **~5,276** |
| audit↔remediate duplication | 4 (1 / 1 / 2) | **~1,055** |
| Scripts, hooks & test substrate | 7 (0 / 0 / 7) | **~731** |
| God-files | 6 (1 / 1 / 4) | **~693** |
| Legacy paths | 6 (0 / 0 / 6) | **~623** |
| Knob sprawl | 6 (0 / 0 / 6) | **~512** |
| Redundant guards | 8 (4 / 4 / 0) | **~313** |
| Over-abstraction | 3 (2 / 1 / 0) | **~173** |
| **Total** | **48 (9 / 7 / 32)** | **~9,376** |

C = CONFIRMED, P = PARTIAL, U = UNVERIFIED. Totals use **corrected** estimates throughout; every figure
a verifier shrank uses the smaller number (e.g. host-gate emits 115→85, final-gate reblock 45→28,
channel classifiers 130→75, design-spec gates 45→34, readability gate 22→8, E1 tests 50→26).

**Deduplication applied:** the provider-adapter finding appeared in both *over-abstraction* and
*audit↔remediate duplication* — counted once at the CONFIRMED 270. The quota-layer finding likewise —
counted once at the PARTIAL 200. The legacy `design_review` CLI arm appeared in both *god-files* (60)
and *legacy paths* (230) — counted once at 230. `detectHostActiveSubagentLimit` and remediate's
`resolveFreshSessionProviderName` appear in both *dead code* and the OrchestratorMode merge — the dead-code
row is discounted 325→250.

**Split:** roughly **5,400 lines from `src/` + `scripts/`** and **~4,000 from `tests/`**. Against
~151,600 total lines, that is **~6%** — and ~56% of it is a single class: infrastructure that was built,
tested, exported, and never wired.

### Items that change behavior

The review's mandate was code removal, not feature removal. These nine do change behavior and each needs
an explicit decision, not a mechanical merge:

| Item | Section | Change |
|---|---|---|
| `rolling_engine` legacy wave path | §4.6 | Removes a live escape hatch. **Ask first.** |
| `agy` `gemini` fallback | §3.7 | A gemini-only machine stops auto-resolving to agy. |
| `--host-*` → `--auditor` | §4.4 | CLI surface; 6 loader assets regenerate atomically. |
| Postinstall merge collapse | §3.6 | Changes what an existing user's `opencode.json` converges to. |
| Worktree `canonicalPathKey` unification | §3.2 | Case-folding becomes win32-only → stricter on Linux. |
| `JudgeRepairTarget` union merge | §3.7 | A stale `design_spec` judge report is rejected, not remapped. |
| b64 flags + `--preferred-executor` | §3.4 | Removes undocumented CLI entry points. |
| Adding the `agy` row to the PATH guard | §2.7 | A previously-unvalidated config can now emit an issue. **Separate commit.** |
| `smoke-linked-remediate-code.mjs` actually linking | §3.6 | Starts exercising something it does not today. A fix, not a simplification. |

### Sequencing

1. **`src/shared/index.ts` barrel (§3.1, ~280)** — largest single deletion, touches no logic, fully
   independent. Do it first.
2. **The mechanical CONFIRMED set (§2.3–§2.9)** — batch the loop-core ones per file into one attested
   commit each.
3. **The owner decisions (§2.1 F3 seam, §4.6 rolling wave, §3.1 discovered-limits, §5 `ui_mode`)** —
   these gate ~2,700 lines between them and cannot be resolved by reading more code.
4. **§4.1 OrchestratorMode** as one atomic commit (shims + barrels + parity tests together — the
   atomic-replace ordering invariant forbids add-then-delete across commits).
5. **§4.2 gate table, §4.3 design-review retirement, §4.4 G6** — independent multi-commit tracks.
6. **§3.6 postinstall last** — it is the only item that touches an already-installed user's config.

Every loop-core commit (`src/shared/loopCorePaths.ts` covers `contractPipeline.ts`, `nextStep.ts`,
`src/shared/dispatch/`, `src/audit/orchestrator/rollingDispatch.ts`) needs a fresh, staged-tree-bound
review attestation.

---

## Tracking

**This report is the map, not the edit — nothing in it has been applied.**

It has no entry in the program of record yet. `docs/backlog/forward-tracks.md` is its home, and the
entry should be ONE line pointing here, never a restatement of the findings (the backlog carries a
per-entry size budget, and a second copy of a 9,400-line analysis would decay against this one).

It was deliberately not added on 2026-07-28: a concurrent session was mid-refactor of
`scripts/shared/generate-handoff-roadmap.mjs`, changing the generated section from *every open item*
to *`▶`-pinned entries only*. Adding a backlog entry forces a `docs/HANDOFF.md` regeneration, which
would have overwritten that in-flight work with the old generator's output. **Add the entry once
that refactor lands** — and pin it with `▶` only if it is genuinely the next thing to do.

⚠ Two claims elsewhere in the repo are FALSE against HEAD and are corrected by this review; fix them
whether or not the deletions happen:
- `docs/backlog/forward-tracks.md` asserts the F3/O3/F4 emit-validate-repair seam is live. It has
  zero importers in `src/` (§2.1).
- `CLAUDE.md:129` documents `resolveHostConcurrencyLimit` as dispatch concurrency machinery. It has
  zero call sites in `src/` — definition, one unconsumed re-export, and its own tests.
