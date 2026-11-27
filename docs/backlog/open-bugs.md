# Open bugs & frictions

> Fixable defects and friction. Fix in tooling — never "the host remembers".
>
> Part of the split backlog — index: [`docs/backlog.md`](../backlog.md).
> A living to-do list, not a status log. Remove an entry once it ships; record durable
> contracts and rationale in project memory or `CLAUDE.md`, never "where the code is today".

- **The attestation gate judges an edit to itself with the edited copy (2026-10-04, medium).** `check:loop-core-attestations` runs in `verify:checks` from the pull request's own tree, so its membership predicate (`.claude/hooks/loop-core-patterns.mjs`) and the checker are the versions under judgment. Since 2026-10-04 the gate's four files are loop-core and admins are bound, so a narrowing that keeps the gate files listed is caught. Not caught: one change that removes the gate files from the list together with their ledger entries, that makes the checker pass, or that unwires it (`package.json` `verify:checks`, `.github/workflows/ci.yml`, `scripts/shared/loopCoreClosureData.mjs`) — each is judged by the copy it edits. **Property:** a required check judges a change to the gate with a copy the change cannot edit.


- **The constitutional-doc commit gate refuses a diff confined to a generated region (2026-10-04, low, friction: tool_should_decide).** `spec/audit/dependency-map.md` holds `BEGIN/END GENERATED spec-mirror` tables that `scripts/shared/generate-spec-mirrors.mjs` owns and `check:spec-mirrors` reconciles; a dependency-map change regenerates a row, and the commit gate then demands an owner-decision override for prose nobody wrote. **Property:** the gate judges only the hand-written part of a constitutional doc; a generated region is judged by its generator's check.

- **A code comment that states a workflow SHAPE or a prose ENUMERATION is checked by nothing
  (2026-08-31, medium, friction: tool_should_decide).** Since 2026-10-04 `check:comment-code-citations`
  resolves every backticked path and symbol in a source comment; its guard-reach row lists what it
  cannot reach. A shape or an enumeration names no single identifier, and a name the same file's code
  spells is not looked up (the 2026-08-31 `continuityScore` header). **Property:** a comment that
  states a workflow shape or an enumeration the code owns is reconciled against it mechanically, or it
  does not state one.

- **Qualify additional analyzer coverage receipts and reuse (2026-11-27, medium).** Actionlint now records and verifies comparable coverage for its qualified native workflow scope. Config changes, omitted files, and ambiguous auxiliary linting still withhold proof. **Remaining:** verify a concrete additional adapter or compatible import/reuse case before extending the mechanism. A tool without comparable coverage can supply positive leads, not certify absence.
