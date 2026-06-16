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
4. **Harden the host-subagent driver onto the shared core** (replaces "delete the fallback"): give the
   host path per-node worktree isolation + verify-before-accept + write-scope, select driver by
   availability. Keep BOTH; one rolling core.
5. **audit-code symmetric** wiring of its rolling engine into the audit live path.
6. **Harden** worktree-branch reuse across a `rate_limited` re-queue.

## Open items to surface
- **Real-run validation (step 3) is the gate** before either driver is trusted in production; it's
  quota-blocked until Jun 19. Everything to date is invocation-verified + unit/injected-provider green.
- **Windows codex sandbox** enforcement unconfirmed (see step 3).
