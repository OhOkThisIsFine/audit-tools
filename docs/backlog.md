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
> and at commit). 182 entr(y/ies) indexed.

### [`open-bugs.md`](backlog/open-bugs.md)

- `open-bugs.md:9` — The release script's await-run timeout (10 min) is shorter than a GitHub `release`-event delivery delay it then misreads as "no run" (2026-08-26, low, friction: tool_should_decide).
- `open-bugs.md:26` — The nightly clean-tree rule does not say which writes it blocks (2026-08-22, low, friction: ambiguous_direction).
- `open-bugs.md:28` — The backlog triage sweep needs a second manual invocation to reach its real coverage (2026-08-22, low, friction: tool_should_decide).
- `open-bugs.md:29` — The critique-driven contract repair step renders the judge-repair template (2026-08-22, medium).
- `open-bugs.md:31` — Remediation intake drops a finding with no `evidence` array, and the audit systemic-challenge lane emits findings without one (2026-08-22, medium).
- `open-bugs.md:33` — No native way to draw a subset of a large findings file into a remediation run (2026-08-22, low, friction: tool_should_decide).
- `open-bugs.md:35` — The contract-pipeline phase cut unions the drafted `neighbor_needs` into the finalized contracts' dependency graph, so symmetric coordination prose overrides every declared token edge (2026-08-22, high).
- `open-bugs.md:37` — The contract-pipeline adversarial judge can demand what the finalized-contract schema cannot express, and its convergence guard then blocks the run on the host (2026-08-22, high).
- `open-bugs.md:39` — A transition that ends the call drops the fold's carried advisories (2026-08-22, low).
- `open-bugs.md:41` — The DAG-derived write scope omits the companion files a fix needs, so the host hand-widens `touched_files` (2026-08-23, high, friction: tool_should_decide).
- `open-bugs.md:53` — An empty dispatch frontier THROWS instead of pausing (2026-08-23, high, friction: tool_should_decide).
- `open-bugs.md:62` — The Implementation DAG prompt does not state the one-invocation rule for `targeted_commands` (2026-08-23, medium, friction: tool_should_decide).
- `open-bugs.md:69` — A release version bump trips the path-A seed-drift alarm (2026-08-23, low, friction: tool_should_decide).
- `open-bugs.md:74` — The step prompt's "Result status requiring attention" lists MISSING results with the same shape as rejections (2026-08-23, low).
- `open-bugs.md:79` — The per-item required tests and the host landing gate do not include the tree-wide guard suites or the cheap release gates, and every landing's evidence is Windows-local (2026-08-23, medium).
- `open-bugs.md:89` — Dispatch-lane children still answer the Stop "closeout challenge" despite `AUDIT_TOOLS_CHILD_SESSION=1` (2026-08-23, low).
- `open-bugs.md:94` — The phase-boundary repository gate re-runs on EVERY `next-step` at the boundary (2026-08-23, low).
- `open-bugs.md:99` — Reviewer minors carried from the first-draw landings (2026-08-23, low).
- `open-bugs.md:108` — The friction close-out walk must be written twice under two different names (2026-08-21, low, friction: tool_should_decide).
- `open-bugs.md:110` — The systemic-challenge lane prompt withholds the banked findings it asks the adversary to beat (2026-08-21, medium).
- `open-bugs.md:112` — Acquisition of `actionlint` fails on extract (2026-08-21, low).
- `open-bugs.md:114` — Conceptual-review DEPTH is still modelled as durable when it must be per-run (2026-08-21, owner directive, medium).
- `open-bugs.md:116` — Promotion and close residuals from the CP-NODE-3/15 reviews (low, one entry).
- `open-bugs.md:136` — Writing the nightly queue desyncs HANDOFF's generated live-status block (2026-08-20, low, friction: tool_should_decide).
- `open-bugs.md:144` — next-step discards a rejected submission's classified issues (2026-08-20, medium, friction: tool_should_decide).
- `open-bugs.md:157` — Host-handoff residuals from the CP-NODE-6 landing (low, one entry).
- `open-bugs.md:183` — Analyzer-boundary residuals from the CP-NODE-1 review (low).
- `open-bugs.md:200` — Staleness third-state residuals from the CP-NODE-10 review (low).
- `open-bugs.md:208` — Emission-scaffold and gate residuals from the CP-NODE-12/13 reviews (low).
- `open-bugs.md:219` — Charter and route residuals from the CP-NODE-18/19 reviews (low).
- `open-bugs.md:232` — Drift-guard residuals from the CP-NODE-25 review (low).
- `open-bugs.md:242` — `fixture-generator-drift-guard` is not hermetic (low, friction).
- `open-bugs.md:248` — A scoped wave item that coins an invariant id in `src/` is structurally unable to satisfy the id-glossary gate (2026-08-20, medium, friction: tool_should_decide).
- `open-bugs.md:259` — The remediate-side submission ledger has no reader — `accepted_via_recovery` marks are write-only (2026-08-19, low-medium).
- `open-bugs.md:267` — recover-ingest / recover-submission leave the last step contract on disk after mutating state (2026-08-19, low).
- `open-bugs.md:274` — `StateStore.mutate` cannot skip the write — a no-op recovery rewrites an identical state file (2026-08-19, low).
- `open-bugs.md:279` — Recovery phase-binding residuals from the adversarial review (2026-08-19, low, one entry — three verified residuals):
- `open-bugs.md:290` — recover-ingest's commander action branch is untested (2026-08-19, low).
- `open-bugs.md:294` — CP-NODE-10 residuals (2026-08-19, low, one entry):
- `open-bugs.md:302` — recover-ingest exits 1 when the only issues are `submission_missing` for genuinely-pending work items (2026-08-19, low).
- `open-bugs.md:306` — The pre-commit round-trip journal is not bound to the HEAD it was captured under, so crash recovery can time-travel the tree backward (2026-08-19, high).
- `open-bugs.md:319` — The citation gate's verdict depends on transient untracked files (2026-08-19, low, friction: tool_should_decide).
- `open-bugs.md:329` — `writeOpenItems` accepts an item with no `subject_key` and persists it; the refusal lands two steps later in the HANDOFF generator (2026-08-14, re-hit 2026-08-19, low, friction: tool_should_decide).
- `open-bugs.md:342` — Modularity refinement is superlinear on one large component and unpinned at scale (2026-08-19, low).
- `open-bugs.md:348` — The TASK draw's coherence eligibility is still disjunctive and has never been measured for collapse (2026-08-19, medium).
- `open-bugs.md:355` — The HANDOFF empty-queue projection contract is full-suite-only, so the commit gates pass a red against it (2026-08-18, low, friction).
- `open-bugs.md:363` — `runCommand` buffers child output unboundedly (2026-08-13, medium).
- `open-bugs.md:370` — `shell-trap-guard` misses `git stash push <pathspec>` eating uncommitted work (2026-08-12, medium).
- `open-bugs.md:376` — Contract-pipeline fan-out names a mechanism the host may not have (2026-08-08, medium).
- `open-bugs.md:384` — Diff-based re-review loses the verdict it must diff against (2026-08-08, low).
- `open-bugs.md:390` — `free_form_intent` clause splitter shreds prose on bare `;` (2026-08-08, low).
- `open-bugs.md:394` — Answering an intake question at the checkpoint does not clear `open_questions` (2026-08-08, low).
- `open-bugs.md:399` — Sweep the test tree for tests that re-implement their subject (2026-08-08, medium).
- `open-bugs.md:408` — Regex-perf triage tail from the analyzer sweep (2026-08-07, low).
- `open-bugs.md:415` — Vitest worker RPC starvation — the false-RED exit is CLOSED at the gate; the >60s blocking worker is unlocated (recharacterized 2026-08-07; was "full-suite exits 1 while every test passes", 2026-08-06).
- `open-bugs.md:434` — Remediation pause/recovery is not durable (2026-08-03, medium).
- `open-bugs.md:442` — Graph heuristics are promoted to findings without a semantic lead boundary (2026-08-03, medium).
- `open-bugs.md:449` — Tool-owned gate reds are unattributed — foreign live-tree dirt pauses the run (2026-07-30, shrunk 2026-08-20; was "Phase-boundary gate false abandonment", HIGH).
- `open-bugs.md:463` — Contract-type coverage is derived from where TESTS live, not from the contract (2026-07-25, low, friction: inefficient-feeding).
- `open-bugs.md:473` — A deletion of a manifest-listed doc landed with the doc-manifest gate red (2026-08-26, low, <!-- doc-citation-exempt: the deleted file IS the subject — it no longer exists by design --> friction: tool-should-decide).
- `open-bugs.md:482` — Backlog prose paraphrased an incident in a way that INVERTED its mechanism, costing a wrong implementation (2026-07-24, medium, friction: ambiguous-direction).
- `open-bugs.md:492` — DD-9 + charter slice-staleness — residual only, revisit on live evidence (2026-07-23, low, accepted).
- `open-bugs.md:517` — A spec row's category prefix is load-bearing enough to manufacture work — and one was false (2026-07-28, low, RESOLVED; the open half is the class).
- `open-bugs.md:528` — ⬇ Live-run watch (re-dogfood 2026-07-22, medium): a worker self-reported "valid, verified" on a malformed-JSON result file — result validity must be checked mechanically, never trusted from the worker's claim.
- `open-bugs.md:536` — ⬇ Live-run watch (re-dogfood 2026-07-22, low, medium-difficulty — an ATTEMPTED fix was reverted 2026-07-25): completion cleanup removes the friction dir before the session stop-gate's close-out walk runs against it.
- `open-bugs.md:554` — LEAD (re-dogfood): systemic-challenge round counter + banked improvements carry across RUNS (2026-07-21, low).
- `open-bugs.md:559` — Review rounds re-derive the same file map every time (inefficient-feeding, 2026-07-19).
- `open-bugs.md:580` — A per-site pinning gate would make "red-green validated" mechanically checkable — UNBUILT on main.
- `open-bugs.md:600` — Friction walk (determinations-execution lap, 2026-07-29):
- `open-bugs.md:614` — Friction walk (duplicated-guard lap, 2026-07-25):
- `open-bugs.md:626` — Implementation workers are never given the contract they must satisfy (2026-08-09, high).
- `open-bugs.md:636` — Self-audit dogfood loop: fixing the tool mid-run invalidates the run (2026-07-16, ambiguous-direction, low-medium).
- `open-bugs.md:652` — A stale-artifact re-extraction `next-step` runs >2min with no progress signal, silently blowing a caller timeout (live dogfood 2026-07-17, inefficient-feeding, low).
- `open-bugs.md:654` — Friction walk (niggle-fix lap, 2026-08-07):
- `open-bugs.md:672` — Friction walk (loop-core `.ts`-conversion tranche lap, 2026-07-28):
- `open-bugs.md:684` — Friction walk (nightly-determinations lap, 2026-07-26):
- `open-bugs.md:696` — Friction walk (touched_files load-gate lap, 2026-07-25):
- `open-bugs.md:702` — Friction walk (fourth backlog-clearance lap, 2026-07-24):
- `open-bugs.md:715` — Friction walk (second backlog-clearance lap, 2026-07-24):
- `open-bugs.md:724` — Untracked-exclusion scope rule — residuals only (each low-severity, documented at the code site).
- `open-bugs.md:750` — External shared-logic audit V1–V7 residuals
- `open-bugs.md:762` — Top gate optimization — the suite-side tail is subprocess wall, not isolation overhead (measured 2026-07-06).
- `open-bugs.md:768` — Selective-deepening convergence — live validation env-bound.
- `open-bugs.md:776` — `goal_id` is read verbatim off the LLM envelope, so its format is unvalidated (re-verified at HEAD 2026-07-25).
- `open-bugs.md:785` — `StepArtifactSchema` is `.strict()` but `writeStepContract` injects `agent_id`.
- `open-bugs.md:791` — systemic_challenge findings ids are adversary-invented and round-colliding.
- `open-bugs.md:798` — The systemic_challenge loop has no ceiling — its only exit is a dry signal the host may have to fabricate.
- `open-bugs.md:805` — `ensure` writes opencode.json with unstable key order.
- `open-bugs.md:810` — Auditor severity calibration: 0 of 9 self-audit criticals survived mechanism verification (2026-08-06, lead, low).
- `open-bugs.md:815` — `check:memory-citations` cannot see a `[[name]]` cross-link, and 4 are already dangling (2026-08-14, nightly, low).
- `open-bugs.md:826` — Steward verification metadata is undeliverable through the host-result envelope (hit 2026-08-18).
- `open-bugs.md:836` — The report renderer emits control characters from finding prose raw (hit 2026-08-18).
- `open-bugs.md:843` — remediate-code step prompts drift from the validators that read their output (2026-08-19, low, friction: tool_should_decide).
- `open-bugs.md:854` — The commit gate's doc-contract leg did not run check:doc-code-citations for a staged docs/backlog/durable-traps.md (2026-08-19, low) — verified NOT a trigger-set gap; the underlying premise dissolves on inspection.
- `open-bugs.md:873` — On remediate the fully-green close walks a different friction record than the run wrote (2026-08-23, low).
- `open-bugs.md:886` — A killed `next-step` wedges `phase.lock` for every later call (2026-08-24, remediation run, medium).
- `open-bugs.md:895` — Host-widened scope on a live-bound block wedges `next-step` (2026-08-23, remediation run, medium).
- `open-bugs.md:905` — A dated measurement sits inside durable routine prose (2026-08-23, low).
- `open-bugs.md:913` — The repo-root artifacts have a mechanism and no producer (2026-08-24, low, friction: hermeticity).
- `open-bugs.md:927` — The remediate loader pair restates what the audit pair now single-sources (2026-08-23, low).

