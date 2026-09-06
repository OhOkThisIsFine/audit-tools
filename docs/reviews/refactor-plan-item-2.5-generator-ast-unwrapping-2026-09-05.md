# Refactoring Plan: Item 2.5 - Code Generator AST Literal Unwrapping

## Item Overview & Current State

- **Item:** 2.5 Code Generator AST Literal Unwrapping
- **Files Involved:**
  - scripts/shared/generate-ingestion-checks.mjs
  - scripts/shared/generate-spec-mirrors.mjs
- **Key Symbols:** unwrapExpression, runGeneratedArtifactCli, spliceGeneratedBlock
- **Prior Sweep & Verification Findings:**
  The catalog cited banner/dry-run duplication, but that was already consolidated into scripts/shared/generatedArtifacts.mjs.
  The actual verified micro-twin between these scripts is the 14-line unwrapExpression(node) helper stripping as const, satisfies, and parentheses down to literal AST expressions.

### The verified twin (byte-identical in both files)

```js
/** Strip `as const` / `satisfies T` / parentheses down to the underlying literal. */
function unwrapExpression(node) {
  let current = node;
  for (;;) {
    if (
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isParenthesizedExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}
```

- `generate-ingestion-checks.mjs` carries it as local symbol `unwrapExpression`, called from `readCheckRow` (unwraps each `property.initializer`) and from `parseIngestionChecks` (unwraps the `INGESTION_CHECKS` declarator initializer).
- `generate-spec-mirrors.mjs` carries the identical local symbol `unwrapExpression`, called from `exportedInitializer` (unwraps any top-level `export const <name>` initializer), from `readStringConstants` (unwraps each candidate constant initializer before the `isStringLiteral` test), and from `parseArtifactDefinitions` (unwraps each `property.initializer` before the `isCallExpression` test).
- Both files already import the shared substrate (`runGeneratedArtifactCli`, `spliceGeneratedBlock`) from `scripts/shared/generatedArtifacts.mjs`. Neither exports its copy; both drift tests (`tests/shared/ingestion-checks-drift.test.ts`, `tests/shared/spec-mirror-drift.test.ts`) exercise the *callers*, never the helper directly.

---

## 1. Architectural Rationale & Boundary Analysis

### 1.1 Why this twin exists

Both generators do STRUCTURAL extraction: they read a TypeScript registry's source text through the `typescript` compiler API and reduce it to plain data, refusing on anything they cannot read with certainty (never regex, never silent drop — see each file's header comment). A registry declared as

```ts
export const INGESTION_CHECKS = [ … ] as const satisfies …;
```

or wrapped in parentheses parses to an `AsExpression` / `SatisfiesExpression` / `ParenthesizedExpression` node, not the `ArrayLiteralExpression` / `ObjectLiteralExpression` the readers test for. The unwrap loop peels exactly those three transparent wrappers, iteratively (they nest: `(X as const)` is a parenthesized as-expression), returning the first node that is none of the three. Every downstream `ts.is*` check then operates on the literal.

### 1.2 Why consolidate now

1. **Single-implementation rule.** `generatedArtifacts.mjs`'s header states the standing rule: each generator keeps only its extraction, its `render()`, and its declaration; shared mechanics live once. The unwrap loop is shared mechanics with two copies — the exact defect class the substrate was created to kill (F1, ceremony review 2026-08-29). A future edit (e.g. also peeling `!` non-null assertions) applied to one copy and not the other silently forks which syntax each registry accepts.
2. **Refusal-semantics coupling.** The helper defines what counts as "still a literal". If the two copies ever disagree, one generator refuses a registry shape the other accepts, and the failure surfaces as a confusing per-generator error rather than a single documented contract.
3. **Cost is ~zero, risk is ~zero.** One pure function, no I/O, no state, byte-identical copies. The move is behavior-preserving by construction and verifiable by render-parity (before/after renders must be byte-identical).

### 1.3 Home-module decision: new `scripts/shared/tsAstHelpers.mjs`, NOT `generatedArtifacts.mjs`

