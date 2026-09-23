# Open bugs & frictions

> Fixable defects and friction. Fix in tooling — never "the host remembers".
>
> Part of the split backlog — index: [`docs/backlog.md`](../backlog.md).
> A living to-do list, not a status log. Remove an entry once it ships; record durable
> contracts and rationale in project memory or `CLAUDE.md`, never "where the code is today".

- **Outside the audit-tools repository, no repository-wide suite gate runs during remediation (2026-09-18, high, friction: tool_should_decide).** `toolOwnedFinalGateCommands` (`src/remediate/steps/gateCommands.ts`) returns no commands unless the target is the audit-tools repository, so `runToolOwnedFinalGate` (`src/remediate/steps/finalGate.ts`) records `scoped_out` at every phase boundary and before close, and lets the run continue. The only whole-repository suite left is the close phase's `plan.test_command` (`runCombinedTestSuite`, `src/remediate/phases/close.ts`), which runs once, after all work, and records `ran:false` when the plan has none. So a run on any other repository can finish with no build, typecheck or suite run at all, and a break from an early phase reaches later phases unseen. Found in the owner's review of prompt row 19 ([prompt refinement](../reviews/prompt-refinement-2026-09-13.md)); deferred from that lap for scope and the design gate (the gate is loop-core). **Property:** every target repository gets a real repository-wide gate at each phase boundary and before close, derived from the repository's own declared commands, and a target with no derivable command is surfaced to the operator, never passed as `scoped_out`.

- **The push gate judges a lap-worktree push against the MAIN checkout's suite stamp (2026-09-15, medium, friction: tool_should_decide).** `.claude/hooks/push-gate.mjs` resolves its root from `CLAUDE_PROJECT_DIR`, which the hook runner binds to the primary checkout, while the `/ship` flow pushes from the lap worktree — so a full-suite green stamped in the worktree (`suiteGreenStampPath` is per worktree by design) is invisible to the gate, which then names the primary checkout's stale tree id and refuses a push the worktree's suite certified. **Property:** the gate judges the tree the push actually sends — the worktree the command runs in (its `cwd`, or `git rev-parse --show-toplevel` from it) — and reads that worktree's stamp; the primary checkout's stamp is consulted only when the push runs there.
- **Host loader and workflow dispatch prompts leak internal mechanics and conflate prompt requests with tooling enforcement (2026-09-13, medium, friction: tool_should_decide).** `skills/audit-code/audit-code.prompt.md` and `skills/remediate-code/remediate-code.prompt.md` contain several defects where internal implementation trivia and unenforceable invariants are pushed onto the host orchestrator. The development instruction (`When developing audit-tools itself, use node audit-code.mjs...`) appears unconditionally during third-party repository audits instead of being scoped strictly to runs inside the `audit-tools` repository root. Implementation commentary about shared markdown fragments is leaked directly into the LLM context. Instructions plead with the model not to add provider or machine fields rather than mechanically rejecting unrecognized arguments in tooling (`guardArgv`), tell the orchestrator to read JSON only far enough to find `prompt_path` when the full payload has already entered context, and refer to abstract, cryptic 'capability preflights' and 'unavailable servers' rather than clear functional criteria (such as cross-file call-hierarchy navigation versus flat keyword search). **Property:** workflow prompts follow Prompt Contract v1: the immediate actor/action is explicit, every required fact is rendered or bound at an exact readable path, closed vocabularies and required fields agree with their validators, tool-owned fields stay out of worker contracts, lane fallbacks preserve lane semantics, and loaders remain thin rather than becoming parallel workflow engines. Canonical implementation target: [Prompt Contract Standard and Verified Prompt Review](../reviews/prompt-contract-standard-2026-09-19.md). Historical inventory: [prompt refinement and workflow prompt inventory](../reviews/prompt-refinement-2026-09-13.md).

- **Missing or mismatched `design_review.answered_at` provenance silently downgrades review depth to defaults (2026-09-13, medium, friction: tool_should_decide).** When an intent checkpoint carries a `design_review` block with a missing or mismatched `answered_at` timestamp, `resolveConceptualReviewSettings` in `src/audit/cli/conceptualDispatch.ts` treats the block as unbound and falls back to `"shallow"` conceptual review. While an informational notice is attached to the next step, the workflow advances anyway with downgraded execution rather than failing fast or requiring explicit operator re-confirmation. If an operator requested deep conceptual review or specific perspectives, this silent fallback executes a degraded pass contrary to user intent. **Property:** a missing or mismatched provenance timestamp on `design_review` causes `confirm_intent` to halt or re-prompt for confirmation rather than silently falling back to shallow defaults. Evidence: [prompt refinement and workflow prompt inventory](../reviews/prompt-refinement-2026-09-13.md).

- **`design_review` schema restricts perspectives to an integer count, preventing selection of specific or custom named perspectives (2026-09-13, low, friction: tool_should_decide).** `IntentCheckpointSchema.design_review` in `src/shared/types/intentCheckpoint.ts` specifies `perspectives: z.number().int().min(1).optional()`. This prevents the operator and orchestrator from selecting specific named perspectives (e.g. `["Adversary", "Minimalist"]`) or proposing domain-tailored `custom_perspectives`. **Property:** `IntentCheckpointSchema.design_review` supports both integer counts and named perspective arrays, alongside an optional `custom_perspectives` definition array. Evidence: [prompt refinement and workflow prompt inventory](../reviews/prompt-refinement-2026-09-13.md).

- **`IntentEquivalenceVerdictSchema` lacks a `rationale` field, precluding reasoning explanations in equivalence verdicts (2026-09-13, low, friction: tool_should_decide).** `IntentEquivalenceVerdictSchema` in `src/audit/orchestrator/intentEquivalenceExecutor.ts` is `.strict()` and only accepts `verdict` and `judged_pair`. Adding a `rationale` field to the prompt's verdict contract to capture the judge's reasoning causes validation rejection until the schema is updated to support it. **Property:** `IntentEquivalenceVerdictSchema` permits an optional `rationale` string field. Evidence: [prompt refinement and workflow prompt inventory](../reviews/prompt-refinement-2026-09-13.md).

