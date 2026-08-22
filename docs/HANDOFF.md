# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- Published state: v0.44.0 (the tag — it carries the consolidated pass: the mechanical deletions,
  the P38 write-scope union, the single-sourced command-shape rule, and the wave-1 durable tests).
  Everything below `main`'s tip is pushed; release CI is green and the global bins are reinstalled.
- The dogfood self-audit of 2026-08-21 is COMPLETE. Promoted deliverables at
  .audit-tools/audit-report.md / .audit-tools/audit-findings.json: 2,712 findings
  (40 high / 1,164 medium / 1,405 low / 103 info), 12 root-cause themes, 6 top risks, 1,590 work
  blocks. Of the 1,813 findings carrying a quote, 1,805 re-verified against disk at ingest.
  The seven defects the run hit in the tool ITSELF are in docs/backlog/open-bugs.md; the two
  standing lane/transport gotchas are in docs/backlog/durable-traps.md.

## Immediate next

1. Remediate from the fresh findings — `.audit-tools/audit-findings.json` is clean input to
   `/remediate-code`. The 40 high-severity findings and the 6 top risks are the obvious first draw;
   several are self-inflicted on the tool's own loop (synchronous spawns starving the lock
   heartbeat, `sameLensDedupe` dropping absorbed findings, write-scope collapsing to host
   attestation on non-git roots).
2. Two audit-side defects the lap hit are worth fixing BEFORE the next audit run, because they cost
   a wedged ingest and a hand-repair each: the generated worker prompt omitting `evidence`, and the
   absence of any un-accept verb once a result is accepted and then fails validation. Both in
   docs/backlog/open-bugs.md.

<!-- BEGIN GENERATED LIVE STATUS — scripts/shared/generate-handoff-roadmap.mjs — DO NOT EDIT BY HAND -->

- **9 nightly decisions are waiting.** Answer in [`nightly-inbox.md`](nightly-inbox.md); settled items disappear from this generated block.
  - `backlogN-1` — Backlog disambiguation: "one run identity" is the stated property, but the adversary says the gap is LINKAGE, not identity — decide which the entry means
  - `solN-1` — A generator-parity gate registered preCommit:false lets a stale tracked render land — approve the reach fix plus the contract test that forbids the shape
  - `docs-1` — A10 says analyzer consent is "per-run", but the code also admits a DURABLE recorded grant — settle which the project means before either side is changed
  - `docs-2` — Apply the de-status rule uniformly to the concept docs still carrying measurements, lap narratives and migration markers — or name the sites that keep them deliberately
  - `sol-1` — P40: approve rendering a prompt output contract FROM the contract — two live sites, one already fixed this way, red-green proof attached
  - `docs-3` — Decide what audit-tools ships to npm consumers — the tarball carries a contributor guide and a maintainer release runbook, and their pointers dangle there
  - `docs-4` — Four facts are kept in two hand-written homes each and three have already drifted — single-source them, or accept the copies deliberately
  - `docs-5` — CONSTITUTIONAL: the audit spec documents an executor-to-artifact producer relation that no registry encodes, and its cross-reference bounces the reader — decide the home
  - `docs-6` — CONSTITUTIONAL: the entrypoint contract calls the shipped slash workflow an interim precursor, while the standing decision says that workflow IS the product

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
