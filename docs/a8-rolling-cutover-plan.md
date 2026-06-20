# A8 — rolling dispatch: unified core, two drivers (working build doc)

> Transient build/checkpoint doc. Delete + fold into HANDOFF/backlog at sprint end.
>
> **REFRAMED (Ethan, 2026-06-16) — supersedes the earlier "literal cutover / delete the
> fallback" reading.** Through discussion we converged on: do NOT delete the host-subagent
> path. There is ONE rolling-dispatch system, not two — a shared rolling **core**
> (eligibility, per-node worktree isolation, verify-before-accept, write-scope, quota
> concurrency, merge) driven by one of two thin **drivers**, selected by what's available:
> - **In-process / CLI-agent driver** — the orchestrator spawns a CLI agent (codex /
>   claude / …) per node via the terminal and awaits it. This *is* the
>   `driveRollingImplementDispatch` engine + `makeProviderNodeDispatcher` (step 1). Not
>   deprecated — it was just never wired (0 callers). Ideal for autonomous/headless runs.
> - **Host-subagent driver** — the conversation host spawns subagents (turn-based); the
>   tool owns the rolling bookkeeping the host executes. This is the existing host path,
>   to be HARDENED onto the same shared core (worktree/verify/write-scope), not deleted.
>
> What was actually dead is the old run-to-completion batch loop; the provider-spawn /
> CLI-dispatch mechanism is dormant, not deprecated. "headless invocation" = that
> CLI-dispatch path.

## Why this is a build, not a flag-flip — the engine was never run end-to-end

`driveRollingImplementDispatch` (remediate `src/steps/nextStep.ts`) has **zero production
callers**; its tests inject stub dispatchers. Reading the path surfaced hard gaps:

- **G1 — no programmatic worker.** Nothing supplies `dispatchNode` (`ProgrammaticNodeDispatcher`).
- **G2 — no worktree commit.** `dispatchNodeWithWorktree` runs the worker, verifies, then
  `mergeWorktree` does `git rev-parse <branch>` + cherry-pick — but nothing ever commits the
  worker's edits in the worktree. Tip == HEAD → cherry-pick is empty; edits are lost on
  `removeWorktree`; the write-scope branch-diff (`gitEditedFilesForBranch`) is empty too.
- **G3 — worktree has no node_modules.** Fresh `git worktree add` omits gitignored
  `node_modules`; `verifyNodeInWorktree` commands (`npm run check`/test) then fail.
- **G4 — prompts not worktree-rooted.** `prepareImplementDispatch` calls `implementPrompt`
  with no `worktreeRoot`, so the prompt declares the *main* repo root and the worker can
  escape isolation. `implementPrompt` already supports a `worktreeRoot` arg (unused).
- **G5 — can't spawn an LLM worker in-session.** claude-code provider throws on
  `CLAUDECODE`; OpenCode uninstalled; codex/antigravity unverified here. Real multi-worker
  validation is not runnable from inside this session.

## Design (grounded in the code)

- **dispatchNode = provider-direct.** Resolve `createFreshSessionProvider(sessionConfig.provider, sessionConfig)`
  and call `provider.launch({ repoRoot: worktreeRoot, promptPath: <node prompt>, taskPath: <minimal task.json>,
  resultPath, uiMode: "headless", timeoutMs })`. `spawnLoggedCommand` already spawns with
  `cwd: input.repoRoot` and scrubs `CLAUDECODE`/`CLAUDE_CODE_*` for the child — so pointing
  `repoRoot` at the worktree runs the headless LLM CLI (claude -p / codex / opencode run) inside
  the worktree. The provider *is* the worker; **no new `worker-run` command**.
- **Tool commits the worktree** after a successful worker run (`git add -A && git commit`),
  deterministically (not LLM/host discretion), before verify + `mergeWorktree`. Fixes G2 +
  makes the write-scope branch-diff real.
- **Worktree node_modules** wired so verify runs (symlink/junction from main, or scoped install). Fixes G3.
- **prepareImplementDispatch threads** the deterministic `worktreePath(root, block_id, runId)`
  into `implementPrompt` so every implement prompt is worktree-rooted. Fixes G4.

## Sequencing (reframed; green at every commit)

