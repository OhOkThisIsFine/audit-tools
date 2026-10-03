# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Current state

Published and installed: `v0.55.3` (`v0.55.2` failed at publish and was deleted). GitHub branch protection on `main` requires the `checks`
status check (strict; admins can bypass), and that job judges every tree against the tracked
loop-core attestation ledger `.claude/loop-core-attestations.json` (143 baseline-only files).
The remaining gap is filed in [`open-bugs.md`](backlog/open-bugs.md) as "A loop-core change can
reach `main` without an attestation": the gate's own files are not loop-core, and an admin's
direct push skips the required check.

The 2026-09-19 recovery record `C:/Code/audit-tools/.audit-tools/recovery/2026-09-19/README.md`
is present on the owner's machine and has not been reviewed; retain unknown work.

## Immediate next

Work the medium entries in [`open-bugs.md`](backlog/open-bugs.md), first the pre-tag CI-green gate
that does not test the publish suite's Node `22.14.0` (it cost the `v0.55.2` tag). Then: the commit
refusal of a session started outside the repo, the worktree reaper's unseen agents, and a settled
owner answer that a later decision overtook. A loop-core attestation needs a full-suite green stamp
on the exact staged tree: run `npm test` after the final stage.
**Live owner decision:** none.

<!-- BEGIN GENERATED LIVE STATUS — scripts/shared/generate-handoff-roadmap.mjs — DO NOT EDIT BY HAND -->
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