### [`forward-tracks.md — Open tracks`](backlog/forward-tracks.md)

- `forward-tracks.md:29` — Track 2.5 — keep production-orphan detection beside knip.

### [`forward-tracks.md — Forward tracks`](backlog/forward-tracks.md)

- `forward-tracks.md:43` — A2 finding-quality oracle — the corpus is SMALL, PUBLIC, PINNED git repos, never labeled self-audit runs.
- `forward-tracks.md:67` — End-to-end remediate-run smoke exercising the tool-owned gate (from the 2026-07-12 dogfood).
- `forward-tracks.md:75` — Deterministic analyzers: own-vs-acquire engine.
- `forward-tracks.md:90` — CI wall-clock: shard balance and the single-file floor.
- `forward-tracks.md:97` — Obligation-id slugs and decomposed-module names are two name spaces joined by a prefix match.
- `forward-tracks.md:109` — Wave-friendly host dispatch: run identity survives partial ingest.
- `forward-tracks.md:123` — Isolated-branch landing gap — a remediation run dispatched on its own `remediation/<runId>` branch has no closing action that lands it on the base branch.
- `forward-tracks.md:132` — One-core dissolution lap — unify the host-handoff substrate and converge remediate on the obligation walk (owner-routed 2026-08-19).

### [`deferred.md`](backlog/deferred.md)

