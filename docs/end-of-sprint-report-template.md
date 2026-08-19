# End-of-sprint report — template

The markdown scheme for the closeout hand-back at the end of every sprint (see the
*End-of-sprint cleanup* step in [`CLAUDE.md`](../CLAUDE.md)). The report is **rendered in
chat** as the hand-back; its durable pieces are simultaneously written to their permanent
homes (`docs/HANDOFF.md`, `docs/backlog.md`, project memory). This template is **timeless
structure, not a persisted instance** — do NOT commit a dated, filled-in copy into the tree
(that would be the changelog/status-doc creep the [documentation philosophy](documentation-philosophy.md)
forbids). Keep every section; write "none" / "nothing pending" rather than dropping a heading,
so a silent omission can't masquerade as "nothing to report".

```markdown
## Sprint closeout — <one-line: what this sprint did + outcome (e.g. shipped audit-tools@X.Y.Z)>

### Verification
- Build + typecheck: <green/red> (`npm run build && npm run check`)
- Tests: <suite(s) run> → <pass/fail counts>, on a clean, fully-pushed tree at `<commit>`

### Landed this sprint
- <change> — `<commit>` / shipped in `<version>`
- … (or "nothing — investigation/docs only")

### Cleanup
- Diff scanned for dead code / orphaned helpers / stray debug·TODO: <removed … | clean>
- Deliberate intermediate state (NOT a bug): <called out … | none>

### Docs synced
- HANDOFF: <updated → … | unchanged>
- backlog: <added/removed … | unchanged>
- memory + index: <updated … | unchanged>

### Remaining next steps — and where each lives
> Say "Nothing pending." OR list every remaining item with its document home.
> Never leave a step implied or living only in chat.
- <next step> → `docs/HANDOFF.md` (immediate next)
- <open bug> → `docs/backlog/open-bugs.md`; <forward track> → `docs/backlog/forward-tracks.md`
- <durable design / status> → project memory + `~/.claude/…/memory/MEMORY.md`
- <durable how-to> → `CLAUDE.md`

### Decisions needed from you — ASKED here, not pointed at
> Every decision only the owner can make that is live at hand-back MUST be posed in this same
> hand-back as an actual answerable question — the question stated, the options spelled out,
> via AskUserQuestion where the harness offers it. "Your decision: see queue X / run command Y"
> is a pointer, not a question, and does not satisfy this section. Write "none" explicitly when
> no decision is pending; record each answer in its durable home (e.g. `answer.mjs <id>`, the
> named doc) once given.
- <the question, options included> → recorded at <answer.mjs id | doc | backlog entry>
- … (or "none")

### Friction this sprint
> Categories are the single-sourced friction vocabulary (`FRICTION_CATEGORIES`,
> `src/shared/friction/frictionRecord.ts`) — one taxonomy for sprint retros and the
> product's mechanical capture. Named prompts are seeds, NOT an exhaustive schema —
> always include the open-ended line.
- ambiguous_direction (instructions/docs/specs pointed the wrong way, or contradicted each other): <… | none>
- tool_should_decide (a human/agent had to remember, notice, or decide something the tool should enforce): <… | none>
- inefficient_feeding (context/tokens wasted moving information in or out — re-derivation, dumps, re-loops): <… | none>
- **Open-ended (anything else that caused friction, fit no category above):** <… | none>
- Logged to: <docs/backlog.md entry | friction record | none warranted>
```

## Notes

- **Next steps + doc homes is mandatory.** The closeout exists partly so a remaining obligation
  is never lost to chat-only memory. If truly nothing remains, the report must say so explicitly.
- **Owner decisions are asked, not referenced.** The recurring failure this section exists to
  stop: hand-backs that say "your decision — item X" while the actual question (which the agent
  holds, options and all) never reaches the owner. If the owner would have to open a file or run
  a command to find out what is being asked, the closeout has not asked it.
- **Friction is named-dimensions + open-ended.** A fixed taxonomy silently drops the unanticipated
  friction that is most of real friction; the open-ended line is load-bearing, not optional.
- **One home per fact.** The report points at where durable content lives; it does not duplicate it.
  Immediate-next → HANDOFF; open work → backlog; durable concepts/status → memory; how-to → CLAUDE.md.
