# P29 — the doc-citation gate skips directory citations and bare filenames, and does not count the skips

Nightly leg 3, 2026-08-13. Queue item `sol-4`. Propose-only.

## The defect

`scripts/check-doc-code-citations.mjs` fails the build when a doc cites a repo path in backticks
that no longer resolves. Before it checks anything it applies two filters:

1. `if (!token.includes("/")) continue;` — a bare filename never reaches validation.
2. an end-anchored extension test — a directory citation (trailing slash, no extension) never
   reaches validation.

Only after both does it increment the `checked` tally. So both forms are silently unchecked,
**and they are excluded from the coverage number the gate prints** — the reported figure
overstates real coverage. The header comment documents both conditions honestly, so this is a
known bound rather than a bug; what makes it worth raising is that a partly-covering gate
reporting full coverage reads as a close, which is the exact shape `CLAUDE.md` bans.

## Recurrence — this run alone, 3 stale citations in the blind spot

| Doc | Citation | Why the gate missed it |
|---|---|---|
| `src/audit/README.md` | `` `prompts/` `` — directory does not exist | no extension |
| `src/audit/adapters/README.md` | `` `normalizeExternal.ts` `` — lives under `src/shared/analyzers/` | no slash |
| `docs/glossary-ids.md` | two deleted `src/remediate/steps/dispatch/*.ts` paths in the INV-WTS row | unbackticked (a third, separate blind spot) |

Two of these were found independently by two different reviewers tonight and confirmed by the
Codex lane; the third by the core-docs adversary. All three were auto-applicable or escalated
stale claims that a gate is supposed to make impossible.

## Mechanism

Widen resolution in `check-doc-code-citations.mjs`:

- **Directory citations** — a token ending in `/` must resolve to a tracked directory. Unambiguous.
- **Bare filenames** — resolve against the tracked file set; fail when the name matches nothing.
  When it matches more than one path, emit an explicit *ambiguous* verdict rather than a silent
  pass, so the widening cannot itself become a new silent hole.
- **Count them** in the printed tally either way.

Minimum viable version if the widening is judged too noisy: report the skipped-citation count
alongside the checked count, and register the uncovered halves in `scripts/guard-reach-data.mjs`
as declared data — the repo's own pattern for a gate whose reach is narrower than its name.

The unbackticked-citation case (the glossary table cell) is a **separate, larger** question and
is deliberately not proposed here: table cells routinely name paths in prose, so requiring
backticks is a doc-convention change, not a gate widening.

## What it would have caught

The `prompts/` and `normalizeExternal.ts` claims, at commit, before either reached a nightly
reviewer.

## False-positive surface

Bare filenames can be genuinely ambiguous across directories — hence the explicit ambiguous
verdict rather than a pass or a hard fail. Directory citations have essentially none. Widening
will land some initial red on existing docs; that count is unmeasured and should be taken before
wiring the widened gate into `verify:checks`.

## Not authored this run

No patch written, and the day-one red count was not measured.
