# Multi-agent cooperative runs — design of record

Everything-agnostic. Target: an **arbitrary number of agents / IDEs / providers all
contribute to the SAME audit or remediation run**. Start an audit in one IDE; run `/audit-code` in a
second IDE and it **joins** the same run, taking on appropriate unclaimed tasks. Symmetric peers — no
primary/secondary — each following the process, feeding off each other's results as they land, never
taking the same task and colliding.

Supersedes the single-writer state model and the durable trap
[[concurrent-nextstep-staleness-cascade-wipe]]. (Corrects a first draft that solved the OPPOSITE problem
— isolating N private runs; the goal is cooperation on ONE shared run.)

## The model

**One shared audit run and one shared remediation run per repo** — the shared `.audit-tools/audit` /
`.audit-tools/remediation` tree *is* the run; the run is not a private namespace. Any agent running the
slash command is a peer that **joins**: each `next-step` claims one unclaimed unit of work, executes it,
merges its result into shared state, releases the claim. At every claim/selection point a peer sees the
results peers have already landed. An agent dying mid-unit lets its claim go stale → another peer
reclaims it (automatic failure recovery). No per-agent run, no roster to maintain — the live claims ARE
the roster.

## The substrate already (mostly) exists

- **Cross-process claim primitive — reuse verbatim.** `ClaimRegistry`
  (`src/shared/quota/claimRegistry.ts`) is filesystem-backed (`node-claims.json`), lock-serialized
  (`withFileLock`), token + heartbeat + stale-reclaim (`STALE_LOCK_MS`). `nodeId → ClaimRecord`, caller
  supplies the path — pointing two coordinators at one file is "the whole point" (its own comment). It is
  the exact mutual-exclusion needed for cross-IDE task claiming.
- **Remediate already joins cooperatively.** Two rolling drivers (host-subagent + in-process provider)
  claim *disjoint* nodes through one shared `ClaimRegistry` and work in parallel; a node one holds returns
  `{acquired:false}` to the other (`src/remediate/steps/rollingSession.ts`, `nextStep.ts`'s
  `driveRollingImplementDispatch`, dispatched/accepted via the `dispatch/` helpers). This IS the
  multi-peer-on-one-run model — generalize it to *cross-IDE*
  peers and to audit.
- **Audit task pool + append-safe results already exist.** `audit_tasks[]` is a pool of independently
  dispatchable tasks; `audit_results.jsonl` is append-only; merge dedups by `task_id`
  (`src/audit/cli/reviewRun.ts`, `ledger.ts`). The data plane is ready for concurrent contributors.

## The three gaps to close

### G1 — Audit holds the coarse lock across execution → serializes peers
`runAuditStepLocked` used to wrap the WHOLE step — load → `advanceAudit` (**including the executor / LLM
work**) → persist — in `artifactTreeLockPath`. A second IDE's `next-step` therefore **blocked** on the
lock and ran strictly after the first. Fixed by splitting the step into three phases (`runAuditStepLocked`
is only the fallback path for host-delegation/complete/no-runner steps, in `src/audit/cli/auditStep.ts`);
only the first and third phases take the short lock:

1. **Claim phase (short lock):** load state, compute the obligation frontier,
   enumerate claimable units, `claim()` the highest-priority unclaimed one (granting over any stale
   existing lease inline, no separate reclaim call), write THIS agent's
   step/prompt, release the lock. If nothing is claimable → write a **cooperative-wait** step and stop.
2. **Execute phase (NO lock):** the executor / dispatch / LLM work runs here — where peers overlap in
   time. The claim is heartbeated so a long unit isn't reclaimed.
3. **Merge phase (short lock):** ingest the result into shared state (append ledger + persist derived
   artifacts, the existing merge-and-ingest), `release()` the claim, release the lock.

This preserves the O2 invariant that mattered (no load against a partially-written bundle — merges are
still serialized) while removing the part that serialized *execution*.

### G2 — Audit has no task-level claiming
Add a shared audit `ClaimRegistry` at `.audit-tools/audit/node-claims.json`. Claimable units:

- **Pooled obligation `audit_tasks`** — each pending task is a claimable node (`nodeId = task_id`). N
  peers claim N distinct tasks → real parallel contribution. Results already append-safe + dedup-by-id.
- **Serial obligations** (`repo_manifest`, `file_disposition`, structure/graph/design, `synthesis`, …)
  — rather than one claimable node per obligation, the design (see *Mechanism* below)
  claims a single shared `bundle-mutation` mutex node for any bundle-mutating step, with the obligation
  name carried only as `poolId` metadata for the "peer is working `<unit>`" cooperative-wait message —
  a single node avoids the "obligation advanced while I waited" mismatch. One peer wins and does it; a
  peer whose only frontier work is a serial obligation already held returns a **cooperative-wait** step
  rather than blocking. When the serial step lands and opens a pool, waiting peers pick up tasks.

