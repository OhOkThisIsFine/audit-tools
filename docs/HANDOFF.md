# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- Published state: v0.45.0 is the last tag, is published to npm, and is what the global bins run.
  `main` is ahead of it, pushed, and CI-green on the tip; that work is not yet released.
- The dogfood self-audit's deliverables are `.audit-tools/audit-report.md` and
  `.audit-tools/audit-findings.json`. The tool defects it and the remediation run exposed are the
  2026-08-21 and 2026-08-22 entries in `docs/backlog/open-bugs.md`.
- The first-draw REMEDIATION RUN (`.audit-tools/remediation/`, 30 work items) is in its implement
  phase and mostly landed: 24 items are on `main` (each implemented and independently reviewed on
  the Ox-Alpha lane, gated, CI-green), 5 resolved with no change, and NODE-5 is implementing with
  26 → 7 → 14 queued behind it. A DETACHED host runner drives it (launched 2026-08-23 from the main
  checkout; it lands items serially on `main`, writes the bound result docs, re-runs `next-step` per
  round, and stops on any pause it cannot answer). The runner, its logs, how to watch/stop/resume it,
  and the pauses it hits are in project memory `remediation-host-runner-2026-08-23`; the run's
  decisions are in `remediation-first-draw-2026-08-22`. P39 and P40 (the two approved
  queue proposals) are built and landed.

## Immediate next

1. Finish the remediation run: read the runner log named in memory `remediation-host-runner-2026-08-23`.
   If the parent is alive, leave it; if it stopped, answer the pause per that memory's recipe and relaunch
   `node .audit-tools/remediation/host-runner/impl-runner.mjs --concurrency 10` from the main checkout.
   When every item is terminal the tool enters closing (final gate): run `node remediate-code.mjs next-step`
   until the report is promoted (`.audit-tools/remediation-report.md` / `remediation-outcomes.json`).
2. Ask the owner the waiting decisions (generated list below; plain-language forms for
   `docs-1..7` and `backlogN-1` are in `.audit-tools/remediation/host-runner/inbox-questions.json`).
3. Ship a release once the run closes (`/ship`): `main` carries 24 remediation landings, P39, P40
   and four follow-up fixes since v0.45.0.

<!-- BEGIN GENERATED LIVE STATUS — scripts/shared/generate-handoff-roadmap.mjs — DO NOT EDIT BY HAND -->

- **8 nightly decisions are waiting.** Answer in [`nightly-inbox.md`](nightly-inbox.md); settled items disappear from this generated block.
  - `docs-2` — Apply the de-status rule uniformly to the concept docs still carrying measurements, lap narratives and migration markers — or name the sites that keep them deliberately
  - `docs-3` — Decide what audit-tools ships to npm consumers — the tarball carries a contributor guide and a maintainer release runbook, and their pointers dangle there
  - `docs-4` — Four facts are kept in two hand-written homes each and three have already drifted — single-source them, or accept the copies deliberately
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
