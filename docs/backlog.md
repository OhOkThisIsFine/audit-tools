# Backlog — index

> Open work, durable traps and future directions, split so each file is ONE bounded read.
> The single file grew past 1,700 lines, which meant every pass navigated it blind — and that is
> how ~21% of entries silently went stale between classification passes.
>
> A living to-do list, not a status log. Remove an entry once it ships; record durable contracts
> and rationale in project memory or `CLAUDE.md`, never "where the code is today".

| File | What lives there |
|---|---|
| [`backlog/open-bugs.md`](backlog/open-bugs.md) | Fixable defects and friction — the working queue |
| [`backlog/minor-bugs.md`](backlog/minor-bugs.md) | The same fixable defects at LOW severity — split off on size alone; re-tagging an entry moves it |
| [`backlog/forward-tracks.md`](backlog/forward-tracks.md) | Open tracks + design-level directions |
| [`backlog/deferred.md`](backlog/deferred.md) | Blocked on data, a live run, creds or a toolchain |
| [`backlog/durable-traps.md`](backlog/durable-traps.md) | Standing environment reference + doc-set hygiene |

<!-- BEGIN GENERATED SEEK INDEX — scripts/shared/generate-backlog-index.mjs — DO NOT EDIT BY HAND -->

> **Seek index — GENERATED from [`docs/backlog/`](backlog/); do not hand-edit it.**
> `open-bugs.md` is past what one read call returns. Read THIS list once, then jump straight to
> an entry with an offset read at its `file:line` anchor — that is what makes the open-work
> record navigable in bounded reads without splitting it.
> Titles are each entry's own bold lead-in, verbatim, so this index restates nothing and cannot
> drift. **Line numbers move under every edit** — regenerate rather than hand-patching them:
> `node scripts/shared/generate-backlog-index.mjs` (`--check` gates it in `verify:checks`
> and at commit). 249 entr(y/ies) indexed.

### [`open-bugs.md`](backlog/open-bugs.md)

