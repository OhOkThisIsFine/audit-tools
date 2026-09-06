# Refactoring Plan: Item 2.2 - CLI Step Execution Scaffolding

## Item Overview & Current State

- **Item:** 2.2 CLI Step Execution Scaffolding
- **Files Involved:**
  - src/audit/cli/forceSynthesisCommand.ts (symbol: cmdForceSynthesis)
  - src/audit/cli/intakeCommand.ts (symbol: cmdIntake)
  - src/audit/cli/synthesizeCommand.ts (symbol: cmdSynthesize)
  - Additional CLI commands in src/audit/cli/*Command.ts
- **Key Symbols:** runAuditStep, getRootDir, getArtifactsDir, warnIfNotGitRepo, outputJson
- **Prior Sweep & Verification Findings:**
  Subcommand entrypoints duplicate boilerplate: parse root & artifacts dir from argv, call runAuditStep, and format JSON output.
  Variance: cmdIntake calls warnIfNotGitRepo(root); cmdSynthesize already uses outputJson from cliHelpers.js.

---

## 1. Architectural Rationale & Boundary Analysis

### 1.1 The duplication (verified in source)

All three in-scope commands follow the identical 4-step scaffold:

1. `getRootDir(argv)` → `getArtifactsDir(argv)` (argv parsing, `args.ts`)
2. `runAuditStep({ root, artifactsDir, preferredExecutor })` (`auditStep.ts`)
3. Format `{ artifacts_dir, selected_executor, progress_summary }` as indented JSON to stdout.

Symbol-by-symbol variance today:

| Symbol | cmdForceSynthesis | cmdIntake | cmdSynthesize (reference shape) |
|---|---|---|---|
| `getRootDir` | `const root = getRootDir(argv)` | `const root = getRootDir(argv)` | inline `root: getRootDir(argv)` |
| `warnIfNotGitRepo` | absent | `warnIfNotGitRepo(root)` | absent |
| `getArtifactsDir` | `const artifactsDir = ...` | `const artifactsDir = ...` | `const artifactsDir = ...` |
| `runAuditStep` + `preferredExecutor` | `"synthesis_executor"` | `"intake_executor"` | `"synthesis_executor"` |
| JSON output | inline `console.log(JSON.stringify(..., null, 2))` | inline `console.log(JSON.stringify(..., null, 2))` | `outputJson({...})` from `cliHelpers.ts` |

So `cmdSynthesize` is already the target shape for the output half; `cmdForceSynthesis` and `cmdIntake` each hand-roll the same `console.log(JSON.stringify(...))`. `outputJson` in `cliHelpers.ts` exists precisely to centralize that pattern (its docstring says so) but only a subset of commands use it.

### 1.2 Why a scaffold helper is the right seam

- **Two stable layers already exist and must not move.** `args.ts` owns argv parsing (`getRootDir`, `getArtifactsDir`, `warnIfNotGitRepo`, `getFlag`, `getBatchResultsDir`); `auditStep.ts` owns the locking/persisting step (`runAuditStep` → `runAuditStepLocked` → `executeAdvance`, plus the lock-free `runAuditStepUnlocked` for the `nextStepHelpers.ts` fold and `ingestBatchAuditResults`). A scaffold helper sits *between* them: it calls down into both but owns neither concern. It must not import orchestrator internals (`advanceAudit`, `deriveAuditState`, `decideNextStep`), must not touch the artifact-tree lock (`withArtifactTreeHold`, `ARTIFACT_TREE_LOCK_TIMEOUT_MS`), and must not replicate the `runAuditStep`/`runAuditStepUnlocked` split.
- **The import-boundary contract constrains placement.** `nextStepHelpers.ts` is banned from importing the locking `runAuditStep` (it uses `runAuditStepUnlocked` + `withArtifactTreeHold`, enforced by a dynamic lock-count acceptance test and `tests/audit/artifact-tree-lock-single-surface.test.ts`). Whatever is added to `cliHelpers.ts` must therefore never import from `auditStep.ts` in a way that gives `nextStepHelpers.ts` a transitive path to the locking entry — i.e. the scaffold helper imports `runAuditStep`, and `nextStepHelpers.ts` must never import the scaffold module. Keep `cliHelpers.ts` (pure output today) free of `auditStep.ts` imports OR put the scaffold in a new `stepCommand.ts` module that `nextStepHelpers.ts` never imports. The second option is safer: `cliHelpers.ts` stays dependency-free (only `console`), and the new module holds the only new `auditStep.ts` edge.
- **Output uniformity is a contract, not cosmetics.** Downstream hosts parse `artifacts_dir`, `selected_executor`, `progress_summary` from stdout. Today two of three commands format that payload by hand; any drift in indentation, key names, or extra keys breaks parsers. Centralizing through `outputJson` makes the envelope identical by construction.
- **`warnIfNotGitRepo` is policy, not scaffolding.** Only `cmdIntake` (and `cmdNextStep`, via `getRootDir` + `warnIfNotGitRepo` in `nextStepCommand.ts`) warn; `cmdSynthesize`/`cmdForceSynthesis` do not. The helper must take this as an explicit per-command option (`warnIfNotGit = true/false`), not impose one policy, so the refactor is behavior-preserving and the policy decision stays visible at each call site.

### 1.3 What is deliberately out of scope

- `runAuditStep` internals (`executeAdvance`, validation gates, `stampToolComputedGrounding`), the lock timeout, and the persist/prune logic in `runAuditStepLocked`.
- The `nextStepHelpers.ts` fold (uses `runAuditStepUnlocked`, never the scaffold).
- Commands that do not call `runAuditStep` (`cmdStatus`, `cmdRequeue`, `cmdResynthesize`, `cmdCleanup`, `cmdSampleRun`, `cmdValidateResults`, `cmdScoreAudit`, `cmdExplainTask`): they benefit from `outputJson` adoption but not from the step scaffold.
- `resynthesizeCommand.ts` resolves its own dirs (`resolveAuditToolsDir(root)`, `auditArtifactsDir(root)`) instead of `getArtifactsDir(argv)` — a separate inconsistency, noted as a follow-up, not folded into this item.

---

## 2. Blast Radius & Affected Files

### 2.1 Directly refactored (behavior-preserving edits)

| File | Symbol | Change |
|---|---|---|
| `src/audit/cli/forceSynthesisCommand.ts` | `cmdForceSynthesis` | Replace hand-rolled `getRootDir`/`getArtifactsDir` + `runAuditStep` + inline `console.log(JSON.stringify(...))` with scaffold call (`preferredExecutor: "synthesis_executor"`, default payload). Net: ~29 lines → ~10. |
| `src/audit/cli/intakeCommand.ts` | `cmdIntake` | Same, with `warnIfNotGit: true` to preserve the existing `warnIfNotGitRepo(root)` call. |
| `src/audit/cli/synthesizeCommand.ts` | `cmdSynthesize` | Same, with `warnIfNotGit: false`; output already via `outputJson`, so this mainly unifies argv/step handling. Becomes the proof that the helper reproduces the reference shape exactly. |
| **New** `src/audit/cli/stepCommand.ts` (recommended) — or extend `src/audit/cli/cliHelpers.ts` | **New** `runStepCommand` (name bikeshed at review; alternatives: `execStepCommand`, `runExecutorCommand`) | The scaffold: parses dirs, optionally warns, calls `runAuditStep`, emits JSON via `outputJson`. See §3.1. |
| `src/audit/cli/cliHelpers.ts` | `outputJson` | Unchanged (reused). Only edited if the scaffold lives here rather than in a new module. |

### 2.2 Second-wave adopters (same pattern, extra options — implement only after wave 1 is green)

| File | Symbol | Why it needs more than the minimal scaffold |
|---|---|---|
| `src/audit/cli/planCommand.ts` | `cmdPlan` | Adds `since: getFlag(argv, "--since")` to `runAuditStep` options and an extra `next_likely_step` output key. Needs `extraOptions` + `extraPayload` passthrough. Inline JSON output → also migrates to `outputJson`. |
| `src/audit/cli/ingestResultsCommand.ts` | `cmdIngestResults` | Branching: batch path calls `ingestBatchAuditResults` (different result shape: `batchFiles`, `imported_files`), single path passes `auditResultsPath: getFlag(argv, "--results")`; plus the `--results`/`--batch-results` mutual-exclusion guard. Needs `extraOptions` at minimum; batch branch likely stays bespoke. |
| `src/audit/cli/importExternalAnalyzerCommand.ts` | `cmdImportExternalAnalyzer` | Pre-reads + validates `externalAnalyzerResults` (`readJsonFile`, `results`-array check, default `--external-analyzer-results` path), passes `externalAnalyzerData`, custom payload (`tool`, `imported_count`, no `progress_summary`). Needs pre-step hook + custom payload builder. |

### 2.3 Untouched but affected-by-contract

- `src/audit/cli.ts` — dispatch table (`["intake", cmdIntake]`, `["plan", cmdPlan]`, `["ingest-results", cmdIngestResults]`, `["synthesize", cmdSynthesize]`, `["force-synthesis", cmdForceSynthesis]`): signatures stay `(argv: string[]) => Promise<void>`, so no edit needed. Verify only.
- `src/audit/cli/args.ts` (`getRootDir`, `getArtifactsDir`, `warnIfNotGitRepo`) and `src/audit/cli/auditStep.ts` (`runAuditStep`, `RunAuditStepOptions`): consumed, not modified. Note: `getArtifactsDir` internally calls `getRootDir` again when `--artifacts-dir` is absent, so commands that call both parse `--root` twice — the scaffold does not fix that (fix belongs to `args.ts`, separate item), but it does centralize the double-call in one place.
- `src/audit/cli/nextStepCommand.ts` (`cmdNextStep`, also calls `warnIfNotGitRepo`) and `nextStepHelpers.ts` (lock-free fold): out of scope; flag as non-adopters so a later sweep does not "unify" them into the locking helper.
- Tests: `tests/audit/cli-dispatcher.test.ts` (maps `intake`→`cmdIntake`, `synthesize`→`cmdSynthesize`, `force-synthesis`→`cmdForceSynthesis`), `tests/audit/cli-remediation.test.ts` (same three file→symbol rows), `tests/audit/helpers/completion-harness.ts` (notes `ingest-results`/`force-synthesis` behavior). No test edits expected; they pin the contract the refactor must preserve.

---

## 3. Specific Code Modifications (Symbol-Located)

### 3.1 New scaffold symbol: `runStepCommand` in new `src/audit/cli/stepCommand.ts`

Recommended over extending `cliHelpers.ts` (§1.2: keeps the pure-output module dependency-free and keeps the new `auditStep.ts` edge out of `nextStepHelpers.ts`'s reach):

```ts
import { runAuditStep, type RunAuditStepOptions } from "./auditStep.js";
import { getArtifactsDir, getRootDir, warnIfNotGitRepo } from "./args.js";
import { outputJson } from "./cliHelpers.js";

export interface StepCommandSpec {
  /** Forwarded as RunAuditStepOptions["preferredExecutor"]. */
  preferredExecutor: NonNullable<RunAuditStepOptions["preferredExecutor"]>;
  /** Default false: preserves cmdIntake/cmdNextStep warning, absence elsewhere. */
  warnIfNotGit?: boolean;
  /** Extra RunAuditStepOptions for wave-2 commands (e.g. cmdPlan's `since`). */
  extraOptions?: (argv: string[]) => Partial<RunAuditStepOptions>;
  /** Defaults to ({artifacts_dir, selected_executor, progress_summary}). */
  buildPayload?: (ctx: {
    artifactsDir: string;
    result: Awaited<ReturnType<typeof runAuditStep>>;
  }) => unknown;
}

