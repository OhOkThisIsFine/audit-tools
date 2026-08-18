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

- **43 nightly decisions are waiting.** Answer in [`nightly-inbox.md`](nightly-inbox.md); settled items disappear from this generated block.
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
  - `docs-11` — Constitutional specs say the host handoff reads access_memory and the affinity graph — it takes neither; correct the docs, or wire the consumption they describe
  - `docs-12` — Constitutional dependency map says task_affinity_graph.json has one writer; it has four — and the two rows beside it already list them
  - `docs-13` — The analyzer default/consent split is described wrong in two constitutional specs and a third time in the source comment — one stale fact, three decaying copies
  - `docs-14` — Constitutional goals doc names a "pre-run sweep" that does not exist — cleanupStaleArtifactsDir has exactly one caller, the CLI verb
  - `docs-15` — Executor catalog note says intake_executor satisfies one obligation; its own Obligation column beside it lists two, and they have different satisfaction rules
  - `docs-16` — Finding grounding is documented as enforced at ingest and advertised to users in the README, but verifyFindingGrounding has zero production callers — the verdict is whatever the worker self-reported
  - `docs-17` — The workflow design's deterministic-block enumeration omits docs_digest and runtime_validation, both of which are registered deterministic and sit in PRIORITY
  - `docs-19` — Doc-set condensation: the release flow has two hand-maintained homes — the ship skill and release.md restate the same gate list, shard split, dist-tag rule and live check
  - `backlog-4` — ensureGlobalAssets is unreachable through the bin — decide whether it is duplicated elsewhere or genuinely dead code to delete
  - `sol-7` — writeOpenItems refuses an item four ways over probes but never checks options or eli5 — the two fields the contract calls mandatory, and the two that shipped missing on 18 items
  - `sol-8` — The free-provider lane has had no file access for at least three nights and answers from nothing — it fabricated last night's "zero findings" closeout
  - `sol-9` — Four cheap gates in verify:checks are still absent from the pre-commit hook — the same hand-accretion that burned v0.34.17 and v0.34.40
  - `sol-10` — Step prompts instruct the host to do what the tool cannot deliver — 7 incidents across 5 dates, and the design-review write instruction is still live at HEAD
  - `docsN-1` — instruction-file edit: CLAUDE.md cites a half-closed trap whose mechanism was deleted with the execution substrate — one of its "two live examples" has no backlog home
  - `docsN-2` — instruction-file edit: CLAUDE.md says a non-default analyzer "requires the per-run consent token" — the code also admits on a persisted recorded grant
  - `docsN-3` — instruction-file edit: CLAUDE.md warns that consent-token redaction is "not yet implemented" and tracked in open-bugs — it is neither tracked there nor unimplemented
  - `docsN-4` — A loader still tells the host to echo the scope line — the tool took that job over deliberately, so a compliant host now prints it twice in two formats
  - `docsN-5` — A loader promises a scope-confirmation gate the tool cannot honour — the warning text reaches no prompt, and the drain has already folded past intake before any host can act
  - `docsN-6` — The audit loader advertises a target-dir argument nothing honours — a typed path is shown back to the user and silently dropped; the remediate loader does the opposite
  - `docsN-7` — The loop-core module header names a consumer deleted with the execution substrate, and its exported predicate has zero production callers while the hook re-implements it
  - `solN-1` — The lane-liveness guard covers one lane of several, and the one probe it runs cannot fail — tonight the Codex lane was dead all run and nothing said so
  - `docsN-8` — Constitutional goals doc defines the remediator's output as Markdown only — the machine contract is missing from all three output statements, and its audit sibling states the pair correctly
  - `docsN-9` — Batched de-status: two design docs that declare "no dated status here" carry dated process provenance and a heading defined against a superseded state
  - `docsN-10` — Doc-set condensation: the shared cross-tool contract is deliberately listed in both workflow designs — and the two copies have already drifted to four bullets versus six

<!-- END GENERATED LIVE STATUS -->

## Immediate next

1. Resume the dogfood audit lap (see *Resume the audit* above), then the remediate phase.
2. The three remaining owner-approved builds. All modify BLOCKING hooks, so two unattended
   maintenance runs declined to land them; they need an attended lap, or an explicit owner call to
   land them unattended anyway. Each is an answered subject in the durable decision ledger, keyed
   below. Named, never numbered: the per-run `sol-N` labels are recycled and go stale immediately.
   - **Child-session/Stop-gate split** (`820ba998`): probe whether child sessions fire SessionStart,
     then session tagging + unregistered-session commit/push refusal. Unblocks the freellmapi
     `pool` lane for this repo.
   - **Record-update pre-commit gate** (`a360d399`): a commit touching a tracked-work path must
     carry the corresponding record update.
   - **Tree-dirt baseline + per-gate pathspec scoping** (`f65ec9c9`), superseding P24's shape.
3. Memory-index consolidation (owner decision 2026-08-09, recorded in the MEMORY.md header; there
   is no size gate — measure with `wc -c` after an index edit). The account-metering saga and six
   other retired-substrate entries were pruned 2026-08-14. **Remaining target: the quota/cost
   cluster** — same retirement, but not uniformly obsolete (the host-quota entries are still live
   for the offload lanes) and its `[[name]]` cross-links are ungated, so it is a focused per-entry
   pass, not a side-task.

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
