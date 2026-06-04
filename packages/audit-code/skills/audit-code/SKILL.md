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
dispatch — unless `confirmation_recommended` is true (agent_count exceeds
`sessionConfig.dispatch.confirm_threshold`, default 10), in which case pause for
user confirmation.

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

### Scope confirmation

The loader emits a scope summary after the intake step (the first `next-step`):
the resolved repo root, the auditable file count, whether git is available, and
any mis-scope smells. It echoes `Auditing <root>, <N> files, git: yes/no` so the
operator can see exactly what is about to be audited. When a mis-scope smell is
set — the resolved root has no `.git` but an ancestor does, or the root is a
workspace member of a parent monorepo — the loader pauses and requires explicit
confirmation before continuing. Expect the workflow to pause on the first step
when targeting a workspace subdirectory or a non-git root whose ancestor is a
repo; in the normal case the echo is informational and the run proceeds without
interruption. Resolution behaviour is unchanged — only the visibility and the
confirm gate are added.

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

When developing `auditor-lambda` itself, prefer the local wrapper at
`packages/audit-code/audit-code.mjs` (there is no `audit-code.mjs` at the
monorepo root):

```bash
node packages/audit-code/audit-code.mjs   # from the monorepo root
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