Two candidate homes were considered:

| Candidate | Pros | Cons |
|---|---|---|
| **A. `scripts/shared/generatedArtifacts.mjs`** (the ONE substrate) | Follows the one-substrate rule literally; zero new import paths; both consumers already import from it | `generatedArtifacts.mjs` currently imports only `node:fs`/`node:path` and is imported by ~10 generators. Adding `import ts from "typescript"` forces the ~8 MB compiler load onto every generator, including ones that never parse TS (backlog-index, cli-surface, constitutional-doc-paths, loop-core-patterns, …). Mixes file-splicing/CLI concerns with AST concerns |
| **B. NEW `scripts/shared/tsAstHelpers.mjs`** (recommended) | Keeps the `typescript` dependency scoped to the structural generators that need it; `generatedArtifacts.mjs` stays dependency-light; leaves room for the adjacent one-liner twin (`parseSource` — see §2) without bloating the substrate | One more shared module (two import lines per consumer instead of one) |

**Recommendation: option B.** The substrate's job is "read source → render → compare → splice → exit-code CLI". AST *reading* helpers are a different layer (they operate on `ts.Node`, not on files/markers). A 20-line leaf module with a single `typescript` import preserves the single-implementation rule in spirit while respecting module cohesion and startup cost. If the owner prefers the literal one-substrate reading, option A is a 5-line fallback (export the same function from `generatedArtifacts.mjs`; everything else in this plan is unchanged).

### 1.4 Import-shape decision

The helper needs the `ts.isAsExpression` / `ts.isSatisfiesExpression` / `ts.isParenthesizedExpression` predicates plus the `.expression` accessor common to all three node kinds. Two shapes:

- **(i) Module imports `typescript` itself** (recommended): `import ts from "typescript"` lives once in the helper; signature stays `unwrapExpression(node)`; both call sites keep their current call shape and just change the import. No caller edits beyond the import line and deleting the local copy.
- **(ii) Caller injects `ts`:** `unwrapExpression(ts, node)` avoids a second `typescript` module instance. Rejected: both callers already import the same `typescript` package instance through Node's resolver, so there is no duplication to avoid, and threading `ts` through `exportedInitializer`, `readStringConstants`, `readCheckRow`, and every test fixture adds noise for no gain.

### 1.5 Deliberate non-goals (do NOT expand accepted syntax in this refactor)

- Do **not** add `isNonNullExpression` (`x!`) or `isTypeAssertion` (`x as T` is already covered via `isAsExpression`; `<T>x` assertions are distinct) peeling. That would silently widen what each registry accepts and weaken the refuse-rather-than-guess contract. If wanted, it is a separate item with its own registry-fixture tests.
- Do **not** generalize to full constant evaluation (binary expressions, template concatenation, enum members). The callers' refusal messages explicitly promise "quoted string or array of quoted strings" — evaluation would contradict them.
- Do **not** touch `extractCitedIngestionChecks` (citation scanner, no unwrap involved) or the render/splice/CLI layer.

---

## 2. Blast Radius & Affected Files

### 2.1 In scope (must change)

| File | Symbol(s) | Change |
|---|---|---|
| **NEW** `scripts/shared/tsAstHelpers.mjs` | `unwrapExpression` (new export), optionally `parseSourceFile` | New leaf module; single `typescript` import; JSDoc contract |
| `scripts/shared/generate-ingestion-checks.mjs` | `unwrapExpression` (delete local), `readCheckRow`, `parseIngestionChecks` | Delete 14-line local; import shared helper; call sites unchanged in shape |
| `scripts/shared/generate-spec-mirrors.mjs` | `unwrapExpression` (delete local), `exportedInitializer`, `readStringConstants`, `parseArtifactDefinitions` | Same as above |

