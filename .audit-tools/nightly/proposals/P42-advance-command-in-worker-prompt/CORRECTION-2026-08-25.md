# Correction — P42's seven cited sites are DRIVER-facing, not worker-facing

**Nightly 2026-08-25. Written before applying the owner's answer; the answer was NOT applied.**

The owner answered subject `26e2d10e4569b448` with *"Remove the advance command from the
worker-facing prompt at all seven sites; it lives in the driver-facing step contract only."*
Verifying the seven sites before editing them falsified the premise the answer rests on.

## What the seven sites actually are

`src/remediate/steps/prompts.ts` exports seven prompt builders. Every one of them is passed as
the `prompt:` field of `writeCurrentStep({ … })`, which renders
`.audit-tools/remediation/steps/current-prompt.md` — the DRIVER-facing conversation prompt the
host reads, not a delegated worker packet:

| builder | consumer |
|---|---|
| `clarificationPrompt` | `src/remediate/steps/nextStep.ts:2566` |
| `ambiguityReviewPrompt` | `src/remediate/steps/nextStep.ts:2778`, `:2815` |
| `reviewApprovalPrompt` | `src/remediate/steps/nextStep.ts:1539` |
| `triagePrompt` | `src/remediate/steps/nextStep.ts:2589` |
| `collectStartingPointPrompt` | `src/remediate/steps/nextStep.ts:2308`, `intakeResolver.ts:104` |
| `synthesizeIntakePrompt` | `src/remediate/steps/intakeResolver.ts:414`, `:445` |
| `collectIntakeClarificationsPrompt` | `src/remediate/steps/intakeResolver.ts:387`, `:472` |

All seven are operator-interactive steps (`status: "blocked"`) whose whole purpose is to hand the
driver a question and then be advanced by that same driver. Telling the driver to advance is
correct there.

## The delegated worker packets do not carry the command

Grepped both host-handoff modules — `src/audit/cli/dispatch/hostHandoff.ts` and
`src/remediate/steps/dispatch/hostHandoff.ts` — for the advance command inside worker material.
The only occurrences are in ingestion-error and unaccept-results messages addressed to the driver.
No delegated worker prompt tells its executor to advance. The trap P42 describes is not
representable in worker packets at HEAD.

## Where the recorded incidents actually happened

P42's recurrence evidence names a `charter_extraction` worker and a `systemic_challenge` round —
both **audit-code** obligations. P42 then cited a **remediate-code** file. The citation and the
incidents are not about the same material.

## Consequence

Applying the answer literally would delete the advance cue from seven driver-facing prompts,
leaving `allowedCommands` in `current-step.json` as the only carrier, and would address none of
the three recorded incidents. The routine therefore applied nothing and escalated the premise as
a new subject.