- **Analyzer consent decisions (`declined`) should not persist across runs (2026-09-13, medium, friction: tool_should_decide).** Currently, `src/audit/cli/nextStepHelpers.ts` persists `declined` analyzer consent decisions to `.audit-tools/audit/analyzer-policy.json` (`AnalyzerConsentDecisionSchema` in `src/shared/analyzerPolicy.ts`), vetoing future runs without re-asking. Per operator directive, neither declines nor grants should persist across runs; all analyzer consent decisions must be per-run so that the operator is prompted fresh on every run. **Property:** `analyzer_consent` decisions (both grants and declines) are strictly ephemeral for the current run, and `persistAnalyzerConsent` is retired from writing durable declines. Evidence: [prompt refinement and workflow prompt inventory](../reviews/prompt-refinement-2026-09-13.md).

- **CI orchestration shards time out at 300s with the spawned `audit-code next-step` still alive, on a
  DIFFERENT test each time (2026-09-04, high, friction: tool_should_decide).** Two `audit-code-test-suite` runs on
  `main` the same day failed identically and in different places: `tests/audit/next-step-narrative.test.ts`
  on shard 1/4 (`e197ea2c`) and `tests/audit/audit-code-completion-present.test.ts` on shard 3/4
  (`001d45f1`). Both report `Test timed out in 300000ms`, and shard 1 additionally reports the global-setup
  teardown catching a surviving child: `1 child process spawned by this run is STILL RUNNING: node
  audit-code.mjs next-step`. The full suite is green locally on the same tree (496 files, run three times),
  so the signal is CI-runner-specific and the varying test file says the cause is a shared resource or a
  runner-speed floor, not any one test. The cost is the expensive kind: `ci` goes green while
  `audit-code-test-suite` goes red on the same commit, so "is main green" has two answers and the red one
  is the one everybody learns to skip. **Property:** an orchestration test that spawns the real CLI either
  completes within a bound the slowest supported runner meets, or fails naming what it waited on — a bare
  300s timeout with a live child names nothing.

- **Three code comments assert a shape the tree no longer has, and nothing checks a comment
  against the code it describes (2026-08-31, medium, friction: tool_should_decide).**
  The header of `src/shared/continuityScore.ts` says audit "re-exports `computeContinuityScores` …
  and biases review-packet ORDERING with it"; `grep` over `src/audit` finds no consumer at all, only
  `access_memory.json` writers — and `spec/audit/dependency-map.md` separately calls that artifact
  write-only, so the comment is what makes the spec look self-contradictory. The doc comments on
  `renderConceptualReviewPrompt` (`src/audit/orchestrator/designReviewPrompt.ts`) and on
  `conceptual_findings` (`src/audit/types/designAssessment.ts`) both list five conceptual-review
  categories where `conceptualOutputFormat` has emitted eight since `e9b0ae77`, and
  `findingsEnvelopeExample` names a "combined" pass that exists nowhere else in the tree. All three
  were found by a doc-review lane
  reading code to check a DOC, which is the point: the docs are gated by
  `check:doc-code-citations`, and comments are gated by nothing. **Property:** a comment that names a
  symbol, a workflow shape or an enumeration the code owns is reconciled against it mechanically, or
  it does not state one.

- **`durable-traps.md` documents RETIRED infrastructure as though it were live (2026-08-30, medium,
  friction: tool_should_decide).** Eight entries describe the FreeLLMAPI router on `127.0.0.1:3001`,
  its `claude.ps1` launcher, and the `mcp__freellmapi__offload_*` tools. FreeLLMAPI was retired
  2026-08-29; at the time this entry was written, llm-relay on `127.0.0.1:8791` had replaced it, but
  llm-relay was itself retired 2026-09-22 by the switch/agent-dispatch lap
  <!-- retired-infrastructure-exempt: llm-relay — historical record of what replaced FreeLLMAPI in
  2026-08-29, before llm-relay's own retirement; the register in
  `scripts/shared/retired-infrastructure-data.mjs` is the current source --> — the machine-wide
  `CLAUDE.md` warns that running `claude.ps1` RESURRECTS the retired FreeLLMAPI service. A ninth
  entry says the relay "dies with the
  dispatching session, and nothing restarts it", which the same file contradicts — it autostarts at
  logon. This file is a standing REFERENCE, so a stale entry costs a future session a wrong action,
  not merely a wasted read. Found incidentally by a scope audit looking for something else, which is
  the point: nothing checks it. **Property:** an entry naming infrastructure that no longer exists is
  deleted or dated when that infrastructure retires, driven by the retirement rather than by someone
  later noticing.

- **A literal pinned in a test outside the change's neighborhood reds only in CI — the general
  discovery arm stays open (2026-08-29, medium, friction: tool_should_decide).** The lap's three
  known instances are closed (one shared pin in `tests/helpers/precommitLegExpectations.ts`,
  <!-- doc-citation-exempt: the deleted member IS the subject — the pin was re-pointed because this file no longer exists -->
  imported by both leg-set consumers; the stale `writeScope.ts` pattern-member pin re-pointed; the
  probeLane and barrel pins fixed earlier, `a8daeef9`). Open: nothing makes the NEXT duplicated
  derived literal red locally. **Property (open half):** the commit legs run the pinning tests
  whose SUBJECT a staged file feeds, or an equivalent gate makes a duplicated derived literal red
  before CI.

- **Registering ONE new gate still takes edits in several separate homes (2026-08-30, medium, friction: tool_should_decide).** The npm script, ordered `verify:checks` membership, GUARDS and REACH rows remain independently authored. CI trigger paths are derived from REACH. The redundant gate-enumeration scripts and ship-skill list have been removed; the remaining consolidation is section B of [the governance plan](../reviews/audit-tools-governance-simplification-2026-09-19.md). **Property:** one executable declaration owns command, order, reach and pre-commit policy, with generated consumers rather than parity checks between duplicate lists.

