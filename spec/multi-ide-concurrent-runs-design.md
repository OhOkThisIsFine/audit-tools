# Multi-agent cooperative runs — design of record

Everything-agnostic. Target (Ethan, 2026-07-02): an **arbitrary number of agents / IDEs / providers all
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
  `{acquired:false}` to the other (`src/remediate/steps/rollingSession.ts`, `dispatch.ts`
  `driveRollingImplementDispatch`). This IS the multi-peer-on-one-run model — generalize it to *cross-IDE*
  peers and to audit.
- **Audit task pool + append-safe results already exist.** `audit_tasks[]` is a pool of independently
  dispatchable tasks; `audit_results.jsonl` is append-only; merge dedups by `task_id`
  (`src/audit/cli/reviewRun.ts`, `ledger.ts`). The data plane is ready for concurrent contributors.

## The three gaps to close

### G1 — Audit holds the coarse lock across execution → serializes peers
`runAuditStepLocked` (`src/audit/cli/auditStep.ts:75-88`) wraps the WHOLE step — load → `advanceAudit`
(**including the executor / LLM work**) → persist — in `artifactTreeLockPath`. A second IDE's `next-step`
therefore **blocks** on the lock and runs strictly after the first. Split the step into three phases;
only the first and third take the short lock:

1. **Claim phase (short lock):** load state, `reclaimStale()`, compute the obligation frontier,
   enumerate claimable units, `claim()` the highest-priority unclaimed one, write THIS agent's
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
  — the obligation itself is ONE claimable node (`nodeId = obligation:<name>`). One peer wins and does
  it; a peer whose only frontier work is a serial obligation already held returns a **cooperative-wait**
  step ("peer is working `<unit>`; nothing else claimable — retry shortly") rather than blocking. When
  the serial step lands and opens a pool, waiting peers pick up tasks.

### G3 — Single shared step slot → peers clobber each other's prompt
`current-step.json` / `current-prompt.md` is one slot per orchestrator (`stepContractWriter.ts`). Each
peer works a *different* unit but shares run state, so each needs its own step/prompt: write
`steps/<agentId>/current-step.json` + `current-prompt.md`, where `agentId` is minted per invocation
(pid+time+rand, same shape as a claim owner token — it also becomes the claim owner). Keep the shared
`steps/current-step.json` as a latest-pointer for observability/back-compat, but each peer reads its own.

## Remediate — already cooperative; make JOIN the default second-invocation path

Implement is already claim-based rolling dispatch over a shared `ClaimRegistry` — cross-IDE peers slot in
with no change to the claim mechanism. Remaining:

- **Serial phases claim `phase:<name>`** (plan / document / triage / close) so two joining peers don't
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

## Decisions (settled, Ethan 2026-07-02)

