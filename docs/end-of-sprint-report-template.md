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
- <open bug / forward track> → `docs/backlog.md`
- <durable design / status> → project memory + `MEMORY.md`
- <durable how-to> → `CLAUDE.md`

### Friction this sprint
> Named prompts are seeds, NOT an exhaustive schema — always include the open-ended line.
- Gate / tool re-loops: <… | none>
- Integration-guard / cross-cutting failures caught late: <… | none>
- Re-scopes / surprises / out-of-band manual interventions: <… | none>
- **Open-ended (anything else that caused friction, fit no category above):** <… | none>
- Logged to: <docs/backlog.md entry | friction record | none warranted>
```

## Notes

- **Next steps + doc homes is mandatory.** The closeout exists partly so a remaining obligation
  is never lost to chat-only memory. If truly nothing remains, the report must say so explicitly.
- **Friction is named-dimensions + open-ended.** A fixed taxonomy silently drops the unanticipated
  friction that is most of real friction; the open-ended line is load-bearing, not optional.
- **One home per fact.** The report points at where durable content lives; it does not duplicate it.
  Immediate-next → HANDOFF; open work → backlog; durable concepts/status → memory; how-to → CLAUDE.md.