- `open-bugs.md:9` — CI orchestration shards time out at 300s with the spawned `audit-code next-step` still alive, on a DIFFERENT test each time (2026-09-04, high, friction: false_red).
- `open-bugs.md:23` — A guard's stated escape hatch does not work for any statement after a NEWLINE (2026-09-04, medium, friction: tool_should_decide).
- `open-bugs.md:36` — `pre-commit-gate.mjs` evaluates the audit-tools tree for a `git commit` run in ANY directory (2026-09-04, medium, friction: tool_should_decide).
- `open-bugs.md:47` — Four code and CI comments assert a shape the tree no longer has, and nothing checks a comment against the code it describes (2026-08-31, medium, friction: tool_should_decide).
- `open-bugs.md:67` — `durable-traps.md` documents RETIRED infrastructure as though it were live (2026-08-30, medium, friction: false_green).
- `open-bugs.md:79` — The repo cannot DETECT a delegated lane — it can only refuse one it recognizes at the dispatching tool call (2026-08-29, high, friction: tool_should_decide).
- `open-bugs.md:108` — The closeout gate calls pushed commits "UNPUSHED" — it tests against `main` and says something different from what it means (2026-08-29, low, friction: false_red).
- `open-bugs.md:119` — The gate fixture helper `stageLoopCoreFile` arms NOTHING, and its own comment says it arms the loop-core gate (2026-08-29, medium, friction: false_green).
- `open-bugs.md:133` — A literal pinned in a test outside the change's neighborhood reds only in CI — the general discovery arm stays open (2026-08-29, medium, friction: tool_should_decide).
- `open-bugs.md:143` — Registering ONE new gate takes edits in five separate homes, and you find them one red at a time (2026-08-30, medium, friction: missing_affordance).
- `open-bugs.md:156` — The loop-core closure rule claims a module only when EVERY importer is core, and today's 25 declared modules are grandfathered by MEASUREMENT (2026-08-30, low, friction: false_green).
- `open-bugs.md:168` — A history-moving commit lands its INCOMING content unreviewed — the gate can only read the STAGED snapshot (2026-08-28, mechanism corrected 2026-08-29, medium).
- `open-bugs.md:186` — The attest preflight's REFUSAL is now sound, but the divergent case gets no verdict at all (2026-08-28, narrowed 2026-08-30, medium, friction: false_red).
- `open-bugs.md:204` — `shell-trap-guard`'s PowerShell here-string rule did not fire on two Bash-tool commits and then fired on a third near-identical one (2026-08-27, medium).
- `open-bugs.md:216` — The rendered decision queue and its tracked snapshot can outlive the ledger that settles them, and nothing gates the disagreement (2026-08-27, medium, friction: tool_should_decide).
- `open-bugs.md:235` — The critique-driven contract repair step renders the judge-repair template (2026-08-22, medium).
- `open-bugs.md:237` — Remediation intake drops a finding with no `evidence` array, and the audit systemic-challenge lane emits findings without one (2026-08-22, medium).
- `open-bugs.md:239` — The Implementation DAG prompt does not state the one-invocation rule for `targeted_commands` (2026-08-23, medium, friction: tool_should_decide).
- `open-bugs.md:246` — The per-item required tests and the host landing gate do not include the tree-wide guard suites or the cheap release gates, and every landing's evidence is Windows-local (2026-08-23, medium).
- `open-bugs.md:256` — The systemic-challenge lane prompt withholds the banked findings it asks the adversary to beat (2026-08-21, medium).
- `open-bugs.md:258` — Conceptual-review DEPTH is still modelled as durable when it must be per-run (2026-08-21, owner directive, medium).
- `open-bugs.md:260` — Promotion and close residuals from the CP-NODE-3/15 reviews (low, one entry).
- `open-bugs.md:280` — next-step discards a rejected submission's classified issues (2026-08-20, medium, friction: tool_should_decide).
- `open-bugs.md:300` — Host-handoff residuals from the CP-NODE-6 landing (low, one entry).
- `open-bugs.md:324` — Analyzer-boundary residuals from the CP-NODE-1 review (low).
- `open-bugs.md:341` — Staleness third-state residuals from the CP-NODE-10 review (low).
- `open-bugs.md:349` — Emission-scaffold and gate residuals from the CP-NODE-12/13 reviews (low).
- `open-bugs.md:360` — Charter and route residuals from the CP-NODE-18/19 reviews (low).
- `open-bugs.md:373` — Drift-guard residuals from the CP-NODE-25 review (low).
- `open-bugs.md:383` — `fixture-generator-drift-guard` is not hermetic (low, friction).
- `open-bugs.md:389` — A scoped wave item that coins an invariant id in `src/` is structurally unable to satisfy the id-glossary gate (2026-08-20, medium, friction: tool_should_decide).
- `open-bugs.md:400` — The remediate-side submission ledger has no reader — `accepted_via_recovery` marks are write-only (2026-08-19, low-medium).
- `open-bugs.md:408` — The TASK draw's coherence eligibility is still disjunctive and has never been measured for collapse (2026-08-19, medium).
- `open-bugs.md:415` — `runCommand` buffers child output unboundedly (2026-08-13, medium).
- `open-bugs.md:422` — `shell-trap-guard` misses `git stash push <pathspec>` eating uncommitted work (2026-08-12, medium).
- `open-bugs.md:428` — Contract-pipeline fan-out names a mechanism the host may not have (2026-08-08, medium).
- `open-bugs.md:436` — Sweep the test tree for tests that re-implement their subject (2026-08-08, medium).
- `open-bugs.md:445` — Vitest worker RPC starvation — the false-RED exit is CLOSED at the gate; the >60s blocking worker is unlocated (recharacterized 2026-08-07; was "full-suite exits 1 while every test passes", 2026-08-06).
- `open-bugs.md:469` — Remediation pause/recovery is not durable (2026-08-03, medium).
- `open-bugs.md:477` — Graph heuristics are promoted to findings without a semantic lead boundary (2026-08-03, medium).
- `open-bugs.md:484` — Tool-owned gate reds are unattributed — foreign live-tree dirt pauses the run (2026-07-30, shrunk 2026-08-20; was "Phase-boundary gate false abandonment", HIGH).
- `open-bugs.md:498` — Backlog prose paraphrased an incident in a way that INVERTED its mechanism, costing a wrong implementation (2026-07-24, medium, friction: ambiguous-direction).
- `open-bugs.md:508` — ⬇ Live-run watch (re-dogfood 2026-07-22, medium): a worker self-reported "valid, verified" on a malformed-JSON result file — result validity must be checked mechanically, never trusted from the worker's claim.
- `open-bugs.md:516` — Review rounds re-derive the same file map every time (inefficient-feeding, 2026-07-19).
- `open-bugs.md:537` — A per-site pinning gate would make "red-green validated" mechanically checkable — UNBUILT on main.
- `open-bugs.md:557` — Friction walk (copy-fallback lap, 2026-08-30):
- `open-bugs.md:584` — Friction walk (commitFold unlink lap, 2026-08-30):
- `open-bugs.md:607` — Friction walk (guard-test-hermeticity lap, 2026-08-30):
- `open-bugs.md:625` — Friction walk (two-identities lap, 2026-08-30):
- `open-bugs.md:642` — Friction walk (determinations-execution lap, 2026-07-29):
- `open-bugs.md:656` — Friction walk (duplicated-guard lap, 2026-07-25):
- `open-bugs.md:668` — The per-result LLM conformance review — the opt-in depth dial half of the owner decision — is unbuilt, so semantic conformance to the carried module contracts is still judged by nothing (2026-08-09, narrowed 2026-08-29, medium).
- `open-bugs.md:679` — Self-audit dogfood loop: fixing the tool mid-run invalidates the run (2026-07-16, ambiguous-direction, low-medium).
- `open-bugs.md:695` — Friction walk (niggle-fix lap, 2026-08-07):
- `open-bugs.md:713` — Friction walk (loop-core `.ts`-conversion tranche lap, 2026-07-28):
- `open-bugs.md:725` — Friction walk (nightly-determinations lap, 2026-07-26):
- `open-bugs.md:737` — Friction walk (touched_files load-gate lap, 2026-07-25):
- `open-bugs.md:743` — Friction walk (fourth backlog-clearance lap, 2026-07-24):
- `open-bugs.md:756` — Friction walk (second backlog-clearance lap, 2026-07-24):
- `open-bugs.md:765` — Untracked-exclusion scope rule — residuals only (each low-severity, documented at the code site).
- `open-bugs.md:787` — External shared-logic audit V1–V7 residuals
- `open-bugs.md:799` — Top gate optimization — the suite-side tail is subprocess wall, not isolation overhead (measured 2026-07-06).
- `open-bugs.md:805` — Selective-deepening convergence — live validation env-bound.
- `open-bugs.md:813` — `goal_id` is read verbatim off the LLM envelope, so its format is unvalidated (re-verified at HEAD 2026-07-25).
- `open-bugs.md:822` — `StepArtifactSchema` is `.strict()` but `writeStepContract` injects `agent_id`.
- `open-bugs.md:828` — systemic_challenge findings ids are adversary-invented and round-colliding.
- `open-bugs.md:835` — The systemic_challenge loop has no ceiling — its only exit is a dry signal the host may have to fabricate.
- `open-bugs.md:842` — `ensure` writes opencode.json with unstable key order.
- `open-bugs.md:847` — Steward verification metadata is undeliverable through the host-result envelope (hit 2026-08-18).
- `open-bugs.md:857` — The report renderer emits control characters from finding prose raw (hit 2026-08-18).
- `open-bugs.md:864` — A killed `next-step` wedges `phase.lock` for every later call (2026-08-24, remediation run, medium).
- `open-bugs.md:873` — A provenance plane with no producer is still exported, advertised and documented (2026-08-27, from the philosophy audit, medium).
- `open-bugs.md:875` — Three persisted contracts are read back without the schema that defines them (2026-08-27, from the philosophy audit, medium).
- `open-bugs.md:877` — The pre-split design-review lane is still polled beside the two current judgment types (2026-08-27, from the philosophy audit, medium).
- `open-bugs.md:879` — The N-R13 status invariant asserts its own literal, and the status vocabulary exists in three unlinked copies (2026-08-27, low-medium).
- `open-bugs.md:895` — The dispatch boundary strips every per-node field the contract pipeline writes onto a promoted finding but `FindingSchema` does not declare (2026-08-27, medium).
- `open-bugs.md:915` — The two evidence-bearing terminal dispositions have no producer — `verified_already_fixed` and `refuted` are unreachable in any real run (2026-08-27, medium, from [`reviews/wave2-dispositions-2026-08-20.md`](./reviews/wave2-dispositions-2026-08-20.md)).
- `open-bugs.md:940` — The closeout render record cannot name the session that wrote it, on a premise that is false (2026-08-27, medium, from [../reviews/closeout-generation-failure-2026-08-26.md](./reviews/closeout-generation-failure-2026-08-26.md)).
- `open-bugs.md:942` — An analysis record can identify work and reach no work queue, and every gate stays green while it happens (2026-08-27, medium, from the orphan-routing lap).
- `open-bugs.md:963` — The masked-exit guard keyed on TEST RUNNERS, not on whether the exit status is load-bearing — NARROWED to its curated-list half (2026-08-27, narrowed 2026-08-29, medium, friction: tool_should_decide).
- `open-bugs.md:980` — An agent push to `main` is not gated on a full-suite stamp, and the "touched area's suite" rule cannot see a cross-area invariant (2026-09-03, medium, friction: tool_should_decide).
- `open-bugs.md:992` — The backlog's own gates run only at commit, so a writer sees the refusal long after the text is cold (2026-09-03, medium, friction: tool_should_decide).
- `open-bugs.md:1004` — `type-coverage`'s acquired-analyzer spawn carries a deadline ten times longer than the callers actually waiting on it, and an orphaned npm lock makes every later spawn re-pay the same wait (2026-09-04, medium, friction: tool_should_decide).

