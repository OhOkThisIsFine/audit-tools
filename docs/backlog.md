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
> and at commit). 215 entr(y/ies) indexed.

### [`open-bugs.md`](backlog/open-bugs.md)

- `open-bugs.md:9` — The suite's added-root-entry teardown check is not hermetic against a CONCURRENT session in the shared checkout, and it reds a commit whose own tests all passed (2026-08-27, medium, friction: false_red).
- `open-bugs.md:23` — `shell-trap-guard`'s PowerShell here-string rule did not fire on two Bash-tool commits and then fired on a third near-identical one (2026-08-27, medium).
- `open-bugs.md:35` — The rendered decision queue and its tracked snapshot can outlive the ledger that settles them, and nothing gates the disagreement (2026-08-27, medium, friction: tool_should_decide).
- `open-bugs.md:58` — The backlog size baseline holds amnesties for entries that no longer exist, and its file ceiling never ratchets down (2026-08-27, low).
- `open-bugs.md:67` — `InputResolution` is declared twice, under one name, with two different shapes (2026-08-27, low).
- `open-bugs.md:77` — The release script's await-run timeout (10 min) is shorter than a GitHub `release`-event delivery delay it then misreads as "no run" (2026-08-26, low, friction: tool_should_decide).
- `open-bugs.md:94` — The nightly clean-tree rule does not say which writes it blocks (2026-08-22, low, friction: ambiguous_direction).
- `open-bugs.md:96` — The backlog triage sweep needs a second manual invocation to reach its real coverage (2026-08-22, low, friction: tool_should_decide).
- `open-bugs.md:97` — The critique-driven contract repair step renders the judge-repair template (2026-08-22, medium).
- `open-bugs.md:99` — Remediation intake drops a finding with no `evidence` array, and the audit systemic-challenge lane emits findings without one (2026-08-22, medium).
- `open-bugs.md:101` — No native way to draw a subset of a large findings file into a remediation run (2026-08-22, low, friction: tool_should_decide).
- `open-bugs.md:103` — The contract-pipeline phase cut unions the drafted `neighbor_needs` into the finalized contracts' dependency graph, so symmetric coordination prose overrides every declared token edge (2026-08-22, high).
- `open-bugs.md:105` — The contract-pipeline adversarial judge can demand what the finalized-contract schema cannot express, and its convergence guard then blocks the run on the host (2026-08-22, high).
- `open-bugs.md:107` — A transition that ends the call drops the fold's carried advisories (2026-08-22, low).
- `open-bugs.md:109` — The DAG-derived write scope omits the companion files a fix needs, so the host hand-widens `touched_files` (2026-08-23, high, friction: tool_should_decide).
- `open-bugs.md:121` — An empty dispatch frontier THROWS instead of pausing (2026-08-23, high, friction: tool_should_decide).
- `open-bugs.md:130` — The Implementation DAG prompt does not state the one-invocation rule for `targeted_commands` (2026-08-23, medium, friction: tool_should_decide).
- `open-bugs.md:137` — A release version bump trips the path-A seed-drift alarm (2026-08-23, low, friction: tool_should_decide).
- `open-bugs.md:142` — The step prompt's "Result status requiring attention" lists MISSING results with the same shape as rejections (2026-08-23, low).
- `open-bugs.md:147` — The per-item required tests and the host landing gate do not include the tree-wide guard suites or the cheap release gates, and every landing's evidence is Windows-local (2026-08-23, medium).
- `open-bugs.md:157` — Dispatch-lane children still answer the Stop "closeout challenge" despite `AUDIT_TOOLS_CHILD_SESSION=1` (2026-08-23, low).
- `open-bugs.md:162` — The phase-boundary repository gate re-runs on EVERY `next-step` at the boundary (2026-08-23, low).
- `open-bugs.md:167` — Reviewer minors carried from the first-draw landings (2026-08-23, low).
- `open-bugs.md:175` — The friction close-out walk must be written twice under two different names (2026-08-21, low, friction: tool_should_decide).
- `open-bugs.md:177` — The systemic-challenge lane prompt withholds the banked findings it asks the adversary to beat (2026-08-21, medium).
- `open-bugs.md:179` — Acquisition of `actionlint` fails on extract (2026-08-21, low).
- `open-bugs.md:181` — Conceptual-review DEPTH is still modelled as durable when it must be per-run (2026-08-21, owner directive, medium).
- `open-bugs.md:183` — Promotion and close residuals from the CP-NODE-3/15 reviews (low, one entry).
- `open-bugs.md:203` — Writing the nightly queue desyncs HANDOFF's generated live-status block (2026-08-20, low, friction: tool_should_decide).
- `open-bugs.md:211` — next-step discards a rejected submission's classified issues (2026-08-20, medium, friction: tool_should_decide).
- `open-bugs.md:224` — Host-handoff residuals from the CP-NODE-6 landing (low, one entry).
- `open-bugs.md:248` — Analyzer-boundary residuals from the CP-NODE-1 review (low).
- `open-bugs.md:265` — Staleness third-state residuals from the CP-NODE-10 review (low).
- `open-bugs.md:273` — Emission-scaffold and gate residuals from the CP-NODE-12/13 reviews (low).
- `open-bugs.md:284` — Charter and route residuals from the CP-NODE-18/19 reviews (low).
- `open-bugs.md:297` — Drift-guard residuals from the CP-NODE-25 review (low).
- `open-bugs.md:307` — `fixture-generator-drift-guard` is not hermetic (low, friction).
- `open-bugs.md:313` — A scoped wave item that coins an invariant id in `src/` is structurally unable to satisfy the id-glossary gate (2026-08-20, medium, friction: tool_should_decide).
- `open-bugs.md:324` — The remediate-side submission ledger has no reader — `accepted_via_recovery` marks are write-only (2026-08-19, low-medium).
- `open-bugs.md:332` — recover-ingest / recover-submission leave the last step contract on disk after mutating state (2026-08-19, low).
- `open-bugs.md:339` — `StateStore.mutate` cannot skip the write — a no-op recovery rewrites an identical state file (2026-08-19, low).
- `open-bugs.md:344` — Recovery phase-binding residuals from the adversarial review (2026-08-19, low, one entry — three verified residuals):
- `open-bugs.md:355` — recover-ingest's commander action branch is untested (2026-08-19, low).
- `open-bugs.md:359` — CP-NODE-10 residuals (2026-08-19, low, one entry):
- `open-bugs.md:367` — recover-ingest exits 1 when the only issues are `submission_missing` for genuinely-pending work items (2026-08-19, low).
- `open-bugs.md:371` — The pre-commit round-trip journal is not bound to the HEAD it was captured under, so crash recovery can time-travel the tree backward (2026-08-19, high).
- `open-bugs.md:384` — The citation gate's verdict depends on transient untracked files (2026-08-19, low, friction: tool_should_decide).
- `open-bugs.md:394` — `writeOpenItems` accepts an item with no `subject_key` and persists it; the refusal lands two steps later in the HANDOFF generator (2026-08-14, re-hit 2026-08-19, low, friction: tool_should_decide).
- `open-bugs.md:407` — Modularity refinement is superlinear on one large component and unpinned at scale (2026-08-19, low).
- `open-bugs.md:413` — The TASK draw's coherence eligibility is still disjunctive and has never been measured for collapse (2026-08-19, medium).
- `open-bugs.md:420` — The HANDOFF empty-queue projection contract is full-suite-only, so the commit gates pass a red against it (2026-08-18, low, friction; BIT 2026-08-27 — burned tag v0.50.0: a hand-written live-state edit using the word the contract bans passed every commit gate and failed only in the release run's test shard, exactly as this entry predicted).
- `open-bugs.md:430` — `runCommand` buffers child output unboundedly (2026-08-13, medium).
- `open-bugs.md:437` — `shell-trap-guard` misses `git stash push <pathspec>` eating uncommitted work (2026-08-12, medium).
- `open-bugs.md:443` — Contract-pipeline fan-out names a mechanism the host may not have (2026-08-08, medium).
- `open-bugs.md:451` — Diff-based re-review loses the verdict it must diff against (2026-08-08, low).
- `open-bugs.md:457` — `free_form_intent` clause splitter shreds prose on bare `;` (2026-08-08, low).
- `open-bugs.md:461` — Answering an intake question at the checkpoint does not clear `open_questions` (2026-08-08, low).
- `open-bugs.md:466` — Sweep the test tree for tests that re-implement their subject (2026-08-08, medium).
- `open-bugs.md:475` — Regex-perf triage tail from the analyzer sweep (2026-08-07, low).
- `open-bugs.md:482` — Vitest worker RPC starvation — the false-RED exit is CLOSED at the gate; the >60s blocking worker is unlocated (recharacterized 2026-08-07; was "full-suite exits 1 while every test passes", 2026-08-06).
- `open-bugs.md:501` — Remediation pause/recovery is not durable (2026-08-03, medium).
- `open-bugs.md:509` — Graph heuristics are promoted to findings without a semantic lead boundary (2026-08-03, medium).
- `open-bugs.md:516` — Tool-owned gate reds are unattributed — foreign live-tree dirt pauses the run (2026-07-30, shrunk 2026-08-20; was "Phase-boundary gate false abandonment", HIGH).
- `open-bugs.md:530` — Contract-type coverage is derived from where TESTS live, not from the contract (2026-07-25, low, friction: inefficient-feeding).
- `open-bugs.md:540` — A deletion of a manifest-listed doc landed with the doc-manifest gate red (2026-08-26, low, <!-- doc-citation-exempt: the deleted file IS the subject — it no longer exists by design --> friction: tool-should-decide).
- `open-bugs.md:549` — Backlog prose paraphrased an incident in a way that INVERTED its mechanism, costing a wrong implementation (2026-07-24, medium, friction: ambiguous-direction).
- `open-bugs.md:559` — DD-9 + charter slice-staleness — residual only, revisit on live evidence (2026-07-23, low, accepted).
- `open-bugs.md:584` — A spec row's category prefix is load-bearing enough to manufacture work — and one was false (2026-07-28, low, RESOLVED; the open half is the class).
- `open-bugs.md:595` — ⬇ Live-run watch (re-dogfood 2026-07-22, medium): a worker self-reported "valid, verified" on a malformed-JSON result file — result validity must be checked mechanically, never trusted from the worker's claim.
- `open-bugs.md:603` — ⬇ Live-run watch (re-dogfood 2026-07-22, low, medium-difficulty — an ATTEMPTED fix was reverted 2026-07-25): completion cleanup removes the friction dir before the session stop-gate's close-out walk runs against it.
- `open-bugs.md:621` — LEAD (re-dogfood): systemic-challenge round counter + banked improvements carry across RUNS (2026-07-21, low).
- `open-bugs.md:626` — Review rounds re-derive the same file map every time (inefficient-feeding, 2026-07-19).
- `open-bugs.md:647` — A per-site pinning gate would make "red-green validated" mechanically checkable — UNBUILT on main.
- `open-bugs.md:667` — Friction walk (determinations-execution lap, 2026-07-29):
- `open-bugs.md:681` — Friction walk (duplicated-guard lap, 2026-07-25):
- `open-bugs.md:693` — Implementation workers are never given the contract they must satisfy (2026-08-09, high).
- `open-bugs.md:703` — Self-audit dogfood loop: fixing the tool mid-run invalidates the run (2026-07-16, ambiguous-direction, low-medium).
- `open-bugs.md:719` — A stale-artifact re-extraction `next-step` runs >2min with no progress signal, silently blowing a caller timeout (live dogfood 2026-07-17, inefficient-feeding, low).
- `open-bugs.md:721` — Friction walk (niggle-fix lap, 2026-08-07):
- `open-bugs.md:739` — Friction walk (loop-core `.ts`-conversion tranche lap, 2026-07-28):
- `open-bugs.md:751` — Friction walk (nightly-determinations lap, 2026-07-26):
- `open-bugs.md:763` — Friction walk (touched_files load-gate lap, 2026-07-25):
- `open-bugs.md:769` — Friction walk (fourth backlog-clearance lap, 2026-07-24):
- `open-bugs.md:782` — Friction walk (second backlog-clearance lap, 2026-07-24):
- `open-bugs.md:791` — Untracked-exclusion scope rule — residuals only (each low-severity, documented at the code site).
- `open-bugs.md:817` — External shared-logic audit V1–V7 residuals
- `open-bugs.md:829` — Top gate optimization — the suite-side tail is subprocess wall, not isolation overhead (measured 2026-07-06).
- `open-bugs.md:835` — Selective-deepening convergence — live validation env-bound.
- `open-bugs.md:843` — `goal_id` is read verbatim off the LLM envelope, so its format is unvalidated (re-verified at HEAD 2026-07-25).
- `open-bugs.md:852` — `StepArtifactSchema` is `.strict()` but `writeStepContract` injects `agent_id`.
- `open-bugs.md:858` — systemic_challenge findings ids are adversary-invented and round-colliding.
- `open-bugs.md:865` — The systemic_challenge loop has no ceiling — its only exit is a dry signal the host may have to fabricate.
- `open-bugs.md:872` — `ensure` writes opencode.json with unstable key order.
- `open-bugs.md:877` — Auditor severity calibration: 0 of 9 self-audit criticals survived mechanism verification (2026-08-06, lead, low).
- `open-bugs.md:882` — Steward verification metadata is undeliverable through the host-result envelope (hit 2026-08-18).
- `open-bugs.md:892` — The report renderer emits control characters from finding prose raw (hit 2026-08-18).
- `open-bugs.md:899` — remediate-code step prompts drift from the validators that read their output (2026-08-19, low, friction: tool_should_decide).
- `open-bugs.md:910` — The commit gate's doc-contract leg did not run check:doc-code-citations for a staged docs/backlog/durable-traps.md (2026-08-19, low) — verified NOT a trigger-set gap; the underlying premise dissolves on inspection.
- `open-bugs.md:929` — On remediate the fully-green close walks a different friction record than the run wrote (2026-08-23, low).
- `open-bugs.md:942` — A killed `next-step` wedges `phase.lock` for every later call (2026-08-24, remediation run, medium).
- `open-bugs.md:951` — Host-widened scope on a live-bound block wedges `next-step` (2026-08-23, remediation run, medium).
- `open-bugs.md:961` — A dated measurement sits inside durable routine prose (2026-08-23, low).
- `open-bugs.md:969` — The repo-root artifacts have a mechanism and no producer (2026-08-24, low, friction: hermeticity).
- `open-bugs.md:988` — The remediate loader pair restates what the audit pair now single-sources (2026-08-23, low).
- `open-bugs.md:996` — A provenance plane with no producer is still exported, advertised and documented (2026-08-27, from the philosophy audit, medium).
- `open-bugs.md:998` — Three persisted contracts are read back without the schema that defines them (2026-08-27, from the philosophy audit, medium).
- `open-bugs.md:1000` — The pre-split design-review lane is still polled beside the two current judgment types (2026-08-27, from the philosophy audit, medium).
- `open-bugs.md:1002` — The systemic-challenge convergence rule is underspecified in the spec and fixed at one round in code (2026-08-27, from the philosophy audit, low).
- `open-bugs.md:1004` — The release-gate gloss table is required by a gate and rendered by no consumer (2026-08-27, from the philosophy audit, low).
- `open-bugs.md:1006` — HANDOFF's hand-written region and the closeout both re-narrate state the repository already holds (2026-08-27, from the philosophy audit, low).
- `open-bugs.md:1008` — Three governance vocabularies are copied per consumer instead of shared (2026-08-27, from the philosophy audit, low).
- `open-bugs.md:1010` — A pipeline warning names an internal record id as its resolution action (2026-08-27, from the philosophy audit, low).
- `open-bugs.md:1012` — The N-R13 status invariant asserts its own literal, and the status vocabulary exists in three unlinked copies (2026-08-27, low-medium).
- `open-bugs.md:1028` — The dispatch boundary strips every per-node field the contract pipeline writes onto a promoted finding but `FindingSchema` does not declare (2026-08-27, medium).
- `open-bugs.md:1048` — The two evidence-bearing terminal dispositions have no producer — `verified_already_fixed` and `refuted` are unreachable in any real run (2026-08-27, medium, from [`reviews/wave2-dispositions-2026-08-20.md`](./reviews/wave2-dispositions-2026-08-20.md)).
- `open-bugs.md:1073` — The closeout render record cannot name the session that wrote it, on a premise that is false (2026-08-27, medium, from [../reviews/closeout-generation-failure-2026-08-26.md](./reviews/closeout-generation-failure-2026-08-26.md)).
- `open-bugs.md:1075` — `check:memory-citations` gates two of the three citation directions, and its guard-reach row names the wrong uncovered half (2026-08-27, low, friction: tool_should_decide).
- `open-bugs.md:1097` — The shared-hash gate is spelled `sha256`, so an inline sha1 chain re-rolls the anti-pattern it bans (2026-08-27, refutation pass over [`shared-helper-adoption-2026-08-25`](./reviews/shared-helper-adoption-2026-08-25.md)).
- `open-bugs.md:1103` — An analysis record can identify work and reach no work queue, and every gate stays green while it happens (2026-08-27, medium, from the orphan-routing lap).
- `open-bugs.md:1124` — The masked-exit guard reaches SUITE commands only, so a rejected `git push` reads as exit 0 (2026-08-27, medium, friction: tool_should_decide).

### [`forward-tracks.md — Open tracks`](backlog/forward-tracks.md)

- `forward-tracks.md:29` — Track 2.5 — keep production-orphan detection beside knip.

### [`forward-tracks.md — Forward tracks`](backlog/forward-tracks.md)

- `forward-tracks.md:43` — ▶ CX-02 — one audit obligation registry, one drain.
- `forward-tracks.md:64` — A2 finding-quality oracle — the corpus is SMALL, PUBLIC, PINNED git repos, never labeled self-audit runs.
- `forward-tracks.md:88` — End-to-end remediate-run smoke exercising the tool-owned gate (from the 2026-07-12 dogfood).
- `forward-tracks.md:96` — Deterministic analyzers: own-vs-acquire engine.
- `forward-tracks.md:111` — CI wall-clock: shard balance and the single-file floor.
- `forward-tracks.md:118` — Obligation-id slugs and decomposed-module names are two name spaces joined by a prefix match.
- `forward-tracks.md:130` — Wave-friendly host dispatch: run identity survives partial ingest.
- `forward-tracks.md:144` — Isolated-branch landing gap — a remediation run dispatched on its own `remediation/<runId>` branch has no closing action that lands it on the base branch.
- `forward-tracks.md:153` — One-core dissolution lap — the two draws are converged; what remains is two adapter divergences (owner-routed 2026-08-19, RE-BASELINED 2026-08-27).
- `forward-tracks.md:178` — Audit-tools does not reach the standalone prompt's simplification quality — rewire the deep path, then measure.
- `forward-tracks.md:199` — The ship pipeline stops before the steps that finish it, and the remainder is agent prose (2026-08-27, from the philosophy audit).

### [`deferred.md`](backlog/deferred.md)

- `deferred.md:11` — A7 multi-host validation — automated half green, manual GUI half never run.
- `deferred.md:21` — Manual real-OpenCode validation
- `deferred.md:24` — Prose-heavy staleness narrowing — the cascade-cost measurement and the remaining prose artifacts stay deferred (2026-07-24, low).

### [`durable-traps.md`](backlog/durable-traps.md)

- `durable-traps.md:16` — Mechanical-analyzer acquisitions decided against — do not re-propose without new evidence (folded here 2026-08-27 from the retired mechanical-analyzer layer spec, now deleted).
- `durable-traps.md:31` — `git add -A` in a SHARED checkout commits a CONCURRENT session's files under your message (2026-08-26).
- `durable-traps.md:40` — Generating code through a Bash heredoc loses ONE level of backslash escaping (2026-08-26).
- `durable-traps.md:49` — Two pushes landing close together can leave the NEWER commit with no CI signal (2026-08-26).
- `durable-traps.md:56` — A session rooted ABOVE the repo loads NONE of its hooks, so every commit gate is silently absent (measured 2026-08-26).
- `durable-traps.md:68` — Each `dispatch_review` `next-step` re-mints EVERY outstanding binding (measured 2026-08-21).
- `durable-traps.md:70` — The llm-relay process dies with the dispatching session, and nothing restarts it (2026-08-21).
- `durable-traps.md:72` — A tracked generated doc that links to an UNTRACKED file blocks every docs-touching commit (2026-08-20).
- `durable-traps.md:82` — `git commit` after `git add <paths>` commits the whole INDEX, not your paths (2026-08-20).
- `durable-traps.md:88` — A vitest CLI file filter resurrects same-suffixed test COPIES under stale worktree dirs (2026-08-06).
- `durable-traps.md:99` — The Workflow tool's per-agent `model` override may not take (observed 2026-08-06).
- `durable-traps.md:106` — A spend-limit death returns a workflow as `completed` with a success-shaped empty result (2026-08-25).
- `durable-traps.md:116` — A broad multi-file review scope kills both peer-CLI lanes, and they fail in OPPOSITE shapes (2026-08-09 and 2026-08-10, four deaths in two nights).
- `durable-traps.md:138` — A PreToolUse block kills the WHOLE chained command — the earlier statements never ran (2026-07-25).
- `durable-traps.md:146` — An "open item" claim in a MEMORY or spec is a lead, not a work order (2026-07-19).
- `durable-traps.md:151` — Never delete from a backlog file by LINE NUMBER.
- `durable-traps.md:157` — A long multi-line prompt passed INLINE to a peer-CLI lane arrives truncated, and the lane then offers to work from whatever file it can find (2026-08-23).
- `durable-traps.md:170` — A Claude lane whose isolated `CLAUDE_CONFIG_DIR` has not TRUSTED the workspace answers from nothing rather than failing (2026-08-15).
- `durable-traps.md:186` — The offload lane degrades on TWO independent axes — payload SIZE and CONCURRENCY — and both look identical to a weak or dead model
- `durable-traps.md:215` — The Bash tool silently CLAMPS `timeout` to 600000ms (2026-07-24).
- `durable-traps.md:228` — Git Bash MANGLES a leading-slash argument into a Windows path (2026-07-25).
- `durable-traps.md:239` — Concurrent agent sessions can share the ONE primary checkout (2026-07-23).
- `durable-traps.md:257` — The pre-commit gate scans the WHOLE command string — including commit-message text — for the hooksPath/no-verify bypass tokens (2026-07-21).
- `durable-traps.md:271` — The offload lane must inline source WITH LINE NUMBERS, or any file:line ask is unanswerable (2026-07-20, medium).
- `durable-traps.md:279` — An offload-lane model will fabricate SUPPORTING QUOTES while getting the STRUCTURE right (2026-07-20, medium).
- `durable-traps.md:289` — The free offload lane is a local router — it must be RUNNING, and callers should request the `auto` alias.
- `durable-traps.md:316` — After an unattended run, `git diff` the tracked docs before committing.
- `durable-traps.md:328` — npm 12 (local, since ~2026-07-09) blocks dependency install scripts by default (`allowScripts`).
- `durable-traps.md:350` — `git push audit-tools HEAD:main` prints a "Changes must be made through a pull request" advisory that is NOT a rejection.
- `durable-traps.md:356` — The `audit-code-completion-*.test.ts` family drives the full audit flow in-process, so a long file wall is expected, not a hang.
- `durable-traps.md:376` — One test runner: vitest
- `durable-traps.md:390` — Don't mask the test exit code with a REDIRECT.
- `durable-traps.md:408` — Global `-g` install BLOCKS `postinstall`
- `durable-traps.md:418` — A global junction to a LIVE working tree silently shadows a registry install.
- `durable-traps.md:424` — PowerShell
- `durable-traps.md:433` — Packaged/global-install drift is caught ONLY by `smoke:packaged-*`, never by dev, `npm run check`, knip or vitest — so it fails the gate loudly, not silently.
- `durable-traps.md:449` — A `vi.spyOn` on the `audit-tools/shared` re-export barrel passes VACUOUSLY.
- `durable-traps.md:462` — Front-load a broad "does this already exist" sweep BEFORE authoring goal_spec/context_bundle/ module_decomposition, not just a targeted one.
- `durable-traps.md:469` — Don't fan out a large mechanical edit across parallel subagents that spawn their OWN grandchildren.
- `durable-traps.md:474` — Do not hand-edit a wedged audit run — use `audit-code force-synthesis`.
- `durable-traps.md:479` — A scratch file written into the repository root is tree dirt for the nightly clean-tree rule (2026-08-22, low).
- `durable-traps.md:486` — A residual-reference check run with an ignore-bypassing search manufactures false positives (2026-07-24, low).
- `durable-traps.md:488` — A root-containment check must survive BOTH a win32 cross-drive path and a real `..`-prefixed name.
- `durable-traps.md:496` — The Grep tool's content output can mangle comment markers with a BACKSLASH.
- `durable-traps.md:501` — After a "string to replace not found" on text you JUST wrote, grep for the anchor instead of re-reading the whole file (2026-07-16).
- `durable-traps.md:505` — A `check:*` typecheck leg can exit non-zero with NO error text when it races the async PostToolUse typecheck hook (2026-08-27).
- `durable-traps.md:513` — A typecheck sweep's error count is not final until you re-run it.
- `durable-traps.md:521` — An untypechecked fixture can sit inert for months while its suite reads green.
- `durable-traps.md:542` — Cite a SYMBOL, never a bare line number — and when no good symbol exists, cite the file alone.
- `durable-traps.md:553` — A backlog entry's bold title must not contain `
- `durable-traps.md:558` — Child sessions in the shared checkout — session-registry split (2026-08-18, mechanized; supersedes the 2026-08-07/09 kill-switch advice).
- `durable-traps.md:590` — The `audit-code-completion-*` files can flake together under full-suite load, and the symptom reads exactly like a regression (2026-08-09).
- `durable-traps.md:603` — An offload recon lane reading a file you are concurrently editing reports the POST-edit tree (2026-08-07).
- `durable-traps.md:610` — Long offload recon jobs die mid-response; short ones do not (2026-08-07).
- `durable-traps.md:624` — `.audit-tools/remediation-report.md` and `-outcomes.json` are TRACKED — archiving a finished run deletes them (2026-08-09).
- `durable-traps.md:635` — A background lane piped through `tail`/`head` shows ZERO bytes until it exits (2026-08-09).
- `durable-traps.md:644` — Right after the free router restarts, its `/v1` Anthropic surface can forward a router-local key UPSTREAM — a transient 401 window, not a permanent property (2026-08-09).
- `durable-traps.md:661` — A trivial `claude.ps1 -p` prompt did not return in 5 min while the router answered in 0.4s (2026-08-09).
- `durable-traps.md:668` — An external-delegation directive and the Workflow tool are in tension — Workflow has no external lane (2026-08-27).
- `durable-traps.md:677` — agy lanes report no progress until they finish — `stdoutBytes` stays 0 for the whole run (2026-08-27).
- `durable-traps.md:685` — The MCP `pool` offload lane dies on the same hand-typed `auto` alias as `claude.ps1`, and its `model` override is INERT (2026-08-27).
- `durable-traps.md:695` — A free-pool reply that returns nothing usable is usually `finish_reason: max_tokens`, not a weak model (2026-08-09).
- `durable-traps.md:706` — `.gitignore`'s `>>> audit-tools managed ignores >>>` block is GENERATED — a rule added between its markers is silently wiped (2026-07-30).
- `durable-traps.md:715` — The contract-pipeline repair prompt orders the OPPOSITE of the repair invariant (2026-08-09).
- `durable-traps.md:723` — A critique can prescribe a remedy the pipeline structurally cannot perform (2026-08-09).
- `durable-traps.md:733` — The per-project memory store has NO locking, and a concurrent session silently reverts your edits (2026-08-09).
- `durable-traps.md:740` — The `~/.claude/…/memory/MEMORY.md` index has no size gate, and the harness read limit is a hard cliff (2026-08-09).
- `durable-traps.md:746` — An attestation binds to the staged tree, and a later gate-demanded regeneration used to void it (2026-08-09; ENFORCED at the attest scripts 2026-08-12, P19).
- `durable-traps.md:761` — `docs/backlog.md` is NOT a record path to `writeOpenItems`, but `docs/backlog/*` is
- `durable-traps.md:772` — Git-bash `/tmp` and node's `C: mp` are different directories (hit 2026-08-18).
- `durable-traps.md:777` — A commit-carries-its-record-update gate has a covered mechanical half and an uncovered semantic half (measured 2026-08-18, closed covered-by-neighbors).
- `durable-traps.md:791` — Never amend or rebase a landed wave commit after the remediation workload prepare (2026-08-19).
- `durable-traps.md:799` — A subagent's Read tool can serve STALE pre-edit content for a file another agent is concurrently editing (2026-08-20).
- `durable-traps.md:807` — A COMMENT-only edit to a graph extractor reds the graph-edge cache digest pin, and the failure text tells you to bump the cache version (2026-08-24).
- `durable-traps.md:815` — CBM graph tools can be absent while its daemon is healthy, and the fallback CLI can be cohort-locked (2026-08-26).
- `durable-traps.md:817` — Philosophy-audit challenges already answered — do not re-propose without new evidence (2026-08-27).
- `durable-traps.md:819` — A workflow killed mid-run by the monthly spend limit reports COMPLETED, and its partial results are recoverable by run id (2026-08-27).
- `durable-traps.md:831` — A long quoted heredoc in the Bash tool can die with "unexpected EOF while looking for matching quote", and the reported line is the last line that arrived (2026-08-27).
- `durable-traps.md:841` — Philosophy-audit challenges PH-04, PH-05 and PH-08 are ANSWERED — the refused halves must not come back (2026-08-27).
- `durable-traps.md:858` — A suite run BEFORE the last doc edit is not evidence for the tree you pushed, and the live-tree tests are where that bites (2026-08-27).

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