- **The loop-core closure rule claims a module only when EVERY importer is core, and today's 25
  declared modules are grandfathered by MEASUREMENT (2026-08-30, low, friction: tool_should_decide).**
  `check:loop-core-closure` closed the moved-symbol class: a module imported only by loop-core is
  core, or it is declared with a reason in `scripts/shared/loopCoreClosureData.mjs`, and a
  declaration that stops being true reds too. Two halves stay uncovered, both stated as
  `uncovered` data in the guard-reach registry rather than only here. (a) A genuinely-core module
  that ALSO has one ordinary consumer is not claimed by the rule, so it must still be added by
  hand. (b) The 25 rows the gate landed with record what the tree MEASURED, not a judgement that
  each module is correctly outside the set — nothing has re-derived their classification.
  **Property:** a declared exclusion states why the module is not core, and that reason has been
  checked rather than inherited from the measurement that created the row.

- **A history-moving commit lands its INCOMING content unreviewed — the gate can only read the
  STAGED snapshot (2026-08-28, mechanism corrected 2026-08-29, medium).** The original entry said
  the gate matches `git commit` text only, so other commit-creating verbs land ungated. That half is
  FALSE and was already false when written: `COMMIT_CREATING_SUBCOMMANDS` has covered
  `commit|merge|rebase|cherry-pick|revert|am` since `d81a86f4` (2026-08-06), and
  `tests/shared/pre-commit-gate-commit-creating.test.ts` pins that a BAD staged sentinel blocks every
  one of them. The observed escape has a DIFFERENT mechanism: a fresh `git cherry-pick <sha>` or
  `git merge <branch>` stages nothing, so the legs, the loop-core attestation and the
  constitutional-doc gate all read an EMPTY staged set and demand nothing, while the command still
  lands the incoming tree. `pre-commit-gate.mjs` states this as a known accepted limit at its
  `COMMIT_CREATING_SUBCOMMANDS` definition. **Open half:** on a branch it is survivable — the gates
  re-run when the work reaches `main` by ordinary commit — but a cherry-pick or merge INTO `main`
  lands loop-core or constitutional content with zero mechanical review. **Property:** the
  attestation checks read the paths the command will INTRODUCE — derivable pre-hoc from the named
  ref (`git show --name-only <sha>`, `git diff --name-only HEAD...<branch>`) — or history-moving
  verbs onto `main` are refused. OWNER DECISION: closing it reverses a recorded acceptance, and
  refusing merges onto `main` would change the documented ship flow.

- **The attest preflight's REFUSAL is now sound, but the divergent case gets no verdict at all
  (2026-08-28, narrowed 2026-08-30, medium, friction: tool_should_decide).** The legs read the working tree
  while the attestation binds the staged tree; an UNSTAGED guard-registry row naming a not-yet-tracked
  test file once refused the attestation of a staged set containing neither. **Covered:** a refusal is
  issued only when the worktree tree equals the staged tree BEFORE and AFTER the legs run, so the
  refusal text's "the staged tree would be rejected" is true when it appears. **Uncovered, all three
  stated outright:** (a) on any divergence the preflight ABSTAINS — a genuine staged-tree failure is
  missed and surfaces at the gate, costing one P19 double-attestation; (b) even an attributable verdict
  is a PREDICTION, since gitignored state, `$HOME` (`check:memory-citations` resolves a path under the
  home dir and exits 0 when absent) and cwd can all change between attest and commit; (c) per-leg
  attribution by declared REACH is permanently off the table — `check-guard-reach.mjs` states verbatim
  that a row's reach may be narrower than its guard's true inputs, so reach is sound as a TRIGGER
  (under-declaration means a leg does not fire) and unsound as ATTRIBUTION (under-declaration would
  stamp a refusal as proven). Two measured instances: `check:scripts` reach carries no `src/**` while
  its tsconfig maps the shared subpath into `src/shared`, and `check:tests` reach carries no
  `wrapper/**` or `.claude/hooks/**` while its tsconfig sets `allowJs` and tests import from both.
  **Property:** the preflight never issues a verdict about the staged tree that it did not establish.

- **`shell-trap-guard`'s PowerShell here-string rule did not fire on two Bash-tool commits and then
  fired on a third near-identical one (2026-08-27, medium).** Three `git commit -m @'…'@` calls went
  through the Bash tool in one session with the same here-string construct. The first two were NOT
  blocked by the here-string rule and reached the pre-commit gate (which stopped them for unrelated
  reasons); the third was blocked with the here-string message and its `commit -F` remedy. The
  remedy works and is correct. What is unexplained is the inconsistency: a guard that admits a
  mangled-commit-message construct twice and refuses it once is a guard whose reach cannot be relied
  on, and the two admitted commands would have landed a truncated message had the other gates not
  intervened. No mechanism is claimed here — the observation is the finding. **Property:** the rule
  is deterministic over the command text, with a contract test pinning the admitted and refused
  forms, so its reach is a property of the input rather than of the attempt.

- **The Implementation DAG prompt does not state the one-invocation rule for `targeted_commands`
  (2026-08-23, medium, friction: tool_should_decide).** The worker emitted `npm run build && npm run
  check` on 23 nodes; the promotion gate rejected the whole DAG twice (`MAX_DAG_REGENERATION_ATTEMPTS`
  = 2, one more would have blocked the pipeline) for a defect the tool can normalize by splitting on
  `&&`. **Property:** a mechanically-normalizable violation never spends a regeneration attempt — the
  tool splits, or the prompt states the rule and the validator reports a targeted repair.

