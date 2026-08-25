# Shared-helper adoption sweep — 2026-08-25

Evidence record for three open-bugs entries. The question asked was "where could an elegant
solution already in this codebase replace overly-complex code". The answer, repeatedly, is that the
elegant solution already exists, is exported, and carries a comment saying it is the only one —
and then 30+ sites re-roll it anyway. This is adoption debt, not missing abstraction.

## Method, and its limits

Knowledge-graph queries over the indexed tree (`C-Code-audit-tools`, 20,791 nodes / 69,288 edges):
complexity properties (`cognitive`, `complexity`, `loop_depth`, `linear_scan_in_loop`), duplicate
function names grouped by distinct file, and `SIMILAR_TO` edges. Every candidate was then read at
source before being written down.

A fan-out workflow was launched to verify each cluster with an independent agent plus an adversarial
refutation pass. It returned nothing: the account hit its monthly spend limit and all seven agents
errored before doing any work. **So this is single-pass evidence with no independent refutation.**
Treat the site lists as verified (each was read) and the severity judgments as unreviewed.

Citations are by SYMBOL, not line number, per the standing trap in
[`durable-traps.md`](../backlog/durable-traps.md).

## The canonical helpers that already exist

| Helper | Home | Reachable as |
|---|---|---|
| `resolveWithinRoot`, `assertWithinRoot` | `src/shared/io/pathContainment.ts` | barrel |
| `isRecord`, `pushValidationIssue`, `requireKeys`, `describeValue` | `src/shared/validation/basic.ts` | barrel |
| `compareCodeUnits` | `src/shared/submission/hostHandoffCore.ts` AND `src/shared/affinityArtifacts.ts` | barrel (the first) |
| `hashContent` | `src/shared/hash.ts` | barrel |
| `stableStringify` | `src/shared/stableStringify.ts` | barrel |
| `scanStringAware` | `src/shared/parsing/stringAwareScanner.ts` | barrel |
| `normalizeRepoPath` (case-FOLDED) | `src/shared/validation/findingGrounding.ts` | barrel |
| `posixify` (case-PRESERVED) | `src/shared/analyzers/normalizeExternal.ts` | private |

## F1 — the root-containment guard, forked four ways

`src/shared/io/pathContainment.ts` is the declared single source. Its own docstring states the case:

> This check was reimplemented across audit artifact paths, analyzer include mapping, graph
> extraction, and remediation worktree seeding. [...] Five copies of a containment check is five
> chances for one to be subtly wrong, and this is the class where that is a security property, not a
> style preference.
>
> Callers differ only in how they REACT (throw / null / skip) and whether the root itself counts as
> contained — both are parameters here, not reasons to fork the predicate.

Both axes are already parameters: `assertWithinRoot` throws, `resolveWithinRoot` returns `null`, and
`allowRoot` decides whether the root itself is contained. `tests/shared/path-containment.test.ts`
pins the edge cases — a `..cache` entry is inside, a `..`-segment is outside, a cross-drive
`relative()` result is outside, and the root itself flips with `allowRoot`.

Production adopters: two. `resolveWithinRoot` is called in `src/audit/extractors/analyzers/typescript.ts`
and `src/audit/extractors/graph.ts`.

Four live forks remain, each re-deriving the predicate by hand, and none of them reached by that
test suite:

| Fork | File | Reaction | Root itself | Maps to |
|---|---|---|---|---|
| `canonicalPath` | `src/shared/analyzerPolicy.ts` | throws | rejected | `assertWithinRoot(root, p, { allowRoot: false })` |
| `canonicalIntentPath` | `src/shared/sessionConfig.ts` | throws | rejected | the same, with the candidate bound to the session-intent path |
| `isOutsideRoot` | `src/remediate/utils/fileIntegrity.ts` | boolean | accepted | `resolveWithinRoot(root, p) === null` |
| inline check | `src/shared/submission/submissionIdentity.ts` | throws | n/a | first-segment split rather than the shared predicate |

`canonicalPath` and `canonicalIntentPath` are the same 22-line function; only the bound second
argument and the error string differ. `canonicalPath` has two callers inside `analyzerPolicy.ts`,
`canonicalIntentPath` one inside `sessionConfig.ts`, `isOutsideRoot` two inside `fileIntegrity.ts`.

**What is NOT claimed.** The forks all use the segment-accurate `` `..${sep}` `` form, so none of
them carries the `..cache` false-reject the shared module's docstring describes, and no live escape
was demonstrated. The finding is that a guard the repo itself classifies as a security property is
maintained in five places, four of which no test covers.

## F2 — `isRecord`, nine definitions, one of them weaker

Canonical: `isRecord` in `src/shared/validation/basic.ts`, barrel-exported —
`typeof value === "object" && value !== null && !Array.isArray(value)`.

