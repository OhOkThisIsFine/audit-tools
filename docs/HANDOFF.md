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

- **v0.39.15 SHIPPED 2026-08-09 — carries the extracted-plan recovery fix (`d7146254`) and the
  provider-identity removal from sizing (`fafca0fb`).** npm live at 0.39.15, both global bins
  reinstalled and the deferred postinstall run manually (npm skips it on `-g`) — 6 host integrations
  deployed, 0 failed; both bins report 0.39.15. Release CI run
  [31353302415](https://github.com/OhOkThisIsFine/audit-tools/actions/runs/31353302415) green across
  all 6 jobs, critical path 241s (summed 824s). **`v0.39.15` tags `5dc2ace0`; nothing is unpublished.**
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
- **⚠ Offload from a Desktop session is shell-out ONLY** — subagents here bypass the proxy entirely —
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
  ✅ **The four dead declared sources are GONE (2026-08-09)** — they lived in
  `~/.audit-code/sources-declared.json` (not the repo, and not `~/.audit-tools/`, which is where the
  previous lap looked and gave up). They pointed at the retired proxy's port, failed the liveness probe
  on every invocation, and have been removed; `next-step` now runs with zero source warnings. The file
  is now an empty `sources` list, so **there is no declared offload lane** — dispatch is host-only.
  ⚠ Do NOT declare a replacement: the owner directive in *Immediate next* 1 removes routing from
  audit-tools altogether, so an empty declaration is the intended end state, not a gap to fill.
- **T4's floor is no longer a single outlier — it is a CLUSTER, which changes what the next split
  buys.** `audit-code-wrapper-packets.test.ts` was split three ways this lap and the baseline was
  regenerated from the 596-file run. The top of the list is now four completion files within 7s of
  each other: `audit-code-completion-present` 134.9s, `-ingest-dir` 134.5s, `-promote` 131.6s,
  `-force-synthesis` 128.0s, then `linux-cycle-regression` 125.9s. Splitting any ONE of them moves
  the floor by ~3s, which is why the mechanism changed — see *Immediate next* 5.
  ⚠ Baseline numbers are under full-suite contention and run ~3× the isolated timings (the new
  wrapper files measure 37-40s alone, 107s in-suite) — compare like with like.

## Verification state

- **The authoritative full-suite green for the SHIPPED source is release CI run
  [31348958340](https://github.com/OhOkThisIsFine/audit-tools/actions/runs/31348958340)** (v0.39.14 —
  gate + all 4 shards green). Read that, not the local run, as the release signal. The full suite was
  additionally green locally on the final source: **596 files passed, 4 skipped, 0 failed** (274s).
- **This lap's two commits are each full-suite green and loop-core-attested.** `d7146254` (staged
  tree `3217e56c`) and `fafca0fb` (staged tree `872afc69`), both verdict clear, attester class
  `agent`. Local full suite on the final source: **597 files passed, 4 skipped, 0 failed** (7757
  tests) — run TWICE, deliberately; see the flake note below.
- **Both are red-green validated by INVERTING the production edit, never by checkout.** `d7146254`:
  re-running `applyPlanPipeline` inside the narrowed try turns the new test red while the three guard
  tests stay green, so they fail independently. `fafca0fb`: making the `provider_default` rung return
  a different pair turns the strengthened fold check red and names the failing case and provider.
- ⚠ **An intervening full run had FOUR `audit-code-completion-*` failures that were a flake.** They
  passed alone and did not reproduce on a re-run of the identical tree, and no mechanism connects the
  change to them. They are NOT in the flake baseline, so the signature is recorded in
  [`durable-traps.md`](backlog/durable-traps.md) — the bar before calling that cluster a regression is
  two greens plus a mechanism argument, not a single alone-pass.
- S1 (`100b9117`) was red-green validated the same way. ⚠ Its attestation had to be written TWICE:
  the pre-commit gate rejected the first because regenerating the backlog seek index changed the
  staged tree afterwards. Stage *everything* — including generated indexes — then attest, and make
  the attest call and the commit call SEPARATE tool calls.
- ⚠ **`LOOP_CORE_PATTERNS` is wider than this document previously claimed, and the error was
  load-bearing.** It is not just `src/shared/{dispatch,engine,quota,rolling}/` plus the two step
  machines: `src/audit/cli/dispatch.ts` is the FIRST entry, and `src/audit/cli/dispatch/`,
  `src/audit/orchestrator/`, `src/audit/cli/{dispatchAttempted,mergeAndIngestCommand,ownerTokens,
  rollingAuditDispatch}.ts` and `src/remediate/{riskSignal.ts,steps/…}` are all in it. Read
  `src/shared/loopCorePaths.ts`, never a restatement — the stale summary here is what led this lap's
  first plan to budget the audit dispatch commit as attestation-free.
