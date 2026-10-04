# Minor open bugs (low severity)

> The LOW-severity tail of [`open-bugs.md`](open-bugs.md), split out 2026-08-28 when that file
> reached its 120,000-byte ceiling and every new entry had to be paid for by condensing another.
>
> Same rules, same lifecycle, same sweeps — this is a size split, not a lower standard. An entry
> here is still a fixable defect that is fixed in tooling and DELETED once it ships. Severity is
> the only thing that decides which file an entry lives in, so re-tagging one moves it.
>
> Part of the split backlog — index: [`docs/backlog.md`](../backlog.md).
> A living to-do list, not a status log. Remove an entry once it ships; record durable
> contracts and rationale in project memory or `CLAUDE.md`, never "where the code is today".

- **The remediate clarification answer still accepts the ignored `scope_additions` field (2026-10-01, low).** Owner decision 2026-10-01: remove it in two steps, because the strict parser refuses an unknown field and a host on an older prompt still sends it. Step one landed 2026-10-03: `PlanClarificationResolutionSchema` (`src/remediate/steps/nextStep.ts`) accepts and ignores it, and the prompt no longer asks for it. **Step two, once a published release carries step one:** delete the field from the schema. **Property:** the answer schema carries no field that has no effect.
- **DD-9 + charter slice-staleness — residual only, revisit on live evidence (2026-07-23, low,
  accepted).** The pair SHIPPED; its mechanism record is the single home —
  [`intent-gate-charter-slice-design-2026-07-23.md`](../reviews/intent-gate-charter-slice-design-2026-07-23.md).
  Accepted residuals (`charter_clarification` is sliced since 2026-10-04, and `systemic_challenge`'s
  whole-manifest edge is exact, not a residual — `dependencySlices.ts` states both):
  (b) under-stale, and NARROWER than the first draft of this entry
  claimed: `charterReadFileSlice` compares content for consensus members ∪ every `isDocIntentFile`
  path (`doc_only` status **OR** `.md/.markdown/.adoc/.rst/.txt` — single-sourced at
  `buildStructureDecomposition.ts` so it can never be narrower than the decomposition's own doc
  universe; pinned by `tests/audit/dependency-slices.test.ts`), PLUS the complete sorted path list,
  so every add / delete / rename fires regardless of classification. What stays outside is a
  content-only edit to a file that is neither a consensus member nor doc-extensioned nor `doc_only`
  — e.g. spec prose living inside a `.ts` the Stated pass reads. Widen `charterReadFileSlice` if a
  live run shows it. (c) over-cost: a revert pair (intent A→B judged, then B→A) re-pays one judge
  round — verdicts are materialized into the baseline (`intentEquivalenceExecutor.ts`), never cached
  per-pair.

- **A spec row's category prefix is load-bearing enough to manufacture work — and one was false
  (2026-07-28, low, RESOLVED; the open half is the class).** `spec/audit/artifact-contract.md` gave a
  TRANSIENT host submission (`intent-equivalence-verdict.json`) the same `Durable host input:` prefix as <!-- doc-citation-exempt: transient host submission, written and deleted at runtime -->
  a registered staleness-DAG leaf, so nightly `docs-3` correctly inferred "register it for consistency"
  and collided with DD-9's deliberate no-verdict-pair-cache retirement. Fixed by relabelling the row and
  making the durable row state its registry+DAG membership explicitly; endpoint traces in
  `docs/reviews/intent-equivalence-verdict-endpoint-trace-2026-07-28.md`.
  **Open property (the class, not this instance):** a category prefix in a normative table is read as
  a contract, so two files sharing one must share its lifecycle. Nothing enforces that. Worth a check
  only if a second instance appears — one occurrence is not yet a pattern.


- **Auditor severity calibration: 0 of 9 self-audit criticals survived mechanism verification
  (2026-08-06, lead, low).** 3 refuted / 6 downgraded — record in
  [`reviews/dogfood-run-2026-08-06.md`](../reviews/dogfood-run-2026-08-06.md). Open question:
  should synthesis demand mechanism-grounded (not flow-existence) evidence for `critical`?
