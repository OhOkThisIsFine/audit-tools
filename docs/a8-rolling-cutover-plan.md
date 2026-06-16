# A8 — rolling-dispatch literal cutover (working build doc)

> Transient build/checkpoint doc. Delete + fold into HANDOFF/backlog at sprint end.
> **Decision (Ethan, 2026-06-16):** *literal* cutover — the rolling/worktree/verify
> engine becomes the **only** implement dispatch path; the host-fanned wave step and
> the `implement_rolling_sequential` fallback are **deleted**; the opt-in flag is removed.
> Accepted consequence: `/remediate-code` can no longer dispatch from inside a live
> Claude session (claude-code provider throws on `CLAUDECODE`); remediate runs headless
> or via a non-claude provider. This intentionally removes host-discretion dispatch
> (the "enforce in tooling, never host discretion" invariant taken to its end).

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

## Sequencing (green at every commit + atomic-replace)

1. **Engine-functional (additive; fallback intact; flag still OFF). ✓ DONE — green.**
   `makeProviderNodeDispatcher` (provider-direct, in `src/steps/providerNodeDispatch.ts`, wired as the
   default `dispatchNode`) + `commitWorktree` (G2) + `ensureWorktreeNodeModules` (G3) +
   `worktreeRootedPrompts` threading (G4). Tests: `tests/rolling-provider-dispatch.test.ts` (8, injected
   provider/real-git). Full remediate suite 1610/0; typecheck clean.
2. **Validate a real ≥2-worker rolling run** where a provider can spawn (headless / codex /
   antigravity). If not runnable in-session, stand up a validation script + document the manual gate.
3. **Atomic cutover commit:** wire dispatchNode-backed rolling as the **only** implement path in
   `buildImplementDispatchStep`; delete `dispatch_implement` + `implement_rolling_sequential`;
   remove the `rolling_engine` flag / `REMEDIATE_ROLLING_ENGINE` env + `resolveRollingEngineEnabled`.
   Lands once the engine is validated (honors the backlog's "gate on validated dispatch; don't
   force the cutover").
4. **audit-code symmetric** wiring of `runRollingDispatch` into the audit live path.
5. **Harden** worktree-branch reuse across a `rate_limited` re-queue.

## Open validation question (surface at the deletion boundary)
The backlog program-of-record says A8 is "gated on a *validated* real multi-worker rolling
dispatch (don't force the cutover)." In-session validation is blocked by G5. The irreversible
deletion (step 3) is therefore held until a real multi-worker run is validated in a spawnable
environment — or Ethan green-lights landing it on injected-provider tests alone.
