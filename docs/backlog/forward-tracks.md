# Forward tracks

> Design-level directions and in-flight tracks — not yet bounded defects.
>
> Part of the split backlog — index: [`docs/backlog.md`](../backlog.md).
> A living to-do list, not a status log. Remove an entry once it ships; record durable
> contracts and rationale in project memory or `CLAUDE.md`, never "where the code is today".

## Open tracks

**Track 3 — every emitted lane should carry a size, complexity and risk ranking, so the host can match a model to the work (2026-09-02, owner-directed).** A step contract tells the host WHICH lanes to
run and WHERE to write, but says nothing about how demanding each lane is — so the host infers
demand from the prompt, and infers it badly. Measured on a live `llm-relay` audit (335 files):
the host placed 5 of 8 design-review lanes plus both charter lanes on a free `pool/medium` tier,
and one conceptual perspective on Gemini Flash. That lane's MEASUREMENTS were accurate — it cited
`src/config.ts` at "nearly 2,500 lines" against an actual 2,486, and `src/backend.ts` at 1,864 <!-- doc-citation-exempt: paths in the audited repo C:/Code/llm-relay, not this tree -->
against 1,863 — but its JUDGMENT was stale: it recommended decoupling `src/server.ts` from its <!-- doc-citation-exempt: paths in the audited repo C:/Code/llm-relay, not this tree -->
route implementations, work that had already shipped, leaving `server.ts` at 894 lines beside an <!-- doc-citation-exempt: paths in the audited repo C:/Code/llm-relay, not this tree -->
existing `src/routes/`. Charter extraction and design review are whole-repo, cross-cutting and <!-- doc-citation-exempt: paths in the audited repo C:/Code/llm-relay, not this tree -->
high-consequence — they set the frame every later step reasons inside — so a weak reviewer's MISS
is unrecoverable downstream: the merge judge can discard a wrong finding, but it cannot restore
one nobody saw. **Property:** every step contract that emits a lane states that lane's size,
complexity and risk, so a host selects a model from a stated ranking instead of guessing from
prompt length. ⚠ The ranking stays provider-neutral by construction — it names DEMAND, never a
model, a provider, a tier or a lane, which is the same boundary the loader already draws when it
forbids sending provider, model, quota, context-window, routing or launch configuration to
audit-tools. Machine-side sibling: `C:\Code\docs\backlog.md` carries the host-side half, since the
host is what must act on the ranking.

