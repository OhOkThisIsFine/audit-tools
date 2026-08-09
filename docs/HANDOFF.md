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

- **v0.39.13 SHIPPED 2026-08-09 — carries the INV-CO-13 module-set gate (`80b3be6a`).** npm live at
  0.39.13, both global bins reinstalled and the deferred postinstall run manually (npm skips it on
  `-g`) — 6 host integrations deployed, 0 failed; both bins report 0.39.13. Release CI run
  [31331291177](https://github.com/OhOkThisIsFine/audit-tools/actions/runs/31331291177) green across
  all 6 jobs, critical path 286s (summed 830s). **`v0.39.13` tags `f2a2e9c2`; `main` carries only
  docs-after-the-tag since, so nothing is unpublished.**
  (v0.39.7 is deliberately absent: its gate failed on eslint and the tag was deleted + forward-bumped.)
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
  ⚠ **Subagent offload went LIVE under this lap (2026-08-09)** — `app/.env` gained
  `FREELLMAPI_ANTHROPIC_PASSTHROUGH=subagent-offload` and the router restarted mid-session. The
  credential you send picks the lane; the global `CLAUDE.md` holds the table. For a window right after
  that restart, `POST /v1/messages` with the router key forwarded UPSTREAM and 401'd with an
  Anthropic-shaped `request_id`; **re-probed 15 min later it worked, so that was transient — do not
  treat it as a permanent surface property.** Triage by error shape (Anthropic `request_id` = delegated
  upstream; `Invalid API key` with no id = the router; `All models exhausted` = pool). Those traps,
  plus `finish_reason: max_tokens` and listed-but-unreachable models, are in
  [`durable-traps.md`](backlog/durable-traps.md).
  ⚠ **The declared offload lane is DEAD right now**, which matters for dispatch in the resumed run:
  every `remediate-code next-step` reports four unresolved `relay-*` sources at `127.0.0.1:8791` — the
  retired proxy's port. Probed 2026-08-09: 8791 answers nothing, while freellmapi (3001) and headroom
  (8787) both respond. Plan dispatch as host-only until that is repointed.
- **T4's floor is no longer a single outlier — it is a CLUSTER, which changes what the next split
  buys.** `audit-code-wrapper-packets.test.ts` was split three ways this lap and the baseline was
  regenerated from the 596-file run. The top of the list is now four completion files within 7s of
  each other: `audit-code-completion-present` 134.9s, `-ingest-dir` 134.5s, `-promote` 131.6s,
  `-force-synthesis` 128.0s, then `linux-cycle-regression` 125.9s. Splitting any ONE of them moves
  the floor by ~3s, which is why the mechanism changed — see *Immediate next* 4.
  ⚠ Baseline numbers are under full-suite contention and run ~3× the isolated timings (the new
  wrapper files measure 37-40s alone, 107s in-suite) — compare like with like.

## Verification state

- **This lap changed NO source — only run artifacts under `.audit-tools/` (gitignored) and docs.**
  `npm run build` and `npm run check` both exit 0 on the final tree. No suite run was warranted and
  none is claimed. The shipped-source signal below is unchanged.
- Every file attribution in the decomposition was verified by reading the named symbol off disk before
  it was scoped, and all 50 `path:line` citations the drafted shards made were mechanically resolved
  against the tree (0 unresolved). The critique's two highest-stakes claims — the phase inversion and
  the cross-phase artifact dependency — were each confirmed against `phase_cut.json` and the contract
  payload rather than accepted from the reviewing lane.

- **The authoritative full-suite green for the SHIPPED source is release CI run
  [31331291177](https://github.com/OhOkThisIsFine/audit-tools/actions/runs/31331291177)** (v0.39.13 —
  gate + all 4 shards green). Read that, not the local run, as the release signal. `verify:checks`
  was additionally green locally (exit 0, both packaged smokes) on the clean tree before the bump.
- **This lap's one change (`80b3be6a`, the INV-CO-13 gate) is red-green validated by INVERTING the
  gate, never by checkout** — twice, and in each the named tests went red and only those. Worth
  knowing:
  - The placement is proven by execution, not argument. With the gate absent, the step emitted
    immediately after a finalized rewrite is literally `# Conceptual Design Critique` — which is why
    the `nextPhase === "critic"` home the plan named would have been five phases too late.
  - The membership check and the multiplicity (duplicate-name) check were inverted **separately**, so
    neither rides on the other's red. 5 tests red for the first, 1 for the second.
  - The three tolerance tests correctly stay GREEN under inversion (they assert *no* issues), so the
    red set is the refusal behaviour alone.
- `verify:checks` exit 0 on the final tree, including both packaged smokes; `npm run build` and
  `npm run check` clean; `tests/remediate` + `tests/shared` = **4912 passed, 0 failed** (332 files).
  ⚠ `tests/audit` was NOT run locally this lap — the change is remediate-only, but CI's sharded run
  is the signal for it.
- `80b3be6a` touches `src/remediate/steps/contractPipeline.ts`, a `LOOP_CORE_PATTERNS` path, so it
  carries a review attestation (staged tree `7fed2c11`, verdict clear, attester class `agent`).
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
- `LOOP_CORE_PATTERNS` covers `src/shared/{dispatch,engine,quota,rolling}/` and the two step
  machines; `.claude/hooks/`, `wrapper/`, `scripts/`, `src/remediate/index.ts` and
  `src/remediate/validation/` are all OUTSIDE it. That is why this lap's validator changes needed no
  attestation and its one `steps/` change did.

## Immediate next

1. **Resume the `dispatch-effectiveness-observability` run — it is IN FLIGHT and parked at the ROUND-3
   REPAIR of `finalized_module_contracts`.** Clean phase boundary, not a breakage: run
   `remediate-code next-step` from the repo root and author the artifact it asks for.
   **The two blocking items to resolve are already stated and each was verified against source:**
   - **CDC-T1** — `INV-ORIGIN-STAMP-TOTAL` requires stamping an originating `attempt_ref` + triple onto
     each finding, but `FindingSchema` (`src/shared/types/finding.ts:102`, re-exported at
     `src/audit/types.ts:186`) defines no such fields and `WorkerFindingSchema`
     (`src/audit/contracts/workerSchemas.ts:40`) adds none. **No module scopes
     `src/shared/types/finding.ts`**, so as written the stamp is unimplementable. Decide: widen a
     module's `file_scope` to include the Finding type, or re-home the join.
   - **CDC-T2** — that repair justified itself by analogy to "the way identity/idempotency keys are
     already stamped", but that precedent is on the RUN LEDGER
     (`src/audit/orchestrator/ledger.ts:9-21`), not on findings. There is no existing
     worker-unauthorable stamp on a `Finding` to copy, so the analogy cannot carry the decision.
   ⚠ **Repair by TARGETED EDIT of the payload, never regeneration** — regeneration is the exact path
   that collapsed 7 modules to 4 last time. Assert the module-name list before and after; the two
   repairs this lap did that and INV-CO-13 stayed green each time.
   **Where the design state lives — read it there, it is not restated here.** Each module's
   `seam_adjustments` in `finalized_module_contracts.json` records verbatim what every seam and repair
   decided and why; `phase_cut.json` carries the ordering (`has_cycle: false`, 5 phases). The 7-module
   set is `attribution-triple-resolution`, `attempt-row-emission`, `verdict-dedup-shared`,
   `verdict-audit-ingest`, `verdict-remediate-gates`, `attribution-artifact`, `effectiveness-render`.
   Durable lessons from the rounds are in project memory
   ([[inverted-neighbor-edges-manufacture-a-cycle]]).
   **State:** the old completed run's DIRECTORY was archived to
   `.audit-tools/remediation.archived-observability-2026-08-08/` and a fresh run bootstrapped in its
   place. Intake, intent confirmation, `goal_spec` and `context_bundle` are all written and validated
   `status: "ok"`; `goal_id` is `dispatch-effectiveness-observability`.
   ⚠ **The `context_bundle` carries three file attributions that are WRONG at HEAD.** All three were
   corrected in the decomposition, with the correction stated in the module's own responsibilities —
   do not "restore" them: `src/remediate/state/itemStatus.ts` sets no status (it is the vocabulary;
   the setter is `acceptReconcile.ts:171`); `src/audit/cli/dispatch/packetFilter.ts` does not
   determine `coverage_mismatch` (`src/audit/validation/auditResults.ts` does); the dependency DAG is
   in `src/audit/orchestrator/dependencyMap.ts`, not `src/audit/io/artifacts.ts`.
   ⚠ The promoted `.audit-tools/remediation-report.md` / `-outcomes.json` are back at their canonical
   paths and unchanged — they are **git-tracked**, so moving them aside was a tracked-file deletion of
   ~56k lines and was reverted. Leave them alone; this run overwrites them on completion, which is the
   intended lifecycle. Mechanism in [`durable-traps.md`](backlog/durable-traps.md).
   The confirmed checkpoint carries `must_not_touch` guards on `audit-findings.json` /
   `audit-report.md` / the archive.
   ⚠ **The contract is INPUT, not output.** `src/shared/types/attributionContract.ts` is already on
   main (`14677902`) — `AttributionTriple`, `DispatchAttemptRow`, `FindingVerdictRow`, `classifyDetail`,
   `deriveAggregates`, and the four enums that fix scope (`DRAWS`, `VERDICT_STAGES`, `VERDICT_DETAILS`,
   `STAGE_OWNERSHIP`). Verified by grep: its only consumers are the shared barrel and its own test. The
   run is the WIRING.
   ⚠ **Keep BOTH render sites in scope** — `src/audit/reporting/synthesis.ts` and
   `src/remediate/phases/close.ts` are exactly what the previous attempt lost when its module set
   collapsed 7 → 4. That collapse is now gated (INV-CO-13, shipped in v0.39.13), which is what unblocked
   this run.
   ⚠ **The two stale branches stay until THIS run completes — owner's call, 2026-08-09; decided, do
   not re-raise.** The earlier plan assumed they were redundant; they are not. They carry commits that
   are *not* on main: `remediation/dispatch-effectiveness-observability` has 2 (`6fcff985`, the old
   run's report, which exists nowhere else, and `d5ef739b`), and `remediate-CP-BLOCK-CP-NODE-1-…` has 1
   (`28ab1175`). CP-NODE-1's *content* re-landed as `14677902`, but `6fcff985` is unique, so deleting
   now would be a real loss. **Delete both once the observability run in this item lands** — that is
   the trigger, and it is the only remaining action on them.
2. **Triage the 2,241 audit findings — the owner's cut is CALIBRATE ON A SAMPLE FIRST** (decided
   2026-08-09). Mechanism-verify a stratified sample across severities, then choose the cut from
   measured precision rather than the auditor's own severity ranking, which is the signal a standing
   open-bugs entry says is broken (2026-08-06: 0 of 9 self-audit criticals survived mechanism
   verification). Maintainability alone is 1,417 of them (63%). The four criticals are summarized in
   [`reviews/dogfood-run-2026-08-08.md`](reviews/dogfood-run-2026-08-08.md). Feeding this to
   `/remediate-code` wholesale would be a mistake — verify by MECHANISM first
   ([[verify-delegated-findings-mechanism-not-just-citation]]).
3. **Dogfood/meta-review 2026-07-30 cluster** (open-bugs, pinned) — live-run-watch properties.
   ⬇ Two of its still-live properties were exercised by the **2026-08-08 dogfood audit** (not the
   observability run in item 1): a pause/cooldown DID occur (pool exhaustion), and the remedy a refusal
   names was NOT reachable — the pool surfaced one member's 402 rather than an aggregate naming the
   exhausted set.
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
