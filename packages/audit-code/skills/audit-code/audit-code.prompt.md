---
description: Autonomous local loop code auditing - loads one backend-rendered audit step at a time
argument-hint: [target-dir]
allowed-tools: [Read, Bash, Glob, Grep, Agent]
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

Then ask the backend for exactly one next step. This is also the **capability
handshake**: report what you can dispatch to *right now* on every `next-step`
call, so the backend sizes review packets to your real model instead of a
conservative 32k floor. Report:

- `--host-max-active-subagents` — how many review subagents you can run in
  parallel (via the `Agent`/`task` tool). Without it the backend assumes serial
  dispatch and sizes waves to one packet at a time.
- `--host-models` — an ordered JSON array (lowest rank first) of the models you
  can dispatch subagents to *right now*, one entry per relative rank:
  `{"rank": "small"|"standard"|"deep", "context_tokens": N, "output_tokens": N}`.
  Ranks are relative capability labels that line up with each packet's
  `model_hint.tier` — never report model names to the backend. Report only ranks
  you can actually dispatch to; the backend partitions and budgets each packet
  against the window of the rank its risk routes it to. Discover the real
  windows, do not guess smaller-than-real values. Each entry may carry an
  optional opaque `model_id` (and `--host-model-id` is the single-model
  equivalent) used only to key per-model quota learning — it is never
  interpreted.
- `--host-context-tokens` / `--host-output-tokens` — single-model shorthand when
  every subagent runs on one model: the context window and output cap of that
  model. When `--host-models` is also given, the roster wins. Omit both and
  dispatch falls back to the conservative 32k default (many tiny packets).

```bash
audit-code next-step --host-max-active-subagents 4 --host-models '[{"rank":"small","context_tokens":32000,"output_tokens":8000},{"rank":"standard","context_tokens":200000,"output_tokens":32000},{"rank":"deep","context_tokens":200000,"output_tokens":64000}]'
```

Or with a single dispatch model:

```bash
audit-code next-step --host-max-active-subagents 4 --host-context-tokens 200000 --host-output-tokens 32000
```

`4` is a safe concurrency default for this host; raise it for more parallelism or
lower it under rate-limit pressure. The backend's learned quota adapts from
there. The token values should match the window of the model(s) dispatching the
packets (e.g. 200000 / 32000 for a 200k-context model).

When developing `auditor-lambda` itself, from the monorepo root use:

```bash
node packages/audit-code/audit-code.mjs next-step --host-max-active-subagents 4 --host-context-tokens 200000 --host-output-tokens 32000
```

Read the returned JSON only far enough to find `prompt_path`, then read and
follow only that prompt. Do not read packet prompts, schemas, command catalogs,
or handoff files unless the current step prompt explicitly instructs you to do
so.

If the returned step is a dispatch step, before launching subagents check
`progress.confirmation_recommended` in `steps/current-step.json`:

- If `progress.confirmation_recommended` is `true`, pause and ask the user:
  "Ready to launch **{progress.dispatch_summary}** — continue?"
  Wait for an affirmative reply before proceeding with subagent dispatch.
- If `progress.confirmation_recommended` is `false` (or absent), proceed
  immediately.

After the **first** `next-step` (the intake step) completes, confirm the audit
scope before proceeding. Read `scope_summary.json` from the `.audit-tools/audit/`
directory. It contains `repo_root`, `auditable_file_count`, `git_available`, and
`mis_scope_smells`. Then:

- Echo one informational line to the user:
  `Auditing <repo_root>, <auditable_file_count> files, git: <yes|no>`.
- If `mis_scope_smells` is **non-empty**, display each smell as a warning and ask
  `Auditing <repo_root>, <auditable_file_count> files, git: <yes|no> — proceed? (yes/no)`.
  Wait for an affirmative reply before the next `next-step`. If the user declines,
  stop and suggest the correct root (e.g. the ancestor git repo or monorepo root
  named in the smell).
- If `mis_scope_smells` is empty, the echo is informational only — continue
  automatically without interrupting the workflow.

Use MCP tools only as a compatibility adapter when direct shell access to
`audit-code next-step` is unavailable. The MCP `start_audit` and
`continue_audit` tools return the same one-step contract; they are not a
separate orchestration path.

When a step prompt tells you to continue, run `audit-code next-step` again with
the same capability flags (`--host-max-active-subagents`, `--host-models`,
`--host-context-tokens`, `--host-output-tokens`) and follow only the newly
returned `prompt_path`.

Stop when the current step prompt tells you to stop.
