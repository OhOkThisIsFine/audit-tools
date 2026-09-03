# P50 — single-source the conceptual finding categories so no comment can drift

**Leg:** 3 (recurring-problem solutions) · **Date:** 2026-09-03 · **HEAD:** `e836d386`
**Status:** proposal only. Leg 3 lands nothing.

## The defect, proven

The conceptual-design review emits eight finding categories. The canonical
occurrence is a bare string literal inside `conceptualOutputFormat`
(`src/audit/orchestrator/designReviewPrompt.ts:408`):

```
"one of: fundamental_approach, core_assumption, structural_risk,
 architecture_pattern, design_simplification, tool_opportunity,
 integration, missing_capability"
```

Two JSDoc comments hand-copy that set and still state the old five-category
list, which the lap at `aeefc6fa`/`09b0f4e4` widened:

- `src/audit/orchestrator/designReviewPrompt.ts:571-572`
- `src/audit/types/designAssessment.ts:42`

The `designReviewPrompt.ts:571` comment documents `renderConceptualReviewPrompt`
— the SHALLOW single-agent pass. That function calls `conceptualOutputFormat`
(line 595), so the shallow pass really does emit all eight categories. The
comment is wrong, not merely narrower. `spec/audit-workflow-design.md` was
updated to the correct eight in the same lap, so the spec is right and only the
code comments are stale.

The sibling contract-pass comment (`designReviewPrompt.ts:527`) matches its own
enum (line 556) exactly, which bounds this to the conceptual pair.

## Why it is a class, not an incident

The signal is that **no gate in this repository reads a code comment.**
`check:doc-code-citations` verifies path citations in tracked `*.md`;
`check:doc-manifest` routes documents; the doc-review rubric scopes leg 1 to the
manifest. A `.ts` comment is outside all of them, so a false statement there is
invisible until a human happens to read it.

Recurrence, counted across distinct dates:

| Date | Record | Instance |
|---|---|---|
| 2026-08-31 | commit `86215384` | *"doc-review: three claims the code contradicts, and **the comment class that hid behind the doc gates**"* |
| 2026-08-31 | `docs/backlog/open-bugs.md` | the `src/shared/continuityScore.ts` header claims audit "biases review-packet ORDERING with it"; `grep` over `src/audit` finds no consumer at all |
| 2026-09-03 | this proposal | two conceptual-category comments, five categories behind the code |

Three records, two distinct dates, four separate stale comments. The
2026-08-31 backlog entry is explicit that the bad comment is what "makes the
spec look self-contradictory" — a stale comment does not merely sit there, it
actively corrupts a reader's model of the spec.

## The mechanism

**Prefer the fix that removes the trap over the guard that catches it.** The trap
here is a second copy of a list, so the fix is to stop having one.

1. Extract the canonical set as an exported const beside the prompt:

   ```ts
   export const CONCEPTUAL_FINDING_CATEGORIES = [
     "fundamental_approach", "core_assumption", "structural_risk",
     "architecture_pattern", "design_simplification", "tool_opportunity",
     "integration", "missing_capability",
   ] as const;
   ```

2. Build the line-408 enum string from it
   (`\`one of: ${CONCEPTUAL_FINDING_CATEGORIES.join(", ")}\``), so the emitted
   prompt and the const cannot disagree by construction.

3. **Delete both stale enumerations.** Replace each with a pointer, not a
   shorter list — a comment that names a subset is the same defect with a
   smaller blast radius:

   - `designReviewPrompt.ts:571-572` → `Categories: see CONCEPTUAL_FINDING_CATEGORIES.`
   - `designAssessment.ts:42` → `Conceptual-design pass (generative); categories are CONCEPTUAL_FINDING_CATEGORIES.`

4. Ship the guard in this directory as `tests/audit/conceptual-category-comment-drift.test.ts`
   so step 3 cannot be undone silently. It fails on any `src/**/*.ts` comment
   line naming three or more canonical tokens.

Steps 1-3 are the fix; step 4 is the ratchet. Both halves ship in one commit
per the atomic-replace invariant.

## What it would have caught

Run at `e836d386` the test names both offenders with the exact missing tokens
(`RED-AT.txt` carries the verbatim failure). Run at `aeefc6fa` — the commit that
widened the category set — it would have failed in CI in the same lap that
introduced the drift, instead of leaving it to be found three days later by a
nightly pass that happened to diff the spec.

## False-positive surface

Measured, not asserted: the scan over every tracked `src/**/*.ts` file flagged
exactly the two known-stale comments and nothing else.

The residual surface is a comment that legitimately names three or more
categories as an example rather than as a list. None exists today. If one is
ever wanted, the honest escape is to name two, or to point at the const — which
is the behaviour the guard is trying to produce anyway. The threshold is
deliberately three: a comment naming one or two categories is discussing them,
while a comment naming three or more is enumerating the set.

The guard reads only comment lines, so it cannot fire on code, and it derives
its expected set from a literal list inside the test. That list is itself a
second copy — the accepted cost of a guard that must state what "correct" is,
and it is bound to the const by step 2, so widening the set reds this test until
the test is updated in the same commit. That is the intended coupling.

## Registry

Adding this test requires a `scripts/guard-reach-data.mjs` row (contract-test
class) per the guard-reach registry rule in `CLAUDE.md`, or
`npm run check:guard-reach` reds the build.

## Owner decision

Accept the whole shape (fix + guard), accept the fix without the guard, or
reject and let the two comments be corrected as an ordinary edit.