**Ceremony-review remainder — Tier 2/3 consolidations, plus the one unlanded Part-5 mechanism
(2026-08-29).** Full evidence and the ranked plan:
[`ceremony-complexity-review-2026-08-29.md`](../reviews/ceremony-complexity-review-2026-08-29.md).
The 2026-08-29 lap landed Tier 0, Tier 1, F8, F10 (registry moved to `~/.agent-config`), and both
anti-refill mechanisms for the orphan-module class (`check:orphan-modules` + knip `files`). What
remains open: **`check:shared-primitives` still scans `git ls-files 'src/**/*.ts'` only**, so the
governance tree stays exempt from the one-definition rule it enforces (the F1 substrate removed
today's duplicates; the gate reach is what stops them re-growing); and the review's Tier 2
(CY-02/05/06 vocabulary copies, CY-15 collectFiles, CY-14, CY-13, F5 one-backlog-process, F4
test:doc-contract registration, F6 Stop-gate preamble, CY-08 line-index memo, C-05, C-09) and
Tier 3 (CY-04, CY-07, CY-12, CY-09, F3 attestation dedup, C-03 philosophy map, C-11 traps sweep,
CY-11, F9 pre-commit boundary split) stay as ranked in the review. **Property:** the single-source
gate reaches the governance tree, so a consolidation lands once instead of refilling. ⚠ Not the
refused half of PH-05 — no gate is weakened; the substrate stops being written N times.

**The audit draw WRITES to the audited tree, and the read-only framing does not say so
(2026-08-24, raised by CP-NODE-7's refutation lane).** `docs/project-philosophy.md` and CLAUDE.md
describe auditing as "the read-only selection" and remediating as "the write/apply selection", but
phase-1 auto-fix spawns `prettier --write` / `black` / `sqlfluff fix --force` / `gofmt -w` over the
audited files, so an audit mutates the tree it is auditing. CP-NODE-7 gave the phase a mechanical
opt-out and dry-run, which makes the mutation refusable but leaves it ON by default. **Property:**
either the read-only framing names auto-fix as its one declared exception, or the phase defaults to
off and a host opts IN — the two documents and the executor agree on which.

**Metric-pool empirical program — grouping/characterization metrics (owner-directed 2026-08-19).**
The in-tree grouping (`shared_file ∧ same_lens` eligibility + constant-free modularity-peak
refinement + per-file aggregated seams) is INTERIM: it is the best-measured choice on one run, not a
selected one. Build the pool catalog and the five-repo dataset in the lab
(`C:\Code\metrics-lab`), then run the experiment that selects which combination of signals actually
groups and characterizes work best. **Property:** the shipped combination is chosen by measurement
across repos, or it is labelled interim wherever it is documented — no in-tool ceiling of any
denomination re-enters, and sizing stays host-side whichever combination wins.

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
  <!-- doc-citation-exempt: proposed dir, not yet created -->
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
  beyond the static registry must route through the same `admitSpawn` chokepoint. (The
  consent-token-never-persisted half is pinned mechanically by
  `tests/shared/consent-token-not-persisted.test.ts`.) [[deterministic-analyzers-own-vs-acquire]]
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
  the prior run's `.audit-tools/audit/runs/<id>/host-results/` is silently orphaned (ingest reads only the current run id), and
  the per-run accepted ledger does not carry forward. Accepted work itself is durable — it folds
  into `audit_results.jsonl` and the coverage matrix — so the failure mode is wasted work, not lost
  work. The tool therefore supports exactly ONE dispatch shape: publish the whole workload, execute
  all of it, then call `next-step`; never call `next-step` with workers in flight. Making waves
  first-class needs a run identity that outlives a partial ingest — stable bound paths across
  re-mints, or an accepted ledger keyed by work item rather than by run — which is a change to the
  host-handoff contract itself, so it takes a `/design-check` before any build.

- **Isolated-branch landing gap — a remediation run dispatched on its own `remediation/<runId>`
  branch has no closing action that lands it on the base branch.** `CLOSING_ACTIONS`
  (`src/shared/types/closingActions.ts`) is commit/push/open-pr/publish/tag/none/custom; the
  retired `merge-to-base` (deleted in `467b1e8f` with the execution substrate) was the opt-in fix —
  one revertable `--no-ff` merge into the launch branch, aborting safely on conflict. A host
  dispatching on an isolated branch must land the work itself (`custom` or a manual merge). If
  isolated-branch dispatch returns as a first-class flow, re-add a landing action in tooling rather
  than relying on the host remembering.

- **One-core dissolution lap — the two draws are converged; what remains is two adapter divergences
  (owner-routed 2026-08-19, RE-BASELINED 2026-08-27).** The original entry routed two declined
  findings, ARC-e96acb7e and ARC-908bbca5. **Both premises were false when routed**; this entry is
  re-derived from measurement rather than deleted, because the stale framing follows from the file's
  raw size and a true entry is the guard against it recurring. Measured at HEAD: remediate drives
  shared `advance` twice over two priority arrays and two declarative registries (A3 landed
  2026-06-17); `hostHandoffCore.ts` already owns three of the four named duplications; `jscpd` at
  gate granularity finds zero clones across the twins. **Property:** each invariant audit enforces
  mechanically on its draw, remediate enforces on its own — the shared core carries the mechanism
  and each draw supplies its policy. Open residue: (1) remediate's boundary struct drops the
  `runDir` the shared core returns and rebuilds it by slicing the workload filename, so renaming
  that file mis-derives every remediate result path; (2) the prompt-binding check runs the same five
  predicates in a different order on each side, so a doubly-malformed document is refused for
  different reasons per draw. **Decided non-goal:** deriving remediate's engine bound.
  `deriveEngineBound` derives FROM a consumer's own graceful cap so the consumer can prove the
  engine bound cannot fire first; remediate has no cap (`countStep` is per-invocation telemetry that
  enforces no limit), so deriving would mean inventing one to derive from. The engine's default is
  its documented backstop for exactly this shallow-fold case.
  **Deliberately NOT in scope:** obligation *granularity* — remediate
  sequences sub-gates inside executor bodies where audit registers `PRIORITY` ids. No measured
  defect attaches to it, and its target moves under CX-02, which converges audit toward remediate's
  shape rather than the reverse. Re-open that quarter only on a measured defect, and only after
  CX-02. Full brief, with both adversarial lanes and the limits of the measurement:
  [`one-core-lap-scope-2026-08-27.md`](../reviews/one-core-lap-scope-2026-08-27.md).

- **▶ Audit-tools deep-review acceptance benchmark still needs its external run.** Pointer only — the eight confirmed gaps, the P0 rewiring sequence, its
  contract-test plan, the conditional P1/P2 extensions, the blinded paired-benchmark gate, and the
  explicit what-not-to-build list are ALL in
  [`audit-tools-simplification-workflow-gap-2026-08-26.md`](../reviews/audit-tools-simplification-workflow-gap-2026-08-26.md),
  which is deliberately the single home for this work. Nothing is restated here, so there is no
  second copy to drift. Its verdict is that the reviewers already exist and the normal execution
  path starves them, so P0 adds no audit phase, no objective schema, and no MCP client to
  audit-tools core; P1 and P2 are contingencies that must each cite a failed benchmark axis, never
  added pre-emptively. P0 and its provider-neutral harness are implemented; that harness is not
  acceptance evidence. The remaining work is the real acceptance gate — ten pinned, blinded paired
  trials scored on six separate non-inferiority axes — using an operator-supplied external executor
  and credentials plus two independent blinded evaluators, then adding a durable contract only where
  a measured axis fails. Acceptance corpus is the two 2026-08-26
  standalone runs,
  [`complexity-reduction-audit-2026-08-26.md`](../reviews/complexity-reduction-audit-2026-08-26.md)
  (the review CX-02 draws from) and
  [`philosophy-simplification-audit-2026-08-26.md`](../reviews/philosophy-simplification-audit-2026-08-26.md),
  plus a held-out repository chosen before tuning. Gaps of its own that are already bounded defects
  on the working queue — the systemic adversary handed a prior-finding count instead of the banked
  set, that lane's adversary-minted finding ids, and the loop's dry-signal convergence having no
  ceiling — are worked there, not here.

- **The ship pipeline stops before the steps that finish it, and the remainder is agent prose (2026-08-27, from the philosophy audit).** `scripts/release-and-publish.mjs` ends at registry visibility; global reinstall, the allowed postinstall lifecycle scripts and both binary smokes live in `.claude/skills/ship/SKILL.md` as instructions an agent must remember and execute — the host-remembering shape the auditor-agnostic rule bans, applied to the project's own pipeline-ownership rule. There is also no single resumable record spanning the phases, so a stall part-way is recovered by hand. **Property:** one idempotent command owns gated ref verification, exactly-once tag/release/publish creation, delayed release observation, registry verification, reinstall with allowed lifecycle scripts, and smoke checks of both global binaries and the installed host assets — resuming only its observation and completion phases and never retrying a destructive creation. The observation half already has its own entry (the await-run timeout shorter than a release-event delivery delay); fix it inside this command rather than beside it. YAML critical-path profiling moves out of release correctness into best-effort reporting.
