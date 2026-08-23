# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- Published state: v0.45.0 is the last tag and is published to npm. `main` is ahead of it and
  pushed. The two audit-side defects the 2026-08-21 dogfood lap hit are SHIPPED — host-handoff validates
  each result BEFORE accepting, with an `unaccept-results` verb and an advisory warning channel
  (`1a34e60f`, follow-ups `02521579`, `e72a06bb`), and the worker prompt and ingestion share ONE
  finding contract rendered from the strict worker projection plus the validator's rule registry
  (`20bba526`), and all four are ancestors of v0.45.0. Both CI workflows are green on the pushed
  tip; the work landed since v0.45.0 is not yet released, so the global bins are v0.45.0.
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
2. Decision queue: P39 and P40 are APPROVED and both have LANDED (`594071ff`, `c3eaa59d`), so
   they have left the queue. The items still open are listed in the generated block below and in
   [`nightly-inbox.md`](nightly-inbox.md); ask them at the next session start.
3. Ship a release for the work landed on `main` since v0.45.0 (`/ship`).

<!-- BEGIN GENERATED LIVE STATUS — scripts/shared/generate-handoff-roadmap.mjs — DO NOT EDIT BY HAND -->

- **12 nightly decisions are waiting.** Answer in [`nightly-inbox.md`](nightly-inbox.md); settled items disappear from this generated block.
  - `docs-1` — A10 says analyzer consent is "per-run", but the code also admits a DURABLE recorded grant — settle which the project means before either side is changed
  - `docs-2` — Apply the de-status rule uniformly to the concept docs still carrying measurements, lap narratives and migration markers — or name the sites that keep them deliberately
  - `docs-3` — Decide what audit-tools ships to npm consumers — the tarball carries a contributor guide and a maintainer release runbook, and their pointers dangle there
  - `docs-4` — Four facts are kept in two hand-written homes each and three have already drifted — single-source them, or accept the copies deliberately
  - `docs-5` — CONSTITUTIONAL: the audit spec documents an executor-to-artifact producer relation that no registry encodes, and its cross-reference bounces the reader — decide the home
  - `docs-6` — CONSTITUTIONAL: the entrypoint contract calls the shipped slash workflow an interim precursor, while the standing decision says that workflow IS the product
  - `backlogN-1` — Backlog disambiguation: "one run identity" is the stated property, but the adversary says the gap is LINKAGE, not identity — decide which the entry means
  - `docs-8` — The ship skill anchors two preflight checks to the releases they burned (v0.34.17, v0.39.7) — keep the version stamps as incident anchors, or drop them and keep the mechanism sentence
  - `docs-9` — The glossary promises to cover every opaque identifier in src, but the F-series phase labels and item-C have no family row — register them, or narrow the promise
  - `sol-2` — P41: approve a registry-driven prompt-contract test that reconciles against every prompt builder — 12 records across 7 dates, and guard-reach already declares the class open
  - `sol-3` — P42: approve deleting the advance command from the worker-facing prompt, so a delegated executor cannot advance the run — a design change, not a guard
  - `sol-4` — P43: approve a configDirTrust row so a lane that cannot read the repo is refused before it is spent on — 10 records across 8 dates, and the trap is marked UNENFORCED

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
