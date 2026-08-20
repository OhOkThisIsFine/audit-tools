# End-of-sprint report — template

The markdown scheme for the closeout hand-back at the end of every sprint (see the
*End-of-sprint cleanup* step in [`CLAUDE.md`](../CLAUDE.md)). The report is **rendered in
chat** as the hand-back; its durable pieces are simultaneously written to their permanent
homes (`docs/HANDOFF.md`, `docs/backlog.md`, project memory). This template is **timeless
structure, not a persisted instance** — do NOT commit a dated, filled-in copy into the tree
(that would be the changelog/status-doc creep the [documentation philosophy](documentation-philosophy.md)
forbids).

**Section order is bottom-weighted on purpose.** The owner reads the END of the message first,
so the sections run from routine mechanics to the decisions and next steps that need attention.
Keep that order.

**Nothing to report means the line is not written.** Omit an empty bullet, and omit a whole
section when every bullet in it would be empty. Never write `none` on its own line, and never
explain the emptiness — an explanatory paragraph under a "none" is the failure this rule exists
to stop. Two exceptions, because there the absence is itself the message: **Verification** always
reports, and **Landed this sprint** always states what the sprint did, even if the answer is
"investigation/docs only".

```markdown
## Sprint closeout

### Verification
- Build + typecheck: <green/red> (`npm run build && npm run check`)
- Tests: <suite(s) run> → <pass/fail counts>, on a clean, fully-pushed tree at `<commit>`

### Cleanup
- Diff scanned for dead code / orphaned helpers / stray debug·TODO: <removed …>
- Deliberate intermediate state (NOT a bug): <called out …>

### Friction this sprint
> Categories are the single-sourced friction vocabulary (`FRICTION_CATEGORIES`,
> `src/shared/friction/frictionRecord.ts`) — one taxonomy for sprint retros and the
> product's mechanical capture. Named prompts are seeds, NOT an exhaustive schema — the
> open-ended line is load-bearing whenever it has content. Write only the lines that do.
- ambiguous_direction (instructions/docs/specs pointed the wrong way, or contradicted each other): <…>
- tool_should_decide (a human/agent had to remember, notice, or decide something the tool should enforce): <…>
- inefficient_feeding (context/tokens wasted moving information in or out — re-derivation, dumps, re-loops): <…>
- **Open-ended (anything else that caused friction, fit no category above):** <…>
- Logged to: <docs/backlog.md entry | friction record>

### Docs synced
- HANDOFF: <updated → …>
- backlog: <added/removed …>
- memory + index: <updated …>

### Landed this sprint
- <one line: what this sprint did + outcome (e.g. shipped audit-tools@X.Y.Z)>
- <change> — `<commit>` / shipped in `<version>`
- … (or "nothing — investigation/docs only")

### Decisions needed from you
> Omit this heading entirely when no decision is live.
> Otherwise every decision only the owner can make MUST be posed here as an actual answerable
> question — the question stated, the options spelled out, via AskUserQuestion where the harness
> offers it. "Your decision: see queue X / run command Y" is a pointer, not a question, and does
> not satisfy this section. Record each answer in its durable home (e.g. `answer.mjs <id>`, the
> named doc) once given.
- <the question, options included> → recorded at <answer.mjs id | doc | backlog entry>

### Remaining next steps, and where each lives
> Omit this heading entirely when nothing remains.
> Otherwise list every remaining item with its document home. Never leave a step implied or
> living only in chat.
- <next step> → `docs/HANDOFF.md` (immediate next)
- <open bug> → `docs/backlog/open-bugs.md`; <forward track> → `docs/backlog/forward-tracks.md`
- <durable design / status> → project memory + `~/.claude/…/memory/MEMORY.md`
- <durable how-to> → `CLAUDE.md`
```

## Notes

- **Essential last.** The reading order is inverted in chat, so decisions and remaining steps sit
  at the bottom where the owner lands first. Mechanics (verification, cleanup, friction) sit above.
- **Silence is the empty value.** A bullet or a section with nothing to report is not written at
  all — no `none`, no explanation of the `none`. Only the two sections named above always report.
  The cost is accepted deliberately: an omission and a genuine nothing now look alike, and the
  guard against a dropped obligation is the next section, not a written-out `none`.
- **Next steps + doc homes is mandatory when any remain.** The closeout exists partly so a
  remaining obligation is never lost to chat-only memory. Every remaining step is written WITH the
  document that will hold it after the session ends.
- **Owner decisions are asked, not referenced.** The recurring failure this section exists to
  stop: hand-backs that say "your decision — item X" while the actual question (which the agent
  holds, options and all) never reaches the owner. If the owner would have to open a file or run
  a command to find out what is being asked, the closeout has not asked it.
- **One home per fact.** The report points at where durable content lives; it does not duplicate it.
  Immediate-next → HANDOFF; open work → backlog; durable concepts/status → memory; how-to → CLAUDE.md.
