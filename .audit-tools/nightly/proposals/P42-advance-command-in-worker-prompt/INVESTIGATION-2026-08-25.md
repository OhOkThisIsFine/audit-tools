# Investigation — where the advance-command incidents actually happened (sol-2)

**2026-08-25. Re-targeted at audit-code per the owner's answer to subject `225930847089a734`.
The CORRECTION-2026-08-25.md premise stands: remediate-code's seven sites are driver-facing.**

## Verdict

The recorded incidents (a `charter_extraction` worker and a `systemic_challenge` round advancing
the loop, 2026-07-16, recorded in docs/backlog/open-bugs.md) were caused by the PRE-SPLIT worker
prompts. Before commit `2625563f` (2026-08-05, "always-materialized fan-out — no capability
branch in step rendering, every lane a file"), both lane prompt builders ended with the advance
instruction:

- 2625563f^ src/audit/cli/charterExtractionPrompt.ts:129-131 — "When the submission is
  written, run:" followed by the continue command.
- 2625563f^ src/audit/systemic/secondOrderAdversaryPrompt.ts:91-93 — the same text.

Commit `2625563f` removed the advance text from worker material: lane prompts are materialized as
separate files (src/audit/cli/fanoutLanes.ts), and the advance command lives only in the
driver-facing step plan (`allowedCommands` and stop conditions in src/audit/cli/nextStepCommand.ts,
persisted by `writeCurrentStep` in src/audit/cli/steps.ts).

## Verified at HEAD 2831f8f8

- `renderCharterKindLanePrompt` (src/audit/cli/charterExtractionPrompt.ts) — advance-free;
  pinned by tests/audit/charter-extraction-executor.test.ts (`not.toContain("next-step")`).
- `renderSecondOrderAdversaryPrompt` (src/audit/systemic/secondOrderAdversaryPrompt.ts) —
  advance-free; unpinned until this investigation. The pin now sits in
  tests/audit/systemic-challenge.test.ts, mirroring the charter pin.
- Generic worker packets (`buildPrompt`, src/audit/cli/dispatch/hostHandoff.ts) — advance-free at
  HEAD; the only next-step texts in the handoff module are ingestion-error and unaccept-results
  messages addressed to the driver. UNPINNED — this is the stated uncovered half. P41's
  prompt-contract registry is the natural home for a general guarantee.

## Consequence

- The open-bugs entry "A delegated step prompt can turn its executor into a second driver
  (2026-07-16)" is closed as shipped: its property — loop advancement is not expressible from the
  material a delegated executor is given — holds at HEAD, and both incident lanes carry a
  mechanical pin. The entry is deleted per the enforce-then-delete rule; this record is its close.
- P42 itself stays closed as superseded. Its remediate-code premise was false — see
  CORRECTION-2026-08-25.md.

Lane evidence: Codex investigation 2026-08-25, verified against source before landing — the
charter pin, the backlog entry text, and the historical prompt bodies via `git show` at
`2625563f^`.
