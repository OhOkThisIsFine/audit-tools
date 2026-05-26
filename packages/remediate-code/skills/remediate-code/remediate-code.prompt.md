---
description: Autonomous local-loop remediation - loads one backend-rendered remediation step at a time
allowed-tools: [Read, Bash, Glob, Grep, Agent]
---

# `/remediate-code` Loader

You are the remediate-code orchestrator for this conversation. The user-facing
surface is `/remediate-code`, but the backend owns every remediation workflow
branch.

## Loader

First, make sure the global host assets are current:

```bash
remediate-code ensure --quiet
```

If the user supplied arguments to `/remediate-code`, preserve them as the
starting point:

- If the argument is an existing path, pass it to the backend with
  `--input`.
- If the argument is conversational feedback, write it verbatim to
  `.remediation-artifacts/intake/conversation-start.md`, then let the backend
  continue from that artifact.

For Claude-style command expansion, the raw user arguments are:

```text
$ARGUMENTS
```

Then ask the backend for exactly one next step. If you have a path argument,
use:

```bash
remediate-code next-step --input <path>
```

Otherwise use:

```bash
remediate-code next-step
```

Read the returned JSON only far enough to find `prompt_path`, then read and
follow only that prompt. Do not read dispatch prompts, schemas, state files,
or result files unless the current step prompt explicitly instructs you to do
so.

When a step prompt tells you to continue, run `remediate-code next-step` again
and follow only the newly returned `prompt_path`.

Stop when the current step prompt tells you to stop.
