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

- **v0.39.12 SHIPPED 2026-08-09.** npm live at 0.39.12, both global bins reinstalled and the deferred
  postinstall run manually (npm skips it on `-g`) — 7 + 6 host integrations deployed, 0 failed; both
  bins report 0.39.12. Release CI run
  [31321715039](https://github.com/OhOkThisIsFine/audit-tools/actions/runs/31321715039) green across
  all 6 jobs, critical path 274s (summed 819s). **`v0.39.12` tags `b1375ee6`; `main` carries only
  docs-after-the-tag since, so nothing is unpublished.**
  (v0.39.7 is deliberately absent: its gate failed on eslint and the tag was deleted + forward-bumped.)
  ⚠ This one carries a **user-visible CLI behavior change**: `<verb> --help` on an installer verb
  (`ensure`/`install`/`install-host`/`verify-install`) now prints help on BOTH bins instead of
  performing the verb. Two of those previously wrote to the repo and to HOME. Verified against the
  installed global bin, not only in tests.
- **The nightly queue is EMPTY — all four propositions were answered and LANDED 2026-08-09.** The
  owner took the recommended cut on each; `.claude/nightly-decisions.json` carries the answers and
  the landing refs, so none will be raised again. `sol-4` split the record-path probe refusal by
  direction (`56a58330`), which **restores leg 2's escalation channel** — the thing that had been
  costing a hand-carried HANDOFF slot; `sol-1` made the unset-`$TMPDIR`/`$CLAUDE_PROJECT_DIR` trap a
  Bash-tool guard rule and DELETED its durable-traps entry (`0bdb216e`); `sol-2` fixed the whole
  `<verb> --help` class on both shipped bins and removed the shadowed `ensure` (`d2e77ed7`); `sol-3`
  retired the sweep's `gone` verdict and repaired the probe inputs (`b564d36a`).
  ⚠ `sol-2` carries a **user-visible CLI behavior change**: `<verb> --help` on an installer verb now
  prints help instead of installing. Two of those verbs previously wrote to the repo and to HOME.
- **⚠ Offload from a Desktop session is shell-out ONLY** — subagents here bypass the relay entirely —
  **and lane quality varies sharply by job length.** Probe small, one bounded item per dispatch, and
  switch lanes rather than retrying the one that just failed. Both traps, with the evidence, are in
  [`durable-traps.md`](backlog/durable-traps.md).
- **T4's floor is no longer a single outlier — it is a CLUSTER, which changes what the next split
  buys.** `audit-code-wrapper-packets.test.ts` was split three ways this lap and the baseline was
  regenerated from the 596-file run. The top of the list is now four completion files within 7s of
  each other: `audit-code-completion-present` 134.9s, `-ingest-dir` 134.5s, `-promote` 131.6s,
  `-force-synthesis` 128.0s, then `linux-cycle-regression` 125.9s. Splitting any ONE of them moves
  the floor by ~3s, which is why the mechanism changed — see *Immediate next* 4.
  ⚠ Baseline numbers are under full-suite contention and run ~3× the isolated timings (the new
  wrapper files measure 37-40s alone, 107s in-suite) — compare like with like.

## Verification state

- **The authoritative full-suite green for the SHIPPED source is release CI run
  [31321715039](https://github.com/OhOkThisIsFine/audit-tools/actions/runs/31321715039)** (v0.39.12 —
  gate + all 4 shards green). Read that, not the local run, as the release signal. `verify:checks`
  was additionally green locally (exit 0, both packaged smokes) on the clean tree at `b4b785b5`
  before the bump.
- **Every one of this lap's four changes is red-green validated, each restored by INVERTING the edit,
  never by checkout** — nine inversions across the four, and in each the named tests went red and
  only those. Two are worth knowing about:
  - `sol-4`'s auto-close guarantee is STRUCTURAL, not caller-dependent: `record_present` /
    `record_missing` are never `absent`/`appeared`/`holds`, so `resolved` is unreachable for a
    record probe even if a future caller passes the creation flag on the close path. Breaking it
    needs BOTH the default flipped and the state renamed — and doing both also reds the original P8
    test.
  - `sol-2`'s inversion reproduces the bug exactly: with the help check disabled, `install --help`
    wrote six entries into the test sandbox on each bin. Its `-h` case initially stayed green, which
    made it vacuous, so it now carries the same no-work assertion — the installer's own JSON output
    also contains the word "install".
- Gates run green on the staged tree for each commit: `check`, `check:tests`, `check:lint`,
  `check:deadcode`, `check:guard-reach`, `check:gate-enumeration`, the doc-contract subset and the
  backlog budget/index. No commit this lap touches a `LOOP_CORE_PATTERNS` path, so no review
  attestation was required — `.claude/hooks/`, `wrapper/`, `scripts/` and `src/remediate/index.ts`
  are all outside the list.
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
- **One loop-core commit this lap**, `40f632b4` (`src/remediate/steps/contractPipeline.ts`), attested
  with the diagnosis and the red-green evidence. The other landings touch no `LOOP_CORE_PATTERNS`
  path — `src/shared/contentKey.ts` and `src/shared/types/attributionContract.ts` are outside the
  list, which covers `src/shared/{dispatch,engine,quota,rolling}/` and the two step machines.

## Immediate next

> **The dogfood gate has CLEARED.** The owner's 2026-08-07 call was that dogfooding could run
> whenever, but **known refactoring goals came first**. Those are now done — dedup cluster 10 of 10,
> providers twin closed, nothing unpublished — so the pinned cluster is no longer held back and
> leads this list.

1. **Gate `finalized_module_contracts` against its own drafted input.** An unchecked LLM repair
   collapsed the module set 7 → 4 and dropped `effectiveness-render`; every later symptom, including
   the scope-less DAG nodes, is downstream of that. Mechanism, evidence and the refuted alternatives:
   [`reviews/observability-dag-scope-join-2026-08-09.md`](reviews/observability-dag-scope-join-2026-08-09.md)
   (`0b2af308`).
   **Do:** add a cross-artifact gate asserting the finalized module-name set equals the drafted
   `module_contracts` set, wired into the `nextPhase === "critic"` block (`contractPipeline.ts` ~2821),
   which already re-emits `contract_finalization` on error. `validateFinalizedModuleContracts`
   (`src/remediate/validation/contractPipeline.ts:286`) checks shape only and `validateDesignSpecGates`
   never sees the drafted contracts, so neither can be extended in place. Loop-core → failing test
   first, attestation required.
   ⚠ **Do not re-run the DAG to fix this** — that was the old entry's instruction and it would have
   fixed nothing. The run is `status: "complete"`, so `next-step` never re-enters the contract pipeline
   at all. [[backlog-prose-decays-verify-against-head]]
   **Owner calls (2026-08-09):** *verify the scope, don't re-author it* — requiring host-declared
   `output_files` collides with `c60eb73f` and is out. And **fresh run once the gate lands**, not an
   in-place repair: the artifacts are unrecoverable, CP-NODE-1's contract is already on main
   (`14677902`), and the stale `remediation/dispatch-effectiveness-observability` branch + worktree get
   cleaned up with it.
2. **Triage the 2,241 audit findings — the owner's cut is CALIBRATE ON A SAMPLE FIRST** (decided
   2026-08-09). Mechanism-verify a stratified sample across severities, then choose the cut from
   measured precision rather than the auditor's own severity ranking, which is the signal a standing
   open-bugs entry says is broken (2026-08-06: 0 of 9 self-audit criticals survived mechanism
   verification). Maintainability alone is 1,417 of them (63%). The four criticals are summarized in
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
5. **Use the escalation channel `sol-4` just restored — the four questions it was blocking are still
   unasked.** They are listed in
   [`P18-leg2-escalations-are-structurally-unwritable/PROPOSAL.md`](../.audit-tools/nightly/proposals/P18-leg2-escalations-are-structurally-unwritable/PROPOSAL.md)
   (read [`SHIPPED-2026-08-09.md`](../.audit-tools/nightly/proposals/SHIPPED-2026-08-09.md) first —
   P15–P18 all landed, so their proposals' present tense is stale):
   the retired `~/.claude/llm-call.mjs` described as live in nine backlog passages, `open-bugs#de319d16`
   and `#0487b95c` (both close-or-keep calls), and the run's wider `already_shipped_or_stale` set. Leg 2
   can now write them as `auto_close: false` items, so the next nightly run should surface them itself
   rather than needing a hand-carried slot.
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
