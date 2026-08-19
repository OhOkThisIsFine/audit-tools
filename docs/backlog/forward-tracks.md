# Forward tracks

> Design-level directions and in-flight tracks — not yet bounded defects.
>
> Part of the split backlog — index: [`docs/backlog.md`](../backlog.md).
> A living to-do list, not a status log. Remove an entry once it ships; record durable
> contracts and rationale in project memory or `CLAUDE.md`, never "where the code is today".

## Open tracks

**Track 2.5 — keep production-orphan detection beside knip.** The dated
[`slimdown-review-2026-07-28.md`](../reviews/slimdown-review-2026-07-28.md) is a historical lead set,
not a current deletion list; the provider and dispatch subgraphs it identified have since been retired.
Its surviving structural finding is that neither knip mode reports a whole module that is exported
through a barrel and otherwise referenced only by its own tests. Periodically run a relative-import
graph check for production files whose only consumers are tests, then verify each candidate against
current HEAD before deleting it. [[orphan-modules-are-invisible-to-both-knip-modes]]

---



## Forward tracks

- **A2 finding-quality oracle — the corpus is SMALL, PUBLIC, PINNED git repos, never labeled
  self-audit runs.** A contract-valid empty result cannot be scored for quality without ground truth;
  raw finding yield is a noisy signal. Its affirmation half (`reviewed_clean`) is shipped. The
  `score-audit` scorer exists. The REFUTED alternative — hand-labelling a live run's findings into
  `corpus/<run-id>.labels.json` — must not be re-proposed; it has two structural flaws: (a) labels against our own moving tree ROT — findings reference
  file:lines that drift within days, so a labeled run is a one-shot number, never a regression
  gate; (b) labeling only what the tool FOUND measures precision only — misses are invisible, so
  recall is unmeasurable without ground truth the tool didn't author.
  **SPEC:** `corpus/` becomes a manifest of pinned public repos — `{repo_url, commit_sha,
  labels[]}`, each label a ground-truth defect (file, region, kind, evidence — ideally the upstream
  FIX commit that proves it). Ground truth comes from someone-else-maintained inventories where
  possible (bugs fixed in later upstream commits; CVE-tagged pre-fix versions; suites like
  Defects4J / BugsInPy) per the synced-not-forked table principle; hand-authored labels are a
  bounded one-time cost per repo and never rot (the SHA is pinned). `score-audit` gains a
  corpus-repo mode: clone at the pinned SHA (hermetic state via `AUDIT_CODE_STATE_DIR`), have the
  host execute the emitted audit workload, and match findings against labels → precision AND
  recall as a repeatable release-time gate. Prefer small-but-REAL repos (real libraries at pre-fix
  commits) over purely synthetic bug suites — synthetic-only corpora overestimate transfer. Rust /
  Ruby pins double as clippy/rubocop analyzer targets (toolchain availability still gates the live
  spawn). **Scope honesty:** this measures finding QUALITY; pipeline-at-scale behavior (charters
  over 1000+ components and deepening) stays validated by dogfood runs. The re-dogfood
  run's hand-label is optional large-target calibration, never a blocker for this.



- **Generate the executor↔artifact mapping from the registries (anti-drift).** `executor-catalog.md` +
  `dependency-map.md` both render the executor→artifact relation, hand-maintained over `EXECUTOR_REGISTRY`
  (`src/audit/orchestrator/executors.ts`) + `ARTIFACT_DEFINITIONS` (`src/audit/io/artifacts.ts`) — it drifted
  once. The mapping is now consolidated to one hand-maintained home (`dependency-map.md`), but the durable fix
  per "never hand-maintain a table someone else could generate" is to GENERATE the mapping from the two
  registries at doc-build/check time. Forward track.

- **End-to-end remediate-run smoke exercising the tool-owned gate (from the 2026-07-12 dogfood).** The
  node:test-gate bug ([[remediate-gate-nodetest-runner-bug]], fixed v0.32.61) blocked EVERY remediate run
  yet no gate/release check caught it: the gate command only runs in a live remediate *run*, and the unit
  test asserted the broken shape as correct. Add a smoke that drives a tiny real remediation to at least one
  phase-boundary/final gate against the actual repo tree (or a fixture repo with vitest tests) so a
  tool-owned gate that can't pass on a clean tree fails the release, not a dogfood run. Sibling of the
  packaged-bin smokes but for the *gate execution path*, not just `--version`.

