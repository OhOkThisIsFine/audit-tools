# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- Published state: v0.41.1 (the tag, not a sha — a sha here restales on every commit). The
  zero-adapter retirement is live; audit-tools emits complete provider-neutral host workloads
  and ingests bound results. Host submissions ride tool-computed sha256-bound paths under
  `<artifactsDir>/submissions/`; the flat `incoming/` scheme is gone, so anything still writing
  to it will be rejected.
- The dogfood audit lap is COMPLETE (2026-08-18): all review, deepening, conflict and
  runtime-reconciliation passes ingested; synthesis narrative accepted; deliverables promoted to
  `.audit-tools/audit-report.md` + `.audit-tools/audit-findings.json` (3,230 findings, 10 themes).
  Executed on the freellmapi pool via a direct `/v1` tool-loop harness with mechanical
  quote-grounding (agy and codex were quota-walled). A pre-promotion snapshot of the full
  artifacts tree sits in the session scratchpad if anything from the run is needed.

## Next: remediate phase (fresh conversation)

1. `remediate-code` consumes `.audit-tools/audit-findings.json`. Start from the report's ten
   themes — T-001/T-002 (vacuous verification, absence-defaults-to-success) and T-004/T-006
   (destroy-before-verify, unbound consent) carry the highest-severity clusters. The owner-approved
   build queue below overlaps several themes; land those builds first where they coincide.

<!-- BEGIN GENERATED LIVE STATUS — scripts/shared/generate-handoff-roadmap.mjs — DO NOT EDIT BY HAND -->
<!-- END GENERATED LIVE STATUS -->

## Immediate next

1. The owner-approved build queue (all decided 2026-08-18, owner present; each is an answered
   subject in the durable decision ledger — named, never numbered, since per-run `sol-N` labels
   recycle). The owner approved landing the three hook builds this session; the rest follow:
   - **Child-session split follow-ups that live OUTSIDE this repo** (the split itself and the
     tree-dirt baseline are landed and stamped in the ledger):
     1. `C:\Users\ethan\freellmapi\claude.ps1` (pool-lane launcher): set
        `AUDIT_TOOLS_CHILD_SESSION=1` in the child environment when the working directory is this
        repo — owner/next-session action; this repo cannot carry it.
     2. Any scheduled task or wrapper OUTSIDE the repo that runs the `/insights` maintenance
        invocation needs the same env prefix (the in-repo routine doc already carries it; lane
        list in the child-sessions entry of `docs/backlog/durable-traps.md`).
     3. Transitional: any OTHER live session predating the feature is child-classified now that
        enforcement is armed; it self-registers from the repo root with
        `node scripts/shared/sessionRegistry.mjs --register <session-id>`.
   - **Record-update pre-commit gate** (`a360d399`): measurement falsified the stated property's
     mechanical enforceability (0 true positives in 180 commits; declared-pair set empty) — owner
     re-scope question PENDING, evidence in
     [`docs/reviews/record-update-gate-measurement-2026-08-18.md`](reviews/record-update-gate-measurement-2026-08-18.md).
     Do not build or close without the owner's pick.
   - The 2026-08-18 decision batch: wire `verifyFindingGrounding` into ingest; P34+P26
     registry-derived pre-commit legs + CI trigger paths; P35 Required-Inputs derivation +
     prompt-capability test; P32 writeOpenItems refusals; general status-laundering guard rule;
     citation-gate widening; shared one-item-per-call dispatch wrapper + size guard; HANDOFF
     heuristic gate; escape-run deny rule; build the pre-run sweep; the constitutional doc edits
     (all attested); release-flow fold into the ship skill; backlog-1..3 edits; the
     tested-but-unwired dead-code audit.
2. The remediate phase over the promoted findings (see *Next: remediate phase* above) — sequence
   it against the build queue where themes and builds coincide.

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
