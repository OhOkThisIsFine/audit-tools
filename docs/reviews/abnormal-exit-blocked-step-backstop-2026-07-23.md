# Abnormal-exit blocked-step backstop — mechanism + review record (2026-07-23)

Closes the backlog *Open bugs* entry: **abnormal next-step exits emit NO step contract, leaving a
stale current-step.json that reads as a live instruction** (observed live twice on the 2026-07-22
re-dogfood: the quota-wall exit 1 left an hour-old gate step on disk reading as "gate re-armed",
and the `advance: exceeded maxTransitions (100)` abort died step-less the same way).

## Property (tool-enforced)

After ANY terminal exit of a `next-step` invocation — normal or fatal — `steps/current-step.json`
reflects THAT invocation's outcome. A fatal termination writes a `blocked` step naming the cause
in the step JSON itself (`progress.summary`); a consumer can never read the previous step as
current. Exit semantics are unchanged: the original error still propagates (stderr report,
nonzero exit).

## Mechanism (one core, two draws)

- **Semantics** — `runWithBlockedStepBackstop(body, writeBlockedStep)` in
  `src/shared/io/stepContractWriter.ts`: catch → derive reason → write blocked step → rethrow the
  ORIGINAL error. A failing blocked-step write is swallowed so it can never mask the original
  failure. Covers every throw class at once (quota wall, engine `maxTransitions` cycle abort,
  mis-shaped-submission parse crash, IO error) — deliberately NOT per-cause conversions inside the
  engine, whose throw stays a defect signal.
- **Assembly** — `writeBlockedStepContract` + `renderBlockedStepPrompt(tool, reason)` in the same
  module: the canonical blocked contract (`step_kind`/`status` `"blocked"`, empty
  `allowed_commands`, `stop_condition` "Report the blocker and stop.", `progress.summary` =
  reason, prompt "# `<tool>` blocked"). Single-sourced so the two orchestrators' blocked steps
  cannot drift (the engine-shared/assembly-forked trap).
- **Audit draw** — `cmdNextStep` split into wrapper + `cmdNextStepBody`
  (`src/audit/cli/nextStepCommand.ts`); the wrapper derives root/artifactsDir then runs the body
  under the backstop. The guidance-file fold moved inside the body (a missing guidance file now
  yields a blocked step too). The two PRE-EXISTING blocked-step sites (config-load error, the
  `result.kind === "blocked"` path) were re-pointed onto the shared assembly; audit's local
  `renderBlockedStepPrompt` deleted. Per-mode inputs: contract version, `runId: null`.
- **Remediate draw** — the CLI `next-step` action body (guidance fold + `decideNextStep`) wrapped
  (`src/remediate/index.ts`); `writeBlockedStep` in `src/remediate/steps/stepWriter.ts` supplies
  the per-mode inputs (remediation contract version, minted `BLOCKED-*` run id — there may be no
  loadable state to read a real id from). `RemediationStepKind` gains `"blocked"`.

## Boundaries considered

- `advance-audit` (the programmatic advance command) never wrote step contracts and its consumers
  do not read `current-step.json` from it — left out deliberately.
- Steps written earlier in the SAME invocation then overwritten by a later throw: correct — the
  step contract is derived state; a re-run re-derives it, and the blocked step names why the
  invocation died after that point.
- Deeper wall/pause classification (retryable `quota_paused` vs hard block) remains the rolling
  engine's job; the backstop only guarantees the contract exists on paths that escape it.

## Tests (red-green validated)

- `tests/shared/blocked-step-backstop.test.mjs` — backstop semantics (original-error preservation,
  writer-failure masking, non-Error stringification) + blocked-contract shape on disk.
- `tests/audit/next-step.test.mjs` — "a fatal next-step exit overwrites the stale step with a
  blocked step naming the cause" (seeded stale step; missing `--guidance-file` as one arbitrary
  member of the covered throw class).
- `tests/remediate/next-step-blocked-backstop.test.ts` — same property through the real commander
  program (`parseAsync`).
- Red check: mutating the backstop to skip the write turned exactly the three mechanism-naming
  tests red (audit + remediate integration, shared unit); restored by inverting.

## Independent review

(4 lanes; results below.)

- **NIM deepseek-v4-pro** — zero refutations across all six probe axes (bypass, consumer
  breakage, double-write, guidance fold, stdout/exit contract, concurrency); confirmed the
  overwrite-on-throw semantics ("no scenario exists where both steps are correct and the overwrite
  is wrong — the throw means the invocation failed and must not leave a ready step"). Its two open
  questions — the guidance fold now emitting a blocked step, and remediate's minted `BLOCKED-*`
  run id — are deliberate design points recorded above.
- **AGY gemini-3.6-flash (effort high)** — 6 findings; 1 ACCEPTED + fixed, rest refuted by
  mechanism or by-design:
  - **ACCEPTED: pre-backstop bypass** — `mkdir` + `ensureSupervisorDirs` ran before the wrapper;
    an IO failure there died step-less. Moved inside the body (the backstop's writer needs no
    pre-created dirs — `writeStepContract` mkdirs recursively). Remediate's
    `resolveArtifactsDirOption` stays outside by necessity (it computes the write target).
  - Prompt/stop-condition text drift: refuted — repo-wide sweep found zero consumers/tests/smokes
    pinning the old strings.
  - run_id null (audit) vs minted string (remediate): pre-existing per-mode contract difference,
    unchanged by this change.
  - Workspace mutated then crash → blocked step + mutated artifacts: by design; artifacts are
    re-derivable and the next invocation re-derives the step.
  - stdout JSON absent on fatal exit: unchanged behavior — fatal exits never printed step JSON;
    hosts read the disk contract on nonzero exit.
  - Per-agent slot desync: misread — `writeStepContract` derives `processAgentId()` internally,
    so the blocked write lands in the crashing process's own agent slot AND the shared latest
    slot.
- **Codex** — attempted (quota-walled until 2026-07-30); the lane produced no output in ~25 min
  and was cut. Two-lane independent review (NIM + AGY) + own sweep stands.
- **Own consumer sweep** — no test/smoke/consumer pins the deleted prompt text ("The audit cannot
  continue…"), the old "configuration blocker" stop-condition, or a strict blocked-step shape;
  remediate validators check `step_kind` as a string, not an enum.
