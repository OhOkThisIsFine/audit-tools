# Audit-tools self-audit — remediation plan & handoff

> **Status (2026-06-01): executed and shipped.** Began as the plan for the 6
> unfixed meta-audit issues in [`HANDOFF.md`](HANDOFF.md) + the 404 findings in
> [`audit-report.md`](audit-report.md); now also the record of what was done.
> **Published:** `@audit-tools/shared@0.6.0`, `auditor-lambda@0.7.0`,
> `remediator-lambda@0.5.0` (master @ `16b0510`). This file is the canonical
> next-agent handoff.

## Next pickup — start here

Substantive remediation is done and released. What remains (none blocking):

1. **Decompose the 3 large files** (clean cuts identified; careful pure-moves,
   each verified by the full suite). `reviewPackets.ts` planning-graph-edges
   cluster → `reviewPacketGraph.ts` (sizing already split to
   `reviewPacketSizing.ts`); `internalExecutors.ts` → per-phase modules (hoist
   `ExecutorRunResult` + shared helpers first); remediate `decideNextStep` →
   extract transition branches into helpers.
2. **A1 finalization root-cause convergence.** The thrashing guard in
   `cli/nextStepCommand.ts` stops the `runtime_validation ↔ synthesis` spin
   gracefully, but the *why* (revisions churn while content is stable) is
   unfixed — needs reproduction with a seeded `.audit-artifacts/`. Suspects:
   `orchestrator/state.ts` `runtimeReady` vs `runtimeValidation.ts` output;
   revision-vs-content staleness in `orchestrator/staleness.ts`.
3. **Quota/dispatch vision** (memory `quota-dispatch-vision`): per-model
   detection landed (`resolveHostModel`); remaining is on-the-fly adaptation in
   the conversation-first path + heterogeneous multi-agent dispatch.
4. **Two requested features** (memory `audit-code-feature-roadmap`): user-chosen
   lenses; choice of design-review depth.
5. **Release robustness:** make the postinstall wrapper generator normalize
   to LF on write (memory `audit-tools-release-crlf-trap`).
6. The 404 findings' **advisory bulk** (MNT file-length, OBS, redundant TST) is
   optional/intentional — not a backlog. The sharp COR/REL ones were fixed; two
   HIGH findings were verified false positives (see the Progress log below).

Project memory auto-loads the durable context: the quota vision, the
no-back-compat directive, the CLAUDECODE test-env gotcha, the stale-worktree
branch trap, and the release CRLF trap. Verify state with
`git log --oneline shared-v0.5.5..HEAD` and the three published versions.

**Base:** branch fast-forwarded onto `audit-tools/master` @ `1f9a640` (the real
latest — the prior pickup mistakenly read a handoff 4 commits behind, before the
self-audit landed). Build + the two new test files (`io-json-retry`,
`file-inventory-language`) verified green on this base (Windows, Node 26).

## Progress (execution log)

Working in logical/pipeline order (not risk order), building + testing each
unit. Per the "ideal code, no back-compat" directive, deprecated/legacy paths
are removed, not preserved. (Tier A/B/C verdicts below are the original
snapshot; this log records actual outcomes.)

**Phase 1 — correctness point-fixes: DONE.** Four real, fixed; two advisory
false positives:
- ✅ **isLens observability gap** — real. Centralized canonical
  `isLens`/`ALL_LENSES` in `types.ts`; `flowRequeue` + legacy `orchestrator.ts`
  taskBuilder both route through it. Regression test added.
- ✅ **worktree branch leak + swallowed commit failure** (`implement.ts`) — real.
  Atomic `git worktree add -b` with stale-state cleanup; commit gated on
  `git diff --cached --quiet`, real failures fall back + clean up. Regression
  test added.
- ✅ **REL-001 `skip_worker_command`** — real one-sided divergence. The field is
  dead legacy (nothing writes it) → removed entirely from both packages.
- ⊘ **MCP template tool names** — FALSE POSITIVE. opencode namespaces MCP tools
  by server key `auditor`, so `auditor_start_audit` is correct.
