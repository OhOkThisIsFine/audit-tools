# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

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
  against real code. Worth a scan for siblings of this shape — a local re-implementation is the
  tell.
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
  the floor by ~3s, so the next T4 step is a decision about the completion family as a whole, not
  another single-file split. ⚠ Baseline numbers are under full-suite contention and run ~3× the
  isolated timings (the new wrapper files measure 37-40s alone, 107s in-suite) — compare like with
  like.

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
- Release CI green for v0.39.4, v0.39.5 and v0.39.6. The T4 split shows as a tighter shard spread:
  v0.39.3 was 205/198/151/132, v0.39.6 critical path 245s — slowest shard down from 205s.
- A strict all-cycles `depcruise` (`tsPreCompilationDeps` on) reports zero cycles of any kind across
  542 modules; the tightened `no-circular` rule was red-green validated (reintroduced cycle → exit 1)
  and restored by inverting the edit, never by checkout.
- Loop-core commits attested (staged-tree-bound, agent class): `c38f4511`, `4082c237`, `426c2ba6`,
  and this sprint's `945b4b2f`, `d901d805`, `fd537faf`, `4503c1fc`.

## Immediate next

> **Owner call 2026-08-07, superseding the earlier deferral:** the dogfood deferral is **obsolete** —
> dogfooding can run whenever, the quiet tree is no longer the gate. But **known refactoring goals
> come first, before another audit run.** That is why the pinned dogfood cluster is last here while
> still being the backlog's pinned item.

1. **Dogfood/meta-review 2026-07-30 cluster** (open-bugs, pinned) — live-run-watch properties.
   **This is now unblocked and is the top item**: the owner gated it behind "known refactoring goals
   first", and those are done — the dedup cluster is 10 of 10, the providers twin is closed, and
   nothing is unpublished.
2. **T4 — needs a DECISION, not another split.** See *Live state*: the floor is a four-file
   completion cluster within 7s, so one more single-file split buys ~3s. Worth deciding whether T4
   continues at all at this granularity before spending a lap on it.
   ⚠ The memory-index size chore is **closed, not pending** (owner call, 2026-08-07): the index is
   one line per cluster already, so its size is the file count rather than padding, and it sits well
   under the harness's real 24.4KB read limit. The harness's 17.1KB compaction reminder still fires
   on memory edits — ignore it. Rationale and the re-open condition are in the note at the top of
   `MEMORY.md`. Do not re-add this as a task.

   ⚠ Standing hazard: `session-config.json` at repo root (untracked,
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