- **Promotion and close residuals from the CP-NODE-3/15 reviews (low, one entry).** (a) The
  friction shortfall gate reads `readdir(...).catch(() => [])`, and `archiveFrictionRecords`
  degrades to `[]` on the same failure — a friction directory that exists but cannot be
  LISTED yields zero on both sides and the records are destroyed ungated (errno-blind, the
  CP-NODE-5 class at lower stakes). **Property:** an unlistable directory refuses the delete,
  same as an unarchivable file. (b) With the coarse-backstop terminal branch retired, the
  guarantee that a `needs_clarification` item never survives into `runClosePhase` is owned
  solely by the force-close backstop in `src/remediate/phases/close.ts` — verify it holds
  there and pin it (the retired branch's residual, named in the CP-NODE-15 classification).
  (c) The tool-owned gate spawns its suites SYNCHRONOUSLY (`runTracked` returns a value) while
  `phase.lock` is held, blocking the event loop so the lock heartbeat starves and the hold is
  exposed to stale-lock reclaim — the CP-NODE-5 lock-hazard class; pre-existing, and the
  one-lock restructure lengthens the hold with (non-spawning) pre-intake. **Property:** a held
  lock's heartbeat survives the longest spawn under it.
  (d) The stderr/run-log pairing pin's residual doors, probed: migrating ONE diagnostic to
  `console.log` and deleting its event stays green (the in-family survivors satisfy the
  vacuity guard — widen the family or key on the `[remediate-code]` prefix), and the pin
  silently mandates event-BEFORE-write ordering — a legitimate write-then-log pairing would
  false-red with a misleading message; state the mandate in the comment and failure text.

- **Host-handoff residuals from the CP-NODE-6 landing (low, one entry).** (a) A malformed
  FRONTIER block at prepare raises a classified aggregate naming the thrower, but still a
  THROW — the bounded-step-instead-of-throw half needs `src/remediate/steps/nextStep.ts`
  plumbing; and the
  free-form path (`normalizeExtractedPlan`) applies no path normalization, so free-form
  `src\a.ts`-style entries hit that refusal persistently. (b) Audit-side
  `withAcceptedResultsLock` covers the accepted-results pair only: ingest reads the
  workload/result-map/task-bindings trio before the lock; prepare writes task-bindings
  entirely outside it. **Property:** one serialization covers the whole binding set.
  (c) The heartbeat/stale-reclaim logger seam has no production adopter. (e)
  `describeRequiredTestFailure` inlines up to 8KB per
  failure into the dispatch prompt — bound the excerpt. (f) `recover-ingest` exits 1
  whenever issues exist even when work WAS accepted — distinguish accepted-with-issues.
  (g) The ENOBUFS/ETIMEDOUT discriminator is win32-verified only (off-platform timeout
  degrades to `spawn_error`, still a refusal); the external-signal branch is posix-only
  and untested; the stale-scan predicate deliberately over-approximates (owned at the
  comment). (h) The prepare-time digest-mismatch throw is unclassified and has no
  sanctioned repair verb: when the state legitimately moves under a live binding (hit
  2026-08-20 — the coarse backstop's item mutation changed prompt-embedded retry
  context, so the re-derived workload digest no longer matched), prepare throws a raw
  "no longer matches" and the only repair is hand-deleting `host_handoff` and
  re-preparing. **Property:** a digest mismatch whose cause is state movement under the
  binding is classified and offers a sanctioned re-bind, not a raw throw.

- **Analyzer-boundary residuals from the CP-NODE-1 review (low).** (a) Six
  `normalizeGenericExternalResults` call sites in the adapter layer pass no repo root,
  so eslint/semgrep/npmAudit/coverageSummary/clippy/rubocop adapters still persist
  absolute paths — `toRepoRelativeAnalyzerPath` is exported and adoption is cheap. (b)
  The sibling analyzer cache under the user's home holds executable npm packages
  created with default modes; the privilege-boundary reasoning now written into the
  binary-acquisition module applies verbatim. (c) Three end-to-end CLI suites drive
  real acquisition with no cache dir pinned, so they write to the real home directory —
  same family as `tests/remediate/postinstall.test.ts` and
  `tests/remediate/postinstall-contract.test.ts` (9 failures at hand-back, both green
  alone: they install an OpenCode global command + permission scopes into home-based
  config). Property: a suite's verdict must not depend on the real user home
  directory's state — single-point fix is pinning the relevant home-rooted paths in
  the vitest setup helper `state-dir-setup.mjs`, never per-suite discretion. (d) The
  bare-string consent token is retired only additively; the scoped grant has no
  production producer until the caller-side node lands.

- **Staleness third-state residuals from the CP-NODE-10 review (low).** The `partial`
  presence classification exempts the nine map-declared leaves, including the
  pipeline's primary machine contract, so a truncated leaf body is caught only through
  its dependents; the stale-artifact set's subclass discriminator is dropped by
  `Set.prototype.union` and `structuredClone` (no caller does either today); and the
  producer-side affinity hash in the artifact-metadata module is unguarded, so a
  malformed body dies loudly at restamp.

- **Emission-scaffold and gate residuals from the CP-NODE-12/13 reviews (low).** The
  loop-core path patterns do not cover `src/shared/steps/`, so the one write-and-log
  site for the host-facing step contract sits outside the attestation gate (a one-line
  pattern addition plus a guard-reach data sync, safety-monotone). The drain's
  re-derivation half is pinned as a unit property of the obligation-state memo, not a
  drain-level one, and nothing keys continuation on the deferred set — the drain-level
  assertion needs a deferred-nonempty fixture that does not exist. The cycle-break
  mediator check requires that SOME member depends on the designated node where the
  prompt says BOTH sides must; the promotion gate reads its cross-gate payloads twice;
  and the stale prompt-schema copy's content pin covers the schema block only.

- **Charter and route residuals from the CP-NODE-18/19 reviews (low).**
  `spec/audit/artifact-contract.md` and a test NAME in the charter-packets suite still
  say the pre-bump charter-register version (one-token fixes; dated review records
  under docs/reviews stay untouched). The stamped-delta type collapse is unfinished —
  the required-on-the-register type and the extraction module's own identity type both
  survive, along with a missing barrel export. A subsystem present with an empty
  members array gets no clarification note although the message would be true, and
  refusals print undifferentiated from routine remediator-routed skips. On the route
  side, a routes module importing a shared router from a sibling has no framework
  marker so its real routes are dropped (documented at the gate, leads-not-verdicts),
  and route registration inside `.vue`/`.svelte`/`.astro` script blocks is now skipped
  by the source-extension gate.

- **Drift-guard residuals from the CP-NODE-25 review (low).** The schema guard's
  anti-inert floor is a bare greater-than-zero check, so coverage can drop from eight
  structural sites to one and still report green — pin the site set, not the count.
  The rank guard's canonical-file exemption is inert (it asserts existence, not
  membership in the walked set) and its rank-literal regex is key-order-locked, so a
  re-inlined table in any other order goes undetected. The retirement guard's failure
  message asserts a resolution fact its probe did not establish for codes outside its
  known set (fail-direction is safe). The `statSync` beside the now-uncaught
  `readdirSync` is still uncaught, so a file that disappears mid-walk kills the guard.

