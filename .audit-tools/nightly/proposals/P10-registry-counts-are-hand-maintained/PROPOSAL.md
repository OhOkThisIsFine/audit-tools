# P10 — a doc that states "N entries" of a code registry is a drift test made of memory, and two drifted at once

## What happened tonight

Two docs each state the size of a code registry in prose. Both were wrong, from the same commit,
and neither could be auto-fixed:

| Doc | Claim | Actual at HEAD |
|---|---|---|
| `spec/audit/artifact-contract.md:17` | `src/audit/io/artifacts.ts` — **38 entries** | 37 (`ARTIFACT_DEFINITIONS`) |
| `spec/audit/executor-catalog.md:10` | `src/audit/orchestrator/executors.ts` — **28 entries** | 27 (`EXECUTOR_REGISTRY`) |

Both shed their entry in `6df1f477` (the dispatch inversion, which retired `provider_confirmation`)
— a commit with no reason to know two prose counts existed. Reviewer and adversary counted
independently and agreed; the runtime values confirm it:

```
$ node --input-type=module -e "import('./dist/audit/io/artifacts.js').then(m=>console.log(Object.keys(m.ARTIFACT_DEFINITIONS).length))"
37
$ node --input-type=module -e "import('./dist/audit/orchestrator/executors.js').then(m=>console.log(m.EXECUTOR_REGISTRY.length))"
27
```

## Why this is worse than an ordinary stale fact

Both files are **constitutional** (`src/shared/constitutionalDocPaths.ts`), so the routine is
correctly forbidden from fixing them. That is the right refusal — but it means this particular class
of error can only ever be corrected by escalating to the owner and spending an attestation override.
A number that is guaranteed to go stale on every registry change, in a document that deliberately
cannot be edited without ceremony, is the most expensive possible place to keep a hand-maintained
count.

Tonight both counts have been open since 2026-07-30 at the latest and neither the reviewer lane nor
the `check:doc-code-citations` gate caught them: the citation gate checks that the **path and symbol**
resolve, and `src/audit/io/artifacts.ts` resolves fine. Nothing checks the number beside it.

## The repo has already solved this shape twice

`CLAUDE.md`: **"One brief, two consumers — never a second copy of the philosophy."** The README's
Philosophy block was a hand-maintained restatement "kept honest by an instruction to *remember* to
update it — a drift test made of memory, which is the thing this project bans." It is now generated
and gated (`check:philosophy-brief`). The `verify:checks` step list went the same way last week
(P6 → `check:gate-enumeration`, "24 gate steps rendered identically in 2 docs").

A registry count is the same object: one authoritative value in code, a restatement in prose, and
nothing but attention holding them together.

## The mechanism — check the count, don't generate the sentence

Generation is the wrong tool here. The count sits mid-sentence in normative prose, and rewriting
constitutional text mechanically is exactly what `constitutionalDocPaths.ts` exists to prevent.
**Check it instead**: a gate that fails the build when the stated number and the real registry
disagree, leaving the edit to the owner under the existing attestation flow.

Extend the existing citation gate rather than adding a new one — `scripts/check-doc-code-citations.mjs`
already parses docs for code references and already runs in `verify:checks`:

1. Recognise the pattern already used in both docs verbatim:
   `` `<path>` — <N> entries `` (and the `N executors` / `N artifacts` variants).
2. Resolve `<path>`, find the single top-level `export const <NAME> = [...]` or `{...}` in it, and
   count its members — array length, or own keys for an object literal. Refuse (loudly) rather than
   guess when the file has no single unambiguous registry export: an unparseable target must fail
   the gate, not silently pass it.
3. Fail with both numbers and the doc line, so the fix is one edit.

Scope it deliberately narrow. Only two sites exist in the whole corpus today:

```
$ grep -rnE '[0-9]+ entries, each' --include='*.md' .
spec/audit/artifact-contract.md:17
spec/audit/executor-catalog.md:10
```

A narrow gate that covers both of them is worth more than a general "verify every number in prose"
ambition that would drown in false positives.

## What it would have caught

Both of tonight's escalations, at the commit that caused them (`6df1f477`) rather than six days
later — and it would have caught them **as a red build on the author's machine**, which is where a
constitutional-doc change is cheapest to make: the same commit that removes the registry entry
updates the count and takes one attestation, instead of a separate owner round-trip afterwards.

## False-positive surface

- **A doc deliberately quoting a historical count** ("was 38 before the inversion") — the pattern
  match is anchored on `` `<path>` — <N> entries ``, which a narrative sentence does not produce.
  A dated review record would; `docs/reviews/**` is excluded by construction and should be excluded
  here too.
- **A registry that is assembled rather than declared** (spread across modules, or built at runtime)
  — rule 2's refusal handles it: the gate says it cannot count this target, and the answer is to
  drop the number from the prose rather than to weaken the gate.
- **A count that is intentionally approximate** ("~40 artifacts") — not matched; only exact integers
  in the anchored form are checked.

## Note on the alternative that was rejected

"Just delete the numbers from both docs" is cheaper and would also end the drift. It is rejected
because the count is load-bearing in both places: each doc is a *contract* enumerating what the
registry must contain, and the size is part of what a reader checks the enumeration against. The
number should stay and be mechanically true.
