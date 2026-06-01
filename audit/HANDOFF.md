# Audit-tools self-audit — handoff

Date: 2026-06-01. Produced by running `/audit-code` on this repo itself, with a
simultaneous **meta-audit** of the experience of running the tool.

This folder is the deliverable set. Start here.

## Contents
- `HANDOFF.md` — this file (what was done, what's fixed, what's left).
- `meta-audit.md` — chronological friction log of running audit-code (the "issues I ran into").
- `audit-report.md` — the static audit of the codebase: **404 findings** (27 high / 127 medium / 235 low / 15 info) across 394 files, 3 work blocks. Advisory — verify before acting.
- `audit-findings.json` — the canonical machine contract for the same findings (feed to `/remediate-code`).

## Fixes applied THIS session (committed alongside this folder)
Both are easy, low-risk wins for issues hit while running the tool, with tests; full suites pass (shared 41 / audit-code 546 / remediate 381).

- **A — Windows EPERM retry in the shared atomic writer.** `packages/shared/src/io/json.ts`: `writeFileAtomic` now wraps the temp→final `rename` in `withFsRetry` (bounded 20ms→250ms backoff on EPERM/EBUSY/EACCES/EEXIST). Test: `packages/shared/tests/io-json-retry.test.mjs`.
- **B — File-type misclassification.** `packages/audit-code/src/extractors/fileInventory.ts`: an override map fixes `.md`→`markdown` (was "gcc machine description") and `.yml`/`.yaml`→`yaml` (was "miniyaml"); extension match is now case-insensitive. Test: `packages/audit-code/tests/file-inventory-language.test.mjs`.

## Remaining issues, prioritized (NOT fixed — need more than an easy win)

1. **Finalization oscillation (HIGH).** After ingestion, the deterministic advance loop ping-pongs between the `runtime_validation_current` and `synthesis_current` obligations (observed iteration 708 and 891 of the 1000 cap) and never converges. Synthesis DOES render the complete report before the loop dies, so the crash hides a success. Fix A stops the *Windows EPERM crash* that resulted, but the oscillation itself remains. Root cause is in the staleness DAG: `src/orchestrator/staleness.ts`, `src/orchestrator/artifactMetadata.ts`, the advance loop in `src/orchestrator/advance.ts`, and the obligation graph in `src/orchestrator/dependencyMap.ts` (runtime_validation_report.json is consumed widely; something synthesis touches re-marks runtime_validation stale, or vice versa). **This is the #1 thing to fix next.**
2. **`wave_size` miscalculation (HIGH, known/recurring — you said fix later).** Model detection fails (`dispatch-quota.json`: `model:null`, `source:"provider_default"`, 32k ctx) → `estimated_wave_tokens` (~32k) exceeds the budget → forced serial `wave_size:1`. Inside Claude Code (~200k ctx) this is pathological. Workaround used: manual parallel dispatch.
3. **Account session-limit invisible to the audit's quota system (HIGH).** When the host account hit its usage cap mid-run, worker subagents returned a "session limit" sentinel with 0 tokens; merge-and-ingest treated those as normal missing results. Workers should detect a host-limit sentinel and treat it as retryable/paused, not a failed task.
4. **`ensure` has no preflight/doctor + dirties the tree (MEDIUM).** In a fresh git worktree, nothing detects missing `node_modules`/`dist`/workspace symlink, so the first commands fail with a raw `ENOENT` or 16 misleading "missing export" TS errors (tsc resolves `@audit-tools/shared` against the *main* checkout's stale `dist`). Separately, `ensure` regenerates the slash-command/skill assets (`.agent`, `.gemini`, `.github`, `AGENTS.md`, `opencode.json`, the `.mjs` wrappers) and writes them with **CRLF**, dirtying the working tree on every run. (Those regenerations were reverted from this commit; note the committed assets are slightly stale vs. what the generator now emits — the generator update fixes the `node audit-code.mjs` path-ambiguity doc.)
5. **`spurious_file_count` inflation (MEDIUM).** `merge-and-ingest` (`src/cli.ts` ~line 730) flags every task-results file not in the *current* round's dispatch plan as "unexpected", so prior deepening rounds' valid results inflate the count (3 → 191 over the run). A correct fix must distinguish prior-round results (proper `<unit>_<lens>_part-N_<hash>.json` naming) from genuinely stray files — left undone to avoid silencing the real worker-hygiene signal.
6. **Workers write stray result files to the repo root (MEDIUM).** Several subagents left `packet-*-result.json` / `audit_result_packet*.json` in the repo cwd (deleted during cleanup). The submit path resolution / worker prompt should keep all output inside the artifacts dir.

## Notes
- Remote default branch is `master` on the `audit-tools` remote (not `origin/main`).
- The audit's machine outputs live (gitignored) in `.audit-artifacts/`; this folder is the durable copy.
