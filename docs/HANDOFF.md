# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- **v0.39.8 SHIPPED 2026-08-07.** npm live at 0.39.8, both global bins reinstalled + postinstall run
  manually (npm defers it on `-g`), both report 0.39.8. Release CI green, critical path 252s.
  ⚠ **`main` is 2 commits AHEAD of the `v0.39.8` tag** — `b2111cbc` and `2468825a`, touching only
  `.claude/skills/ship/SKILL.md` and this file. Docs/skill only, no `src/` delta, so the published
  artifact matches the shipped source; do not read the gap as an unpublished code change.
- **v0.39.7 was burned and is deliberately absent** — its gate job failed on five eslint errors and
  the release + tag were deleted (`gh release delete --cleanup-tag`), then forward-bumped. A gap in
  the version sequence is expected, not a missing publish.
- **The analyzer sweep's dedup cluster is 8 of 10 done.** Item 4 (rolling-dispatch prep head) and
  the sidecar-naming defect it exposed both landed 2026-08-07. Items 6 and 8 remain, each with a
  verified diff-ready spec in
  [`reviews/dedup-cluster-2026-08-07b.md`](reviews/dedup-cluster-2026-08-07b.md) — which also
  records the cases where the offload lane's proposal was WRONG and what verification found
  instead. Read it before re-deriving either.
- **A spec's "built in N places" proved to be a floor, not a count.** The sidecar item said the name
  was built in TWO places; the family was six filenames in TEN places across five modules, with
  three independent writer/reader rebuild pairs. Grep the whole family before sizing the remaining
  items. Recorded in memory as `extraction-spec-scope-is-a-floor`.
- **⚠ Offload was DEGRADED this session and may still be.** This is a Desktop session, so it
  bypasses the proxy chain entirely (`ANTHROPIC_BASE_URL=https://api.anthropic.com`; headroom shows
  zero Claude requests against 2325 Codex). Shelling out via `llm-relay dispatch` DOES work and was
  used — but `pool/high` stalled ~12min with no output and the second DeepSeek dispatch never
  returned, while the first had worked fine. The owner was mid-update on the llm-relay package.
  **Probe a lane with a small task before committing bulk work to it.**
- **A type-only import cycle is now a red build.** All three that existed were broken and
  `no-circular` lost its `viaOnly` exemption, so the cleanup is enforced rather than tracked.
- **The T4 single-file floor is now `audit-code-wrapper-packets.test.ts` (198.5s)**, after
  `audit-code-completion.test.ts` (~335s) was split five ways over
  `tests/audit/helpers/completion-harness.ts`.

## Verification state

- **The authoritative full-suite green for the SHIPPED source is release CI run
  [31242135825](https://github.com/OhOkThisIsFine/audit-tools/actions/runs/31242135825)** (v0.39.8 —
  gate + all 4 shards green). Read that, not the local runs, as the release signal.
- Local full suite was green twice at **590 files / 7684 tests** (4 files + 15 tests skipped, 265s),
  once per landing — but both runs predate `4503c1fc`, which changed two return shapes. So no LOCAL
  full-suite run covers the released source; CI above does. The shard-duration baseline still dates
  from the older 589-file run and is one file stale — regenerate on the next release.
- `npm run verify:checks` was run locally end-to-end (all 27 steps green) on the final tree, after
  the fast preflight let the v0.39.7 lint failure through. `check:lint` is now IN that preflist
  (`.claude/skills/ship/SKILL.md`), so the trap is in the mechanism and carries no backlog entry.
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

1. **Analyzer-sweep dedup cluster — remaining two** (open-bugs), specs in
   [`reviews/dedup-cluster-2026-08-07b.md`](reviews/dedup-cluster-2026-08-07b.md).
   **Item 6** is the smaller: 6a the byte-identical five-statement conceptual-prep scaffold in
   `nextStepCommand.ts` (keep the per-branch step *assembly* — that difference is load-bearing), 6b
   parameterizing the workspace-pattern algorithm shared by `graphManifestEdges/{cargo,packageJson}.ts`.
   ✅ 6b's stable-order warning is already DISCHARGED — `graph.ts:204` runs `uniqueSortedEdges`
   downstream, so `pathLookup.values()` iteration order never reaches the artifact; no ordering fix
   is needed. **Item 8** unifies three step-drivers (`completion-harness.advanceToDispatchReady`,
   `wrapper-harness.startDispatchRun`, `helpers/run-wrapper.mjs`) into one parameterized driver.
2. **`providers/index.ts` descriptor twin** (open-bugs, new) — found during item 4; the two files
   differ only by the descriptor constant they reference.
3. **T4 remainder** — next target `audit-code-wrapper-packets.test.ts` (198.5s), same
   one-file-at-a-time protocol; queue in the brief's status block.
4. **Dogfood/meta-review 2026-07-30 cluster** (open-bugs, pinned) — live-run-watch properties. Run
   it once the refactors above are done, per the owner call.
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
