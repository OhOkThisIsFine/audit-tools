---
name: audit-code
description: Conversation-first autonomous code auditing workflow for the /audit-code command.
---

# audit-code skill

The canonical entrypoint is `/audit-code` in conversation.

This skill should be treated as a conversational product surface first.

## Primary contract

Normal usage should:

- run from conversation, not from manual shell arguments
- avoid manual paths, provider flags, and model-selection arguments
- advance the audit automatically until it completes or no further automatic progress is possible

Semantic review should be delegated to bounded subagents whenever the host can
dispatch them. The conversation orchestrator owns dispatch and ingestion control;
it should not perform broad review itself when subagents are available.
Entering `/audit-code` is explicit user authorization to fan out those review
subagents; do not require a separate delegation request before parallel
dispatch.

If the host cannot delegate to subagents, the conversation orchestrator may
complete exactly one assigned review task, ingest it through the provided backend
command, then stop so the user can rerun `/audit-code` from fresh context.
In that fallback path it should not prepare packet dispatch, probe alternate
backend subcommands, synthesize reports, or choose a smaller task; the first
pending task and the exact worker command are the boundary.
The backend writes a deterministic single-task fallback prompt for that case so
the orchestrator does not need to infer the first task from a broad batch prompt.

Subagent fan-out belongs to the host agent runtime rather than to repo-local
backend provider settings.

When dispatch-plan entries include provider-neutral complexity and
`model_hint.tier` metadata, a capable host may map those tiers to its own
subagent models. The backend should not prescribe concrete model names.

Bounded steps are a backend implementation detail, not the intended user experience.

## Embedded Prompt Payload

The prompt payload in `audit-code.prompt.md` remains the canonical instruction asset.

The intended user setup is one global package install:

```bash
npm install -g auditor-lambda
```

That makes `audit-code` available on `PATH` and seeds user-level command/skill
assets for hosts the package can safely update. The prompt self-bootstraps the
current repository before advancing the audit:

```bash
audit-code ensure --quiet
```

That idempotent bootstrap writes repo-local fallback/guidance assets for
supported hosts plus shared MCP setup guidance only when they are missing or
stale. Codex uses the global skill installed by npm rather than a repo-local
skill bundle.

Use the explicit installer for repair or forced refresh:

```bash
audit-code install
```

Use direct prompt import only when the target host still needs it after bootstrap.

## Repo-local fallback

The repository still exposes a backend CLI wrapper:

```bash
audit-code
```

from the target repository root.

When developing inside the `auditor-lambda` repository itself, prefer:

```bash
node audit-code.mjs
```

That keeps the run pinned to the local wrapper and local `dist/` output instead
of whichever global `audit-code` binary happens to be on `PATH`.

Debug one-step mode:

```bash
audit-code --single-step
```

## Backend mode note

For repo-local backend usage:

- omitted provider remains `local-subprocess`
- `local-subprocess` should stop cleanly once semantic review is needed and
  expose scoped task artifacts for the slash-command orchestrator
- `provider: "auto"` is the explicit opt-in best-effort routing mode
- explicit provider names remain available when an operator wants a specific backend

Those explicit provider names are backend compatibility bridges, not the intended default review owner.

## Development rule

Prefer the skill-first conversational contract over the CLI-first backend shape.