- `deferred.md:11` — A7 multi-host validation — automated half green, manual GUI half never run.
- `deferred.md:21` — Manual real-OpenCode validation
- `deferred.md:24` — Prose-heavy staleness narrowing — the cascade-cost measurement and the remaining prose artifacts stay deferred (2026-07-24, low).

### [`durable-traps.md`](backlog/durable-traps.md)

- `durable-traps.md:16` — `git add -A` in a SHARED checkout commits a CONCURRENT session's files under your message (2026-08-26).
- `durable-traps.md:25` — Generating code through a Bash heredoc loses ONE level of backslash escaping (2026-08-26).
- `durable-traps.md:34` — Two pushes landing close together can leave the NEWER commit with no CI signal (2026-08-26).
- `durable-traps.md:41` — A session rooted ABOVE the repo loads NONE of its hooks, so every commit gate is silently absent (measured 2026-08-26).
- `durable-traps.md:53` — Each `dispatch_review` `next-step` re-mints EVERY outstanding binding (measured 2026-08-21).
- `durable-traps.md:55` — The llm-relay process dies with the dispatching session, and nothing restarts it (2026-08-21).
- `durable-traps.md:57` — A tracked generated doc that links to an UNTRACKED file blocks every docs-touching commit (2026-08-20).
- `durable-traps.md:67` — `git commit` after `git add <paths>` commits the whole INDEX, not your paths (2026-08-20).
- `durable-traps.md:73` — A vitest CLI file filter resurrects same-suffixed test COPIES under stale worktree dirs (2026-08-06).
- `durable-traps.md:84` — The Workflow tool's per-agent `model` override may not take (observed 2026-08-06).
- `durable-traps.md:91` — A spend-limit death returns a workflow as `completed` with a success-shaped empty result (2026-08-25).
- `durable-traps.md:101` — A broad multi-file review scope kills both peer-CLI lanes, and they fail in OPPOSITE shapes (2026-08-09 and 2026-08-10, four deaths in two nights).
- `durable-traps.md:123` — A PreToolUse block kills the WHOLE chained command — the earlier statements never ran (2026-07-25).
- `durable-traps.md:131` — An "open item" claim in a MEMORY or spec is a lead, not a work order (2026-07-19).
- `durable-traps.md:136` — Never delete from a backlog file by LINE NUMBER.
- `durable-traps.md:142` — A long multi-line prompt passed INLINE to a peer-CLI lane arrives truncated, and the lane then offers to work from whatever file it can find (2026-08-23).
- `durable-traps.md:155` — A Claude lane whose isolated `CLAUDE_CONFIG_DIR` has not TRUSTED the workspace answers from nothing rather than failing (2026-08-15).
- `durable-traps.md:171` — The offload lane degrades on TWO independent axes — payload SIZE and CONCURRENCY — and both look identical to a weak or dead model
- `durable-traps.md:200` — The Bash tool silently CLAMPS `timeout` to 600000ms (2026-07-24).
- `durable-traps.md:208` — Git Bash MANGLES a leading-slash argument into a Windows path (2026-07-25).
- `durable-traps.md:219` — Concurrent agent sessions can share the ONE primary checkout (2026-07-23).
- `durable-traps.md:228` — The pre-commit gate scans the WHOLE command string — including commit-message text — for the hooksPath/no-verify bypass tokens (2026-07-21).
- `durable-traps.md:242` — The offload lane must inline source WITH LINE NUMBERS, or any file:line ask is unanswerable (2026-07-20, medium).
- `durable-traps.md:250` — An offload-lane model will fabricate SUPPORTING QUOTES while getting the STRUCTURE right (2026-07-20, medium).
- `durable-traps.md:260` — The free offload lane is a local router — it must be RUNNING, and callers should request the `auto` alias.
- `durable-traps.md:287` — After an unattended run, `git diff` the tracked docs before committing.
- `durable-traps.md:299` — npm 12 (local, since ~2026-07-09) blocks dependency install scripts by default (`allowScripts`).
- `durable-traps.md:321` — `git push audit-tools HEAD:main` prints a "Changes must be made through a pull request" advisory that is NOT a rejection.
- `durable-traps.md:327` — The `audit-code-completion-*.test.ts` family drives the full audit flow in-process, so a long file wall is expected, not a hang.
- `durable-traps.md:347` — One test runner: vitest
- `durable-traps.md:361` — Don't mask the test exit code with a REDIRECT.
- `durable-traps.md:379` — Global `-g` install BLOCKS `postinstall`
- `durable-traps.md:389` — A global junction to a LIVE working tree silently shadows a registry install.
- `durable-traps.md:395` — PowerShell
- `durable-traps.md:404` — Packaged/global-install drift is caught ONLY by `smoke:packaged-*`, never by dev, `npm run check`, knip or vitest — so it fails the gate loudly, not silently.
- `durable-traps.md:420` — A `vi.spyOn` on the `audit-tools/shared` re-export barrel passes VACUOUSLY.
- `durable-traps.md:433` — Front-load a broad "does this already exist" sweep BEFORE authoring goal_spec/context_bundle/ module_decomposition, not just a targeted one.
- `durable-traps.md:440` — Don't fan out a large mechanical edit across parallel subagents that spawn their OWN grandchildren.
- `durable-traps.md:445` — Do not hand-edit a wedged audit run — use `audit-code force-synthesis`.
- `durable-traps.md:450` — A scratch file written into the repository root is tree dirt for the nightly clean-tree rule (2026-08-22, low).
- `durable-traps.md:457` — A residual-reference check run with an ignore-bypassing search manufactures false positives (2026-07-24, low).
- `durable-traps.md:459` — A root-containment check must survive BOTH a win32 cross-drive path and a real `..`-prefixed name.
- `durable-traps.md:467` — The Grep tool's content output can mangle comment markers with a BACKSLASH.
- `durable-traps.md:472` — After a "string to replace not found" on text you JUST wrote, grep for the anchor instead of re-reading the whole file (2026-07-16).
- `durable-traps.md:476` — A typecheck sweep's error count is not final until you re-run it.
- `durable-traps.md:484` — An untypechecked fixture can sit inert for months while its suite reads green.
- `durable-traps.md:505` — Cite a SYMBOL, never a bare line number — and when no good symbol exists, cite the file alone.
- `durable-traps.md:516` — A backlog entry's bold title must not contain `
- `durable-traps.md:521` — Child sessions in the shared checkout — session-registry split (2026-08-18, mechanized; supersedes the 2026-08-07/09 kill-switch advice).
- `durable-traps.md:553` — The `audit-code-completion-*` files can flake together under full-suite load, and the symptom reads exactly like a regression (2026-08-09).
- `durable-traps.md:566` — An offload recon lane reading a file you are concurrently editing reports the POST-edit tree (2026-08-07).
- `durable-traps.md:573` — Long offload recon jobs die mid-response; short ones do not (2026-08-07).
- `durable-traps.md:587` — `.audit-tools/remediation-report.md` and `-outcomes.json` are TRACKED — archiving a finished run deletes them (2026-08-09).
- `durable-traps.md:598` — A background lane piped through `tail`/`head` shows ZERO bytes until it exits (2026-08-09).
- `durable-traps.md:607` — Right after the free router restarts, its `/v1` Anthropic surface can forward a router-local key UPSTREAM — a transient 401 window, not a permanent property (2026-08-09).
- `durable-traps.md:624` — A trivial `claude.ps1 -p` prompt did not return in 5 min while the router answered in 0.4s (2026-08-09).
- `durable-traps.md:631` — A free-pool reply that returns nothing usable is usually `finish_reason: max_tokens`, not a weak model (2026-08-09).
- `durable-traps.md:642` — `.gitignore`'s `>>> audit-tools managed ignores >>>` block is GENERATED — a rule added between its markers is silently wiped (2026-07-30).
- `durable-traps.md:651` — The contract-pipeline repair prompt orders the OPPOSITE of the repair invariant (2026-08-09).
- `durable-traps.md:659` — A critique can prescribe a remedy the pipeline structurally cannot perform (2026-08-09).
- `durable-traps.md:669` — The per-project memory store has NO locking, and a concurrent session silently reverts your edits (2026-08-09).
- `durable-traps.md:676` — The `~/.claude/…/memory/MEMORY.md` index has no size gate, and the harness read limit is a hard cliff (2026-08-09).
- `durable-traps.md:682` — An attestation binds to the staged tree, and a later gate-demanded regeneration used to void it (2026-08-09; ENFORCED at the attest scripts 2026-08-12, P19).
- `durable-traps.md:697` — `docs/backlog.md` is NOT a record path to `writeOpenItems`, but `docs/backlog/*` is
- `durable-traps.md:708` — Git-bash `/tmp` and node's `C: mp` are different directories (hit 2026-08-18).
- `durable-traps.md:713` — A commit-carries-its-record-update gate has a covered mechanical half and an uncovered semantic half (measured 2026-08-18, closed covered-by-neighbors).
- `durable-traps.md:727` — Never amend or rebase a landed wave commit after the remediation workload prepare (2026-08-19).
- `durable-traps.md:735` — A subagent's Read tool can serve STALE pre-edit content for a file another agent is concurrently editing (2026-08-20).
- `durable-traps.md:743` — A COMMENT-only edit to a graph extractor reds the graph-edge cache digest pin, and the failure text tells you to bump the cache version (2026-08-24).
- `durable-traps.md:751` — CBM graph tools can be absent while its daemon is healthy, and the fallback CLI can be cohort-locked (2026-08-26).

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
