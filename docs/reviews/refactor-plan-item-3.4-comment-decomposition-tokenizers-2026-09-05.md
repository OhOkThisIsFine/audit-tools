# Refactoring Plan: Item 3.4 - Comment Decomposition Tokenizers

## Item Overview & Current State

- **Item:** 3.4 Comment Decomposition Tokenizers
- **Files Involved:**
  - src/audit/extractors/commentDecomposition.ts
- **Key Symbols:** deriveCommentDecomposition, deriveDocGroups, referenceTokens, tokenOwner
- **Prior Sweep & Verification Findings:**
  Both functions share an identical ~15-line idiom for populating tokenOwner maps from tokenized paths, flagging ambiguities with an ambiguous sentinel, and sorting tokens longest-first.
  Safe intra-file extraction into a private helper.

- **Confirmed by inspection (this plan):**
  - `referenceTokens` is a single, non-duplicated pure tokenizer: for a posix path it emits the full path, the extensionless path, the last-two-segments form (plus its extensionless variant), and — only when the stem is >= 5 chars and not in `GENERIC_STEMS` — the basename WITH extension. The trailing filter keeps tokens containing `/` or equal to the basename. `GENERIC_STEMS` (`index`, `types`, `type`, `utils`, `util`, `helpers`, `helper`, `constants`, `main`, `mod`) exists solely to serve this tokenizer. Neither is duplicated; neither changes in this refactor.
  - The duplicated idiom is exactly three blocks, present once in `deriveCommentDecomposition` (indexing its `files` universe) and once in `deriveDocGroups` (indexing its `codeFiles` universe): (a) a `tokenOwner` build loop calling `referenceTokens` per file and flagging a token claimed by two files with a NUL-prefixed sentinel (which can never equal a real path), (b) a purge loop deleting sentinel entries, (c) a longest-first sort (`b.length - a.length || compareCodeUnits(a, b)`). The duplication catalog scores it at 28 matching AST nodes.
  - The two functions DIFFER outside the idiom and those differences stay put: the index universe (`files` vs `codeFiles`), the scanned corpus (per-file `extractCommentText` output vs each doc's entire text), and the accumulation (space-keyed `weightByPair` undirected edges vs per-doc `named` sets filtered to size >= 2 groups). Only (a)-(c) move.
  - Catalog line references for this item are stale (they cite line windows that no longer match the file). Locate everything by symbol per Section 3, never by line number.

---

## 1. Architectural Rationale & Boundary Analysis

The token index (owner map + longest-first token order) is a **private matching substrate** of the comment-decomposition extractor: it translates a file universe into the vocabulary that comment/doc text is scanned against. Both intent-declared derivations in the module — comment cross-reference edges (`deriveCommentDecomposition`) and doc-declared groups (`deriveDocGroups`) — are consumers of that substrate with different corpora and different accumulations. The index construction itself has exactly one meaning ("unambiguous reference tokens for this universe, most-specific first") and today has two spellings that must be kept identical by discipline. A single private helper replaces discipline with construction.

### 1.1 Correct home: a private (non-exported) helper in `src/audit/extractors/commentDecomposition.ts`, adjacent to `referenceTokens`

- The module already owns every piece of the idiom: `referenceTokens`, `GENERIC_STEMS`, the sentinel convention, and both consumers. Extraction introduces **no new import edge and no cycle risk** — the helper needs only `referenceTokens` and `compareCodeUnits`, both already in scope.
- The helper stays **private**. Its only consumers are the two functions in this file (verified: repo-wide grep for `deriveCommentDecomposition|deriveDocGroups` shows no other importers — see Section 2). Exporting it would advertise a contract (`Map` + sorted-array shape, sentinel purge semantics) that no external caller needs.
- Alternatives considered and rejected:
  - **New module (e.g. `src/audit/extractors/tokenIndex.ts`)** — justified only with a second consuming module; there is none, and a new file adds a seam plus an import edge for a ~15-line body. Acceptable fallback only if review prefers it; the rest of this plan is unchanged apart from the import path.
  - **`src/shared/`** — wrong layer. The token vocabulary (path-form variants, the `GENERIC_STEMS` distinctiveness rule, the longest-first order) serves only comment/doc reference matching. Nothing else in the repo builds reference tokens, and `shared/` would gain a single-consumer export coupled to this extractor's matching policy. Same reasoning as item 2.1's rejection of the engine-module home: do not hoist a one-consumer domain policy into shared vocabulary.
  - **Generalizing the scan loops too** — rejected. The loops differ irreducibly (comment-text-per-file with self-exclusion and pair-weight accumulation vs whole-doc-text with group-size filtering). A unified scanner parameterized over corpus-projection plus accumulation would be harder to read than the two explicit loops. This refactor extracts the identical part only.

### 1.2 What the helper owns and what stays at the call sites

- The helper owns ONLY index construction: build map, purge ambiguities, sort longest-first. It takes an already-normalized universe (`readonly string[]` of posix, deduped, sorted paths) and returns `{ tokenOwner, tokens }`. It does NOT normalize: both call sites already normalize (`toPosixPath` dedupe + `compareCodeUnits` sort) and `deriveDocGroups` normalizes TWO lists while indexing only one (`codeFiles`), so folding normalization into the helper would couple it to list selection for no gain.
- The matching loops, the corpus reads, and all accumulation stay at the call sites untouched.

### 1.3 Semantics that must be preserved verbatim

- The sentinel value and purge behavior: a token claimed by two files maps to the sentinel during the build and is deleted (not kept, not assigned arbitrarily) before matching. Bare-basename collisions (e.g. two `CHANGELOG.md`-style distinctive basenames in different dirs) therefore couple nothing — the "drop rather than couple arbitrarily" rule is load-bearing and stays.
- The longest-first token order including its tiebreak (`compareCodeUnits`). The order is preserved **even though it is currently inert**: both consumers test every token and accumulate owners into a set (no first-match-wins), so ordering cannot affect results — recorded as finding MNT-e3dd9a7f ("longest-first sort is inert and its justifying comment is false"). This refactor moves the sort and its justifying comment verbatim into the helper WITHOUT "fixing" either: dropping the sort or rewriting the comment expands a pure-relocation diff and orphans the finding. The finding stays open against the new location (Section 5 notes the re-verification).
- No change to `referenceTokens`, `GENERIC_STEMS`, either public signature, or determinism (sorted input, canonicalized pair orientation, sorted outputs all stay exactly as they are).

### 1.4 Explicitly out of scope (adjacent known defects — do NOT fix in this diff)

- **Space-joined pair keys** (`${a} ${b}` + `indexOf(" ")` decode): corrupts edges for paths containing spaces (finding COR-708ffb9a, shared with `deriveDataStateCoupling`). Key encoding is untouched; the helper must not change it.
- **Inert longest-first sort + false comment** (MNT-e3dd9a7f): preserved verbatim per above; fixing it is a separate behavior-justifying change.
- **`deriveDocGroups` has no scanned accounting** (OBS-708ffb9a): adding a `scannedFiles`-style return changes a public signature — separate item.
- **`buildStructureDecomposition` dropping `scannedFiles`** (OBS-f6b45af2): pipeline-level, separate item.
- **`defaultReadFileText` / `toPosixPath` duplication with `docsDigest` / `disposition`** (shared-helper-adoption debt): cross-module unification, separate item.
- No change to the comment-grammar half of the module (`scanCommentSpans`, `extractCommentText`, `stripCommentText`, `maskCommentSpans`, `extractCommentLines`, `strippedSourceLines`) or to `CommentDecompositionParams` / `DocGroupsParams` / `CommentDecompositionResult`.

---

## 2. Blast Radius & Affected Files

| File | Role in this refactor | Change class |
|---|---|---|
| `src/audit/extractors/commentDecomposition.ts` | New private helper + two call-site replacements | **Additive + local replacement (single file)** |
| `src/audit/decompose/buildStructureDecomposition.ts` | Imports `deriveCommentDecomposition` + `deriveDocGroups`; calls both with sorted universes | **Untouched** (helper is private; no import change) |
| `src/audit/decompose/sources.ts` | Consumes the outputs (`commentEdges`, `docGroups`) via `StructureSourcesInput` | **Untouched** (output shapes unchanged) |
| `src/audit/orchestrator/charterPackets.ts` | Imports `extractCommentLines` + `strippedSourceLines` from the same module | **Untouched symbols; regression net only** |
| `tests/audit/structure-decomposition.test.ts` | Direct coverage: cross-reference edges, non-comment exclusion, doc groups, end-to-end decomposition | **Untouched; primary regression net** |
| `tests/audit/charter-packets.test.ts` | Covers the untouched comment-grammar symbols of the same module | **Untouched; module regression net** |

- **No other importers.** Verified by repo-wide grep for `deriveCommentDecomposition|deriveDocGroups`: definition sites in `commentDecomposition.ts`; call sites in `buildStructureDecomposition.ts`; test imports in `structure-decomposition.test.ts`; type/doc mentions in `decompose/sources.ts`. `referenceTokens` and `tokenOwner` appear nowhere outside `commentDecomposition.ts`. No file outside the table references any touched symbol.
- **No runtime behavior change is intended or expected.** Pure relocation of identical blocks behind a private helper with identical inputs, identical outputs, and identical order. The existing suites assert exact edges/groups, so they are the regression net; no new behavior needs coverage.
- **Risks (all low):** (1) helper input-contract drift — mitigated: the helper takes the already-normalized arrays as-is and normalizes nothing itself, so call-site order/dedupe behavior cannot change; (2) accidental semantic "improvement" (dropping the inert sort, "fixing" the comment, changing the sentinel) — mitigated: Section 3 requires a verbatim move and Section 5 greps for residue; (3) stale catalog line refs misleading the implementer — mitigated: all locations below are by symbol.

---

## 3. Specific Code Modifications (Symbol-Located)

### 3.1 `referenceTokens` surroundings — add the single private helper

- Place the new helper immediately after `referenceTokens` (and before the `CommentDecompositionResult` interface / `deriveCommentDecomposition`), so the tokenizer, its stop-list (`GENERIC_STEMS`), and the index built on top of them read as one unit.
- Recommended name: `buildTokenIndex`. (Acceptable alternative: `buildReferenceTokenIndex`. Either is fine; pick one and use it at both call sites.)
- Signature: `(files: readonly string[]) => { tokenOwner: Map<string, string>; tokens: string[] }`, where `files` is the already-normalized universe (posix, deduped, `compareCodeUnits`-sorted — exactly what each call site holds today in its `files` / `codeFiles` local).
- Body: the verbatim move of the three blocks — the `tokenOwner` build loop over `files` calling `referenceTokens` with the sentinel-on-collision rule, the purge loop deleting sentinel entries, and the longest-first sort. No normalization, no reading, no matching inside.
- JSDoc: what the index is (unambiguous reference token → owning file, plus longest-first token order), the input contract (already posix-normalized/deduped/sorted), the ambiguity rule (shared tokens are dropped, never assigned arbitrarily), and a pointer noting the ordering's known-inert status (finding MNT-e3dd9a7f) so a future fix has context — WITHOUT changing the sort or its moved inline comment.
- No new imports: `referenceTokens` and `compareCodeUnits` are already in scope. The helper is NOT exported.

### 3.2 `deriveCommentDecomposition` — replace the idiom with a call

- Delete its local `tokenOwner` build loop, purge loop, and longest-first sort; replace with a single `const { tokenOwner, tokens } = buildTokenIndex(files);` over its existing normalized `files` local.
- Everything else untouched: universe normalization, the per-file read + `scannedFiles` count, `extractCommentText` + `toPosixPath` scan, the `referenced`-set accumulation with self-exclusion, the space-keyed `weightByPair` canonicalization, and the edge sort.

### 3.3 `deriveDocGroups` — replace the idiom with a call

- Delete its local `tokenOwner` build loop, purge loop, and longest-first sort; replace with a single `const { tokenOwner, tokens } = buildTokenIndex(codeFiles);` over its existing normalized `codeFiles` local. Note the argument is `codeFiles`, NOT `docFiles` — the docs are the scanned corpus, the code files are the indexed universe. Mixing these up is the highest-risk typo in this refactor; the structural check in Section 5 guards it.
- Everything else untouched: both list normalizations, the per-doc read + skip-on-undefined, whole-text `toPosixPath` scan, the `named`-set accumulation, the size->=2 filter, and both sorts.

### 3.4 What does NOT change

- `referenceTokens`, `GENERIC_STEMS`, `CommentDecompositionParams`, `DocGroupsParams`, `CommentDecompositionResult`, both public signatures, the sentinel literal, the sort comparator, the sort's inline comment text, and every symbol in the comment-grammar half of the module.

---

## 4. Step-by-Step Implementation Sequence

1. **Add the helper.** In `src/audit/extractors/commentDecomposition.ts`, insert private `buildTokenIndex` after `referenceTokens` with the verbatim-moved three blocks and the Section-3a jsdoc. Typecheck the file — it must compile with zero new imports (both names already in scope) even before the call sites convert (unused-function lint may flag it transiently; that clears in the next steps).
2. **Convert `deriveCommentDecomposition`.** Replace its three index blocks with the `buildTokenIndex(files)` call. Confirm the rest of the body still resolves `tokenOwner` and `tokens` from the destructuring.
3. **Convert `deriveDocGroups`.** Replace its three index blocks with the `buildTokenIndex(codeFiles)` call — double-check the argument is the code universe, not the doc list. Confirm the rest of the body still resolves both names.
4. **Sweep for residue.** Grep `tokenOwner` in `src/`: expect the helper (parameter/return/local), the two destructurings, and the existing per-loop uses — zero remaining build/purge/sort blocks. Grep `ambiguous` (sentinel): expect occurrences only inside the helper. Grep `referenceTokens`: expect exactly one definition plus one call site (inside the helper), down from two. Grep `longest-first`: expect exactly one occurrence (inside the helper, with its original comment text preserved).
5. **Verify** per Section 5, then commit as a single pure-relocation commit (no behavior mixed in).

---

## 5. Verification & Regression Test Plan

- **Typecheck + lint.** Full repo typecheck and eslint over the touched file. This catches the highest-risk failure mode of a relocation: a missed binding or a stale reference. Must be clean (modulo the transient unused-function note between steps 1 and 2, which must not survive step 3).
- **Targeted tests.** Run `tests/audit/structure-decomposition.test.ts` — it directly exercises both moved consumers' contracts (path-named cross-reference edges with `scannedFiles`, code-text-only exclusion, single-doc grouping). Must pass unmodified.
- **Module regression.** Run `tests/audit/charter-packets.test.ts` — it covers the untouched comment-grammar symbols of the same module (`extractCommentText`, `stripCommentText`, `strippedSourceLines`, `extractCommentLines`, including the astral/line-truth cases). Must pass unmodified, proving the edited module's other half was not disturbed.
- **Wider regression.** Run the full audit suites covering the call chain (`buildStructureDecomposition`, `sources.ts` consumers, structure executors). Because the change is behavior-preserving by construction, the existing suites are the regression net — any failure here means the relocation was not pure and must be investigated as a moved-body discrepancy (most suspect: wrong helper argument in `deriveDocGroups`, altered sentinel, dropped/reordered sort), not as a test update.
- **Structural assertions (manual, cheap).**
  - `referenceTokens`: one definition, one call site (the helper).
  - Sentinel/`longest-first` comment: present exactly once, inside the helper, byte-identical text.
  - `deriveDocGroups` calls the helper with `codeFiles`.
  - `git diff --stat`: exactly one file modified (`src/audit/extractors/commentDecomposition.ts`), no test or caller changes.
- **Post-merge finding hygiene.** Re-verify finding MNT-e3dd9a7f against the new location (the inert sort + false comment now live in `buildTokenIndex`): confirm the finding's claim still holds verbatim and update its recorded location/symbol so the open item tracks the helper instead of the two former call sites. No other finding changes (COR-708ffb9a, OBS-708ffb9a, OBS-f6b45af2, and the shared-helper-adoption debt are untouched by construction).
