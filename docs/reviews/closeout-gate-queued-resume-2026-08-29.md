# Closeout challenge on a terminated-but-unharvested task — diagnosis and fix proposal (2026-08-29)

An independent worker diagnosed the 2026-08-29 mid-sprint firing of `closeout-challenge-gate` and
measured the Stop payload on the current build (Claude Code 2.1.247). This record holds the
evidence and the fix design. The fix LANDED the same day, owner-approved (`f9c48223` — the
`pendingQueuedResume` leg, the `liveSessionWorkReason` vocabulary, the debug skip-log, and the
red-green hook cases); the two backlog entries this diagnosis merged and closed died with it. The
uncovered halves below are ACCEPTED residuals, stated in the predicate's own doc.

## The firing, traced

| time (UTC) | event |
|---|---|
| 16:43:48 | `run_in_background` PowerShell task launched (the release pipeline) |
| 16:43:52 | the task FAILED (its own pre-tag CI gate, exit 1) and its notification was enqueued |
| 16:44:20 | the agent's final turn text still said the pipeline was running (stale) |
| 16:44:23 | Stop fired; the gate challenged and spent one cap slot |
| 16:44:49 | the harness resumed the session and delivered the queued notification |

So the guard did not fail past a live task. The task was dead 31 seconds before the Stop.

## Measured payload shapes (probe recorder, same build)

- Live background task → `background_tasks: [{id, type: "shell", status: "running", …}]`. The
  field is present and the guard suppresses. This REFUTES the earlier hypothesis that the build
  omits the field.
- Task terminated, notification not yet harvested (the real-world shape) → `background_tasks: []`,
  and a second Stop follows seconds later once the harness resumes. Entries leave the array on
  process exit, not on harvest.

Conclusion: the predicate `sessionHasLiveBackgroundWork` (`scripts/shared/liveSessionWork.mjs`) is
correct on its own terms and blind to the case that matters — a Stop the harness will resume from
QUEUED input. The gate's header promises to skip a wait; the implementation keys on task liveness.

## The fix (landed `f9c48223`)

One edit in `scripts/shared/liveSessionWork.mjs`, additive leg on the same predicate — both Stop
gates already pass the whole payload, so no call-site changes:

- `pendingQueuedResume(transcript_path)`: a depth counter over the transcript's `queue-operation`
  records (`enqueue` → +1, `dequeue`/`remove` → −1). Depth > 0 at the Stop means the harness holds
  queued input it will deliver, so the Stop is a wait → suppress.
- It MUST be a depth counter, not id-matching: `dequeue` records carry no content and no task-id.
- No absent→idle inversion: the leg suppresses only on POSITIVE evidence. A missing, empty, or
  unreadable transcript yields false and the gate fires exactly as today.
- Suppression logging: when `AUDIT_TOOLS_HOOK_DEBUG` is set, append one JSONL line
  (`reason: live_background_task | queued_resume`) under `.claude/hooks/.state/closeout-challenge/`
  — this diagnosis needed a probe campaign only because a skip leaves no trace.
- Tests: extend `tests/shared/hook-session-gates.test.ts` (registered cover for this gate) — RED
  case: `background_tasks: []` plus an unabsorbed `enqueue` in the transcript must not fire; green
  case: after the matching `dequeue`, the gate fires; unit case: missing/unreadable
  `transcript_path` returns false.
- Do NOT relax `TERMINAL_TASK_STATUSES` — the existing test pins that a harvested terminal task
  still challenges, and that behavior is correct.

## Collisions

None found. `scripts/shared/**` is already claimed in the guard registry; the gate's registered
test file gains cases rather than a new file appearing; the suppression exits before the marker
read, so the 2x-per-session cap spends nothing on a suppressed Stop.

## Uncovered halves to declare if implemented

1. Flush race: a task dying within milliseconds of the Stop may not have its enqueue on disk yet —
   degrades to today's behavior (fires).
2. Stuck-positive depth: an enqueue that never gets a matching dequeue/remove suppresses for the
   rest of the session; a recency bound on counted operations is the tightening option.
3. Kind-agnostic: a queued USER prompt also suppresses — defensible (the harness resumes either
   way) and unavoidable, since dequeue records carry no discriminator.
