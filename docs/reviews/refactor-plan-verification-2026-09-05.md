# Refactor-plan verification against HEAD

**Date:** 2026-09-05  
**Scope:** the nine 2026-09-05 refactor plans not yet implemented.  
**Method:** one agent per plan, reading the plan in full and then checking every claim against
the source at HEAD. Where plan and source disagreed, the source won and the agent recorded where.

## Why this exists

The plans were authored on 2026-09-05 against a tree that has since moved: items 3.5, 3.1, 3.4
and 2.5 landed, plus a graph-edge cache-key bump and a gate-wiring change. Line numbers quoted in
the plans are unreliable, and several plans carry claims that do not hold against the code.

**Every premise held.** All nine describe real duplication or real complexity. What did not hold
was a long tail of specifics — symbol names, call-site counts, coverage claims, and in three cases
a proposed change that would have caused a regression if implemented as written.

| | |
|---|---|
| Plans verified | 9 of 9 |
| Premises that held | all |
| Plan errors found | **73** |
| Behavior changes identified | 47 |
| Choices left open for the owner | 58 |
| Loop-core items (need an attestation) | 5 |

---

## 2.1 deriveObligationState function twin

**Premise holds:** yes  
**Loop-core:** yes — commit needs a review attestation

The duplication is real at HEAD, but NOT in the "byte-identical" form the plan's Overview claims. Two definitions exist: `src/audit/cli/nextStepHelpers.ts:2582` (module-private `function deriveObligationState`) and `src/audit/orchestrator/advance.ts:601` (`export function deriveObligationState`). Both have the identical signature `(id: string, cache: WeakMap<ArtifactBundle, AuditState>) => (bundle: ArtifactBundle) => "missing" | "stale" | "satisfied"` and, after stripping comments and indentation, identical bodies EXCEPT for two textual differences I diffed: (a) the `export` keyword on advance.ts's declaration, and (b) the call formatting — nextStepHelpers.ts:2607 is `state = deriveAuditState(bundle, { emitStaleness: false });` on one line, advance.ts:613-615 is `state = deriveAuditState(bundle, {` / `emitStaleness: false,` / `});` across three. Token-for-token the executable code is the same (complete-gate short-circuit -> WeakMap memo on bundle identity -> deriveAuditState(bundle,{emitStaleness:false}) on miss -> find-by-id -> `if (!found) return "satisfied"` -> missing/stale passthrough, else satisfied). The interior COMMENTS differ substantively, not merely the jsdoc as the plan says: nextStepHelpers carries the "namesake"/6145a1a3/emit-off-preserve-list block (2590-2606), advance.ts carries a shorter identity-safety block (609-612) plus a much longer jsdoc (581-600). So the plan's "byte-identical" and "Only the doc comments differ" are both overstated; "logically identical" holds. The rest of the premise verified true: advance.ts's `buildPlanDrawObligations` (735-754) and nextStepHelpers' `buildAuditObligations` (2626+) each call `derive: deriveObligationState(id, cache)` inside a `PRIORITY.map`; advance's memo is `new WeakMap<ArtifactBundle, AuditState>()` at advance.ts:824, inside `advanceAuditInner` (declared 794) as the plan states; the fold's memo is created at nextStepHelpers.ts:2631 inside `buildAuditObligations`. `deriveAuditState` and both types are already in scope in `src/audit/orchestrator/state.ts` (deriveAuditState declared at state.ts:72; `import type { ArtifactBundle }` line 2; `AuditState` in the type import block lines 3-8), so the plan's "no new imports needed" is correct.

### Files to change

- `src/audit/orchestrator/obligationDerive.ts (NEW — the plan's stated fallback home; see minimal_change for why this, not state.ts)`
- `src/audit/orchestrator/advance.ts`
- `src/audit/cli/nextStepHelpers.ts`
- `tests/audit/advance-drain-loop.test.ts`

### Symbol checks

| Symbol | File | Found | Note |
|---|---|---|---|
| `deriveObligationState (fold twin)` | `src/audit/cli/nextStepHelpers.ts` | yes | Line 2582, module-private `function deriveObligationState(id, cache)`. Signature matches the plan exactly. Body matches the plan's description exactly. |
| `deriveObligationState (plan-draw twin)` | `src/audit/orchestrator/advance.ts` | yes | Line 601, `export function deriveObligationState(id, cache)`. Signature matches the plan exactly. Body differs from the fold twin only in the multi-line formatting of the deriveAuditState call. |
| `deriveAuditState` | `src/audit/orchestrator/state.ts` | yes | Line 72, exported, `(bundle: ArtifactBundle, options: DeriveAuditStateOptions = {}) => AuditState`. `DeriveAuditStateOptions.emitStaleness` at line 61-69. Matches the plan. |
| `ArtifactBundle` | `src/audit/io/artifacts.ts` | yes | Type-imported into state.ts line 2, into nextStepHelpers.ts line 34, and used in advance.ts. In scope at all three sites. |
| `AuditState` | `src/audit/types/auditState.ts` | yes | Type-imported into state.ts (lines 3-8), nextStepHelpers.ts line 54, advance.ts line 3. |
| `PRIORITY` | `src/audit/orchestrator/nextStep.ts` | yes | Imported and mapped by both registry builders. Untouched by this item. |
| `buildPlanDrawObligations` | `src/audit/orchestrator/advance.ts` | yes | Declared line 745, takes `cache: WeakMap<ArtifactBundle, AuditState>`, maps PRIORITY with `derive: deriveObligationState(id, cache)` at line 750. Shape matches the plan. |
| `buildAuditObligations` | `src/audit/cli/nextStepHelpers.ts` | yes | Declared line 2626, EXPORTED and takes NO parameters; creates its own `const cache = new WeakMap<...>()` at line 2631; `derive: deriveObligationState(id, cache)` at line 2849. Matches the plan. |
| `advanceAuditInner` | `src/audit/orchestrator/advance.ts` | yes | Declared line 794; creates `const deriveCache = new WeakMap<ArtifactBundle, AuditState>()` at line 824. The plan is right that the memo is created here; note advance.ts's OWN jsdoc at line 591-592 wrongly says the cache is created 'in advanceAudit' — a pre-existing doc inaccuracy worth fixing in the merged jsdoc. |
| `isActionableObligationState` | `src/shared/engine/obligationEngine.ts` | yes | Line 69. Confirms the plan's claim that only missing/stale are actionable, so collapsing everything else to "satisfied" is the same partition. |
| `obligationEngine module header (the layering claim)` | `src/shared/engine/obligationEngine.ts` | yes | Lines 1-18 do say the engine owns only ordered selection and that 'each orchestrator derives its own obligation states'. The plan's rejection of the catalog's shared/ home is correct and source-backed. |
| `deriveObligationState import in the drain-loop test` | `tests/audit/advance-drain-loop.test.ts` | yes | PARTIAL SHAPE MISMATCH. The plan calls it 'one import' to repoint. It is not a static import: lines 11-19 are a `const { advanceAudit, deriveObligationState, engineMaxTransitions, ExecutorFailure, findExecutorFailure, findPriorityOrderingViolations, MAX_DRAIN_STEPS } = await import("../../src/audit/orchestrator/advance.js");` destructure. The implementer must remove the name from that destructure and add a second `await import` block for the new home. Test body (line 323-341) unchanged. |
| `one-holistic-derivation-per-scan test (NOT named by the plan)` | `tests/audit/one-holistic-derivation-per-scan.test.ts` | yes | PLAN OMISSION. This test does not import deriveObligationState, so the plan's grep missed it, but it is the test that actually pins the memo. It `vi.mock`s `../../src/audit/orchestrator/state.js`, spreads `...actual`, and replaces `deriveAuditState` with a spying stub, then calls `buildAuditObligations()` and every def's `derive`, asserting exactly ONE holistic derivation. This makes the plan's recommended home unsafe — see conflicts_with_landed and minimal_change. |
| `createObligationDeriveCache` | `(proposed by the plan, does not exist)` | **NO** | Optional additive factory. No such symbol at HEAD. If adopted it gains two adopters immediately (both builders), so it will not trip check:deadcode; if adopted with only one adopter it would. |

### Plan errors (8)

- Overview claims the two bodies are 'byte-identical'. They are not. advance.ts:601 carries `export`, and its deriveAuditState call is formatted across three lines (613-615) where nextStepHelpers.ts:2607 is one line. The plan's own §1 later says 'logically identical', which is the accurate claim; the Overview contradicts it.

- 'Only the doc comments differ (each names the other as its namesake)' is wrong: the INTERIOR comments differ substantively too — nextStepHelpers.ts:2590-2606 is a six-paragraph block (namesake, 6145a1a3, identity safety, emit-off preserve-list) while advance.ts:609-612 is a four-line identity-safety note. The 'merge both jsdocs' instruction must extend to the interior comments or content is silently lost.

- MATERIAL: §2 asserts 'No other importers. Verified by repo-wide grep for deriveObligationState' and concludes 'the existing suite is the regression net'. The grep was symbol-name-based and therefore missed `tests/audit/one-holistic-derivation-per-scan.test.ts`, which reaches the function through `buildAuditObligations()` and pins its memo via a `vi.mock` of `src/audit/orchestrator/state.js`. That test makes the plan's RECOMMENDED home (§1.3, state.ts) break a green test: an intra-module call from state.ts to its own deriveAuditState is not intercepted by the mock, so the spy sees 0 derivations against an assertion of 1. The plan's risk list ('all low', three named risks) does not contain this one.

- §3.4/§4 step 4 describe 'repoint one import' in tests/audit/advance-drain-loop.test.ts. That file has no static import of the symbol — it is a destructure off a top-level `await import(".../advance.js")` (lines 11-19). The edit is a destructure split plus a new dynamic import, not a path swap.

- §1.3 and §5 claim relocating into state.ts 'introduces no new import edge and no cycle risk' and that the import block should be 'diff-identical'. True for imports, but incomplete as a safety argument — the hazard is the mock boundary, not the import graph.

- Minor: the plan repeats advance.ts's own jsdoc inaccuracy in reverse. advance.ts:591-592 says the cache is 'created in advanceAudit'; it is actually created in advanceAuditInner (line 824). The plan states advanceAuditInner correctly, so the merged jsdoc must not copy advance.ts's wording verbatim.

- Minor: §1.1 says '~25 passes' and advance.ts's jsdoc says '~8-9x the hand loop's'; the one-holistic test asserts only 'exactly 1'. Neither number is pinned by anything, so do not restate a count in the merged jsdoc without measuring it.

- Not a plan error but a correction the plan already makes, worth carrying forward: the source catalog (docs/reviews/duplication-and-complexity-catalog-2026-09-05.md:37) quotes a signature `deriveObligationState(runArtifacts: RunArtifactBundle, ...): ObligationState` that exists nowhere in the tree, and proposes src/shared/engine/obligationEngine.ts as the home. The plan's rejection of that home is source-backed by the engine module header (lines 1-18) and is correct.

### Behavior changes (6)

- No runtime behavior change. Strictly checked: signature identical, body token-identical, precedence of the complete-gate above the memo preserved, accepted inputs unchanged, return value for every input unchanged, memo ownership (fresh WeakMap per registry construction / per advanceAudit call, never module-level) unchanged.

- Module export-surface change (not runtime): `src/audit/orchestrator/advance.ts` stops exporting `deriveObligationState`. Its only external consumer is tests/audit/advance-drain-loop.test.ts; the plan explicitly forbids a compat re-export.

- Visibility change (not runtime): the nextStepHelpers.ts copy goes from module-private to imported-from-a-shared-module, so the fold's derive becomes reachable by any orchestrator module.

- If the optional `createObligationDeriveCache()` factory is adopted: one new exported symbol and two call sites replace `new WeakMap<ArtifactBundle, AuditState>()`. Still no behavior change (same WeakMap, same freshness), but it is an API addition, not a pure move.

- Comment/jsdoc content changes in advance.ts (lines 82, 743, 822) and the deletion of the nextStepHelpers 'namesake' comment. Non-executable.

- NOT a behavior change but worth flagging as a divergence from the plan's stated intent: choosing state.ts as the home WOULD change observable test behavior (it breaks the vi.mock interception in one-holistic-derivation-per-scan.test.ts). That is precisely why the fallback home is selected.

### Minimal change

Do the relocation, but into the plan's FALLBACK home, not its recommended one.

1. Create `src/audit/orchestrator/obligationDerive.ts` containing exactly one exported symbol:
   `export function deriveObligationState(id: string, cache: WeakMap<ArtifactBundle, AuditState>): (bundle: ArtifactBundle) => "missing" | "stale" | "satisfied"`
   with the body copied verbatim from either twin (they are token-identical): complete-gate `if (bundle.audit_state?.status === "complete") return "satisfied";` above the memo, `cache.get` / on miss `deriveAuditState(bundle, { emitStaleness: false })` then `cache.set`, `state.obligations.find((o) => o.id === id)`, `if (!found) return "satisfied";`, missing/stale passthrough else "satisfied".
   Imports: `import { deriveAuditState } from "./state.js";`, `import type { ArtifactBundle } from "../io/artifacts.js";`, `import type { AuditState } from "../types/auditState.js";`. No cycle: state.ts does not import advance.ts or the CLI.
   Merge the two comment blocks into one jsdoc (keep: the holistic-scan narrowing, the 6145a1a3 memo regression, the identity-key safety argument, the emit-off/one-consolidated-record contract, and the pruned-id convention for friction_capture_current). Correct advance.ts's inherited error while merging: the plan-draw cache is created in `advanceAuditInner`, not `advanceAudit`.

2. `src/audit/orchestrator/advance.ts`: delete lines 581-624 (the jsdoc + the exported definition); add `import { deriveObligationState } from "./obligationDerive.js";`. Leave `buildPlanDrawObligations` and `advanceAuditInner`'s `deriveCache` untouched. Reword the three comment pointers that now imply a local definition: line 82 (`see deriveObligationState: the memo is keyed on bundle IDENTITY`), line 743 (`see \`deriveObligationState\``), line 822 (`Per-call derivation memo (see deriveObligationState)`).

3. `src/audit/cli/nextStepHelpers.ts`: delete lines 2575-2614 (jsdoc + private definition, including the "namesake" comment at 2590 — after this, `grep -rn namesake src tests` must return nothing); add `import { deriveObligationState } from "../orchestrator/obligationDerive.js";`. Leave `buildAuditObligations` untouched.

4. `tests/audit/advance-drain-loop.test.ts`: remove `deriveObligationState,` from the `await import(".../advance.js")` destructure (lines 11-19) and add `const { deriveObligationState } = await import("../../src/audit/orchestrator/obligationDerive.js");`. Test body unchanged.

