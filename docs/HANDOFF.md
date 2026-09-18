# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- **v0.52.0 is published and installed globally.** Release commit `84e2a2d9` passed the publish
  workflow ([run 35191266555](https://github.com/OhOkThisIsFine/audit-tools/actions/runs/35191266555));
  npm resolves 0.52.0 and both installed command surfaces report 0.52.0. Content: the findings
  contract `v1alpha2` (`audit_read`, below), the dispatch-lane reader fix, and the release-script
  and doc commits that followed 0.51.11.
- **The cleanup-and-implementation lap is complete.** Every packet (P00–P30) is on `main`; the
  machine-local plan directory and its wave log are the record of how each landed.
- **The commit gate runs at git's own boundary.** The tracked `.githooks/` run
  `.claude/hooks/commit-gate.mjs` for every commit into this repository; the PreToolUse
  `pre-commit-gate.mjs` keeps only what git cannot see (the hook-bypass refusal, the push
  child-session refusal, routing of gated incoming content for merge, cherry-pick and revert, and
  healing a crashed staged-snapshot round-trip left by the git-boundary gate).
- **The commit gate is wired per clone.** `core.hooksPath` is a git setting the SessionStart guard
  points at `.githooks` (writing the worktree scope too where `extensions.worktreeConfig` makes a
  `.git/config.worktree` entry win). A clone that has never opened a session runs no commit gate
  until it does; the registry row states this as the uncovered half.
- **A relay lane child is recognized as a dispatched child.** `readSessionRegistry` treats a
  positive `LLM_RELAY_DISPATCH_DEPTH` (set by llm-relay `dispatch` in every lane child) exactly like
  `AUDIT_TOOLS_CHILD_SESSION=1`, so the session-scoped Stop gates never recruit a lane's report.
- **The benchmark track is retired (owner decision 2026-09-10).** Its forward-track entries, its
  harness and its contract tests are gone; the shipped `score-audit` command stays.
- **The charter layer is the five-step pipeline (landed 2026-09-15).** Three blind lanes each
  submit one goal DAG; the `charter_comparison` reader confirms tool-proposed correspondences and
  records seven-dimension n-ary differences; the separate `charter_fidelity` lane verifies each
  finding candidate against its source slices; only `supported` records become findings. The
  delta-miner, the triangulated telos and `charter-register/v4` are gone (a v4 register on disk is
  discarded and re-derived). Design of record: `spec/conceptual-design-review-design.md`
  §"The estimator charters".
- **The host-prompt review is complete.** In
  `docs/reviews/prompt-refinement-2026-09-13.md`, rows 8 through 20 read APPROVED (owner,
  2026-09-17 and 2026-09-18). Row 20 slimmed the remediate result to `v1alpha3` (the host names
  only `landed_commit` and `obligation_evidence`; the tool derives the rest from git and its own
  test rerun), ends every worker prompt in both draws with a tool-filled result template, and
  renders both draws' ingest reports through one shared renderer with a fourth remedy,
  `operator`. Row 19 has no verify prompt (the tool checks each result itself); its change is a plainer
  `final_gate_red` pause. Its review found that the repository-wide suite gate runs only on
  audit-tools itself — logged in `docs/backlog/open-bugs.md`. Row 18 gave each contract-pipeline role its own read scope and Field
  Rules, and moved three asks into tooling: a shim-only decomposition scope re-emits
  decomposition, the cyclic-seam re-check reads the live ledger (the record never decides whether
  cycles remain), and the judge's `counterexample` repair target is refused with a reason. The
  `closing` worker phase is retired: the close phase writes `verification_report`. Row 16 moved a worker's clarification question onto the item it pauses
  (the run-level list is retired) and made every resolution file a bare array that is refused whole
  on one bad entry; row 17a shares that parser and its rules text. Row 17b refuses a malformed
  review resolution whole (a wrong field name used to approve a declined finding) and records the
  user's reason for a decline. Row 17c has the host write only `intake-summary.json` (`v1alpha2`):
  the tool renders the brief and builds the confirmation proposal from it, and the draft
  checkpoint is retired. Row 15 became a redesign, not a wording fix: a lens steward now receives every file its
  lens was applied to, with per-file metrics, and the two file-count caps are deleted. The axis is
  `coverage_policy` on `AuditTask`, and all three coverage-completeness gates read it. Design of
  record: `docs/reviews/lens-steward-redesign-2026-09-17.md`.
- **The findings contract records what the audit read.** `audit-findings.json` (contract
  `v1alpha2`) carries the required, nullable `audit_read` — the commit plus the paths that were
  uncommitted — and the remediator's close-phase evidence leg reads it from `state.plan`, so
  `verified_already_fixed` and `refuted` are reachable on a real run. A `v1alpha1` report no longer
  routes structured; `audit-code resynthesize` upgrades one and states `audit_read: null`. Contract:
  `spec/audit/artifact-contract.md` §"`audit_read` — what the audit read".

## Immediate next

**Land the lap branch** once: `--no-ff`, both attester classes, the adopted suite stamp. Then
`/ship`.

**Live owner decision:** none.

## Deliberate state, not bugs

- **Line anchors under the runtime state dirs are left alone on purpose.** 2,781 of them sit in
  generated tool output, which the next run rewrites, so a refusal there would be unfixable by
  editing. The line-anchor rule therefore covers every tracked doc EXCEPT those dirs — including
  dated review records, which were cleaned of all 935 of theirs. `check-doc-code-citations.mjs`
  states this beside the scope itself.

- The judge-side naming refusal is unreachable on the production path by design of the parse
  order: the property it guards holds twice over, and only its claimed reach does not. Tracked
  in [`minor-bugs.md`](backlog/minor-bugs.md).
- The charter packet builder no longer caps packet size; its coverage manifest records only
  unreadable or empty omissions.

<!-- BEGIN GENERATED LIVE STATUS — scripts/shared/generate-handoff-roadmap.mjs — DO NOT EDIT BY HAND -->
<!-- END GENERATED LIVE STATUS -->

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
