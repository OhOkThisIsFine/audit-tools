# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- Published state: v0.42.0 (the tag, not a sha — a sha here restales on every commit). The
  zero-adapter retirement is live; audit-tools emits complete provider-neutral host workloads
  and ingests bound results. Host submissions ride tool-computed sha256-bound paths under
  `<artifactsDir>/submissions/`; the flat `incoming/` scheme is gone, so anything still writing <!-- doc-citation-exempt: deleted incoming/ scheme narrative (P25) -->
  to it will be rejected.
- Promoted audit deliverables are live at `.audit-tools/audit-findings.json` (machine contract)
  and `.audit-tools/audit-report.md` (render); the remediate phase below consumes them. Run
  history and measurements live in the decision ledger and project memory, not here.

## Next: remediate phase (fresh conversation)

1. `remediate-code` consumes `.audit-tools/audit-findings.json`. Start from the report's ten
   themes — T-001/T-002 (vacuous verification, absence-defaults-to-success) and T-004/T-006
   (destroy-before-verify, unbound consent) carry the highest-severity clusters. The owner-approved
   build queue below overlaps several themes; land those builds first where they coincide.

<!-- BEGIN GENERATED LIVE STATUS — scripts/shared/generate-handoff-roadmap.mjs — DO NOT EDIT BY HAND -->

- **5 nightly decisions are waiting.** Answer in [`nightly-inbox.md`](nightly-inbox.md); settled items disappear from this generated block.
  - `solN-2` — The citation gate only sees BACKTICKED citations, and the glossary writes all 45 of its citations as bare table cells — third recurrence of a stale citation the gate structurally cannot see
  - `backlogN-1` — A friction-walk entry has no open work left, but deleting it would orphan the one uncovered property it deliberately states outright
  - `backlogN-2` — The nightly inbox wipes its own citation-exemption markers on every render — pick the mechanism that makes an exemption survive
  - `backlogN-3` — HOST_GATE_DESCRIPTORS is a finished registry that nothing in production reads — wire a reader, or delete it on the next unwired pass
  - `backlogN-4` — Work blocks no longer bound anything: 98.3% of one audit's findings landed in a single block — four fixes are characterized and it needs your pick

<!-- END GENERATED LIVE STATUS -->

## Immediate next

1. The remediate phase over the promoted findings (see *Next: remediate phase* above). The
   decision-batch build queue is fully landed and stamped in the ledger (`completed_ref` per
   subject) — the ledger, not this doc, says what if anything remains.
2. Outside-repo residue this repo cannot carry:
   - The freellmapi MCP offload `pool` lane spawns `claude.exe -p` with repo cwd and no
     `AUDIT_TOOLS_CHILD_SESSION=1`, so the child self-registers as an owner and its Stop
     closeout-challenge replaces the returned answer — the env must be set in the freellmapi
     server's lane config (`claude.ps1` already carries it; lane list in the child-sessions
     entry of `docs/backlog/durable-traps.md`).
   - Transitional: any live session predating the session registry is child-classified while
     enforcement is armed; it self-registers from the repo root with
     `node scripts/shared/sessionRegistry.mjs --register <session-id>`.

<!-- BEGIN GENERATED ROADMAP — scripts/shared/generate-handoff-roadmap.mjs — DO NOT EDIT BY HAND -->

> **This list is GENERATED from [`docs/backlog/`](backlog/) — do not hand-edit it.**
> It is the IMMEDIATE NEXT work only, never the full open set. Prefix an entry's bold title with
> `▶` in the backlog file that owns it and it appears here; empty means nothing is
> pinned, which is a statement rather than an omission.
> **Every open item lives in [`docs/backlog/`](backlog/)**, reachable by the seek index in
> [`backlog.md`](backlog.md) — this block is not a second index of it.
> Every line is a POINTER: the backlog entry's own title, verbatim, and a link to the file that
> holds its spec. Nothing here restates a spec, so this list and the backlog cannot drift.
> Regenerate: `node scripts/shared/generate-handoff-roadmap.mjs` (`--check` gates it in
> `verify:checks` and at commit). 0 pinned item(s).

### ▶ Next up — pinned in the backlog

*(nothing pinned — no immediate next step is set. Every open item is in [`docs/backlog/`](backlog/).)*

<!-- END GENERATED ROADMAP -->