- **The shard-duration baseline is still CURRENT** — the 596-file count is unchanged by this lap's
  single added test file.

## Immediate next

1. **REMOVE the sizing window — it gates item 2.** The routing-removal directive, cut (d) and all six
   owner decisions live in `CLAUDE.md` and
   [`forward-tracks.md`](backlog/forward-tracks.md); the verified plan is
   [`routing-removal-separation-plan-2026-08-09.md`](reviews/routing-removal-separation-plan-2026-08-09.md),
   **corrected by** [`s2-sizing-window-design-check-2026-08-09.md`](reviews/s2-sizing-window-design-check-2026-08-09.md).
   Read both before touching sizing; do not re-derive them, and do not implement the plan's S2 — see
   *"ANSWERED 2026-08-09"* below for why the S-sequence is superseded.

   **The next commit** deletes `resolvePlanContextBudget`, `resolveCurrentWorkPartitionRuntime` and
   `resolveSizingWindowTokens`, plus the budget splitters they feed, and stops `block_quota` /
   `quota.*` being sizing inputs. It is a removal, not a re-sourcing.
   ✅ **Scope is settled, nothing open** — grouping survives, so `mergeBlocksSharingFiles` and the
   block concept STAY. The shape and its one consequence are stated once, below.
   Loop-core: staged-tree review attestation on every commit, full suite before each one.
   ⚠ **SIX owner decisions are recorded in the plan's *Owner decisions* section — read them there,
   not from a summary.** The sharpest is that **quota goes ENTIRELY** (the verb, the nine sources, the
   learned `tokens_per_pct` slope, cooldowns, RPM/TPM, reservations), and decision 6 takes the
   declared sizing window with it.
2. **THEN resume the `dispatch-effectiveness-observability` run — the DECOMPOSITION WAS RE-CUT (owner
   call, 2026-08-09) and it is now at `module_contract_drafting`.** Clean phase boundary: run
   `remediate-code next-step` from the repo root and author the per-module shards it asks for (one per
   module, 8 modules).
   ⚠ **Do not author those shards before item 1 is settled.** This run's design of record resolves its
   attribution triple from `CapacityPool.{providerName,hostModel,rank}` — pool machinery the cut
   DELETES. Authoring now risks encoding a layer that is being removed.
   ⚠ **DECIDED 2026-08-09 — the provider axis is DROPPED; re-scope the run to model × lens.**
   `src/shared/types/attributionContract.ts` — this run's declared INPUT — imports `PROVIDER_NAMES`
   (`:9-11`) and validates `AttributionTriple.provider` against it (`:26-34`), so cut (c) stops it
   compiling; and with no adapter and no provider concept the axis is unvalidatable, so `deriveAggregates`'
   provider→model→lens indexing carries no information. The run answers *which model*, never *which
   backend* — the accepted cost. **The 8-module set must be re-authored against the reduced triple
   before the shards are written**, since three of its modules name attribution capture and
   projection directly.
   **Why the re-cut:** round 3 rejected the contract on CDC-T1/T2, and source verification showed the
   repair was not authorable at all — every candidate landed one file short and inverted the phase cut,
   because **the old 7 modules were drawn over the attribution contract's vocabulary rather than over
   the codebase's real seams**. `file_scope` lives in the decomposition, so no rewrite of
   `finalized_module_contracts` could fix it. The full evidence — including two refuted candidate
   designs, an empirically-demonstrated worker-forgery surface, and the design of record (C) — is in
   [`reviews/observability-contract-round3-source-verification-2026-08-09.md`](reviews/observability-contract-round3-source-verification-2026-08-09.md).
   **Read that before authoring the shards; the new decomposition's `responsibilities` fields already
   encode its conclusions and every load-bearing `path:line` in them was verified at HEAD.**
   **The design of record, in one line each:** carry attribution on the **`AuditResult`**, never the
   `Finding` (exact cardinality, durable idempotent ledger persistence, and `token_usage` is the exact
   precedent — the worker cannot know it); project attempt rows from the ledger rather than a live
   sink; carry per-attempt provenance through merge as an **object-identity side map** so absorption is
   a set union and no `FindingSchema` change is needed at all; and mark attribution explicitly
   **unavailable**, never `"unknown"`, where the contract pipeline's DAG re-derivation has destroyed
   the key.
   ⚠ **The 8-module set is** `attempt-attribution-capture`, `audit-result-attribution-field`,
   `attempt-row-projection`, `dedup-attempt-provenance`, `verdict-audit-ingest`, `attribution-artifact`,
   `verdict-remediate-gates`, `effectiveness-render`. Assert that list before and after any repair —
   regeneration is what collapsed 7 modules to 4 on the previous attempt (now gated by INV-CO-13).
   ⚠ The superseded artifacts (old decomposition, seam report, finalized contracts, critique, phase
   cut, repair-state, and the 7 stale drafting shards) are archived under
   `.audit-tools/remediation/intake/contract/history/`, not deleted. `goal_spec` and `context_bundle`
   were kept and are unchanged.
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
3. **Triage the 2,241 audit findings — the owner's cut is CALIBRATE ON A SAMPLE FIRST** (decided
   2026-08-09). Mechanism-verify a stratified sample across severities, then choose the cut from
   measured precision rather than the auditor's own severity ranking, which is the signal a standing
   open-bugs entry says is broken (2026-08-06: 0 of 9 self-audit criticals survived mechanism
   verification). Maintainability alone is 1,417 of them (63%). The four criticals are summarized in
   [`reviews/dogfood-run-2026-08-08.md`](reviews/dogfood-run-2026-08-08.md). Feeding this to
   `/remediate-code` wholesale would be a mistake — verify by MECHANISM first
   ([[verify-delegated-findings-mechanism-not-just-citation]]).
