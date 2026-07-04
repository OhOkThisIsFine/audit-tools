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

When developing `audit-tools` itself, the entrypoint lives at
`audit-code.mjs` (at the repo root). From the repo root use:

```bash
node audit-code.mjs ensure --quiet
```

Then ask the backend for exactly one next step. This is also the **capability
handshake**: report what you can dispatch to *right now* on every `next-step`
call, so the backend sizes review packets to your real model instead of a
conservative 32k floor. Report:

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

Do **not** report a parallel-subagent count. The backend owns concurrency: it
sizes how many subagents run at once from its own token-budget gate and from any
hard host cap it can detect (e.g. Codex's `~/.codex/config.toml`
`[agents].max_threads`). When it detects no hard cap it runs without one — you
never supply or guess a number. (An operator with a genuine fixed parallel limit
for this machine may pass `--host-max-active-subagents N` as an optional
override; it is not part of the handshake and is never something to invent.)

```bash
audit-code next-step --host-models '[{"rank":"small","context_tokens":32000,"output_tokens":8000},{"rank":"standard","context_tokens":200000,"output_tokens":32000},{"rank":"deep","context_tokens":200000,"output_tokens":64000}]'
```

Or with a single dispatch model:

```bash
audit-code next-step --host-context-tokens 200000 --host-output-tokens 32000
```

The token values should match the window of the model(s) dispatching the packets
(e.g. 200000 / 32000 for a 200k-context model).

When developing `audit-tools` itself, from the repo root use:

```bash
node audit-code.mjs next-step --host-context-tokens 200000 --host-output-tokens 32000
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

When a step prompt tells you to continue, run `audit-code next-step` again with
the same capability flags (`--host-models`, `--host-context-tokens`,
`--host-output-tokens`) and follow only the newly returned `prompt_path`.

Stop when the current step prompt tells you to stop.
