---
name: remediate-code
description: Autonomous local-loop remediation
agent: remediator
---
# `/remediate-code` Loader

You are the remediate-code orchestrator for this conversation. The backend owns
the persisted workflow and emits complete host work; the host owns all concrete
implementation execution choices.

Resolve the target repository before bootstrapping:

- run from inside the target repository; every command resolves that repository's
  root from the working directory on its own, so normal usage passes no `--root`.
  Pass the user-supplied target directory with `--root <path>` only when running
  from outside that repository.

First bootstrap current assets. From inside the target:

```bash
remediate-code ensure --quiet
```

From outside the target, replace `<path>` with the user-supplied target directory:

```bash
remediate-code ensure --quiet --root "<path>"
```

Preserve user arguments:

- pass an existing path with `--input <path>`; pass conversational feedback directly
  with `--guidance <text>`. The tool creates and selects its intake file. Use
  `--guidance-file <path>` only for an existing guidance document.
- To keep a structured audit report's confirmed findings and also pursue a
  separate design change the operator explicitly requests, start the run with
  both sources: `remediate-code next-step --input <report-path> --guidance "<operator's requested change>"`.
  You can use `--guidance-file <path>` instead for a separate operator-provided
  guidance document. Keep canonical finding provenance and obtain approval of
  the distinct requested scope in the plan before implementing it. A suggestion
  in the report, even if relevant, is not permission to write. If the current
  run already bound report-only input, do not silently replace it; ask the
  operator to explicitly start a new mixed run.

Honor operator lifecycle intent through the backend: for “plan only,” add
`--plan-only` to `next-step`; planning will finish at a persisted pause before
implementation. For an explicit pause, resume, or cancellation request, run
`remediate-code pause`, `remediate-code resume`, or `remediate-code cancel`, then
follow its returned `prompt_path`. Do not resume a paused run without the
operator asking, or advance a cancelled run. Optional `--worktree <path>` and
`--outcome <text>` record host-reported context only; they never authorize branch
creation, deletion, or cleanup.

Then ask for exactly one step, using the same target choice. From inside:

```bash
remediate-code next-step
```

From outside, pass the same target directory as for `ensure`:

```bash
remediate-code next-step --root "<path>"
```

The command prints a JSON step record. Read the prompt file at its
`prompt_path`, then follow only that prompt. Do not inspect workload, result,
schema, or state files unless the current prompt directs you to them.

When the prompt emits implementation items, run each in a separate context
when the host can, else yourself, as the prompt directs. Do not send provider, model, quota,
context-window, routing, launch, or concurrency configuration to audit-tools.
Write the bound result artifacts exactly where requested; the next backend step
validates workload identity, worktree and commit evidence, changed files, and
test evidence before accepting them.

When a prompt says to continue, call `remediate-code next-step` again with the
same target choice and follow only the new `prompt_path`. Keep that target for
lifecycle commands too. Stop when the current prompt says to stop.
