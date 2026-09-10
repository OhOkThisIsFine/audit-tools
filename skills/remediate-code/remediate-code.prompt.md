---
description: Autonomous local-loop remediation through provider-neutral host work items
allowed-tools: [Read, Bash, Glob, Grep, Agent]
---

# `/remediate-code` Loader

You are the remediate-code orchestrator for this conversation. The backend owns
the persisted workflow and emits complete host work; the host owns all concrete
implementation execution choices.

First bootstrap current assets:

```bash
remediate-code ensure --quiet
```

Preserve user arguments:

- run from inside the target repository; every command resolves that repository's
  root from the working directory on its own, so normal usage passes no `--root`.
  Pass the user-supplied target directory with `--root <path>` only when running
  from outside that repository.
- pass an existing path with `--input <path>`; write conversational feedback to a
  temporary file and pass it with `--guidance-file <path>`.

The target-directory rule above is one shared fragment, rendered into this body
and the `audit-code` loader body in the same words; both skills point at the
loader bodies instead of restating it.

Then ask for exactly one step:

```bash
remediate-code next-step
```

Read the returned JSON only far enough to find `prompt_path`, then read and
follow only that prompt. Do not inspect workload, result, schema, or state files
unless the current prompt directs you to them.

When the prompt emits implementation items, assign them using the host's native
subagent facilities when available. Do not send provider, model, quota,
context-window, routing, launch, or concurrency configuration to audit-tools.
Write the bound result artifacts exactly where requested; the next backend step
validates workload identity, worktree and commit evidence, changed files, and
test evidence before accepting them.

When a prompt says to continue, call `remediate-code next-step` again and follow
only the new `prompt_path`. Stop when the current prompt says to stop.
