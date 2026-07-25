# Backlog clearance lap — 2026-07-24 (second)

## Landed

- **Remediate node-claim leak (loop-core).** The stray-worktree guard threw before any session
  bookkeeping, so `writeSessionFile` never ran: the node was never counted in `terminal`, `inFlight`
  stayed pinned ≥1, and the run hung permanently. Fixed with a new terminal class `accept_stray`
  (deliberately not `accept_failed` — that field's directive promises a quarantine ref and names
  `reverify-node`, which a never-committed stray does not have). Order is load-bearing and pinned:
  sidecar → mark terminal → drop token → persist → release → throw last.
- **`StrayWorktreeRejection` carries the directive.** Found by independent review: persisting the node
  terminal is not enough when the stray is the LAST node to complete — guaranteed for every one-node
  grant — because the only call that could surface the state is the one that rejected. The rejection now
  carries the directive it would have returned; the CLI prints it on stdout, the diagnostic on stderr,
  and exits non-zero. The alternative (a prompt line telling the host to call `accept-node` twice) was
  rejected as the "host must remember" shape.
## Built, verified, and REVERTED — the one that matters

**Per-node `token_estimate` for the remediate fit gates.** Three attempts, each killed by review, and
the third killed by the thing the first two were trying to fix.

1. **Byte-SUM estimator — REJECTED.** Summed every scoped read file. That cost model was deliberately
   retired: implement packets inline no file content (workers read on demand), so the sum exploded a
   many-referencing-tests node to `no_capable_pool` — measured here at 307k tokens where the correct
   model gives 65k. It was also a SECOND number for a node that already had one twenty lines below,
   so the coordinator and admission would have disagreed about the same node's fit.
2. **Persist the existing `estimateImplementSlotTokens` instead — correct, and still reverted.**
3. **Why: an honest estimate makes "this node fits NO pool" REACHABLE, and both consumers handle that
   terminally rather than resumably.** Headless in-process: `context_cap` on every pool →
   `neverDispatchable` → a permanent strand blocking the rest of the run. Hybrid: both partitions empty →
   the `partition.host.length === 0` early-merge runs instead of the `no_capable_pool` structural-refusal
   PAUSE → every item `blocked` + `markTerminal`, dead for the run even after the operator frees a larger
   pool. The flat 2000 was not merely imprecise, it was **load-bearing**: every node lied about fitting,
   which is what kept the mishandled branch unreachable.

The routing property (an unplaceable node pauses resumably, naming the real cause) must land first; the
estimate wiring is then two lines. Recorded as a backlog entry with all of the above.
- **`rollingDispatch.test.mjs` de-flaked** (closes two entries). Fixed `setTimeout` waits replaced with a
  `waitFor` poll on a generous deadline; assertions stay exact, so a genuine regression still fails.
- **FLW-COR-003's second half CLOSED.** "A zero-granted round pauses the drain" verified holding at HEAD
  for two independent reasons: admission never runs inside a loop (every dispatch executor is
  `host_delegation`, so both drains halt at the dispatch boundary before admission is computed), and
  `detectHostDispatchWall` returns `atWall` with a discriminated cause the moment `grantedCount === 0`.

## Corrected, not fixed

- **The stale-agent-worktree entry's grep clause was FALSE.** `dist/`, `.claude/*` and
  `.audit-tools/*/*` are gitignored, so `rg`/`git grep` provably cannot see a worktree's build output.
  The surviving lesson is a search-tool trap (an ignore-bypassing `grep -r` manufactures residual-reference
  false positives) and now lives in `durable-traps.md`. The pruning MECHANISM remains genuinely missing.

## The finding that matters

My own first draft of the `accept_stray` host directive was **confidently wrong in exactly the way the
design warned about**: it told the host to re-dispatch the node into "the worktree path listed above",
but `acceptNode.ts` removes the worktree before the stray return, there is no re-dispatch command in
`allowedCommands`, and if the host improvised anyway the new idempotency guard would take the early-out
and silently discard the redone work. The tool's real recovery was already wired — the sidecar makes
`acceptHardFailed` true, which blocks the items and routes them to triage on merge — and the prompt was
talking the host out of it. Independent adversarial review caught it; the same false "quarantined,
re-drive with reverify-node" sentence was then found in two OTHER places reaching the operator for a
stray (the friction ledger note and the item's `failure_reason`), both now branched.

Lesson: writing the new terminal class was the easy half. Every place that already describes the OLD
terminal class to a human is a site the new class silently inherits a false description from.

## Triage of the whole file

Re-run as one NIM call per entry (batching still dies; the per-entry unit is the reliable one), 97/97
returned, 4 unresolved after model rotation. Counts: **40 actionable · 26 owner-decision · 18
accepted-residual-or-lesson · 7 live/env-blocked · 2 possibly-already-shipped.** Treat as a LEAD, not a
verdict — of six entries carried into verification this lap, **two had premises that were false or
partly false at HEAD** (the FLW-COR-003 second half, and the stale-worktree entry's grep clause).

## Verified premises (workflow, 6 candidates)

| entry | premise at HEAD | disposition |
|---|---|---|
| FLW-COR-003 zero-granted | FALSE | closed |
| stale agent worktrees | PARTLY (grep clause false) | entry corrected; mechanism still open |
| proxy-lane populate command | TRUE | fix_now, small |
| Gate-0 `dropped[]` never rendered | TRUE | fix_now, small |
| dead-proxy probe | PARTLY — `openai-compatible` alone does not probe | fix_now, small |
| test tree not typechecked | TRUE | real, but 197 errors — own lap |