export async function runStepCommand(argv: string[], spec: StepCommandSpec): Promise<void> {
  const root = getRootDir(argv);
  if (spec.warnIfNotGit) warnIfNotGitRepo(root);
  const artifactsDir = getArtifactsDir(argv);
  const result = await runAuditStep({
    root,
    artifactsDir,
    preferredExecutor: spec.preferredExecutor,
    ...spec.extraOptions?.(argv),
  });
  outputJson(
    spec.buildPayload?.({ artifactsDir, result }) ?? {
      artifacts_dir: artifactsDir,
      selected_executor: result.selected_executor,
      progress_summary: result.progress_summary,
    },
  );
}
```

Design notes:

- `outputJson` is the single emission path — no `console.log(JSON.stringify(...))` remains in adopters.
- `getRootDir(argv)` is resolved once into `root` (today `cmdSynthesize`/`cmdPlan`/`cmdIngestResults` call it inline inside the `runAuditStep` argument while also calling `getArtifactsDir`, which re-resolves it — same values, wasted work; the scaffold resolves once and passes both).
- `RunAuditStepOptions` is the options type (re-exported from `auditStep.ts`); no new options interface, so executor additions flow through automatically.
- `buildPayload` default reproduces the exact three-key payload byte-for-byte (key order preserved: `artifacts_dir`, `selected_executor`, `progress_summary`).

### 3.2 `cmdForceSynthesis` (forceSynthesisCommand.ts)

- Remove imports of `runAuditStep`, `getArtifactsDir`, `getRootDir`; import `runStepCommand` from `./stepCommand.js`.
- Preserve the docstring block on `cmdForceSynthesis` (deterministic-synthesis recovery semantics) — it documents executor behavior, not scaffolding, and must survive.
- Replace the body (`getRootDir` → `getArtifactsDir` → `runAuditStep({ preferredExecutor: "synthesis_executor" })` → inline `console.log(JSON.stringify(...))`) with:
  `return runStepCommand(argv, { preferredExecutor: "synthesis_executor" });`

### 3.3 `cmdIntake` (intakeCommand.ts)

- Same import swap as §3.2.
- Replace the body (`getRootDir` → `warnIfNotGitRepo(root)` → `getArtifactsDir` → `runAuditStep({ preferredExecutor: "intake_executor" })` → inline JSON) with:
  `return runStepCommand(argv, { preferredExecutor: "intake_executor", warnIfNotGit: true });`
- The `warnIfNotGit: true` flag is the load-bearing preservation of the one behavioral difference between `cmdIntake` and `cmdForceSynthesis`.

### 3.4 `cmdSynthesize` (synthesizeCommand.ts)

- Same import swap (drop `runAuditStep`, `getArtifactsDir`/`getRootDir`, `outputJson` imports; import `runStepCommand`).
- Replace the body (`getArtifactsDir` → `runAuditStep({ root: getRootDir(argv), preferredExecutor: "synthesis_executor" })` → `outputJson(...)`) with:
  `return runStepCommand(argv, { preferredExecutor: "synthesis_executor" });`
- Expected result is line-identical stdout to today (same three keys, same order, same `outputJson` formatting) — this is the regression anchor: if `cmdSynthesize` output changes, the helper is wrong, not the callers.

### 3.5 Wave 2 (only after wave 1 ships; each is a separate commit)

- `cmdPlan`: adopt with `extraOptions: (argv) => ({ since: getFlag(argv, "--since") })` and `buildPayload` adding `next_likely_step: result.next_likely_step`; keeps `getFlag` import, drops `console.log` for `outputJson`-via-scaffold.
- `cmdIngestResults`: adopt the single-result branch with `extraOptions: (argv) => ({ auditResultsPath: getFlag(argv, "--results") })`; keep the mutual-exclusion guard and the `ingestBatchAuditResults` batch branch bespoke.
- `cmdImportExternalAnalyzer`: adopt only if a pre-step hook is added (`prepare: (argv, artifactsDir) => ...` returning extra options + payload context); otherwise leave bespoke — forcing it through `extraOptions` would re-read the file inside `runAuditStep` and undo the deliberate single-read optimization noted in its comment.

---

## 4. Step-by-Step Implementation Sequence

1. **Add the scaffold (new file, no caller changes).** Create `src/audit/cli/stepCommand.ts` with `StepCommandSpec` + `runStepCommand` per §3.1. Typecheck. No behavior change; nothing imports it yet.
2. **Migrate `cmdSynthesize` first.** It already emits via `outputJson`, so the diff isolates the argv/step half. Typecheck + run the synthesize-related tests. Snapshot stdout before/after on a fixture repo and `diff` — must be empty.
3. **Migrate `cmdForceSynthesis`.** Same snapshot-diff procedure. This is the inline-`console.log` → `outputJson` conversion; formatting is identical by construction (both `JSON.stringify(data, null, 2)`), but verify rather than assume.
4. **Migrate `cmdIntake`.** Same, plus assert the git-warning still fires: run once from a non-git temp dir, confirm the `warnIfNotGitRepo` stderr warning appears, and once from a git repo, confirming silence.
5. **Grep for residue.** `console.log(JSON.stringify` must return zero hits in the three migrated files; `runAuditStep` must be imported only by `stepCommand.ts` (plus legitimate non-CLI-scaffold users: `ingestResultsCommand.ts`, `importExternalAnalyzerCommand.ts`, `planCommand.ts` until wave 2, `auditStep.ts` itself).
6. **Run the gates** (§5). Commit wave 1 as one commit (`refactor(cli): scaffold runAuditStep commands behind runStepCommand` or repo-conventional message).
7. **Wave 2, one command per commit,** in order `cmdPlan` → `cmdIngestResults` → `cmdImportExternalAnalyzer` (increasing bespoke complexity). Re-run snapshot diffs per command; each must be byte-identical stdout (plus identical stderr for warning paths).

---

## 5. Verification & Regression Test Plan

### 5.1 Stdout snapshot diffs (primary guard — catches envelope drift)

For each migrated command, on a fixed fixture repo (deterministic seed if available):

- Before/after capture: `cmdX --root <fixture> > before.json` on the pre-refactor tree, same on the post-refactor tree, `diff before.json after.json` → must be empty.
- Key-order-sensitive comparison (parse + deep-equal is insufficient; also compare raw bytes) since hosts may string-match.
- `cmdIntake` additionally: stderr capture from a non-git directory must still contain the `warnIfNotGitRepo` warning; from a git repo must not.

### 5.2 Existing suite (regression net)

- `tests/audit/cli-dispatcher.test.ts` — dispatch table still resolves `intake`/`synthesize`/`force-synthesis` to `cmdIntake`/`cmdSynthesize`/`cmdForceSynthesis` (signatures unchanged, so this should pass untouched).
- `tests/audit/cli-remediation.test.ts` — file→symbol rows for the three commands.
- Full audit test path covering `runAuditStep` executors (`intake_executor`, `synthesis_executor`) — at minimum the tests that exercise `cmdPlan`/`cmdSynthesize` fixtures; run the whole `tests/audit` directory if time permits.
- Typecheck (`tsc --noEmit` or repo script) and lint/CI gate per repo convention.

### 5.3 Negative checks (prove the boundaries held)

- `nextStepHelpers.ts` does not import `stepCommand.ts` (grep) — the import-boundary contract still holds; the lock-count / single-surface tests (`tests/audit/artifact-tree-lock-single-surface.test.ts` and the dynamic lock-count acceptance test) still pass.
- `auditStep.ts` exports unchanged (`runAuditStep`, `runAuditStepUnlocked`, `withArtifactTreeHold`, `ARTIFACT_TREE_LOCK_TIMEOUT_MS`); no orchestrator import leaks into `stepCommand.ts` (grep for `advanceAudit|deriveAuditState|decideNextStep` → zero hits in `stepCommand.ts`).
- Double-resolution note: confirm `getRootDir` is called once per scaffold invocation (code inspection; the previous inline pattern resolved it twice via `getArtifactsDir`).

### 5.4 Rollback criteria

- Any snapshot diff non-empty (other than intentional wave-2 payload additions, which must be separately reviewed), any dispatcher/remediation test failure, or any lock-surface test failure → revert the offending command commit; the scaffold file itself is inert without callers and can stay or go with the revert.

### 5.5 Follow-ups (not this item — log, do not fold in)

- `resynthesizeCommand.ts` bypasses `getArtifactsDir(argv)` (uses `auditArtifactsDir(root)`); `getArtifactsDir` double-resolves `getRootDir`; `outputJson` adoption in remaining bespoke commands (`cmdCleanup`, `cmdValidateResults`, `cmdScoreAudit`, `cmdExplainTask`, `cmdRecoverSubmission`, `cmdSampleRun` already uses it). Each is a separate small item.
