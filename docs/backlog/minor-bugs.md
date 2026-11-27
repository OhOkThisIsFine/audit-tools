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

- **File-lock checks are cooperative, not an atomic write fence (2026-10-06, low).** Heartbeat loss now latches, and the shared locked JSON stores and remediation lifecycle writer recheck ownership before writing. Other state-changing lock users may still lack a check, and a check plus rename is not one atomic operation. P3 of the canonical implementation plan is a separate protocol decision. **Property:** evaluate a remaining caller only when an actual stale-write path warrants work; do not treat the heartbeat or a pre-write check as an atomic guarantee.

- **DD-9 + charter slice-staleness — residual only, revisit on live evidence (2026-07-23, low,
  accepted).** The pair SHIPPED; its mechanism record is the single home —
  [`intent-gate-charter-slice-design-2026-07-23.md`](../reviews/intent-gate-charter-slice-design-2026-07-23.md).
  The charter now hashes the docs and consensus-member comments that its packet reader actually reads, plus
  the full path inventory. Nonmember source prose is intentionally outside that read set.
  Remaining cost question: a revert pair can re-run the equivalence judge because verdicts are
  materialized into the baseline. Keep the conservative behavior unless live cost justifies another change.
