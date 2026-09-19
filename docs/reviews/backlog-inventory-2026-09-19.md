<!-- review-routing: backlog-forward -->

# Frozen backlog inventory — 2026-09-19

Source snapshot: `787f7320d74dff7c21a0b46b660248a28acbfebd`. The 203 IDs below remain stable when live backlog entries move or disappear. Titles are the original seek-index titles. Packet references point to [the implementation plan](backlog-implementation-2026-09-19.md).

Default verification-only disposition means the original defect is fixed or superseded, with the exact qualification in the plan's coverage tables; it does not authorize silently closing a newer defect. Durable references are retained, not assigned implementation work.

| ID | Source | Original title | Packet / disposition |
|---|---|---|---|
| O01 | open-bugs.md | Outside the audit-tools repository, no repository-wide suite gate runs during remediation (2026-09-18, high, friction: tool_should_decide). | 6 |
| O02 | open-bugs.md | The push gate judges a lap-worktree push against the MAIN checkout's suite stamp (2026-09-15, medium, friction: tool_should_decide). | 24 |
| O03 | open-bugs.md | Host loader and workflow dispatch prompts leak internal mechanics and conflate prompt requests with tooling enforcement (2026-09-13, medium, friction: tool_should_decide). | 7–11 |
| O04 | open-bugs.md | Missing or mismatched `design_review.answered_at` provenance silently downgrades review depth to defaults (2026-09-13, medium, friction: tool_should_decide). | 4 |
| O05 | open-bugs.md | `design_review` schema restricts perspectives to an integer count, preventing selection of specific or custom named perspectives (2026-09-13, low, friction: tool_should_decide). | 4 |
| O06 | open-bugs.md | `IntentEquivalenceVerdictSchema` lacks a `rationale` field, precluding reasoning explanations in equivalence verdicts (2026-09-13, low, friction: tool_should_decide). | 3 |
| O07 | open-bugs.md | Analyzer consent decisions (`declined`) should not persist across runs (2026-09-13, medium, friction: tool_should_decide). | 5 |
| O08 | open-bugs.md | CI orchestration shards time out at 300s with the spawned `audit-code next-step` still alive, on a DIFFERENT test each time (2026-09-04, high, friction: tool_should_decide). | 35 |
| O09 | open-bugs.md | Three code comments assert a shape the tree no longer has, and nothing checks a comment against the code it describes (2026-08-31, medium, friction: tool_should_decide). | Verification-only; see plan coverage table |
| O10 | open-bugs.md | `durable-traps.md` documents RETIRED infrastructure as though it were live (2026-08-30, medium, friction: tool_should_decide). | 38 |
| O11 | open-bugs.md | A literal pinned in a test outside the change's neighborhood reds only in CI — the general discovery arm stays open (2026-08-29, medium, friction: tool_should_decide). | 21 |
| O12 | open-bugs.md | Registering ONE new gate still takes edits in several separate homes (2026-08-30, medium, friction: tool_should_decide). | 22 |
| O13 | open-bugs.md | The loop-core closure rule claims a module only when EVERY importer is core, and today's 25 declared modules are grandfathered by MEASUREMENT (2026-08-30, low, friction: tool_should_decide). | Verification-only; see plan coverage table |
| O14 | open-bugs.md | A history-moving commit lands its INCOMING content unreviewed — the gate can only read the STAGED snapshot (2026-08-28, mechanism corrected 2026-08-29, medium). | Verification-only; see plan coverage table |
| O15 | open-bugs.md | The attest preflight's REFUSAL is now sound, but the divergent case gets no verdict at all (2026-08-28, narrowed 2026-08-30, medium, friction: tool_should_decide). | Verification-only; see plan coverage table |
| O16 | open-bugs.md | `shell-trap-guard`'s PowerShell here-string rule did not fire on two Bash-tool commits and then fired on a third near-identical one (2026-08-27, medium). | Verification-only; see plan coverage table |
| O17 | open-bugs.md | The Implementation DAG prompt does not state the one-invocation rule for `targeted_commands` (2026-08-23, medium, friction: tool_should_decide). | Verification-only; see plan coverage table |
| O18 | open-bugs.md | Promotion and close residuals from the CP-NODE-3/15 reviews (low, one entry). | Verification-only; see plan coverage table |
| O19 | open-bugs.md | Host-handoff residuals from the CP-NODE-6 landing (low, one entry). | 12–13 |
| O20 | open-bugs.md | Analyzer-boundary residuals from the CP-NODE-1 review (low). | 5 (consent only; other subparts fixed) |
| O21 | open-bugs.md | Staleness third-state residuals from the CP-NODE-10 review (low). | Verification-only; see plan coverage table |
| O22 | open-bugs.md | Emission-scaffold and gate residuals from the CP-NODE-12/13 reviews (low). | 15 (drain test only) |
| O23 | open-bugs.md | Charter and route residuals from the CP-NODE-18/19 reviews (low). | 18 (routes only) |
| O24 | open-bugs.md | Drift-guard residuals from the CP-NODE-25 review (low). | Verification-only; see plan coverage table |
| O25 | open-bugs.md | `fixture-generator-drift-guard` is not hermetic (low, friction). | Verification-only; see plan coverage table |
| O26 | open-bugs.md | A scoped wave item that coins an invariant id in `src/` is structurally unable to satisfy the id-glossary gate (2026-08-20, medium, friction: tool_should_decide). | Verification-only; see plan coverage table |
| O27 | open-bugs.md | The TASK draw's coherence eligibility is still disjunctive and has never been measured for collapse (2026-08-19, medium). | Verification-only; see plan coverage table |
| O28 | open-bugs.md | Contract-pipeline fan-out names a mechanism the host may not have (2026-08-08, medium). | 10 |
| O29 | open-bugs.md | Sweep the test tree for tests that re-implement their subject (2026-08-08, medium). | 21 |
| O30 | open-bugs.md | Vitest worker RPC starvation — the false-RED exit is CLOSED at the gate; the >60s blocking worker is unlocated (recharacterized 2026-08-07; was "full-suite exits 1 while every test passes", 2026-08-06). | 35 |
| O31 | open-bugs.md | Remediation pause/recovery is not durable (2026-08-03, medium). | 14 |
| O32 | open-bugs.md | Graph heuristics are promoted to findings without a semantic lead boundary (2026-08-03, medium). | 16 |
| O33 | open-bugs.md | Tool-owned gate reds are unattributed — foreign live-tree dirt pauses the run (2026-07-30, shrunk 2026-08-20; was "Phase-boundary gate false abandonment", HIGH). | Verification-only; see plan coverage table |
| O34 | open-bugs.md | ⬇ Live-run watch (re-dogfood 2026-07-22, medium): a worker self-reported "valid, verified" on a malformed-JSON result file — result validity must be checked mechanically, never trusted from the worker's claim. | Verification-only; see plan coverage table |
| O35 | open-bugs.md | Review rounds re-derive the same file map every time (inefficient-feeding, 2026-07-19). | Verification-only; see plan coverage table |
| O36 | open-bugs.md | The per-site pinning gate's name binding is author-supplied (2026-07-25). | 21 |
| O37 | open-bugs.md | Friction walk (copy-fallback lap, 2026-08-30): | Verification-only; see plan coverage table |
| O38 | open-bugs.md | Friction walk (commitFold unlink lap, 2026-08-30): | Verification-only; see plan coverage table |
| O39 | open-bugs.md | The per-result LLM conformance review — the opt-in depth dial half of the owner decision — is unbuilt, so semantic conformance to the carried module contracts is still judged by nothing (2026-08-09, narrowed 2026-08-29, medium). | 17 |
| O40 | open-bugs.md | Self-audit dogfood loop: fixing the tool mid-run invalidates the run (2026-07-16, ambiguous-direction, low-medium). | Verification-only; see plan coverage table |
| O41 | open-bugs.md | Friction walk (niggle-fix lap, 2026-08-07): | 33 |
| O42 | open-bugs.md | Friction walk (touched_files load-gate lap, 2026-07-25): | Verification-only; see plan coverage table |
| O43 | open-bugs.md | External shared-logic audit V1–V7 residuals | Verification-only; see plan coverage table |
| O44 | open-bugs.md | Top gate optimization — the suite-side tail is subprocess wall, not isolation overhead (measured 2026-07-06). | 35 |
| O45 | open-bugs.md | Selective-deepening convergence — live validation env-bound. | 36 |
| O46 | open-bugs.md | The dispatch boundary strips every per-node field the contract pipeline writes onto a promoted finding but `FindingSchema` does not declare (2026-08-27, medium). | 3 |
| O47 | open-bugs.md | The masked-exit guard keyed on TEST RUNNERS, not on whether the exit status is load-bearing — NARROWED to its curated-list half (2026-08-27, narrowed 2026-08-29, medium, friction: tool_should_decide). | 31 |
| O48 | open-bugs.md | An agent push to `main` is not gated on a full-suite stamp, and the "touched area's suite" rule cannot see a cross-area invariant (2026-09-03, medium, friction: tool_should_decide). | 24 |
| O49 | open-bugs.md | Audit-side host prompts still name a sub-agent MECHANISM (2026-09-15, low, friction: tool_should_decide). | 10 |
| M01 | minor-bugs.md | Empty repo-root files named backtick and node.id appeared during vitest/build runs, producer unlocated (2026-08-29, low, friction: tool_should_decide). | Evidence watch; preserve producer uncertainty |
| M02 | minor-bugs.md | A refactor that deletes a symbol NAMED in an escalate-only constitutional doc leaves the doc citing a dead symbol, and no gate notices the dangling state (2026-08-29, low, friction: tool_should_decide). | Verification-only; see plan coverage table |
| M03 | minor-bugs.md | The release pre-tag CI-green gate fails hard on an IN-FLIGHT run instead of watching it (2026-08-29, low, friction: tool_should_decide). | Verification-only; see plan coverage table |
| M04 | minor-bugs.md | HANDOFF's hand-written Immediate-next can claim work that already landed, and nothing checks it (2026-08-29, low, friction: ambiguous_direction). | 30 |
| M05 | minor-bugs.md | A re-entered `commitFold` can still append ONE duplicate `accepted` event when `recordLaneOutcome` throws after its durable append (2026-08-28, low). | 12 |
| M06 | minor-bugs.md | The obligation engine's bound doc is off by one against its own comparison (2026-08-28, low). | Verification-only; see plan coverage table |
| M07 | minor-bugs.md | The release script's await-run timeout (10 min) is shorter than a GitHub `release`-event delivery delay it then misreads as "no run" (2026-08-26, low, friction: tool_should_decide). | Verification-only; see plan coverage table |
| M08 | minor-bugs.md | The nightly clean-tree rule does not say which writes it blocks (2026-08-22, low, friction: ambiguous_direction). | 29 |
| M09 | minor-bugs.md | No native way to draw a subset of a large findings file into a remediation run (2026-08-22, low, friction: tool_should_decide). | M09 intake packet immediately after 4 |
| M10 | minor-bugs.md | A transition that ends the call drops the fold's carried advisories (2026-08-22, low). | Verification-only; see plan coverage table |
| M11 | minor-bugs.md | A release version bump trips the path-A seed-drift alarm (2026-08-23, low, friction: tool_should_decide). | Verification-only; see plan coverage table |
| M12 | minor-bugs.md | Reviewer minors carried from the first-draw landings (2026-08-23, low). | Verification-only; see plan coverage table |
| M13 | minor-bugs.md | The friction close-out walk must be written twice under two different names (2026-08-21, low, friction: tool_should_decide). | Verification-only; see plan coverage table |
| M14 | minor-bugs.md | Writing the nightly queue desyncs HANDOFF's generated live-status block (2026-08-20, low, friction: tool_should_decide). | 29 |
| M15 | minor-bugs.md | recover-ingest / recover-submission leave the last step contract on disk after mutating state (2026-08-19, low). | Verification-only; see plan coverage table |
| M16 | minor-bugs.md | `StateStore.mutate` cannot skip the write — a no-op recovery rewrites an identical state file (2026-08-19, low). | Verification-only; see plan coverage table |
| M17 | minor-bugs.md | Recovery phase-binding residuals from the adversarial review (2026-08-19, low, one entry — three verified residuals): | Verification-only; see plan coverage table |
| M18 | minor-bugs.md | recover-ingest's commander action branch is untested (2026-08-19, low). | Verification-only; see plan coverage table |
| M19 | minor-bugs.md | CP-NODE-10 residuals (2026-08-19, low, one entry): | Verification-only; see plan coverage table |
| M20 | minor-bugs.md | recover-ingest exits 1 when the only issues are `submission_missing` for genuinely-pending work items (2026-08-19, low). | Verification-only; see plan coverage table |
| M21 | minor-bugs.md | The citation gate's verdict depends on transient untracked files (2026-08-19, low, friction: tool_should_decide). | Verification-only; see plan coverage table |
| M22 | minor-bugs.md | `writeOpenItems` accepts an item with no `subject_key` and persists it; the refusal lands two steps later in the HANDOFF generator (2026-08-14, re-hit 2026-08-19, low, friction: tool_should_decide). | Verification-only; see plan coverage table |
| M23 | minor-bugs.md | The HANDOFF empty-queue projection contract is full-suite-only, so the commit gates pass a red against it (2026-08-18, low, friction; BIT 2026-08-27 — burned tag v0.50.0: a hand-written live-state edit using the word the contract bans passed every commit gate and failed only in the release run's test shard, exactly as this entry predicted). | Verification-only; see plan coverage table |
| M24 | minor-bugs.md | Diff-based re-review loses the verdict it must diff against (2026-08-08, low). | Verification-only; see plan coverage table |
| M25 | minor-bugs.md | `free_form_intent` clause splitter shreds prose on bare `;` (2026-08-08, low). | Verification-only; see plan coverage table |
| M26 | minor-bugs.md | Answering an intake question at the checkpoint does not clear `open_questions` (2026-08-08, low). | Verification-only; see plan coverage table |
| M27 | minor-bugs.md | Regex-perf triage tail from the analyzer sweep (2026-08-07, low). | 19 |
| M28 | minor-bugs.md | Contract construction-site coverage proves presence, not completeness or reach (2026-07-25, low, friction: inefficient-feeding). | 20 |
| M29 | minor-bugs.md | DD-9 + charter slice-staleness — residual only, revisit on live evidence (2026-07-23, low, accepted). | 37 |
| M30 | minor-bugs.md | A spec row's category prefix is load-bearing enough to manufacture work — and one was false (2026-07-28, low, RESOLVED; the open half is the class). | Recurrence watch; original incident fixed |
| M31 | minor-bugs.md | ⬇ Live-run watch (re-dogfood 2026-07-22, low, medium-difficulty — an ATTEMPTED fix was reverted 2026-07-25): completion cleanup removes the friction dir before the session stop-gate's close-out walk runs against it. | 36 |
| M32 | minor-bugs.md | LEAD (re-dogfood): systemic-challenge round counter + banked improvements carry across RUNS (2026-07-21, low). | Verification-only; see plan coverage table |
| M33 | minor-bugs.md | A stale-artifact re-extraction `next-step` runs >2min with no progress signal, silently blowing a caller timeout (live dogfood 2026-07-17, inefficient-feeding, low). | Verification-only; see plan coverage table |
| M34 | minor-bugs.md | Auditor severity calibration: 0 of 9 self-audit criticals survived mechanism verification (2026-08-06, lead, low). | Verification-only; see plan coverage table |
| M35 | minor-bugs.md | The commit gate's doc-contract leg did not run check:doc-code-citations for a staged docs/backlog/durable-traps.md (2026-08-19, low) — verified NOT a trigger-set gap; the underlying premise dissolves on inspection. | Verification-only; see plan coverage table |
| M36 | minor-bugs.md | A dated measurement sits inside durable routine prose (2026-08-23, low). | 30 |
| M37 | minor-bugs.md | The remediate loader pair restates what the audit pair now single-sources (2026-08-23, low). | 7–11 (remaining prompt work only) |
| M38 | minor-bugs.md | HANDOFF's hand-written region and the closeout both re-narrate state the repository already holds (2026-08-27, from the philosophy audit, low). | 30 |
| M39 | minor-bugs.md | Three governance vocabularies are copied per consumer instead of shared (2026-08-27, from the philosophy audit, low). | Verification-only; see plan coverage table |
| M40 | minor-bugs.md | `check:memory-citations` gates two of the three citation directions, and its guard-reach row names the wrong uncovered half (2026-08-27, low, friction: tool_should_decide). | Verification-only; see plan coverage table |
| M41 | minor-bugs.md | The repo owns its green mechanism but exposes no way to ASK it, so a lap re-derives the answer by hand (2026-08-30, low, friction: tool_should_decide). | Verification-only; see plan coverage table |
| M42 | minor-bugs.md | `refuseSuppliedVerificationStatus` cannot fire on the production judge path (2026-09-03, low). | Verification-only; see plan coverage table |
| M43 | minor-bugs.md | The leg-1 scope ledger never prunes entries for deleted documents (2026-09-11, low). | 29 |
| M44 | minor-bugs.md | The e2e leg's refusal test passes for the wrong reason (2026-09-15, low). | 15 |
| M45 | minor-bugs.md | A stale host workload `contract_version` re-prepares by a path no test crosses (2026-09-15, low). | 15 |
| M46 | minor-bugs.md | The merge-commit gate reports one refusal class per attempt (2026-09-15, low, friction: inefficient_feeding). | 24 |
| M47 | minor-bugs.md | `RemediationPlanSchema.themes` has no writer and no reader (2026-09-17, low, friction: tool_should_decide). | 3 |
| M48 | minor-bugs.md | The dispatch-lane reader leaves a FAILED CLI lane's envelope wrapped (2026-09-17, low, friction: tool_should_decide). | 32 |
| M49 | minor-bugs.md | The in-scan `duplicate_submission_id` branch may now be unreachable (2026-09-18, low, friction: tool_should_decide). | 15 |
| F01 | forward-tracks.md | Track 3 — every emitted lane should carry a size, complexity and risk ranking, so the host can match a model to the work (2026-09-02, owner-directed). | 10 |
| F02 | forward-tracks.md | Ceremony-review remainder — Tier 2/3 consolidations, plus the one unlanded Part-5 mechanism (2026-08-29). | 22–31, 38; see ceremony dispositions |
| F03 | forward-tracks.md | The audit draw WRITES to the audited tree, and the read-only framing does not say so (2026-08-24, raised by CP-NODE-7's refutation lane). | 5 |
| F04 | forward-tracks.md | Track 2.5 — keep production-orphan detection beside knip. | Verification-only; see plan coverage table |
| F05 | forward-tracks.md | End-to-end remediate-run smoke exercising the tool-owned gate (from the 2026-07-12 dogfood). | Verification-only; see plan coverage table |
| F06 | forward-tracks.md | Deterministic analyzers: own-vs-acquire engine. | 36 |
| F07 | forward-tracks.md | CI wall-clock: shard balance and the single-file floor. | 35 / external assignment |
| F08 | forward-tracks.md | `preferredExecutor` is a MODE, and the step-command scaffold serves only one of the two (2026-09-05). | Verification-only; see plan coverage table |
| F09 | forward-tracks.md | Obligation-id slugs and decomposed-module names are two name spaces joined by a prefix match. | Verification-only; see plan coverage table |
| F10 | forward-tracks.md | Wave-friendly host dispatch: run identity survives partial ingest. | Verification-only; see plan coverage table |
| F11 | forward-tracks.md | Isolated-branch landing gap — a remediation run dispatched on its own `remediation/<runId>` branch has no closing action that lands it on the base branch. | Verification-only; see plan coverage table |
| F12 | forward-tracks.md | One-core dissolution lap — the two draws are converged; what remains is two adapter divergences (owner-routed 2026-08-19, RE-BASELINED 2026-08-27). | Verification-only; see plan coverage table |
| F13 | forward-tracks.md | The ship pipeline stops before the steps that finish it, and the remainder is agent prose (2026-08-27, from the philosophy audit). | 2 (operational recovery only) |
| D01 | deferred.md | A7 multi-host validation — automated half green, manual GUI half never run. | 36 |
| D02 | deferred.md | Manual real-OpenCode validation | 36 |
| D03 | deferred.md | Prose-heavy staleness narrowing — the cascade-cost measurement and the remaining prose artifacts stay deferred (2026-07-24, low). | 37 |
| T01 | durable-traps.md | Never run `npm test` concurrently with any other `npm run check:*` in the same worktree (2026-09-15). | Retain reference / accepted limitation |
| T02 | durable-traps.md | A background PowerShell task can fail with NO output (2026-09-18). | Retain reference / accepted limitation |
| T03 | durable-traps.md | An entry that reinterprets an incident must quote or link the primary record's own words for the mechanism, not restate them. | Retain reference / accepted limitation |
| T04 | durable-traps.md | A guard that fires AS DESIGNED is not friction and is never re-filed as a defect (owner decision 2026-09-05, nightly item bl-1). | Retain reference / accepted limitation |
| T05 | durable-traps.md | A delegated `codex exec` lane runs the sprint ceremony and CONSUMES the session's lap record (2026-08-29, ENFORCED IN PART). | 38 + external lap-ownership follow-through |
| T06 | durable-traps.md | `gh run list --commit <short-sha>` silently returns an EMPTY set — the flag matches the FULL 40-character sha only (2026-08-29). | Retain reference / accepted limitation |
| T07 | durable-traps.md | Parallel deep `codex exec` lanes exhaust the ChatGPT quota in well under an hour, and a lane dies mid-answer with NO verdict (2026-08-28). | 38 |
| T08 | durable-traps.md | Mechanical-analyzer acquisitions decided against — do not re-propose without new evidence (folded here 2026-08-27 from the retired mechanical-analyzer layer spec, now deleted). | Retain reference / accepted limitation |
| T09 | durable-traps.md | `git add -A` in a SHARED checkout commits a CONCURRENT session's files under your message (2026-08-26). | 38 |
| T10 | durable-traps.md | Generating code through a Bash heredoc loses ONE level of backslash escaping (2026-08-26). | Retain reference / accepted limitation |
| T11 | durable-traps.md | Two pushes landing close together can leave the NEWER commit with no CI signal (2026-08-26). | Retain reference / accepted limitation |
| T12 | durable-traps.md | A session rooted ABOVE the repo loads NONE of its Claude Code hooks (measured 2026-08-26) — the COMMIT gate no longer depends on that, the shell traps still do. | Retain reference / accepted limitation |
| T13 | durable-traps.md | A mid-session llm-relay death needs a hand restart — its autostart only covers LOGON (2026-08-21, corrected 2026-09-10). | External relay supervision |
| T14 | durable-traps.md | A tracked generated doc that links to an UNTRACKED file blocks every docs-touching commit (2026-08-20). | Retain reference / accepted limitation |
| T15 | durable-traps.md | `git commit` after `git add <paths>` commits the whole INDEX, not your paths (2026-08-20). | Retain reference / accepted limitation |
| T16 | durable-traps.md | A vitest CLI file filter resurrects same-suffixed test COPIES under stale worktree dirs (2026-08-06). | Retain reference / accepted limitation |
| T17 | durable-traps.md | The Workflow tool's per-agent `model` override may not take (observed 2026-08-06). | Retain reference / accepted limitation |
| T18 | durable-traps.md | A spend-limit death returns a workflow as `completed` with a success-shaped empty result (2026-08-25). | Retain reference / accepted limitation |
| T19 | durable-traps.md | A broad multi-file review scope kills both peer-CLI lanes, and they fail in OPPOSITE shapes (2026-08-09 and 2026-08-10, four deaths in two nights). | Retain reference / accepted limitation |
| T20 | durable-traps.md | A PreToolUse block kills the WHOLE chained command — the earlier statements never ran (2026-07-25). | Retain reference / accepted limitation |
| T21 | durable-traps.md | An "open item" claim in a MEMORY or spec is a lead, not a work order (2026-07-19). | Retain reference / accepted limitation |
| T22 | durable-traps.md | Never delete from a backlog file by LINE NUMBER. | Retain reference / accepted limitation |
| T23 | durable-traps.md | A long multi-line prompt passed INLINE to a peer-CLI lane arrives truncated, and the lane then offers to work from whatever file it can find (2026-08-23). | Retain reference / accepted limitation |
| T24 | durable-traps.md | A lane that lost its tools FABRICATES a confident answer instead of failing — but workspace trust is NOT what takes them away (2026-08-15, premise corrected by measurement 2026-08-29). | Retain reference / accepted limitation |
| T25 | durable-traps.md | The offload lane degrades on TWO independent axes — payload SIZE and CONCURRENCY — and both look identical to a weak or dead model | External relay capacity |
| T26 | durable-traps.md | The Bash tool silently CLAMPS `timeout` to 600000ms (2026-07-24). | Retain reference / accepted limitation |
| T27 | durable-traps.md | Empty repo-root files named from code or prose are cmd.exe REDIRECT artifacts, and since 2026-08-30 NOTHING in this repo watches for them (relanded here as its guard was deleted). | Retain reference / accepted limitation |
| T28 | durable-traps.md | Git Bash MANGLES a leading-slash argument into a Windows path (2026-07-25). | Retain reference / accepted limitation |
| T29 | durable-traps.md | Concurrent agent sessions can share the ONE primary checkout (2026-07-23). | 38 |
| T30 | durable-traps.md | The pre-commit gate scans the WHOLE command string — including commit-message text — for the hooksPath/no-verify bypass tokens (2026-07-21). | Retain reference / accepted limitation |
| T31 | durable-traps.md | The offload lane must inline source WITH LINE NUMBERS, or any file:line ask is unanswerable (2026-07-20, medium). | Retain reference / accepted limitation |
| T32 | durable-traps.md | An offload-lane model will fabricate SUPPORTING QUOTES while getting the STRUCTURE right (2026-07-20, medium). | Retain reference / accepted limitation |
| T33 | durable-traps.md | The free offload lane is a local router — it must be RUNNING, and callers should request the `auto` alias. | 38 |
| T34 | durable-traps.md | After an unattended run, `git diff` the tracked docs before committing. | Retain reference / accepted limitation |
| T35 | durable-traps.md | npm 12 (local, since ~2026-07-09) blocks dependency install scripts by default (`allowScripts`). | Retain reference / accepted limitation |
| T36 | durable-traps.md | `git push audit-tools HEAD:main` prints a "Changes must be made through a pull request" advisory that is NOT a rejection. | Retain reference / accepted limitation |
| T37 | durable-traps.md | The `audit-code-completion-*.test.ts` family drives the full audit flow in-process, so a long file wall is expected, not a hang. | Retain reference / accepted limitation |
| T38 | durable-traps.md | One test runner: vitest | Retain reference / accepted limitation |
| T39 | durable-traps.md | Don't mask the test exit code with a REDIRECT. | Retain reference / accepted limitation |
| T40 | durable-traps.md | Global `-g` install BLOCKS `postinstall` | Retain reference / accepted limitation |
| T41 | durable-traps.md | A global junction to a LIVE working tree silently shadows a registry install. | Retain reference / accepted limitation |
| T42 | durable-traps.md | PowerShell | Retain reference / accepted limitation |
| T43 | durable-traps.md | Packaged/global-install drift is caught ONLY by `smoke:packaged-*`, never by dev, `npm run check`, knip or vitest — so it fails the gate loudly, not silently. | Retain reference / accepted limitation |
| T44 | durable-traps.md | A `vi.spyOn` on the `audit-tools/shared` re-export barrel passes VACUOUSLY. | 31 |
| T45 | durable-traps.md | Front-load a broad "does this already exist" sweep BEFORE authoring goal_spec/context_bundle/ module_decomposition, not just a targeted one. | Retain reference / accepted limitation |
| T46 | durable-traps.md | Don't fan out a large mechanical edit across parallel subagents that spawn their OWN grandchildren. | Retain reference / accepted limitation |
| T47 | durable-traps.md | Do not hand-edit a wedged audit run — use `audit-code force-synthesis`. | Retain reference / accepted limitation |
| T48 | durable-traps.md | A scratch file written into the repository root is tree dirt for the nightly clean-tree rule (2026-08-22, low). | Retain reference / accepted limitation |
| T49 | durable-traps.md | A residual-reference check run with an ignore-bypassing search manufactures false positives (2026-07-24, low). | Retain reference / accepted limitation |
| T50 | durable-traps.md | A root-containment check must survive BOTH a win32 cross-drive path and a real `..`-prefixed name. | Retain reference / accepted limitation |
| T51 | durable-traps.md | The Grep tool's content output can mangle comment markers with a BACKSLASH. | Retain reference / accepted limitation |
| T52 | durable-traps.md | After a "string to replace not found" on text you JUST wrote, grep for the anchor instead of re-reading the whole file (2026-07-16). | Retain reference / accepted limitation |
| T53 | durable-traps.md | A `check:*` typecheck leg can exit non-zero with NO error text when it races the async PostToolUse typecheck hook (2026-08-27). | Retain reference / accepted limitation |
| T54 | durable-traps.md | A typecheck sweep's error count is not final until you re-run it. | Retain reference / accepted limitation |
| T55 | durable-traps.md | An untypechecked fixture can sit inert for months while its suite reads green. | Retain reference / accepted limitation |
| T56 | durable-traps.md | Cite a SYMBOL, never a bare line number — and when no good symbol exists, cite the file alone. | Retain reference / accepted limitation |
| T57 | durable-traps.md | A backlog entry's bold title must not contain ` | Retain reference / accepted limitation |
| T58 | durable-traps.md | Child sessions in the shared checkout — session-registry split (2026-08-18, mechanized; supersedes the 2026-08-07/09 kill-switch advice). | External lap-ownership follow-through |
| T59 | durable-traps.md | A full-suite-only failure is classified by `runIsolatedDiagnostics` in `scripts/shared/run-vitest-gate.mjs`, never from a remembered file list. | Retain reference / accepted limitation |
| T60 | durable-traps.md | An offload recon lane reading a file you are concurrently editing reports the POST-edit tree (2026-08-07). | Retain reference / accepted limitation |
| T61 | durable-traps.md | Long offload recon jobs die mid-response; short ones do not (2026-08-07). | Retain reference / accepted limitation |
| T62 | durable-traps.md | `.audit-tools/remediation-report.md` and `-outcomes.json` are TRACKED — archiving a finished run deletes them (2026-08-09). | Retain reference / accepted limitation |
| T63 | durable-traps.md | A background lane piped through `tail`/`head` shows ZERO bytes until it exits (2026-08-09). | Retain reference / accepted limitation |
| T64 | durable-traps.md | A trivial peer-CLI `-p` prompt did not return in 5 min while the relay answered in 0.4s (2026-08-09). | 38 |
| T65 | durable-traps.md | An external-delegation directive and the Workflow tool are in tension — Workflow has no external lane (2026-08-27). | Retain reference / accepted limitation |
| T66 | durable-traps.md | agy lanes report no progress until they finish — `stdoutBytes` stays 0 for the whole run (2026-08-27). | Retain reference / accepted limitation |
| T67 | durable-traps.md | The MCP `pool` offload lane's `--model auto` alias warns, and its `model` override is INERT (2026-08-27, mechanism corrected 2026-08-29). | 38 |
| T68 | durable-traps.md | A free-pool reply that returns nothing usable is usually `finish_reason: max_tokens`, not a weak model (2026-08-09). | 38 |
| T69 | durable-traps.md | `.gitignore`'s `>>> audit-tools managed ignores >>>` block is GENERATED — a rule added between its markers is silently wiped (2026-07-30). | Retain reference / accepted limitation |
| T70 | durable-traps.md | The contract-pipeline repair prompt orders the OPPOSITE of the repair invariant (2026-08-09). | 13 |
| T71 | durable-traps.md | A critique can prescribe a remedy the pipeline structurally cannot perform (2026-08-09). | 13 |
| T72 | durable-traps.md | The per-project memory store has NO locking, and a concurrent session silently reverts your edits (2026-08-09). | 38 + external atomic memory writes |
| T73 | durable-traps.md | The `~/.claude/…/memory/MEMORY.md` index has no size gate, and the harness read limit is a hard cliff (2026-08-09). | External memory-index limits |
| T74 | durable-traps.md | An attestation binds to the staged tree, and a later gate-demanded regeneration used to void it (2026-08-09; ENFORCED at the attest scripts 2026-08-12, P19). | Retain reference / accepted limitation |
| T75 | durable-traps.md | `docs/backlog.md` is NOT a record path to `writeOpenItems`, but `docs/backlog/*` is | 31 |
| T76 | durable-traps.md | Git-bash `/tmp` and node's `C: mp` are different directories (hit 2026-08-18). | Retain reference / accepted limitation |
| T77 | durable-traps.md | A commit-carries-its-record-update gate has a covered mechanical half and an uncovered semantic half (measured 2026-08-18, closed covered-by-neighbors). | Retain reference / accepted limitation |
| T78 | durable-traps.md | Never amend or rebase a landed wave commit after the remediation workload prepare (2026-08-19). | Retain reference / accepted limitation |
| T79 | durable-traps.md | A subagent's Read tool can serve STALE pre-edit content for a file another agent is concurrently editing (2026-08-20). | Retain reference / accepted limitation |
| T80 | durable-traps.md | A COMMENT-only edit to a graph extractor reds the graph-edge cache digest pin, and the failure text tells you to bump the cache version (2026-08-24). | Retain reference / accepted limitation |
| T81 | durable-traps.md | CBM graph tools can be absent while its daemon is healthy, and the fallback CLI can be cohort-locked (2026-08-26). | Retain reference / accepted limitation |
| T82 | durable-traps.md | Philosophy-audit challenges already answered — do not re-propose without new evidence (2026-08-27). | Retain reference / accepted limitation |
| T83 | durable-traps.md | A workflow killed mid-run by the monthly spend limit reports COMPLETED, and its partial results are recoverable by run id (2026-08-27). | Retain reference / accepted limitation |
| T84 | durable-traps.md | A long quoted heredoc in the Bash tool can die with "unexpected EOF while looking for matching quote", and the reported line is the last line that arrived (2026-08-27). | Retain reference / accepted limitation |
| T85 | durable-traps.md | Philosophy-audit challenges PH-04, PH-05 and PH-08 are ANSWERED — the refused halves must not come back (2026-08-27). | Retain reference / accepted limitation |
| T86 | durable-traps.md | Two offload lanes fail SUCCESS-SHAPED, and neither reports why in its status (2026-08-28). | 38 |
| T87 | durable-traps.md | A literal `<<'EOF'` heredoc still loses one level of backslash, because the TOOL JSON eats it before the shell ever sees it (2026-08-28). | Retain reference / accepted limitation |
| T88 | durable-traps.md | A quota-exhaustion message names a reset date, and that date is not a prediction (2026-08-28). | Retain reference / accepted limitation |
| T89 | durable-traps.md | "File missing" is classified from ENOENT alone, and a path that traverses a FILE does not report ENOENT on both platforms (2026-09-03). | 31 |
