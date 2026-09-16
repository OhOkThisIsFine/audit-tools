# P66 — the shared dispatch lane reads a CLI lane's envelope as the answer, and throws on a running job

**Leg 3 (recurring-problem solutions). Proposal only — nothing in this
directory is applied.**

## What keeps happening

Every lane-backed leg of this routine reads its answer through ONE helper,
`scripts/shared/mcp-dispatch-lane.mjs`. That helper assumes two things about
the relay's reply that the relay no longer guarantees:

1. **The body is the lane's own output.** For a CLI rung (`agy-gemini`) the
   body is a conversation ENVELOPE — `{"conversation_id":…,"status":"SUCCESS",
   "response":"<the real answer>","duration_seconds":…,"usage":{…}}`. The
   caller parses the envelope, finds none of its own fields, and records the
   call as an error.
2. **A call never returns while the job runs.** `dispatch` is called with
   `waitMs = timeoutMs + 5000`, and the code comments that a `running` status
   "cannot happen". The relay's own tool description now states that a larger
   `waitMs` is CLAMPED to `routing.mcp.maxWaitMs` and the clamp is announced in
   the reply. So `running` happens, and the helper throws it away as a
   transport fault.

## Recurrence, counted

| Date | Leg-2 sweep | Errors | Note |
|---|---|---|---|
| 2026-09-06 | 1/1 classified | 0 | single entry |
| 2026-09-07 | 2/2 classified | 0 | single-digit pass |
| 2026-09-09 | 89/95 classified | 6 | first appearance |
| 2026-09-10 | 0/1 classified | 1 | whole pass lost |
| 2026-09-11 | 89/89 classified | 0 | every row free-pool |
| 2026-09-16 | 34/62 classified | 28 | 19 envelope, 9 running-job |

Tonight's 28 errors split exactly along the two mechanisms above: 19 read
"response did not match the triage schema (verdict=null, why, action)" and 9
read "dispatch returned a running job". The classified 34 were all served by
`free-pool`, whose body IS the raw answer — so the split is not lane quality,
it is which rung the ladder happened to pick.

The same helper is the routine's **second independent lane** for leg 1
(`docs/nightly-routine.md`, *Start inputs and execution lanes*). The first lane,
Codex, was quota-exhausted tonight until 2026-09-19 and was also quota-exhausted
on 2026-09-10. So on a night when Codex is dead, an envelope-blind reader is the
difference between an adversary pass and no adversary pass at all.

## The mechanism

Both halves live in one function, `openDispatchLane(...).dispatch`, and one
pure helper beside it.

1. **Unwrap the envelope.** In `parseDispatchAnswer`, after the header/body
   split, test the body for the CLI-lane envelope shape — a JSON object with a
   string `response` and a `conversation_id` — and return the inner `response`
   as the body when it matches. Everything else passes through untouched, so a
   raw-answer lane is unaffected. This is a recognition of one declared shape,
   not a guess: the relay documents the CLI rungs as returning their harness's
   own record.
2. **Poll instead of throwing.** On `status: running`, poll the server's
   `dispatch_status` until it reports a terminal state, then take the answer
   from `dispatch_result`, and only then give up — with the elapsed time and the
   job id in the error. The existing `DispatchLaneError` and the caller's
   errored/resume path are unchanged, so a genuinely stuck job still lands
   exactly where it lands today.

`scripts/shared/triage-backlog.mjs` needs no change under this proposal. Its
`buildTriageRecord` validation is correct and should stay strict; what it was
handed was the wrong document.

## What it would have caught

Tonight: 28 of 62 backlog entries, i.e. 45% of leg 2's corpus. On 2026-09-09: 6
of 95. It would not have helped 2026-09-10 (a different, single-entry failure).

## False-positive surface

The unwrap is the only risk: a lane whose REAL answer is itself a JSON object
carrying both `conversation_id` and a string `response` would be unwrapped by
mistake. No caller in this repo asks for such a shape — the triage schema is
`verdict`/`why`/`action` — and the test below pins a raw-answer body passing
through unchanged. The polling half has no false-positive surface; it can only
turn a thrown transport fault into an answer or into the same fault later.

## Files

- `dispatch-lane-envelope.test.ts` — the red test. It belongs at
  `tests/shared/dispatch-lane-envelope.test.ts` when applied; vitest excludes
  `.audit-tools/**`, so a test sitting here never runs.
- `RED-AT.txt` — the verbatim failure at HEAD `a2461a9b`, and an honest
  statement that the running-job half has no red test at HEAD.

## The owner's call

This is repo-local code in a nightly helper, not a doc fix and not a backlog
deletion, so leg 3's propose-only bound holds and the routine landed nothing.