- ⊘ **`detectHostActiveSubagentLimit` test fixture** — FALSE POSITIVE. The test
  imports audit-code's single-arg `(env)` wrapper, so the fixture is passed
  correctly and the Codex branch is genuinely exercised.

Suites green throughout Phase 1.

**Phases 2–7 — DONE** (all committed; final suites green: shared 41 ·
audit-code 556 · remediate-code 380):
- ✅ **A4** — root `.gitattributes` enforcing LF (498 tracked files were CRLF; a
  `.sh` hook was CRLF-broken); `ensure` preflight that fails with an actionable
  `npm install` message instead of phantom "missing export" TS errors.
- ✅ **A2** — agent-host providers (claude-code/vscode-task) default to parallel
  dispatch, not serial (kills `wave_size=1`). **+ host model detection**
  (`resolveHostModel`) so per-model quota engages (Claude → 200k context,
  model-keyed state) — first increment toward the per-model/provider quota
  vision; heterogeneous multi-agent dispatch tracked separately.
- ✅ **A3** — `detectRateLimitError` recognizes the host session/usage-limit
  sentinel + clock-time reset → cooldown on the auditor-spawned path; the
  dispatch prompt tells the host to pause-and-resume rather than thrash-redispatch.
- ✅ **A5/A6** — only genuinely stray files count toward `spurious_file_count`
  (canonical `<stem>_<digest>.json` results no longer inflate it); packet prompt
  reinforced to submit-only.
- ✅ **A1** — finalization **thrashing guard**: when loop iterations outrun
  distinct artifact states, stop gracefully (the report is already rendered) and
  surface the cycling obligations, instead of spinning to the 1000-cap crash.
  The deeper root-cause convergence (why runtime_validation↔synthesis ping-pong)
  is a tracked follow-up.
- ◧ **Tier C** — **coverage done** for the real gaps: `runAutoFixExecutor`,
  `withinRoot` path-escape guard, and `worktreeIsolation` helpers (all were
  uncovered). **Refactor:** extracted `reviewPacketSizing.ts` out of
  `reviewPackets.ts` (pure move, verified). The **big file-splits are deferred
  to a focused follow-up** (reviewPackets graph cluster; internalExecutors into
  per-phase modules; remediate `decideNextStep`) — the cuts are clean, but each
  is a large multi-step manual move better done as a dedicated careful pass than
  a session-tail grind. OBS bulk remains deferred.

## How to read the 404 findings

- **The count is inflated by repeated IDs.** A finding ID (e.g. `COR-001`,
  `MNT-001`, `TST-001`) is re-emitted once per file/unit it touches, so `404`
  ≈ a few dozen *distinct* problems fanned across files. Distribution:
  TST 131 · MNT 122 · OBS 65 · COR 28 · OPR 14 · DI 14 · DR 8 · CD 6 ·
  SHD/REL/DA 5 · CFG 1.
- **It's advisory.** At least one HIGH ("entire quota subsystem has zero test
  coverage") is contradicted by shipping tests (`quota-scheduler`,
  `quota-file-lock`, `discovered-limits`, `header-extraction`). Verify each
  before acting.
- **The meta-audit issues (Tier A) are the higher-signal list** — they were
  found by *running* the tool end-to-end, not static inspection, and several
  match standing memory notes.

---

## Tier A — the 6 meta-audit issues (authoritative backlog)

| # | Sev | Issue | Verdict |
|---|---|---|---|
| A1 | HIGH | Finalization oscillation: `runtime_validation_current` ↔ `synthesis_current` ping-pong (~700–900 advance iters), never converges | **FIX — #1** |
| A2 | HIGH | `wave_size=1` from failed model detection → forced serial dispatch (known, has resisted multiple patches) | **FIX — redesign, not re-patch** |
| A3 | HIGH | Host account session-limit invisible to the quota subsystem; a wave dies silently mid-run | **FIX** |
| A4 | MED | `ensure` has no preflight/doctor (cryptic fresh-worktree failures) + regen dirties tree with CRLF | **FIX — early win** |
| A5 | MED | `spurious_file_count` inflates 3→191 across deepening rounds (re-counts prior results) | **FIX — small** |
| A6 | MED | Workers write stray `*-result.json` to repo root | **FIX — small / or ACCEPT** |

