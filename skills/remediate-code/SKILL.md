---
name: remediate-code
description: Conversation-first remediation of audit findings or feedback. Loads one backend-rendered step prompt at a time via remediate-code next-step.
version: 0.2.0
---

# remediate-code skill

The canonical entrypoint is `/remediate-code` in conversation.

This skill should be treated as a conversational product surface first.

## Primary contract

Normal usage should:

- run from conversation, not from manual shell arguments
- avoid manual paths, provider flags, and batching arguments
- advance the remediation automatically until it completes or no further
  automatic progress is possible

The backend accepts structured audit reports, feedback documents, and
conversation-only starting points. Non-structured starts must go through the
backend-rendered intake brief and clarification steps before normal planning.

Semantic work (documentation, implementation) should be delegated to bounded
subagents whenever the host can dispatch them. The conversation orchestrator
owns dispatch and ingestion control; it should not perform broad work itself
when subagents are available. Entering `/remediate-code` is explicit user
authorization to fan out those subagents; do not require a separate delegation
request before parallel dispatch.

If the host cannot delegate to subagents, the conversation orchestrator may
complete exactly one assigned task, ingest it through the provided backend
command, then stop so the user can rerun `/remediate-code` from fresh context.
The backend writes a deterministic single-task fallback prompt for that case so
the orchestrator does not need to infer the first task from a broad batch prompt.

When dispatch-plan entries include complexity and `model_hint.tier` metadata,
a capable host may map those tiers to its own subagent models. The backend
should not prescribe concrete model names.

Bounded steps are a backend implementation detail, not the intended user
experience.

## Embedded Prompt Payload

The prompt payload in `remediate-code.prompt.md` remains the canonical
instruction asset.

The intended user setup is one global package install:

```bash
npm install -g remediator-lambda
```

That makes `remediate-code` available on `PATH` and seeds user-level
command/skill assets for hosts the package can safely update. The prompt
self-bootstraps before advancing the remediation:

```bash
remediate-code ensure --quiet
```

That idempotent bootstrap writes host assets (Claude command, Codex skill,
OpenCode config) only when they are missing or stale.

Use the explicit installer for repair or forced refresh:

```bash
remediate-code install
```

Use direct prompt import only when the target host still needs it after
bootstrap.

## Repo-local fallback

When developing inside the `remediator-lambda` repository itself, prefer:

```bash
node remediate-code.mjs
```

That keeps the run pinned to the local wrapper and local `dist/` output instead
of whichever global `remediate-code` binary happens to be on `PATH`.

## Development rule

Prefer the skill-first conversational contract over the CLI-first backend shape.