- **Cooperative, not isolated** — peers contribute to ONE shared run; no primary/secondary.
- **No TTL/heartbeat as run-liveness** (D2 from the first draft still holds) — a *claim's* heartbeat is a
  short work-lease (that's what `STALE_LOCK_MS` reclaim is for), but the RUN itself has no wall-clock
  liveness; run progress is the shared ledger/state, staleness is the dependency-DAG at merge.
- **No host/agent label in shared state** (D3 holds) — coordination is about WHAT is claimed, not WHO.
  `agentId` is a claim owner token, not a human/IDE identity.

## Implementation slices (each a green atomic commit)

0. **Revert the isolation code** (`runRegistry.ts`, per-run path helpers, index exports, test) — design
   correction. *(done)*
1. **Audit lock-split WITH exclusive bundle-mutation claim — ✅ SHIPPED.** In `auditStep.ts`:
   `classifyStep` probes (short lock) whether the current step runs a deterministic bundle-mutating
   runner. If so: `claimWithBackoff` the single `bundle-mutation` mutex node in a shared audit
   `ClaimRegistry` (`.audit-tools/audit/node-claims.json`); re-load fresh under the claim; execute the
   runner UNLOCKED under `withClaimHeartbeat`; persist under a short lock gated by a merge-time ownership
   re-validation (`registry.heartbeat` — OD3 layer 2); release in `finally`. A peer that can't win the
   mutex returns a non-persisting cooperative-wait result (OD1 backoff already exhausted inside
   `claimWithBackoff`). The host-delegation handoff / complete / no-runner path keeps the original
   short-lock RMW (`runAuditStepLocked`), no claim. Single-agent behavior identical (always wins its own
   mutex). **Why one mutex, not `obligation:<id>`:** a single node avoids the "obligation advanced while I
   waited" mismatch — the winner re-loads and executes whatever is current. **Why coupled to the split:**
   `writeCoreArtifacts(prune:true)` is a full-bundle replace, so executing outside the lock is only safe
   because the mutex makes bundle mutation serial (audit's frontier is singular); without it two unlocked
   executors clobber each other's persist (the wipe trap). Reusable helpers: `claimWithBackoff` /
   `withClaimHeartbeat` (`src/shared/quota/claimLease.ts`). Tests: `tests/shared/claim-lease.test.mjs`;
   full shared+audit suite green (3434/0).
2. **Audit task-POOL claiming — ✅ SHIPPED (mechanism).** In `prepareDispatchArtifacts`
   (`src/audit/cli/dispatch.ts`): before packetization, `claimMany` the candidate `task_id`s in a shared
   per-run task-claims registry (`.audit-tools/audit/task-claims.json`, SEPARATE file from the slice-1
   `node-claims.json` mutex because it uses a long ~20min lease — a claim is held across an
   out-of-process worker with no live heartbeat); dispatch only the granted (disjoint) subset — a task a
   live peer holds is omitted. After the top-K `filterPackets`, `clear` the claims on DEFERRED (not-
   emitted) tasks so peers can take them. At ingest (`mergeAndIngestCommand.ts`, after `runAuditStep`
   succeeds), `clear` the claims for every TERMINAL task (passing + failing); `notDispatched` is left
   alone (may be a peer's). Correctness backstop for a rare lease overrun = the existing dedup-by-task_id
   at ingest. New `ClaimRegistry.claimMany`/`clear` + per-registry configurable `staleMs` (OD3 lease).
   **Idempotency crux (`poolId = runId`):** `claimMany` re-grants a node already held by the SAME `poolId`
   and only skips a DIFFERENT live pool's nodes. Dispatch passes `runId` as poolId, so a run's *repeated*
   `prepare-dispatch` (multiple dispatch calls occur within one run before ingest) re-grants its own
   in-flight tasks — without this the second call skipped everything and the plan came back empty/`partial`
   (caught by the wrapper e2e). Two IDEs have distinct `runId`s, so they still partition disjointly.
   The A-8 hybrid in-process driver (`tasksOverride`) is exempt (owns a coordinator-assigned partition).
   Tests: `claim-lease.test.mjs` (claimMany disjoint / same-pool re-grant / clear / stale window). **Boundary — deferred to
   slice 3:** the per-PEER runDir + step-slot orchestration so two peers' *simultaneous* `audit_tasks`
   next-steps don't collide on shared per-run files (`dispatch-plan.json`, result-map). The claim
   *partitioning* is done; wiring each peer to its own dispatch run is the per-agent-step-slot work.
3. **Per-agent step slot — ✅ SHIPPED.** The real gap was NOT the step JSON (every `next-step` prints
   the full contract to STDOUT — per-invocation-safe) but the PROMPT FILE: the host reads it from a file
   via the returned `prompt_path`, so a concurrent clobber of the shared `steps/current-prompt.md` would
   make one peer read another's prompt (→ run the other's disjoint tasks). Fix in `stepContractWriter.ts`:
   a per-PROCESS `processAgentId()` (one `next-step` process = one id = one `steps/<agentId>/` slot);
   `writeStepContract` writes the prompt+JSON there and returns `prompt_path`/`current_*` pointing at it,
   so the host (which already uses the returned `prompt_path`) is concurrency-safe with NO host/SKILL
   change. A shared `steps/current-*` "latest" copy is ALSO written (single-agent back-compat + the
   ~55 helper-based tests + human debug; last-writer-wins, nothing correctness-critical reads it).
   Best-effort TTL GC prunes stale `steps/<id>/` slots. `currentStepPath`/`currentPromptPath` gained an
   optional `agentId` (default = shared path, back-compat). Also **closed the slice-2 boundary**: audit's
   dispatch `runId` is already per-invocation (ms-precision `buildRunId`), so concurrent peers' per-run
   files (`runs/<runId>/dispatch-plan.json`, result-map, pending-audit-tasks) already auto-isolate — no
   extra work needed. Tests: `step-contract-writer.test.mjs` (per-agent slot + shared mirror).
4. **Remediate phase mutex + default join — ✅ SHIPPED.** In `decideNextStepLoop` (`nextStep.ts`) a
   single `phase:main` mutex (repo-level remediation `nodeClaimsPath`, `poolId = stateRunId`) wraps the
   MAIN advance via `claimWithBackoff` + `withClaimHeartbeat`, released in `finally`; a peer that can't win
   returns a non-persisting `phase_busy` cooperative-wait step (new step kind). State is re-loaded fresh
   under the mutex (safe: for an established run the pre-intake gates are no-ops). This serializes the
   SERIAL phases (planning/triage/close) so two peers never clobber `state.json`, but does NOT serialize
   the heavy implement work — that runs out-of-process via the per-run implement `node-claims` (a distinct
   file under `runs/<runId>/implement/`), so each peer emits its dispatch and claims disjoint nodes during
   its mutex turn, then runs them in parallel. Mirrors audit slice 1. Implement was already cooperative;
   the per-agent step slot came free with the shared slice-3 writer, so a second `remediate-code next-step`
   now joins by default. Tests: `phase-mutex-cooperative.test.ts` (phase_busy on contention + no state
   advance; normal advance when free).
5. **Rewrite the durable trap** [[concurrent-nextstep-staleness-cascade-wipe]] → resolved by claim-based
   cooperation (execution outside the lock, claims prevent double-work, merges serialized).

## Decisions on the open questions (settled, Ethan 2026-07-02)

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
  Layer (1) makes revocation *timely*; layer (2) makes it *airtight*. The lease length and heartbeat
  interval are a `(taskLeaseMs, heartbeatMs)` pair with `heartbeatMs << taskLeaseMs << (typical task
  duration ceiling)`; concrete values set in slice 2.
