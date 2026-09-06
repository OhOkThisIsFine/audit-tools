# Refactoring Plan: Item 3.1 - Manifest String Array Extractors

## Item Overview & Current State

- **Item:** 3.1 Manifest String Array Extractors
- **Files Involved:**
  - src/audit/extractors/graphManifestEdges/toml.ts (symbol: `tomlStringArray`)
  - src/audit/extractors/graphManifestEdges/yaml.ts (symbol: `yamlStringArray`)
- **Key Symbols:** `tomlStringArray`, `yamlStringArray`, `extractTomlManifestEdges`, `extractYamlManifestEdges`
- **Prior Sweep & Verification Findings:**
  Byte-for-byte identical array coercion operating on post-parse JavaScript values (typeof value === "string" ? [value] : Array.isArray(value) ? ...).
  Operates on parsed primitives, not parser ASTs, so unifying does not couple TOML and YAML parsers.

---

## 1. Architectural Rationale & Boundary Analysis

### 1.1 The duplication, precisely

`tomlStringArray` (`toml.ts`) and `yamlStringArray` (`yaml.ts`) have **identical
bodies** — only the doc comments differ:

```ts
const raw =
  typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.filter((v): v is string => typeof v === "string")
      : [];
return raw.map((s) => s.trim()).filter((s) => s.length > 0);
```

Semantics: a bare string scalar coerces to a one-element array (TOML allows
`testpaths = "tests"`; YAML allows `packages: foo`), an array keeps only its
string elements, anything else (`undefined`, `null`, numbers, booleans, tables /
maps) coerces to `[]`. Results are trimmed with empties dropped, matching the
prior line-scanner extractor's behavior.

### 1.2 Why this is safe to unify (parser boundary)

Both helpers operate on **post-parse plain JavaScript values** (`unknown`), not
on parser ASTs. The TOML side parses with `smol-toml`, the YAML side with
`yaml` (eemeli) — but by the time `tomlStringArray` / `yamlStringArray` runs,
both parsers have produced ordinary `string | unknown[] | object` values and
the parser-specific work is over. A shared coercion therefore **does not couple
the two vetted parsers**: `toml.ts` keeps importing `smol-toml`, `yaml.ts`
keeps importing `yaml`, and neither imports the other's parser. The shared
function has zero parser dependencies.

### 1.3 Correct home for the shared helper

The natural home is the existing shared manifest module,
`src/audit/extractors/graphManifestEdges/workspace.ts`, which already owns the
cross-ecosystem manifest utilities (`WorkspacePattern`, `addWorkspacePattern`,
`workspaceMemberEdges`, `collectWorkspacePatternValues`). It imports only
`graphPathUtils.js` — no parser — so adding a pure `unknown → string[]`
coercion introduces **no new dependency edge and no import cycle**. Alternative
considered and rejected: `src/shared/` — the helper is manifest-extractor
specific (scalar-or-sequence coercion with trim/drop-empty manifest semantics),
not a general-purpose utility, and the sibling `asStringArray` helpers in
`browserExtension.ts` and `testPlanCarry.ts` deliberately have *different*
semantics (no scalar coercion, no trimming), so unifying with those would change
behavior. Keep this refactor scoped to the two identical manifest helpers.

### 1.4 Naming discrepancy (recorded, not blocking)

The symbols `extractTomlManifestEdges` and `extractYamlManifestEdges` named in
the item brief **do not exist in the tree** (verified by repo-wide grep — zero
hits). The actual edge-entry symbols are:

- TOML side: `extractCargoWorkspaceMemberEdges` (`cargo.ts`), which reads via
  `cargoWorkspacePatterns`, and `extractPyprojectTestpathLinks`
  (`pyproject.ts`), which reads via `pyprojectTestpaths`.
- YAML side: `extractWorkspacePackageEdges` (packageJson/workspace path,
  fed by `pnpmWorkspacePatterns` in `pnpm.ts`) and
  `extractYamlPathReferenceEdges` (`yamlPaths.ts` — does **not** use
  `yamlStringArray`; it walks scalars via `collectYamlStringScalars`).