1. **In-process / CLI-agent driver made functional (additive; flag still OFF). ✓ DONE — green.**
   `makeProviderNodeDispatcher` (`src/steps/providerNodeDispatch.ts`, wired as the default
   `dispatchNode`) + `commitWorktree` (G2) + `ensureWorktreeNodeModules` (G3) + `worktreeRootedPrompts`
   threading (G4). Tests: `tests/rolling-provider-dispatch.test.ts` (8, injected provider/real-git).
   Remediate suite 1610/0. Committed `dc4d9c2`.
2. **Make the codex provider real. ✓ DONE — green.** `codexProvider.ts` rewritten to the *verified*
   invocation (smoke-tested vs codex-cli 0.140.0): `codex exec --sandbox <mode> --cd <worktree>
   --add-dir <resultDir>` with the prompt on **stdin**; the old `--prompt`/`prompt_flag` guess removed.
   `CodexConfig` redesigned (`sandbox_mode`, `model` — never defaulted, `extra_args`). Windows shim
   single-sourced as `resolveWindowsShimSpawnCommand` (opencode delegates). Argv tests added; shared
   631/0. Since `makeProviderNodeDispatcher` resolves the provider from config, codex is already a
   usable CLI-dispatch backend — no extra wiring.
3. **Validate a real ≥2-worker rolling run via codex. ⛔ BLOCKED — codex usage limit resets Jun 19, 2026.**
   The smoke confirmed auth + the exact invocation (codex read stdin, selected gpt-5.5, started) — only
   the usage cap stopped the edit. Re-run after Jun 19 (or via another spawnable provider): set
   `sessionConfig.provider="codex"` + `dispatch.rolling_engine=true` on a small real remediation, confirm
   ≥2 nodes land via worktree→verify→merge. NOTE the unverified-on-Windows detail: whether
   `--sandbox workspace-write` is enforced on Windows is still unconfirmed (codex sandbox is historically
   mac/Linux); the real run will show it — fall back to `danger-full-access` via config if needed.
4. **Host-subagent driver — ✓ BUILT (flag-gated, default-OFF), green.** `acceptNodeWorktree` extracted as
   the shared core (commit `d2003313`); `accept-node --id X` callback + the `dispatch_implement_rolling`
   step + the lock-guarded `rollingSession` state machine (`prepareHostRollingDispatch`/`advanceHostRolling`,
   bounded JIT worktrees) landed (`73424050` + `414e302e`). When `rolling_engine` is enabled AND the host can
   dispatch, next-step emits the worktree-per-node rolling step; the host spawns a subagent per node and calls
   `accept-node` on each completion (dispatch/wait/done). Tests: `host-rolling-dispatch.test.ts` (7) + a
   `decideNextStep` emission test. **✓ real-subagent end-to-end smoke DONE + a false-resolve bug found & fixed
   (`f18138fe`) — see "Open items" below.** REMAINING: the provider-path real-run (Jun 19) + flip to default-ON.
5. **audit-code symmetric** wiring of its rolling engine into the audit live path.
6. **Harden** worktree-branch reuse across a `rate_limited` re-queue.

## Host-subagent driver protocol (step 4 — the next build)

One-shot-CLI orchestrator + host-as-executor ⇒ rolling via a **per-completion callback** the tool owns:

- **Extract the shared `acceptNode` core** first: pull the post-worker lifecycle (commit → verify-in-worktree
  → cherry-pick merge → write-scope-from-branch-diff) out of `dispatchNodeWithWorktree` into a reusable
  fn (`acceptNodeWorktree(root, runId, block, state, worktreeRoot, branch, workerOutcome) → {outcome, verifyPassed, merged}`).
  The in-process provider loop calls it inline; the host driver calls it from a new command.
- **`accept-node --id X` command** (the per-completion callback): runs `acceptNode(X)` + recomputes
  eligibility + JIT-creates the next eligible node's worktree + worktree-rooted prompt → prints
  "dispatch Y" or "done."
- **Dispatch step**: pre-creates the currently-eligible nodes' worktrees + prompts and tells the host:
  "spawn up to N subagents (N = quota slots) into these worktrees; as EACH finishes run
  `accept-node --id <node>`; keep N slots full from what it returns; when none remain, run `next-step`."
  → dispatch-next-on-complete (full JIT), tool-owns-correctness, host-executes-spawn.