### G3 — Single shared step slot → peers clobber each other's prompt
`current-step.json` / `current-prompt.md` is one slot per orchestrator (`stepContractWriter.ts`). Each
peer works a *different* unit but shares run state, so each needs its own step/prompt: write
`steps/<agentId>/current-step.json` + `current-prompt.md`, where `agentId` is minted per invocation
(pid+time+rand, same shape as a claim owner token — it also becomes the claim owner). Keep the shared
`steps/current-step.json` as a latest-pointer for observability/back-compat, but each peer reads its own.

## Remediate — already cooperative; make JOIN the default second-invocation path

Implement is already claim-based rolling dispatch over a shared `ClaimRegistry` — cross-IDE peers slot in
with no change to the claim mechanism. Remaining:

- **Serial phases claim a single `phase:main` mutex** (plan / triage / close) so two joining peers don't
  both plan; the non-winner picks an implementable claimable block or gets a cooperative-wait step.
- **A plain second `next-step` enters the rolling join path** rather than contending on `state.json`
  (largely true via rolling today — verify + wire the entry so it's the default, not opt-in).
- `state.json` mutations stay lock-safe via the existing `state.lock`.

## Agent identity

Per-invocation `agentId`, minted like a claim owner token (`pid-time-rand`); it scopes the step slot and
owns the peer's claims. Not persisted as a run. `ClaimRegistry.listClaims()` answers "who is working
what" — no separate roster.

## What this deletes / does NOT need (ideal-code — [[prefer-ideal-code-no-backcompat]])

- **No `runs/<runId>/` isolation, no run registry, no `resolveRun` ambiguity** — the first-draft slice-1
  code (`runRegistry.ts`, per-run path helpers) is reverted as the wrong model. The shared tree is
  already the shared run.
- **The coarse "whole audit step under one lock"** — replaced by the claim/execute/merge split (single
  atomic replace per the atomic-replace-ordering invariant).

## Decisions (settled)

- **Cooperative, not isolated** — peers contribute to ONE shared run; no primary/secondary.
- **No TTL/heartbeat as run-liveness** — a *claim's* heartbeat is a
  short work-lease (that's what `STALE_LOCK_MS` reclaim is for), but the RUN itself has no wall-clock
  liveness; run progress is the shared ledger/state, staleness is the dependency-DAG at merge.
- **No host/agent label in shared state** (D3 holds) — coordination is about WHAT is claimed, not WHO.
  `agentId` is a claim owner token, not a human/IDE identity.

## Mechanism

How the three gaps close, as durable design (the shared substrate above supplies every primitive):

- **Audit lock-split with an exclusive bundle-mutation claim.** A bundle-mutating step claims a single
  `bundle-mutation` mutex node in a shared audit `ClaimRegistry` (`.audit-tools/audit/node-claims.json`),
  re-loads fresh under the claim, executes the runner **unlocked** under a heartbeat, then persists under a
  short lock gated by a merge-time ownership re-validation (OD3 layer 2), releasing in `finally`. A peer
  that can't win the mutex returns a non-persisting cooperative-wait result; the host-delegation / complete
  / no-runner path keeps the plain short-lock RMW with no claim. **Why one mutex, not `obligation:<id>`:**
  a single node avoids the "obligation advanced while I waited" mismatch — the winner re-loads and executes
  whatever is current. **Why coupled to the split:** `writeCoreArtifacts(prune:true)` is a full-bundle
  replace, so unlocked execution is only safe because the mutex serializes bundle mutation (audit's
  frontier is singular); without it two unlocked executors clobber each other's persist (the wipe trap).
- **Audit task-pool claiming.** Before packetization, `claimMany` the candidate `task_id`s in a **separate**
  per-run task-claims registry (`.audit-tools/audit/task-claims.json`) — separate from the bundle mutex
  because it uses a long lease held across an out-of-process worker with **no live heartbeat**; dispatch
  only the granted disjoint subset, clear deferred (not-emitted) claims so peers can take them, and clear
  every terminal task's claim at ingest. The rare lease-overrun backstop is the existing dedup-by-`task_id`
  at ingest. **Idempotency crux (`poolId = runId`):** `claimMany` re-grants a node already held by the
  same pool and skips only a *different* live pool's nodes, so a run's repeated `prepare-dispatch` re-grants
  its own in-flight tasks while two IDEs (distinct `runId`s) still partition disjointly. The hybrid
  in-process driver (a coordinator-assigned partition) is exempt.
- **Per-agent step slot.** The contended surface is the prompt FILE, not the step JSON (which each
  invocation prints to stdout): the host reads the prompt via the returned `prompt_path`, so a per-process
  `agentId` scopes it to a `steps/<agentId>/` slot and the host is concurrency-safe with no host/skill
  change. A shared `steps/current-*` "latest" mirror stays for single-agent back-compat and debug
  (last-writer-wins; nothing correctness-critical reads it). Audit's per-invocation `runId` already
  auto-isolates the other per-run dispatch files.
- **Remediate phase mutex + default join.** A single `phase:main` mutex wraps the main advance; a peer
  that can't win returns a non-persisting `phase_busy` cooperative-wait step. This serializes only the
  serial phases (plan / triage / close) so two peers never clobber `state.json`; the heavy implement work
  stays cooperative out-of-process via the per-run implement node-claims, so peers claim disjoint nodes and
  run them in parallel. A plain second `next-step` therefore joins by default.

This resolves [[concurrent-nextstep-staleness-cascade-wipe]]: concurrent runners can no longer interleave a
destructive stale-sweep, so the old "one sequential call at a time" rule is superseded (residual: an
external linter reformat of `intent_checkpoint.json` still causes re-derive churn, not data loss).

## Decisions on the open questions (settled)

- **OD1 — Cooperative-wait = bounded backoff THEN hand back.** A peer whose only frontier work is a
  held serial obligation does a few short **in-process bounded waits of increasing duration**
  (re-resolving the frontier between them, to catch a quick opening cheaply); if still blocked, it
  returns the **non-blocking "retry — peer working `<unit>`" contract** for the host to re-invoke. Best
  of both: fast pickup when the serial step finishes quickly, host-paced when it doesn't.
- **OD2 — One shared run each (YAGNI).** Exactly one shared audit + one shared remediation per repo; the
  shared tree IS the run. No multi-distinct-run namespacing. Revisit only on a real need.
- **OD3 — Long per-task lease + heartbeats + a REVOCATION protocol.** Audit task claims get a lease
  longer than the shared `STALE_LOCK_MS` (long tasks aren't reclaimed prematurely) AND the executing
  peer heartbeats on a timer. The critical addition: when A's lease *does* go stale and B reclaims it,
  and A later wakes, **A must be told its claim is void and abandon its work** — never write a stale
  result over B's. Mechanism (all token-checked, already supported by `ClaimRegistry`) — TWO layers of the SAME
  ownership re-validation, because `heartbeat(nodeId, ownerToken)` already returns `false` when the token
  no longer owns the node (it is an ownership check, not merely a lease refresh):
  1. **Heartbeat-driven continuous re-validation (primary).** A's periodic `heartbeat` both refreshes the
     lease AND re-validates ownership every tick. The moment a heartbeat returns `false` (B reclaimed the
     stale lease), A **stops and abandons** — it does not finish, does not write. This is the ongoing
     revocation signal, not an afterthought: a superseded peer learns it is superseded at the next tick.
  2. **Merge-time ownership gate (mandatory backstop).** Before ingesting, A re-checks ownership
     (`heartbeat`/`isClaimed` + token compare); `false` ⇒ **discard result, refuse the merge**. This
     closes the narrow race where revocation lands between A's last heartbeat and its ingest, enforced at
     the single merge chokepoint — so correctness never depends on the heartbeat timer's granularity.
  Layer (1) makes revocation *timely*; layer (2) makes it *airtight*.

  **The two layers map onto the two claim lifetimes.** Layer (1)'s continuous heartbeat
  re-validation (`withClaimHeartbeat`) is wired only to the short-lived coordination mutexes
  (bundle-mutation, `phase:main`), where a live heartbeat spans the whole critical section
  (`CLAIM_HEARTBEAT_MS` / `PHASE_CLAIM_HEARTBEAT_MS` = 10_000). The long-lived per-task / per-node
  *execution* claims (`task-claims.json`, remediate's node-claims) hold a long lease across an
  out-of-process worker run with no live heartbeat — they are **lease-only** (20-min TTL,
  `AUDIT_TASK_CLAIM_LEASE_MS` = 20 · 60_000), resting entirely on layer (2): the merge-time ownership
  gate at the single ingest chokepoint (`mergeAndIngestCommand.ts` → `partitionByOwnership`), backed by
  dedup-by-`task_id` / dedup-by-id, as the airtight backstop against a rare lease overrun. Extending
  continuous heartbeat re-validation over the long-lived execution claims is the still-open slice-3
  work (tracked in `docs/backlog.md`).
