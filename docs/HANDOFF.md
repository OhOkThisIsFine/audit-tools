# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- **The dogfood self-audit COMPLETED 2026-08-08 — `audit-report.md` / `audit-findings.json` are FRESH.**
  **2,241 findings** (4 critical, 92 high, 1,329 medium, 804 low, 12 info) over **200 work blocks**;
  1,264 files audited. Three dispatch waves (382 packets, then 6 deepening / 154 tasks, then 3 / 25),
  every packet accounted for. Run record, the four criticals, and **12 tool findings** are in
  [`reviews/dogfood-run-2026-08-08.md`](reviews/dogfood-run-2026-08-08.md). The friction record
  (9 observations across all three categories) is promoted to `.audit-tools/audit-friction-run.json`,
  which is gitignored — read it there, it is not in git.
  ⚠ **The findings are AUDIT OUTPUT, not a work queue.** Nothing has been triaged or verified; the
  auditor's own severity calibration is a known-weak signal (see the 2026-08-06 entry in open-bugs).
  Grounding says 1,054 grounded / 10 ungrounded, so ~1,177 findings carry no grounding verdict at all.

- **v0.39.9 SHIPPED 2026-08-08.** npm live at 0.39.9, both global bins reinstalled and the deferred
  postinstall run manually (npm skips it on `-g`) — 7 + 6 host integrations deployed, 0 failed; both
  bins report 0.39.9. Release CI run
  [31244546675](https://github.com/OhOkThisIsFine/audit-tools/actions/runs/31244546675) green across
  all 6 jobs, critical path 294s (summed 854s). **Tag and `main` are level — no gap.**
- **v0.39.7 was burned and is deliberately absent** — its gate job failed on five eslint errors and
  the release + tag were deleted (`gh release delete --cleanup-tag`), then forward-bumped. A gap in
  the version sequence is expected, not a missing publish.
- **The analyzer sweep's dedup cluster is COMPLETE — 10 of 10.** Items 6 and 8 landed this lap,
  along with the `providers/index.ts` descriptor twin that item 4 had exposed. What each one
  actually turned out to be — and where the written spec was wrong — is in
  [`reviews/dedup-cluster-2026-08-07b.md`](reviews/dedup-cluster-2026-08-07b.md).
- **"Built in N places" was a floor twice more, not a count.** Item 6a's spec said two branches; the
  family was three (`prepareContractDispatch` builds the same notice pair for the contract pass).
  Item 8's spec named three drivers, one of which (`run-wrapper.mjs`) turned out not to be a driver
  at all, while the real third (`next-step-harness.advancePastDesignReview`) went unmentioned. Grep
  the whole family before sizing any remaining extraction — `extraction-spec-scope-is-a-floor`.
- **Item 8 exposed a test that never called its subject.** `"advancePastDesignReview throws on
  unknown pause kind"` asserted against a hand-copied replica of the walker declared inside the test
  body; the production helper could have been deleted and it would have stayed green. Now driven
  against real code. It is a defect CLASS no gate catches — the sweep for siblings is a backlog
  entry in [`open-bugs.md`](backlog/open-bugs.md), which carries the tell and the remedy.
- **⚠ Offload from a Desktop session is shell-out ONLY, and lane quality varies sharply.** Subagents
  here bypass the relay entirely. `llm-relay dispatch` works, but of three long DeepSeek recon jobs
  two died with `API Error: Server error mid-response` after ~10min and the third took ~25min, while
  the agy lane returned complete reports in minutes. `claude -p` buffers to completion, so a dying
  lane and a healthy one look identical (zero bytes) until the end. Probe small, one bounded item
  per dispatch, and prefer switching lanes over retrying the one that just failed. Both traps are in
  [`durable-traps.md`](backlog/durable-traps.md).
- **A type-only import cycle is now a red build.** All three that existed were broken and
  `no-circular` lost its `viaOnly` exemption, so the cleanup is enforced rather than tracked.
- **T4's floor is no longer a single outlier — it is a CLUSTER, which changes what the next split
  buys.** `audit-code-wrapper-packets.test.ts` was split three ways this lap and the baseline was
  regenerated from the 596-file run. The top of the list is now four completion files within 7s of
  each other: `audit-code-completion-present` 134.9s, `-ingest-dir` 134.5s, `-promote` 131.6s,
  `-force-synthesis` 128.0s, then `linux-cycle-regression` 125.9s. Splitting any ONE of them moves
  the floor by ~3s, which is why the mechanism changed — see *Immediate next* 2.
  ⚠ Baseline numbers are under full-suite contention and run ~3× the isolated timings (the new
  wrapper files measure 37-40s alone, 107s in-suite) — compare like with like.

## Verification state

- **The authoritative full-suite green for the SHIPPED source is release CI run
  [31244546675](https://github.com/OhOkThisIsFine/audit-tools/actions/runs/31244546675)** (v0.39.9 —
  gate + all 4 shards green). Read that, not the local run, as the release signal.
- A LOCAL full suite also covers this source, unlike the last two releases: **592 files passed /
  4 skipped, 7684 passed / 15 skipped, 264.9s**, on a clean committed tree at `f6f99cb3`. The test
  count is identical to the pre-lap run, which is the expected signature of a pure split plus a
  rewritten-in-place test.
- Each landing was additionally verified before its commit: `build` + `check` + `check:tests` +
  `check:lint` + `check:deadcode` + `check:depgraph` green, plus targeted suites — 180 tests across
  the 9 design-review/conceptual suites and 68 in graph-manifest-edges (item 6), 166/2-skipped across
  12 provider suites (providers twin), 65 across the 15 harness-affected suites (item 8), 7 across
  the three new wrapper files (T4).
- **The shard-duration baseline is now CURRENT** — regenerated from this lap's 596-file run.
- **A release now runs the whole `verify:checks` BEFORE it tags** (`scripts/release-and-publish.mjs`,
  `7ebb8976`). It previously ran `npm run check` alone — a typecheck — which is how v0.39.7 got
  tagged with eslint errors; `tsc` cannot see an unused destructured binding. Expect ~2min at the
  pre-tag gate now, and expect a red gate to refuse BEFORE `vX.Y.Z` exists rather than after. The
  vitest suite is unchanged (sharded, in CI). Red-green validated, and
  `tests/audit/release-contract.test.ts` now pins the invocation — it previously pinned the word
  `verify:release` appearing in a COMMENT while the script ran `check`.
- A strict all-cycles `depcruise` (`tsPreCompilationDeps` on) reports zero cycles of any kind across
  542 modules; the tightened `no-circular` rule was red-green validated (reintroduced cycle → exit 1)
  and restored by inverting the edit, never by checkout.
- **No loop-core commit was needed this lap** — nothing landed touched `LOOP_CORE_PATTERNS`, so no
  attestation applies. (The attested set from earlier laps is in git history, not restated here.)

## Immediate next

> **The dogfood gate has CLEARED.** The owner's 2026-08-07 call was that dogfooding could run
> whenever, but **known refactoring goals came first**. Those are now done — dedup cluster 10 of 10,
> providers twin closed, nothing unpublished — so the pinned cluster is no longer held back and
> leads this list.

1. **Decide the fate of `remediation/dispatch-effectiveness-observability` (pushed, 2 commits), then
   repair its two upstream defects.** The observability feature request ran through the contract
   pipeline (3 adversarial laps → judge approved) into implementation. CP-NODE-1 landed the shared
   attribution-contract type surface on that branch;
   <!-- doc-citation-exempt: the module lives on the unmerged remediation branch, not on main -->
   `src/shared/types/attributionContract.ts`; CP-NODE-2/3/4 are halted. Two repairs gate the rest,
   neither fixable by retry: (a) `attempt_key` rests on an admission identity the dispatch layer does
   NOT mint — verified against source, `lease_id` is null on the unmetered lane, `packet_id` repeats
   by design, `newInstanceId` is random; `contentKey`'s `result_content_discriminator` is the existing
   precedent, and the amendment needs a critic/judge lap
   ([[attempt-key-has-no-admission-identity]]). (b) `implementation_dag` carries no per-node file
   scope, so the dispatch boundary refuses CP-NODE-2/3 structurally. Evidence:
   `.audit-tools/remediation/scratch/dispatch-effectiveness-observability/C-024-verification.md`.
   ⚠ Seven frictions from the run are in the run's friction record but **NOT in open-bugs.md** — that
   file is 129.6KB against a 120KB ceiling and the budget gate allows only shrinkage, so landing them
   requires an offsetting condensation.
2. **Triage the 2,241 audit findings — decide the CUT before reading them.** They are unfiltered output.
   Maintainability alone is 1,417 (63%), and the auditor's severity calibration has a standing
   open-bugs entry against it (2026-08-06: 0 of 9 self-audit criticals survived mechanism verification).
   The 4 criticals + 92 high are the only tractable starting set; the four criticals are summarized in
   [`reviews/dogfood-run-2026-08-08.md`](reviews/dogfood-run-2026-08-08.md). Feeding this to
   `/remediate-code` wholesale would be a mistake — verify by MECHANISM first
   ([[verify-delegated-findings-mechanism-not-just-citation]]).
3. **Dogfood/meta-review 2026-07-30 cluster** (open-bugs, pinned) — live-run-watch properties.
   ⬇ Two of its still-live properties were exercised this run: a pause/cooldown DID occur (pool
   exhaustion), and the remedy a refusal names was NOT reachable — the pool surfaced one member's 402
   rather than an aggregate naming the exhausted set.
4. **T4 changes mechanism — attack PER-TEST COST, stop splitting files** (owner call, 2026-08-08).
   The floor is a four-file completion cluster within 7s (see *Live state*), so further single-file
   splits redistribute time rather than lower it. The cost to attack: each completion test runs ~35s
   because it spins a real audit run through real subprocesses, so the target is the shared
   fixture/setup — one home for the cost, which lowers every file at once and keeps working as files
   are added. Re-measure, and only then decide whether anything still needs splitting.
   ⚠ Do not resume the one-file-at-a-time protocol without new numbers; it is not the mechanism
   for a cluster.

### Standing notes — not tasks

⚠ The memory-index size chore is **closed, not pending** (owner call, 2026-08-07): the index is one
line per cluster already, so its size is the file count rather than padding, and it sits well under
the harness's real 24.4KB read limit. The harness's 17.1KB compaction reminder still fires on memory
edits — ignore it. Rationale and the re-open condition are in the note at the top of `MEMORY.md`.
Do not re-add this as a task.

⚠ `session-config.json` at repo root (untracked,
`block_quota: {context_tokens: 200000, reserved_output_tokens: 32000, host_model: claude-opus-5}`)
is load-bearing — recreate if absent.

<!-- BEGIN GENERATED ROADMAP — scripts/shared/generate-handoff-roadmap.mjs — DO NOT EDIT BY HAND -->

> **This list is GENERATED from [`docs/backlog/`](backlog/) — do not hand-edit it.**
> It is the IMMEDIATE NEXT work only, never the full open set. Prefix an entry's bold title with
> `▶` in the backlog file that owns it and it appears here; empty means nothing is
> pinned, which is a statement rather than an omission.
> **Every open item lives in [`docs/backlog/`](backlog/)**, reachable by the seek index in
> [`backlog.md`](backlog.md) — this block is not a second index of it.
> Every line is a POINTER: the backlog entry's own title, verbatim, and a link to the file that
> holds its spec. Nothing here restates a spec, so this list and the backlog cannot drift.
> Regenerate: `node scripts/shared/generate-handoff-roadmap.mjs` (`--check` gates it in
> `verify:checks` and at commit). 1 pinned item(s).

### ▶ Next up — pinned in the backlog

- ▶ Dogfood/meta-review 2026-07-30 cluster — remaining live-run-watch properties. · [`open-bugs.md`](backlog/open-bugs.md)

<!-- END GENERATED ROADMAP -->
