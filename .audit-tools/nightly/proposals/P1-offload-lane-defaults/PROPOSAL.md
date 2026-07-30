# P1 — the offload helper's DEFAULTS are the failing configuration, and the failure looks like model incapacity

**Leg 3 proposal. Nothing here has been landed.** Target file is out-of-repo:
`C:\Users\ethan\.claude\llm-call.mjs` (67 lines).

## The recurrence (counted, after adversarial correction)

The reviewer claimed 7 entries / 4 dates. The adversary found the count inflated: the
"glm fabricated verbatim quotes" incident is a *different* pattern (it appears twice, in
memory and at `docs/backlog.md:1523`), and one cited line
(`docs/reviews/dispatch-legibility-trace-2026-07-23.md:75`) records the **misdiagnosis**
("the bimodal-latency lane trap, not size"), i.e. it is evidence the trap exists, not
evidence of the pattern being recognised.

More importantly the adversary found **two of the four cited durable traps are already
fixed in the helper** and were being counted as live recurrence:

- `docs/backlog.md:1511` — "sets no `max_tokens` and `strict: true`" → the file sets
  `max_tokens` at L32 (`LLM_MAX_TOKENS` override) and explicitly refuses `strict:true`
  at L37-38 with a written rationale.
- `docs/backlog.md:1517` — the undici headers-timeout → fixed at L21-27 / L41-62
  (`node:http`, 30-min ceiling, `LLM_TIMEOUT_MS`).

**Honest live remainder: 2 distinct dates** — 2026-07-20 (no line numbers on inlined
files; glm answered "NOT VERIFIABLE" to eight consecutive citation checks) and 2026-07-24
(`docs/backlog.md:91`, the default schema is unfit for its most common use; an adversarial
review returned `findings: [""]` under a summary asserting three named bugs, at
`finish_reason=stop`). Still a pattern, on a much smaller evidence base than claimed.

That the two *fixed* traps stopped recurring is itself the evidence that fixing the one
call site works.

## Why it keeps happening

`llm-call.mjs` is the single chokepoint, and three of its defaults are the failure:

- **L11-20** — one hardcoded schema (`{summary, findings[], open_questions[]}`), no
  override flag. Every caller wanting a task-shaped schema must hand-roll a throwaway
  `node:http` POST, which is what `docs/backlog.md:91` is complaining about.
- **L9** — files inlined as raw text with no line numbers, so a model cannot cite.
- **L66-67** — `finish_reason` printed to **stderr**, exit **0** regardless. A piping
  caller drops the one signal that distinguishes a truncated answer from a complete one.

## Proposed mechanism — class (a), makes the trap unrepresentable

1. **`--schema <file|json>`** — keep the current generic shape as the default *only when
   the flag is absent*. Additive; a fit schema costs one flag instead of a throwaway script.
2. **Number inlined lines** (`N<TAB>source`) and say so in the system prompt, with
   `--no-line-numbers` for rewrite-shaped tasks.
3. **Print `TRUNCATED` on stdout for any non-`stop` finish, and exit non-zero on
   `finish_reason === "length"` specifically.**

⚠ **Item 3 is narrowed from the reviewer's version on the adversary's finding.** The
original said "exit non-zero when `finish_reason !== 'stop'`", which would also fail on
`tool_calls` and on providers returning a null/absent `finish_reason` — and
`docs/backlog.md:1540` records that `finish_reason` is `undefined` for error bodies.
Only `length` is unambiguously "you got cut off".

Class (b) was considered and rejected: a PreToolUse hook could pattern-match the
invocation but cannot see `finish_reason` (a *response* property) and cannot judge schema
fitness — strictly weaker than fixing the one call site everything goes through.

## What it would have caught

- (1) the 2026-07-24 `findings: [""]` adversarial review — generic container, analytical task.
- (2) the 2026-07-20 eight-consecutive-citation-refusal.
- (3) the 2026-07-19 truncated-batch misdiagnosis and the truncated doc-review digest.

## False-positive surface

- (1) zero — default shape unchanged, flag is additive.
- (2) the real one: a "rewrite this file and return it" call would receive numbered input
  and could echo numbers back. `llm write` is retired and the records show recon /
  extraction / review use only, so near-zero in practice; `--no-line-numbers` is the escape.
- (3) narrowed to `length`, so a legitimate non-`stop` termination is no longer failed.

## Companion cleanup (part of this proposal)

Retire the two stale durable traps that describe already-fixed behaviour:
`docs/backlog.md:1511` and `docs/backlog.md:1517`. Leaving them standing is what let this
proposal's first draft count remediated evidence as live recurrence — a second-order
instance of the same "prose decays" family.