WHY NOT state.ts (the plan's §1.3 recommendation): `tests/audit/one-holistic-derivation-per-scan.test.ts` mocks the state.js MODULE and replaces its `deriveAuditState` export with a spy. vi.mock only intercepts cross-module imports; a call from inside state.ts to its own module-local `deriveAuditState` binding is not intercepted. Put deriveObligationState in state.ts and that test's spy records 0 calls where it asserts 1 — the CX-02 scan-cost invariant test goes red and would have to be rewritten, which makes the change no longer a pure relocation. `obligationDerive.ts` keeps the module boundary the mock depends on (it imports deriveAuditState from the mocked state.js), so the test passes untouched. The plan itself lists this module as an acceptable fallback and says the rest of the plan is unchanged apart from the import path — so this is the plan's own option B, selected on evidence.

Skip the optional `createObligationDeriveCache` factory for the minimal change (see open_choices).

### Red-green plan

Coverage EXISTS, but not where the plan says it does.

Primary covering test: `tests/audit/one-holistic-derivation-per-scan.test.ts` ("one fold scan performs ONE holistic audit-state derivation, not one per obligation"). It builds the real fold registry via `buildAuditObligations()` and calls every def's `derive` against the same bundle, asserting `deriveSpy.mock.calls.length === 1`.
Single mutation that reds it: delete the `cache.set(bundle, state);` line from the relocated function (or change the memo key to a fresh object). Every def then re-derives and the assertion fails with "one scan over N obligations should derive the holistic audit state once; it derived it N times". This proves the moved code is the code actually on the fold's derive path AND that the mock still reaches it — i.e. it is the exact test that catches the state.ts home being wrong. Run it FIRST after the move.

Secondary: `tests/audit/advance-drain-loop.test.ts` "the drain re-derives obligation state at every transition (the memo is per-bundle identity)" (line 323) proves the symbol resolves from its new home and that the missing/satisfied mapping is intact. Mutation that reds it: change `if (!found) return "satisfied";` to return `"missing"` — the `derive(after)` expectation of "satisfied" would still hold (repo_manifest IS found once present), so use instead: remove the `bundle.audit_state?.status === "complete"` short-circuit... that also does not red it. The honest statement: this test asserts RETURN VALUES only, so it does NOT red on memo loss (both `derive(before)` calls return "missing" with or without the cache) and its `cache.has(after)` assertion is false either way. Treat it as an import-resolution and mapping smoke test, not the memo's regression net. That is a coverage nuance the plan gets wrong when it calls this test the one that "directly exercises the moved symbol's contract".

Coverage gap (a finding, not an obstacle): nothing asserts that the PLAN DRAW's registry (`buildPlanDrawObligations` in advance.ts) shares the same derive implementation — after the move, a re-twinning in advance.ts would be caught by no test. The plan's own suggested follow-up (an import-equality assertion that both builders resolve the same function reference) would close it; it is not gated on this item.

Suite to run: `npx vitest run tests/audit/one-holistic-derivation-per-scan.test.ts tests/audit/advance-drain-loop.test.ts`, then `npm run build && npm run check`, then the full audit suite.

### Open choices (6)

- THE HOME. The plan recommends src/audit/orchestrator/state.ts and offers src/audit/orchestrator/obligationDerive.ts as an 'acceptable fallback if review prefers it'. The source forces a decision the plan did not know it was asking: state.ts requires rewriting the vi.mock in tests/audit/one-holistic-derivation-per-scan.test.ts (making the change no longer a pure relocation and weakening a CX-02 invariant test); obligationDerive.ts keeps every test byte-unchanged at the cost of one more file. Recommend obligationDerive.ts; a human must confirm they accept the extra module.

- Whether to adopt the optional `createObligationDeriveCache()` factory. Pro: single-sources the 'fresh per registry, never module-level' discipline currently spelled as a bare `new WeakMap` at nextStepHelpers.ts:2631 and advance.ts:824. Con: an additive export on a pure-relocation commit; the plan says skip it for a minimal diff.

- Whether to add the plan's suggested follow-up hardening test (both registry builders resolve the same deriveObligationState reference). The plan calls it 'recommended as a follow-up, not a gate'. This is the only thing that would mechanically prevent re-twinning, and it closes the coverage gap named above.

- How much of each comment block survives the merge — the two blocks assert overlapping but non-identical facts (namesake / 6145a1a3 / identity safety / emit-off preserve-list / pruned-id convention / the disputed '~25' and '~8-9x' numbers).

- Whether to fix advance.ts's pre-existing 'created in advanceAudit' jsdoc inaccuracy in this commit or leave it out as unrelated.

- Loop-core attestation: who attests and under which class (--attester-class agent|human). All three source files are loop-core, so the commit cannot land without one, and a 'concerns' verdict without an override blocks any commit that can reach main.

### Against what already landed

No conflict with any of the six listed landed commits. They touch src/audit/extractors/graphSignals.ts, src/audit/extractors/graphManifestEdges/workspace.ts, toml.ts, yaml.ts, src/audit/extractors/commentDecomposition.ts, src/audit/extractors/graph.ts, scripts/shared/tsAstHelpers.mjs, scripts/generate-spec-mirrors.mjs and scripts/guard-reach-data.mjs — a disjoint set from this item's four files. Last touches of this item's files are older: advance.ts b4a3eb4a (2026-08-28), state.ts 44065eaa (2026-09-03), nextStepHelpers.ts 830885fb (2026-09-03). Nothing landed already does any part of this plan; both twins are still present and neither has been deleted or repointed. One landed commit is procedurally relevant only: check:control-bytes is now preCommit 'always', so the new/edited files must be control-byte clean. Also note 44065eaa added the `not_applicable` obligation state to state.ts; deriveObligationState collapses it to "satisfied", which is unchanged by this move and consistent with isActionableObligationState.

---

## 2.2 — CLI Step Execution Scaffolding

**Premise holds:** yes  
**Loop-core:** no

PREMISE HOLDS, with one correction to how the plan words it. The plan says all three commands "follow the identical 4-step scaffold". They are NOT identical bodies — they differ in three ways, all of which the plan does eventually name in its variance table, so the prose overstates while the table is accurate.

C:\Code\audit-tools\src\audit\cli\forceSynthesisCommand.ts (cmdForceSynthesis):
  const root = getRootDir(argv);
  const artifactsDir = getArtifactsDir(argv);
  const result = await runAuditStep({ root, artifactsDir, preferredExecutor: "synthesis_executor" });
  console.log(JSON.stringify({ artifacts_dir: artifactsDir, selected_executor: result.selected_executor, progress_summary: result.progress_summary }, null, 2));

C:\Code\audit-tools\src\audit\cli\intakeCommand.ts (cmdIntake): byte-identical to the above EXCEPT (a) `warnIfNotGitRepo(root);` between the two dir calls and (b) preferredExecutor: "intake_executor".

C:\Code\audit-tools\src\audit\cli\synthesizeCommand.ts (cmdSynthesize):
  const artifactsDir = getArtifactsDir(argv);            // <-- artifactsDir FIRST
  const result = await runAuditStep({ root: getRootDir(argv), artifactsDir, preferredExecutor: "synthesis_executor" });   // <-- root resolved INLINE, after artifactsDir
  outputJson({ artifacts_dir: artifactsDir, selected_executor: result.selected_executor, progress_summary: result.progress_summary });

So: same emitted payload (same three keys, same order, both paths end in JSON.stringify(data, null, 2) — outputJson at C:\Code\audit-tools\src\audit\cli\cliHelpers.ts is exactly that one line), but different resolution ORDER in cmdSynthesize and a hand-rolled console.log in the other two. The duplication is real and the plan's stated ~29→~10 line reduction for cmdForceSynthesis is roughly right (29 lines today).

The plan's supporting claims also check out at HEAD: cliHelpers.ts has zero imports (pure console); outputJson is adopted by only 6 other modules (requeueCommand, resynthesizeCommand, sampleRunCommand, statusCommand, synthesizeCommand, updateRuntimeValidationCommand) while 13 modules still hand-roll console.log; getArtifactsDir does re-resolve getRootDir when --artifacts-dir is absent (src\audit\cli\args.ts:103-108), so the double-parse the plan notes is real; resynthesizeCommand.ts really does bypass getArtifactsDir for auditArtifactsDir(root) (lines 12-13, 26-27); nextStepCommand.ts:264 really does call warnIfNotGitRepo.

### Files to change

- `src/audit/cli/stepCommand.ts (NEW — name collides visually with the *Command.ts CLI-verb convention; see open_choices)`
- `src/audit/cli/forceSynthesisCommand.ts`
- `src/audit/cli/intakeCommand.ts`
- `src/audit/cli/synthesizeCommand.ts`

### Symbol checks

| Symbol | File | Found | Note |
|---|---|---|---|
| `cmdForceSynthesis` | `src/audit/cli/forceSynthesisCommand.ts` | yes | Exists, async (argv: string[]) => Promise<void>. Shape matches the plan exactly: getRootDir -> getArtifactsDir -> runAuditStep({preferredExecutor:"synthesis_executor"}) -> inline console.log(JSON.stringify(...,null,2)). Carries the 3-line recovery docstring the plan says must survive. |
| `cmdIntake` | `src/audit/cli/intakeCommand.ts` | yes | Exists. Shape matches: getRootDir -> warnIfNotGitRepo(root) -> getArtifactsDir -> runAuditStep({preferredExecutor:"intake_executor"}) -> inline console.log(JSON.stringify(...)). No docstring. |
| `cmdSynthesize` | `src/audit/cli/synthesizeCommand.ts` | yes | Exists. Shape matches the plan's variance table (outputJson + inline getRootDir), NOT the plan's prose 'identical scaffold'. artifactsDir is resolved BEFORE root. |
| `runAuditStep` | `src/audit/cli/auditStep.ts` | yes | Line 80. Signature (options: RunAuditStepOptions) => Promise<AdvanceAuditResult>. Locking entry (wraps runAuditStepLocked in withArtifactTreeHold). |
| `RunAuditStepOptions` | `src/audit/cli/auditStep.ts` | yes | Line 42, exported interface. preferredExecutor is `preferredExecutor?: string` — so the plan's NonNullable<RunAuditStepOptions["preferredExecutor"]> resolves to plain `string`, which typechecks but gives NO compile-time check that the executor id is real. |
| `getRootDir` | `src/audit/cli/args.ts` | yes | Line 96. Explicit --root -> resolveRepoRoot; absent -> discoverRepoRoot(callerWorkingDirectory()) — filesystem-touching, not pure. |
| `getArtifactsDir` | `src/audit/cli/args.ts` | yes | Line 103. Falls back to auditArtifactsDir(getRootDir(argv)) — confirms the double-resolution the plan notes. |
| `warnIfNotGitRepo` | `src/audit/cli/args.ts` | yes | Line 110. console.warn only, never throws. Callers at HEAD: intakeCommand.ts:6 and nextStepCommand.ts:264 only. |
| `outputJson` | `src/audit/cli/cliHelpers.ts` | yes | Exists, one line: console.log(JSON.stringify(data, null, 2)). Docstring does say it centralizes the repeated pattern, as the plan claims. |
| `runAuditStepUnlocked` | `src/audit/cli/auditStep.ts` | yes | Line 149. Lock-free core used by the fold. Unchanged by this item. |
| `withArtifactTreeHold` | `src/audit/cli/auditStep.ts` | yes | Line 120; ARTIFACT_TREE_LOCK_TIMEOUT_MS at line 104. Both unchanged by this item. |
| `ingestBatchAuditResults` | `src/audit/cli/auditStep.ts` | yes | Line 370. Wave-2 only (cmdIngestResults batch branch). |
| `cmdPlan` | `src/audit/cli/planCommand.ts` | yes | EXISTS BUT SHAPE DIFFERS FROM THE PLAN: it passes NO preferredExecutor at all — runAuditStep({root, artifactsDir, since: getFlag(argv,"--since")}). The plan's StepCommandSpec makes preferredExecutor REQUIRED, so cmdPlan cannot adopt the scaffold as specified without making that field optional. Plan error for wave 2 (§3.5). |
| `cmdIngestResults` | `src/audit/cli/ingestResultsCommand.ts` | yes | Exists; matches the plan's description (mutual-exclusion guard via hasFlag, batch branch with imported_files, single branch with preferredExecutor "result_ingestion_executor" + auditResultsPath). Wave 2. |
| `cmdImportExternalAnalyzer` | `src/audit/cli/importExternalAnalyzerCommand.ts` | yes | Exists; matches the plan (pre-read via readJsonFile, results-array check, externalAnalyzerData passthrough, payload {artifacts_dir, tool, imported_count, selected_executor} — note NO progress_summary, as the plan says). Wave 2. |
| `next_likely_step` | `src/audit/orchestrator/advanceTypes.ts` | yes | Line 121, `string \| null` on AdvanceAuditResult — cmdPlan's extra payload key is real. |
| `getFlag` | `src/audit/cli/args.ts` | yes | Line 34, supports a default third argument (used by cmdImportExternalAnalyzer). |
| `getBatchResultsDir` | `src/audit/cli/args.ts` | yes | Line 118. Exists as the plan claims. |
| `src/audit/cli/stepCommand.ts` | `src/audit/cli/stepCommand.ts` | **NO** | Does not exist — the new module the plan proposes. Correctly described as new. |
| `runStepCommand / StepCommandSpec` | `src/audit/cli/stepCommand.ts` | **NO** | Do not exist anywhere in src/. New symbols. |
| `tests/audit/artifact-tree-lock-single-surface.test.ts` | `tests/audit/artifact-tree-lock-single-surface.test.ts` | yes | Exists, but it constrains only references to `artifactTreeLockPath` (allow-list: auditToolsPaths.ts, shared/index.ts, auditStep.ts) plus the timeout constant. It does NOT constrain who imports runAuditStep, so it is NOT the guard the plan's §5.3 implies. |
| `the 'dynamic lock-count acceptance test'` | `tests/audit/one-lock-hold-per-next-step.test.ts` | yes | Named in tests/audit/fold-lock-import-boundary.test.ts's header. The actual import-boundary guard is tests/audit/fold-lock-import-boundary.test.ts, which the plan never names: it greps nextStepHelpers.ts's IMPORT CLAUSES for the literal names withFileLock/artifactTreeLockPath/runAuditStep/ensureSemanticReviewRun/writeCoreArtifacts. |
| `tests/audit/cli-dispatcher.test.ts` | `tests/audit/cli-dispatcher.test.ts` | yes | Rows at lines 56/64/65 exist. It only asserts `typeof mod[exportName] === "function"` after a dynamic import — it exercises no command body. |
| `tests/audit/cli-remediation.test.ts` | `tests/audit/cli-remediation.test.ts` | yes | Rows at 325/333/334 exist, same typeof-function assertion against dist/. Its warnIfNotGitRepo tests (lines 238-275) call cliTestUtils.warnIfNotGitRepo DIRECTLY, never through cmdIntake. |
| `tests/audit/helpers/completion-harness.ts` | `tests/audit/helpers/completion-harness.ts` | yes | Exists; line 104 comment mentions ingest-results/force-synthesis as the plan says. |

### Plan errors (8)

- §3.1 / §5.3: 'getRootDir(argv) is resolved once into root ... the scaffold resolves once and passes both'. FALSE against src/audit/cli/args.ts:103-108 — getArtifactsDir(argv) unconditionally re-derives the root via auditArtifactsDir(getRootDir(argv)) whenever --artifacts-dir is absent. The scaffold as written still resolves twice on the default path. The §5.3 verification step 'confirm getRootDir is called once per scaffold invocation' would therefore FAIL as stated.

- §3.5 (wave 2, cmdPlan): the plan says adopt cmdPlan with `extraOptions: (argv) => ({ since: getFlag(argv, "--since") })`. src/audit/cli/planCommand.ts passes NO preferredExecutor, but StepCommandSpec.preferredExecutor is required. The plan names no executor id for cmdPlan and gives no way to omit it. Wave 2 for cmdPlan is unimplementable as specified.

- §5.2/§5.4 call tests/audit/cli-dispatcher.test.ts and tests/audit/cli-remediation.test.ts a 'regression net' that 'pins the contract the refactor must preserve'. They pin only that the three modules export a function of that name. No test at HEAD reaches the payload, the key order, or cmdIntake's git warning. The plan's regression net is materially weaker than it claims.

- §1.2 and §5.3 attribute the import-boundary enforcement to 'a dynamic lock-count acceptance test and tests/audit/artifact-tree-lock-single-surface.test.ts'. The single-surface test constrains only references to `artifactTreeLockPath`; it says nothing about who may import runAuditStep. The test that actually enforces the boundary is tests/audit/fold-lock-import-boundary.test.ts (a literal grep of nextStepHelpers.ts's import clauses for runAuditStep and four other names), which the plan never names. Its enforcement is TEXTUAL and one level deep: it would NOT catch nextStepHelpers.ts importing a module that itself imports runAuditStep. So the plan's stated reason for preferring a new stepCommand.ts over extending cliHelpers.ts ('gives nextStepHelpers a transitive path') is not a property any test enforces — the new-module choice is still the better one, but for hygiene reasons, not because a gate would red.

- §1.1 prose 'All three in-scope commands follow the identical 4-step scaffold' contradicts the plan's own variance table three rows later. cmdSynthesize's body is genuinely differently ordered. Minor, but an implementer reading only §1.1 would expect a mechanical find/replace.

- §3.1's `NonNullable<RunAuditStepOptions["preferredExecutor"]>` is a no-op: the field is `preferredExecutor?: string`, so the type is plain `string`. It buys no validation and adds an import of RunAuditStepOptions that wave 1 otherwise does not need.

- §2.1 proposes the new module be named stepCommand.ts, which matches the *Command.ts naming used by every CLI VERB module in src/audit/cli/. It is not a verb and is not in the dispatch table. I found no test that globs *Command.ts, so nothing will red — but the name is misleading against a live convention.

- §3.1's StepCommandSpec includes `extraOptions` and `buildPayload` that no wave-1 adopter uses. Shipping them in wave 1 means unexercised configuration in a repo whose stated policy is to delete speculative paths; defer both to the wave-2 commit that needs them.

### Behavior changes (5)

- ORDER OF SIDE-EFFECTING RESOLUTION CHANGES IN cmdSynthesize. Today it calls getArtifactsDir(argv) FIRST and getRootDir(argv) second (inline in the runAuditStep argument). The scaffold calls getRootDir first. Both functions hit the filesystem (getRootDir -> discoverRepoRoot/resolveRepoRoot, src/shared/io/repoRoot.ts) and can throw, so if BOTH --artifacts-dir is supplied and --root is invalid, the throwing call moves earlier. Same error class either way, but it is a precedence change, not a pure move — the plan does not mention it.

- getRootDir IS RESOLVED ONCE INSTEAD OF TWICE for cmdSynthesize (and for the wave-2 commands). Today cmdSynthesize resolves the root inline AND again inside getArtifactsDir when --artifacts-dir is absent. The scaffold as written still calls getArtifactsDir(argv) (which re-resolves internally), so the count goes 2 -> 2 in the default case and only the explicit-root path saves work. The plan's §3.1 design note and §5.3 claim 'resolved once per scaffold invocation' — that is FALSE as the plan's own code is written: getArtifactsDir(argv) does not accept a root, so it re-resolves. Either accept 2 resolutions (no behavior change) or change args.ts (explicitly out of scope). Flagging as a plan error rather than a behavior change; the SOURCE WINS here.

- cmdForceSynthesis and cmdIntake stdout moves from an inline console.log(JSON.stringify(x, null, 2)) to outputJson, which is character-for-character the same call. Byte-identical by construction — pure move, listed only to record that it was checked.

- For wave 2 as written, cmdPlan WOULD gain a preferredExecutor it does not have today. Its runAuditStep call passes no preferredExecutor at all; the plan's StepCommandSpec makes it required. Adopting cmdPlan without first making preferredExecutor optional would change which executor the plan command selects — a real behavior change hidden inside a 'pure move'. Do not do it.

- No change to exit codes, thrown errors, stderr other than the warn path, or to any runAuditStep option value in wave 1.

### Minimal change

Wave 1 only, one commit, four files.

1. NEW src/audit/cli/stepCommand.ts — the minimal scaffold, WITHOUT the speculative wave-2 hooks:

   import { runAuditStep } from "./auditStep.js";
   import { getArtifactsDir, getRootDir, warnIfNotGitRepo } from "./args.js";
   import { outputJson } from "./cliHelpers.js";

   export interface StepCommandSpec {
     preferredExecutor: string;
     /** Default false — preserves cmdIntake's warning and its absence elsewhere. */
     warnIfNotGit?: boolean;
   }

   export async function runStepCommand(argv: string[], spec: StepCommandSpec): Promise<void> {
     const root = getRootDir(argv);
     if (spec.warnIfNotGit) warnIfNotGitRepo(root);
     const artifactsDir = getArtifactsDir(argv);
     const result = await runAuditStep({ root, artifactsDir, preferredExecutor: spec.preferredExecutor });
     outputJson({
       artifacts_dir: artifactsDir,
       selected_executor: result.selected_executor,
       progress_summary: result.progress_summary,
     });
   }

   DROP the plan's `extraOptions` and `buildPayload` fields from wave 1: no wave-1 adopter uses either, they are dead configuration until wave 2 lands, and the repo's "ideal code / no speculative generality" stance plus the check:deadcode gate argue against shipping unexercised options. Add them in the wave-2 commit that first needs them. Keep `preferredExecutor: string` rather than NonNullable<RunAuditStepOptions["preferredExecutor"]> — the latter erases to exactly `string` (the field is `preferredExecutor?: string`), so the indirection buys nothing; keep RunAuditStepOptions out of the import list entirely in wave 1.

2. src/audit/cli/forceSynthesisCommand.ts — keep the existing docstring on cmdForceSynthesis verbatim; body becomes
   `return runStepCommand(argv, { preferredExecutor: "synthesis_executor" });`
   Imports become only `import { runStepCommand } from "./stepCommand.js";`.

3. src/audit/cli/intakeCommand.ts — body becomes
   `return runStepCommand(argv, { preferredExecutor: "intake_executor", warnIfNotGit: true });`

4. src/audit/cli/synthesizeCommand.ts — body becomes
   `return runStepCommand(argv, { preferredExecutor: "synthesis_executor" });`
   (drops its own outputJson/getArtifactsDir/getRootDir/runAuditStep imports.)

All three keep `export async function cmdX(argv: string[]): Promise<void>` so the two dispatcher tests and src/audit/cli.ts's table (lines 77/85/86) need no edit.

Do NOT touch args.ts, auditStep.ts, cliHelpers.ts, nextStepHelpers.ts, nextStepCommand.ts, or resynthesizeCommand.ts. Do NOT let stepCommand.ts import anything from src/audit/orchestrator/.

Gates to run: npm run build && npm run check, then npm run check:deadcode (new exports must have adopters — both do), npm run check:guard-reach (should be unaffected; it reconciles guards, not src modules), and tests/audit/cli-dispatcher.test.ts + tests/audit/cli-remediation.test.ts + tests/audit/fold-lock-import-boundary.test.ts + tests/audit/artifact-tree-lock-single-surface.test.ts.

### Red-green plan

COVERAGE GAP — state it plainly: NO existing test reaches the behavior this refactor moves.

What exists and what it actually pins:
- tests/audit/cli-dispatcher.test.ts (rows 56/64/65) and tests/audit/cli-remediation.test.ts (rows 325/333/334) only dynamically import the module and assert `typeof mod[exportName] === "function"`. They never call cmdIntake/cmdSynthesize/cmdForceSynthesis, never inspect stdout, never inspect the payload keys.
- tests/audit/cli-remediation.test.ts:238-275 tests warnIfNotGitRepo, but by calling cliTestUtils.warnIfNotGitRepo(tempDir) DIRECTLY. It does not go through cmdIntake, so it cannot notice cmdIntake losing the warn call.
- I grepped tests/ for any invocation of the three commands or their payload: nothing. The plan's §5.2 claim that these tests are a "regression net" for this refactor is WRONG — they are a net for the export names only.

Consequence: the plan's own primary guard (§5.1 before/after stdout snapshot diff) is a MANUAL procedure with no committed artifact. Under the repo's "enforce in tooling, never host discretion" rule that is the wrong shape for the one property this refactor can break.

Red-green plan (write these two tests as part of the change; they are the missing coverage, and they red today's tree only in the sense that they do not exist):

Test A — payload envelope. In a new tests/audit/step-command-scaffold.test.ts: stub/spy the runAuditStep boundary (or run cmdSynthesize against an existing audit fixture repo the way tests/audit/cleanup.test.ts does — it already parses `parsed.artifacts_dir` from captured stdout at lines 321/407/455, so that harness pattern exists), capture stdout via the existing captureConsole helper, and assert (i) JSON.parse succeeds, (ii) Object.keys(parsed) deep-equals exactly ["artifacts_dir","selected_executor","progress_summary"] — ORDER-SENSITIVE, since the plan itself says hosts may string-match — and (iii) the raw text ends with the 2-space-indented form.
  Single mutation that reds it: in stepCommand.ts, reorder the default payload to put selected_executor first (or change outputJson's indent from 2 to 0). Both leave every current test green today; with Test A they red.

Test B — the git warning is per-command policy. Same file: call cmdIntake with --root pointing at a non-git temp dir and assert the console.warn text /does not appear to be a git repository/ appears; call cmdForceSynthesis the same way and assert it does NOT.
  Single mutation that reds it: delete `warnIfNotGit: true` from the cmdIntake call site (or invert the default to `warnIfNotGit ?? true` in the scaffold). This is the plan's one load-bearing behavioral preservation and nothing at HEAD would catch its loss.

If the implementer refuses to add tests, the change is still safe-by-inspection for the three wave-1 commands, but record the gap: the untested property is "the three commands emit the same three keys in the same order, and exactly one of them warns".

### Open choices (7)

- Module name and location: the plan itself bikesheds `runStepCommand` vs `execStepCommand` vs `runExecutorCommand`, and stepCommand.ts vs extending cliHelpers.ts. Recommend a new module (keeps cliHelpers.ts import-free) but named something that does not collide with the *Command.ts verb convention — e.g. src/audit/cli/stepScaffold.ts.

- Whether to ship extraOptions/buildPayload in wave 1 (plan says yes; I recommend no — defer to the first wave-2 adopter that needs them). Owner call, since it trades a second edit to the scaffold against unexercised config.

- Whether wave 2 happens at all, and if so how cmdPlan is handled: make preferredExecutor optional in StepCommandSpec (matching runAuditStep's own optionality), or leave cmdPlan bespoke. The plan assumes the former without saying so.

- Whether the two missing tests (payload envelope, per-command git-warning) are in scope for this item or filed separately. The plan proposes a manual before/after stdout snapshot instead; the repo's enforce-in-tooling rule points the other way, but making the coverage a blocker changes the item's size.

- Whether the getArtifactsDir double-resolution is fixed now (an args.ts change, which the plan explicitly defers) or left as-is, given the plan's own verification step asserts a property that only holds after that fix.

- Whether resynthesizeCommand.ts's divergent dir resolution (auditArtifactsDir(root) instead of getArtifactsDir(argv)) is folded in or stays a §5.5 follow-up.

- Commit shape: the plan says one commit for wave 1 (§4.6) but a per-command sequence in §4.2-4.4. The repo's atomic-replace rule wants the scaffold and all three deletions in one commit on main; confirm that reading.

### Against what already landed

No conflict and no overlap. All six landed commits are in disjoint territory: items 3.5/3.1/3.4 touch src/audit/extractors/* (graphSignals.ts, graphManifestEdges/workspace.ts, toml.ts, yaml.ts, commentDecomposition.ts, graph.ts), item 2.5 touches scripts/shared/tsAstHelpers.mjs and scripts/generate-spec-mirrors.mjs, and the check:control-bytes flip touches scripts/guard-reach-data.mjs. None of them touches src/audit/cli/*, and none of them creates a scaffold, a step-command helper, or an outputJson adopter. Nothing in them already partly does what this plan proposes. Two indirect notes: (a) item 2.5 set a precedent for the shape this plan follows — a new shared helper module + delete the local copies in one commit — so use the same commit shape here; (b) the check:control-bytes flip to preCommit 'always' means the new file must be control-byte clean (plain ASCII/LF) or the pre-commit leg reds. Line numbers quoted in this plan are unaffected because the plan's targets were not moved by any landed commit — every symbol I located sits where the plan says.

---

## 2.3 — Intra-file gate validation iteration (accepted/non-waived counterexample-id extraction)

**Premise holds:** yes  
**Loop-core:** no

PREMISE CONFIRMED AT HEAD, and the two bodies are byte-identical once comments are stripped. In C:\Code\audit-tools\src\remediate\validation\contractPipelineGates.ts:

Copy A — inside validateImplementationDAGIntegrity (function starts line 312; block at lines 341-356):
  const acceptedCounterexampleIds = new Set<string>();
  if (isRecord(judgeReportPayload) && Array.isArray(judgeReportPayload.classifications)) {
    for (const cls of judgeReportPayload.classifications as unknown[]) {
      if (
        isRecord(cls) &&
        cls.classification === "accepted" &&
        typeof cls.counterexample_id === "string" &&
        cls.counterexample_id.length > 0 &&
        // A waived counterexample is resolved by a recorded owner decision —
        // coverage must not be demanded for it (open-bugs.md:108).
        !waivedCounterexampleIds?.has(cls.counterexample_id)
      ) {
        acceptedCounterexampleIds.add(cls.counterexample_id);
      }
    }
  }

Copy B — inside validateEvidenceThreaded (function starts line 653; block at lines 684-697, preceded by the comment "// 2. accepted counterexamples must be threaded into the DAG. A waived counterexample is resolved by a recorded owner decision and is not demanded here (open-bugs.md:108)."):
  const acceptedCounterexampleIds = new Set<string>();
  if (isRecord(judgeReportPayload) && Array.isArray(judgeReportPayload.classifications)) {
    for (const cls of judgeReportPayload.classifications as unknown[]) {
      if (
        isRecord(cls) &&
        cls.classification === "accepted" &&
        typeof cls.counterexample_id === "string" &&
        cls.counterexample_id.length > 0 &&
        !waivedCounterexampleIds?.has(cls.counterexample_id)
      ) {
        acceptedCounterexampleIds.add(cls.counterexample_id);
      }
    }
  }

`diff` of the two blocks with comment lines removed is empty. The ONLY difference between the two copies is where the waiver comment sits (inline among the conjuncts in A; above the block in B). Downstream uses are as the plan states: A feeds `acceptedCounterexampleIds.has(ceId)` (line 417) and the coverage sweep `if (acceptedCounterexampleIds.size > 0)` (line 438); B feeds the threading check at line 699.

The contract-difference table in §1.2 also verified true against src/remediate/contractPipeline/derive.ts:431-447 (`acceptedCounterexampleIds`): returns string[], no `length > 0` guard, no waiver parameter, non-record → []. Its consumer is src/remediate/steps/contractPipeline.ts:352.

The cycle claim is real: src/remediate/contractPipeline/derive.ts:39 value-imports `isTestablePhaseObligation` from "../validation/contractPipelineGates.js", so a value import back would close a cycle.

The third copy the plan puts out of scope also exists, at src/remediate/steps/contractPipeline.ts:1153-1157 inside the DAG traceability validator: `new Set((judge?.classifications ?? []).filter((entry) => entry.classification === "accepted").map((entry) => entry.counterexample_id))` — no isRecord guard, no length guard, no waiver filter, as claimed.

### Files to change

- `src/remediate/validation/contractPipelineGates.ts`
- `tests/remediate/validation.test.ts`
- `tests/remediate/contract-obligations-and-gates.test.ts`

### Symbol checks

| Symbol | File | Found | Note |
|---|---|---|---|
| `validateImplementationDAGIntegrity` | `src/remediate/validation/contractPipelineGates.ts` | yes | Exported, line 312. Signature matches the plan exactly: (dagPayload, obligationLedgerPayload, counterexamplePayload, judgeReportPayload, waivedCounterexampleIds?: ReadonlySet<string>) => ValidationIssue[]. |
| `validateEvidenceThreaded` | `src/remediate/validation/contractPipelineGates.ts` | yes | Exported, line 653. Signature matches: (assessmentReportPayload, judgeReportPayload, dagPayload, waivedCounterexampleIds?: ReadonlySet<string>) => ValidationIssue[]. |
| `judgeReportPayload (parameter)` | `src/remediate/validation/contractPipelineGates.ts` | yes | Present in both gates as `unknown`; the plan's parameter-name assumption for the helper's first argument is consistent. |
| `waivedCounterexampleIds (parameter)` | `src/remediate/validation/contractPipelineGates.ts` | yes | Optional 5th arg of the DAG gate and 4th arg of the threading gate; also a field of the cross-gate inputs type (line 1796), wired positionally at lines 1870 and 1894. |
| `escapeRegExp` | `src/remediate/validation/contractPipelineGates.ts` | yes | Module-private, line 962 — the placement anchor the plan names still exists. |
| `isRecord` | `src/remediate/validation/contractPipelineGates.ts` | yes | Already imported from "audit-tools/shared" (line 23). No new import needed, as the plan claims. |
| `acceptedCounterexampleIds (derive.ts export)` | `src/remediate/contractPipeline/derive.ts` | yes | Line 431. Contract differs from the gate blocks exactly as the plan's §1.2 table states. |
| `isTestablePhaseObligation` | `src/remediate/validation/contractPipelineGates.ts` | yes | Imported by derive.ts line 39 — the direction that makes a reverse value import a cycle. Confirmed. |
| `evaluateContractPipelineCrossGateOutcomes` | `src/remediate/validation/contractPipelineGates.ts` | yes | The single direct caller of both gates in src/ (call sites at lines 1870 and 1894). See plan-error note: it is 1 direct caller, not 9. |
| `waivedJudgeAcceptedIds` | `src/remediate/contractPipeline/repairState.ts` | yes | Line 195; consumed by src/remediate/index.ts:435, src/remediate/validation/artifacts.ts:558, src/remediate/steps/contractPipeline.ts:2182 to populate inputs.waivedCounterexampleIds. Unaffected by this refactor. |
| `TESTABLE_OBLIGATION_KINDS` | `src/remediate/validation/contractPipelineGates.ts` | yes | Imported from ../contractPipeline/obligationKinds.js (line 42), as the plan says — but this is NOT the file's only value import from contractPipeline/ (see plan_errors). |
| `third inline copy in the DAG traceability validator` | `src/remediate/steps/contractPipeline.ts` | yes | Lines 1153-1157. Out of scope per plan §2.4; note this file IS loop-core, so touching it would trigger the attestation gate. |

### Plan errors (6)

- PATH: the plan is at docs/reviews/refactor-plan-item-2.3-intra-file-gate-validation-2026-09-05.md, NOT docs/reviews/refactor-plans/ as the task stated. That subdirectory does not exist; all thirteen refactor plans sit directly in docs/reviews/.

- §1.2 states the gates file 'currently imports only `type` + leaf helpers from contractPipeline/: ContractPipelineArtifactName as import type, and TESTABLE_OBLIGATION_KINDS from the leaf module obligationKinds.ts'. FALSE at HEAD. src/remediate/validation/contractPipelineGates.ts lines 34-40 also VALUE-import `evaluatePairing`, `obligationScopeAnchors`, `readObligationChangeClassification`, `extractSymbolTokens` (plus `type PairingVerdict`) from "../contractPipeline/changeClassification.js". The plan's CONCLUSION is unaffected — derive.ts line 39 value-imports isTestablePhaseObligation from the gates module, so a reverse value import from derive.js still closes a cycle — but the stated premise about the import surface is wrong and should not be copied into the helper's JSDoc verbatim.

- §2.2 claims '9 inbound callers per gate' from a graph trace. At HEAD there is exactly ONE direct call site per gate in src/ — evaluateContractPipelineCrossGateOutcomes, lines 1870 and 1894 of the same file — plus a barrel re-export in src/remediate/validation/contractPipeline.ts (lines 335, 337) and test call sites. The nine are transitive callers of the cross-gate entry point, not callers of the gates. The plan's operative claim (no caller needs editing) is correct.

- §5.4 prescribes `npm run typecheck`. There is NO such script in package.json. Use `npm run check` (tsc -p tsconfig.json --noEmit) and, because the change adds test cases, `npm run check:tests`. Lint is `npm run check:lint` (eslint .); `npx eslint <paths>` also works.

- §3.1's proposed JSDoc copies the citation 'open-bugs.md:108'. That line suffix is STALE at HEAD — line 108 of docs/backlog/open-bugs.md is inside the closeout-gate 'UNPUSHED commits' entry, not the waiver entry. The stale cite already exists in the source at lines 350, 683 and 1791 (and in five other files), so this is pre-existing, not introduced; no gate catches it (check:backlog-line-numbers scans docs/backlog/*.md only, check:doc-code-citations scans tracked markdown only). Prefer citing the file without the suffix in the new JSDoc.

- §2.3 says the DAG-gate describe has 12 cases 'covering ... non-record DAG returns []'. Minor wording: the case asserts zero error-severity issues from a null DAG (line 1143), which is the canEvaluateImplementationDagIntegrity early return, not literally a [] return. Immaterial to the refactor.

### Behavior changes (3)

- NONE, if implemented exactly as specified. Verified conjunct-by-conjunct: the helper body is character-equivalent to both current blocks (same guards, same order, same `?.` optional-chaining on the waiver set, same Set dedup, same empty-set-on-malformed default), the local variable name is preserved at both sites so no downstream expression changes, and no exported signature, issue path, message, or severity is touched.

- Risks that WOULD be behavior changes if the implementer deviates, listed so they are checked in review: (a) dropping `cls.counterexample_id.length > 0` would newly accept "" as a demanded id; (b) writing `!waivedCounterexampleIds.has(...)` without `?.` would throw on the undefined-waivers path taken by every existing test and every direct call that omits the argument; (c) reusing derive.ts's `acceptedCounterexampleIds` would change return type (array, possibly duplicated), admit empty-string ids, drop waiver filtering, and introduce a derive <-> gates module cycle; (d) returning a ReadonlySet type would break nothing today but the plan specifies Set<string>.

- Additive test cases (plan §5.2) are new coverage, not behavior change — but they DO newly pin the waiver and empty-string semantics that are currently unpinned, so a future edit that was silently green will start failing. That is intended.

### Minimal change

In src/remediate/validation/contractPipelineGates.ts ONLY (plus additive tests):

1. Add one module-private helper immediately above the existing `escapeRegExp` (line 962), with JSDoc recording (a) the acceptance+waiver semantics, (b) why it is NOT derive.ts's `acceptedCounterexampleIds` (derive.ts already imports `isTestablePhaseObligation` from this module, so a value import back closes a cycle). Body must be character-equivalent to the current blocks:

function collectUnwaivedAcceptedCounterexampleIds(
  judgeReportPayload: unknown,
  waivedCounterexampleIds?: ReadonlySet<string>,
): Set<string> {
  const accepted = new Set<string>();
  if (isRecord(judgeReportPayload) && Array.isArray(judgeReportPayload.classifications)) {
    for (const cls of judgeReportPayload.classifications as unknown[]) {
      if (
        isRecord(cls) &&
        cls.classification === "accepted" &&
        typeof cls.counterexample_id === "string" &&
        cls.counterexample_id.length > 0 &&
        !waivedCounterexampleIds?.has(cls.counterexample_id)
      ) {
        accepted.add(cls.counterexample_id);
      }
    }
  }
  return accepted;
}

Do not name it `acceptedCounterexampleIds` (collides conceptually with the derive.ts export).

2. Replace lines 341-356 (inside validateImplementationDAGIntegrity, between the `counterexampleIds` set build and the `// Track which obligations...` comment) with:
   const acceptedCounterexampleIds = collectUnwaivedAcceptedCounterexampleIds(
     judgeReportPayload,
     waivedCounterexampleIds,
   );
   Keep the local name so lines 417 and 438-439 are untouched.

3. Replace lines 684-697 (inside validateEvidenceThreaded) with the same two-argument call, keeping the local name so line 699 onward is untouched. Keep the existing "// 2. accepted counterexamples must be threaded into the DAG..." lead comment (it describes the CHECK, not the extraction); move only the waiver sentence into the helper JSDoc if you want the paragraph in one place.

4. Do steps 1-3 in ONE commit: an added-but-unused private function would trip no-unused-vars.

5. Additive tests only, no edits to existing cases (see red_green_plan).

Nothing else changes: no import line, no export line, no issue path/message, no signature, no derive.ts, no steps/contractPipeline.ts. Expected diff shape: +~28 lines helper, -28 lines across the two blocks, in one file, plus new test cases in two test files.

Gate commands (the plan's are wrong — see plan_errors): `npm run check` (tsc) and `npm run check:tests` for the test tree; `npm run check:lint` (eslint .) or `npx eslint <files>`; suites via `npx vitest run tests/remediate/validation.test.ts tests/remediate/contract-obligations-and-gates.test.ts tests/remediate/contract-pipeline-derive-obligations.test.ts`.

### Red-green plan

COVERAGE GAP — state it plainly: `grep -rn "waivedCounterexampleIds" tests/` returns ZERO hits repo-wide. No test anywhere (including tests/remediate/validate-artifact-cross-gates.test.ts, which exercises evaluateContractPipelineCrossGateOutcomes) passes a waiver set to either gate. The waiver conjunct `!waivedCounterexampleIds?.has(...)` and the `length > 0` conjunct are BOTH unreached by any existing test. Deleting either one today is green.

What existing tests DO reach (behavioral-equivalence proof for the pure move):
- tests/remediate/validation.test.ts, describe("validateImplementationDAGIntegrity") — 12 cases (call sites at lines 1048, 1054, 1064, 1074, 1084, 1095, 1106, 1117, 1126, 1138, 1143, 1157). The case at line 1150, "non-accepted counterexamples in judge report do not require coverage", is the one that reaches the `classification === "accepted"` conjunct.
- tests/remediate/contract-obligations-and-gates.test.ts, describe("validateEvidenceThreaded") — 5 cases (lines 256, 261, 281, 302, 307), including the fail-closed missing-DAG case.

SINGLE MUTATION THAT REDS THE FIXED CODE (proves the extraction is wired and the accepted-filter survived): in the new helper, delete the `cls.classification === "accepted" &&` conjunct. → tests/remediate/validation.test.ts "non-accepted counterexamples in judge report do not require coverage" fails (CE-1 classified "invalid" would then demand DAG coverage). A second, broader mutation — make the helper `return new Set()` unconditionally — reds both suites (validation.test.ts empty-DAG/coverage cases and contract-obligations-and-gates.test.ts "flags an accepted counterexample not threaded into any DAG node" and the fail-closed case). Note the accepted-conjunct mutation does NOT red the threading suite, because every judge fixture there classifies as "accepted".

MUTATIONS THAT STAY GREEN TODAY (the gap the plan's §5.2 tests must close): deleting `!waivedCounterexampleIds?.has(...)`, and deleting `cls.counterexample_id.length > 0`. Add at minimum: (a) waiver suppresses the coverage/threading demand for a waived accepted id, in both gates; (b) partial waiver — accept CE-1+CE-2, waive CE-1, expect exactly one issue naming CE-2; (c) empty-string counterexample_id produces no demand in either gate. With (a) and (c) added, deleting the waiver conjunct and deleting the length guard each go red.

### Open choices (6)

- Helper NAME. The plan offers collectUnwaivedAcceptedCounterexampleIds / acceptedCounterexampleIdsOf / unwaivedAcceptedIds and only forbids `acceptedCounterexampleIds`. Pick one.

- Helper PLACEMENT — immediately above or immediately below escapeRegExp (line 962). Either satisfies the file's exported-above/private-below layout.

- Whether to leave a one-line pointer comment at each call site or let the helper JSDoc carry the whole waiver rationale (§3.2 says 'if desired').

- How much of the §5.2 test set to write. Cases (a) waiver-suppression and (c) empty-string-id are load-bearing (they are the mutations that are green today); (b) partial waiver, (d) cross-gate parity, and (e) malformed-payload are defensible but optional.

- Whether to also close the SAME gap at the cross-gate entry point by adding a waiver case to tests/remediate/validate-artifact-cross-gates.test.ts — the plan does not mention that file, and it is the only place inputs.waivedCounterexampleIds is exercised end-to-end (today it is not).

- Whether to file the two out-of-scope follow-ups the plan names as backlog entries now: unifying with derive.ts's acceptedCounterexampleIds via a cycle-safe leaf module, and the third copy at src/remediate/steps/contractPipeline.ts:1153 (which lacks the waiver filter entirely — a live semantic divergence, not just duplication, and that file IS loop-core so it would need a review attestation).

### Against what already landed

No conflict and no overlap. All six landed commits are in src/audit/extractors/* and scripts/* (graphSignals.ts, graphManifestEdges/workspace.ts, toml.ts, yaml.ts, commentDecomposition.ts, graph.ts, scripts/shared/tsAstHelpers.mjs, scripts/shared/generate-spec-mirrors.mjs, scripts/guard-reach-data.mjs). `git log -- src/remediate/validation/contractPipelineGates.ts` shows its last touch is f3962a8b (the owner-waiver commit that CREATED both duplicated blocks), well before this batch. Nothing in the landed set already does any part of item 2.3. One indirect note: check:control-bytes now runs as an unconditional pre-commit leg, so any non-ASCII characters you introduce (the plan's JSDoc uses em dashes and arrows, as does the existing code) must stay ordinary UTF-8 punctuation, not 0x1A-style control bytes — commit 92893c4c exists because a lane wrote raw control bytes into a doc.

---

## 2.4 Dispatch Execution Envelopes

**Premise holds:** yes  
**Loop-core:** no

PREMISE HOLDS for the two named target rows, and is PARTLY WRONG for the three optional rows.

VERIFIED at HEAD in `src/audit/cli/nextStepCommand.ts` (1554 lines): `emitCriticalFlowFallback` (line 1351) and `emitSynthesisNarrative` (line 1418) build their `prompt:` arrays from byte-for-byte the same envelope. The two arrays differ in EXACTLY three tokens and nothing else:
  - title: "# audit-code critical-flow fallback"  vs  "# audit-code synthesis narrative"
  - write sentence: "The executor must write the CriticalFlowFallbackResult JSON object to:"  vs  "The executor must write the SynthesisNarrative JSON object to:"
  - path expression: `  ${fallbackResultsPath}`  vs  `  ${narrativeResultsPath}`
Everything else — the "" after the title, `...renderLaneShortfallLines(fanout.shortfall)`, the `...renderFanoutExecutionLines({ lanes: fanout.pendingLanes.map((lane) => ({ label: lane.label, promptPath: lane.promptPath })) })` spread (identical, including the absence of `resultPath`), and the 8-line closer ("", "When the result file exists, run:", "", `  ${continueCommand}`, "", "Read and follow only the new step prompt returned by that command.", "") — is character-identical. The plan's structural description of these two rows is accurate.

DISAGREEMENT WITH SOURCE (plan §3.4): the plan says `emitCharterDelta` "fits the helper as-is" and `emitSystemicChallenge` "fits via `midNote`". NEITHER DOES. Both carry a lead-in paragraph BETWEEN the shortfall lines and the execution lines, for which the plan's proposed helper (§3.1) has no slot:

  emitCharterDelta (src/audit/cli/nextStepCommand.ts:874-883):
      ...renderLaneShortfallLines(fanout.shortfall),
      "The assembled charters are ready for the INDEPENDENT delta-miner (it did not author them).",
      "",
      ...renderFanoutExecutionLines({...}),

  emitSystemicChallenge (src/audit/cli/nextStepCommand.ts:1019-1028):
      ...renderLaneShortfallLines(fanout.shortfall),
      "This round's adversary lane challenges the audit process itself (optimization/better-way mandate). The adversary must NOT be the agent that drove this audit.",
      "",
      ...renderFanoutExecutionLines({...}),

  target rows (1390-1397, 1458-1465) — NO lead-in:
      ...renderLaneShortfallLines(fanout.shortfall),
      ...renderFanoutExecutionLines({...}),

The plan's own byte-identity guard (§3.4's "only if a pre-change capture proves byte-identical") would correctly stop the adoption, so the plan is self-correcting — but its stated assessment of those two rows is a factual error and an implementer following §3.4's prose without running the capture would emit changed host-visible prompts.

DISAGREEMENT WITH SOURCE (plan §1.2 / §3.4, `emitCharterExtraction`): §1.2 lists it among "rows exhibiting this envelope"; §3.4 excludes it, citing "extra `Read and follow only...` after the continue command". There is no extra line — `emitCharterExtraction` (prompt at 798-826) has exactly ONE "Read and follow only the new step prompt returned by that command." line, same as every other row. Its real disqualifiers are: a different closer lead-in ("When every pending lane's result file exists, run:", line 820), a lead-in paragraph, a conditional completed-lanes block, and a `renderFanoutExecutionLines` call that additionally passes `resultPath`. The exclusion verdict is right; the reason given is wrong.

`emitEdgeReasoning` (line 1177): the plan's §6 follow-up implies it carries the envelope. It does NOT — it delegates the whole body to `renderEdgeReasoningDispatchPrompt` and only prepends `shortfallLines` (1222-1231). It is correctly listed only under the submission-path follow-up, but it is not an envelope-duplication site.

Closer census at HEAD: the literal "When the result file exists, run:" appears at lines 888 (charter_delta), 1035 (systemic_challenge), 1402 (critical_flow_fallback), 1470 (synthesis_narrative). "Read and follow only the new step prompt returned by that command." appears 5 times (those four plus charter_extraction at 824). The design-review rows (600, 649) use different lead-ins and carry no "Read and follow only" line — the plan's out-of-scope call on them is correct.

### Files to change

- `src/audit/cli/nextStepCommand.ts`

### Symbol checks

| Symbol | File | Found | Note |
|---|---|---|---|
| `emitCriticalFlowFallback` | `src/audit/cli/nextStepCommand.ts` | yes | Line 1351. Module-local `const`, not exported, built via emissionRow<"critical_flow_fallback">. Shape matches the plan exactly: laneSubmissionPath -> nextStepCommand -> basePrompt -> materializeFanoutLanes -> currentStepPlan with an inline prompt array. |
| `emitSynthesisNarrative` | `src/audit/cli/nextStepCommand.ts` | yes | Line 1418. Module-local const, emissionRow<"synthesis_narrative">. Shape matches the plan exactly and mirrors emitCriticalFlowFallback. |
| `emissionRow` | `src/audit/cli/nextStepCommand.ts` | yes | Line 479. `function emissionRow<K extends NextStepEmissionKind>(handle) : NextStepEmissionRow`. Matches the plan's description (binds the row to its result variant once). Untouched by the plan. |
| `currentStepPlan` | `src/audit/cli/nextStepCommand.ts` | yes | Line 414. Returns `{ via: "current", params }`. Signature unchanged by the plan. |
| `materializeFanoutLanes` | `src/audit/cli/fanoutLanes.ts` | yes | Imported at nextStepCommand.ts:20; called at 226, 782, 849, 987, 1197, 1365, 1433. Untouched by the plan (non-goal 1). |
| `operatorHandoffBlock` | `src/audit/cli/nextStepCommand.ts` | yes | Line 437, immediately before writeAuditStep (456). The plan's stated insertion point ("directly after it, before writeAuditStep") is a real, currently-empty seam at HEAD. |
| `renderLaneShortfallLines` | `src/audit/cli/laneSubmissions.ts` | yes | Exported at laneSubmissions.ts:602; imported at nextStepCommand.ts:30. Returns string[]. Matches the plan. |
| `renderFanoutExecutionLines` | `src/shared/prompts.ts` | yes | Exported at prompts.ts:87; imported at nextStepCommand.ts:10. Returns string[]. Matches the plan. |
| `laneSubmissionPath` | `src/audit/cli/laneSubmissions.ts` | yes | Exported at laneSubmissions.ts:209. Called separately by charter_delta (847), charter_clarification (916), systemic_challenge (964), analyzer rows (1107, 1144), edge_reasoning (1179), intent_equivalence (1311), critical_flow_fallback (1353), synthesis_narrative (1420) — the twin-derivation the plan defers to §6 is real. |
| `renderLaneResultsFooter` | `src/audit/cli/fanoutLanes.ts` | yes | Line 126, applied inside fanoutLanes.ts:141. Confirms the plan's non-goal 1 (two audiences: lane file vs step prompt). |
| `NEXT_STEP_EMISSION_TABLE` | `src/audit/cli/nextStepCommand.ts` | yes | Line 1495, exported, typed `Readonly<Record<NextStepEmissionKind, NextStepEmissionRow>>` — total record as the plan describes. Untouched. |
| `NEXT_STEP_EMISSION_KINDS` | `src/audit/cli/nextStepCommand.ts` | yes | Line 1553, derived from the table's own keys. Untouched. |
| `createStepEmissionScaffold` | `src/shared/steps/stepEmissionScaffold.ts` | yes | Imported at nextStepCommand.ts:17, used at 1520 to build NEXT_STEP_EMISSION. Untouched. |
| `writeAuditStep` | `src/audit/cli/nextStepCommand.ts` | yes | Line 456, the single writer dispatch, wired at 1541. Untouched. |
| `blockedStepPlan` | `src/audit/cli/nextStepCommand.ts` | yes | Line 420. Untouched. |
| `semanticReviewPlan` | `src/audit/cli/nextStepCommand.ts` | yes | Line 426, used only in the scaffold's semantic_review fallback at 1531. Untouched. |
| `emitCharterExtraction` | `src/audit/cli/nextStepCommand.ts` | yes | Line 724. EXISTS but its shape does NOT match the plan's §1.2 claim that it exhibits the envelope: different closer lead-in ("When every pending lane's result file exists, run:", line 820), a lead-in paragraph, a conditional completed-lanes block, and renderFanoutExecutionLines called with resultPath. §3.4's exclusion is right; its stated reason (an extra "Read and follow only" line) is false — there is exactly one. |
| `emitCharterDelta` | `src/audit/cli/nextStepCommand.ts` | yes | Line 838. EXISTS but does NOT fit the proposed helper as the plan claims: a lead-in paragraph sits between shortfall lines and execution lines (874-877), for which the helper has no parameter. |
| `emitSystemicChallenge` | `src/audit/cli/nextStepCommand.ts` | yes | Line 956. EXISTS. The midNote slot does fit its "An EMPTY findings array..." paragraph (1033), but it ALSO has a pre-execution lead-in paragraph (1021-1022) the helper cannot express. |
| `emitEdgeReasoning` | `src/audit/cli/nextStepCommand.ts` | yes | Line 1177. EXISTS but carries NO inline envelope — it delegates to renderEdgeReasoningDispatchPrompt (1224) and only prepends shortfallLines. Relevant to the §6 path follow-up only, not to envelope duplication. |
| `emitDesignReviewParallel / emitDesignReviewContract / emitDesignReviewConceptual` | `src/audit/cli/nextStepCommand.ts` | yes | Lines 567, 629, 675. Confirmed out of scope: distinct closer lead-ins at 600 and 649, and no "Read and follow only" line at all. |
| `prepareContractDispatch` | `src/audit/cli/nextStepCommand.ts` | yes | Line 202, cited by the plan for the twin-path-derivation note; also referenced in the src/audit/cli/fanoutLanes.ts:22 module comment. Both citations check out. |
| `renderSingleLaneDispatchEnvelope` | `src/audit/cli/nextStepCommand.ts` | **NO** | The symbol the plan PROPOSES to add. Does not exist at HEAD — expected, not a plan error. |

### Plan errors (8)

- §3.4: "`emitCharterDelta`: ... fits the helper as-is" is FALSE. The row has a lead-in paragraph between `renderLaneShortfallLines` and `renderFanoutExecutionLines` (src/audit/cli/nextStepCommand.ts:875-876) that the proposed helper cannot express.

- §3.4: "`emitSystemicChallenge`: ... fits via `midNote`" is FALSE for the same reason — its pre-execution lead-in (src/audit/cli/nextStepCommand.ts:1021-1022) has no slot. The `midNote` slot does correctly fit its post-path "An EMPTY findings array..." line (1033), but that is only half the row.

- §3.4: `emitCharterExtraction` is excluded for the wrong reason — the plan cites an "extra `Read and follow only...` after the continue command". There is exactly one such line (src/audit/cli/nextStepCommand.ts:824), same as every other row. Its real disqualifiers are the different closer lead-in at line 820 ("When every pending lane's result file exists, run:"), the lead-in paragraph at 802, the conditional completed-lanes block at 812-819, and the `resultPath` field passed to `renderFanoutExecutionLines` at 808.

- §1.2: lists `emitCharterExtraction` among "Rows exhibiting this envelope", which §3.4 then contradicts. On the source, §3.4's exclusion is right and §1.2's inclusion is wrong.

- §6.1 / §1.4 non-goal 3: implies `emitEdgeReasoning` is an envelope site. It is not — it delegates the whole body to `renderEdgeReasoningDispatchPrompt` (src/audit/cli/nextStepCommand.ts:1224) and prepends only `shortfallLines`. It IS a valid member of the submission-path-derivation follow-up (its `laneSubmissionPath` call is at 1179), so the §6 listing is defensible; the §1.4 framing is loose.

- §4 step 2: "typecheck (`tsc`) to confirm the helper compiles unused" — an unused module-local function is an eslint error under the repo's PostToolUse tsc+eslint hook. Add the helper and its call sites in one edit.

- §5.3: characterizes the closer-drift pin as "optional, not required". Measured against the suite, the closer text is asserted by ZERO tests, so without the pin the refactor lands with no regression signal for the exact property it exists to protect. It should be required.

- §5.2/§4 step 1 do not say where the baseline capture instrumentation lives. The repo bans tests referencing untracked paths; the capture must be temporary local instrumentation writing to a scratch dir outside the repo, and must not be committed. Worth stating in the brief so it is not committed by accident.

### Behavior changes (3)

- NONE, if the plan is implemented as scoped to `emitCriticalFlowFallback` and `emitSynthesisNarrative` only. Verified by reading both prompt arrays at src/audit/cli/nextStepCommand.ts:1388-1409 and 1456-1477: the proposed helper's element sequence reproduces both arrays element-for-element with no reordering, no rewording, and no added or removed blank line. It is a pure intra-function extraction — no signature change, no control-flow change, no IO, no path derivation moved.

- BEHAVIOR CHANGE IF §3.4 IS FOLLOWED AS WRITTEN (host-visible prompt regression): adopting the helper in `emitCharterDelta` would DELETE the line "The assembled charters are ready for the INDEPENDENT delta-miner (it did not author them)." plus its trailing blank from the emitted step prompt (nextStepCommand.ts:875-876), because the helper has no slot between shortfallLines and executionLines. Same for `emitSystemicChallenge`: it would delete "This round's adversary lane challenges the audit process itself (optimization/better-way mandate). The adversary must NOT be the agent that drove this audit." plus its blank (1021-1022). Both violate the plan's own non-goal 5 (byte-identical host-visible prompts). The §3.4 byte-identity precondition prevents this if actually run; the prose assertion that these rows "fit" does not.

- MINOR SCOPE CHANGE I RECOMMEND (not in the plan): dropping the `midNote?: string` parameter from §3.1. That is a change to the plan, not to runtime behavior — no caller in the minimal change passes it.

### Minimal change

In `src/audit/cli/nextStepCommand.ts` ONLY, one commit:

1. Insert a module-local (NOT exported) helper immediately after `operatorHandoffBlock` (ends line 454) and before `writeAuditStep` (line 456). Do not put "Prompt" in its name (see the registry gate above). Exact body, which reproduces the two target rows character-for-character:

```ts
function renderSingleLaneDispatchEnvelope(opts: {
  title: string;
  shortfallLines: string[];
  executionLines: string[];
  writeSentence: string;
  submissionPath: string;
  continueCommand: string;
}): string[] {
  return [
    opts.title,
    "",
    ...opts.shortfallLines,
    ...opts.executionLines,
    "",
    opts.writeSentence,
    "",
    `  ${opts.submissionPath}`,
    "",
    "When the result file exists, run:",
    "",
    `  ${opts.continueCommand}`,
    "",
    "Read and follow only the new step prompt returned by that command.",
    "",
  ];
}
```

DROP the plan's optional `midNote` parameter. Its only stated purpose was `emitSystemicChallenge` adoption, and that row cannot adopt the helper anyway (it needs a pre-execution lead-in the helper has no slot for). Shipping an unused optional parameter is speculative and `npm run check:deadcode` gates unused exports at release — keep the helper to exactly what its two callers need.

2. In `emitCriticalFlowFallback` (line 1351), replace the `prompt: [ ... ].join("\n")` at 1388-1409 with:
```ts
prompt: renderSingleLaneDispatchEnvelope({
  title: "# audit-code critical-flow fallback",
  shortfallLines: renderLaneShortfallLines(fanout.shortfall),
  executionLines: renderFanoutExecutionLines({
    lanes: fanout.pendingLanes.map((lane) => ({
      label: lane.label,
      promptPath: lane.promptPath,
    })),
  }),
  writeSentence:
    "The executor must write the CriticalFlowFallbackResult JSON object to:",
  submissionPath: fallbackResultsPath,
  continueCommand,
}).join("\n"),
```

3. In `emitSynthesisNarrative` (line 1418), the symmetric replacement at 1456-1477 with title `"# audit-code synthesis narrative"`, writeSentence `"The executor must write the SynthesisNarrative JSON object to:"`, submissionPath `narrativeResultsPath`.

4. Change NOTHING else. Do not touch `emitCharterDelta`, `emitSystemicChallenge`, `emitCharterExtraction`, `emitEdgeReasoning`, the design-review rows, `emissionRow`, `currentStepPlan`, `NEXT_STEP_EMISSION_TABLE`, the scaffold, or any file outside `src/audit/cli/nextStepCommand.ts`.

Do not follow the plan's §4 step 2 literally ("typecheck to confirm the helper compiles unused") — an unused module-local function trips `@typescript-eslint/no-unused-vars` under the repo's PostToolUse tsc+eslint hook. Add the helper and both call sites in one edit.

Expected diff: roughly +20 / −30 lines, one file.

### Red-green plan

COVERAGE GAP — state it plainly: NO existing test reaches the behavior this refactor is supposed to preserve.

What I checked and found:
- `tests/audit/next-step-critical-flow-fallback.test.ts:116-120` reads `paused.prompt_path` and asserts only `toMatch(/critical-flow fallback/i)`, `toContain(resultsPath)`, and `toMatch(/sequentially yourself|else read and follow/)` (the last is satisfied by `renderFanoutExecutionLines`, not by the closer).
- `tests/audit/next-step-narrative.test.ts:134-135` reads `paused.prompt_path` and asserts only `toMatch(/synthesis narrative/i)`. It does not even assert the results path appears in the step prompt.
- `grep -rn "When the result file exists|Read and follow only" tests/` returns NOTHING. `grep -rn "The executor must write" tests/` returns NOTHING. The closer and the write sentence are asserted nowhere in the suite.
- `tests/audit/systemic-challenge.test.ts` and `tests/audit/charter-delta-executor.test.ts` contain no `stepPrompt` / `prompt_path` reads at all.
- `tests/audit/next-step-helpers.test.ts` and `tests/audit/seam-host-only-next-step.test.ts` guard the TABLE key set and the host-only seam; they are structurally blind to prompt bytes. The plan (§1.2, §2.2) says this correctly.

Consequence: a mutation that deletes the entire closer from the helper, or reorders `writeSentence` after the continue command, or drops the blank line after the title, is GREEN today for `synthesis_narrative`. For `critical_flow_fallback` a mutation that drops `` `  ${submissionPath}` `` alone would red the `toContain(resultsPath)` assertion at line 117 — that is the ONLY closer-adjacent byte any test pins, and it does not pin position or the sentence.

Red-green plan that actually works:
1. RED FIRST, before the refactor: capture the two step prompts. Run `npx vitest run tests/audit/next-step-critical-flow-fallback.test.ts tests/audit/next-step-narrative.test.ts` with a temporary local instrumentation that copies each `paused.prompt_path` and each lane prompt under `artifact_paths` to a scratch dir OUTSIDE the repo (use the session scratchpad — tests must reference tracked paths only, so this instrumentation must not be committed).
2. Apply the change. Re-capture. `diff` must be empty for all four files. This is the load-bearing check and is stronger than any assertion in the suite.
3. Then MAKE THE GAP A FINDING, not a workaround. Add to each of the two existing tests one assertion that the emitted step prompt ends with the closer, e.g.
   `expect(stepPrompt.endsWith("When the result file exists, run:\n\n  " + continueCmd + "\n\nRead and follow only the new step prompt returned by that command.\n")).toBe(true);`
   or, less brittle, `expect(stepPrompt).toMatch(/When the result file exists, run:\n\n {2}audit-code next-step .*\n\nRead and follow only the new step prompt returned by that command\.\n$/);`
   RED-GREEN VALIDATE IT: with the assertion in place, mutate the helper by deleting the `"Read and follow only the new step prompt returned by that command."` line — BOTH tests must go red. Restore, both green. Deleting only `""` after the title must also red it (it does, because the regex is anchored to end-of-string and the earlier bytes shift only if the whole prompt is compared; if you use the `endsWith` form, use a separate assertion `expect(stepPrompt.startsWith("# audit-code synthesis narrative\n\n")).toBe(true)` and invert that one too).
   Without step 3 the refactor lands with the same zero coverage the plan's §1.2 identifies as the drift risk it is trying to fix — the helper single-sources the closer but nothing stops a future row from hand-rolling one. The plan calls this pin "optional, not required" (§5.3, §6.2); given the measured gap, treat it as required.
4. Then the full suite: `npm run build && npm run check && npm test`.

### Open choices (6)

- The helper's NAME. The plan says "names negotiable, semantics not". Constraint discovered at HEAD and not in the plan: if the name contains the substring "Prompt" AND the symbol is exported, `tests/shared/prompt-renders-its-contract.test.ts:306` (`scanExportedPromptBuilders`) reds until a row is added to `tests/shared/promptContractRegistry.ts`. Keeping it module-local and "Prompt"-free avoids this entirely.

- Whether to keep the `midNote?: string` parameter. I recommend dropping it (no caller in the minimal change uses it, and its intended adopter cannot adopt). An owner may prefer keeping it as the plan wrote it.

- Whether to attempt `emitCharterDelta` / `emitSystemicChallenge` adoption at all, and if so whether to widen the helper with a `leadInLines?: string[]` slot (positioned between shortfallLines and executionLines) so all four rows can share it. That is a real design choice the plan did not consider because it mis-read those two rows: a four-row helper with two optional slots is a bigger, better-justified single-sourcing win; a two-row helper with zero optional slots is the smaller, safer change the plan actually specifies. Owner call.

- Whether to add the closer-drift assertion to the two row tests. The plan calls it optional (§5.3, §6.2); I recommend required given the measured zero coverage. Owner may still decline.

- Whether to fold in §6.1 (unify submission-path derivation so rows consume `fanout.lanes[i].resultPath` instead of re-calling `laneSubmissionPath`). The plan defers it; the twin derivation is confirmed present at HEAD across eight call sites (nextStepCommand.ts:847, 916, 964, 1107, 1144, 1179, 1311, 1353, 1420).

- Whether to record the §3.4 decline ("leave these rows on their inline arrays, they do not fit") as a one-line source comment at each declined row, as §4 step 5 directs, or only in the closeout.

### Against what already landed

NO CONFLICT, and NO OVERLAP. None of the six landed commits touches src/audit/cli/nextStepCommand.ts, src/shared/prompts.ts, src/audit/cli/fanoutLanes.ts, or src/audit/cli/laneSubmissions.ts. `git log --oneline -- src/audit/cli/nextStepCommand.ts` shows its most recent commit is 89bc84b1, well before the item-3.x/2.5 wave. The landed items live in src/audit/extractors/* and scripts/shared/*; the GRAPH_EDGE_CACHE_KEY_VERSION v4->v5 bump and the check:control-bytes preCommit flip are irrelevant to prompt assembly.

Nothing already partly does this: no shared prompt-envelope helper exists anywhere. The closest existing single-sourcing is `renderFanoutExecutionLines` (src/shared/prompts.ts:87) and `renderLaneShortfallLines` (src/audit/cli/laneSubmissions.ts:602) — exactly the two pieces the plan says are already factored.

One landed-adjacent guard the plan does not mention and the implementer must respect: `tests/shared/prompt-renders-its-contract.test.ts:306` (`scanExportedPromptBuilders`) scans all of `src/**/*.ts` for `export function|const <name containing "Prompt">` and REDS unless `tests/shared/promptContractRegistry.ts` claims each such export exactly once. The plan's proposed name `renderSingleLaneDispatchEnvelope` contains no "Prompt" and is module-local, so it is clear — but naming it `...Prompt` AND exporting it would fail that gate.

---

## 3.2 Confidence Scoring Mapping

**Premise holds:** yes  
**Loop-core:** yes — commit needs a review attestation

The duplication is real and EXACT at HEAD. src/audit/extractors/analyzers/merge.ts:49-53 and src/audit/orchestrator/edgeReasoning.ts:51-55 both contain, byte-identically:

function confidenceOf(edge: GraphEdge): number {
  return typeof edge.confidence === "number" && Number.isFinite(edge.confidence)
    ? edge.confidence
    : 0;
}

Nothing differs — not whitespace, not the signature, not the JSDoc (neither has one). Line numbers still match the plan's citations exactly; no landed commit moved them.

The plan's two corrections of the catalog are BOTH verified correct against source:
1. The catalog's "Why Identified" (mapping `"high" | "medium" | "low"` literals to probabilities) is FALSE — no such literal-to-probability mapping exists in either file, or anywhere in src/. Both helpers read a numeric field.
2. src/shared/types/graph.ts really does contain only Zod schemas (GraphEdgeSchema, RouteEdgeSchema, NodeMetricSchema, NodeMetricsSchema, GraphBundleSchema) and z.infer types — zero functions. The catalog's proposed landing zone would be the first runtime code there. src/shared/graph/ exists and holds exactly the runtime-over-GraphEdge modules the plan claims (graphPaths.ts, directedCycles.ts), and graphPaths.ts's header says what the plan quotes.

Plan-vs-source disagreements found (all minor, all source-wins):
- Plan §2.1/§3.4 says edgeReasoning.ts has FOUR reads and instructs "replace 4 call sites (… and any 4th read)". There are exactly THREE: lines 77, 95, 106. No fourth exists.
- Plan §1.5 cites the hidden-coupling floor as "0.5 in designAssessment.ts". The real path is src/audit/extractors/designAssessment.ts (not orchestrator/), symbol HIDDEN_COUPLING_CONFIDENCE_FLOOR = 0.5 at line 293. Value and intent correct, path under-specified.
- Plan §3.3 says merge.ts's shared imports are "import type { GraphEdge } / compareCodeUnits lines"; at HEAD merge.ts:1-2 are exactly `import type { GraphEdge } from "audit-tools/shared";` and `import { compareCodeUnits } from "audit-tools/shared";` — so the value import already exists and edgeConfidence extends line 2. Matches.
- Plan §3.5 lists typescript.ts TS_* consumer lines "~187, ~213-215, ~241, ~266, ~297, ~329" — all six confirmed present at those lines.

### Files to change

- `src/shared/graph/edgeConfidence.ts (NEW)`
- `src/shared/index.ts`
- `src/audit/extractors/analyzers/merge.ts`
- `src/audit/orchestrator/edgeReasoning.ts`
- `tests/shared/edge-confidence.test.ts (NEW)`
- `src/audit/extractors/analyzers/types.ts (only if the optional TS_* relocation is taken)`
- `src/audit/extractors/analyzers/typescript.ts (only if the optional TS_* relocation is taken)`

### Symbol checks

| Symbol | File | Found | Note |
|---|---|---|---|
| `confidenceOf (merge)` | `src/audit/extractors/analyzers/merge.ts` | yes | Private, lines 49-53, exactly as the plan quotes. One call site: line 92, `if (!existing \|\| confidenceOf(edge) >= confidenceOf(existing))` inside mergeAnalyzerEdges — matches the plan verbatim. |
| `confidenceOf (edgeReasoning)` | `src/audit/orchestrator/edgeReasoning.ts` | yes | Private, lines 51-55, body byte-identical to merge.ts's. THREE call sites, not the plan's four: line 77 (`if (confidenceOf(edge) < floor)` in collectLowConfidenceEdges), line 95 (`confidence: confidenceOf(edge)` in edgeReasoningContentHash), line 106 (`confidenceOf(edge).toFixed(2)` in buildEdgeReasoningPrompt). |
| `GraphEdge` | `src/shared/types/graph.ts` | yes | z.infer type off GraphEdgeSchema (line 3). Both consumers import it as a type from "audit-tools/shared", not by relative path. |
| `DEFAULT_EDGE_CONFIDENCE_FLOOR` | `src/audit/orchestrator/edgeReasoning.ts` | yes | Line 25, exported, = 0.65. Plan leaves it in place; correct — it is used as the default parameter of collectLowConfidenceEdges. |
| `MAX_REASONED_EDGES` | `src/audit/orchestrator/edgeReasoning.ts` | yes | Line 27, exported, = 200. Untouched by the plan. |
| `TS_IMPORT_EDGE_CONFIDENCE / TS_REEXPORT_ / TS_EXTENDS_ / TS_IMPLEMENTS_ / TS_CALL_EDGE_CONFIDENCE` | `src/audit/extractors/analyzers/merge.ts` | yes | All five exported at lines 7-11 (0.99, 0.99, 0.97, 0.97, 0.9) under the tuning comment at lines 4-6 — exactly as the plan states. Grep across src/, tests/, scripts/ confirms the plan's step-1 expectation: the ONLY importer is src/audit/extractors/analyzers/typescript.ts:9-15. No test or deep-import consumer. So the plan's backward-compat option (a) clean break is the correct branch; option (b) shim is dead. |
| `edgeConfidence (existing private twin)` | `src/audit/extractors/graph.ts` | yes | Line 206-208. Confirmed WEAKER as the plan claims: `return typeof edge.confidence === "number" ? edge.confidence : 0;` — no Number.isFinite guard, so NaN/Infinity propagate. This is a real name collision with the plan's proposed shared export name. |
| `clampConfidence` | `src/audit/extractors/graph.ts` | yes | Lines 199-203; clamps to [0,1] with an explicit fallback. Different contract, correctly excluded. |
| `normalizeGraphPath / collectGraphEdges re-export` | `src/shared/index.ts` | yes | Line 84. findCyclicComponents/findFirstCycleWitness at line 85. The plan's insertion point is accurate. |
| `src/shared/graph/` | `src/shared/graph/` | yes | Contains exactly graphPaths.ts and directedCycles.ts. No edgeConfidence.ts — the plan's new file does not exist. |
| `analyzers/types.ts` | `src/audit/extractors/analyzers/types.ts` | yes | Exists and is as described (AnalyzerContext/AnalyzerOutput/LanguageAnalyzer, AnalyzerResolutionSchema, AnalyzerPlanEntry). Note it is NOT purely type-only — it already holds a runtime Zod enum — so it can host constants without changing its character. |
| `HIDDEN_COUPLING_CONFIDENCE_FLOOR` | `src/audit/extractors/designAssessment.ts` | yes | Line 293, = 0.5. The plan cites this as 'designAssessment.ts' without the extractors/ path; there is no src/audit/orchestrator/designAssessment.ts. |
| `IMPORT_EDGE_CONFIDENCE / REFERENCE_EDGE_CONFIDENCE / RELATIVE_REFERENCE_EDGE_CONFIDENCE` | `src/audit/extractors/graph.ts` | yes | Lines 147-149 = 0.95 / 0.72 / 0.82, matching the plan's §1.5 figures. |
| `tests/shared/edge-confidence.test.ts` | `tests/shared/edge-confidence.test.ts` | **NO** | Does not exist — the plan proposes it. tests/audit/analyzer-seam.test.ts, tests/audit/edge-reasoning.test.ts and tests/audit/tree-sitter-analyzers.test.ts all DO exist. |
| `isValidGraphEdge (landed item 3.5)` | `src/audit/extractors/graphSignals.ts` | yes | Checked for interaction: it is an intra-file extraction in graphSignals.ts and does not touch confidence reading. No overlap with this item. |

### Plan errors (7)

- §2.1 and §3.4 claim FOUR reads of confidenceOf in src/audit/orchestrator/edgeReasoning.ts and instruct the implementer to find 'any 4th read'. There are exactly three (lines 77, 95, 106). An implementer hunting a fourth will waste time or invent one.

- §1.5 cites the hidden-coupling floor as being in 'designAssessment.ts' with no path; the file is src/audit/extractors/designAssessment.ts (HIDDEN_COUPLING_CONFIDENCE_FLOOR = 0.5, line 293). There is no orchestrator/designAssessment.ts.

- §3.5 offers a backward-compat branch (b) 'one-release re-export shim … if any external/deep-import consumer exists'. The grep is already done: typescript.ts is the sole importer, and the repo's standing decision is 'ideal code over compatibility, no external consumers'. Branch (b) is dead and should not be offered.

- §5 asserts the finished diff 'touches exactly' a list that includes the TS_* relocation files. That conflates two independent changes: the duplication fix (this catalog item) and a layering correction of where analyzer tuning constants live. The second has no duplication justification at all — it is a separate item that happens to live in the same file.

- §4 step 7 proposes 'a compile-time assertion that both merge.ts and edgeReasoning.ts import it (or a grep-gate test asserting no local function confidenceOf remains)'. The repo already owns this class of gate as declared data (scripts/check-shared-primitives.mjs, registered in scripts/guard-reach-data.mjs and wired into verify:checks). A hand-rolled grep test in tests/shared would be an unregistered guard and would red npm run check:guard-reach, which fails on any check script outside the registry. If the property is wanted, add it to the shared-primitives gate, not to a bespoke test.

- The plan never mentions the loop-core attestation requirement, even though src/audit/orchestrator/edgeReasoning.ts is loop-core by src/shared/loopCorePaths.ts. The commit will be blocked without an attestation, and the plan's §4/§5 sequences give no step for it.

- Neither §5 nor §4 notices that the merge.ts call site is effectively untested (see red_green_plan) — the plan asserts the existing suites constitute a 'behavior-invariance proof', which for merge.ts:92 they do not.

### Behavior changes (5)

- NONE in the core dedupe. The two deleted bodies are byte-identical to each other and to the proposed shared body, and every call site is a direct textual substitution. For every input to mergeAnalyzerEdges, collectLowConfidenceEdges, edgeReasoningContentHash and buildEdgeReasoningPrompt the output is unchanged, including the content hash (the hashed field is the same number).

- Module export-surface change (not runtime): under the plan's §3.5 option (a), merge.ts stops exporting the five TS_*_EDGE_CONFIDENCE constants. Nothing outside typescript.ts imports them, so no runtime behavior changes, but any external deep import of dist/.../merge.js for those names would break. This is scope creep relative to the duplication item.

- New public API surface on audit-tools/shared: edgeConfidence becomes an exported package symbol. Additive only.

- DEFERRED, explicitly out of scope, and correctly identified by the plan as a behavior change: adopting the shared helper in src/audit/extractors/graph.ts would turn a NaN/Infinity confidence into 0 instead of propagating it. That changes emitted graph-edge content, which would in turn require a GRAPH_EDGE_CACHE_KEY_VERSION bump (already at v5). Do NOT let this ride along.

- Latent risk, not a proposed change: if the implementer chooses the name edgeConfidence and someone later 'tidies' graph.ts's private edgeConfidence by importing the shared one, that silently makes the deferred behavior change. The plan actually WANTS the name collision to force the decision (§1.4); a reviewer may reasonably judge that as manufacturing a trap rather than surfacing one.

### Minimal change

The duplication being removed is three lines in two files. The minimal correct change is the plan's §3.1-§3.4 ONLY; §3.5 (the TS_* constant relocation) is a separate, unrelated layering concern the plan bundles in and should be dropped or split.

1. NEW src/shared/graph/edgeConfidence.ts:
   import type { GraphEdge } from "../types/graph.js";
   export function edgeConfidence(edge: GraphEdge): number {
     return typeof edge.confidence === "number" && Number.isFinite(edge.confidence)
       ? edge.confidence
       : 0;
   }
   with a doc comment saying why non-finite reads as 0 (the value feeds >= / < comparisons where NaN poisons every comparison). Relative type import matches graphPaths.ts:3.

2. src/shared/index.ts — insert after line 84:
   export { edgeConfidence } from "./graph/edgeConfidence.js";

3. src/audit/extractors/analyzers/merge.ts — delete lines 49-53; extend the existing line-2 value import to `import { compareCodeUnits, edgeConfidence } from "audit-tools/shared";`; rewrite line 92 to `if (!existing || edgeConfidence(edge) >= edgeConfidence(existing)) {`. Keep the type import at line 1 (GraphEdge is still used by edgeGroupOf/groupedKey/ungroupedKey/sortEdges/mergeAnalyzerEdges).

4. src/audit/orchestrator/edgeReasoning.ts — delete lines 51-55; extend line 2 to `import { hashContent, compareCodeUnits, edgeConfidence } from "audit-tools/shared";`; rewrite the THREE reads at lines 77, 95, 106. GraphEdge type import stays (edgeSignature and every exported signature use it).

5. NEW tests/shared/edge-confidence.test.ts — table-driven: missing field→0, undefined→0, NaN→0, Infinity→0, -Infinity→0, 0→0, 0.72→0.72, 1→1, -0.5→-0.5 (readers do not clamp; pin it).

Naming caveat the implementer must handle deliberately: src/audit/extractors/graph.ts already has a PRIVATE function named edgeConfidence with different (weaker) semantics. After this lands, two functions with the same name and different behavior coexist in the tree. Either (a) accept it and add a one-line comment on graph.ts:206 pointing at the shared helper and the deferred adoption, or (b) rename the shared export (e.g. statedEdgeConfidence / readEdgeConfidence). Do not leave the collision silent.

Gate notes: src/shared/graph/edgeConfidence.ts gains two importers in the same commit, so check:deadcode and check:orphan-modules are satisfied; one of its importers (merge.ts) is outside loop-core, so check:loop-core-closure will not demand it join the set. The commit stages a loop-core file, so it needs the attestation.

### Red-green plan

Existing coverage is ASYMMETRIC — one call site is genuinely covered, the other is not, and NEITHER covers the guard that is the whole point of the helper.

COVERED (edgeReasoning): tests/audit/edge-reasoning.test.ts:45 "collectLowConfidenceEdges returns only edges below the 0.65 floor" asserts exactly 2 candidates from a 3-edge fixture (0.95 / 0.25 / 0.55). Mutation that reds the fixed code: make edgeConfidence return a constant 0 — the 0.95 edge then falls below the floor and the count becomes 3, failing the `toBe(2)`. Returning a constant 1 also reds it (count 0). This is a real red-green on the shared helper via a consumer.

NOT COVERED (merge): tests/audit/analyzer-seam.test.ts:48 "analyzer import edge supersedes the regex floor" passes a floor edge at 0.95 and an analyzer edge at 0.99, and mergeAnalyzerEdges iterates `[...floor, ...analyzer]` with a `>=` tie-break, so the analyzer edge wins on ORDER alone. A mutant edgeConfidence that returns a constant still passes that test, and passes the ungrouped-kinds test and tests/audit/tree-sitter-analyzers.test.ts too. No test anywhere puts a HIGHER-confidence floor edge against a lower-confidence analyzer edge in the same group — the one input shape where merge.ts's comparison actually decides. COVERAGE GAP, and it is a finding, not an obstacle: the refactor cannot break what no test observes, so a mechanical mistake at merge.ts:92 would land green.

NOT COVERED ANYWHERE: the Number.isFinite branch. No test in the repo feeds an edge with a missing, undefined, NaN or Infinity confidence to either helper. The guard that distinguishes these two helpers from the weak twin in extractors/graph.ts is currently unpinned. The plan's new tests/shared/edge-confidence.test.ts closes this, and it is the highest-value part of the item.

Recommended additions beyond the plan: one merge case with floor 0.99 / analyzer 0.90 in the same group asserting the FLOOR edge survives — that is the assertion which makes merge.ts:92 red-green-able.

### Open choices (6)

- Take §3.5 at all, or split it out? The TS_*_EDGE_CONFIDENCE relocation is a layering fix, not duplication, and it is what makes this a 6-file change instead of a 4-file one. Recommend splitting; the owner decides.

- If §3.5 is taken: src/audit/extractors/analyzers/types.ts versus a new src/audit/extractors/analyzers/edgeConfidences.ts. The plan states no preference beyond 'preferred'. Note types.ts already carries runtime code (AnalyzerResolutionSchema), so hosting constants there does not change its character.

- The shared export's NAME: edgeConfidence (colliding deliberately with the private, weaker function at src/audit/extractors/graph.ts:206) versus a distinct name such as statedEdgeConfidence. The plan argues the collision is a feature; a reviewer may call it a trap.

- Whether to file the deferred follow-up (graph.ts adopts the guarded helper, NaN→0, requiring a GRAPH_EDGE_CACHE_KEY_VERSION bump) as a backlog entry now, and to which file — docs/backlog/open-bugs.md as a real latent defect, or docs/backlog/minor-bugs.md if judged low severity. The plan says 'file a follow-up backlog entry' without naming a destination.

- Whether to close the merge.ts coverage gap in this item (add a floor-wins-over-analyzer merge case) or to record it as a separate coverage finding. Closing it in-item is cheap and makes the refactor red-green-able at both call sites.

- Whether the 'no local function confidenceOf remains' property is enforced at all, and if so whether it goes into scripts/check-shared-primitives.mjs (registry-registered) rather than a bespoke test.

### Against what already landed

No conflict. None of the six landed commits touches merge.ts, edgeReasoning.ts, src/shared/graph/, src/shared/index.ts, or either confidenceOf body — the plan's quoted line numbers for this item are still exact.

Three interactions worth knowing:
1. GRAPH_EDGE_CACHE_KEY_VERSION was bumped v4→v5 in src/audit/extractors/graph.ts. That is the module holding the WEAK private edgeConfidence the plan defers as a follow-up. If someone later takes that follow-up (adopting the isFinite-guarded helper there, NaN→0), it changes emitted edge confidences and would need another cache-key bump. Not this item, but it means the follow-up is not free.
2. Landed siblings set a precedent this plan departs from: 3.5 (isValidGraphEdge) and 3.4 (buildTokenIndex) were INTRA-FILE extractions, and 3.1 (manifestStringArray) landed in an EXISTING sibling module (src/audit/extractors/graphManifestEdges/workspace.ts) rather than a new file or src/shared. This plan creates a new src/shared module. Nothing forbids it — the two consumers genuinely sit in different audit areas, unlike 3.1's — but it is a style divergence a reviewer will notice.
3. 2.5 created scripts/shared/tsAstHelpers.mjs as a new shared home for a duplicated helper, so "new shared module for a shared helper" does have a landed precedent in the scripts tree.

Nothing in the landed set already does any part of what this plan proposes.

---

## 3.3 Gate Runner Construction Twins

**Premise holds:** yes  
**Loop-core:** yes — commit needs a review attestation

PREMISE HOLDS, and the plan's own correction of the catalog (three construction sites, not two) is accurate at HEAD.

Path of the plan file: the task gave `docs/reviews/refactor-plans/refactor-plan-item-3.3-...md`; that directory does not exist. The plan is at `docs/reviews/refactor-plan-item-3.3-gate-runner-construction-twins-2026-09-05.md` (untracked). Read from there.

Three `ReviewDecisionRecord` literals in `src/remediate/steps/nextStep.ts` at HEAD (4694 lines):
- A1 autonomous arm, `runReviewApprovalGate` (record at 1709-1715, `await writeJsonFile(decisionPath, record)` at 1716): `plan_id: randomRunId("path-a-review")`, `approved_ids: auto.approved_ids`, `declined: []`. No archive loop (nothing consumed). Matches the plan's table row exactly.
- A2 interactive consume arm, `runReviewApprovalGate` (1768-1783).
- B consume arm, `runPlanningReviewGate` (2612-2627).

A2 vs B are BYTE-IDENTICAL modulo two spaces of indentation. Verified mechanically: `diff <(sed 's/^  //' <A2 slice>) <B slice>` reports differences only OUTSIDE the block (the preceding `refusalStep` return and the following code), and reports ZERO differences across all 15 lines of the record literal + write + archive loop. The shared block is:

    const record: ReviewDecisionRecord = {
      schema_version: REVIEW_DECISION_SCHEMA_VERSION,
      plan_id: request.plan_id,
      approved_ids: decision.approved_ids,
      declined: decision.declined,
      created_at: new Date().toISOString(),
    };
    await writeJsonFile(decisionPath, record);
    // Archive the consumed inputs so the gate cannot re-halt.
    for (const p of [resolutionPath, requestPath]) {
      if (existsSync(p)) {
        await withFsRetry(() => rename(p, `${p}.consumed-${Date.now()}`));
      }
    }

so the plan's §1.1 archive-loop quote is exact, and its "identical shape" claim is literally true.

Where source disagrees with the plan (three points, all minor, source wins):
1. §3.5 / §1.3.7 calls the "mid-run clarification resolver" a `.consumed-` LOOP. At HEAD (`src/remediate/steps/nextStep.ts:2467-2469`) it is a SINGLE-file guarded rename of `resolutionPath` only — no array, no `requestPath`. It is not a loop and would need a one-element call, not a drop-in. The genuine second loop is the ambiguity gate at 2822-2826, which IS byte-identical to the A2/B loop.
2. §2.2 says `writeJsonFile` has "53 callers repo-wide". At HEAD `grep -rn "writeJsonFile(" src/` returns 71 occurrences. Immaterial to the change; the plan does not modify it.
3. §1.3.4 quotes Path B's id as `state.plan?.plan_id ?? randomRunId("path-b-review")` — correct (line 2582, bound to local `reviewPlanId`) — but note the record itself uses `request.plan_id`, not `reviewPlanId`; `reviewPlanId` only seeds `buildReviewRequest`. The helper receiving `request.plan_id` (as §3.4 says) is right; the §1.1 table's "live plan's own id" is a simplification.

### Files to change

- `src/remediate/steps/nextStep.ts`

### Symbol checks

| Symbol | File | Found | Note |
|---|---|---|---|
| `runReviewApprovalGate` | `src/remediate/steps/nextStep.ts` | yes | Line 1683. Signature `(root, artifactsDir, survivors: Finding[], autonomous = false): Promise<ReviewGateProceed \| ReviewGateHalt>`. Module-private. Single caller at line 2002 (autonomous flag from `canonicalIntent.review_mode === "autonomous"` at 2008). Shape matches the plan. |
| `runPlanningReviewGate` | `src/remediate/steps/nextStep.ts` | yes | Line 2566. Signature `(root, artifactsDir, state: RemediationState, store: StateStore): Promise<RemediationStep \| null>`. Module-private. Single caller `handlePlanning` at line 2845, gated on `state.plan && !existsSync(reviewDecisionPath(artifactsDir))` (2844) exactly as the plan claims. |
| `ReviewDecisionRecord` | `src/remediate/steps/nextStep.ts` | yes | Interface at line 1558, module-private (not exported). Fields exactly `schema_version: typeof REVIEW_DECISION_SCHEMA_VERSION`, `plan_id: string`, `approved_ids: string[]`, `declined: Array<{ finding_id: string; reason: string }>`, `created_at: string`. Matches the plan's helper return type. |
| `REVIEW_DECISION_SCHEMA_VERSION` | `src/remediate/steps/nextStep.ts` | yes | Line 1550, `"remediate-code-review-decision/v1" as const`. Also read at 1485 and 1793 by `discardOnSchemaVersionMismatch` (replay guards) — those are NOT construction sites and must not be swept by the plan's step-5 residue grep. |
| `writeJsonFile` | `src/shared/io/json.ts` | yes | Defined at src/shared/io/json.ts:173, imported into nextStep.ts via the `audit-tools/shared` barrel (import line 18). Unchanged by this refactor, as the plan states. |
| `withFsRetry` | `src/shared/io/json.ts` | yes | Defined at src/shared/io/json.ts:66, already imported in nextStep.ts (import line 23). `existsSync` (node:fs, line 2) and `rename` (node:fs/promises, line 3) also already imported — the plan's 'no import changes needed' holds. |
| `archiveConsumedInputs` | `src/remediate/steps/nextStep.ts` | **NO** | PLAN-DECLARED-NEW, not a plan error. The plan lists it as a key symbol but states in §1.2 that it 'does not exist yet'. Confirmed: zero hits repo-wide. The loop it names is inlined at four places in nextStep.ts (1777-1781, 2622-2626, 2822-2826, and the single-file 2467-2469). |
| `buildReviewDecisionRecord` | `src/remediate/steps/nextStep.ts` | **NO** | PLAN-DECLARED-NEW. Zero hits repo-wide. To be created module-private. |
| `writeReviewDecisionRecord` | `src/remediate/steps/nextStep.ts` | **NO** | PLAN-DECLARED-NEW. Zero hits repo-wide. Optional per the plan's own §3.1 alternative. |
| `reviewDecisionPath / reviewRequestPath / reviewResolutionPath / ambiguityDecisionPath` | `src/remediate/steps/nextStep.ts` | yes | Lines 1572, 1566, 1569, 1584. The plan's placement anchor ('after the path helpers, before `extractAuditFindings`') is valid: `extractAuditFindings` is at 1589. |
| `buildAutonomousReviewDecision` | `src/remediate/review/autonomousGate.js (imported at nextStep.ts:135)` | yes | Used at line 1704; supplies `auto.approved_ids` for site A1 as the plan's table says. |
| `applyReviewResolution / isResolutionForRequest / buildReviewRequest / refuseUnknownIdResolution` | `src/remediate/review/reviewGate.ts (refuseUnknownIdResolution is local to nextStep.ts)` | yes | All present and used at both consume arms; explicitly untouched by the plan. |

### Plan errors (7)

- Plan file path in the task is wrong: `docs/reviews/refactor-plans/refactor-plan-item-3.3-...md` does not exist. The file is at `docs/reviews/refactor-plan-item-3.3-gate-runner-construction-twins-2026-09-05.md` (untracked, alongside 12 sibling refactor plans and the two catalog/runbook docs).

- §3.5 and §1.3.7 describe the mid-run clarification resolver as having a `.consumed-` LOOP. At HEAD it is a single-file guarded rename of `resolutionPath` only (src/remediate/steps/nextStep.ts:2467-2469) — no array, no `requestPath`. The plan's §5.5 follow-up ('expands call sites from 2 to 4 with zero helper changes') is therefore wrong about that site: only the ambiguity gate (2822-2826) is a drop-in; the clarification resolver would need a one-element call, and passing both paths there would change behavior.

- §2.2 states `writeJsonFile` has '53 callers repo-wide'. At HEAD `grep -rn "writeJsonFile(" src/` returns 71 occurrences. Not load-bearing (the function is not modified), but the number is stale.

- §1.1's table says Path B's `plan_id` source is 'the live plan's own id'. Strictly, the record uses `request.plan_id` (line 2614); `reviewPlanId = state.plan?.plan_id ?? randomRunId("path-b-review")` (line 2582) only seeds `buildReviewRequest`. The distinction matters when the request is read back from a pre-existing `review_request.json` rather than rebuilt. §3.4's instruction (`buildReviewDecisionRecord(request.plan_id, …)`) is correct; the table is the loose one.

- §4 step 5 tells the implementer to grep for `schema_version: REVIEW_DECISION_SCHEMA_VERSION` and 'expect exactly one hit'. That is correct for that exact pattern, but the bare token `REVIEW_DECISION_SCHEMA_VERSION` legitimately remains at lines 1485, 1550, 1559 and 1793 (definition, interface type, and the two `discardOnSchemaVersionMismatch` replay reads). Do not treat those as residue.

- §2.3 lists tests 'that observe the affected artifacts' but omits `tests/remediate/remediate-state-invariants.test.ts`, which is the ONLY test that actually drives site A1 end-to-end. It also asserts a coverage picture the source does not support — see the coverage gap in the red-green plan.

- §2.4's `check_index_coverage` claim ('generation current') is a 2026-09-05 statement about the graph index, not re-established here. Treat the graph-derived caller list as advisory; the caller sets were re-verified directly by grep and are correct (one caller each for both gates).

### Behavior changes (4)

- NONE identified. Read strictly, every proposed edit is a pure move: the three literals produce the same object with the same field order, `writeJsonFile` is called with the same two arguments at the same point in control flow, and `archiveConsumedInputs` iterates the same array in the same order with the same `existsSync` guard, the same `withFsRetry` wrapper, and the same `.consumed-${Date.now()}` suffix. Firing predicates, halt/proceed shapes, return types, replay keying, the declined→`ignored` disposition loop, and `store.saveState` are all outside the migrated lines.

- Near-miss worth naming (still not a behavior change): `Date.now()` inside `archiveConsumedInputs` is still evaluated per path inside the loop, and `new Date().toISOString()` inside `buildReviewDecisionRecord` is still evaluated once per record before the write. Hoisting either out of its current position WOULD be a behavior change (two paths archived at the same timestamp; a timestamp taken before rather than after the caller's own work). The plan does not propose hoisting — do not 'tidy' it into one.

- Near-miss worth naming: `archiveConsumedInputs(paths: readonly string[])` is a compile-time-only narrowing. The helper does not copy the array, so a caller's later mutation would still be visible — same as today, where the array is an inline literal at both sites. No runtime difference.

- Latent risk if the implementer over-reaches: adopting the helper at line 2467-2469 (the mid-run clarification resolver) would be a behavior change, because that site archives ONLY `resolutionPath` today. Passing `[resolutionPath, requestPath]` there would newly rename the ambiguity request. The plan puts that site out of scope; keep it out.

### Minimal change

All edits in `src/remediate/steps/nextStep.ts`. Nothing else, no test edits, no imports, no exports.

STEP 1 — add three module-private helpers immediately after `ambiguityDecisionPath` (ends line 1586) and before `extractAuditFindings` (line 1589):

    function buildReviewDecisionRecord(
      planId: string,
      approvedIds: string[],
      declined: Array<{ finding_id: string; reason: string }>,
    ): ReviewDecisionRecord {
      return {
        schema_version: REVIEW_DECISION_SCHEMA_VERSION,
        plan_id: planId,
        approved_ids: approvedIds,
        declined,
        created_at: new Date().toISOString(),
      };
    }

    async function writeReviewDecisionRecord(
      decisionPath: string,
      record: ReviewDecisionRecord,
    ): Promise<void> {
      await writeJsonFile(decisionPath, record);
    }

    /** Archive consumed gate inputs so the gate cannot re-halt on the next call. */
    async function archiveConsumedInputs(paths: readonly string[]): Promise<void> {
      for (const p of paths) {
        if (existsSync(p)) {
          await withFsRetry(() => rename(p, `${p}.consumed-${Date.now()}`));
        }
      }
    }

STEP 2 — site A1, `runReviewApprovalGate`, lines 1709-1716 (the `const record` literal through `await writeJsonFile(decisionPath, record);`). Replace with:

    await writeReviewDecisionRecord(
      decisionPath,
      buildReviewDecisionRecord(randomRunId("path-a-review"), auto.approved_ids, []),
    );

Keep the preceding "Leftovers stay LIVE…" comment (1705-1708) and everything after (`leftovers`, `emitAutonomousLeftoverDeliverable`, the `proceed` return).

STEP 3 — site A2, lines 1768-1783 (record literal through the closing `}` of the archive loop). Replace with:

    await writeReviewDecisionRecord(
      decisionPath,
      buildReviewDecisionRecord(request.plan_id, decision.approved_ids, decision.declined),
    );
    // Archive the consumed inputs so the gate cannot re-halt.
    await archiveConsumedInputs([resolutionPath, requestPath]);

STEP 4 — site B, lines 2612-2627, identical replacement text (two spaces less indentation). The `// Declined nodes → recorded terminal disposition` loop and `store.saveState` below stay untouched.

Order matters: `[resolutionPath, requestPath]` — resolution first, exactly as today.

STEP 5 — residue check. `grep -n "schema_version: REVIEW_DECISION_SCHEMA_VERSION" src/remediate/steps/nextStep.ts` must return exactly ONE hit (inside the builder); today it returns three (1710, 1769, 2613). Do NOT expect the bare token `REVIEW_DECISION_SCHEMA_VERSION` to fall to one — lines 1485, 1550, 1559 and 1793 legitimately keep it. `grep -n "consumed-\${Date.now()}"` must fall from four hits to three: the helper, the single-file clarification rename at 2467-2469, and the ambiguity-gate loop at 2822-2826 (both out of scope).

Gates: `npm run build && npm run check`, then `npx vitest run tests/remediate/next-step-review-gate.test.ts tests/remediate/cp-node-1-regressions.test.ts tests/remediate/n-r13-document-phase-dissolved.test.ts tests/remediate/integration-pipeline.test.ts tests/remediate/remediate-state-invariants.test.ts`, then the full suite. A loop-core attestation is required before the commit.

### Red-green plan

EXISTING COVERAGE (sites A2 and B are well covered; site A1 is NOT — see the gap below).

Site A2 — `tests/remediate/next-step-review-gate.test.ts`:
- "an empty resolution approves everything and advances into the contract pipeline" (~line 143) asserts `decision.declined === []`, `decision.approved_ids` contains both ids, `existsSync(resolutionPath) === false`, and exactly ONE `review_resolution.json.consumed*` entry in the artifacts dir (line 156).
- "a disapproved finding is recorded with a reason and dropped from the pipeline seed" (~line 175) asserts `decision.declined[0].finding_id/reason` and `decision.approved_ids`.
- "the decision gates the gate: a later run does not re-halt" (~line 164) covers the archive's re-halt-impossible property.

Site B — same file, "declining a node records it terminal (never silently closed) and the run proceeds" (~line 418) asserts `decision.plan_id === "PLAN-PATH-B"`, `decision.declined`, and the `ignored` disposition; "re-running after the decision does not re-halt" (~line 446) covers B's archive.

RED MUTATIONS (each a single edit to the fixed code, each expected to red a named existing test):
1. In `archiveConsumedInputs`, invert the guard to `if (!existsSync(p))`. RED: `next-step-review-gate.test.ts` "an empty resolution approves everything…" — `existsSync(resolutionPath)` stays true and the `.consumed` count assertion at line 156 becomes 0. This is the single cleanest mutation; it reds both A2 and B archive behavior.
2. In `buildReviewDecisionRecord`, hardcode `plan_id: "path-b-review"` instead of `planId`. RED: the Path-B test's `expect(decision.plan_id).toBe("PLAN-PATH-B")` (line 435).
3. In `buildReviewDecisionRecord`, swap `declined` for `[]`. RED: "a disapproved finding is recorded with a reason…" (`decision.declined.map(...)` expected `[STRATEGIC_ID]`).
4. In `buildReviewDecisionRecord`, change `schema_version` to any other string. RED via the replay: `discardOnSchemaVersionMismatch` (line 1793) discards the record, `declined` becomes `[]`, and the disapproval test's seed/approved-findings assertions fail.

COVERAGE GAP — a finding, state it in the commit note. **No test asserts the CONTENT of the site-A1 (autonomous) decision record.** `tests/remediate/remediate-state-invariants.test.ts` ("CP-NODE-15 inv-12/fail-8: the leftover emit, driven", ~line 695) is the only test that actually drives the A1 arm through `decideNextStep` with `review_mode: "autonomous"`, and it asserts only the leftover deliverable pair and its run-log event — never `review_decision.json`. `tests/remediate/cp-node-1-regressions.test.ts` (~line 585) exercises the autonomous-SHAPED replay but HAND-WRITES `review_decision.json` rather than letting A1 produce it. `tests/remediate/autonomous-gate.test.ts` is a pure unit test of `buildAutonomousReviewDecision`. Consequence: a mutation confined to A1's record (wrong `plan_id`, or `approved_ids` set to every survivor) reds NOTHING — A1 returns its `proceed` from the locally computed `approvedSet`, not from the record, and no test makes a second `decideNextStep` call in autonomous mode to force the replay read. This gap predates the refactor and the refactor neither widens nor closes it; the migration of A1 is therefore verified only by typecheck plus diff review.

### Open choices (6)

- Wrapper or no wrapper. The plan itself (§3.1) offers the alternative of dropping `writeReviewDecisionRecord` and calling `writeJsonFile(decisionPath, buildReviewDecisionRecord(...))` inline at the three sites — one line shorter per site. The plan prefers the wrapper; the repo's dead-code posture (`npm run check:deadcode`, default-mode knip) tolerates a module-private one-line wrapper, so this is a taste call for the owner. Note the wrapper's stated value ('a future schema bump or ledger hook has one call site') is already delivered by `buildReviewDecisionRecord` for the schema half.

- Whether to migrate the ambiguity gate's identical loop (src/remediate/steps/nextStep.ts:2822-2826) in the SAME commit. The plan says no ('one item, one gate pair') and defers it to §5.5. Against that: the repo's atomic-replace ordering invariant and 'fix the defect CLASS' preference argue for taking the one byte-identical sibling now rather than leaving a second copy of the loop the helper exists to kill. This is genuinely the owner's call.

- Whether the single-file clarification-resolver rename (2467-2469) should also route through `archiveConsumedInputs([resolutionPath])`. Uniform naming vs. an extra call for one path; the plan does not address the single-path form at all.

- Helper placement. The plan pins it after the path helpers and before `extractAuditFindings` (i.e. around line 1587). An equally defensible home is directly beside the two gate functions. Cosmetic; the plan's choice keeps 'review-gate persistence vocabulary' together and is a fine default.

- Whether `archiveConsumedInputs` deserves a JSDoc line stating WHY it exists (re-halt impossibility), given the plan keeps the `// Archive the consumed inputs so the gate cannot re-halt.` comment at each CALL site. Duplicating the rationale in both places, or keeping it only at the call sites, is a style choice.

- §5.5's second item — whether `writeReviewDecisionRecord` should emit a run-log event (today only the autonomous leftover emit logs). The plan explicitly proposes no behavior change here and leaves the question open.

### Against what already landed

NO CONFLICT, and none of the landed commits partly does this work.

Checked each: item 3.5 (`isValidGraphEdge`, src/audit/extractors/graphSignals.ts), item 3.1 (`manifestStringArray` in src/audit/extractors/graphManifestEdges/workspace.ts; `tomlStringArray`/`yamlStringArray` deleted), item 3.4 (`buildTokenIndex` in src/audit/extractors/commentDecomposition.ts), item 2.5 (scripts/shared/tsAstHelpers.mjs), the GRAPH_EDGE_CACHE_KEY_VERSION v4→v5 bump in src/audit/extractors/graph.ts, and the check:control-bytes preCommit flip in scripts/guard-reach-data.mjs — every one is in `src/audit/extractors/`, `scripts/`, or a gate-registry file. None touches `src/remediate/`. `git log --oneline -3 -- src/remediate/steps/nextStep.ts` shows the last three touches are c899265a / 23719896 / 30ddc47d, none of them from that list.

One operational consequence, not a conflict: because the target is loop-core (see below), the commit gate demands a fresh staged-tree-bound review attestation (`node .claude/hooks/attest-loop-core-review.mjs`). None of the landed commits changes that.

---

## 4.1 Source Line Counting Twins

**Premise holds:** yes  
**Loop-core:** yes — commit needs a review attestation

PATH CORRECTION FIRST: the task named `docs/reviews/refactor-plan-item-4.1-source-line-counting-twins-2026-09-05.md`; no `docs/reviews/refactor-plans/` directory exists at HEAD. The plan read is `docs/reviews/refactor-plan-item-4.1-source-line-counting-twins-2026-09-05.md` (untracked).

PREMISE HOLDS, and the plan's own corrections to the catalog are accurate at HEAD. Neither twin touches disk; both are in-memory precedence chains. Verified verbatim:

`src/audit/orchestrator/reviewPacketShared.ts` (3-arg, task-first):
```ts
export function lineCountForPath(
  task: AuditTask,
  path: string,
  lineIndex?: Record<string, number>,
): number {
  return task.file_line_counts?.[path] ?? lineIndex?.[path] ?? 0;
}
```

`src/audit/orchestrator/selectiveDeepening/shared.ts` (4-arg, path-first):
```ts
export function lineCountForPath(
  path: string,
  task: AuditTask | undefined,
  result: AuditResult,
  lineIndex?: Record<string, number>,
): number {
  return (
    task?.file_line_counts?.[path] ??
    resultLineIndex(result)[path] ??
    lineIndex?.[path] ??
    0
  );
}
```
The two bodies are NOT identical (the plan never claims they are; the catalog's "identical twins" framing is what is wrong): the deepening variant inserts the result-coverage level and the argument order is inverted. So this is a superset/argument-order-inversion pair, not a copy-paste pair — the "swap task and path at a call site" hazard the plan flags (§1.2) is real.

The named defect is real: `resultLineIndex` rebuilds a full `Object.fromEntries` over `result.file_coverage` on EVERY call, and every caller maps it over N paths. `lineCountFromSources` likewise does a per-path `.find` over each result's `file_coverage`.

`conflict.ts` really does already build the memoized shape at the call site (`const lineSources = new Map<string, { task?: AuditTask; result: AuditResult }>()`), supporting the plan's argument.

Incidental correctness detail the plan does not mention: `resultLineIndex(result)[path]` is a prototype-bearing object from `Object.fromEntries`, so a coverage path literally named `constructor`/`toString` returns an inherited function rather than `undefined` and short-circuits the `??` chain. Moving to `Map.get` (as the plan does) silently FIXES that; `lineIndex?.[path]` stays a plain Record and keeps the hazard.

### Files to change

- `src/audit/orchestrator/lineCounts.ts (NEW — does not exist at HEAD)`
- `src/audit/orchestrator/reviewPacketShared.ts`
- `src/audit/orchestrator/reviewPackets.ts`
- `src/audit/orchestrator/reviewPacketMetrics.ts`
- `src/audit/orchestrator/selectiveDeepening/shared.ts`
- `src/audit/orchestrator/selectiveDeepening/conflict.ts`
- `src/audit/orchestrator/selectiveDeepening/highRiskClean.ts`
- `src/audit/orchestrator/selectiveDeepening/findingFollowup.ts`
- `src/audit/orchestrator/selectiveDeepening/lensVerification.ts`
- `src/audit/orchestrator/selectiveDeepening/runtimeValidation.ts`
- `src/audit/orchestrator/selectiveDeepening/stewardFollowup.ts`
- `tests/audit/orchestrator-remediation.test.ts (new discriminating tests — see red_green_plan)`

### Symbol checks

| Symbol | File | Found | Note |
|---|---|---|---|
| `lineCountForPath (3-arg)` | `src/audit/orchestrator/reviewPacketShared.ts` | yes | EXISTS, line 27. Shape matches plan exactly: (task: AuditTask, path: string, lineIndex?: Record<string,number>) => task.file_line_counts?.[path] ?? lineIndex?.[path] ?? 0. File also holds ReviewPacketPlanningData and normalizePriority, as the plan says. |
| `lineCountForPath (4-arg)` | `src/audit/orchestrator/selectiveDeepening/shared.ts` | yes | EXISTS, line 96. Shape matches: (path, task: AuditTask\|undefined, result: AuditResult, lineIndex?) with the four-level chain. Note `result` is REQUIRED (not optional) at HEAD. |
| `resultLineIndex` | `src/audit/orchestrator/selectiveDeepening/shared.ts` | yes | EXISTS, line 87, module-private (not exported). Returns Record<string,number> via Object.fromEntries, rebuilt per call. Matches the plan's defect description. |
| `lineCountFromSources` | `src/audit/orchestrator/selectiveDeepening/shared.ts` | yes | EXISTS, line 145. Signature (path, tasks: AuditTask[], results: AuditResult[], lineIndex?). tasks/results are REQUIRED non-optional arrays of non-undefined elements — the plan's proposed LineCountMultiSources widens both to optional arrays of possibly-undefined, an accepted-input change. |
| `ReviewTask` | `src/ (repo-wide)` | **NO** | CONFIRMED ABSENT, exactly as the plan's own §1.5 correction says. Only `allReviewTasks` locals in ingestionExecutors.ts:229 and planningExecutors.ts:241. The plan header's 'ReviewTask' means AuditTask; the plan already self-corrects, so this is a header wart, not an actionable plan error. |
| `AuditTask.file_line_counts` | `src/audit/types.ts` | yes | EXISTS, line 147: `file_line_counts: z.record(z.string(), z.number()).optional()`. Matches. |
| `FileCoverageRecord` | `src/audit/types.ts` | yes | EXISTS, line 95: { path, total_lines, pass_id, lens?, agent_role? }. AuditResultSchema.file_coverage (line 203) is the separate inline { path, total_lines } array. Both match the plan's §1.5 description; the plan's minimal structural view type accepts both. |
| `buildPacket / fileLineCounts materialization` | `src/audit/orchestrator/reviewPackets.ts` | yes | EXISTS, call at line 103: `owner ? lineCountForPath(owner, path, lineIndex) : 0`. Matches plan row #1. |
| `taskLineCount` | `src/audit/orchestrator/reviewPacketMetrics.ts` | yes | EXISTS, private, call at line 40: `lineCountForPath(task, path, lineIndex)`. Matches plan row #2. |
| `buildConflictFollowupTask` | `src/audit/orchestrator/selectiveDeepening/conflict.ts` | yes | EXISTS, call at line 54 inside a ternary with `: (params.lineIndex?.[path] ?? 0)` fallback. Matches plan row #3, including the plan's note that the fallback arm is subsumed. |
| `buildHighRiskCleanFollowupTask` | `src/audit/orchestrator/selectiveDeepening/highRiskClean.ts` | yes | EXISTS, call at line 65. Matches plan row #4. |
| `buildFindingFollowupTask` | `src/audit/orchestrator/selectiveDeepening/findingFollowup.ts` | yes | EXISTS, call at line 41. Matches plan row #5. |
| `lensVerificationTriggers` | `src/audit/orchestrator/selectiveDeepening/lensVerification.ts` | yes | EXISTS, line 52. Params are { lens, sources, externalAnalyzerPaths } — NO lineIndex, as the plan says. Call at line 87: `lineCountForPath(path, owner.task, owner.result)`, no lineIndex. Matches plan row 6a. |
| `selectLensVerificationFiles` | `src/audit/orchestrator/selectiveDeepening/lensVerification.ts` | yes | EXISTS, line 211. PLAN SHAPE MISMATCH (minor): it takes THREE POSITIONAL params `(sources, externalAnalyzerPaths, lens)`, not an options object. The plan's §3.4 'add lineIndex? param' is still doable but means a 4th positional arg (or an options-object conversion the plan does not scope). Call at line 228, no lineIndex. Matches plan row 6b otherwise. |
| `buildLensVerificationTask` | `src/audit/orchestrator/selectiveDeepening/lensVerification.ts` | yes | EXISTS, line 291, options object WITH `lineIndex?: Record<string, number>` (line 296). lineCountFromSources call at line 336-341, passing params.lineIndex. Matches plan row 6c, including the plan's claim it already holds lineIndex. |
| `buildLensVerificationTasks` | `src/audit/orchestrator/selectiveDeepening/lensVerification.ts` | yes | EXISTS, line 373, holds params.lineIndex (line 376) and calls lensVerificationTriggers at line 394 WITHOUT it. Matches the plan's threading claim for 6a. |
| `buildRuntimeValidationFollowupTask` | `src/audit/orchestrator/selectiveDeepening/runtimeValidation.ts` | yes | EXISTS, lineCountFromSources call at lines 75-80 with (path, params.relatedTasks, params.results, params.lineIndex). Matches plan row #7. |
| `buildVerificationFollowupTasks / coverageByPath` | `src/audit/orchestrator/selectiveDeepening/stewardFollowup.ts` | yes | EXISTS, line 14; coverageByPath built at line 27; counting at line 88 is `coverageByPath.get(path) ?? params.lineIndex?.[path] ?? 0` — it does NOT consult params.task?.file_line_counts. The plan's §2.3 description is exactly right, including that `coverageByPath.has(path)` is still needed for the suggestedPaths filter (line 54). |
| `AuditResult type import in selectiveDeepening/shared.ts` | `src/audit/orchestrator/selectiveDeepening/shared.ts` | yes | PLAN ERROR. §3.3 says 'Type AuditResult import in shared.ts becomes unused — remove it'. FALSE: after deleting the three functions, AuditResult is still used at line 58 (BuildSelectiveDeepeningTaskOptions.results), line 66 (FindingContext.result) and line 121 (pathsForFinding). Do NOT remove that import; doing so is a compile error. |
| `src/shared/paths.ts` | `src/shared/paths.ts` | yes | EXISTS, 23 lines (plan says 24 — off by one, immaterial), exactly toPosixPath + normalizeRepoRelPath. The plan's REJECTED-as-destination reasoning holds. |
| `src/audit/orchestrator/lineCounts.ts` | `src/audit/orchestrator/lineCounts.ts` | **NO** | Does not exist at HEAD — the plan's one new file. Confirmed no name collision. |
| `MAX_LENS_VERIFICATION_FILES / MAX_LENS_VERIFICATION_RESULT_SUMMARIES` | `src/audit/orchestrator/selectiveDeepening/shared.ts` | yes | EXIST (lines ~99-100 region of the constants block). The plan's §2.4 claim that tests/audit/observability-signals.test.ts imports only constants from shared.js is confirmed by grep — no test imports either twin function. |

### Plan errors (10)

- §3.3 FACTUAL ERROR: 'Type AuditResult import in shared.ts becomes unused — remove it from the type import (keep AuditTask, Finding, Lens)'. FALSE at HEAD. After deleting the three functions, `AuditResult` is still referenced at src/audit/orchestrator/selectiveDeepening/shared.ts:58 (BuildSelectiveDeepeningTaskOptions.results), :66 (FindingContext.result) and :121 (pathsForFinding). Following the plan here is an immediate compile error.

- §3.1 GATE ERROR: the module exports `buildResultLineIndex` and `resultLineIndexFor`, neither of which any production call site uses (the plan itself says 'Canonical call sites need not use it' and only the throwaway probes call them). `check:deadcode` runs `knip --no-config-hints` with `exports` in knip.json's include list — an exported symbol with no importing consumer is a red build. Make both module-private (as minimal_change does) or give them a real adopter. This is the exact class recorded in project memory as 'an additive export with no adopter reds check:deadcode'.

- §3.1 SAME GATE ERROR, second instance: the `resultIndex?: ReadonlyMap<string, number>` escape-hatch field on LineCountSources has no adopter either (the plan explicitly says conflict.ts 'need not use it'). Interface members are not knip-reported, so it will not red the build — but it is unreachable API shipped on speculation, which is what 'ideal code over compatibility' in CLAUDE.md forbids. Drop it; add it when a caller needs it.

- §2.2 row 6a / §3.4 MISCLASSIFICATION: threading lineIndex into lensVerificationTriggers is called 'behavior-neutral'. It is not (see behavior_changes #2). §5.3's 'ranking output is unchanged' rests on the same error (behavior_changes #3). Both claims are refuted by resultFiles() preferring task.file_paths over file_coverage.

- §3.4 SHAPE MISMATCH: 'selectLensVerificationFiles: add lineIndex? param'. At HEAD that function is three POSITIONAL params `(sources, externalAnalyzerPaths, lens)` at lensVerification.ts:211, not an options object — the plan reads as if it were one. minimal_change drops this step entirely, so it is moot there, but any implementer following the plan verbatim would be adding a fourth positional argument to a function whose neighbours all use options objects.

- MISSING STEP — LOOP-CORE ATTESTATION. Every file the plan touches, and the new file, sits under `src/audit/orchestrator/`, a directory-prefix pattern in src/shared/loopCorePaths.ts:51. The commit gate blocks a loop-core commit lacking a fresh staged-tree-bound attestation. The plan's §4 sequence and §5.5 closeout checklist never mention it; an implementer following the plan hits the block at commit time with no idea why.

- §5.2 METHOD ERROR (repo-policy, not factual): 'Parity is proven with throwaway probes'. This repo's standing rule is that a property worth stating is enforced mechanically — a throwaway probe leaves the precedence chain exactly as untested after the change as before it, and the coverage gap in red_green_plan shows that is a real hole, not a theoretical one. Probes A, B and D should land as real tests.

- §1.4 minor: 'src/shared/paths.ts — 24 lines'. It is 23 lines at HEAD. Immaterial to the conclusion, which is correct.

- HEADER minor: 'Key Symbols: … ReviewTask' names a symbol that does not exist in src/. The plan self-corrects in §1.5, so it is a stale header, not an actionable error — but the header is what a skimming implementer reads.

- PATH: the task named `docs/reviews/refactor-plans/refactor-plan-item-4.1-…`. No such directory exists; the file is at `docs/reviews/refactor-plan-item-4.1-source-line-counting-twins-2026-09-05.md`.

### Behavior changes (8)

- #1 (plan §2.3, ACKNOWLEDGED by the plan) stewardFollowup.ts precedence inversion. HEAD: `coverageByPath.get(path) ?? params.lineIndex?.[path] ?? 0` — task counts are never consulted. Plan: task counts win. Output changes for any path where the lens-verification task's file_line_counts disagrees with the verification result's coverage. The plan calls this a 'deliberate precedence fix'; it is a semantic change bundled into a move and should be its own commit. Note the plan's own mitigation reasoning ('paths are pre-filtered to coverageByPath.has(path), so the old code always hit coverage') is right about the filter but does not bound the disagreement — the filter guarantees coverage HAS the path, not that it agrees with the task.

- #2 (plan MISLABELS this as behavior-neutral) lensVerification.ts:87, `lensVerificationTriggers` totalLines. Plan row 6a threads `lineIndex` in and says '(behavior-neutral: adds a fallback level that previously returned 0)'. IT IS NOT NEUTRAL. `resultFiles(source)` returns `source.task.file_paths` whenever that array is non-empty — those paths need not appear in `file_coverage`, and `file_line_counts` is optional — so paths that resolve to 0 today can resolve to a real lineIndex value. totalLines directly gates the `large_lens_surface` trigger (threshold 2000), which gates whether a lens-steward task is built at all. A previously-absent steward task can now be created.

- #3 (plan MISLABELS, and §5.3 asserts the opposite) lensVerification.ts:228, `selectLensVerificationFiles`. Threading `lineIndex` changes the `lines` value fed to `add(path, priorityScore, lines)`, which is combined with `Math.max` and used as the ranking tiebreak. §5.3 claims 'ranking output is unchanged' — that claim depends on the very threading it also proposes. Different `lines` can reorder `selectedPaths`, which changes the steward task's `file_paths`, which changes `taskIdFor('steward', …)` inputs indirectly via omittedPathCount/rationale text. Do not thread lineIndex here as part of a move.

- #4 lineCountFromSources widens its accepted input: HEAD takes `tasks: AuditTask[]` and `results: AuditResult[]` (required, non-undefined elements); the plan takes optional readonly arrays whose elements may be undefined. Strictly wider — no existing caller changes answer — but it does change what the function accepts, and it lets `lensVerification.ts` delete its `.filter((task): task is AuditTask => task !== undefined)` type guard (same answers, since a filtered-out and a skipped undefined both fall through).

- #5 lineCountForPath's `result` becomes OPTIONAL where HEAD requires it (shared.ts:99 `result: AuditResult`). Callers can now omit it, so a caller that means to pass a result and forgets gets a silent fallback to lineIndex/0 instead of a compile error. This is the price of unifying with the 3-arg planning form and is unavoidable, but it is a real loss of static enforcement — flag it in review.

- #6 WeakMap memoization introduces a staleness window that does not exist today. HEAD rebuilds the index on every call, so a mutation of `result.file_coverage` is observed immediately. After the change, the first lookup pins the index for the lifetime of that result object. The plan's soundness argument ('file_coverage is append-only at ingestion time') is an assertion about a code path outside the touched files and is NOT verified by anything in this plan or by any test. If a result object is ever reused across an ingestion that appends coverage, counts go stale silently.

- #7 (incidental, plan does not mention) prototype-pollution-shaped fix: HEAD's `resultLineIndex(result)[path]` returns an inherited Object.prototype member for a coverage path named `constructor`/`toString`/`valueOf`, which short-circuits the `??` chain with a non-number. The Map-based rewrite returns undefined and falls through correctly. A behavior change for pathological path names — an improvement, but a change.

- #8 conflict.ts:54 loses its explicit `source ? … : (params.lineIndex?.[path] ?? 0)` branch. Verified equivalent (helper with no task and no result returns lineIndex ?? 0), so this is a pure simplification — listed only so the reviewer knows it was checked rather than assumed.

### Minimal change

MINIMAL CORRECT CHANGE — a pure move plus ONE memoization, deliberately smaller than the plan.

1. NEW `src/audit/orchestrator/lineCounts.ts`. Type-only imports of AuditTask from `../types.js`. Export exactly TWO functions (see plan_errors on why the plan's other two exports must not ship):

```ts
import type { AuditTask } from "../types.js";

/** Minimal coverage carrier — accepts AuditResult and FileCoverageRecord arrays. */
export interface LineCountResultView {
  readonly file_coverage: ReadonlyArray<{ path: string; total_lines: number }>;
}

export interface LineCountSources {
  task?: AuditTask | undefined;
  result?: LineCountResultView | undefined;
  lineIndex?: Record<string, number> | undefined;
}

const resultIndexes = new WeakMap<object, ReadonlyMap<string, number>>();

function resultLineIndexFor(result: LineCountResultView): ReadonlyMap<string, number> {
  const cached = resultIndexes.get(result);
  if (cached) return cached;
  const built = new Map(result.file_coverage.map((c) => [c.path, c.total_lines]));
  resultIndexes.set(result, built);
  return built;
}

/** Precedence: task.file_line_counts -> result file_coverage -> lineIndex -> 0. */
export function lineCountForPath(path: string, sources?: LineCountSources): number {
  return (
    sources?.task?.file_line_counts?.[path] ??
    (sources?.result ? resultLineIndexFor(sources.result).get(path) : undefined) ??
    sources?.lineIndex?.[path] ??
    0
  );
}

export interface LineCountMultiSources {
  tasks?: ReadonlyArray<AuditTask | undefined> | undefined;
  results?: ReadonlyArray<LineCountResultView | undefined> | undefined;
  lineIndex?: Record<string, number> | undefined;
}

/** First task hit -> first result hit -> lineIndex -> 0. */
export function lineCountFromSources(path: string, sources?: LineCountMultiSources): number {
  for (const task of sources?.tasks ?? []) {
    const count = task?.file_line_counts?.[path];
    if (count !== undefined) return count;
  }
  for (const result of sources?.results ?? []) {
    if (!result) continue;
    const count = resultLineIndexFor(result).get(path);
    if (count !== undefined) return count;
  }
  return sources?.lineIndex?.[path] ?? 0;
}
```
Keep `??` throughout — a recorded `0` must beat the fallback; `||` is the regression this invites.

2. Repoint the planning pair (imports switch to `"./lineCounts.js"`):
   - `reviewPackets.ts:103` -> `owner ? lineCountForPath(path, { task: owner, lineIndex }) : 0` (keep the ternary; the `owner` guard also drives nothing else).
   - `reviewPacketMetrics.ts:40` -> `lineCountForPath(path, { task, lineIndex })`.

3. Repoint the deepening strategies (imports switch to `"../lineCounts.js"`; drop the twin names from the `./shared.js` import lists):
   - `conflict.ts:54` -> collapse the ternary to `lineCountForPath(path, { task: source?.task, result: source?.result, lineIndex: params.lineIndex })` (the `?? 0` arm is subsumed).
   - `highRiskClean.ts:65`, `findingFollowup.ts:41` -> `lineCountForPath(path, { task: params.task, result: params.result, lineIndex: params.lineIndex })`.
   - `lensVerification.ts:87` and `:228` -> `lineCountForPath(path, { task: …, result: … })` — PASS NO lineIndex (keep HEAD behavior; see behavior_changes #2/#3). This deletes the plan's whole lineIndex-threading step for `lensVerificationTriggers` and `selectLensVerificationFiles`.
   - `lensVerification.ts:336` -> `lineCountFromSources(path, { tasks: params.sources.map((s) => s.task), results: params.sources.map((s) => s.result), lineIndex: params.lineIndex })` — the widened `tasks` element type lets the existing `.filter((task): task is AuditTask => …)` be deleted (pure simplification, same answers: a filtered-out undefined task and a skipped-undefined task both fall through).
   - `runtimeValidation.ts:75` -> `lineCountFromSources(path, { tasks: params.relatedTasks, results: params.results, lineIndex: params.lineIndex })`.

4. `stewardFollowup.ts:88` — TWO options, and this is the one real judgment call (see open_choices #1). Minimal-and-behavior-preserving: leave it alone entirely (it is a third variant, not a twin, and the plan's §2.3 change is a semantic change smuggled into a move). If the precedence fix IS wanted, it lands as its OWN commit after the move, with its own test.

5. DELETE `lineCountForPath` from `reviewPacketShared.ts`; DELETE `resultLineIndex`, `lineCountForPath`, `lineCountFromSources` from `selectiveDeepening/shared.ts`. KEEP the `AuditResult` type import in shared.ts (plan error). No re-export shims.

6. Loop-core attestation is REQUIRED before commit (the plan never mentions it): every touched path is under `src/audit/orchestrator/`, which is a directory-prefix pattern in `src/shared/loopCorePaths.ts`. Run `node .claude/hooks/attest-loop-core-review.mjs --reviewed-by <id> --attester-class <agent|human> --checked "<...>"` against the final staged tree.

7. Gates: `npm run check`, `npm run check:tests`, then `check:lint check:depgraph check:deadcode check:orphan-modules check:dup check:shared-primitives check:loop-core-closure check:control-bytes`, then `npm test`. `check:doc-code-citations` strips `:NNN` suffixes and resolves paths only, so the catalog's `reviewPacketShared.ts:27` / `shared.ts:96` citations will NOT red — but they become factually stale; fix them in `docs/reviews/duplication-and-complexity-catalog-2026-09-05.md` lines 161-162 and 241 (line 241 additionally proposes `src/shared/paths.ts` as the destination, which the plan correctly rejects).

### Red-green plan

COVERAGE GAP — state this plainly, it is the main finding of the verification.

Tests that REACH the code (all via `buildSelectiveDeepeningTasks` in `tests/audit/orchestrator-remediation.test.ts`; no test imports either twin directly, and `tests/audit/observability-signals.test.ts` imports only constants from `selectiveDeepening/shared.js`):
- line 369 `expect(tasks[0].file_line_counts!["src/api/auth.ts"]).toBe(40)` — reaches findingFollowup's lineCountForPath.
- line 602 same assertion — reaches stewardFollowup's counting path.
- the two `lensVerificationTriggers totalLines` tests (fixtures at lines ~1544 and ~1633) — reach lensVerification.ts:87 and gate the `trigger:large_lens_surface` tag.
- the lens-steward and runtime-validation tests (fixtures at ~1278, ~1697) — reach lineCountFromSources.
- `tests/audit/review-packets.test.ts:20` and `review-packet-sizing.test.ts:37,52` — reach reviewPackets/reviewPacketMetrics.

BUT NO EXISTING TEST DISCRIMINATES THE PRECEDENCE CHAIN. Every fixture builds `file_coverage` as `task.file_paths.map((path) => ({ path, total_lines: task.file_line_counts![path] }))` (lines 508, 1238, 1302, 1365, 1428, 1509, 1588, 1658) or hand-writes coverage equal to the task counts (lines 344, 568-571). And NO test that reaches these call sites passes a non-empty `lineIndex`. Consequences:
- Swapping the first two precedence levels (result before task) in the fixed `lineCountForPath` reds NOTHING.
- Deleting the `lineIndex` arm reds NOTHING.
- Replacing `??` with `||` (the 0-is-a-real-count regression the plan itself warns about) reds NOTHING.
- The §2.3 stewardFollowup precedence change reds NOTHING — line 602's fixture has task count == coverage == 40.

The only mutation that reds an existing test is a coarse one: make `lineCountForPath` return `0` unconditionally, or drop BOTH the task and result arms — then lines 369, 602 and the `trigger:large_lens_surface` assertion (~1613) go red. That is a smoke test, not a precedence test.

RED-GREEN PLAN (do this, do not use the plan's "throwaway probes" — this repo's standing rule is that a property worth stating is enforced mechanically, and a throwaway probe leaves no gate):
1. RED FIRST, before the move: add a discriminating test in `tests/audit/orchestrator-remediation.test.ts` with `task.file_line_counts = { "src/api/auth.ts": 40 }` but `file_coverage = [{ path: "src/api/auth.ts", total_lines: 77 }]`, plus a `lineIndex = { "src/api/auth.ts": 999, "src/other.ts": 5 }` passed to `buildSelectiveDeepeningTasks`. Assert the follow-up task's `file_line_counts["src/api/auth.ts"] === 40` (task beats coverage beats index). Add a second case with `file_line_counts: { "z.ts": 0 }` and `lineIndex: { "z.ts": 5 }` asserting `0`. Confirm these pass at HEAD (they should — they pin existing behavior), then confirm each reds under exactly one single-level mutation of the fixed code: swap task/result arms -> first case yields 77; `??`->`||` -> second case yields 5.
2. Only then perform the move; the same tests stay green, which is the parity proof.
3. If open_choices #1 is resolved as "apply the steward precedence fix", it needs its OWN red test: a steward-followup fixture where `task.file_line_counts[path] !== coverage total_lines`, asserting the coverage value at HEAD and the task value after — the fix is exactly what flips it.
4. The compiler is the completeness proof for call-site migration: delete the twins as a separate step (plan §4 step 4) so any missed call site is a `check` error.

### Open choices (7)

- #1 THE BIG ONE — does the stewardFollowup precedence fix (§2.3) ship at all, and if so in this commit or its own? HEAD deliberately or accidentally reads coverage-before-task there; nothing in the code or tests records which. The plan decides 'yes, fix it' and asks only for sign-off on the diff. Recommend: land the move behavior-preserving, then the precedence change separately with its own red test, so a bisect can separate a move regression from a semantic one. Owner call.

- #2 Whether `lineIndex` is threaded into lensVerificationTriggers and selectLensVerificationFiles at all. The plan says yes and calls it neutral; it is not neutral (behavior_changes #2/#3) and it can change whether a lens-steward task is created. Recommend: no. If yes, it is a third separate commit with its own test.

- #3 Whether the WeakMap memoization ships in the same commit as the move. It is the plan's stated 'real defect' but it is an optimization with a staleness window (behavior_changes #6), and there is no benchmark and no test that would catch staleness. Splitting move-then-memoize costs one commit and makes both bisectable.

- #4 Is the append-only-at-ingestion premise behind the WeakMap actually true? The plan asserts it without citing the ingestion code. Someone must read src/audit/orchestrator/resultIngestion.ts and src/audit/coverage.ts (applyFileCoverage) and confirm no result object is mutated after a deepening pass has read it. Until that is checked, the memoization is unproven.

- #5 Module name and placement: `src/audit/orchestrator/lineCounts.ts`. The plan's rejection of src/shared/paths.ts and of both twin modules is sound, but the sibling-leaf choice is still a naming call, and the file lands inside loop-core by placement alone. An alternative — `src/audit/orchestrator/lineCounts.ts` vs a `src/audit/orchestrator/planning/` subdir — was not considered.

- #6 Whether the stale catalog citations in docs/reviews/duplication-and-complexity-catalog-2026-09-05.md (lines 161-162 pointing at reviewPacketShared.ts:27 and shared.ts:96, and line 241 proposing src/shared/paths.ts as the destination) get corrected in this commit. That file is UNTRACKED at HEAD, so check:doc-code-citations does not see it and no gate forces the issue — it is a judgment call, and line 241 in particular now contradicts the plan's own accepted decision.

- #7 Whether reviewPackets.ts:103 keeps its `owner ? … : 0` ternary or collapses to `lineCountForPath(path, { task: owner, lineIndex })`. Collapsing is equivalent ONLY because a missing owner falls through to lineIndex — which is a BEHAVIOR CHANGE (HEAD returns a hard 0 for an unowned path even when lineIndex has it). minimal_change keeps the ternary; the plan's §2.2 row 1 collapses it without flagging the difference. Someone must decide which is wanted.

### Against what already landed

NO CONFLICT with any of the six landed commits. Verified by reading each touched file at HEAD:
- item 3.5 (isValidGraphEdge in src/audit/extractors/graphSignals.ts) — different subtree, no shared symbol.
- item 3.1 (manifestStringArray in graphManifestEdges/workspace.ts; tomlStringArray/yamlStringArray deleted) — different subtree. It is however the closest PRECEDENT: same "extract a shared helper into a sibling leaf, delete both copies, repoint call sites, no shim" shape. Follow its landed structure.
- item 3.4 (buildTokenIndex in commentDecomposition.ts) — different subtree; also precedent for the memoized-index idea.
- item 2.5 (scripts/shared/tsAstHelpers.mjs) — scripts tree only.
- GRAPH_EDGE_CACHE_KEY_VERSION v4→v5 (src/audit/extractors/graph.ts) — unrelated; this refactor changes no persisted artifact shape, so NO further cache-key bump is required.
- check:control-bytes → preCommit 'always' — only means the control-bytes gate now runs on every commit; write LF-only ASCII (no smart quotes, no stray control bytes) in the new file.

Nothing in the landed set already does any part of item 4.1: both twins are fully intact at HEAD and lineCounts.ts does not exist.

LINE NUMBERS in the plan are still accurate at HEAD for every file it names (spot-checked reviewPacketShared.ts:27, shared.ts:87/96/145, reviewPackets.ts:103, reviewPacketMetrics.ts:40, conflict.ts:54, highRiskClean.ts:65, findingFollowup.ts:41, lensVerification.ts:87/228/336, runtimeValidation.ts:75, stewardFollowup.ts:88) — the landed commits did not move this code. Still locate by name.

---

## hotspot-2-contractPipelineGates (decompose validateImplementationDAGIntegrity + validateEvidenceThreaded)

**Premise holds:** yes  
**Loop-core:** no

PLAN LOCATION: the task gave `docs/reviews/refactor-plan-hotspot-contract-pipeline-gates-2026-09-05.md` under `docs/reviews/refactor-plans/`; that subdirectory does not exist. The file read is `C:\Code\audit-tools\docs\reviews\refactor-plan-hotspot-contract-pipeline-gates-2026-09-05.md` (untracked).

PREMISE HOLDS at HEAD (4c88bf1f). `src/remediate/validation/contractPipelineGates.ts` is 1928 lines (plan says 1,929 — trivial drift). `validateImplementationDAGIntegrity` spans lines 312-443 (~132 lines, plan "~140"); `validateEvidenceThreaded` spans 653-741 (~89 lines, plan "~92"). Both still have exactly the phase structure the plan describes:
- DAG gate: guard `canEvaluateImplementationDagIntegrity` → build `obligationIds` / `counterexampleIds` / `acceptedCounterexampleIds` → one `for (const [i, node] of nodes.entries())` loop with branches 1a `satisfies_obligations`, 1b `verification_obligation_ids`, 1c `addresses_counterexamples` → two post-loop sweeps emitting path `implementation_dag.coverage`.
- Evidence gate: no top-level guard; three independently self-guarded checks (violated-findings evidence; accepted-CE threading, fail-closed when accepted set non-empty and DAG absent; blank description on obligation-satisfying nodes). `canEvaluateEvidenceThreaded` is used ONLY in `gateOutcome(...)` inside `evaluateContractPipelineCrossGateOutcomes` — plan §1.5(3) is correct.
- Item 2.3 has NOT landed: `collectUnwaivedAcceptedCounterexampleIds` appears nowhere in source, only in the two plan docs. So Step 0 is live work.

WHERE THE PLAN AND SOURCE DISAGREE (source wins):
1. §1.2 Boundary A calls the two accepted-set blocks "character-for-character identical". They are NOT character-identical — the executable code is identical, the comments differ. DAG copy (lines 340-355):
```
  const acceptedCounterexampleIds = new Set<string>();
  if (isRecord(judgeReportPayload) && Array.isArray(judgeReportPayload.classifications)) {
    for (const cls of judgeReportPayload.classifications as unknown[]) {
      if (
        isRecord(cls) &&
        cls.classification === "accepted" &&
        typeof cls.counterexample_id === "string" &&
        cls.counterexample_id.length > 0 &&
        // A waived counterexample is resolved by a recorded owner decision —
        // coverage must not be demanded for it (open-bugs.md:108).
        !waivedCounterexampleIds?.has(cls.counterexample_id)
      ) {
```
Evidence copy (lines 682-697) carries the rationale ABOVE the block instead:
```
  // 2. accepted counterexamples must be threaded into the DAG. A waived
  // counterexample is resolved by a recorded owner decision and is not
  // demanded here (open-bugs.md:108).
  const acceptedCounterexampleIds = new Set<string>();
  ...
        cls.counterexample_id.length > 0 &&
        !waivedCounterexampleIds?.has(cls.counterexample_id)
      ) {
```
Consequence for the implementer: the extracted helper must carry the open-bugs.md:108 rationale in its JSDoc; both comment forms are deleted at the call sites.

2. §4 step 4 says the `else if (Array.isArray(node.satisfies_obligations))` / `else if (Array.isArray(node.verification_obligation_ids))` absent-ledger branches "are the OBS-cca3801c-2 behavior" and must not be dropped. Read at HEAD they are provably OUTPUT-DEAD: they run only when `obligationIds.size === 0`, and the only reader of `coveredObligationIds` is the sweep guarded by `if (obligationIds.size > 0)`. They accumulate into a set that is never read on that branch. Preserving them verbatim is still the safe move (this is a pure-motion refactor), but the plan's justification for them is wrong and no test can distinguish their presence.

3. §1.4's catalog correction is CORRECT and verified: `validateImplementationDAGIntegrity` contains no cycle logic. The only `findCyclicComponents` call in the file is line 244, inside `validateDesignSpecGates`. There is no `validateCycleWitnesses` symbol anywhere in `src`.

4. §5.4 commands: `npm run typecheck` DOES NOT EXIST in package.json. The scripts are `npm run check` (tsc -p tsconfig.json --noEmit) and `npm run check:tests` (tsconfig.test.json). Use those.

5. §2.3's "known gap" is confirmed: `grep -rn "waived" tests/remediate/*.ts` hits only `tests/remediate/contract-pipeline-adversarial.test.ts` (repair-state waiver records). No test passes `waivedCounterexampleIds` to either gate.

### Files to change

- `src/remediate/validation/contractPipelineGates.ts`
- `tests/remediate/validation.test.ts`
- `tests/remediate/contract-obligations-and-gates.test.ts`
- `docs/reviews/duplication-and-complexity-catalog-2026-09-05.md`

### Symbol checks

| Symbol | File | Found | Note |
|---|---|---|---|
| `validateImplementationDAGIntegrity` | `src/remediate/validation/contractPipelineGates.ts` | yes | Exported, line 312. Signature matches plan exactly: (dagPayload, obligationLedgerPayload, counterexamplePayload, judgeReportPayload, waivedCounterexampleIds?: ReadonlySet<string>) => ValidationIssue[]. Body ends line 443. |
| `validateEvidenceThreaded` | `src/remediate/validation/contractPipelineGates.ts` | yes | Exported, line 653. Signature matches: (assessmentReportPayload, judgeReportPayload, dagPayload, waivedCounterexampleIds?: ReadonlySet<string>) => ValidationIssue[]. Body ends line 741. No top-level guard, as the plan states. |
| `collectUnwaivedAcceptedCounterexampleIds` | `src/remediate/validation/contractPipelineGates.ts` | **NO** | Item 2.3 has NOT landed. Symbol exists only in the two plan documents. Step 0 of this plan is real, unskippable work. |
| `validateDAGReferentialIntegrity` | `src/remediate/validation/contractPipelineGates.ts` | **NO** | New symbol proposed by the plan (§3.2). Correctly absent. |
| `validateDAGCouvertureGaps` | `src/remediate/validation/contractPipelineGates.ts` | **NO** | New symbol proposed by the plan (§3.3). Correctly absent. Name is left open by the plan itself. |
| `validateViolatedFindingsEvidence / validateCounterexampleThreading / validateSatisfyingNodeDescriptions` | `src/remediate/validation/contractPipelineGates.ts` | **NO** | New symbols proposed by the plan (§3.5). Correctly absent. |
| `validateCycleWitnesses` | `(catalog proposal)` | **NO** | PLAN CONFIRMS AS CATALOG ERROR, and the source agrees: no cycle detection exists in validateImplementationDAGIntegrity. Cycle logic is findCyclicComponents at line 244 inside validateDesignSpecGates. Do not implement it. |
| `validateContractPipeline` | `(prompt/catalog)` | **NO** | Not a symbol anywhere in src. The plan already flags this; the real aggregator is evaluateContractPipelineCrossGateOutcomes. |
| `escapeRegExp` | `src/remediate/validation/contractPipelineGates.ts` | yes | Line 962, module-private. The plan's anchor for helper placement is intact. |
| `pushValidationIssue` | `src/shared/validation/basic.ts` | yes | Line 31, alongside createValidationIssue (line 23). Imported into contractPipelineGates.ts from "audit-tools/shared". NOT edited by this plan. |
| `canEvaluateImplementationDagIntegrity` | `src/remediate/validation/contractPipelineGates.ts` | yes | Line 1689, module-private, called as the DAG gate's early return. |
| `canEvaluateEvidenceThreaded` | `src/remediate/validation/contractPipelineGates.ts` | yes | Line 1643. Used ONLY for GateOutcome classification inside evaluateContractPipelineCrossGateOutcomes, never as an early return. Plan invariant §1.5(3) verified. |
| `evaluateContractPipelineCrossGateOutcomes` | `src/remediate/validation/contractPipelineGates.ts` | yes | Exported async, near line 1840. Wires inputs.waivedCounterexampleIds positionally into both gates exactly as the plan describes. |
| `validateArtifacts` | `src/remediate/validation/artifacts.ts` | yes | Line 435; calls evaluateContractPipelineCrossGateOutcomes at line 552 (imported line 38). Plan §2.2 caller claim holds. |
| `acceptedCounterexampleIds (derive)` | `src/remediate/contractPipeline/derive.ts` | yes | Exported at line 431, returns string[]. derive.ts imports isTestablePhaseObligation from ../validation/contractPipelineGates.js at line 39, so the plan's module-cycle argument for keeping the helper intra-file is CORRECT. Out of scope. |
| `acceptedCeIdsOf` | `src/remediate/steps/contractPipeline.ts` | yes | Line 890, plus a third inline accepted-set at line 1153. Third/fourth copies; out of scope per plan §2.4. |
| `barrel re-export` | `src/remediate/validation/contractPipeline.ts` | yes | Re-exports validateImplementationDAGIntegrity (line 335) and validateEvidenceThreaded (line 337). Untouched by the plan. |
| `isLoopCorePath / LOOP_CORE_PATTERNS` | `src/shared/loopCorePaths.ts` | yes | 12 patterns. None matches src/remediate/validation/**. |

### Plan errors (8)

- Plan path: the task cites docs/reviews/refactor-plans/…; that directory does not exist. The plan lives at docs/reviews/refactor-plan-hotspot-contract-pipeline-gates-2026-09-05.md.

- §5.4 and §4 step 6 call `npm run typecheck`. NO SUCH SCRIPT exists in package.json. Use `npm run check` (tsc --noEmit) and `npm run check:tests`.

- §1.2 Boundary A: the two accepted-set blocks are NOT 'character-for-character identical'. The executable code is identical; the DAG copy carries a two-line open-bugs.md:108 comment INSIDE the conjunct list, the evidence copy carries a three-line comment ABOVE the block. Both are quoted in premise_notes.

- §4 step 4's justification for the `else if` absent-ledger branches ('they are the OBS-cca3801c-2 behavior') is wrong: those branches fill `coveredObligationIds` only when `obligationIds.size === 0`, and the only reader of that set is guarded by `obligationIds.size > 0`. They cannot affect output.

- INTERNAL CONTRADICTION: §5.2's final paragraph asks for helper-level unit tests of `validateDAGCouvertureGaps` and `validateCounterexampleThreading`, while §2.4 and §3.7 forbid adding, removing, or modifying any `export` line and §5.3 says to verify no `export` hunk appears in the diff. Module-private helpers cannot be unit-tested from tests/. One of the two constraints must give.

- §4 step 3 ('add the helpers as their own step; the file must compile with unused-function allowance') is not viable here: eslint.config.js sets `@typescript-eslint/no-unused-vars` to `error` for all vars/args (only `^_` prefixed are exempt), and the global PostToolUse hook runs tsc+eslint on TS edits. An intermediate state with unused private helpers is a red lint. Fold steps 3+4 (and 5) into one edit/commit, which the plan already offers as the alternative.

- Minor: plan states the file is 1,929 lines; HEAD is 1928. Function spans are ~132 and ~89 lines vs the plan's ~140 and ~92. Neither changes the analysis.

- Not an error but a live prerequisite the plan's §4 step 2 lets you skip conditionally: Item 2.3 has NOT landed. `collectUnwaivedAcceptedCounterexampleIds` does not exist. Step 0 must be executed.

### Behavior changes (5)

- NONE INTENDED — the plan is a pure code motion: same predicates, same emission order (1a→1b→1c→2a→2b; evidence 1→2→3), same path/message/severity strings, identical exported signatures. Under strict reading, no input produces a different return value.

- Latent-but-not-actual: `validateCounterexampleThreading` takes the already-built accepted SET instead of `(judgeReportPayload, waivedCounterexampleIds)`. Observably identical only because the orchestrator builds the set with the same helper the DAG gate uses. It DOES move waiver semantics to a single site — a behavior consolidation, not a behavior change, but it is the one place where a mistake becomes a silent semantic change (and nothing tests it today).

- Cosmetic-only diff: the guard's `return issues` at line 320 becomes `return []` once the local `issues` accumulator is removed from the DAG orchestrator. Same value (a fresh empty array) for the same input.

- Doc change, not code: the catalog's Hotspot #2 Phase 2 bullet is rewritten to drop `validateCycleWitnesses`.

- NOT a behavior change but worth stating: the two output-dead `else if` branches are preserved verbatim. If an implementer 'simplifies' them away as dead code, that is still output-equivalent today, but it silently discards the OBS-cca3801c-2 intent the plan attributes to them. Keep them; do not repeat the plan's justification.

### Minimal change

ONE source file plus two test files. Do it as a single commit (see red_green_plan for why splitting reds the lint hook).

STEP 0 (Item 2.3, not yet landed). Add module-private helper immediately above `escapeRegExp` (line 962) in src/remediate/validation/contractPipelineGates.ts:
```ts
/** Judge-accepted counterexample ids minus those covered by a recorded owner
 *  waiver (open-bugs.md:108) — a waived CE is resolved by decision, so no gate
 *  may demand coverage for it. Defensive over `unknown`: never throws. */
function collectUnwaivedAcceptedCounterexampleIds(
  judgeReportPayload: unknown,
  waivedCounterexampleIds?: ReadonlySet<string>,
): Set<string> { /* the existing 14-line block, verbatim */ }
```
Replace the block at lines 340-355 (inside validateImplementationDAGIntegrity) and the block at lines 685-697 (inside validateEvidenceThreaded), keeping the local name `acceptedCounterexampleIds` so no downstream reference moves. Delete both now-redundant comment forms from the call sites; the rationale lives in the helper JSDoc. Do NOT name the helper `acceptedCounterexampleIds` (collides conceptually with the derive.ts export).

STEP 1 (Boundary B). Add, in the private-helper region:
```ts
interface DAGReferentialResult {
  issues: ValidationIssue[];
  coveredObligationIds: Set<string>;
  coveredCounterexampleIds: Set<string>;
}
function validateDAGReferentialIntegrity(
  nodes: unknown[],
  obligationIds: ReadonlySet<string>,
  counterexampleIds: ReadonlySet<string>,
  acceptedCounterexampleIds: ReadonlySet<string>,
): DAGReferentialResult
```
Move lines 360-419 (the whole `for (const [i, node] of nodes.entries())` loop) verbatim, including both `else if` absent-ledger branches (keep them: pure motion, even though they are output-dead — see premise_notes item 2) and the `Node "${node.id}"` interpolations.
```ts
function validateDAGCouvertureGaps(
  obligationIds: ReadonlySet<string>,
  acceptedCounterexampleIds: ReadonlySet<string>,
  coveredObligationIds: ReadonlySet<string>,
  coveredCounterexampleIds: ReadonlySet<string>,
): ValidationIssue[]
```
Move lines 421-441 (both `implementation_dag.coverage` sweeps) verbatim, in order 2a then 2b.

STEP 2. Reduce `validateImplementationDAGIntegrity` to: guard → build `obligationIds` (lines 322-330 unchanged) → build `counterexampleIds` (331-338 unchanged) → helper call for the accepted set → `const nodes = dagPayload.nodes as unknown[];` → `const ref = validateDAGReferentialIntegrity(nodes, obligationIds, counterexampleIds, acceptedCounterexampleIds);` → `const gaps = validateDAGCouvertureGaps(obligationIds, acceptedCounterexampleIds, ref.coveredObligationIds, ref.coveredCounterexampleIds);` → `return [...ref.issues, ...gaps];`. Drop the now-unused local `const issues: ValidationIssue[] = []` from the top BUT keep the guard returning `[]` (currently `return issues` at line 320 — change it to `return []`).

STEP 3 (Boundary C). Add three private helpers, each a verbatim move:
- `validateViolatedFindingsEvidence(assessmentReportPayload: unknown): ValidationIssue[]` — lines 661-678.
- `validateCounterexampleThreading(acceptedCounterexampleIds: ReadonlySet<string>, dagPayload: unknown): ValidationIssue[]` — lines 699-720. It takes the already-built set, not the judge payload; the `if (acceptedCounterexampleIds.size > 0)` wrapper moves with it, preserving fail-closed-on-missing-DAG (non-empty set + absent nodes => `nodes = []` => issues).
- `validateSatisfyingNodeDescriptions(dagPayload: unknown): ValidationIssue[]` — lines 722-740.
Reduce `validateEvidenceThreaded` to: helper call for the accepted set, then `return [ ...validateViolatedFindingsEvidence(assessmentReportPayload), ...validateCounterexampleThreading(acceptedCounterexampleIds, dagPayload), ...validateSatisfyingNodeDescriptions(dagPayload) ];` — no top-level guard introduced, order 1→2→3 preserved.

STEP 4. Tests: add the five waiver/parity cases (plan §5.2 items 1-5) plus the helper-level set-diff cases. Because the helpers are module-private and no `export` line may be added, the helper-level unit tests of §5.2's last paragraph CANNOT be written without exporting them — see open_choices.

STEP 5. Correct the Hotspot #2 Phase 2 bullet in docs/reviews/duplication-and-complexity-catalog-2026-09-05.md per plan §1.4 (drop validateCycleWitnesses).

Verify with: `npx vitest run tests/remediate/validation.test.ts tests/remediate/contract-obligations-and-gates.test.ts tests/remediate/contract-pipeline-derive-obligations.test.ts`, then `npm run build && npm run check` and `npm run check:tests` (NOT `npm run typecheck` — no such script), then `npx eslint` on the three touched files.

### Red-green plan

EXISTING COVERAGE IS REAL for the motion itself, and the plan's counts are accurate at HEAD:
- `tests/remediate/validation.test.ts`, `describe("validateImplementationDAGIntegrity")` at line 1016 — exactly 12 `it(...)` cases, matching the plan's enumeration (valid DAG; empty DAG; ghost satisfies_obligations; ghost verification_obligation_ids; ghost addresses_counterexamples; obligation not covered; accepted CE not addressed; ledger absent; counterexample artifact absent; verification_obligation_ids counts toward coverage; non-record DAG => []; non-accepted classification).
- `tests/remediate/contract-obligations-and-gates.test.ts`, `describe("validateEvidenceThreaded")` — exactly 5 cases (violated-without-evidence; unthreaded accepted CE; threaded CE passes; fail-closed missing DAG; empty description).
These 17 cases passing UNMODIFIED is the behavioural-equivalence proof.

SINGLE MUTATION THAT REDS THE FIXED CODE: in `validateDAGCouvertureGaps`, invert the obligation sweep's membership test — `if (!coveredObligationIds.has(oblId))` → `if (coveredObligationIds.has(oblId))`. That reds at minimum "returns no errors for a fully valid DAG", "errors when an obligation is not covered by any node (bidirectional coverage)", and "counts verification_obligation_ids toward coverage". For Boundary C the equivalent single mutation is deleting the `validateCounterexampleThreading(...)` spread from the orchestrator, which reds "flags an accepted counterexample not threaded into any DAG node" and "is fail-closed: accepted counterexamples but a missing DAG => violation".

COVERAGE GAPS — findings, not obstacles:
1. `waivedCounterexampleIds` is UNTESTED on both gates. Confirmed by grep: no test in tests/remediate/ passes it to either gate. So today, deleting the `!waivedCounterexampleIds?.has(...)` conjunct from either copy is a SILENT green — the extraction into one helper is therefore an unguarded consolidation until plan §5.2 cases 1-5 land. Land those cases in the SAME commit and prove them red by commenting out that conjunct in the new helper.
2. The two `else if` absent-ledger branches (lines 375-379 and 397-401) are unreachable-in-effect (see premise_notes item 2). NO mutation to them can red any test, because the set they fill is only read when `obligationIds.size > 0`, which is exactly when they do not run. Do not treat their preservation as test-covered.
3. Helper-level unit tests for `validateDAGCouvertureGaps` / `validateCounterexampleThreading` (plan §5.2 final paragraph) cannot be written against module-private symbols; the plan simultaneously forbids adding any `export` line (§2.4, §3.7). This is an internal contradiction in the plan — see open_choices.

### Open choices (8)

- Helper name for the coverage sweep: the plan offers `validateDAGCouvertureGaps` (a French/English hybrid, deliberately avoiding the overloaded `Coverage` name that collides with the local `Coverage` interface in validatePairedObligations) or `validateDAGBidirectionalCoverage` / `findUncoveredObligationsAndCounterexamples`. Human pick.

- Helper name for Item 2.3: `collectUnwaivedAcceptedCounterexampleIds` vs `acceptedCounterexampleIdsOf` vs `unwaivedAcceptedIds`. The only hard constraint is that it must NOT be `acceptedCounterexampleIds`.

- Whether Item 2.3 lands as its own commit first or as Step 0 of this diff. It has not landed, so this is a real fork. (Note the atomic-replace invariant and the lint constraint above both push toward ONE commit.)

- The §5.2-final helper-level unit tests vs the no-new-`export` rule (see plan_errors). Options: (a) drop the helper-level tests and rely on the 17 gate-level cases; (b) export the two set-taking helpers — which changes the `check:deadcode` picture and breaks the plan's own 'no export hunk' acceptance check; (c) test them indirectly through the gates only. Owner call.

- Whether the five §5.2 waiver/parity cases are attributed to Item 2.3 or to this hotspot diff — they must land somewhere, and today nothing tests waivers on either gate.

- Whether to keep the two output-dead `else if` absent-ledger branches (recommended: keep, pure motion) or delete them as verified dead code in a separate, separately-justified diff.

- Whether the catalog correction (docs/reviews/duplication-and-complexity-catalog-2026-09-05.md, Hotspot #2 Phase 2 bullet) rides in this commit or is filed separately. Note that file is currently UNTRACKED per git status.

- Whether to also file the third/fourth accepted-set copies (`acceptedCeIdsOf` at src/remediate/steps/contractPipeline.ts:890 and the inline Set at :1153, plus `acceptedCounterexampleIds` at src/remediate/contractPipeline/derive.ts:431) as a follow-up cross-module item, as plan §2.4 defers. NOTE: src/remediate/steps/contractPipeline.ts IS loop-core, so that follow-up would require a review attestation; this diff does not.

### Against what already landed

No conflict and no overlap. `git log --oneline -- src/remediate/validation/contractPipelineGates.ts` shows the file's last touch was f3962a8b (judge escalation / owner waivers), well before the six commits named in the task. The landed work is entirely in `src/audit/extractors/**` (graphSignals.ts isValidGraphEdge, graphManifestEdges/workspace.ts manifestStringArray, commentDecomposition.ts buildTokenIndex, graph.ts cache-key v5), `scripts/shared/tsAstHelpers.mjs` + generate-spec-mirrors.mjs, and `scripts/guard-reach-data.mjs`. None of them touches contractPipelineGates.ts, the remediate validation tree, or the two test files. Nothing in them already does any part of this plan. Two indirect notes: (a) this plan adds no new tracked file and no new hook or check script, so `scripts/guard-reach-data.mjs` / `npm run check:guard-reach` need no registry row; (b) the `check:control-bytes` flip to preCommit 'always' means any 0x1A/control byte a lane injects into the new JSDoc or test strings will now red the commit rather than only release CI — write plain ASCII arrows in new comments.

---

## hotspot-7 (decompose ingestRemediationHostResults in src/remediate/steps/dispatch/hostHandoff.ts)

**Premise holds:** yes  
**Loop-core:** yes — commit needs a review attestation

PREMISE HOLDS, and is a complexity premise, not a duplication one — there is no twin body to compare, so the "if two bodies differ, quote both" test does not apply here.

Measured at HEAD:
- src/remediate/steps/dispatch/hostHandoff.ts is 2740 lines (plan: 2740). Exact match.
- ingestRemediationHostResults spans lines 2366-2740 = 375 lines (plan: "~375 lines", and it explicitly corrects the catalog's "500 lines"). Exact match; the plan's correction of the catalog is right.
- The three interleaved jobs the plan names are all present in one body with the shared mutable locals it names: issues, completed, resultIds, landedFiles, recordedRecoveryMarks, nextState. Verified by reading lines 2366-2740.
- Phase-1 order claimed by §3.2 matches source exactly: readSubmissionDocument gate (workload_missing/workload_invalid, guarded by `if (state.host_handoff)`) -> `issues.push(...planBlockIssues(paths.root, state))` -> git-backed `trusted_binding_missing` gate -> parseWorkload -> accumulated `workload_invalid` -> effectiveBoundWorkload -> eligibleIds from hostDependencyLevels(state)[0] -> canCorroborate.
- canCorroborate expression matches the plan verbatim: `state.host_handoff !== undefined || (await isGitRepo(paths.root))` (line ~2493).
- The plan's claim that no issue-classified gate throws inside the ingest is TRUE: the one throwing helper (assertBlockContract via buildWorkItem) is wrapped in try/catch inside parseWorkItem (lines 1167-1176), and the ledger append is wrapped in try/catch that converts to a `recovery_unrecorded` refusal.

WHERE PLAN AND SOURCE DISAGREE (source wins, all reported below in plan_errors):
1. §3.2 says validateHostResultBundle returns a finished summary "for the two whole-ingest early exits". There are THREE: workload read failure, trusted_binding_missing, and `!workload` (parseWorkload null). Miscount.
2. §2.1/§2.2 say `src/remediate/index.ts` "Re-exports recoverIngestHostResults only". It does not re-export it — it IMPORTS it from ./steps/nextStep.js (line 5) and CALLS it (line 284), and separately imports remediationSubmissionBinding + type RemediationHostIngestSummary from hostHandoff.js (lines 36-39). The "impact: none" verdict still holds.
3. §2.2 names a caller `src/remediate/steps/nextStep.ts -> execute (dispatch routing)`. No such caller exists. `execute` in nextStep.ts is an obligation-registry PROPERTY name (lines 4045, 4071, 4116, ...), not a function that calls the ingest. The graph's "4 callers" is inflated: there are exactly TWO real call sites, both in nextStep.ts (line 1064 in recoverIngestHostResults, line 1096 in buildImplementDispatchStep).
4. §1.2's accumulator annotation `landedFiles ... // accepted edit surface (Phase 3 only)` CONTRADICTS §3.3 and contradicts source. `landedFiles` is initialized from nextState.applied_edit_surface (line 2488), is READ inside the decision branch's excusedPaths set (line ~2558), and is WRITTEN by the landed branch (line ~2707) — all inside the Phase-2 loop. It is a Phase-2 accumulator with intra-loop feedback. Following §1.2 literally is a behavior change (see behavior_changes).
5. §3.4 omits `delete item.host_result_evidence` from the landed acceptance (source line ~2705); it lists only status/timestamps/landedFiles.
6. §5.2 mixes issue CODES with ingestion CHECK ids (`result_envelope`, `identity_binding`, `write_scope`, `commit_evidence`, `test_evidence`, `obligation_evidence`, `worktree_evidence`, `landing_attestation`, `outcome_shape`, `no_change_corroboration` are check ids from src/shared/submission/ingestionChecks.ts, not members of REMEDIATION_ISSUE_CODES). Every name it uses is real; the taxonomy label is loose.
7. §2.1 says "No export-list change except the three new functions if tests need them". Exporting them is NOT free — see conflicts_with_landed (DISPATCH_BARREL_EXPORTS is an exact-equality pin).

### Files to change

- `src/remediate/steps/dispatch/hostHandoff.ts`

### Symbol checks

| Symbol | File | Found | Note |
|---|---|---|---|
| `ingestRemediationHostResults` | `src/remediate/steps/dispatch/hostHandoff.ts` | yes | Exported async function at line 2366, body ends 2740 (375 lines). Signature matches plan: { root, artifactsDir, runId, state: unknown, recovery?: { requiredTestVerdicts } } -> Promise<RemediationHostIngestSummary \| UnsupportedRetiredRemediationState>. |
| `parseResult` | `src/remediate/steps/dispatch/hostHandoff.ts` | yes | Line 1255. Shape CHANGED since the plan's baseline by commit 041f7b6d: the failure arm is now { ok: false, check: IngestionCheckId, reason } and invalidResult takes (check, reason). The plan does not depend on the old shape. |
| `ParsedHostResult` | `src/remediate/steps/dispatch/hostHandoff.ts` | yes | Type alias at line 1220; failure arm carries the new `check: IngestionCheckId` field. |
| `AcceptedHostResult` | `src/remediate/steps/dispatch/hostHandoff.ts` | yes | Line 1239, Extract<ParsedHostResult, { ok: true }>. Matches plan's description of the landed\|decision union. |
| `corroborateHostResult` | `src/remediate/steps/dispatch/hostHandoff.ts` | yes | Line 2123. Params { root, state, workItem, result, verdicts, recovery }. Called with the UNMUTATED `state`, not nextState — important for the phase split. |
| `CorroboratedHostResult` | `src/remediate/steps/dispatch/hostHandoff.ts` | yes | Line 1531. Carries ok/code/check/message and, on success, changedFiles + usedRecovery. |
| `corroborateNoChangeClaim` | `src/remediate/steps/dispatch/hostHandoff.ts` | yes | Line 1725. Takes { root, workItem, excusedPaths } — excusedPaths is built from state.run_start_dirty PLUS the live landedFiles set. |
| `rerunRequiredTests` | `src/remediate/steps/dispatch/hostHandoff.ts` | yes | Line 2013, file-local. Called on the no-change path directly and inside corroborateHostResult on the landed path. |
| `runRequiredTest` | `src/remediate/steps/dispatch/hostHandoff.ts` | yes | Line 1923, EXPORTED and pinned in tests/helpers/dispatchBarrelBaseline.ts. |
| `precomputeRecoveryTestVerdicts` | `src/remediate/steps/dispatch/hostHandoff.ts` | yes | Line 2081, exported and pinned in the barrel baseline. Not modified by the plan. |
| `parseWorkload` | `src/remediate/steps/dispatch/hostHandoff.ts` | yes | Line 1183, returns RemediationHostWorkload \| null. Never throws. |
| `parseWorkItem` | `src/remediate/steps/dispatch/hostHandoff.ts` | yes | Line 1124. Catches the buildWorkItem/assertBlockContract throw and returns null. |
| `planBlockIssues` | `src/remediate/steps/dispatch/hostHandoff.ts` | yes | Line 614. Advisory only; its output is spread into `issues` before the binding gate. |
| `effectiveBoundWorkload` | `src/remediate/steps/dispatch/hostHandoff.ts` | yes | Line 457. Called once, immediately after parseWorkload succeeds. |
| `hostDependencyLevels` | `src/remediate/steps/dispatch/hostHandoff.ts` | yes | Line 820, exported and barrel-pinned. Only level [0] is consumed by the ingest. |
| `migrateLegacyDirectoryScopesAfterFinalDrain` | `src/remediate/steps/dispatch/hostHandoff.ts` | yes | Line 477. Runs post-loop, guarded by `nextState.host_handoff && pendingWorkItemIds.length === 0`. |
| `gitCommitExists` | `src/remediate/steps/dispatch/hostHandoff.ts` | yes | Line 1553. Not called from the ingest body directly — reached via corroborateHostResult. |
| `gitCommitIsAncestor` | `src/remediate/steps/dispatch/hostHandoff.ts` | yes | Line 1564. |
| `gitCommitIsOrphaned` | `src/remediate/steps/dispatch/hostHandoff.ts` | yes | Line 1593. |
| `gitChangedFilesOfCommit` | `src/remediate/steps/dispatch/hostHandoff.ts` | yes | Line 1606. |
| `gitChangedFilesSince` | `src/remediate/steps/dispatch/hostHandoff.ts` | yes | Line 1660. Used by corroborateNoChangeClaim, not by the ingest body. |
| `resolveBoundaryPaths` | `src/remediate/steps/dispatch/hostHandoff.ts` | yes | Line 679, returns BoundaryPaths { root, artifactsDir, workloadPath, resultDir }. NOTE: root/artifactsDir are RESOLVED values, not params.root/params.artifactsDir — the plan's HostIngestContext should carry `paths: BoundaryPaths` rather than re-flattening root/artifactsDir, and it needs workloadPath too. |
| `parseCurrentState` | `src/remediate/steps/dispatch/hostHandoff.ts` | yes | Line 290. First statement of the orchestrator; returns null -> "unsupported_retired_state". |
| `requiredTestIssue` | `src/remediate/steps/dispatch/hostHandoff.ts` | yes | Line 2051. Used on the no-change path in the ingest body. |
| `remediationScanMessages` | `src/remediate/steps/dispatch/hostHandoff.ts` | yes | Present (2 refs). Passed as `messages` to scanBoundSubmission. |
| `scanBoundSubmission` | `src/shared/submission/` | yes | Shared core, consumed not modified. 8 refs across src/. |
| `RemediationHostResult` | `src/remediate/steps/dispatch/hostHandoff.ts` | yes | Private interface at line 200. Plan reuses it in HostItemVerdict — fine, it is file-local and the verdict types would be too. |
| `RemediationHostDecision` | `src/remediate/steps/dispatch/hostHandoff.ts` | yes | Private interface at line 235. |
| `RemediationRequiredTestVerdicts` | `src/remediate/steps/dispatch/hostHandoff.ts` | yes | Exported type at line 1808 (ReadonlyMap). |
| `RemediationHostIngestSummary` | `src/remediate/steps/dispatch/hostHandoff.ts` | yes | Exported interface at line 184. |
| `RemediationHostIngestIssue` | `src/remediate/steps/dispatch/hostHandoff.ts` | yes | Line 182 = SubmissionIssue<RemediationIssueCode>. REMEDIATION_ISSUE_CODES (line 126) SPREADS SUBMISSION_ISSUE_CODES, which is why `submission_contract_invalid` typechecks. |
| `StateStore` | `src/remediate/state/store.ts` | yes | Exists; used by nextStep.ts (store.mutate at line 1038, store.saveState in buildImplementDispatchStep). Plan correctly proposes no change here. |
| `prepareRemediationHostHandoff` | `src/remediate/steps/dispatch/hostHandoff.ts` | yes | Line 2234. Explicit non-change. |
| `remediationSubmissionBinding` | `src/remediate/steps/dispatch/hostHandoff.ts` | yes | Line 730. Explicit non-change. |
| `RemediationStore` | `(none)` | **NO** | Zero hits in src/. The plan itself flags this as a stub-name that does not exist and correctly declines to introduce it. Not a plan error. |
| `HostExecutionResult` | `(none)` | **NO** | Zero hits in src/. Same: the plan flags it as non-existent and does not adopt it. |
| `validateHostResultBundle` | `(proposed)` | **NO** | Zero hits. NEW name proposed by the plan (adopted from the catalog). Intentional. |
| `executeHostVerificationReruns` | `(proposed)` | **NO** | Zero hits. NEW name proposed by the plan. Intentional. |
| `commitRemediationStateUpdates` | `(proposed)` | **NO** | Zero hits. NEW name proposed by the plan. Intentional. |
| `HostIngestContext / HostItemVerdict / HostIngestAccumulators` | `(proposed)` | **NO** | Zero hits. NEW file-local types proposed by the plan. Intentional. |
| `nextStep.ts -> execute (claimed caller)` | `src/remediate/steps/nextStep.ts` | **NO** | PLAN ERROR. No function named `execute` calls the ingest. `execute` appears only as an obligation-registry property (lines 4045, 4071, 4116, 4153, 4244, 4252, 4266). The real callers are recoverIngestHostResults (line 1064) and buildImplementDispatchStep (line 1096). |
| `src/remediate/index.ts re-export of recoverIngestHostResults` | `src/remediate/index.ts` | **NO** | PLAN ERROR (harmless). index.ts imports recoverIngestHostResults from ./steps/nextStep.js (line 5) and calls it (line 284); it does not re-export it. It does import remediationSubmissionBinding + type RemediationHostIngestSummary from hostHandoff.js. |
| `DISPATCH_BARREL_EXPORTS` | `tests/helpers/dispatchBarrelBaseline.ts` | yes | NOT NAMED BY THE PLAN, and load-bearing. A committed 9-entry list of hostHandoff.ts's value exports, asserted with exact set equality in tests/remediate/host-handoff.test.ts line 1569. Any newly EXPORTED function reds it. |

### Plan errors (11)

- §3.2 says the validate phase has 'two whole-ingest early exits'. There are THREE in source (workload read failure at ~2388; trusted_binding_missing at ~2429; parseWorkload null at ~2453), and they do not return the same pending_work_item_ids.

- §1.2's accumulator comment marks `landedFiles` as '(Phase 3 only)', contradicting §3.3 and contradicting source line 2488 / ~2558 / ~2707 where it is seeded, read and written inside the loop. Following it is a fail-closed regression on the no-change path.

- §2.1 and §2.2 both say src/remediate/index.ts 'Re-exports recoverIngestHostResults'. It does not. It imports it from ./steps/nextStep.js (line 5) and calls it (line 284). The 'impact: none' verdict survives; the description does not.

- §2.2 lists a caller 'src/remediate/steps/nextStep.ts -> execute (dispatch routing)'. No such caller. `execute` is an obligation-registry property name in nextStep.ts (lines 4045+). The graph's '4 callers' is inflated — there are exactly 2 real call sites, both in nextStep.ts (1064, 1096).

- §2.1's 'No export-list change except the three new functions if tests need them' understates the cost. tests/helpers/dispatchBarrelBaseline.ts pins hostHandoff.ts's value exports to exactly 9 names and tests/remediate/host-handoff.test.ts:1569 asserts set equality. Any new export reds that test, and check:deadcode (knip default mode) flags an export with no consumer. The plan does not name dispatchBarrelBaseline.ts anywhere.

- §1.2's HostIngestContext flattens `root` and `artifactsDir` and omits `workloadPath` and the BoundaryPaths object. resolveBoundaryPaths (line 679) RESOLVES those values through resolveHostHandoffPaths — they are not params.root/params.artifactsDir — and Phase 1 needs workloadPath. Carry `paths: BoundaryPaths`.

- §1.2's HostItemVerdict omits `pendingItems`, which the mutation code needs and which today is computed pre-mutation inside the loop. Without it Phase 3 must recompute against a mutated clone.

- §3.4's landed-acceptance list omits `delete item.host_result_evidence` (source line ~2705).

- §5.2 presents ingestion CHECK ids (result_envelope, identity_binding, write_scope, commit_evidence, test_evidence, obligation_evidence, worktree_evidence, landing_attestation, outcome_shape, no_change_corroboration) as issue codes. They are check ids from src/shared/submission/ingestionChecks.ts, a separate axis from REMEDIATION_ISSUE_CODES (line 126). Every name is real; the label is loose. Note also that REMEDIATION_ISSUE_CODES spreads SUBMISSION_ISSUE_CODES, which is why submission_contract_invalid is valid despite not appearing in the local list.

- The plan does not mention the loop-core attestation requirement for this file, nor tests/shared/ingestion-checks-drift.test.ts (both landed constraints on any commit touching hostHandoff.ts).

- The plan cites 'CC 80' as 'confirmed by the shape of the code'. I did not verify a cyclomatic-complexity number — nothing in this repo's gates measures CC, so §5.4's 'orchestrator CC <= 4, extracts CC <= ~20' is an unmeasurable acceptance criterion as written. Treat it as prose, not a gate.

### Behavior changes (8)

- PURE-MOVE CLAIM IS MOSTLY TRUE. The plan is a decomposition, not a redesign; it changes no signature, no issue code, no message. Below is everything that is NOT a pure move.

- 1. landedFiles scoping (plan-internal contradiction, §1.2 vs §3.3). If landedFiles becomes a Phase-3-only accumulator as §1.2 annotates, corroborateNoChangeClaim's excusedPaths loses the edits accepted EARLIER IN THE SAME INGEST. A resolved_no_change item whose working-tree dirt is an earlier item's accepted landing flips from ACCEPTED to REFUSED with a no_change_corroboration issue. That is a change in what input is accepted. Uncovered by tests. Follow §3.3, not §1.2.

- 2. pendingItems recomputation. §1.2's HostItemVerdict carries workItem+result but NOT pendingItems, so Phase 3 must recompute `finding_ids.filter(id => nextState.items[id]?.status === 'pending')` after earlier verdicts were applied. If two work items share a finding id, the set of findings mutated for the second item changes (today the second item's filter already sees the first's mutation; after the split it sees the pre-loop state, or a partially-mutated state depending on ordering). Change in what a function writes for a given input. Fix by carrying pendingItems on the verdict.

- 3. The `if (pendingItems.length === 0) continue;` pending filter. Today it observes mutations made by earlier items in the same ingest; deferring all mutation to Phase 3 makes it observe only the pre-loop nextState. Same class as (2) — a re-ingest/duplicate-finding precedence change.

- 4. Timestamp grouping. Today `const now = new Date().toISOString()` (decision path) and `const completedAt = new Date().toISOString()` (landed path) are evaluated per item inside the loop, interleaved with git probes and test reruns that take real wall-clock time. Moving mutation into Phase 3 makes every item share the phase's timestamps and pushes them later. No test asserts distinct per-item timestamps today, but started_at/completed_at values observably change. Strictly, a change in what the function returns for a given input.

- 5. Ledger-append ordering relative to state mutation. Today the mark for item N is appended before item N is marked resolved and before item N+1 is corroborated. After a full Phase 2/3 split, ALL marks precede ALL mutations. The invariant the code comment states ('the mark goes down BEFORE the item is marked resolved') still holds, and it is arguably strengthened, but the interleaving on a crash mid-ingest differs: a crash after item 3's mark but before Phase 3 now leaves marks for items 1-3 with NO state mutation at all, where today items 1-2 would have been mutated in the returned clone. Since the caller only persists on state_changed and nothing is persisted mid-ingest, this is observationally inert — but it is not a pure move.

- 6. Early-exit count. If the implementer follows §3.2's 'two whole-ingest early exits' literally and folds the parseWorkload-null exit into another, `pending_work_item_ids` would change from `state.host_handoff?.work_item_ids ?? []` to `[]` (or vice versa) on that path. Avoid by implementing three.

- 7. NOT a behavior change, but worth stating: no export-surface change is proposed and none should be made — the three extracts stay file-local.

### Minimal change

Do the plan's §3.2/§3.3/§3.4/§3.5 split, all four new symbols FILE-LOCAL (not exported), entirely inside src/remediate/steps/dispatch/hostHandoff.ts. No other file changes. Corrections to the plan that the implementation must apply:

A. CONTEXT SHAPE. Carry `paths: BoundaryPaths` (root, artifactsDir, workloadPath, resultDir), not a re-flattened root/artifactsDir — resolveBoundaryPaths (line 679) returns RESOLVED values that need not equal params.root/params.artifactsDir, and Phase 1 needs paths.workloadPath. Also carry `runId: params.runId` and `recovery: params.recovery !== undefined` (the raw boolean corroborateHostResult takes).

B. VALIDATE PHASE returns one of FOUR outcomes, not three: the populated context, or one of THREE early summaries (workload read failure; trusted_binding_missing; parseWorkload null). Each early summary's `pending_work_item_ids` differs and must be copied verbatim: read-failure and parse-failure return `state.host_handoff?.work_item_ids ?? []`; the trusted_binding_missing gate returns `[]`. Getting these confused is a silent behavior change.

C. THE PHASE 2/3 SEAM IS NOT WHERE THE PLAN DRAWS IT. Three intra-loop couplings force part of "commit" to stay in the loop or to be threaded explicitly:
   - `landedFiles` is seeded from nextState.applied_edit_surface (line 2488), READ by the decision branch's excusedPaths (line ~2558) and WRITTEN by the landed branch (line ~2707). It MUST be a Phase-2 accumulator, mutated during the loop. §1.2's "(Phase 3 only)" annotation is wrong; follow §3.3.
   - `pendingItems` (the per-item `finding_ids.filter(id => nextState.items[id]?.status === "pending")`) is computed in the loop and consumed by the mutation. Put `pendingItems: readonly string[]` on both accept verdict arms rather than recomputing it in Phase 3 — recomputing after earlier items have already mutated nextState changes what the later item writes if two work items ever share a finding id (nothing in buildWorkItem/buildFindingAssignments forbids that).
   - The loop's FIRST check `if (pendingItems.length === 0) continue;` reads nextState, which today already reflects earlier items' mutations. If Phase 3 is deferred wholesale, this filter reads a pre-mutation nextState. Either keep the item-status writes inside Phase 2 (safest, and the split still drops CC because it removes the verdict/outcome branching), or accept the divergence and pin it with a test.
   The safe minimal seam: Phase 2 = the loop, emitting verdicts AND maintaining `landedFiles`, `completed`, `resultIds`, `issues`, `recordedRecoveryMarks`, plus the per-item nextState.items writes. Phase 3 = only the strictly post-loop tail (applied_edit_surface fold, pendingWorkItemIds derivation, final-drain migration + `delete nextState.host_handoff`, state_changed, summary assembly). That is a pure move with zero semantic risk. Lifting the item-status writes out of the loop as well is the plan's ambition and is the part that needs the extra verdict fields in (C) plus new tests.

D. PRESERVE VERBATIM, in order: every `issues.push` (17 sites) with its exact `code`, `check` and message string; every `continue`; the workload-order iteration over `effectiveWorkload.work_items`; `resultIds.add(resultId)` BEFORE the branch; the ledger mark BEFORE the item is marked resolved; and `delete item.host_result_evidence` on the landed path (§3.4 omits it).

E. Do NOT touch src/remediate/steps/nextStep.ts, src/remediate/index.ts, or src/shared/submission/*. Do not add exports. Do not change any message string (several are test-pinned, and the ingestion-check drift test scans literals).

### Red-green plan

COVERAGE IS GOOD for the fail-closed gates and WEAK for the intra-loop couplings the split actually risks. Two suites reach the behavior: tests/remediate/host-handoff.test.ts (contract/prepare-ingest round trips, the export-surface pin at line 1569) and tests/remediate/host-handoff-corroboration.test.ts (~35 `it` blocks, all driving ingestRemediationHostResults end to end against real git fixtures).

COVERED — single mutations that red today:
- Delete the `if (!eligibleIds.has(workItem.id))` refusal block (line ~2506) -> reds "keeps dependency eligibility enforced under recovery" (host-handoff-corroboration.test.ts:1729).
- Flip `canCorroborate` to a constant `true` -> reds "refuses attestation-only acceptance when neither a trusted binding nor a git repo exists" (:1756).
- Drop the lazy `recordedRecoveryMarks` identity check (accept `alreadyMarked = false` always) -> reds "does not append a second ledger mark when a recovery acceptance is retried" (:1539) and the ledger assertion in :1481.
- Change the mark identity from (run, item, landedCommit) to (run, item) -> reds "marks a re-accepted item again when the landed commit differs" (:1690).
- Remove the try/catch around the ledger append -> reds "refuses a recovery acceptance whose ledger mark cannot be recorded" (:1411).
- Move `migrateLegacyDirectoryScopesAfterFinalDrain` before the loop -> reds "defers legacy plan migration until the bound workload's final drain" (:632).
- Export any of the three new functions -> reds the export-surface pin (host-handoff.test.ts:1569) and check:deadcode.
- Break any `check: "<literal>"` citation -> reds tests/shared/ingestion-checks-drift.test.ts.

COVERAGE GAP — a finding, state it in the closeout:
1. NO test drives a landed acceptance and a resolved_no_change in the SAME ingest, so the `landedFiles -> excusedPaths` intra-ingest feedback (line 2488 -> line ~2558 -> line ~2707) is UNCOVERED. Following §1.2's "landedFiles is Phase 3 only" would silently start refusing an honest no-change item whose only dirt is an earlier item's accepted edit, and the suite would stay green. Grep evidence: `applied_edit_surface` is asserted in only 4 corroboration tests (:568, :588, :624, :1358), all single-landed-item; the two-item test (:1481) is landed+landed.
2. NO test has two work items sharing a finding id, so the mutation-visible `pendingItems` filter is uncovered.
3. NO pure Phase-3 state-transition test exists (every path goes through a git fixture), which is exactly what the plan's §5.3 proposes to add.
Write test (1) FIRST, red-green it against today's code (invert by seeding excusedPaths from `state.applied_edit_surface` only), then refactor — it is the one characterization test the split genuinely needs and does not have.

### Open choices (6)

- THE SEAM DEPTH. Two viable endpoints: (a) minimal — Phase 3 is only the strictly post-loop tail (applied_edit_surface fold, pendingWorkItemIds, final-drain migration, state_changed, summary), a provably pure move that still removes the biggest branch cluster; or (b) the plan's full ambition — lift the per-item nextState.items writes out of the loop too, which requires carrying pendingItems on the verdict and accepting the timestamp-grouping and duplicate-finding precedence changes. (a) is safe today; (b) needs the new tests in §5.3 first. The plan does not offer this choice; a human should make it.

- Whether to add the missing characterization test (landed + resolved_no_change in one ingest, exercising landedFiles -> excusedPaths) BEFORE the refactor, or ship the refactor and add it after. Repo convention (design-check, red-green-validate) says before.

- Whether the three extracts stay file-local (recommended — the export-surface pin and check:deadcode both punish exporting) or the DISPATCH_BARREL_EXPORTS baseline is deliberately widened to expose them for unit testing. The plan hedges; someone must decide.

- Whether HostItemVerdict is introduced at all under option (a) — if mutation stays in the loop, the verdict type is dead weight and check:deadcode would flag any unused member.

- Whether §5.4's CC targets (orchestrator CC <= 4, extracts CC <= ~20) are a real acceptance bar. No gate in this repo measures cyclomatic complexity, so either a human accepts them as eyeball criteria or the item needs a measurement tool.

- Whether to also correct the plan document's four factual errors in place (index.ts re-export, the `execute` caller, the two-vs-three early exits, the landedFiles phase annotation) or leave the plan as a dated record and rely on this brief. The plan is a tracked doc at docs/reviews/refactor-plan-hotspot-host-handoff-2026-09-05.md.

### Against what already landed

NO CONFLICT with any of the six commits named in the brief. None of them touch src/remediate/steps/dispatch/hostHandoff.ts, src/remediate/steps/nextStep.ts, or src/shared/submission/. They are all in src/audit/extractors/*, scripts/shared/*, and scripts/guard-reach-data.mjs. `git log --oneline -- src/remediate/steps/dispatch/hostHandoff.ts` shows the most recent touch is 041f7b6d, which is NOT in that list.

TWO THINGS AT HEAD THAT THE PLAN DOES NOT ACCOUNT FOR (neither is a conflict; both are constraints the implementer must respect):

1. Commit 041f7b6d ("ingestion: the check set is declared data both ingests cite") landed a citation registry, src/shared/submission/ingestionChecks.ts, and a contract test tests/shared/ingestion-checks-drift.test.ts. That test asserts, in BOTH directions, that each draw's ingestion SOURCE FILE cites exactly the check ids the registry declares for that draw. The extractor (extractCitedIngestionChecks in scripts/shared/generate-ingestion-checks.mjs) scans a whole file's text for `refuse`/`invalidResult`/`bindingFailure` first string-literal arguments and for `check: "<literal>"` property assignments. Because the registry keys off the FILE (`{ id: "remediate", source: "src/remediate/steps/dispatch/hostHandoff.ts" }`) and not off a function, moving these call sites BETWEEN FUNCTIONS INSIDE hostHandoff.ts is safe. Moving any of them OUT of the file, or dropping any `check: "..."` literal, reds tests/shared/ingestion-checks-drift.test.ts and `npm run check:ingestion-checks`. The plan's §3.2/§3.3/§3.4 keep everything in-file, so it is compatible.

2. tests/helpers/dispatchBarrelBaseline.ts pins hostHandoff.ts's value-export surface to exactly 9 names, asserted with `expect(Object.keys(barrel).sort()).toEqual([...DISPATCH_BARREL_EXPORTS].sort())` (tests/remediate/host-handoff.test.ts line 1569; also imported by tests/remediate/backend-independent-planning.test.ts). The plan's §2.1 hedge "prefer file-local + export for testability" is therefore not cost-free: exporting validateHostResultBundle / executeHostVerificationReruns / commitRemediationStateUpdates reds that pin until the baseline file is edited in the same commit, and `npm run check:deadcode` (knip default mode) will additionally flag any exported symbol with no consumer. Keep all three file-local.

3. Because hostHandoff.ts is loop-core, the commit is blocked until a fresh staged-tree-bound attestation exists: `node .claude/hooks/attest-loop-core-review.mjs --reviewed-by <id> --attester-class <agent|human> --checked "<...>"` (per CLAUDE.md, P53 / .githooks/pre-commit -> .claude/hooks/commit-gate.mjs).

---