**A1 — Finalization oscillation (the headline).** Confirmed non-trivial: the
static `ARTIFACT_DEPENDENCY_MAP` declares `runtime_validation_report.json →
audit-report.md` but **not** the reverse, so this is *not* a declared cycle —
it's a revision-fixpoint that never settles in `staleness.ts` /
`artifactMetadata.ts`. Likely class of bug: the revision computed at *write*
time (marker) ≠ the revision recomputed at *check* time, so an obligation never
clears its own staleness and `decideNextStep` re-picks it. Synthesis renders the
real report *before* the loop dies, so the crash hides a success.
- Entry points: `src/orchestrator/{staleness.ts, artifactMetadata.ts,
  advance.ts, dependencyMap.ts, nextStep.ts}`.
- First step is **diagnostic, not a fix**: instrument the advance loop to log
  `{iteration, obligation, artifact, recordedRev, recomputedRev}` and run one
  `next-step` on a seeded `.audit-artifacts` to capture the exact mismatch.
- Risk: medium — staleness DAG is load-bearing; needs a regression test
  (`tests/staleness.test.mjs` already exists) proving convergence in ≤2 steps.

**A2 — wave_size redesign.** Root cause (from `dispatch-quota.json`):
`model:null`, `source:provider_default`, 32k context → one packet's estimate
(~32k) exceeds the budget → strictly serial. The handoff explicitly says this
"has resisted multiple fixes" — so **do not patch the arithmetic again**;
rethink the chain (host-model detection → resolved_limits → estimated_wave_tokens
→ wave_size), e.g. trust an explicit `session-config.model`, or treat a
low-confidence `provider_default` as "assume large context / parallel-capable"
rather than the pessimistic 32k floor. Pair with the ~60 `large_packet` warnings
(chunker target size vs. resolved budget are unreconciled — `chunking.ts`).

**A3 — host session-limit.** Infra partly exists (`quota/hostLimits.ts` in both
`shared` and `remediate-code`). Wire audit-code's worker path + `merge-and-ingest`
to detect the "session limit · resets <time>" sentinel (0 tokens) and treat the
task as **retryable/paused**, not a normal empty result.

