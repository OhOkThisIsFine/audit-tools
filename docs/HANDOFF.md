# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Current state

`main` carries simplify parts P01 (shared contracts, `49a42916`), P02 (shared infrastructure,
`cec41197`), P03 (audit orchestrator core), P04 (audit orchestrator review and charter), P05
(audit cli), P06 (audit extractors) and P07 (the rest of `src/audit`) on top of release v0.55.20,
plus the withheld
P01–P03 items the 2026-11-16 lap judged worth doing. The items it skipped stay in the
[deferred record](reviews/simplify-deferred-items-2026-11-16.md). The owner chose to release the
parts later, together, so the published package is v0.55.20.
The remaining structured MCP routes are in [`forward-tracks.md`](backlog/forward-tracks.md).

Release metadata is in [package.json](../package.json); publication and global-install evidence
is in project memory (`memory: release-state`). GitHub branch protection on `main` requires the `checks`
status check (strict) and binds admins, so work lands with `npm run land` (a pull request, then a
fast-forward); that job judges every tree against the tracked loop-core attestation ledger
`.claude/loop-core-attestations.json`. The remaining gap is filed in
[`open-bugs.md`](backlog/open-bugs.md) as "The attestation gate judges an edit to itself with the
edited copy".

Legacy dispatch validation/merge scripts have been removed from the package; the asset guard
requires production reference paths for dispatch scripts and data. Release CI includes the exact
publish runtime, and profile fixtures write to temporary destinations. The mirror guard scans only surviving
production roots. Superseded answers retain their original ledger entry and record
the applied remainder, omitted clause, and later owner decision in the inbox.

The 2026-09-19 recovery record `C:/Code/audit-tools/.audit-tools/recovery/2026-09-19/README.md`
is present on the owner's machine and has not been reviewed; retain unknown work.

## Immediate next

Next: the simplify sweep, parts P08–P12, one part per chat, landed one at a time. Each part reads
its row and *Leads and skips* in the
[partition record](reviews/simplify-partition-2026-11-15.md) first.
Also open: qualify the isolated reviewed refactor candidate under the serialized validation lane; see the
[qualification record](reviews/audit-refactor-qualification-2026-10-14.md) for scope and remaining gates.
No commit, publication or release acceptance is established. The owner discarded the paused
2026-10-05 dogfood run (2026-10-09); a new dogfood run is the owner's call and would use 0.55.6.
**Live owner decision:** none.

<!-- BEGIN GENERATED ROADMAP — scripts/shared/generate-handoff-roadmap.mjs — DO NOT EDIT BY HAND -->

> **This list is GENERATED from [`docs/backlog/`](backlog/) — do not hand-edit it.**
> It is the IMMEDIATE NEXT work only, never the full open set. Prefix an entry's bold title with
> `▶` in the backlog file that owns it and it appears here; empty means nothing is
> pinned, which is a statement rather than an omission.
> **Every open item lives in [`docs/backlog/`](backlog/)**, reachable by the seek index in
> [`backlog.md`](backlog.md) — this block is not a second index of it.
> Every line is a POINTER: the backlog entry's own title, verbatim, and a link to the file that
> holds its spec. Nothing here restates a spec, so this list and the backlog cannot drift.
> Regenerate: `node scripts/shared/generate-handoff-roadmap.mjs` (`--check` gates it in
> `verify:checks` and at commit). 0 pinned item(s).

### ▶ Next up — pinned in the backlog

*(nothing pinned — no immediate next step is set. Every open item is in [`docs/backlog/`](backlog/).)*

<!-- END GENERATED ROADMAP -->
