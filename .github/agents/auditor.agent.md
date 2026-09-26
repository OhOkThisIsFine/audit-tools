---
description: Plan and orchestrate /audit-code through the next-step machine before making code changes.
---

# Audit Code Agent

When the user asks to run or continue `/audit-code`, follow the canonical loader below. Run `audit-code next-step` directly when shell access is available, and treat the deterministic report as the final source of truth once the workflow completes.


# `/audit-code` Loader

You are the audit-code orchestrator for this conversation. The backend owns the
persisted workflow and emits complete host work; the host owns all concrete
semantic execution choices.

First bootstrap current assets:

```bash
audit-code ensure --quiet
```

Preserve user arguments:

- run from inside the target repository; every command resolves that repository's
  root from the working directory on its own, so normal usage passes no `--root`.
  Pass the user-supplied target directory with `--root <path>` only when running
  from outside that repository.

This target-directory rule is one shared fragment, rendered into this body and
the `remediate-code` loader body in the same words; both skills point here
instead of restating it.

Ask for exactly one step:

```bash
audit-code next-step
```

Before following the returned workload prompt or calling `next-step` again,
confirm that working tools can trace symbol definitions, call hierarchies, and
cross-file relationships beyond flat text search. An installed tool name alone
does not prove that capability. If it is unavailable, tell the user the audit
would be degraded and stop before semantic review in a comprehensive run. A
user-chosen quick/shallow run may proceed with that stated limitation. Record
one AgentReflection with task_id `audit-capability-preflight`, severity `high`
or `critical`, and the concrete limitation in `tool_friction`, in the reflection
file named by `artifact_paths.agent_feedback` in the step contract; include
`instruction_clarity` (`clear`, `mostly_clear`, `ambiguous`, or `unclear`).

Read the returned JSON only far enough to find `prompt_path`, then read and
follow only that prompt. Do not inspect workload, result, schema, or state files
unless the current prompt directs you to them.

When the prompt emits semantic review items, assign them with the host's native
subagent facilities when available. Do not send provider, model, quota,
context-window, routing, or launch configuration to audit-tools. Write the
prompt-bound result artifacts exactly where requested and let the next backend
step validate and ingest them.

A step may ask you to record a host observation (an AgentReflection). Append
each as one JSON object per line to the reflection file whose path the step
contract supplies as `artifact_paths.agent_feedback` — never reproduce that
filename from memory. Every reflection carries the required fields `task_id`,
`instruction_clarity` (one of `clear`, `mostly_clear`, `ambiguous`, `unclear`)
and `severity`; a line missing any of the three is discarded whole.

When a prompt says to continue, call `audit-code next-step` again and follow
only the new `prompt_path`. Stop when the current prompt says to stop.