4. **Dogfood/meta-review 2026-07-30 cluster** (open-bugs, pinned) — live-run-watch properties.
   ⬇ Two of its still-live properties were exercised by the **2026-08-08 dogfood audit** (not the
   observability run in item 1): a pause/cooldown DID occur (pool exhaustion), and the remedy a refusal
   names was NOT reachable — the pool surfaced one member's 402 rather than an aggregate naming the
   exhausted set.
5. **T4 changes mechanism — attack PER-TEST COST, stop splitting files** (owner call, 2026-08-08).
   The floor is a four-file completion cluster within 7s (see *Live state*), so further single-file
   splits redistribute time rather than lower it. The cost to attack: each completion test runs ~35s
   because it spins a real audit run through real subprocesses, so the target is the shared
   fixture/setup — one home for the cost, which lowers every file at once and keeps working as files
   are added. Re-measure, and only then decide whether anything still needs splitting.
   ⚠ Do not resume the one-file-at-a-time protocol without new numbers; it is not the mechanism
   for a cluster.
6. **Use the escalation channel `sol-4` just restored — the four questions it was blocking are still
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

## ⚠ ANSWERED 2026-08-09 — the declared sizing window goes too; S2 is superseded

Three questions were put to the owner. The first was **rejected at the premise**, and that dissolves
the other two — both were marked "[No preference]", consistent with being moot.

> *"This question seems to demonstrate deep confusion about the point of this refactoring. The
> audit-tools should not be involved in dispatching, routing, or transport."*

The question offered three sources for the single declared sizing window — `block_quota`,
model-name-keyed `quota.models[<name>]`, the persisted handshake. **All three are config describing a
backend's context and output caps, i.e. transport configuration.** This is exactly the escape clause
the separation plan's *Owner decisions* 2 wrote down: *"If the intent is that even this must go, the
tool cannot partition at all and packet sizing becomes the host's job too."* It fired.

**The shape now of record** (plan's *Owner decisions* 6, put back to the owner as an explicit
either/or and **confirmed**): the tool partitions on **content coherence** and reports a **token
estimate**, and never partitions to fit a backend's window. Work blocks survive — batching into
logical units is a product conviction — but "reasonable size" stops meaning "fits model X". The host
bundles for the backend it chose, because only the host knows what that is.

**So the S-sequence is superseded, and the next lap is a REMOVAL, not S2's rewrite:**
`resolvePlanContextBudget`, `resolveCurrentWorkPartitionRuntime` and `resolveSizingWindowTokens` go,
with the splitters they feed; `block_quota` / `quota.*` stop being sizing inputs. S1 was a waypoint,
not the endpoint. The roster max and the safety-margin divergence are moot, not deferred.

⚠ **The cost, stated so it is not discovered later:** the tool can no longer promise a unit of work
fits anywhere. `work_blocks` in `audit-findings.json` stops being a fit claim and becomes a coherence
grouping plus an estimate — any consumer reading it as "this fits in one context" must be re-pointed.

⚠ This lap's two landed commits are unaffected and stay: removing provider identity from sizing and
narrowing the extracted-plan recovery are both on the path to the smaller endpoint, not off it.

### Standing notes — not tasks

⚠ The memory-index size chore was **RE-OPENED by the owner on 2026-08-09** — this note previously
said "closed (owner call, 2026-08-07)" and was stale by two days. `MEMORY.md`'s own header is the
current authority: the index is AT the 24.4KB read limit, and the instruction is to **merge closed
sagas and cut obsolete memories**, never a mechanical line-trim (tried, failed). It stands at 23.6KB.
Two gates on deleting a file: repo docs cite memories by name (`check:memory-citations` fails on a
dangling one), and memories cite each other as `[[name]]`, which that gate does NOT check. The
harness's 17.1KB compaction reminder is a separate thing and still fires on every memory edit —
ignore that one.

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
