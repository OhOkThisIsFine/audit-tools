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

- **v0.39.10 SHIPPED 2026-08-08.** npm live at 0.39.10, both global bins reinstalled and the deferred
  postinstall run manually (npm skips it on `-g`) — 7 + 6 host integrations deployed, 0 failed; both
  bins report 0.39.10. Release CI run
  [31297966782](https://github.com/OhOkThisIsFine/audit-tools/actions/runs/31297966782) green across
  all 6 jobs, critical path 246s (summed 850s). **Tag and `main` are level at `148c1734` — no gap.**
  (v0.39.7 is deliberately absent: its gate failed on eslint and the tag was deleted + forward-bumped.)
- **The nightly queue holds FOUR unanswered propositions** (`7a0bb2da`, 2026-08-09) — `sol-1` a
  Bash-tool guard rule for env vars unset in that shell, `sol-2` both shipped bins running the
  installer on `<verb> --help`, `sol-3` the leg-2 sweep's `gone` verdict being wrong every time it
  fires, `sol-4` leg 2 having no writable escalation channel since 2026-08-06. Each carries options
  and a full proposal under `.audit-tools/nightly/proposals/`; answer by ticking a box in
  [`nightly-inbox.md`](nightly-inbox.md), then `npm run nightly:ingest`.
- **The owner's three earlier answers are APPLIED and recorded DONE** (`af37bbad`). `docs-1`:
  CLAUDE.md now states Node 22+, matching `engines >=22`. `sol-1`: the shipped
  <!-- doc-citation-exempt: naming the file this lap deleted is the point of the sentence -->
  `examples/catalog/sources-declared.json` is DELETED rather than re-pinned — its three model values
  named llm-relay pools retired at v0.15.4, so the example the README told operators to copy failed
  every dispatch. `examples/README.md` now documents the shape in prose with no runnable values.
  `sol-2`: `triage-backlog.mjs` no longer treats `--help` as its output filename.
  ⚠ **The sol-1 sweep was wider than the item stated** — a fourth dead-name copy sat in
  `examples/auditor-descriptor/self-with-sources.json`, named nowhere in the item. Record channels
  (`docs/reviews/`, `.audit-tools/`, the decisions ledger) are deliberately untouched.
- **Record the constitutional-doc override AFTER staging the complete set, never before.** It binds
  to an exact staged-tree hash and names only the constitutional docs in *that* tree, so attesting
  against a partial stage both invalidates on the next `git add` and can under-cover the real commit.
  [[constitutional-override-binds-to-final-staged-tree]]
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
  [31297966782](https://github.com/OhOkThisIsFine/audit-tools/actions/runs/31297966782)** (v0.39.10 —
  gate + all 4 shards green). Read that, not the local run, as the release signal.
- The pre-release lap was additionally verified locally on the clean committed tree at `af37bbad`:
  the whole `verify:checks` green (exit 0, including `pack:smoke` and both packaged smokes), plus
  `ci` and `audit-code-test-suite` green on that commit before the bump. Targeted suites: 55 tests
  across the three affected suites (`examples-session-config`, `auditor-sources`,
  `triage-lane-health`).
- **The arg guard is red-green validated both ways** — no junk files under a flag, and a flag-shaped
  `argv[2]` no longer exits an *importer*. That second half matters: `triage-lane-health.test.ts`
  imports the module and its stated invariant is that importing must not start a sweep, so an
  unconditional `process.exit` in the guard would have killed the test worker. Both guards are bound
  to a single-sourced `IS_CLI`.
- **The shard-duration baseline is still CURRENT** — regenerated from the 596-file run one lap ago;
  nothing this lap changed test counts materially.
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
5. **Decide what happens to the passages describing the RETIRED `~/.claude/llm-call.mjs` as live.**
   The 2026-08-08 nightly recorded this under "could not cover" because its writer refuses a premise
   probe aimed at `docs/backlog/`, so it has no channel and needs an answer rather than a sweep. The
   helper was retired 2026-07-28 and is confirmed absent from disk; six passages in
   [`durable-traps.md`](backlog/durable-traps.md) (`:96`, `:135`, `:153`, `:155`, `:207`, `:221`) and
   three in [`open-bugs.md`](backlog/open-bugs.md) (`:325`, `:841`, `:846`) still describe its
   behaviour as current. The nightly's own note says four and cites older line numbers — it drifted,
   so re-grep rather than trusting either list. The traps around the dead helper still carry live
   lessons, which is why deleting them wholesale is a judgment call and not a reference fix.
   ⬇ The refusal that pushed this item here is now itself a raised decision (nightly `sol-4`,
   2026-08-09): it blocks three other backlog questions too, and leg 2 has produced zero escalations
   since it landed. Answering `sol-4` gives this item its proper channel back.
   ⚠ `open-bugs.md` is over the 120,000-byte ceiling — grandfathered, so the budget gate accepts only
   SHRINKAGE there. Any edit to that file must come out net-negative.

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
