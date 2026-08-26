# Why agents almost never produce the closeout correctly — 2026-08-26

Scope: the rendered end-of-sprint hand-back introduced on 2026-08-20 (`2db6494b`,
`9a1a766d`), its input registry (`scripts/closeout-sections-data.mjs`), its renderer
(`scripts/render-closeout.mjs`), and its Stop-hook enforcement
(`.claude/hooks/closeout-challenge-gate.mjs`).

## Measurement

Source: `~/.claude/projects/C--Code-audit-tools/*.jsonl`, parsed for `render-closeout.mjs`
tool calls and their results, and for Stop-hook challenge text.

| Metric | Value |
| --- | --- |
| Sessions that fired the closeout challenge since 2026-08-18 | 29 |
| Of those, sessions that ran `render-closeout.mjs --in` | 10 |
| Of those, sessions that hand-wrote the report instead | **19 (66%)** |
| Renderer invocations, all sessions | 63 |
| Renderer refusals: "every section must be stated" | 11 |
| Renderer refusals: "unknown section id(s)" | 2 |
| Gate findings: "the closeout render on record is for <old head>" | 16 |
| Gate findings: "no rendered closeout on record for this tree" | 3 |

The last two rows are the tell. 19 sessions hand-wrote the report, but the gate reported a
missing render only 3 times. The enforcement did not see 16 of the 19 misses.

## Root cause 1 — the Stop hook states the opposite of the input contract

The renderer's **input** requires the literal `"none"` for every silent section. The Stop
challenge's stderr is the loudest and latest instruction an agent reads at closeout time, and
it says (`closeout-challenge-gate.mjs:328`):

> Then RE-RENDER the whole closeout report **to the scheme in
> docs/end-of-sprint-report-template.md** … a line or section with nothing to report is
> OMITTED, **never written out as "none"** and never explained.

Two defects in one sentence:

1. It does not distinguish the input from the output. "Never written out as `none`" is true of
   the rendered markdown and false of the JSON input. The agent applies it to the input.
2. "RE-RENDER … to the scheme in `<doc>`" reads as an instruction to write markdown by hand
   against a scheme. The word "render" is doing double duty for "run the renderer" and "compose
   the report".

The result is the observed behavior: the agent hand-writes a report that omits its silent
sections. That output is byte-similar to what the renderer produces, so it looks correct, and
no HEAD-bound record is written.

## Root cause 2 — the blank template cannot be rendered, and its refusal gives a forbidden instruction

`--template` is the documented starting point. It emits:

```json
{ "verification": [""], ..., "landed": [""], ... }
```

`verification` and `landed` are the two `required: true` sections. Rendering the unedited
template fails with:

```
render-closeout: empty value(s) for: verification, landed. Write the literal "none" to fall
silent on purpose — an empty string or array is indistinguishable from forgetting.
```

Following that instruction produces a second refusal:

```
render-closeout: section "verification" is required and may not be "none"
```

The `emptied` branch (`render-closeout.mjs:180`) does not check `section.required` before it
recommends `"none"`. The documented entry point is therefore a two-step contradiction. Verified
by direct execution on 2026-08-26.

## Root cause 3 — the enforcement record is repo-global and HEAD-keyed

`.claude/hooks/.state/closeout-render/latest.json` is a single file for the whole repo. The gate
(`closeout-challenge-gate.mjs:210-222`) compares only `rec.head` against the current HEAD. It
never compares `rec.session_id`, and `session_id` is `null` in the live record because
`CLAUDE_SESSION_ID` is not present in the renderer's environment.

Consequence: once any session renders at HEAD X, every later session that stops at HEAD X passes
the check silently. This is why 19 hand-written closeouts produced only 3 "no rendered closeout"
findings. The claim in `docs/end-of-sprint-report-template.md` — "hand-writing the report instead
is not a quiet way around the check" — is not true as built.

## Root cause 4 — render-then-commit invalidates the render, and no document states the order

The closeout requires committing the HANDOFF trim, the backlog update, and the memory sync. The
record binds to HEAD at render time. An agent that renders before that commit moves HEAD, and the
gate then reports:

> the closeout render on record is for `<X>`, not the current `<Y>` — re-render it

That finding appears 16 times. No document states when to render relative to the final commit.
`CLAUDE.md:230` lists the render as step 7 of 7 but does not say it must follow the last commit,
and the template doc does not mention ordering at all. A re-render after the commit also produces
a second, different hand-back in the same chat, which is itself a defect in the hand-back.

## Root cause 5 — the section prose invites invented ids

`docs/end-of-sprint-report-template.md` describes Cleanup as "…and any **deliberate** intermediate
state called out". Two sessions created a `deliberate_state` key and were refused with
`unknown section id(s): deliberate_state`. The prose names a concept that is not a section id.

## What is not the cause

- The renderer's validation logic is sound. When agents reach it with a real input, it works: 63
  invocations, 6 failures, and 3 of those 6 were deliberate negative tests or unrelated hook
  errors.
- The bottom-weighted section order and the required/silent split are not implicated in any
  observed failure.

## What was changed

Owner decisions taken in session, 2026-08-26: bind the record to the tree rather than to HEAD, and
fix all five defects.

| Defect | Fix | Where |
| --- | --- | --- |
| 1 | The Stop challenge names the renderer command and states both halves of the `"none"` rule — every section carries a value in the INPUT, the silent ones are omitted from the OUTPUT. The "RE-RENDER … to the scheme in `<doc>`" phrasing is gone. | `.claude/hooks/closeout-challenge-gate.mjs` |
| 2 | The empty-value refusal splits by disposition. A required section is told what to fill in and is never told to write `"none"`. | `scripts/render-closeout.mjs` |
| 3 | The gate compares the record's `rendered_at` against the session registry's `registered_at`. A render that predates this session is reported as another session's hand-back. | `.claude/hooks/closeout-challenge-gate.mjs` |
| 4 | The record binds to a worktree tree-object id. Committing exactly what the report described keeps it valid; an edit after the render invalidates it. A pre-v2 record falls back to the HEAD comparison for the one session that spans the upgrade. | `scripts/shared/worktree-tree.mjs` (new), `scripts/render-closeout.mjs`, `.claude/hooks/closeout-challenge-gate.mjs` |
| 5 | Every section bullet names its input key. The Cleanup prose no longer reads as a separate key. | `docs/end-of-sprint-report-template.md` |

The record format is now `version: 2` and carries `tree`.

Regression tests, in `tests/shared/closeout-render.test.ts`:

- the blank `--template` refusal never tells a required section to write `"none"`;
- the record binds to worktree content — a temp repo renders with an uncommitted `HANDOFF.md`,
  commits it, and the recorded tree still matches while HEAD has moved.

`tests/shared/hook-session-gates.test.ts` now pins the renderer command and both halves of the
`"none"` rule instead of the doc name — the old assertion pinned the wording that caused defect 1.

Verified on 2026-08-26: `npm run build`, `npm run check`, `npm run check:scripts`,
`npm run check:tests`, `npm run check:guard-reach`, and `npm test` (451 files, 5996 tests) all green.
