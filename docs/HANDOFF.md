# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- Published state: v0.44.0 is the last tag. `main` is ahead of it and pushed (not yet released):
  the two audit-side defects the 2026-08-21 dogfood lap hit are SHIPPED — host-handoff validates
  each result BEFORE accepting, with an `unaccept-results` verb and an advisory warning channel
  (`1a34e60f`, follow-ups `02521579`, `e72a06bb`), and the worker prompt and ingestion share ONE
  finding contract rendered from the strict worker projection plus the validator's rule registry
  (`20bba526`). Release CI has not run on these (no tag); the global bins are still v0.44.0.
- The dogfood self-audit of 2026-08-21 is complete; its promoted deliverables are
  .audit-tools/audit-report.md / .audit-tools/audit-findings.json. Its tool defects live in
  docs/backlog/open-bugs.md (the 2026-08-21 and 2026-08-22 entries).
- A first-draw REMEDIATION RUN (all high findings + the top risks' medium ones) is IN FLIGHT in
  `.audit-tools/remediation/` and is BLOCKED inside the contract pipeline on an owner decision:
  the adversarial judge demands adding a module for MNT-c2dc7f9c (dropped at intake, no evidence
  array) or an owner-level goal_spec waiver, plus structured dependency/scope fields the finalized
  contract schema does not have. The run, every host decision taken, the drivers, and how to
  resume are in project memory `remediation-first-draw-2026-08-22`; the tool defects it exposed are
  the 2026-08-22 high entries in docs/backlog/open-bugs.md.

## Immediate next

1. Resume the remediation run with the OWNER'S ANSWERS (given 2026-08-22 at hand-back): (a)
   MNT-c2dc7f9c is WAIVED for this run — record it as a host decision (goal_spec non_goal / the
   contracts' out-of-scope note already says so) and remediate it in a later draw; (b) the judge's
   structured-field demands are DOWNGRADED for this run — the `artifact:` token graph is the
   structured form; proceed to implementation dispatch. Mechanically: from the main checkout,
   resolve the six accepted counterexamples in
   `.audit-tools/remediation/intake/contract/judge_report.input.json` as downgraded/waived with that
   rationale (use the tool's own downgrade path if its block prompt names one; otherwise edit the
   classifications), `node remediate-code.mjs next-step`, then relaunch the driver described in memory
   `remediation-first-draw-2026-08-22`. Implementation dispatch follows; items ship per dependency
   level, results are `host-results/<sha256(item)>.json`, landed commits must be reachable from
   HEAD, and the tool reruns the required tests.
2. Decision queue: P39 (`solN-1`) and P40 (`sol-1`) are APPROVED (ticked in the inbox the
   generated block below points at — build both halves / approve as proposed); eight queue items
   are still open and must be asked at the next session start.
3. Ship a release for the landed main (`/ship`): the shipped defect fixes are only on `main`.

<!-- BEGIN GENERATED LIVE STATUS — scripts/shared/generate-handoff-roadmap.mjs — DO NOT EDIT BY HAND -->

- **10 nightly decisions are waiting.** Answer in [`nightly-inbox.md`](nightly-inbox.md); settled items disappear from this generated block.
  - `docs-1` — A10 says analyzer consent is "per-run", but the code also admits a DURABLE recorded grant — settle which the project means before either side is changed
  - `docs-2` — Apply the de-status rule uniformly to the concept docs still carrying measurements, lap narratives and migration markers — or name the sites that keep them deliberately
  - `sol-1` — P40: approve rendering a prompt output contract FROM the contract — two live sites, one already fixed this way, red-green proof attached
  - `docs-3` — Decide what audit-tools ships to npm consumers — the tarball carries a contributor guide and a maintainer release runbook, and their pointers dangle there
  - `docs-4` — Four facts are kept in two hand-written homes each and three have already drifted — single-source them, or accept the copies deliberately
  - `docs-5` — CONSTITUTIONAL: the audit spec documents an executor-to-artifact producer relation that no registry encodes, and its cross-reference bounces the reader — decide the home
  - `docs-6` — CONSTITUTIONAL: the entrypoint contract calls the shipped slash workflow an interim precursor, while the standing decision says that workflow IS the product
  - `docs-7` — HANDOFF Live state carries nine hand-typed run counts no probe can track, plus a parenthetical narrating what already shipped — trim, or keep them deliberately
  - `backlogN-1` — Backlog disambiguation: "one run identity" is the stated property, but the adversary says the gap is LINKAGE, not identity — decide which the entry means
  - `solN-1` — A generator-parity gate registered preCommit:false lets a stale tracked render land — approve the reach fix plus the contract test that forbids the shape

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