Byte-equivalent copies: `src/audit/extractors/browserExtension.ts`,
`src/audit/orchestrator/selectiveDeepening/shared.ts` (exported; one importer, `stewardFollowup.ts`),
`src/audit/supervisor/runLedger.ts`, `src/remediate/contractPipeline/testPlanCarry.ts`,
`src/shared/analyzers/candidates.ts` (spelled with `Boolean(value)`, equivalent for objects),
`src/shared/decompose/contentCoherence.ts`, `src/shared/submission/hostHandoffCore.ts` (exported; the
barrel re-exports this one).

Divergent copy — `src/audit/orchestrator.ts`:

```ts
return value !== null && typeof value === "object";
```

It omits `!Array.isArray`, so an array satisfies a guard named "is record". No live defect:
`assertUnitManifest` reads a property immediately after each check and throws on `undefined`. It is a
latent hole, and it is why the class matters more than the count.

## F3 — `compareCodeUnits`, seven definitions and two exported homes

Identical body everywhere: `left < right ? -1 : left > right ? 1 : 0`.

- Exported twice: `src/shared/submission/hostHandoffCore.ts` (the barrel's source) and
  `src/shared/affinityArtifacts.ts`.
- Consumers are split across the two. `src/shared/artifactFreshness.ts`,
  `src/shared/decompose/workBlockSeams.ts` and `src/remediate/steps/contractPipeline.ts` import the
  `affinityArtifacts` one; `src/remediate/steps/dispatch/hostHandoff.ts` imports the barrel.
- `src/remediate/steps/contractPipeline.ts` reaches it by relative path rather than through the
  `audit-tools/shared` subpath export.
- Private redefinitions: `src/shared/stableStringify.ts`, `src/shared/decompose/contentCoherence.ts`,
  `src/audit/orchestrator/partitionTaskGraph.ts`, `src/audit/orchestrator/reviewPackets.ts`,
  `src/audit/reporting/workBlocks.ts`.

`src/shared/stableStringify.ts` opens with "There must be exactly ONE such serializer — never write a
second." Its own comparator is the seventh copy of a different one-and-only-one primitive.

## F4 — ICU collation on arrays the same file says must be code-unit ordered

`src/remediate/steps/contractPipeline.ts` states the invariant inline: code-unit order, never
`localeCompare`, on every persisted seed array, because the seed order must not depend on the host's
ICU collation. It imports `compareCodeUnits` and applies it correctly to the work-block and seam
seeds.

The same file then uses `localeCompare` at seven other sorts, including the findings array and each
finding's affected-files array promoted into the extracted plan.

The two comparators genuinely disagree on mixed case: by code unit `"B"` (0x42) precedes `"a"`
(0x61); ICU puts `"a"` first. A content hash taken over an ICU-ordered array therefore varies with
the host locale — the phantom-staleness cascade already fought once for repo-manifest file order
(memory: staleness-churn-repo-manifest-file-order).

150 `localeCompare` sites exist across `src/`, concentrated in
`src/shared/decompose/charterExtraction.ts`, `src/audit/extractors/commentDecomposition.ts`,
`src/remediate/steps/contractPipeline.ts`, `src/shared/decompose/consensus.ts` and
`src/audit/orchestrator/fileAnchors.ts`. Which of them feed a persisted artifact rather than a human
render is the open question, and is why the property below is a gate rather than a blanket
replacement.

One related divergence worth noting: `pairKey` in `src/shared/decompose/consensus.ts` canonicalizes
its pair with `localeCompare`, while `pairKey` in `src/shared/decompose/contentCoherence.ts`
canonicalizes with `compareCodeUnits` — two canonical-pair keys in the same directory, ordered by
different comparators.

## F5 — `hashContent` bypassed five times, once by the exact anti-pattern it names

`src/shared/hash.ts` says it is "the single source for SHA-256 content hashing across both
orchestrators" and that "No call site should carry a bare `.slice(0, N)` literal on a hash result
anymore."

- `workBlockSeamId` in `src/shared/decompose/workBlockSeams.ts` carries exactly that truncation
  literal. Equivalent: `hashContent(file, { length: 12 })`.
- `src/shared/contentKey.ts` — private `sha256(value: string)`. Equivalent: `hashContent(value)`.
- `src/shared/analyzers/binaryAcquisition.ts` — private `sha256(bytes)`. Equivalent:
  `hashContent(bytes)`.
- `hashArtifactValue` in `src/shared/artifactFreshness.ts` — inline chain over `stableStringify`.
- `src/audit/orchestrator/artifactMetadata.ts` — inline chain over a joined entry list.

`src/remediate/utils/fileIntegrity.ts` is the model adopter; its comment already states that no
inline hash construction remains in it.

Deliberately excluded: `buildToolingManifest` in `src/audit/io/toolingManifest.ts` builds its digest
incrementally across a directory walk, so it is not a `hashContent` call.

## F6 — path normalization: ten definitions, two behaviours

Posix-only (backslash to forward slash): `toPosix` in
`src/audit/decompose/buildStructureDecomposition.ts`, `src/audit/decompose/sources.ts`,
`src/audit/extractors/commentDecomposition.ts` and `src/audit/extractors/docsDigest.ts`;
`normalizePath` in `src/audit/extractors/fsIntake.ts`, `src/audit/reporting/workBlocks.ts` and
`src/shared/decompose/contentCoherence.ts`.

Posix plus a stripped leading `./`: `normalizePath` in `src/audit/orchestrator/fileAnchors.ts`;
`normalizeRepoRelPath` in `src/shared/constitutionalDocPaths.ts` and `src/shared/loopCorePaths.ts`.

The second behaviour is byte-identical to `posixify` in `src/shared/analyzers/normalizeExternal.ts`,
which is private. Its docstring already explains its relationship to the shared normalizer: it is
`normalizeRepoPath` without the case fold, "correct for membership matching and wrong for a path that
will be persisted and later re-read from a case-sensitive filesystem."

`normalizeRepoPath` in `src/shared/validation/findingGrounding.ts` is therefore NOT a drop-in for
either group — it lowercases, and invariant INV-B3-1 is documented at its definition.

## F7 — a JSONC comment stripper beside the scanner it imports

`src/audit/extractors/graphManifestEdges/jsonc.ts` imports `scanStringAware` and uses it in
`removeTrailingJsonCommas`. Its sibling `stripJsonComments` instead runs a private in-string and
escape state machine: cyclomatic 13, cognitive 37, one of the five most complex functions in `src/`.
Two quote grammars in one file, only one of them shared.

This is not a swap. `scanStringAware` owns its loop index and offers no skip-ahead, so a comment body
still reaches the unquoted callback and that callback must carry its own line- and block-comment
flag. The rewrite removes the quote-and-escape half, not the whole function. The two-tier dependency
rule in `CLAUDE.md` also bears on it, since JSONC is a grammar this repo does not own.

## F8 — exact twins

- `getExternalSignalPaths` — identical in `src/audit/orchestrator/requeueUtils.ts` (exported) and
  `src/audit/orchestrator/taskBuilder.ts` (private).
- `formatSchemaFailure` — identical in `src/shared/analyzerPolicy.ts` and `src/shared/sessionConfig.ts`.
- `errorMessage` — identical in `src/shared/io/json.ts` and `src/shared/sessionConfig.ts`.
- `defaultReadFileText` — identical in `src/audit/extractors/commentDecomposition.ts` and
  `src/audit/extractors/docsDigest.ts`.
- `pushIssue` in `src/audit/validation/artifacts.ts` is a pure pass-through to `pushValidationIssue`,
  which the same file already imports. (The `pushIssue` in `src/audit/validation/auditResults.ts` is a
  different function over a richer issue shape — not a twin.)

## Candidates checked and rejected

- **The five-file quote-scanner cluster is a false positive.** The graph flagged
  `onQuoteOpen` / `onQuoteClose` / `onUnquoted` as functions in five files, but in
  `src/audit/extractors/graphManifestEdges/go.ts`, `src/audit/extractors/graphPythonImports.ts`,
  `src/shared/tooling/repoConventions.ts` and `removeTrailingJsonCommas` those are callback objects
  already passed to `scanStringAware`. Only F7 holds out.
- **`stableStrings`** — the one in `src/audit/reporting/workBlocks.ts` is a three-line dedupe-and-sort;
  the one in `src/shared/decompose/contentCoherence.ts` is a validator taking field, item id and a
  normalizer. Different functions sharing a name.
- **`canonicalPair`** — the one in `src/shared/decompose/charterExtraction.ts` orders a charter-kind
  pair against a domain array; the one in `src/shared/decompose/contentCoherence.ts` orders two
  strings. Different functions sharing a name.
- **`tests/shared/fixtures/remediation-contracts/contract-harness.ts`** keeps its own
  `compareCodeUnits`. Leave it: a test oracle must not import the code it validates.

## Constraints any future lap must respect

- **No `src/shared/index.ts` import from inside `src/shared`.** `src/shared/submission/hostHandoffCore.ts`
  documents a circular import that `check:depgraph` refuses; shared-internal modules use relative deep
  imports.
- **`check:deadcode` reds an export with no consumer**, so a newly-exported helper must land in the
  same commit as its adopters (memory: additive-export-without-adopter-fails-the-deadcode-gate).
- **Loop-core attestation** applies to `src/remediate/steps/contractPipeline.ts`,
  `src/remediate/steps/dispatch/hostHandoff.ts` and `src/remediate/steps/nextStep.ts`.
- **Atomic replace**: the new mechanism and the deleted copies ship in one commit.
- Import direction: `src/shared` never imports `src/audit` or `src/remediate`.

## Related, not duplicated

The one-core dissolution lap in [`forward-tracks.md`](../backlog/forward-tracks.md) covers
whole-subsystem forks between the audit and remediate host-handoff modules. This record is the
finer grain: individual primitives with a declared single home, re-rolled inside both halves and
inside `src/shared` itself.
