# P28 — offload / peer-CLI dispatch scope is unbounded at the call site; the standing remedy is prose only

Nightly leg 3, 2026-08-13. Queue item `sol-3`. Propose-only. **Strongest recurrence in the store.**

## The defect

Nothing bounds how much work one offload or peer-CLI call asks for. Over-scope it and the lane
does not fail cleanly — it returns nothing, truncates mid-response, or dies — and the entire
answer is lost, including read-only work already completed. The standing remedy is
"one bounded unit per dispatch", and it lives in prose, so every caller has to remember it.

## Recurrence — counted: 6 backlog entries + 4 memories, 6 distinct dates

| Date | Incident |
|---|---|
| 2026-07-23 | Offload lane degrades on two axes — payload SIZE and CONCURRENCY (`durable-traps.md`, record `docs/reviews/worker-kind-pool-class-rule-2026-07-23.md`). |
| 2026-07-28 | An 836-line call returned HTTP 504. |
| 2026-08-07 | Long offload recon jobs die mid-response; short ones do not. |
| 2026-08-09 | 15,532 output tokens discarded on an agy refutation — "the variable is job LENGTH, not the lane". |
| 2026-08-09 | 7 of 7 contract-drafting jobs returned nothing usable — `finish_reason: max_tokens`, budget spent reasoning out loud. |
| 2026-08-09 / 08-10 | A broad multi-file review scope killed both peer-CLI lanes — four deaths in two nights. |

Memories: `offload-lane-failures-are-usually-the-caller`, `nim-offload-reliable-unit-is-one-entry`,
`offload-classify-failure-by-output-size`, `pool-lane-needs-verification-shaped-prompts`.

## Mechanism — prefer the fix over the guard

The repo already implements the correct shape **exactly once**:
`scripts/shared/triage-backlog.mjs` dispatches one entry per call, preflights the lane once (a
dead lane aborts at entry 0 with the router's own error), and writes a `<out>-coverage.json`
stamp beside the output as it runs. Nothing generalizes it.

**Extract that driver** into `scripts/shared/dispatch-peer-cli.mjs`: takes a list of bounded
items, runs one call per item, redirects each to its own log, records `finish_reason` and output
size per item, and emits the coverage stamp. The over-scoped mega-prompt then stops being
something a caller can express, rather than something a caller must remember not to write.

**Optional guard half** (secondary, because ad-hoc Bash calls bypass any script): a
`shell-trap-guard` rule denying a `codex exec` / `agy -p` statement whose prompt names more than
N repo paths or exceeds K characters, pointing at the wrapper.

## What it would have caught

The four 2026-08-09/10 lane deaths; the 15k-token agy discard; the 836-line 504; the seven lost
contract-drafting jobs.

## False-positive surface — the two halves differ sharply

The **wrapper** half has no false-positive surface: it is a library, not a refusal.

The **guard** half does. A genuinely long single-item prompt — a design-check refutation over one
large file — is legitimate and would trip a char/path heuristic, so the guard needs a bypass env.
And the store already records that an advisory with a bypass gets set reflexively
(`an-advisory-that-fires-and-is-read-past`). Rank the wrapper first; treat the guard as optional.

## Not authored this run

No patch written. The extraction is a real refactor with a live consumer
(`triage-backlog.mjs` runs every night), so it wants a design pass rather than an overnight diff.
