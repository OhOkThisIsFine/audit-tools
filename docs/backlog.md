# Backlog — known friction, deferred fixes & future features

A living log of things to fix or build later, so they aren't lost between sessions.
**Remove an entry once it ships** — this is a to-do list, not a status log (same
anti-rot rule as CLAUDE.md's *"docs capture durable concepts, not current state"*).

## Known friction (agent / dev experience)

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
Compounding: the structured path also inherits the auditor's non-unique-id flaw (audit-code
**T-004**) for `work_blocks.finding_ids` → finding mapping (`plan.ts:105`), so a clean dogfood
remediation of this repo is still blocked until synthesis emits unique, content-addressable ids.

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
  of always running the full set.
- **Heterogeneous multi-agent dispatch — capacity-pool foundation shipped 2026-06-04.**
  `computeDispatchCapacity({ pools, pendingItemTokens })` in `@audit-tools/shared`
  sizes dispatch JIT and sums concurrent slots across `CapacityPool`s; both
  orchestrators route through it (single host pool today). Remaining toward the
  heterogeneous fleet: per-packet provider assignment + partitioning `pendingItemTokens`
  across pools, host-model detection (`hostModel` is usually null), and building a real
  second pool (an IDE model or another CLI provider). See memory `quota-dispatch-vision`.
