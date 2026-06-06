# Backlog — known friction, deferred fixes & future features

A living log of things to fix or build later, so they aren't lost between sessions.
**Remove an entry once it ships** — this is a to-do list, not a status log (same
anti-rot rule as CLAUDE.md's *"docs capture durable concepts, not current state"*).

## Known friction (agent / dev experience)

- **`t.mock.module` is unusable in audit-code tests.** audit-code runs tests via
  `node --import tsx/esm --test`; `t.mock.module` needs
  `--experimental-test-module-mocks` and conflicts with the tsx/esm loader, so it
  throws `t.mock.module is not a function`. Use a dependency-injection seam instead
  (e.g. `cmdWorkerRun(argv, deps)` in `src/cli/workerRunCommand.ts`) rather than
  module-graph mocking.
- **Remediation block scopes can omit companion contract files.** A block adding
  `lens_breakdown` to the generated audit findings summary had write access for
  the shared type and synthesis code but not `packages/audit-code/schemas/`, even
  though `audit_findings.schema.json` has `additionalProperties:false` on
  `summary`. Implementation workers need schema files included whenever a public
  artifact contract changes.
- **Backslash escaping / arg serialization.** Inline `node -e "…\\…"` (regexes,
  Windows paths) gets mangled by shell backslash handling — write a small script
  file instead of inlining. Separately, the Workflow tool's `args` can arrive as a
  JSON *string* rather than a parsed object, so `args.foo` is `undefined`; defend
  with `const a = typeof args === 'string' ? JSON.parse(args) : args`.
- **The `Bash` tool mangles Windows backslash paths.** A plain command like
  `node C:\…\audit-code.mjs merge-and-ingest …` run through `Bash` drops the
  backslashes (`C:\a\b` → `C:ab` → MODULE_NOT_FOUND). Use the `PowerShell` tool for
  Windows-absolute-path commands, or forward slashes (Node accepts `C:/…`). The
  orchestrators now emit POSIX-slash commands for this reason (`renderCommand`), so
  the trap is mainly for hand-typed paths. (The `opentoken wrap` step-JSON mangling
  friction graduated to a command-class wrap policy — control-plane commands are
  wrap-exempt, encoded in the dispatch prompts + memory `opentoken-wrap-mangles-orchestrator-prompts`.)
- **Fresh git worktrees lack `node_modules`.** A newly created worktree resolves
  `@audit-tools/shared` against a stale `dist/` → spurious "no exported member"
  type errors. Run `npm install` in the worktree before `npm run check`.
- **New default-on orchestrator behavior breaks existing fixtures.** Turning the
  dispatch canary on by default (audit-code FINDING-008) changed `prepare-dispatch`
  first-contact output and broke end-to-end fixtures that assumed a single-round,
  all-packets dispatch; the fix was seeding `dispatch.canary:false` in the test
  helper. Any new default-on behavior needs a sweep of existing fixtures (or should
  ship default-off until they catch up).
- **audit-code `node --test` needs the tsx loader.** Bare
  `node --test packages/audit-code/tests/*.test.mjs` fails with
  `ERR_MODULE_NOT_FOUND` (the `.mjs` tests import built `.ts` via `.js` specifiers).
  Use the canonical `node --import tsx/esm --test …` (as in the package's `test`
  script). A trap when running one test file by hand or telling a subagent to "run
  node --test".
- **The `Bash` and `PowerShell` tools share one working directory.** A `cd` inside
  a `Bash` call changes the directory the next `PowerShell` call runs in, so a later
  `npm run check -w packages/<pkg>` fails with *No workspaces found* (the path
  doubles). Use a subshell `(cd … && …)` in Bash, or pass absolute paths and
  `Set-Location` the repo root explicitly, rather than relying on per-tool CWD.
- **PowerShell block output cannot be piped inline after a `foreach` statement.**
  A shape like `foreach (...) { ... } | ConvertTo-Json` throws "An empty pipe
  element is not allowed"; assign the loop output first (`$out = foreach (...) {
  ... }`) and pipe `$out`.
- **Dirty remediation test files can mask block verification.** In shared
  worktrees, broad focused runs may fail on pre-existing edited tests unrelated to
  the block; record the broad failure and run the new/changed tests by name so
  worker evidence stays attributable.

## Deferred fixes (product bugs)

### remediate-code host-dispatch gaps (surfaced by the 2026-06-03 MCP-removal dogfood run)

- **F016 (provider `queryLimits`) deferred — near-zero value.** The canonical dispatch
  call site already treats an absent method and a `null` return identically
  (`await provider.queryLimits?.(…).catch(() => null) ?? null`), so the null-returning
  stubs change nothing at runtime; the only durable value would be the `types.ts`
  JSDoc contract. Revisit only if a provider gains a real proactive rate-limit endpoint
  (ties into "Adaptive, multi-agent quota-aware dispatch" below).

### remediate-code: the structured `audit-findings.json` fast-path skips intake entirely

Surfaced dogfooding this repo's own 488-finding self-audit (2026-06-04). Default input
discovery now **prefers `audit-findings.json` over `audit-report.md`** (fixed:
`defaultInputCandidates` + single best-pick in `resolveInputPaths`, regression test in
`next-step.test.ts`) — the JSON is the source of truth on both sides, so feeding it takes the
lossless structured hand-off instead of a lossy LLM re-extraction from the markdown render.

**Still open:** for structured input, `resolveIntakeStep` calls `runPlanPhase` directly
(`intakeResolver.ts:105-120`) and **bypasses the whole intake summary/brief/clarification flow**.
A clean "remediate everything" hand-off is fine, but a large contract gives the operator no
scope dialog — no "high-severity only?", no theme/package filter, no chance to exclude scratch
units — it always plans *every* finding. Consider a lightweight scope gate on the structured
path too (e.g. selectable `work_blocks`, or a severity/theme/package filter before planning).
Compounding (now resolved): the structured path also inherited the auditor's non-unique-id flaw
(audit-code **T-004**) for `work_blocks.finding_ids` → finding mapping (`plan.ts:105`); **fixed in
audit-code 0.10.3** — synthesis re-keys findings with globally-unique content-derived ids
(`reporting/findingIdentity.ts`), so the structured path now round-trips cleanly.

### remediate-code: fileIntegrity chokes on a finding whose affected_files is a directory

Surfaced re-running the remediation on the self-audit (2026-06-04). A finding's `affected_files`
entry can be a directory path (e.g. `packages/audit-code/schemas/`), and `checkFileIntegrity`
tries to hash it as a file → non-fatal `[remediate-code] fileIntegrity: I/O error hashing …:
EISDIR`. Planning continues but the integrity hash is silently absent for that item. Skip (or
recurse into) directory paths in the integrity hasher, or normalize/reject directory
`affected_files` at plan intake.

### remediate-code: implement dispatch produces an unworkable mega-block on hub-heavy codebases

Surfaced driving the self-audit remediation to the implement phase (2026-06-05). `buildWorkBlocks`'
file-based union-find collapsed **448 of 468** actionable audit-code findings into a single
`block-1` (594 write-paths, a **1.1 MB** implement prompt) because a handful of hub files
(`cli.ts`, `plan.ts`, `index.ts`, `io/artifacts.ts`) transitively connect otherwise-independent
findings. The implement phase dispatches one worker per block (to serialize edits to shared files),
so block-1 becomes an impossible single-worker task — far past any model's practical apply budget.
The real write-conflict graph is sparse: most findings touch disjoint files and could run in
parallel; only the hub-file cluster needs serializing. Options: (a) cap block size and split a
large block into serialized sub-waves keyed on the *actual* per-file conflict components (parallel
across disjoint components, serial within one); (b) budget the implement prompt and page findings;
(c) treat hub files as a dedicated serial lane and parallelize the rest. Until then, a monorepo
self-audit can plan but not cleanly implement.

### remediate-code: redesign implementation preview for clarity and rigidity

Standardize the formatting across providers and IDEs by outputting a deterministic format based on
tiers. Rename tiers. Rather than specifically prompting user to approve/deny tier 3 items only,
simply ask user to identify any findings to ignore. Allow for conversational feedback from the user.
Include a pros/cons section for each finding so the user can make an informed decision.

### remediate-code: ask for user approval for intake object(s)

Even if a perfectly-structured and non-stale audit report exists, give the user an opportunity to
specify a different or additional items to remediate. Look for the canonical audit document created
by auditor-lambda, but also look through any docs/ or similar folders for other potential candidate
inputs. Propose any files found to the user with a short description of what they contain, so the
user can decide whether to use any or many of them. The user can also at this time provide 
conversational direction as to other issues to remediate.

### audit-code: no way to re-synthesize a clean audit-findings.json after promotion

Surfaced fixing T-004 (2026-06-04). Synthesis promotes `audit-findings.json` to the repo root and
prunes the intermediate `.audit-artifacts/` inputs (`audit_results.jsonl`, `unit_manifest`, …), so
a later fix to the synthesis boundary (e.g. unique finding ids) cannot regenerate the existing
contract without a full re-audit — the raw per-packet results are gone. Worked around with a
one-off re-key script (`assignStableFindingIds` + `buildWorkBlocks` over the promoted findings).
Consider an `audit-code resynthesize` command that re-runs the deterministic synthesis tail
(re-key → re-block → re-render) over an existing `audit-findings.json`, or retain the minimal
inputs needed to re-synthesize.

### audit-code: fold pending `requeue_tasks` into the dispatch planner

The `audit_tasks_completed` no-progress loop (surfaced dogfooding a long multi-session
fan-out, 2026-06-04) was **fixed**: selective-deepening answers were being stranded
behind a stale, run-id-scoped `merge-complete.json` — once an early round wrote the
marker, every later deepening round for the same run-id short-circuited to an
idempotent replay, so the valid on-disk `deepening_*` results never ingested and
`audit_tasks_completed` stayed blocked forever. `merge-and-ingest` now (a) recovers an
un-dispatched pending task's answer from its on-disk result file (matched by
`task_id`) even when the dispatch manifest is empty, and (b) treats the completion
marker as **stale** when a pending task has an on-disk answer — re-processing instead
of replaying. Regression test: *"merge-and-ingest self-heals a stale completion
marker…"* in `audit-code-wrapper.test.mjs`. The "loops instead of halting" symptom is
resolved at the root (no premature marker stranding), so a separate repeat-detector is
unnecessary.

**Still open — requeue tasks are never dispatchable.** `requeue_tasks.json`
mandatory-coverage gaps (`status: pending`) appear **0×** in `review_packets.json` and
are never folded into `buildPendingAuditTasks` (`dispatch.ts`), so files like
`dispatch.ts`, `envelope.ts`, `lineIndex.ts` and the critical-flow test files are never
re-audited. Folding `bundle.requeue_tasks` into the pending set is loop-safe (requeue
never gates `audit_tasks_completed`, and a dispatched task is excluded the next round via
`completedTaskIds`) **but needs care**: requeue tasks carry no `file_line_counts`, and
the first-contact generation path in `prepareDispatchArtifacts` writes pending tasks
without `addFileLineCountHints` — so the fold-in must also hint line counts or packet
`total_lines` / result validation will be wrong. Deserves its own focused change + an
end-to-end dispatch validation.

### audit-code: confine auditor subagents to their assigned result paths

Review subagents must only emit results through `submit-packet` (which writes the
backend-assigned per-task result file under the run dir). In practice they scatter
stray files across the workspace: ad-hoc `packet-<n>-result.json` and
`audit_result*.json` at the repo root, files literally named `escaped` / `inside` /
`quote`, and — worst — mangled-name junk like `C:Codeaudit-tools…json` produced when a
subagent runs `node … > C:\…\file.json` in **bash** and the backslash path collapses
into a filename written to the repo root (the "Bash mangles Windows paths" trap, hit in
the wild during the 2026-06-04 dogfood run). `merge-and-ingest` already ignores these as
*spurious*, so they don't corrupt audit state, but they pollute the repo (had to be
`git clean`ed out of the untracked set after the run) and a mangled absolute write could
in principle clobber a real path.

The dispatch plan already carries a per-packet `access.write_paths` for exactly this,
but it is **advisory** — this host "did not report a callable restriction facility", so
nothing enforces it. Fixes: (a) make the packet-prompt submit instruction unambiguous
that the *only* permitted write is via `submit-packet`, with no scratch/temp files; (b)
where the host supports per-subagent file-access restriction, pre-approve only the
packet's `write_paths` and deny the rest; and (c) have workers pipe results to
`submit-packet` over stdin (or write to a relative temp path inside the run dir) instead
of constructing absolute shell-redirect paths — which is what manufactures the
mangled-name junk on Windows bash. **Principle: an auditor should never be able to write
a random file to a random location.**

## Features to add later

- **User-selected lenses.** Let the operator choose which audit lenses run instead
  of always running the full set. Consider having a base set of lenses that always run,
  so that the obligations of multiple-lenses-per-item can still be satisfied.
- **Heterogeneous multi-agent dispatch — capacity-pool foundation shipped 2026-06-04.**
  `computeDispatchCapacity({ pools, pendingItemTokens })` in `@audit-tools/shared`
  sizes dispatch JIT and sums concurrent slots across `CapacityPool`s; both
  orchestrators route through it (single host pool today). Remaining toward the
  heterogeneous fleet: per-packet provider assignment + partitioning `pendingItemTokens`
  across pools, host-model detection (`hostModel` is usually null), and building a real
  second pool (an IDE model or another CLI provider). See memory `quota-dispatch-vision`.
- **Choice of depth of Design Review step**
  Allow user to decide whether to do a shallow or deep design review. Shallow might mean
  having a single large-context agent do that review, and deep might mean using multiple
  parallel agents to come up with their own ideas, then to synthesize those independent
  perspectives, as in the https://github.com/uditakhourii/adhd project.
- **Limit unnecessary conversation outputs**
  Currently, many agents emit multiple steps describing their discovery of project
  principles: "I'm the orchestrator for...", "I should perform one bounded step...".
  Where possible, condense steps to eliminate round trips, and perform actions
  via the mechanical backend, only giving the orchestrator and subagents what they
  need.