The refactor therefore touches the `tomlStringArray` / `yamlStringArray`
helpers and their four call sites, not any `extract*ManifestEdges` symbol.
If a follow-up renames or introduces umbrella `extractTomlManifestEdges` /
`extractYamlManifestEdges` entry points, that is a separate item.

### 1.5 Considered but out of scope

- `collectWorkspacePatternValues` (`workspace.ts`): array-only, no scalar
  coercion, no trim/filter of its own (relies on `addWorkspacePattern` to
  trim/drop). Overlapping but not identical — callers pass already-typed arrays.
  Leave alone.
- The double-trim (`tomlStringArray`/`yamlStringArray` trim, then
  `addWorkspacePattern` trims again): harmless and idempotent. Do not "optimize"
  it away in this refactor — it keeps each layer's contract self-contained
  (the pyproject path never passes through `addWorkspacePattern` at all, so the
  coercion-layer trim is load-bearing there).

## 2. Blast Radius & Affected Files

### 2.1 Direct changes (3 source files + 1 test file)

| File | Symbol(s) | Change |
|---|---|---|
| `src/audit/extractors/graphManifestEdges/workspace.ts` | (new) `manifestStringArray` | Add the single shared coercion (pure, no parser imports) |
| `src/audit/extractors/graphManifestEdges/toml.ts` | `tomlStringArray` | Reimplement as thin wrapper over `manifestStringArray` (or remove; see §3, Option A vs B) |
| `src/audit/extractors/graphManifestEdges/yaml.ts` | `yamlStringArray` | Reimplement as thin wrapper over `manifestStringArray` (or remove; see §3) |
| `tests/audit/graph-manifest-edges.test.ts` | `tomlStringArray` / `yamlStringArray` test imports | Update imports if wrappers are removed; add shared-helper cases either way |

### 2.2 Transitive callers (behavior-preserving; no edits needed beyond import source)

| Caller | File | Call |
|---|---|---|
| `cargoWorkspacePatterns` | `cargo.ts` | `tomlStringArray(workspace.members)`, `tomlStringArray(workspace.exclude)` |
| `pyprojectTestpaths` | `pyproject.ts` | `tomlStringArray(iniOptions?.testpaths)` |
| `pnpmWorkspacePatterns` | `pnpm.ts` | `yamlStringArray(root?.packages)` |

Total: **4 call sites in 3 files**. All pass post-parse `unknown` values and
consume `string[]`; swapping the underlying implementation for an identical one
is behavior-preserving by construction.

### 2.3 Explicitly NOT affected

- `yamlPaths.ts` (`extractYamlPathReferenceEdges` → `collectYamlStringScalars`):
  different helper, different semantics (recursive scalar walk). Regression
  coverage only.
- `index.ts`: re-exports edge extractors, not the string-array helpers. No change.
- `browserExtension.ts` `asStringArray`, `testPlanCarry.ts` `asStringArray`:
  different semantics (no scalar→`[s]`, no trim). Out of scope — do not touch.
- No public API surface beyond the repo: these helpers are imported only by the
  sibling extractor modules and the test file (no external package consumers;
  single-package repo).

### 2.4 Risk assessment

**Low.** Pure function, no I/O, no parser coupling, four call sites, full unit
coverage of both helpers plus end-to-end edge tests (Cargo dotted-key /
inline-table, pyproject scalar + dotted header, pnpm inline-flow, malformed
input degradation). The only decision with blast-radius consequences is
Option A (keep thin wrappers, zero caller/test churn) vs Option B (remove
wrappers, touch 3 caller files + test imports) — see §3.

## 3. Specific Code Modifications (Symbol-Located)

### 3.1 New shared helper in `workspace.ts`

Add alongside `addWorkspacePattern` / `collectWorkspacePatternValues`:

```ts
/**
 * Coerce a post-parse manifest value to a string[]: a string scalar → `[s]`
 * (both TOML and YAML allow a bare scalar where a list is expected), a string
 * array → its string elements, anything else → `[]`. Trims and drops empties
 * to match the prior line-scanner extractors' behavior. Operates on plain JS
 * values, so it is parser-agnostic — shared by the TOML (`smol-toml`) and YAML
 * (`yaml`) sides without coupling the parsers.
 */
export function manifestStringArray(value: unknown): string[] {
  const raw =
    typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value.filter((v): v is string => typeof v === "string")
        : [];
  return raw.map((s) => s.trim()).filter((s) => s.length > 0);
}
```

`workspace.ts` gains no imports (pure function of `unknown`).

### 3.2 Option A (recommended): thin wrappers in `toml.ts` / `yaml.ts`

- Symbol `tomlStringArray` (`toml.ts`): keep the export, replace the body with
  `return manifestStringArray(value);`, add `import { manifestStringArray }
  from "./workspace.js";`. Keep its TOML-specific doc comment (mentioning the
  bare `testpaths = "tests"` scalar form) and mark it as delegating to the
  shared helper.
- Symbol `yamlStringArray` (`yaml.ts`): same treatment — keep the export,
  delegate to `manifestStringArray`, keep the YAML doc comment.
- Callers (`cargoWorkspacePatterns`, `pyprojectTestpaths`,
  `pnpmWorkspacePatterns`) and the test file: **unchanged**.

Rationale: zero churn at call sites and in tests; the per-format names remain
as discoverable, format-documented aliases; a future format-specific divergence
(e.g. YAML null/`~` handling) has a place to land without re-splitting. Cost:
two one-line wrappers — negligible.

### 3.3 Option B (alternative): remove wrappers, point callers at shared helper

- Delete `tomlStringArray` from `toml.ts` and `yamlStringArray` from `yaml.ts`.
- Symbol `cargoWorkspacePatterns` (`cargo.ts`): change import to
  `import { manifestStringArray } from "./workspace.js";`, replace both
  `tomlStringArray(...)` calls.
- Symbol `pyprojectTestpaths` (`pyproject.ts`): same import change, replace the
  single `tomlStringArray(...)` call.
- Symbol `pnpmWorkspacePatterns` (`pnpm.ts`): same import change, replace the
  single `yamlStringArray(...)` call.
- Test file: replace the `tomlStringArray` / `yamlStringArray` unit tests with
  `manifestStringArray` cases (keeping the same scalar / mixed-array /
  `undefined` assertions), leaving the end-to-end edge tests untouched.

Rationale: single source of truth, no alias indirection. Cost: touches 3 caller
files + test imports for no behavioral gain; loses the format-specific doc
anchors. Prefer Option A unless the repo's standing convention is
no-delegation-aliases (check the decision log in `CLAUDE.md` before choosing).

### 3.4 Semantics that must be preserved exactly (both options)

- `"tests"` → `["tests"]` (scalar coercion); `" a "` → `["a"]` (trim).
- `[" a ", "b", 3, null]` → `["a", "b"]` (non-strings dropped, empties dropped).
- `undefined` / `null` / `42` / `true` / `{...}` → `[]`.
- Whitespace-only strings (`"   "`) → dropped.
- Never throws on any input (callers rely on degrade-to-empty; malformed
  manifests are handled at the parse layer, but the coercion itself must stay
  total).

## 4. Step-by-Step Implementation Sequence

