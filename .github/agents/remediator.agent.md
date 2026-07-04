---
description: Plan and orchestrate /remediate-code through the next-step machine before making code changes.
---

# Remediate Code Agent

When the user asks to run or continue `/remediate-code`, follow the canonical loader below. Run `remediate-code next-step` directly when shell access is available, and treat the deterministic report as the final source of truth once the workflow completes.


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
- If the argument is conversational feedback, write it to a temporary file
  and pass that file with `--guidance-file <path>` (single-step bootstrap:
  the backend writes it to intake/conversation-start.md itself, idempotently).

For Claude-style command expansion, the raw user arguments are:

```text
$ARGUMENTS
```

Then ask the backend for exactly one next step. If you have a path argument,
use:

```bash
remediate-code next-step --input <path>
```

If you have conversational guidance to pass as a file, use:

```bash
remediate-code next-step --guidance-file <path-to-guidance-file>
```

Otherwise use:

```bash
remediate-code next-step
```

Every `next-step` call is also the **capability handshake**: report what you can
dispatch to *right now* so the backend sizes remediation waves and per-worker
context to your real model instead of a conservative 32k floor. Report:

- `--host-can-dispatch-subagents` — whether you can run callable subagents at all
  (via the `Agent`/`task` tool). Without it the backend runs remediation serially.
  Do **not** report a parallel-worker count: the backend owns concurrency (its
  token-budget gate plus any hard host cap it can detect, e.g. Codex
  `[agents].max_threads`) and runs uncapped when it detects none. An operator with
  a genuine fixed machine limit may pass `--host-max-concurrent N` as an optional
  override; it is never a value to guess.
- `--host-models` — an ordered JSON array (lowest rank first) of the models you
  can dispatch workers to *right now*, one entry per relative rank:
  `{"rank": "small"|"standard"|"deep", "context_tokens": N, "output_tokens": N}`.
  Ranks are relative capability labels that line up with each item's
  `model_hint.tier` — never report model names to the backend. Report only ranks
  you can actually dispatch to. Each entry may carry an optional opaque
  `model_id` (and `--host-model-id` is the single-model equivalent) used only to
  key per-model quota learning — it is never interpreted.
- `--host-context-tokens` / `--host-output-tokens` — single-model shorthand when
  every worker runs on one model: the context window and output cap of that
  model. When `--host-models` is also given, the roster wins. Omit both and
  dispatch falls back to the conservative 32k default. Use the actual numbers
  for your dispatch model — discover them, do not guess a smaller-than-real
  value.

```bash
remediate-code next-step --input <path> --host-can-dispatch-subagents --host-models '[{"rank":"standard","context_tokens":200000,"output_tokens":32000},{"rank":"deep","context_tokens":200000,"output_tokens":64000}]'
```

Or with a single dispatch model:

```bash
remediate-code next-step --input <path> --host-can-dispatch-subagents --host-context-tokens 200000 --host-output-tokens 32000
```

Read the returned JSON only far enough to find `prompt_path`, then read and
follow only that prompt. Do not read dispatch prompts, schemas, state files,
or result files unless the current step prompt explicitly instructs you to do
so.

When a step prompt tells you to continue, run `remediate-code next-step` again
(with the same capability flags) and follow only the newly returned `prompt_path`.

Stop when the current step prompt tells you to stop.