**A4 — `ensure` preflight (recommended early win).** A fresh worktree has no
`node_modules`, so the first command fails with raw `ENOENT` (missing `dist`) or
~16 fake "missing export" TS errors (tsc resolves `@audit-tools/shared` against
the *main* checkout's stale `dist`). **This is the exact trap that derailed the
prior pickup of this very session.** Add a doctor/preflight that detects
missing deps/build/symlink and prints the fix (`npm install` + build-shared-first).
Separately, stop the asset regen from writing CRLF (dirtying the tree every run).
Low risk, contained, high quality-of-life.

**A5 / A6 — hygiene.** A5: scope the "unexpected file" check in
`cmdMergeAndIngest` (`src/cli.ts` ~L692-929) to the *active* run plan, or
archive/move ingested results so prior rounds aren't re-flagged. A6: fix worker
submit-path resolution / prompt so output stays inside the artifacts dir. Both
small; A6 is borderline-ACCEPT since cleanup already deletes the strays.

---

## Tier B — sharp correctness/reliability findings worth fixing (from the 404)

These are the high-signal slice of the static findings: concrete bugs, not
quality opinions. **One confirmed by reading source; the rest are VERIFY-then-fix.**

| ID | Where | What | Verdict |
|---|---|---|---|
| COR-001 | `remediate-code/src/phases/implement.ts:418` | `git branch` before `git worktree add`; branch leaks on partial failure → permanently forces sequential mode for that block | **FIX — confirmed** |
| COR-001 | `implement.ts:444` | worktree-block `git commit` return value ignored → a failed commit reports success with lost changes | **FIX — looks real** |
| COR-001 | `flowRequeue.ts` (+1 more) | `isLens()` guard omits `observability` → throws on a valid lens instead of processing | **VERIFY → FIX (small)** |
| COR-001 | opencode command template | MCP tool names don't match actual server exports | **VERIFY** |
| REL-001 | `usesDeferredWorkerCommand` | deprecated `skip_worker_command` no longer honoured | **VERIFY (may be intentional)** |
| DR-003 | providers/quota across both pkgs | duplicated + drifted, incl. a security-relevant default | **VERIFY residual** — the drift sprint (REFACTOR-HANDOFF) centralized helpers + fixed all 10 known drift bugs; confirm what's left (the provider *classes* are still per-package) |

Fix the confirmed COR-001 branch leak with an atomic `git worktree add -b
<branch> <path>` (creates branch + worktree in one step; nothing to leak) or add
branch cleanup on the `{ ok: false }` path.

---

## Tier C — advisory bulk (strategy, not per-item verdicts)

- **MNT long-file/complexity (122).** Several HIGH ones are the *intended*
  outcome of the completed refactor sprint and should be **ACCEPTED/known**:
  `cli.ts` @1728 (deliberately a thin dispatcher), `cmdRunToCompletion` @~1000.
  **Genuine new candidates** the sprint didn't reach, same pure-move pattern:
  `reviewPackets.ts` (1848), `internalExecutors.ts` (810),
  `decideNextStepInner`/`decideNextStep` (740, remediate). → **OPTIONAL future
  refactor**, not urgent, do only if touching those files anyway.
- **TST coverage (131).** **SELECTIVE.** Real, worth filling: `autoFixExecutor`,
  `waveScheduler`/`dispatch.ts` exported logic, `worktreeIsolation.ts`,
  `withinRoot` path-escape guard — and **TST-001 "detectHostActiveSubagentLimit
  tested with wrong argument"** is a genuine *test correctness* bug (fix the
  fixture). Likely **stale/inaccurate**: "entire quota subsystem zero coverage"
  (tests exist) — verify scope before writing redundant tests.
- **OBS observability (65) + OPR/DI/CD/CFG.** Mostly advisory enhancements;
  **DEFER** unless a specific one blocks debugging. Skim DI (data-integrity) for
  any real correctness overlap with Tier B before dismissing.

---

## Recommended execution sequence

1. **A1 oscillation** — diagnostic instrumentation → root-cause → fix +
   convergence regression test. (Highest value; unblocks clean `complete`.)
2. **Quick-wins batch** (low risk, high confidence, one PR):
   A4 ensure-preflight · A5 spurious_file_count · A6 stray files ·
   COR-001 branch leak · `isLens` observability · the TST-001 wrong-fixture test.
3. **A2 wave_size redesign** (design first — it's resisted patches).
4. **A3 host session-limit** handling (wire the existing `hostLimits` infra).
5. **Tier B verify-then-fix** the remaining COR/REL/DR HIGH findings.
6. **Optional:** new MNT refactor candidates + selective TST coverage.

## Channel: hand-fix vs `/remediate-code`

- **Tier A + Tier B + the TST-001 test bug → hand-fix here.** They need judgment,
  cross-file reasoning, or design — not mechanical application.
- **Tier C selective coverage / OBS bulk → candidate for `/remediate-code`**
  consuming `audit/audit-findings.json` (that's the audit→remediate pipeline).
  But filter first: feeding all 404 (many advisory/stale/intentional) would
  generate low-value churn. Curate a findings subset before dispatching.

## Fix-vs-accept at a glance

- **FIX NOW:** A1; quick-wins batch (A4, A5, A6, COR-001 branch leak, isLens,
  TST-001 fixture).
- **FIX (sequenced):** A2 (redesign), A3; confirmed Tier B correctness bugs.
- **VERIFY first:** COR-001 commit-ignored / MCP-names, REL-001, DR-003 residual,
  questionable TST claims.
- **ACCEPT / known:** `cli.ts`@1728 & `cmdRunToCompletion` length (intended);
  A6 arguably (cleanup handles it).
- **DEFER:** OBS bulk; optional MNT refactors (reviewPackets/internalExecutors/
  decideNextStep); non-overlapping DI/OPR/CD/CFG.