### [`minor-bugs.md`](backlog/minor-bugs.md)

- `minor-bugs.md:14` — The backlog's `friction:` tags are unchecked, and seven of them are not in the canonical vocabulary (2026-08-30, low, friction: tool_should_decide).
- `minor-bugs.md:25` — `check:backlog-budget` reports the overage but nothing about what to cut, so satisfying it is a guess-and-rerun loop (2026-08-30, low, friction: inefficient_feeding).
- `minor-bugs.md:34` — `question-philosophy-gate` challenges the `/start-lap` approval question, which a skill MANDATES and philosophy cannot settle (2026-08-30, low, friction: false_red).
- `minor-bugs.md:46` — Empty repo-root files named backtick and node.id appeared during vitest/build runs, producer unlocated (2026-08-29, low, friction: hermeticity).
- `minor-bugs.md:53` — A refactor that deletes a symbol NAMED in an escalate-only constitutional doc leaves the doc citing a dead symbol, and no gate notices the dangling state (2026-08-29, low, friction: tool_should_decide).
- `minor-bugs.md:65` — The release pre-tag CI-green gate fails hard on an IN-FLIGHT run instead of watching it (2026-08-29, low, friction: tool_should_decide).
- `minor-bugs.md:75` — HANDOFF's hand-written Immediate-next can claim work that already landed, and nothing checks it (2026-08-29, low, friction: ambiguous_direction).
- `minor-bugs.md:86` — A re-entered `commitFold` can still append ONE duplicate `accepted` event when `recordLaneOutcome` throws after its durable append (2026-08-28, low).
- `minor-bugs.md:99` — The obligation engine's bound doc is off by one against its own comparison (2026-08-28, low).
- `minor-bugs.md:105` — The backlog size baseline holds amnesties for entries that no longer exist, and its file ceiling never ratchets down (2026-08-27, low).
- `minor-bugs.md:114` — `InputResolution` is declared twice, under one name, with two different shapes (2026-08-27, low).
- `minor-bugs.md:124` — The release script's await-run timeout (10 min) is shorter than a GitHub `release`-event delivery delay it then misreads as "no run" (2026-08-26, low, friction: tool_should_decide).
- `minor-bugs.md:141` — The nightly clean-tree rule does not say which writes it blocks (2026-08-22, low, friction: ambiguous_direction).
- `minor-bugs.md:143` — The backlog triage sweep needs a second manual invocation to reach its real coverage (2026-08-22, low, friction: tool_should_decide).
- `minor-bugs.md:144` — No native way to draw a subset of a large findings file into a remediation run (2026-08-22, low, friction: tool_should_decide).
- `minor-bugs.md:146` — A transition that ends the call drops the fold's carried advisories (2026-08-22, low).
- `minor-bugs.md:148` — A release version bump trips the path-A seed-drift alarm (2026-08-23, low, friction: tool_should_decide).
- `minor-bugs.md:153` — The step prompt's "Result status requiring attention" lists MISSING results with the same shape as rejections (2026-08-23, low).
- `minor-bugs.md:158` — Dispatch-lane children still answer the Stop "closeout challenge" despite `AUDIT_TOOLS_CHILD_SESSION=1` (2026-08-23, low).
- `minor-bugs.md:163` — The phase-boundary repository gate re-runs on EVERY `next-step` at the boundary (2026-08-23, low).
- `minor-bugs.md:168` — Reviewer minors carried from the first-draw landings (2026-08-23, low).
- `minor-bugs.md:176` — The friction close-out walk must be written twice under two different names (2026-08-21, low, friction: tool_should_decide).
- `minor-bugs.md:178` — Acquisition of `actionlint` fails on extract (2026-08-21, low).
- `minor-bugs.md:180` — Writing the nightly queue desyncs HANDOFF's generated live-status block (2026-08-20, low, friction: tool_should_decide).
- `minor-bugs.md:188` — recover-ingest / recover-submission leave the last step contract on disk after mutating state (2026-08-19, low).
- `minor-bugs.md:195` — `StateStore.mutate` cannot skip the write — a no-op recovery rewrites an identical state file (2026-08-19, low).
- `minor-bugs.md:200` — Recovery phase-binding residuals from the adversarial review (2026-08-19, low, one entry — three verified residuals):
- `minor-bugs.md:211` — recover-ingest's commander action branch is untested (2026-08-19, low).
- `minor-bugs.md:215` — CP-NODE-10 residuals (2026-08-19, low, one entry):
- `minor-bugs.md:223` — recover-ingest exits 1 when the only issues are `submission_missing` for genuinely-pending work items (2026-08-19, low).
- `minor-bugs.md:227` — The citation gate's verdict depends on transient untracked files (2026-08-19, low, friction: tool_should_decide).
- `minor-bugs.md:237` — `writeOpenItems` accepts an item with no `subject_key` and persists it; the refusal lands two steps later in the HANDOFF generator (2026-08-14, re-hit 2026-08-19, low, friction: tool_should_decide).
- `minor-bugs.md:250` — Modularity refinement is superlinear on one large component and unpinned at scale (2026-08-19, low).
- `minor-bugs.md:256` — The HANDOFF empty-queue projection contract is full-suite-only, so the commit gates pass a red against it (2026-08-18, low, friction; BIT 2026-08-27 — burned tag v0.50.0: a hand-written live-state edit using the word the contract bans passed every commit gate and failed only in the release run's test shard, exactly as this entry predicted).
- `minor-bugs.md:266` — Diff-based re-review loses the verdict it must diff against (2026-08-08, low).
- `minor-bugs.md:272` — `free_form_intent` clause splitter shreds prose on bare `;` (2026-08-08, low).
- `minor-bugs.md:276` — Answering an intake question at the checkpoint does not clear `open_questions` (2026-08-08, low).
- `minor-bugs.md:281` — Regex-perf triage tail from the analyzer sweep (2026-08-07, low).
- `minor-bugs.md:288` — Contract-type coverage is derived from where TESTS live, not from the contract (2026-07-25, low, friction: inefficient-feeding).
- `minor-bugs.md:298` — A deletion of a manifest-listed doc landed with the doc-manifest gate red (2026-08-26, low, <!-- doc-citation-exempt: the deleted file IS the subject — it no longer exists by design --> friction: tool-should-decide).
- `minor-bugs.md:307` — DD-9 + charter slice-staleness — residual only, revisit on live evidence (2026-07-23, low, accepted).
- `minor-bugs.md:328` — A spec row's category prefix is load-bearing enough to manufacture work — and one was false (2026-07-28, low, RESOLVED; the open half is the class).
- `minor-bugs.md:339` — ⬇ Live-run watch (re-dogfood 2026-07-22, low, medium-difficulty — an ATTEMPTED fix was reverted 2026-07-25): completion cleanup removes the friction dir before the session stop-gate's close-out walk runs against it.
- `minor-bugs.md:357` — LEAD (re-dogfood): systemic-challenge round counter + banked improvements carry across RUNS (2026-07-21, low).
- `minor-bugs.md:362` — A stale-artifact re-extraction `next-step` runs >2min with no progress signal, silently blowing a caller timeout (live dogfood 2026-07-17, inefficient-feeding, low).
- `minor-bugs.md:364` — Auditor severity calibration: 0 of 9 self-audit criticals survived mechanism verification (2026-08-06, lead, low).
- `minor-bugs.md:369` — remediate-code step prompts drift from the validators that read their output (2026-08-19, low, friction: tool_should_decide).
- `minor-bugs.md:380` — The commit gate's doc-contract leg did not run check:doc-code-citations for a staged docs/backlog/durable-traps.md (2026-08-19, low) — verified NOT a trigger-set gap; the underlying premise dissolves on inspection.
- `minor-bugs.md:399` — On remediate the fully-green close walks a different friction record than the run wrote (2026-08-23, low).
- `minor-bugs.md:412` — A dated measurement sits inside durable routine prose (2026-08-23, low).
- `minor-bugs.md:420` — The repo-root artifacts have a mechanism and no producer (2026-08-24, low, friction: hermeticity).
- `minor-bugs.md:442` — The remediate loader pair restates what the audit pair now single-sources (2026-08-23, low).
- `minor-bugs.md:450` — The release-gate gloss table is required by a gate and rendered by no consumer (2026-08-27, from the philosophy audit, low).
- `minor-bugs.md:452` — HANDOFF's hand-written region and the closeout both re-narrate state the repository already holds (2026-08-27, from the philosophy audit, low).
- `minor-bugs.md:454` — Three governance vocabularies are copied per consumer instead of shared (2026-08-27, from the philosophy audit, low).
- `minor-bugs.md:456` — A pipeline warning names an internal record id as its resolution action (2026-08-27, from the philosophy audit, low).
- `minor-bugs.md:458` — `check:memory-citations` gates two of the three citation directions, and its guard-reach row names the wrong uncovered half (2026-08-27, low, friction: tool_should_decide).
- `minor-bugs.md:480` — `buildToolingManifest`'s dist walk is a TOCTOU against a concurrent rebuild (2026-08-28, low, friction: tooling_gap).
- `minor-bugs.md:491` — The repo owns its green mechanism but exposes no way to ASK it, so a lap re-derives the answer by hand (2026-08-30, low, friction: tool_should_decide).
- `minor-bugs.md:500` — `refuseSuppliedVerificationStatus` cannot fire on the production judge path (2026-09-03, low).
- `minor-bugs.md:511` — The runtime-artifact-name generator's source list omits two modules that mint runtime names (2026-09-03, low).

### [`forward-tracks.md — Open tracks`](backlog/forward-tracks.md)

- `forward-tracks.md:11` — Track 3 — every emitted lane should carry a size, complexity and risk ranking, so the host can match a model to the work (2026-09-02, owner-directed).
- `forward-tracks.md:30` — Ceremony-review remainder — Tier 2/3 consolidations, plus the one unlanded Part-5 mechanism (2026-08-29).
- `forward-tracks.md:45` — The audit draw WRITES to the audited tree, and the read-only framing does not say so (2026-08-24, raised by CP-NODE-7's refutation lane).
- `forward-tracks.md:54` — Metric-pool empirical program — grouping/characterization metrics (owner-directed 2026-08-19).
- `forward-tracks.md:63` — Track 2.5 — keep production-orphan detection beside knip.

### [`forward-tracks.md — Forward tracks`](backlog/forward-tracks.md)

- `forward-tracks.md:77` — A2 finding-quality oracle — the corpus is SMALL, PUBLIC, PINNED git repos, never labeled self-audit runs.
- `forward-tracks.md:101` — End-to-end remediate-run smoke exercising the tool-owned gate (from the 2026-07-12 dogfood).
- `forward-tracks.md:109` — Deterministic analyzers: own-vs-acquire engine.
- `forward-tracks.md:124` — CI wall-clock: shard balance and the single-file floor.
- `forward-tracks.md:131` — Obligation-id slugs and decomposed-module names are two name spaces joined by a prefix match.
- `forward-tracks.md:143` — Wave-friendly host dispatch: run identity survives partial ingest.
- `forward-tracks.md:157` — Isolated-branch landing gap — a remediation run dispatched on its own `remediation/<runId>` branch has no closing action that lands it on the base branch.
- `forward-tracks.md:166` — One-core dissolution lap — the two draws are converged; what remains is two adapter divergences (owner-routed 2026-08-19, RE-BASELINED 2026-08-27).
- `forward-tracks.md:191` — ▶ Audit-tools deep-review acceptance benchmark still needs its external run.
- `forward-tracks.md:213` — The ship pipeline stops before the steps that finish it, and the remainder is agent prose (2026-08-27, from the philosophy audit).

### [`deferred.md`](backlog/deferred.md)

- `deferred.md:11` — A7 multi-host validation — automated half green, manual GUI half never run.
- `deferred.md:21` — Manual real-OpenCode validation
- `deferred.md:24` — Prose-heavy staleness narrowing — the cascade-cost measurement and the remaining prose artifacts stay deferred (2026-07-24, low).

### [`durable-traps.md`](backlog/durable-traps.md)

- `durable-traps.md:16` — A delegated `codex exec` lane runs the sprint ceremony and CONSUMES the session's lap record (2026-08-29, ENFORCED IN PART).
- `durable-traps.md:31` — `gh run list --commit <short-sha>` silently returns an EMPTY set — the flag matches the FULL 40-character sha only (2026-08-29).
- `durable-traps.md:37` — Parallel deep `codex exec` lanes exhaust the ChatGPT quota in well under an hour, and a lane dies mid-answer with NO verdict (2026-08-28).
- `durable-traps.md:49` — Mechanical-analyzer acquisitions decided against — do not re-propose without new evidence (folded here 2026-08-27 from the retired mechanical-analyzer layer spec, now deleted).
- `durable-traps.md:64` — `git add -A` in a SHARED checkout commits a CONCURRENT session's files under your message (2026-08-26).
- `durable-traps.md:73` — Generating code through a Bash heredoc loses ONE level of backslash escaping (2026-08-26).
- `durable-traps.md:82` — Two pushes landing close together can leave the NEWER commit with no CI signal (2026-08-26).
- `durable-traps.md:89` — A session rooted ABOVE the repo loads NONE of its hooks, so every commit gate is silently absent (measured 2026-08-26).
- `durable-traps.md:101` — Each `dispatch_review` `next-step` re-mints EVERY outstanding binding (measured 2026-08-21).
- `durable-traps.md:103` — The llm-relay process dies with the dispatching session, and nothing restarts it (2026-08-21).
- `durable-traps.md:105` — A tracked generated doc that links to an UNTRACKED file blocks every docs-touching commit (2026-08-20).
- `durable-traps.md:115` — `git commit` after `git add <paths>` commits the whole INDEX, not your paths (2026-08-20).
- `durable-traps.md:121` — A vitest CLI file filter resurrects same-suffixed test COPIES under stale worktree dirs (2026-08-06).
- `durable-traps.md:132` — The Workflow tool's per-agent `model` override may not take (observed 2026-08-06).
- `durable-traps.md:139` — A spend-limit death returns a workflow as `completed` with a success-shaped empty result (2026-08-25).
- `durable-traps.md:149` — A broad multi-file review scope kills both peer-CLI lanes, and they fail in OPPOSITE shapes (2026-08-09 and 2026-08-10, four deaths in two nights).
- `durable-traps.md:177` — A PreToolUse block kills the WHOLE chained command — the earlier statements never ran (2026-07-25).
- `durable-traps.md:185` — An "open item" claim in a MEMORY or spec is a lead, not a work order (2026-07-19).
- `durable-traps.md:190` — Never delete from a backlog file by LINE NUMBER.
- `durable-traps.md:196` — A long multi-line prompt passed INLINE to a peer-CLI lane arrives truncated, and the lane then offers to work from whatever file it can find (2026-08-23).
- `durable-traps.md:209` — A lane that lost its tools FABRICATES a confident answer instead of failing — but workspace trust is NOT what takes them away (2026-08-15, premise corrected by measurement 2026-08-29).
- `durable-traps.md:232` — The offload lane degrades on TWO independent axes — payload SIZE and CONCURRENCY — and both look identical to a weak or dead model
- `durable-traps.md:261` — The Bash tool silently CLAMPS `timeout` to 600000ms (2026-07-24).
- `durable-traps.md:274` — Empty repo-root files named from code or prose are cmd.exe REDIRECT artifacts, and since 2026-08-30 NOTHING in this repo watches for them (relanded here as its guard was deleted).
- `durable-traps.md:291` — Git Bash MANGLES a leading-slash argument into a Windows path (2026-07-25).
- `durable-traps.md:305` — Concurrent agent sessions can share the ONE primary checkout (2026-07-23).
- `durable-traps.md:323` — The pre-commit gate scans the WHOLE command string — including commit-message text — for the hooksPath/no-verify bypass tokens (2026-07-21).
- `durable-traps.md:337` — The offload lane must inline source WITH LINE NUMBERS, or any file:line ask is unanswerable (2026-07-20, medium).
- `durable-traps.md:345` — An offload-lane model will fabricate SUPPORTING QUOTES while getting the STRUCTURE right (2026-07-20, medium).
- `durable-traps.md:355` — The free offload lane is a local router — it must be RUNNING, and callers should request the `auto` alias.
- `durable-traps.md:384` — After an unattended run, `git diff` the tracked docs before committing.
- `durable-traps.md:396` — npm 12 (local, since ~2026-07-09) blocks dependency install scripts by default (`allowScripts`).
- `durable-traps.md:418` — `git push audit-tools HEAD:main` prints a "Changes must be made through a pull request" advisory that is NOT a rejection.
- `durable-traps.md:424` — The `audit-code-completion-*.test.ts` family drives the full audit flow in-process, so a long file wall is expected, not a hang.
- `durable-traps.md:444` — One test runner: vitest
- `durable-traps.md:458` — Don't mask the test exit code with a REDIRECT.
- `durable-traps.md:476` — Global `-g` install BLOCKS `postinstall`
- `durable-traps.md:486` — A global junction to a LIVE working tree silently shadows a registry install.
- `durable-traps.md:492` — PowerShell
- `durable-traps.md:501` — Packaged/global-install drift is caught ONLY by `smoke:packaged-*`, never by dev, `npm run check`, knip or vitest — so it fails the gate loudly, not silently.
- `durable-traps.md:517` — A `vi.spyOn` on the `audit-tools/shared` re-export barrel passes VACUOUSLY.
- `durable-traps.md:530` — Front-load a broad "does this already exist" sweep BEFORE authoring goal_spec/context_bundle/ module_decomposition, not just a targeted one.
- `durable-traps.md:537` — Don't fan out a large mechanical edit across parallel subagents that spawn their OWN grandchildren.
- `durable-traps.md:542` — Do not hand-edit a wedged audit run — use `audit-code force-synthesis`.
- `durable-traps.md:547` — A scratch file written into the repository root is tree dirt for the nightly clean-tree rule (2026-08-22, low).
- `durable-traps.md:554` — A residual-reference check run with an ignore-bypassing search manufactures false positives (2026-07-24, low).
- `durable-traps.md:556` — A root-containment check must survive BOTH a win32 cross-drive path and a real `..`-prefixed name.
- `durable-traps.md:564` — The Grep tool's content output can mangle comment markers with a BACKSLASH.
- `durable-traps.md:569` — After a "string to replace not found" on text you JUST wrote, grep for the anchor instead of re-reading the whole file (2026-07-16).
- `durable-traps.md:573` — A `check:*` typecheck leg can exit non-zero with NO error text when it races the async PostToolUse typecheck hook (2026-08-27).
- `durable-traps.md:581` — A typecheck sweep's error count is not final until you re-run it.
- `durable-traps.md:589` — An untypechecked fixture can sit inert for months while its suite reads green.
- `durable-traps.md:610` — Cite a SYMBOL, never a bare line number — and when no good symbol exists, cite the file alone.
- `durable-traps.md:621` — A backlog entry's bold title must not contain `
- `durable-traps.md:626` — Child sessions in the shared checkout — session-registry split (2026-08-18, mechanized; supersedes the 2026-08-07/09 kill-switch advice).
- `durable-traps.md:658` — The `audit-code-completion-*` files can flake together under full-suite load, and the symptom reads exactly like a regression (2026-08-09).
- `durable-traps.md:676` — An offload recon lane reading a file you are concurrently editing reports the POST-edit tree (2026-08-07).
- `durable-traps.md:683` — Long offload recon jobs die mid-response; short ones do not (2026-08-07).
- `durable-traps.md:697` — `.audit-tools/remediation-report.md` and `-outcomes.json` are TRACKED — archiving a finished run deletes them (2026-08-09).
- `durable-traps.md:708` — A background lane piped through `tail`/`head` shows ZERO bytes until it exits (2026-08-09).
- `durable-traps.md:717` — Right after the free router restarts, its `/v1` Anthropic surface can forward a router-local key UPSTREAM — a transient 401 window, not a permanent property (2026-08-09).
- `durable-traps.md:734` — A trivial `claude.ps1 -p` prompt did not return in 5 min while the router answered in 0.4s (2026-08-09).
- `durable-traps.md:743` — An external-delegation directive and the Workflow tool are in tension — Workflow has no external lane (2026-08-27).
- `durable-traps.md:752` — agy lanes report no progress until they finish — `stdoutBytes` stays 0 for the whole run (2026-08-27).
- `durable-traps.md:760` — The MCP `pool` offload lane's `--model auto` alias warns, and its `model` override is INERT (2026-08-27, mechanism corrected 2026-08-29).
- `durable-traps.md:770` — A free-pool reply that returns nothing usable is usually `finish_reason: max_tokens`, not a weak model (2026-08-09).
- `durable-traps.md:781` — `.gitignore`'s `>>> audit-tools managed ignores >>>` block is GENERATED — a rule added between its markers is silently wiped (2026-07-30).
- `durable-traps.md:790` — The contract-pipeline repair prompt orders the OPPOSITE of the repair invariant (2026-08-09).
- `durable-traps.md:798` — A critique can prescribe a remedy the pipeline structurally cannot perform (2026-08-09).
- `durable-traps.md:808` — The per-project memory store has NO locking, and a concurrent session silently reverts your edits (2026-08-09).
- `durable-traps.md:815` — The `~/.claude/…/memory/MEMORY.md` index has no size gate, and the harness read limit is a hard cliff (2026-08-09).
- `durable-traps.md:821` — An attestation binds to the staged tree, and a later gate-demanded regeneration used to void it (2026-08-09; ENFORCED at the attest scripts 2026-08-12, P19).
- `durable-traps.md:836` — `docs/backlog.md` is NOT a record path to `writeOpenItems`, but `docs/backlog/*` is
- `durable-traps.md:847` — Git-bash `/tmp` and node's `C: mp` are different directories (hit 2026-08-18).
- `durable-traps.md:852` — A commit-carries-its-record-update gate has a covered mechanical half and an uncovered semantic half (measured 2026-08-18, closed covered-by-neighbors).
- `durable-traps.md:866` — Never amend or rebase a landed wave commit after the remediation workload prepare (2026-08-19).
- `durable-traps.md:874` — A subagent's Read tool can serve STALE pre-edit content for a file another agent is concurrently editing (2026-08-20).
- `durable-traps.md:882` — A COMMENT-only edit to a graph extractor reds the graph-edge cache digest pin, and the failure text tells you to bump the cache version (2026-08-24).
- `durable-traps.md:890` — CBM graph tools can be absent while its daemon is healthy, and the fallback CLI can be cohort-locked (2026-08-26).
- `durable-traps.md:892` — Philosophy-audit challenges already answered — do not re-propose without new evidence (2026-08-27).
- `durable-traps.md:894` — A workflow killed mid-run by the monthly spend limit reports COMPLETED, and its partial results are recoverable by run id (2026-08-27).
- `durable-traps.md:906` — A long quoted heredoc in the Bash tool can die with "unexpected EOF while looking for matching quote", and the reported line is the last line that arrived (2026-08-27).
- `durable-traps.md:916` — Philosophy-audit challenges PH-04, PH-05 and PH-08 are ANSWERED — the refused halves must not come back (2026-08-27).
- `durable-traps.md:933` — Two offload lanes fail SUCCESS-SHAPED, and neither reports why in its status (2026-08-28).
- `durable-traps.md:948` — A literal `<<'EOF'` heredoc still loses one level of backslash, because the TOOL JSON eats it before the shell ever sees it (2026-08-28).
- `durable-traps.md:959` — A quota-exhaustion message names a reset date, and that date is not a prediction (2026-08-28).
- `durable-traps.md:965` — "File missing" is classified from ENOENT alone, and a path that traverses a FILE does not report ENOENT on both platforms (2026-09-03).

<!-- END GENERATED SEEK INDEX -->

**Log friction the moment you hit it** — non-obvious traps, misbehaving tools, missing affordances,
shell/env quirks. One line to `backlog/open-bugs.md` (a fixable defect) or
`backlog/durable-traps.md` (a standing gotcha) before moving on.

**Verify an entry's PREMISE against HEAD before opening a lap on it.** Backlog prose decays, and it
decays in a specific way: not merely going stale, but *paraphrasing an incident until the mechanism
inverts*. Two entries did exactly that this cycle, and each cost a wrong implementation before the
primary record was re-read. An entry that reinterprets an incident must quote or link the primary
record's own words for the mechanism.

**Per-entry size budget.** Entries earn their length, but the growth driver is post-mortem narrative
accreting after the fact. `npm run check:backlog-budget` fails the build on an entry past the
budget; condense at write time, and put the narrative in `git log` or a `docs/reviews/` record.

---

## Live-validation guide — READ FIRST if you're running a live audit/remediate


Some open items carry a **⬇ Live-run watch** line: exactly what to observe during a real run to
confirm the fix validated — or to catch it failing. Pick a run config from this matrix; watch the
items it lights up.

| Run config | Items it exercises (watch their ⬇ lines) |
|---|---|
| **Any** live audit | Selective-deepening convergence · prompt-bound result ingestion · knip `files`/`dependencies` dead-code leads |
| **Any** live remediation on a dirty checkout | Allowed-file enforcement · run-start-dirt overlap · commit/test/worktree evidence · pause/resume continuity |
| **Two cooperating hosts** | Idempotent audit ingestion · locked remediation state transitions · stale workload rejection |
| **Rust or Ruby target repo** | clippy (cargo) + rubocop (bundle) live spawn |

**General fail-signals to log on ANY live run** (add a line under *Open bugs* if you hit one): a run
that wedges and needs `force-synthesis` to finish · orphaned pending `deepening:*` tasks · a crash
while ingesting a partial workload · an analyzer that silently skipped when it should have spawned ·
a host result accepted despite a prompt/scope mismatch · knip dead-code leads that never reach the
per-file lens. (The A2 oracle corpus is now
pinned public repos, not labeled live runs — a run's findings are at most optional calibration
data; see Deferred / waiting.)

---