- **`fixture-generator-drift-guard` is not hermetic (low, friction).** All three cases
  failed on a missing built entry point that existed on disk throughout, and the suite
  passes alone and on re-run — consistent with a concurrent dist clean/rebuild rather
  than a regression. Property: a guard suite's verdict must not depend on another
  process's build timing.

- **A scoped wave item that coins an invariant id in `src/` is structurally unable to
  satisfy the id-glossary gate (2026-08-20, medium, friction: tool_should_decide).**
  `docs/glossary-ids.md` is outside every module's `file_scope`, the gate scans `src/` for
  `INV-*` ids, and the pre-commit gate does not run the glossary test — so the red lands
  silently and is discovered by the NEXT item's worker (happened twice in one session:
  `INV-SSP-DEFERRED-SET-REPORTED` at CP-NODE-10, `INV-CCI-NO-DELTA-ID-PARSING` at
  CP-NODE-18). **Property:** either workload preparation includes `docs/glossary-ids.md` in
  any scope whose contract declares a new invariant id, or the glossary gate joins the
  per-item required commands, or new ids stay out of `src/` comments by convention (the gate
  scans `src/` only — CP-NODE-9 adopted this deliberately).

- **The TASK draw's coherence eligibility is still disjunctive and has never been measured for
  collapse (2026-08-19, medium).** The findings draw moved to `shared_file AND same_lens`;
  `TASK_DRAW_COHERENCE_POLICY` keeps `weighted_score_threshold` deliberately, because no measurement
  of `buildTaskCoherencePartition`'s components on a real graph exists. **Property:** the task draw's
  eligibility is either measured and shown not to collapse, or aligned with the findings draw's — it
  is not left disjunctive on the grounds that nobody looked.

