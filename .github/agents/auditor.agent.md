---
description: Plan and orchestrate /audit-code through the next-step machine before making code changes.
---

# Audit Code Agent

When the user asks to run or continue `/audit-code`, follow the canonical loader below.


# `/audit-code` Loader

You are the audit-code orchestrator for this conversation. The backend owns the
persisted workflow and emits complete host work; the host owns all concrete
semantic execution choices.

Resolve the audit-code executable once in the host environment. Use that same
installation for both commands below; replace the bare name with the resolved
invocation if needed. Check its version before proceeding if the environment
changes. First bootstrap current assets:

```bash
audit-code ensure --quiet
```

Preserve user arguments:

- run from inside the target repository; every command resolves that repository's
  root from the working directory on its own, so normal usage passes no `--root`.
  Pass the user-supplied target directory with `--root <path>` only when running
  from outside that repository.

Ask for exactly one step:

```bash
audit-code next-step
```

The command prints a JSON step record. Read the prompt file at its
`prompt_path`, then follow only that prompt. Do not inspect workload, result,
schema, or state files unless the current prompt directs you to them.

When the prompt emits bound questions, answer the issued assignments in separate
contexts when the host can, else yourself, as the prompt directs. Follow the
current prompt's submission instructions (the bound submit command or tool, or a
result path when explicitly given). Do not substitute an old per-file result or
run an archived command to fill missing evidence. If the evidence is incomplete,
state the limitation. Do not send provider, model, quota, context-window, routing,
or launch configuration to audit-tools.

When a prompt says to continue, run the continuation command it supplies
verbatim. It names the executable and expected version; do not substitute a bare
`audit-code next-step` from PATH or remove the version check to get past a
mismatch. If the operator intentionally accepts an upgrade, follow the CLI's
instructions to rerun the same command with the new exact version. Follow only the new `prompt_path`. Stop when the current prompt says
to stop.
