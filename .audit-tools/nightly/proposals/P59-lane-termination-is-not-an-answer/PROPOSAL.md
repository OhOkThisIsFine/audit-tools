# P59 — A lane that terminated without an answer is handed back as an answer

**Scope: MACHINE-WIDE.** The boundary is llm-relay's `dispatch` / `dispatch_result`
MCP result and the `relay` subagent's return. Every repository's sessions cross it.
The work item belongs in `C:\Code\docs\backlog.md`, not in this repo's backlog.

**No patch attached, deliberately.** The owner is being asked WHICH FORM the
verdict takes, and the candidate forms share no code. See *The open choice* below.

## The recurrence

Nine records across six distinct dates describe one shape: a lane process
terminates successfully, returns nothing usable, and the caller cannot tell that
apart from a correct answer. All quotes verified at their cited source.

| Date | Source | What was returned |
|---|---|---|
| 2026-09-09 | `C:\Code\docs\backlog.md`, Standing traps | `job-0005` "reported completed/exit 0 after 765 seconds but returned only `I`" |
| 2026-09-07 | `C:\Code\docs\backlog.md`, Standing traps | "agent-mode jobs exited after 302s and 623s with only `Now` and `Let`" |
| 2026-08-31 | `C:\Code\docs\backlog.md`, Standing traps | "`codex exec` can return an EMPTY answer with exit 0 … the process exits 0" |
| 2026-08-31 | `C:\Code\docs\backlog.md`, Open items | "`functions.wait` can report spawned-command completion while descendants remain running" |
| 2026-08-28 | `docs/backlog/durable-traps.md` | "Two offload lanes fail SUCCESS-SHAPED, and neither reports why in its status" |
| 2026-08-25 | `docs/backlog/durable-traps.md` | "A spend-limit death returns a workflow as `completed` with a success-shaped empty result" |
| 2026-08-09 | `docs/backlog/durable-traps.md` | "A free-pool reply that returns nothing usable is usually `finish_reason: max_tokens`" |

Three project-memory entries exist whose entire content is *classify the empty
answer by hand*: `workflow-spend-limit-death-is-success-shaped`,
`empty-offload-reply-is-usually-max-tokens`,
`offload-classify-failure-by-output-size`. Three memories teaching one manual
classification is the signal that the classification belongs in the tool.

## The mechanism

Make "an answer" unrepresentable for a lane that produced none, at the one
boundary every host already crosses. Today the return is an answer string plus a
process status, so the caller reconstructs failure from stderr, byte count and
`finish_reason` — exactly what those three memories teach by hand.

Replace it with a discriminated outcome the server computes. `answered` requires
a terminal stop reason of `end_turn` AND an answer above a declared floor.
Anything else returns `terminated_without_answer`, carrying the reason
(`max_tokens`, `spend_limit`, `zero_stdout`, `preamble_only`,
`descendants_alive`), the stderr tail, the byte count, and — for agent-mode
lanes — the worktree diff status. The relay already holds every one of these
facts when it decides the job is done; the defect is that it discards them into a
string. A caller then cannot paste an empty answer forward, because there is no
field to paste from.

The classification must be ADDITIVE: the answer text is still returned beside the
verdict, so a caller who asked a yes/no question still reads "yes".

## What it would have caught

- The 765-second job whose whole answer was `I`, and the 302 s / 623 s jobs
  answering `Now` and `Let`. All three are below any answer floor and all three
  had clean worktrees, so all three would have returned
  `terminated_without_answer` instead of being read as results.
- The 2026-08-28 pool lane that never started — zero stdout, `unrecognized_model`
  on stderr — would have named its own stderr tail at the 900 s mark rather than
  when someone thought to look.
- The 2026-08-25 fan-out that returned `{clusters: [], tally: {surviving: 0,
  refuted: 0}}` under a spend limit would have been
  `terminated_without_answer: spend_limit`, not a zero-finding result standing as
  evidence of absence.

## False-positive surface

A genuinely short correct answer — "yes", a version string, a single symbol name
— trips the answer floor. That is real, and it is why the floor must be a
declared per-mode threshold and why the verdict must be additive rather than
replacing the text. The residual risk is a caller learning to ignore the verdict;
the counter is that the verdict names a concrete reason instead of being a
generic warning. Secondarily, `descendants_alive` can fire on a benign detached
child.

## The open choice

Three forms, sharing no code:

1. **Server-side verdict** — the relay computes the discriminant and every host
   gets it for free. Highest value, largest change, and it needs an answer floor
   per lane mode.
2. **Client-side classifier** — a shared helper in `~/.agent-config/` that every
   caller runs over a returned result. Smaller, but it is opt-in, so it is
   exactly the *host must remember* shape this machine's own conviction bans.
3. **Reason passthrough only** — the relay stops discarding `finish_reason`,
   stderr tail and byte count, and states them beside the answer without judging.
   Cheapest and has no false-positive surface at all, but it leaves the
   classification to the reader, which is what the three memories already do.

## Checked against existing proposals

P5 (triage lane masks a 429 — same family, scoped to one repo script's error
string, already settled), P36 (lane-liveness probe — session start, not the
return boundary), P46 (one broken provider eats leg 2), P49 (leg-2 lane candidate
fallback), P21 (dispatch piped into a buffering filter — the view, not the
value), P17 (fabricated triage record). Also checked against the settled nightly
decisions "A dropped dispatch lane is a stderr line, not a value" (2026-07-28,
in-repo sibling path) and the 2026-07-29 affirmation contract that closed
success-shaped-empty for `AuditResult` — audit-tools executors only; the lane
boundary was never carried.

Related but distinct: [P58](../P58-lane-probe-cannot-resolve-a-shim/PROPOSAL.md)
is the same honesty property one step earlier, at lane PROBING rather than lane
RETURN.