- **Contract-pipeline fan-out names a mechanism the host may not have (2026-08-08, medium).**
  `module_contract_drafting` says "dispatch ONE sub-agent PER MODULE"; where in-process subagents are
  unavailable the only route is a shell-out lane the tool neither knows nor sizes for (2 of 9 such
  dispatches died mid-output; only the step's presence check caught it). **Property:** a fan-out step
  states what it NEEDS (N independent contexts, no shared authorship), not a mechanism; an
  absent-after-dispatch shard reports as TRANSPORT failure, not a refusal. Uncovered half: nothing
  carries the Stop-gate kill-switches into a shell-out child, so it hangs.

- **Sweep the test tree for tests that re-implement their subject (2026-08-08, medium).** One live
  instance found and fixed in `c791df49` (see git log). **Why no gate catches it:** such a test is
  green, typechecks, has no unused exports, and coverage counts the replica's lines — knip, eslint and
  the red-green rule all pass a test that pins nothing. **The tell:** a function declared in a test file
  that mirrors production control flow (a `for` over step kinds, a switch over cases) instead of calling
  into `src/`. **Property:** every test either calls production code or is deleted; where a replica
  exists because the subject is undrivable, fix the *untestability* (inject the dependency), not the
  test. Scope: `tests/**`, starting with the harness-heavy audit suites. [[test-must-reach-the-code-it-claims]]

- **Vitest worker RPC starvation — the false-RED exit is CLOSED at the gate; the >60s blocking
  worker is unlocated (recharacterized 2026-08-07; was "full-suite exits 1 while every test
  passes", 2026-08-06).** The exit-code half is a non-issue through the sanctioned path:
  `npm test`/CI route through `scripts/shared/run-vitest-gate.mjs` (since `605fe61e`), which converts
  exit-1 + 0-failed + the `[vitest-worker]: Timeout calling "onTaskUpdate"` stderr marker into a loud
  PASS — the 2026-08-06 red exits were raw `npx vitest run` invocations that bypass it. What stays open
  is the starvation itself: the worker-side birpc reply timeout is a hard 60s
  (`rpc.-pEldfrD.js` onTimeoutError), so the error means ONE continuous ≥60s sync stretch in some <!-- doc-citation-exempt: vitest worker bundle chunk -->
  worker. `audit-code-completion-*.test.ts` is ruled out as sole cause — a solo run does not reproduce and
  an event-loop stall probe recorded ZERO stalls during a full run in which the error fired. Candidate
  sweep: [`reviews/rpc-starvation-candidates-2026-08-07.md`](../reviews/rpc-starvation-candidates-2026-08-07.md)
  — its one confirmed instance (sync full-CLI `next-step` children in
  `next-step-pipeline-dispatch.test.ts`) was converted to async spawn; gate-script spawns in
  `tests/shared/*-gate.test.ts` are the next leads. **Re-hit 2026-08-31:** the final
  pre-release and released-tree `npm test` runs each recorded 6,119 passed / 0 failed,
  then emitted the same `onTaskUpdate` timeout; `run-vitest-gate.mjs` correctly
  rendered REPORTER-TRANSPORT PASS both times. This satisfies the recurrence trigger:
  instrument the remaining synchronous gate-script spawns next. ⚠ Standing trap from
  the reverted 2026-08-06 attempt: `projects:`
  at the TOP LEVEL of `vitest.config.ts` is silently ignored and voids the whole test config
  (false GREEN); any config split must nest under `test.projects` and prove both exit
  polarities. **Property:** no test worker blocks its event loop ≥60s continuously; until then
  the vitest-gate tolerance is the guard, and raw `npx vitest run` full runs still read red.

- **Remediation pause/recovery is not durable (2026-08-03, medium).** A plan-only stop left
  `.audit-tools/remediation/state.json` at `status: implementing`; the host work and its worktree
  had to be found and reconciled manually, while the worktree survived only because the operator
  knew its path. The primary record is
  [`graph-derived-findings-remediation-process-review-2026-08-03.md`](../reviews/graph-derived-findings-remediation-process-review-2026-08-03.md).
  **Property:** `plan_only`, pause, cancel, and resume persist the work item, workload binding,
  worktree outcome, and exact continuation action; resume must not re-run or discard accepted work.

- **Graph heuristics are promoted to findings without a semantic lead boundary (2026-08-03, medium).**
  Generic cut-edge detection labels ordinary test/asset/manifest bridges as systemic fragility; absolute
  co-change counts overstate broad migration commits; and whole-document file co-mentions masquerade as
  declared module boundaries. The sixteen declined items are the negative/corroboration corpus. **Property:**
  deterministic graph output is a generation/provenance-bound lead, not an approved finding, until semantic
  confirmation; report promotion must preserve producer, source hash, and evidence lineage.

- **Tool-owned gate reds are unattributed — foreign live-tree dirt pauses the run (2026-07-30,
  shrunk 2026-08-20; was "Phase-boundary gate false abandonment", HIGH).** The mutation half is
  RETIRED and test-pinned: a red gate now persists the failing command and a bounded output tail
  to `final-gate.json` and emits a resumable `final_gate_red` pause — no item status, phase, or
  state write; the coarse reattempt/terminate machinery is deleted (it wiped 21 resolutions on
  2026-08-20 when an unrelated landed commit reddened the live-tree suite; the 2026-07-30
  abandonment of 13 items was the same class). What stays open: the gate runs on the LIVE tree
  and computes no attribution, so dirt or breakage the run did not cause still pauses it — now
  bounded, classified, and resumable, but reported as the run's red rather than as environment.
  Primary records:
  [`meta-review-remediation-run-2026-07-30.md`](../reviews/meta-review-remediation-run-2026-07-30.md).
  **Property (residual):** a gate red is attributed to run-touched paths where possible, so a
  foreign red reports as environment, not as the run's failure.

- **⬇ Live-run watch (re-dogfood 2026-07-22, medium): a worker self-reported "valid, verified" on a
  malformed-JSON result file — result validity must be checked mechanically, never trusted from
  the worker's claim.** The merge correctly rejected it, but the failure surfaced only as an
  unexplained same-packet re-grant. Properties: (a) results are parse- and
  AuditResult-contract-checked at result-write or pre-merge; (b) the merge's "missing or invalid"
  names WHICH per task (file absent vs parse error vs contract mismatch). Record:
  [`re-dogfood-friction-2026-07-22.md`](../reviews/re-dogfood-friction-2026-07-22.md) #12.

- **Review rounds re-derive the same file map every time (inefficient-feeding, 2026-07-19).** Each
  adversarial round spawns FRESH agents that re-grep the same call-site map from scratch (~135k
  subagent tokens per round, much of it identical recon), because continuing a prior reviewer
  preserves its context but forfeits the independence the round exists for.
  **Property to hold:** no review round re-derives a mechanical fact another round already established,
  and no round judges anything it authored — the verified map is a read-only, provenanced input artifact
  each round receives labelled as prior recon it did not author, and cannot write back to (updates go
  through a separate recon step, so it cannot absorb a reviewer's assumptions and then be handed to the
  next round as fact).
  **Already refuted, do not re-propose:** that independence of VERDICT and independence of INPUT are in
  tension — they are not, and the framing is why the obvious fix looked wrong. A round must not judge
  work it authored; being handed a factual map it did not produce does not compromise that, so
  re-deriving from scratch was never carrying independence, only paying for redundant derivation.
  ⚠ Sharing an agent SESSION across rounds is likewise wrong and forfeits exactly what the round is for.

- **The per-site pinning gate's name binding is author-supplied (2026-07-25).**
  `scripts/check-sites-pinned.mjs` derives each changed site from the staged diff, so an omitted hunk
  is impossible, and requires a `// sites-pinned: <test file names>` declaration above it. The names
  are read from that declaration, so the gate moves the claim one level up rather than removing it;
  its output says so and is not admissible as loop-core attestation evidence. **Property:** the
  expected-failing test name for a site is DERIVED (from a baseline coverage or ownership map), not
  author-supplied. Not yet designed.

- **Friction walk (copy-fallback lap, 2026-08-30):** (1) **ambiguous-direction:** none — the goal
  came from the backlog and was approved, and the one scope decision it raised (widening the
  loop-core set) was asked and answered before the edit. (2) **inefficient-feeding (medium): the
  recorded lane lesson did not reach the point of use, so the SAME 20 minutes were spent again.**
  The *two-identities* walk below already said to prefer agy over the pool lane for a repo-reading
  refutation. It lived only in a friction walk, so this lap dispatched `claude-free-pool` anyway and
  it ran 23 min without returning. `.claude/skills/design-check/SKILL.md` step 3 now names the agy
  rungs and demotes the pool lane to last resort, so the preference is read where the lane is
  chosen. Measurements:
  [`design-gate-copy-fallback-2026-08-30.md`](../reviews/design-gate-copy-fallback-2026-08-30.md). (3) **inefficient-feeding (low): the release
  refuses on an IN-FLIGHT CI run rather than waiting for it.** `release-and-publish.mjs`
  `ensureCiGreenOnHeadSha` failed the whole release ~2 min after the push, and its own message says
  "wait for CI (or the in-flight run) to complete, then retry" — so it knows an in-flight run may
  exist and declines to wait on it. The retry then re-ran the full pre-tag gate from scratch.
  **Property:** the pre-tag gate waits out a run already in flight for that SHA, and refuses only
  when none exists or one has concluded red. (4) **already tracked, hit again, deliberately NOT
  restated:** the closeout Stop gate challenged a mid-lap pause, and `verify-green.mjs check`
  deferred without naming a runnable check — both are open entries in the machine-wide
  `C:\Code\docs\backlog.md`. (5) **filed machine-wide this lap:** three merged, clean `start-lap-*` worktrees survived their laps and cost
  this lap-start an inspection each; the owner ruled worktree cleanup machine-wide.

- **Friction walk (commitFold unlink lap, 2026-08-30):** (1) **ambiguous-direction:** none — the
  goal was picked from the backlog with the owner, and the one live owner decision (the session
  liveness shape) was asked and answered before any edit. (2) **inefficient-feeding (medium): a
  release invalidates the green stamp BY CONSTRUCTION, and no batching avoids it.** The stamp binds
  worktree CONTENT; `release-and-publish.mjs` bumps `package.json` and `package-lock.json` AFTER its
  pre-tag gate, so every release ends with a stamp pointing at the pre-bump tree and costs one extra
  full local suite (~3.2 min) to re-certify a two-line version change that the publish run's own
  4-way sharded suite already ran. Distinct from the two-identities lap's batching case, which WAS
  avoidable. **Property:** the release script mints the stamp on the tree it bumped, or the
  mechanism recognises a bump-only delta as content it already certified.
  (3) **inefficient-feeding (low):** the `claude-free-pool` (pool/medium) refutation lane ran 14 min
  with no answer and was cancelled; an `agy` lane given the identical prompt returned a fully-cited
  verdict in ~4 min, and its two novel claims both held against source. For a repo-reading
  refutation, prefer agy and hand it the recon map.
  (4) **machine-wide, filed OUTSIDE this repo:** `verify-green.mjs check` defers to this repo's
  mechanism and names no runnable substitute, so step 3 of the lap had to hand-compute
  `worktreeTree` to learn whether the baseline was green. Its home is `C:\Code\docs\backlog.md`,
  because the declaration schema and its reader are machine-wide.

- **The per-result LLM conformance review — the opt-in depth dial half of the owner decision — is
  unbuilt, so semantic conformance to the carried module contracts is still judged by nothing
  (2026-08-09, narrowed 2026-08-29, medium).** The mechanical floor half is enforced: the work item
  binds `obligation_ids`, the result cites evidence per bound obligation (`obligation_evidence`,
  `remediation-host-result/v1alpha3`), and ingestion refuses uncovered, unknown, duplicated, or
  uncited obligations (`parseResult`, src/remediate/steps/dispatch/hostHandoff.ts). What remains is
  the decision's second half: a bounded per-result LLM conformance review as an opt-in per-run
  depth dial (per-run choices are never persisted) that judges whether the cited evidence actually
  demonstrates conformance to the carried contracts — coverage is mechanical, sufficiency is not.
  [[enforce-robustness-in-tooling-not-host-discretion]]

- **Self-audit dogfood loop: fixing the tool mid-run invalidates the run (2026-07-16,
  ambiguous-direction, low-medium).** The defect was found BY the run, and committing its fix changed
  the audited tree → staleness correctly marked the planning chain stale and restarted from
  `charter_extraction`. Semantics are right (the dependency DAG is truth); the open sliver is that an
  active run should announce which upstream change invalidated it instead of silently re-planning.
  **SPEC — keep the cascade, ANNOUNCE it. Do not narrow staleness to make dogfooding cheaper.** The
  regression to first-planning-step is correct: the audited tree changed, so the planning derived from it
  is genuinely invalid, and the dependency graph is the source of truth. Any mechanism that spares a
  self-audit run from its own cascade would be special-casing the tool's convenience against the
  correctness rule the whole design rests on.
  What is actually wrong is that a large, expensive, correct action happens SILENTLY and looks like
  malfunction. The run should state that it was invalidated, by which upstream artifacts, and what it is
  therefore re-deriving — one message, at the moment it happens.
  **Property to hold:** an expensive automatic recovery explains itself at the moment it triggers. A user
  who cannot tell a correct cascade from a wedge will eventually defeat the cascade.

- **Friction walk (niggle-fix lap, 2026-08-07):** **tool-should-decide (low):** implement agents
  left ~16 stray `*.log` files in the repo ROOT despite prompts directing output elsewhere — the
  recorded offloaded-diff-scope class ([[parallel-dispatch-bounded-current-verified]]); the driver
  swept them before commit. The `*.log` ignore rule keeps such a log from reddening
  `check:doc-code-citations`, but it also removed `git status` as the signal that surfaced this —
  a stray log is now invisible.

- **Friction walk (touched_files load-gate lap, 2026-07-25):** (1) **tool-should-decide (medium):** a
  fixture helper ending in `as RemediationState` (`tests/remediate/helpers/nextStepHarness.ts`)
  makes `check:tests` inert for that fixture — it hid blocks missing a REQUIRED contract field from the
  gate added to catch exactly that. Property: a fixture must not be able to cast away a contract's
  required keys — `satisfies`, or a builder that cannot omit them.

- **External shared-logic audit V1–V7 residuals** (each deliberate, low-severity, documented at the code
  site):
  - **(from V3) postinstall agent-scope legacy-wildcard migration gap.** Both postinstall scripts preserve
    an EXISTING legacy agent-scope bash `'*':'allow'` in an already-deployed
    `~/.config/opencode/opencode.json` on upgrade (the wrapper/install path DOES migrate it → `'ask'`;
    pinned deliberate by remediate's COR-fc1f12a6 tests). Full closure: mirror the wrapper's
    `withoutManagedBroadBashWildcard` migration into `scripts/{audit,remediate}/postinstall.mjs`.
  - **(from V5) path-guard blind spots.** `tests/shared/audit-tools-path-guard.test.ts` cannot see
    template-literal construction (no live occurrence today) and its allowlist honesty check is
    substring-only. Tighten if a violation ever sneaks past. Also low: `validateArtifacts`'s unused
    `root="."` default now yields an absolute (not relative) report path — no live call site hits it.

- **Top gate optimization — the suite-side tail is subprocess wall, not isolation overhead (measured
  2026-07-06).** It sits in a few audit integration files, so
  `pool:'threads'` / `isolate:false` will not help — the lever is the sharding already shipped, plus
  possibly splitting the 100s+ files across more shards (verify per-file: many tests spawn/mutate fs, so
  isolation-off risks bleed). Live numbers are in `.audit-tools-profile/*-history.ndjson`, never here.

- **Selective-deepening convergence — live validation env-bound.** The pending-task partition and
  prompt-bound audit ingestion now single-source the identity of every deepening task
  (`src/audit/orchestrator/pendingTasks.ts`,
  `src/audit/cli/dispatch/hostHandoff.ts#ingestAuditHostResults`). Missing or mismatched host results
  remain pending rather than being rebound heuristically. **Still open:** confirmation on a real run
  that every `deepening:*` task converges in bounded rounds and the audit reaches synthesis without
  `force-synthesis`.

- **The dispatch boundary strips every per-node field the contract pipeline writes onto a promoted
  finding but `FindingSchema` does not declare (2026-08-27, medium).**
  `promoteImplementationDagToExtractedPlan` (`src/remediate/steps/contractPipeline.ts`) writes
  `concrete_change`, `preconditions`, `expected_changes`, and `addresses_counterexamples` onto each
  promoted finding. `FindingSchema` (`src/shared/types/finding.ts`) is a bare `z.object` declaring
  none of them, so zod's default strip removes all four at the `FindingSchema.parse` inside
  `buildFindingAssignments` (`src/remediate/steps/dispatch/hostHandoff.ts`) — and that parse result
  IS the per-item payload handed to the host, the last hop before the implementer prompt.
  `targeted_commands`, which IS declared, survives the same parse, so the loss is silent and
  field-selective rather than a visibly broken payload. `tests/remediate/contract-pipeline.test.ts`
  pins the producer for `preconditions` and `expected_changes`, so the producer half is guarded and
  the consumer half is not; no code reads any of the four off a finding, because their only intended
  consumer is the host payload the parse empties. The implementer works from `summary`/`evidence`
  without the node's stated precondition or expected change.
  **Property:** a field the pipeline computes onto a finding reaches its consumer or is not computed
  — it is declared on the finding contract, or the producer and the tests pinning it go. Same class
  as the write-only remediate submission-ledger entry, at a different boundary.
  [[write-only-data-looks-authoritative]] Trace:
  [`n-r13-and-lean-fast-path-trace-2026-08-25.md`](../reviews/n-r13-and-lean-fast-path-trace-2026-08-25.md).

- **The masked-exit guard keyed on TEST RUNNERS, not on whether the exit status is load-bearing —
  NARROWED to its curated-list half (2026-08-27, narrowed 2026-08-29, medium, friction:
  tool_should_decide).** `git push origin main 2>&1 | tail -3` was admitted and reported exit 0 for a
  push refused as non-fast-forward, its hint scrolled past inside the captured tail. The false green
  is worse than on a suite: an agent that believes a push landed stops verifying, and
  pipeline-ownership then reads as satisfied while the work sits only on the local branch.
  **Enforced half:** `shell-trap-guard.mjs` runs ONE rule over two families (`MASK_FAMILIES`) — the
  suite family unchanged, plus a state-changing family (`git push|commit|merge|rebase|cherry-pick|tag`,
  `npm|pnpm|yarn publish`) — in BOTH the pipe rule and the background-laundering rule, with the same
  two escapes (`pipefail`, `PIPESTATUS`) and the same `AUDIT_TOOLS_ALLOW_MASKED_EXIT` bypass.
  Read-only verbs (`log`, `status`, `diff`, `show`, `branch`) stay admitted, pinned so the fix cannot
  become a false red. **Open half:** the family is a CURATED LIST, because "is this exit status
  load-bearing" is not derivable from command text. Every state-changing command outside the list is
  still admitted — `gh pr merge`, `gh release create`, `npm version`, `docker push`, `terraform apply`.
  **Property for the remainder:** a command that changes state outside this repo's working tree is
  refused when piped into a filter, or the registry states which verbs the list claims.

- **An agent push to `main` is not gated on a full-suite stamp, and the "touched area's suite" rule
  cannot see a cross-area invariant (2026-09-03, medium, friction: tool_should_decide).** P50 landed
  RED on `main`: its lander ran build, typecheck and the touched area's suite — exactly what
  `CLAUDE.md` requires — and pushed. The new test imported `execSync` directly, which the cross-area
  `INV-WH` windowless-spawn invariant (`tests/helpers/trackedSpawn.ts`) refuses; that invariant lives
  in another area, so no touched-area suite could reach it and only release CI did. `main` stayed red
  across two commits until the repair rode with an unrelated cluster. The commit gate's staged-set
  legs have the same blind spot by construction — they are derived from the staged paths. **Property:**
  a push to `main` from an agent session is refused unless a suite-green stamp binds the pushed tree —
  a PreToolUse gate on `git push`, or the commit gate running the full suite for any commit that can
  land on `main`.

- **Audit-side host prompts still name a sub-agent MECHANISM (2026-09-15, low, friction: tool_should_decide).** P25c made the remediate-side prompts state the NEED (independent contexts, no shared authorship) instead of a mechanism the host may not have; the audit side still says "sub-agent"/"subagent" in `src/audit/cli/conceptualDispatch.ts` (3 sites), `src/audit/cli/nextStepCommand.ts` (13 sites) and `DISPATCH_PROMPT_HANDOFF_NOTE` in `src/shared/prompts.ts`. **Property:** one shared rendering of the independence need, used by both draws (one core, two draws), with a test that reds on the mechanism wording in either.
