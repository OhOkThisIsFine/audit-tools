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

## Next: resume the remediation run mid-implementation

The run is LIVE and mid-wave — resume it, never restart it (a restart discards the approved
design). `remediate-code next-step` picks it up; if it offers the resume/restart gate, answer
`{"choice":"resume"}` in `.audit-tools/remediation/confirm_resume_ack.json`.

- **Design phase is closed and approved.** Six contract-repair rounds against five adversarial
  counterexample rounds (accepted 5 → 3 → 2 → 1 → 0) ended in a judge `approved` verdict:
  329 obligations satisfied, 0 violated, 26 uncertain (all the ledger generator's always-empty
  `depends_on` roll-ups — a generator property, not a design defect). The 27-node implementation
  DAG covers all 355 obligations.
- **Implementation wave 1 (13 items) is partly landed** — see *Immediate next*. Each item lands
  as one commit whose changed-file set exactly equals its work item's `allowed_files`, with a
  result JSON at the item's `result_path`; ingestion re-validates the binding before advancing.
- **Dispatch protocol that works:** one item in flight at a time (the tree is shared); give the
  implementer its module's contract + specs as the spec, require red-green by inversion (never
  `git checkout --`), real exit codes, and a STOP-and-report on any out-of-scope edit rather
  than scope creep. Every STOP so far was a genuine routing gap worth fixing at the source.
- **Known routing-gap class:** the DAG's node `output_files` did not inherit the contracts'
  clause-1(c) declared write targets, so declared files fell out of `allowed_files`. Fixed for
  CP-NODE-2/24/25/21 by adding the file to the node's `output_files` **and** the derived plan
  block's `touched_files`, then deleting `state.host_handoff` so the wave re-prepares. Expect the
  same fix shape if a later item stops on a declared-but-unwritable file.
- **Carry-forward the judge flagged:** the phantom-drop residual's mitigation was discharged by
  CP-NODE-0 (374 cited paths / 88 distinct all grounded at `eca6506a`); if planning is ever
  deferred past a tree-moving pause, re-run that grounding before dispatching more items.

<!-- BEGIN GENERATED LIVE STATUS — scripts/shared/generate-handoff-roadmap.mjs — DO NOT EDIT BY HAND -->
<!-- END GENERATED LIVE STATUS -->

## Immediate next

1. **Finish implementation wave 1.** Landed so far (unpushed, on `main`): CP-NODE-2, 14, 4, 8, 7,
   16, 17, 20, 21, 22 — plus the pre-flight CP-NODE-0 (a `resolved_no_change` decision, no commit).
   plus CP-NODE-23 (`ccb72eff`, tip of `main`). Remaining in the wave: **CP-NODE-10** (staleness
   slice propagation) and **CP-NODE-11** (audit flow + requeue policy). Both touch loop-core
   paths, so each needs an independent review pass and a fresh
   `node .claude/hooks/attest-loop-core-review.mjs` attestation bound to the staged tree before its
   commit — same shape as the coherence lap's landing earlier in this program.
2. **Nothing is pushed.** Ten-plus commits sit on local `main`. Before pushing: full
   `npm run build && npm run check && npm test` green, then push `HEAD:main`. Two known reds to
   clear first, both docs-only: the `id-glossary` contract test (five new `INV-*` ids need rows in
   `docs/glossary-ids.md` — a cleanup agent was landing exactly this at hand-off, so verify it
   landed) and whatever `verify:checks` surfaces once the wave completes.
3. **Deferred-by-design during the wave, worth one consolidated pass afterwards:** several modules
   had no permanent test home in their `allowed_files`, so their red-green transcripts live only in
   commit messages (CP-NODE-14, 4, 8, 16, 17, 20, 23). Route those test files and land the durable
   tests. Also queued: lift `GateOutcome` into `audit-tools/shared` with its adopters (CP-NODE-14's
   deviation), and decide `intentOrdering`'s orphan disposition (CP-NODE-16's inv-4 — wire a
   production caller or delete; it is currently fixed-but-orphaned).
4. Outside-repo residue this repo cannot carry:
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
