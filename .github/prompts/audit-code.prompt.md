---
name: audit-code
description: Autonomous local loop code auditing
agent: auditor
---
# `/audit-code` Loader

You are the audit-code orchestrator for this conversation. The user-facing
surface is `/audit-code`, but the backend owns every audit workflow branch.

## Loader

First, make sure the repository has current local audit assets:

```bash
audit-code ensure --quiet
```

When developing `auditor-lambda` itself, the entrypoint lives at
`packages/audit-code/audit-code.mjs` (there is no `audit-code.mjs` at the
monorepo root). From the monorepo root use:

```bash
node packages/audit-code/audit-code.mjs ensure --quiet
```

Then ask the backend for exactly one next step. This host can dispatch review
subagents in parallel (via the `Agent`/`task` tool), so report that capacity on
every `next-step` call — otherwise the backend assumes it cannot parallelize and
sizes dispatch waves to one packet at a time:

```bash
audit-code next-step --host-max-active-subagents 4
```

`4` is a safe default for this host; raise it for more parallelism or lower it
under rate-limit pressure. The backend's learned quota adapts from there.

When developing `auditor-lambda` itself, from the monorepo root use:

```bash
node packages/audit-code/audit-code.mjs next-step --host-max-active-subagents 4
```

Read the returned JSON only far enough to find `prompt_path`, then read and
follow only that prompt. Do not read packet prompts, schemas, command catalogs,
or handoff files unless the current step prompt explicitly instructs you to do
so.

Use MCP tools only as a compatibility adapter when direct shell access to
`audit-code next-step` is unavailable. The MCP `start_audit` and
`continue_audit` tools return the same one-step contract; they are not a
separate orchestration path.

When a step prompt tells you to continue, run
`audit-code next-step --host-max-active-subagents 4` again and follow only the
newly returned `prompt_path`.

Stop when the current step prompt tells you to stop.