1. **Confirm convention**: check the standing-decisions log in `CLAUDE.md` for
   any ruling on shared-helper-vs-alias (cf. item 3.2's outcome) and pick
   Option A (default) or B.
2. **Add `manifestStringArray`** to
   `src/audit/extractors/graphManifestEdges/workspace.ts`, next to
   `collectWorkspacePatternValues`. No new imports.
3. **(A)** Rewrite `tomlStringArray` (`toml.ts`) and `yamlStringArray`
   (`yaml.ts`) as one-line delegations, keeping exports and doc comments; or
   **(B)** delete both, update the imports and call sites in `cargo.ts`
   (`cargoWorkspacePatterns`, 2 calls), `pyproject.ts` (`pyprojectTestpaths`,
   1 call), and `pnpm.ts` (`pnpmWorkspacePatterns`, 1 call).
4. **(B only)** Update `tests/audit/graph-manifest-edges.test.ts` imports and
   the two coercion unit tests to target `manifestStringArray`.
5. **Typecheck** (`tsc --noEmit` or the repo's typecheck script) — catches stale
   imports, especially under Option B.
6. **Run the manifest edge suite** (`tests/audit/graph-manifest-edges.test.ts`)
   — see §5.
7. **Run the full test suite + lint** to catch anything importing the helpers
   outside the known call sites (grep says there is none, but verify green).
8. **Review the diff**: the behavioral diff must be empty — only the shared
   helper addition plus delegation/import changes. No comment, confidence, or
   edge-kind changes ride along.

## 5. Verification & Regression Test Plan

### 5.1 Existing tests that gate this refactor (all in `tests/audit/graph-manifest-edges.test.ts`)

- `tomlStringArray coerces a scalar, an array, and rejects non-strings` —
  scalar→`[s]`, trim + non-string drop, `undefined`→`[]`.
- `yamlStringArray coerces a scalar, a sequence, and rejects non-strings` —
  same three properties on the YAML side. Under Option A both tests pass
  unchanged and thereby prove delegation preserves behavior; under Option B
  they are ported 1:1 to `manifestStringArray` (add a case asserting both old
  names — if kept — agree with the shared helper on scalar / mixed / empty).
- End-to-end callers (must pass untouched under either option):
  - Cargo dotted-key `workspace.members` recovery; inline-table
    `workspace = { members, exclude }` with exclude honored; multi-line TOML
    array parsing (`cargoWorkspacePatterns`).
  - Pyproject scalar `testpaths = "tests"` + dotted-header resolution
    (`extractPyprojectTestpathLinks`).
  - pnpm inline-flow `packages: [a, b]` recovery
    (`extractWorkspacePackageEdges`); nested-map path recovery
    (`extractYamlPathReferenceEdges` — guards the YAML module against
    collateral damage).
  - Malformed-input degradation: TOML extractors → `[]`, YAML extractors →
    `[]`, never throw.

### 5.2 New assertions to add

- Shared-helper parity test (Option A): for a fixed battery — `"tests"`,
  `" a "`, `"   "`, `[" a ", "b", 3, null, undefined]`, `undefined`, `null`,
  `42`, `true`, `{ members: ["a"] }` — assert
  `tomlStringArray(v)` deep-equals `yamlStringArray(v)` deep-equals
  `manifestStringArray(v)`. This is the test that would have caught the
  duplication and now pins the unification.
- Under Option B, the same battery runs once against `manifestStringArray`.

### 5.3 Regression procedure

1. Before the change: record green on `tests/audit/graph-manifest-edges.test.ts`
   (note: the file's imports use top-level await with `vitest`; run via the
   repo's configured runner, not bare `node:test`).
2. After the change: re-run the manifest suite, then the full suite
   (`npm test` / repo equivalent), plus typecheck and lint.
3. Mutation spot-check (optional, cheap): temporarily perturb the shared helper
   (e.g. drop the `.trim()`) and confirm the coercion unit tests go red —
   proves the tests actually gate the shared code path rather than passing
   vacuously.
4. Verify no other importers: repo-wide grep for `tomlStringArray`,
   `yamlStringArray` (and, under Option B, confirm zero remaining references
   to the deleted names) and for the phantom `extractTomlManifestEdges` /
   `extractYamlManifestEdges` (expected: still zero — no dangling references
   introduced).

### 5.4 Acceptance criteria

- Full suite green, typecheck green, lint green.
- Behavioral diff empty: all pre-existing manifest edge tests pass unmodified
  (Option A) or pass with only import/port changes to the two coercion unit
  tests (Option B).
- New parity battery green.
- No new dependencies, no parser imports cross between `toml.ts` and `yaml.ts`,
  no change to edge kinds, confidences, reasons, or public `index.ts` exports.
