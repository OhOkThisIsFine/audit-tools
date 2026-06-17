# A8 provider-path validation — NIM provider + engine validation (working/checkpoint doc)

> Transient. Fold into HANDOFF/backlog at sprint end. Created 2026-06-17.

## What shipped this sprint
- **`OpenAiCompatibleProvider`** (`packages/shared/src/providers/openAiCompatibleProvider.ts`, committed
  `f74c53c`): a first-class, single-shot, API-driven worker (the `llm write` pattern as a provider). POSTs the
  node prompt to any OpenAI-compatible `/chat/completions` endpoint, applies the returned `{files,result}` into
  the worktree, writes `result` to `resultPath`. NIM is one config instance (no hardcoded model). Wired into
  PROVIDER_NAMES / factory / auto-resolution / config validation. 13 unit tests.
- **Control-plane guard** (follow-up commit): a worker's `files[]` entry under `.audit-tools/` is skipped — NIM
  reliably echoes the result file into `files[]` (the prompt says "write your result to <path>"), which would
  otherwise commit an artifact into the worktree and collide with live artifacts on cherry-pick. Regression test added.

## Why codex+NIM was a dead end (settled)
codex 0.140 dropped `wire_api="chat"`; NIM's Responses API rejects codex's core `namespace` tools. NIM's
chat-completions API is fine — only codex couldn't consume it. So we built a provider that talks chat directly.

## VALIDATION RESULTS (2026-06-17)
- **Real NIM provider smoke (green):** `gpt-oss-120b` followed the single-shot `{files,result}` contract exactly —
  produced a correct module + valid test + the precise result artifact; the provider applied them.
- **A8 in-process rolling engine over live NIM (green):** `tests/nim-rolling-e2e.test.ts` (gated `RUN_NIM_E2E=1`).
  Drove `driveRollingImplementDispatch` with `provider=openai-compatible` (NIM), 3 disjoint nodes:
  **2 landed via worktree→commit→verify→merge; the verify-fail node routed to triage (`blocked`), NOT
  false-resolved** (the f18138fe gate fires correctly on the provider path). "merged 2, 1 rejected." ✓
  This is the provider-path real-run the flip was waiting on — the ENGINE is proven.

## ⚠ KEY DISCOVERY — the engine is NOT wired into production routing
`driveRollingImplementDispatch` has **zero production callers** (grep: only its definition + comments + the new
test). `decideNextStep`'s implement routing (`nextStep.ts:1387+`) emits host-executed STEPS:
- `rolling_engine` ON + host can dispatch → `dispatch_implement_rolling` (host-subagent driver; validated f18138fe).
- host CANNOT dispatch → `implement_rolling_sequential` (the host runs the nodes ITSELF).
- else → `dispatch_implement` (classic host-fanned wave).

None call `driveRollingImplementDispatch`. So:
- **Flipping `rolling_engine` default-ON** only switches the conversation-first default to the host-subagent
  rolling driver (already validated). It does NOT engage the provider engine.
- **With `provider=openai-compatible` set today, NIM still wouldn't drive implement nodes** — production emits a
  host step, not the provider engine. The handoff's "nightly autonomy → the provider path" premise assumed a
  wiring that doesn't exist.

## DECISION NEEDED (asked Ethan)
To make NIM actually usable headlessly, the in-process provider engine must be WIRED into `decideNextStep`
(route to `driveRollingImplementDispatch` when rolling_engine is on AND a programmatic backend provider is
configured). Design crux to settle: when BOTH a dispatch-capable host AND a configured backend provider exist,
which driver wins? Options: (B) wire the provider engine in now, validate through the real next-step path, then
flip [recommended — the clean endpoint, makes NIM real]; (A) flip the host-subagent driver now, wire the
provider engine as the next item.

## Status
- [x] NIM endpoint live; `OpenAiCompatibleProvider` built + unit-tested (`f74c53c`).
- [x] Control-plane guard + regression test.
- [x] Provider engine validated end-to-end over live NIM (gated e2e green).
- [ ] Wire the provider engine into `decideNextStep` (pending scope confirm).
- [ ] Flip `rolling_engine` default-ON.
- Publish: HELD per Ethan (2026-06-17).

## Cleanup owed
- `~/.codex/nim.config.toml` is dead (codex+NIM doesn't work) → remove.
- Temp scratch: `%TEMP%/nim-codex-smoke*`, `_nim_smoke.mjs`.
