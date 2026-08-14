# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- Published state: v0.41.1 (the tag, not a sha — a sha here restales on every commit). The
  zero-adapter retirement is live; audit-tools emits complete provider-neutral host workloads
  and ingests bound results. Host submissions ride tool-computed sha256-bound paths under
  `<artifactsDir>/submissions/`; the flat `incoming/` scheme is gone, so anything still writing
  to it will be rejected.
- The dogfood audit lap is IN FLIGHT and deliberately PAUSED at the `dispatch_review` step:
  intake/scope/lenses confirmed (930 files; custom `host_contract_robustness` lens included),
  all 5 analyzers consented, critical-flow enrichment plus both design reviews (contract +
  conceptual) ingested. Per the owner's atomic-migration call the paused dispatch re-runs on the
  new arrival scheme: `next-step` re-emits it; deterministic artifacts survive, only
  dispatched-but-uningested work repeats.

## Resume the audit (fresh conversation)

1. `node audit-code.mjs next-step` re-renders the current step; follow its prompt — it is the
   `dispatch_review` host workload (dispatch items to workers, write each bound result, then
   `next-step` again). Free-lane caveat: the freellmapi `pool` lane is unusable for long tasks
   in THIS repo until P23 lands (the repo Stop gates fire inside the child and replace its
   deliverable); use the agy lanes, with verification-shaped prompts.

<!-- BEGIN GENERATED LIVE STATUS — scripts/shared/generate-handoff-roadmap.mjs — DO NOT EDIT BY HAND -->

- **19 nightly decisions are waiting.** Answer in [`nightly-inbox.md`](nightly-inbox.md); settled items disappear from this generated block.
  - `docs-1` — Constitutional goals doc: the deterministic-responsibilities list is missing six live obligations plus the friction close-out
  - `docs-2` — The analyzer candidate set is described as 4 tools with 1 default in three places; it is 12 tools with 5 defaults — and the code comment is the likely source
  - `docs-3` — Constitutional catalog contradicts itself about friction capture — one line says "not in the priority chain", another says its id sits in PRIORITY
  - `docs-4` — Constitutional policy still says "one bounded step"; the engine drains the frontier — and the sibling contract already has the corrected wording
  - `docs-5` — Constitutional goals doc documents a closing action the schema would reject — merge-to-base was deleted with the execution substrate
  - `docs-6` — instruction-file edit: the own-vs-acquire rule puts secret-scan on the wrong side, and npm-audit on the wrong side in the opposite direction
  - `docs-7` — The philosophy map states the opposite of its named home on concurrency — and two dead code helpers are the last physical trace of the retired mechanism
  - `docs-8` — Two conflicting round-trip counts in one doc (~12 and 17) against a real phase count of 15 — but collapsing them to one number would erase the mechanism
  - `docs-9` — A loader body pins version: 0.3.0 while the package is 0.41.1 — nothing reads the field, and its sibling loader has none
  - `docs-10` — A glossary row points at two files deleted with the execution substrate, and its contract sentence over-claims three of its four nouns
  - `backlog-1` — Two trap entries cite line numbers that never could have been right — and the file's own rule says to delete the suffixes, not bump them
  - `backlog-2` — The completion-test entry counts five files and four tests; there are three files and three tests — and a sibling entry says three then four in ten lines
  - `backlog-3` — The live-validation guide's premise did not survive the backlog split — it says "each such item", and 2 of 113 entries have the line
  - `sol-5` — HANDOFF changelog creep has recurred against a written rule — enforce it in the generator, or accept it as advice the nightly re-trims
  - `sol-1` — A gate inspects .claude/** but CI cannot be triggered by it — generate the trigger paths from the guard-reach registry
  - `sol-2` — The guard that blocks a masked suite exit prescribes, in its own remedy text, the shape that fakes a green suite in the background — both shell branches
  - `sol-3` — The strongest recurrence in the store: an over-scoped offload call silently loses its whole answer — the working pattern exists once and generalizes to nothing
  - `sol-4` — The citation gate cannot see a directory citation or a bare filename — two of tonight's doc findings were in that blind spot, and the coverage count hides it
  - `sol-6` — An inline node -e carrying a regex is mangled before it runs — deny the form, deny only the escape-run case, or leave it as advice

<!-- END GENERATED LIVE STATUS -->

## Immediate next

1. Resume the dogfood audit lap (see *Resume the audit* above), then the remediate phase.
2. The remaining owner-approved builds:
   - **P23** (sol-7): probe whether child sessions fire SessionStart, then session tagging +
     unregistered-session commit/push refusal. Unblocks the freellmapi `pool` lane for this repo.
   - **sol-8**: SessionStart tree-dirt baseline + per-gate pathspec scoping (supersedes P24's shape).
   - **backlog-2 gate + sol-3 leg-1 scope ledger.**
3. Memory-index consolidation (owner decision 2026-08-09, recorded in the MEMORY.md header; there
   is no size gate — measure with `wc -c` after an index edit): merge the closed sagas properly — the citations gate
   and `[[name]]` cross-links make it a focused pass, not a side-task.

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
