---
name: audit-code
description: Conversation-first autonomous code auditing workflow for the /audit-code command.
---

# audit-code skill

The canonical entrypoint is `/audit-code` in conversation.

## Primary contract

Normal usage should:

- run from conversation rather than manual backend commands
- advance automatically until complete or genuinely blocked
- read only the current backend-rendered prompt for each bounded step
- leave provider, model, quota, routing, and launch choices to the host

audit-tools owns deterministic discovery, planning, persisted state, strict
result ingestion, and synthesis. When semantic review is ready it emits a
complete provider-neutral workload. Delegate those bounded items through the
host's native subagent facilities when available, then return only the bound
result artifacts requested by the current prompt.

If the host cannot delegate, complete exactly one emitted review item in the
current conversation, write its required result artifact, ingest it, and stop
so the user can resume from fresh context. Do not invent a smaller task or an
alternate execution path.

## Loader protocol

Bootstrap once, then request one step at a time:

```bash
audit-code ensure --quiet
audit-code next-step
```

When developing audit-tools itself, use the repository-local wrapper:

```bash
node audit-code.mjs ensure --quiet
node audit-code.mjs next-step
```

The target-directory rule has one home — *Preserve user arguments* in the
`/audit-code` loader prompt, whose absolute path `audit-code prompt-path` prints.
Follow it as written there. Do not add provider, model, quota, routing, or launch
flags.

Read the returned JSON only far enough to find `prompt_path`, then read and
follow only that prompt. Do not inspect workload, result, schema, or state files
unless the current prompt directs you to them. When it says to continue, call
`next-step` again. Stop when it says to stop.

The package install seeds command and skill assets. Use `audit-code install`
for repair or forced refresh and `audit-code prompt-path` only for hosts that
still require direct prompt import.

## Development rule

Prefer the skill-first conversational contract over lower-level CLI commands.