Call-site inventory (all preserved, only the callee's origin changes):

- `readCheckRow`: `const value = unwrapExpression(property.initializer)` — per-property peel.
- `parseIngestionChecks`: `declaration.initializer && unwrapExpression(declaration.initializer)` — top-level registry peel.
- `exportedInitializer`: `return unwrapExpression(declaration.initializer)` — generic top-level peel used by `parseArtifactDefinitions`, `parseExecutorRegistry`, `parseDependencyMap`.
- `readStringConstants`: `const initializer = unwrapExpression(declaration.initializer)` before the `isStringLiteral` gate.
- `parseArtifactDefinitions`: `const call = unwrapExpression(property.initializer)` before the `isCallExpression` gate.

### 2.2 In-scope hardening (same files, two missed peel sites — normalize)

Within `generate-spec-mirrors.mjs`, two property-level reads do **not** unwrap today, inconsistently with the three above:

- `parseExecutorRegistry`: `const value = property.initializer` is tested directly with `ts.isStringLiteral(value)` (`id`/`kind`) and `ts.isArrayLiteralExpression(value)` (`obligation_ids`).
- `parseDependencyMap`: `const value = property.initializer` is tested directly with `ts.isArrayLiteralExpression(value)`.

Consequence: an executor entry written as `id: "x" as const` (legal TS, same meaning) renders in the artifact-catalog path but **refuses** in the executor-catalog path. After the shared helper exists, routing both sites through it is a 2-line change each that makes the file self-consistent. Recommended as part of this item (flagged separately in §3, step 4, so it can be split out if the owner wants a pure move).

### 2.3 Adjacent but OUT of scope (documented, not changed)

| File / symbol | Why out of scope |
|---|---|
| `generate-executor-producers.mjs` → `readArrayLiteral` / `readObject` | Same structural idiom but **no unwrap at all**: `const initializer = declaration.initializer` must `isArrayLiteralExpression` directly, and `readObject` refuses any non-plain-literal property. An `as const satisfies` registry would refuse here while passing in the other two generators. Real inconsistency, but changing refusal behavior is a semantic change, not a dedup — file as follow-up item |
| `executor-write-sites.mjs` → `buildScopeIndex` (`const initializer = declaration.initializer` + direct `isObjectLiteralExpression` test) | Same observation; different subsystem (write-site indexing, not doc generation); follow-up item |
| `generate-filelock-export-surface.mjs` (imports `typescript`, uses `decl.initializer` / `param.initializer` textually) | Textual normalization (`norm(decl.initializer.getText(sf))`), not literal extraction — no unwrap semantics to share |
| `parseSource` one-liner in `generate-spec-mirrors.mjs` (`ts.createSourceFile(file, text, Latest, true)`) vs inline `ts.createSourceFile(…)` in `generate-ingestion-checks.mjs` (`parseIngestionChecks`, `extractCitedIngestionChecks`) | Second micro-twin (~3 lines). Natural second export (`parseSourceFile`) of the new module, but not this item — note as follow-up so this refactor stays a pure move |
| `scripts/shared/generatedArtifacts.mjs` (`spliceGeneratedBlock`, `runGeneratedArtifactCli`) | Unchanged. Both consumers keep their existing imports from it; no new dependency added to it |
| `scripts/shared/spec-mirror-data.mjs`, `scripts/guard-reach-data.mjs`, `.github/workflows/ci.yml`, `package.json` check scripts | Reference the generators by path/command, not by helper location — untouched |
| Generated outputs (`docs/audit-pkg/contracts.md` block, `spec/audit/*.md` regions) | Must be byte-identical before/after; regenerated only to prove parity, then no diff expected |

### 2.4 Test-surface blast radius

- `tests/shared/ingestion-checks-drift.test.ts` imports `BEGIN_MARKER, END_MARKER, RENDER_FILE, SOURCE_FILE, POINTER_FILES, extractCitedIngestionChecks, renderIngestionChecks` — none is the helper; unaffected except via render parity.
- `tests/shared/spec-mirror-drift.test.ts` imports `beginMarker, readRegistries, reconcileRegions, renderRegion, spliceRegion` — unaffected except via render parity.
- `tests/shared/generated-artifacts-splice.test.ts` pins splice refusals — untouched (substrate unchanged).
- No test imports `unwrapExpression` today; the plan adds a focused unit test for the new module (see §5) without modifying existing tests.

---

## 3. Specific Code Modifications (Symbol-Located)

### 3.1 NEW `scripts/shared/tsAstHelpers.mjs` — export `unwrapExpression`

```js
import ts from "typescript";

/**
 * Strip `as const` / `satisfies T` / parentheses down to the underlying literal.
 *
 * The registries these generators read are declared `… as const satisfies …`
 * (and occasionally parenthesized); the readers test for the literal node, so
 * the transparent wrappers must be peeled first. Iterates because wrappers
 * nest (`(X as const)`). Anything else — including `!` non-null assertions and
 * `<T>x` assertions — is returned as-is and left to the caller's
 * refuse-rather-than-guess check.
 *
 * @param {import("typescript").Node} node
 * @returns {import("typescript").Node} the first node that is none of the three wrappers.
 */
export function unwrapExpression(node) {
  let current = node;
  for (;;) {
    if (
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isParenthesizedExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}
```

Body is a verbatim move of either current copy (they are byte-identical; pick one, delete both). JSDoc states the three-wrapper contract and the non-goal explicitly so the next editor does not "helpfully" widen it.

### 3.2 `generate-ingestion-checks.mjs`

- **Delete** local symbol `unwrapExpression` (the 14-line helper plus its `/** Strip … */` doc line).
- **Add** to the existing `./generatedArtifacts.mjs` import region a second import line:
  `import { unwrapExpression } from "./tsAstHelpers.mjs";`
  (`ts` import stays — the file still uses `ts.is*` predicates directly in `readCheckRow`, `parseIngestionChecks`, `extractCitedIngestionChecks`.)
- **Leave** call sites `readCheckRow` (`unwrapExpression(property.initializer)`) and `parseIngestionChecks` (`unwrapExpression(declaration.initializer)`) textually unchanged — they now resolve to the import.
- Header comment ("Extraction is STRUCTURAL … the idiom of generate-executor-producers.mjs and generate-spec-mirrors.mjs") unchanged.

### 3.3 `generate-spec-mirrors.mjs`

- **Delete** local symbol `unwrapExpression` (doc line + 14-line body).
- **Add** `import { unwrapExpression } from "./tsAstHelpers.mjs";` alongside the existing `spliceGeneratedBlock` import.
- **Leave** call sites `exportedInitializer`, `readStringConstants`, `parseArtifactDefinitions` textually unchanged.
- (`ts` import stays — used throughout the parsers.)

### 3.4 Hardening (same file, opt-out-able): `parseExecutorRegistry` + `parseDependencyMap`

- In `parseExecutorRegistry`, change `const value = property.initializer;` to `const value = unwrapExpression(property.initializer);` so `id`/`kind`/`obligation_ids` accept the same `as const`-wrapped literals the artifact parser already accepts.
- In `parseDependencyMap`, change `const value = property.initializer;` to `const value = unwrapExpression(property.initializer);` for the dependency-array test. (The computed-key path already resolves through constants; the `resolveName(element, …)` element reads stay as-is — elements are bare literals by contract.)
- Each change keeps the existing refusal messages; only the node under test is peeled first. If the owner wants a zero-behavior-delta move, skip this sub-step — the shared helper still lands identically.

### 3.5 Fallback variant (if owner mandates the ONE-substrate reading)

Skip the new file; instead append the §3.1 export to `generatedArtifacts.mjs` (adding `import ts from "typescript"` there) and import `unwrapExpression` from `"./generatedArtifacts.mjs"` in both consumers. All call-site edits in §3.2–§3.4 are otherwise identical. Cost: every `generatedArtifacts.mjs` consumer pays the compiler load.

---

## 4. Step-by-Step Implementation Sequence

1. **Snapshot current renders (parity baseline).** Run both generators in write mode on a clean tree and confirm no diff, then save the outputs for comparison:
   `node scripts/shared/generate-ingestion-checks.mjs` → `git diff --stat` clean;
   `node scripts/shared/generate-spec-mirrors.mjs` → clean. Copy the rendered block/regions to temp files (outside the repo) as the byte-parity oracle.
2. **Create `scripts/shared/tsAstHelpers.mjs`.** Add the §3.1 module verbatim (move, not rewrite). Run `node --check` on it.
3. **Migrate `generate-spec-mirrors.mjs`.** Delete local `unwrapExpression`, add the shared import (§3.3). Run `node --check`, then `--check`-mode gate and write-mode parity check against the §1 baseline (must be byte-identical).
4. **Migrate `generate-ingestion-checks.mjs`.** Same: delete local, add import (§3.2). `node --check`, gate + parity check.
5. **Normalize the two missed peel sites** (`parseExecutorRegistry`, `parseDependencyMap` per §3.4). Re-run parity: renders must still be byte-identical on the current registries (the registries use bare literals today, so peeling is a no-op on them — any diff here is a red flag, not an improvement).
6. **Prove the peel with a scratch fixture** (not a tracked-file mutation): feed `parseIngestionChecks`, `parseArtifactDefinitions`, and the newly-wrapped executor/dependency readers a synthetic source string wrapping the registry in `as const satisfies` + parentheses, and confirm all four accept it while an `x!`-wrapped variant still refuses. (Throwaway script or REPL; do not commit the fixture — or commit it as the unit test in §5.)
7. **Run the verification plan (§5) in full**, then update the catalog note: `docs/reviews/duplication-and-complexity-catalog-2026-09-05.md` item 2.5 describes stale banner/dry-run duplication already fixed by `generatedArtifacts.mjs` — append a pointer to this plan noting the residual twin is now consolidated, so the next sweep does not re-report it.

---

## 5. Verification & Regression Test Plan

### 5.1 New unit test (the only test change)

Add `tests/shared/ts-ast-helpers.test.ts` (vitest, mirroring repo test style) covering the shared contract directly:

- `as const`-wrapped array literal unwraps to the array literal.
- `satisfies T`-wrapped object literal unwraps to the object literal.
- Parenthesized literal unwraps; **nested** `((X as const))` unwraps fully (loop, not single peel).
- Bare literal returns identical node (no-op).
- Non-null assertion (`"x"!`) and numeric literal pass through **unpeeled** (pins the §1 non-goal: caller refusals still fire).
- `exportedInitializer`-style flow: a synthetic `export const R = […] as const satisfies …;` source parses and the unwrapped initializer `isArrayLiteralExpression`.

No existing test file is modified; existing drift tests become regression witnesses unchanged (any behavior change breaks them).

### 5.2 Gates and suites (in order)

1. `node --check scripts/shared/tsAstHelpers.mjs`, `node --check` on both edited generators (syntax).
2. `npm run check:ingestion-checks` and `npm run check:spec-mirrors` (the `--check` byte-parity gates) — must pass on an untouched tree.
3. Targeted vitest: `tests/shared/ingestion-checks-drift.test.ts`, `tests/shared/spec-mirror-drift.test.ts`, `tests/shared/generated-artifacts-splice.test.ts` (substrate untouched — must stay green), plus the new `tests/shared/ts-ast-helpers.test.ts`.
4. Byte-parity proof: write-mode runs of both generators against the §4 baseline produce **empty `git diff`** on all generated outputs (`docs/audit-pkg/contracts.md`, `spec/audit/artifact-contract.md`, `spec/audit/executor-catalog.md`, `spec/audit/dependency-map.md`).
5. Full suite (`npm test` / the repo's verify flow) before commit — the change is load-bearing-adjacent (doc gates run in CI via `.github/workflows/ci.yml` trigger paths listing both generator scripts), so CI parity matters.

### 5.3 Rollback and risk

- Risk is minimal: pure move of a pure function; both old copies are recoverable from git. If any gate reds, revert the two import/deletion edits and delete the new module — the tree is back to the current state with no output changes.
- The §3.4 hardening is the only sub-step that can change refusal behavior; it is independently revertible (two one-line restores) without touching the shared-helper move. If it reds any drift test, revert it and land the move alone.
