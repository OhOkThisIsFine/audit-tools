# P37 — the citation gate is blind to un-backticked citations, and the glossary is written entirely that way

## The trap

`npm run check:doc-code-citations` resolves **backticked** repo-path citations against the
git-tracked set. Its detection is syntax-gated: a citation not wrapped in backticks is not a
citation as far as the gate is concerned.

`docs/glossary-ids.md` writes **every** code citation as a bare table cell — no backticks. It is
the one doc in the corpus whose entire purpose is pointing at the code that owns each identifier,
and it is the one doc the citation gate cannot see at all.

## Recurrence — counted, not asserted

Same class — *a stale code citation the gate structurally cannot see* — on three distinct dates:

| Date | Instance | The gate's state |
|---|---|---|
| (gate's own header) | the `.mjs`→`.ts` test conversion stranded 31 citations across 9 docs, found a week later by a nightly review | gate did not exist / link-only |
| 2026-08-13 | nightly `sol-4` / `P29`: gate blind to **directory** and **bare-filename** citations — two of that night's doc items were citations it could not see | widened to those two forms |
| 2026-08-19 | tonight: `docs/glossary-ids.md:44` cited `src/remediate/steps/dispatch/verifyCommands.ts`, deleted the previous day in `ab1e9598`. **All ten mechanical gates ran GREEN**, including this one. Found by hand-grepping the deleted paths. | still backtick-gated |

The pattern in the middle column is the finding: each round widened the *form* of citation that
had just escaped (path → directory → bare filename), and each time the gate stayed keyed on the
backtick. The escape is not the form, it is the delimiter.

## Size of the blind spot at HEAD

59 un-backticked, gate-invisible code citations repo-wide. **45 of them (76%) are in
`docs/glossary-ids.md`.** The rest: `docs/nightly-routine.md` 5, `spec/multi-ide-concurrent-runs-design.md` 3,
`docs/HANDOFF.md` 2, and one each in `.claude/skills/ship/SKILL.md`, `.claude/skills/start-lap/SKILL.md`,
`docs/audit-pkg/development.md`, `docs/backlog.md`.

## Mechanism — make them visible to the gate that already exists

Prefer the fix that removes the trap over the guard that catches it. No new gate is needed: the
existing gate is correct, it is simply not being shown the citations.

1. **Backtick the citations** in `docs/glossary-ids.md` (and the 14 elsewhere). The existing
   `check:doc-code-citations` then resolves them like any other.
2. **A contract test pins the property**, so the file cannot drift back to bare cells:
   `tests/shared/glossary-citations-backticked.test.ts` fails when a path-shaped token in the
   glossary's owner column is not backticked.

Verified before proposing: backticking line 44's citation and running the gate turned it **RED**
with the correct message (`does not resolve … does not name a tracked file`). Reverted; the gate
does catch it once it can see it.

## What it would have caught

Tonight's finding, at the commit that deleted the module (`ab1e9598`) rather than a day later by
hand-grep — the pre-commit hook already runs the doc-contract subset when the staged set touches
those docs. `ab1e9598` deleted `verifyCommands.ts` and repointed `INV-WTS`'s row in the same
commit; it missed `INV-RSM-VERIFY` because nothing was checking.

## False-positive surface

Low, and bounded by the existing gate's own exemption rules (pattern tokens, third-party paths,
`<!-- doc-citation-exempt: … -->`). The one new surface is the contract test's own token regex
firing on prose that merely *looks* like a path. Mitigated by scoping the test to the glossary's
table rows — its owner column is a citation column by construction, never prose.

## Bound

Leg 3 is propose-only. Nothing here is landed. The patch and its red-green test are written out
so approval is one step rather than a re-derivation.

## Red-green validation (2026-08-19, at `ad0d51b0`)

Both halves were executed and then reverted — leg 3 lands nothing.

| Phase | Command | Result |
|---|---|---|
| RED | `npx vitest run tests/shared/glossary-citations-backticked.test.ts` (patch NOT applied) | exit **1** — `1 failed`, listing the un-backticked citations |
| GREEN | `node apply-patch.mjs` then the same vitest run | exit **0** — `1 passed`; patch reported `45 citations now backticked` |
| Gate reach | `npm run check:doc-code-citations` after the patch | exit **0**, and the printed tally rose to `400 path + 72 directory + 358 bare-filename citations across 54 tracked docs` — the glossary's 45 are now inside the gate's reach rather than invisible to it |

The tally line is the point: before the patch those 45 were not counted as citations at all, so the
gate's own "every one resolves" was true of a set that excluded them.