- **Selection by availability**: host-subagent driver when the host can dispatch (the conversation-first
  default); in-process provider driver when a spawnable provider (codex/local-LLM/`claude -p`-when-not-nested)
  is configured.
- **Isolation**: each node in its OWN worktree (hard inter-node, both drivers). Binding a Task-subagent to
  its worktree is SOFT (orchestrator can't cwd-confine the host's subagent) → enforced by detection:
  worktree-rooted prompt + a "main tree must stay clean" guard + branch-diff write-scope ⇒ a strayed
  subagent's node just FAILS, never silent corruption. Provider workers get hard cwd-confinement.

## Open items to surface
- **Host-subagent driver real-subagent smoke — ✓ DONE (this session).** Drove the real machine to
  `dispatch_implement_rolling` in an isolated repo (3 disjoint nodes, slots capped to 2), spawned ACTUAL Task
  subagents into the worktrees, called `accept-node` per completion: dispatch→wait→done all confirmed, real
  worktree commit→verify→merge (2 landed on main), JIT worktree creation, finalize via
  merge-implement-results→next-step, failing node routed to triage. No quota needed.
- **False-resolve bug found by the smoke — ✓ FIXED (`f18138fe`).** Both rolling drivers discarded
  `acceptNodeWorktree`'s `{merged}` outcome, so a node that fails tool-owned verify with IN-SCOPE edits was
  marked `resolved` from its self-reported result while its fix never landed (silent false-close). Fix: a
  per-node `accept-outcome-<block>.json` sidecar written by BOTH drivers + a merge-state gate in
  `mergeImplementResults` that blocks any self-reported-resolved node whose recorded outcome is `merged:false`.
  Red→green regression (`dispatch-merge-tolerance.test.ts`) + real-git wiring test (`host-rolling-dispatch.test.ts`).
- **Provider-path real-run validation — ✓ DONE 2026-06-17 via NVIDIA NIM (NOT codex).** codex+NIM is a dead
  end (codex 0.140 dropped `wire_api=chat`; NIM's Responses API rejects codex's `namespace` tools), so we
  built the `openai-compatible` provider (the `llm write` pattern as a provider) + WIRED
  `driveRollingImplementDispatch` into `decideNextStep` (routes there when rolling_engine ON + an explicit
  backend provider is configured — precedence over host-subagent), then validated through the REAL next-step
  path over live NIM (`tests/nim-rolling-e2e.test.ts`, gated `RUN_NIM_E2E=1`): ≥2 nodes land via
  worktree→verify→merge, a verify-fail routes to triage (`blocked`), never false-resolved.
- **Flip `rolling_engine` default-ON — ✓ DONE (`8819713`).** Rolling is the implement default; the wave is an
  explicit opt-out (`rolling_engine:false`). Fixtures swept for the new default.
- **Windows codex sandbox** — moot for the validation (we used NIM, not codex). Revisit only if codex is later
  used as a spawnable in-process backend on Windows.

## Remaining to fully land A8 (then fold + delete this doc)
- **Step 5 — audit-code symmetric wiring** of `runRollingDispatch` into the audit live path (still dormant).
- ✓ **Step 6 — worktree-branch reuse across a `rate_limited` re-queue** — DONE. `resetNodeWorktreeAndBranch`
  (remove worktree → prune → force-delete branch) makes every (re-)dispatch start clean from HEAD; the
  in-process driver calls it before `createWorktree`. Real-git regression test in `rolling-provider-dispatch.test.ts`.
- ✓ **Worktree walks UP to the parent repo** — DONE. `createWorktree` asserts `git rev-parse --show-toplevel`
  canonicalizes to the target root and refuses otherwise (covers both drivers).
- **Surface `openai-compatible` as a confirmed pool** — DONE for the in-process driver (config-gated discovery
  + 2nd CapacityPool + per-slot provider resolution); the {host-subagent + NIM} hybrid + live cross-provider
  spill run remain (backlog quota *a-residual*).

## Step 7 — hybrid topology wiring (FINDING-020 capstone, task_847a8c7d) — REMEDIATE DONE (green)

