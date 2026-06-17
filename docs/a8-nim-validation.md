# A8 provider-path validation — NIM investigation (working/checkpoint doc)

> Transient. Fold into HANDOFF/backlog at sprint end. Created 2026-06-17.

## Goal
Validate the A8 **in-process provider** rolling-dispatch path end-to-end WITHOUT waiting for
the Jun-19 codex/ChatGPT quota reset (Ethan: "forget the live run on the 19th"). Gate before
flipping `rolling_engine` default-ON: a real provider drives ≥2 disjoint nodes through
worktree→commit→verify→merge AND a verify-fail routes to **triage** (not false-resolve).

## FINDING (2026-06-17): codex + NIM is a DEAD END
- A8 in-process path needs an **agentic CLI** that edits files in the worktree; NIM is a raw
  OpenAI-compatible endpoint, not an agentic CLI → can only work *through* an agentic CLI.
- codex-cli **0.140.0 dropped `wire_api="chat"`** (→ discussion 7782); it now speaks ONLY the
  OpenAI **Responses** API.
- NIM **does** implement `/v1/responses` for `openai/gpt-oss-120b` (plain-text probe OK), BUT its
  Responses impl **rejects codex's core tool palette**: `tools[9].type=='namespace'` →
  "Input should be 'function'" (108–126 validation errors). Persists even with
  `--ignore-user-config` (plugins/MCP stripped) → the `namespace` tool is codex-core, not config.
- ∴ codex cannot drive NIM. Verified on this machine, codex 0.140.0, key `NVIDIA_API_KEY`.
- NIM's **chat-completions** API is fully fine — only codex can't use it. No other wired provider
  can consume it either (opencode could, but it's uninstalled + deliberately removed).

## Consequence — two real paths to validate A8 (the fork)
1. **claude-code now** — drive a real `claude -p` provider-path rolling smoke (CLAUDECODE-unset,
   provider pinned, `rolling_engine=true`). Zero new code, uses Claude quota (headroom confirmed),
   unblocks the flip today. NIM 2nd-pool becomes its own build later.
2. **Build a NIM chat-completions agentic provider** (Explore "option C") — thin
   `OpenAiCompatibleProvider`: NIM `/v1/chat/completions` + tool-loop → apply edits in worktree →
   result contract; base_url/model/key in sessionConfig (no hardcoded model). Validates A8 AND
   delivers the long-missing real 2nd pool for INV-QD-14 spill. Bigger; flip waits on it; means
   owning an in-house agentic loop (a departure from "shell out to mature agent CLIs").
3. **Both** — validate+flip via claude-code now, build NIM provider this sprint as the 2nd pool.

## Cleanup owed
- `~/.codex/nim.config.toml` is dead (codex+NIM doesn't work) → remove.
- Temp scratch: `%TEMP%/nim-codex-smoke*`.

## Status
- [x] NIM endpoint live, `NVIDIA_API_KEY` valid (121 models); `/v1/responses` works for gpt-oss.
- [x] codex+NIM proven non-viable (tool-schema rejection) — see FINDING.
- [ ] Path chosen by Ethan.
- [ ] A8 provider-path validated (≥2 nodes worktree→verify→merge + verify-fail→triage).
- [ ] Flip `rolling_engine` default-ON; full green; docs/memory.
- Publish: HELD per Ethan (2026-06-17).
