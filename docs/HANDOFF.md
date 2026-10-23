# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Current state

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

Next: qualify the isolated reviewed refactor candidate under the serialized validation lane; see the
[qualification record](reviews/audit-refactor-qualification-2026-10-14.md) for scope and remaining gates.
No commit, publication or release acceptance is established. The owner discarded the paused
2026-10-05 dogfood run (2026-10-09); a new dogfood run is the owner's call and would use 0.55.6.
**Live owner decision:** none.

<!-- BEGIN GENERATED LIVE STATUS — scripts/shared/generate-handoff-roadmap.mjs — DO NOT EDIT BY HAND -->

- **5 nightly decisions are waiting.** Answer in [`nightly-inbox.md`](nightly-inbox.md); settled items disappear from this generated block.
  - `leg2-comment-shape-enumeration-check-2026-10-21` — backlog spec: how should a comment stating a workflow SHAPE or prose ENUMERATION be mechanically checked?
  - `leg1-synthesis-narrative-always-runs-header-2026-10-23` — spec/audit-workflow-design.md: fix or clarify the "Synthesis narrative (always runs)" header, which contradicts its own body and the code
  - `leg1-open-bugs-checkout-staleness-narrative-trim-2026-10-23` — docs/backlog/open-bugs.md: trim the checkout-staleness entry's dated narrative, keeping only its still-open Property
  - `leg1-docset-condensation-qualification-triple-pointer-2026-10-23` — Doc-set condensation: three backlog/handoff homes point at the audit-refactor-qualification blocker — same item filed three times, or genuinely distinct?
  - `leg3-p70-stale-main-reads-wrong-checkout-2026-10-23` — Leg-3 proposal P70: fix session-start-guards.mjs's stale-main check to read the session's own worktree, not CLAUDE_PROJECT_DIR

<!-- END GENERATED LIVE STATUS -->

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