> Ethan-confirmed scope (2026-06-20): **Full hybrid now.** ONE remediate cycle splits the eligible frontier
> across [host-subagent pool + in-process backend (NIM) pool] via the `HybridSpillCoordinator`, host nodes →
> subagents (step contract), NIM nodes → in-process workers (this cycle), both merged by the shared
> `acceptNodeWorktree`. Live cross-provider run stays gated (`RUN_NIM_E2E=1`). Spec: `docs/remaining-specs.md` §A8.

**Key fact:** `buildConfirmedPools` (src/remediate/steps/dispatch.ts) ALREADY returns `[hostPool, nimPool]` when
`provider != openai-compatible` AND `openai_compatible` is configured. The gap: the host-subagent driver ignores
the 2nd pool; the decision point (`nextStep.ts` ~L1485) selects ONE driver mutually-exclusively. The coordinator
(`src/shared/dispatch/coordinator.ts`, `planAssignments`) is the single claimant + proactive splitter, zero
production callers today.

**Model (matches spec L78-81):** per next-step cycle — `coordinator.planAssignments(frontier)` does the full
host-vs-inprocess split (each node claimed to exactly one pool); partition by pool providerName; run the in-process
partition NOW (concurrent, bounded by the coordinator's split); hand the host partition to the host via the
existing `dispatch_implement_rolling` step. Next cycle re-splits the remaining frontier by current capacity →
continuous proactive distribution. Claims + ownerTokens flow from the coordinator to whichever driver executes.

**Increments (all green; branch `a8-hybrid-spill-wiring`, awaiting Ethan review before merge/publish):**
1. ✓ `planHybridDispatch` (`src/remediate/steps/hybridDispatch.ts`) — drive the coordinator to split the frontier
   + claim each node, partition `{inProcess, host}` by `isInProcessPool`. Hermetic test proves crit. 1/2/4 at the
   partition level (`tests/remediate/hybrid-dispatch.test.ts`, 6). Commit `2ea578d`.
2. ✓ Extract `executeNodeInWorktree` (`dispatch.ts`) — the per-node in-process lifecycle (reset→create→seed→
   launch→acceptNodeWorktree→record), shared by the reactive engine and the hybrid executor. Behaviour-preserving.
   Commit `b574012`.
3. ✓ `prepareHostRollingDispatch` consumes a pre-prepared plan + pre-claimed host partition (reuses coordinator
   tokens, no re-claim); `advanceHostRolling` needs no change (partition ≤ slots). Commit `5f12e99`.
4. ✓ **Cutover** — the host-subagent branch of `decideImplementDispatch` activates the hybrid when a backend pool
   is ALSO confirmed: prepare once → `planHybridDispatch` → `executeInProcessPartition` (in-process partition runs
   this cycle, each node on its assigned pool) → host partition handed to the host driver. Pure host-subagent
   falls out when no backend pool. The explicit-backend in-process branch is unchanged. Commit `384a696`.
5. ✓ Hermetic executor integration test (`tests/remediate/hybrid-inprocess.test.ts`, 2) — nodes run on their
   backend pool, merge into HEAD, claims released; an errored node is not merged (triage, never false-resolved).
   Commit `c5f991c`.

**Remaining for FULL A-8 (NOT blocking the remediate-hybrid review):**
- **Audit symmetric** — `driveRollingAuditDispatch` still uses the reactive `runRollingDispatch`; wire it through
  the coordinator so review-packet spill matches remediate (cutover-plan step 5; audit in-process is still dormant
  in the live path, so this is a larger pre-existing gap, not just "apply the coordinator").
- **DC-4 cross-cycle pause** — the hybrid's settled set is per-cycle; persist it + wire `coordinator.terminalStatus`
  → the `all_pools_exhausted` resumable pause (today an exhausted backend node routes to triage — bounded, no
  livelock, but no resumable pause yet).
- **Live hybrid run (crit. 3)** — manual in-session validation with a Claude session AND a NIM key present at once
  (`provider=claude-code` + `openai_compatible` configured); the in-process half is already covered by the gated
  `tests/nim-rolling-e2e.test.ts`. The host half needs a real host, so it is an in-session check, not a CI test.