- **Deterministic analyzers: own-vs-acquire engine.** **Open:** clippy/rubocop landed fixture-only (no
  Rust/Ruby repo → live spawn unvalidated). *(Mutation testing was
  considered and dropped 2026-07-03: it doesn't fit the acquire+scan model — Stryker must run the full
  test suite per mutant and needs a per-repo test-runner config we don't own, so it either no-ops or is
  its own subsystem. Not an analyzer-registry add. Re-file as a scoped forward track only if a lightweight
  mutation signal appears.)* **Forward constraint:** any future proposal channel for analyzer ids
  beyond the static registry must route through the same `admitSpawn` chokepoint. Durable choices
  live only in the strict provider-neutral analyzer policy; per-run consent tokens are never
  persisted. [[deterministic-analyzers-own-vs-acquire]]
  - **⬇ Live-run watch** (audit a **Rust** repo for clippy / a **Ruby** repo for rubocop, with the per-run
    consent token so the gate admits the non-default tool): the tool must actually **spawn and normalize**
    output into leads (cargo-clippy / bundle-rubocop), not skip. FAIL = "skipped" status when the ecosystem
    is present + consent given, or a parse that drops all output. (No Rust/Ruby toolchain on the box →
    install `rustup` / `ruby`+`bundler` first, or point at a repo that vendors them.)

- **CI wall-clock: shard balance and the single-file floor.** Pointer only — the brief, the measurements,
  the settled owner decisions and the rejected alternatives are ALL in
  `docs/reviews/ci-wallclock-plan-critique-2026-08-07.md`, which is deliberately the single home for this
  work. Nothing is restated here, so there is no second copy to drift. Implementation assigned outside
  this repo's agent loop by the owner 2026-08-07. [[vitest-shard-is-hash-based-and-file-atomic]]


- **Obligation-id slugs and decomposed-module names are two name spaces joined by a prefix match.**
  A DAG node that declares no files inherits its write scope from the module its obligations belong
  to, matched as `OBL-<moduleSlug>-…`. Nothing forces the two sides to agree, so a rename on either
  breaks the join — and its failure mode is an EMPTY result, indistinguishable from "nothing to
  inherit". That is how the 2026-08-09 observability run stranded two of four nodes. `40f632b4` made
  the miss a loud refusal at DAG validation, which is the safety property; it did NOT unify the two
  name spaces, and it deliberately did not make the join tolerant (containment or fuzzy slugs would
  attach work to a module nobody chose, which is worse than refusing). **Open question, not a
  planned change:** whether the obligation id should be DERIVED from the decomposition rather than
  authored alongside it, so the join cannot be broken by a rename at all.
  [[prefix-join-between-two-name-spaces-fails-empty]]

- **Wave-friendly host dispatch: run identity survives partial ingest.** A semantic-review run is
  reused only when the pending task id set is EXACTLY equal (`sameTaskIds`, consulted by
  `ensureSemanticReviewRun` in `src/audit/cli/reviewRun.ts`), so ingesting even one accepted result
  mints a new run id — new run directory, workload, task bindings, result map, and new bound result
  paths. Two consequences, both observed on the 2026-08-12 dogfood lap: a worker still writing into
  the prior run's `host-results/` is silently orphaned (ingest reads only the current run id), and
  the per-run accepted ledger does not carry forward. Accepted work itself is durable — it folds
  into `audit_results.jsonl` and the coverage matrix — so the failure mode is wasted work, not lost
  work. The tool therefore supports exactly ONE dispatch shape: publish the whole workload, execute
  all of it, then call `next-step`; never call `next-step` with workers in flight. Making waves
  first-class needs a run identity that outlives a partial ingest — stable bound paths across
  re-mints, or an accepted ledger keyed by work item rather than by run — which is a change to the
  host-handoff contract itself, so it takes a `/design-check` before any build.

- **`ensureGlobalAssets` is now production-unwired — decide whether it is duplicated or genuinely
  dead.** Deleting the shadowed `ensure` ACTION (sol-2, 2026-08-09) removed its only non-test caller:
  the bin routes `ensure` to `installer.ensureBootstrap` in `wrapper/`, never to
  `src/remediate/index.ts`. It stays exported and its tests still pass, so default-mode knip cannot
  see it — this is exactly the tested-but-unwired class CLAUDE.md assigns to the periodic manual
  `knip --production` audit. The open question is whether the wrapper's `ensureBootstrap` already
  covers the global-asset half it writes, in which case both it and
  `src/remediate/utils/hostAssets.ts`'s comment naming it go too.

- **Isolated-branch landing gap — a remediation run dispatched on its own `remediation/<runId>`
  branch has no closing action that lands it on the base branch.** `CLOSING_ACTIONS`
  (`src/remediate/state/closingActions.ts`) is commit/push/open-pr/publish/tag/none/custom; the
  retired `merge-to-base` (deleted in `467b1e8f` with the execution substrate) was the opt-in fix —
  one revertable `--no-ff` merge into the launch branch, aborting safely on conflict. A host
  dispatching on an isolated branch must land the work itself (`custom` or a manual merge). If
  isolated-branch dispatch returns as a first-class flow, re-add a landing action in tooling rather
  than relying on the host remembering.
