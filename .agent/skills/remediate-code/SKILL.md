---
name: remediate-code
description: Conversation-first remediation of audit findings or feedback through provider-neutral host work items.
---

# remediate-code skill

The canonical entrypoint is `/remediate-code` in conversation.

## Primary contract

Normal usage should:

- run from conversation rather than manual backend commands
- preserve structured findings, path inputs, and conversational guidance
- advance automatically until complete or genuinely blocked
- leave provider, model, quota, routing, and launch choices to the host

The backend owns intake, contract planning, persisted state, dependency and
phase safety, strict result ingestion, verification, and closeout. When
implementation is ready it emits every eligible provider-neutral work item.
Delegate bounded work through the host's native subagent facilities when
available. The host returns prompt-bound commit and test evidence; the backend
corroborates that evidence before it accepts completion.

If the host cannot delegate, complete exactly one emitted work item in the
current conversation, write its required result artifact, ingest it, and stop
so the user can resume from fresh context.

## Loader protocol

Bootstrap once, then request one step at a time:

```bash
remediate-code ensure --quiet
remediate-code next-step
```

Pass a supplied path with `--input`. Pass conversational guidance using the
loader's temporary guidance file and `--guidance-file`. Do not add capability,
provider, model, quota, context-window, or concurrency flags.

Read the returned JSON only far enough to find `prompt_path`, then read and
follow only that prompt. When it says to continue, call `next-step` again. Stop
when it says to stop.

When developing audit-tools itself, prefer `node remediate-code.mjs`. Use
`remediate-code install` for repair or forced asset refresh.

## Development rule

Prefer the skill-first conversational contract over lower-level CLI commands.
