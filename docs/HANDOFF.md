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

- **11 nightly decisions are waiting.** Answer in [`nightly-inbox.md`](nightly-inbox.md); settled items disappear from this generated block.
  - `docsN-1` — instruction-file edit: CLAUDE.md cites a half-closed trap whose mechanism was deleted with the execution substrate — one of its "two live examples" has no backlog home
  - `docsN-2` — instruction-file edit: CLAUDE.md says a non-default analyzer "requires the per-run consent token" — the code also admits on a persisted recorded grant
  - `docsN-3` — instruction-file edit: CLAUDE.md warns that consent-token redaction is "not yet implemented" and tracked in open-bugs — it is neither tracked there nor unimplemented
  - `docsN-4` — A loader still tells the host to echo the scope line — the tool took that job over deliberately, so a compliant host now prints it twice in two formats
  - `docsN-5` — A loader promises a scope-confirmation gate the tool cannot honour — the warning text reaches no prompt, and the drain has already folded past intake before any host can act
  - `docsN-6` — The audit loader advertises a target-dir argument nothing honours — a typed path is shown back to the user and silently dropped; the remediate loader does the opposite
  - `docsN-7` — The loop-core module header names a consumer deleted with the execution substrate, and its exported predicate has zero production callers while the hook re-implements it
  - `solN-1` — The lane-liveness guard covers one lane of several, and the one probe it runs cannot fail — tonight the Codex lane was dead all run and nothing said so
  - `docsN-8` — Constitutional goals doc defines the remediator's output as Markdown only — the machine contract is missing from all three output statements, and its audit sibling states the pair correctly
  - `docsN-9` — Batched de-status: two design docs that declare "no dated status here" carry dated process provenance and a heading defined against a superseded state
  - `docsN-10` — Doc-set condensation: the shared cross-tool contract is deliberately listed in both workflow designs — and the two copies have already drifted to four bullets versus six

<!-- END GENERATED LIVE STATUS -->

## Immediate next

1. The owner-approved build queue (all decided 2026-08-18, owner present; each is an answered
   subject in the durable decision ledger — named, never numbered, since per-run `sol-N` labels
   recycle). The owner approved landing the three hook builds this session; the rest follow:
   - **Child-session/Stop-gate split** (`820ba998`): probe whether child sessions fire SessionStart,
     then session tagging + unregistered-session commit/push refusal. Unblocks the freellmapi
     `pool` lane for this repo.
   - **Record-update pre-commit gate** (`a360d399`): a commit touching a tracked-work path must
     carry the corresponding record update.
   - **Tree-dirt baseline + per-gate pathspec scoping** (`f65ec9c9`), superseding P24's shape.
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
