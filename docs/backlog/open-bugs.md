# Open bugs & frictions

> Fixable defects and friction. Fix in tooling — never "the host remembers".
>
> Part of the split backlog — index: [`docs/backlog.md`](../backlog.md).
> A living to-do list, not a status log. Remove an entry once it ships; record durable
> contracts and rationale in project memory or `CLAUDE.md`, never "where the code is today".

- **Audit/shared tests time out under full-suite load and pass alone (2026-10-08, medium).** On `38bba3cf`, `npm test` failed only `tests/audit/analyzer-run-consent.test.ts` ("late formatting opt-in…", 60 s budget) and `tests/audit/next-step-integrity-reintake.test.ts` ("same-line-count pending source edit…", 120 s budget); `run-vitest-gate.mjs` reported LOAD-ONLY for both, so no suite stamp exists for a clean tree. On 2026-11-16 `tests/shared/exec-owned-bounds.test.ts` failed the same way (an owned grandchild still alive under full-suite load; passes alone). **Property:** each test's runtime stays within its budget under the full suite, so a clean tree can earn a green stamp.

- **Inspection coverage claims are accepted on the host's word (2026-10-05, medium).** A Sonnet batch claimed full coverage of two files it never opened, and the contract checks accepted it; `file_coverage` is checked for line counts only. **Property:** an accepted result's coverage of a file is backed by evidence the tool checks against that file's content, so an unread file cannot pass as covered.

- **The attestation gate judges an edit to itself with the edited copy (2026-10-04, medium).** `check:loop-core-attestations` runs in `verify:checks` from the pull request's own tree, so its membership predicate (`.claude/hooks/loop-core-patterns.mjs`) and the checker are the versions under judgment. Since 2026-10-04 the gate's four files are loop-core and admins are bound, so a narrowing that keeps the gate files listed is caught. Not caught: one change that removes the gate files from the list together with their ledger entries, that makes the checker pass, or that unwires it (`package.json` `verify:checks`, `.github/workflows/ci.yml`, `scripts/shared/loopCoreClosureData.mjs`) — each is judged by the copy it edits. **Property:** a required check judges a change to the gate with a copy the change cannot edit.


- **The constitutional-doc commit gate refuses a diff confined to a generated region (2026-10-04, low, friction: tool_should_decide).** `spec/audit/dependency-map.md` holds `BEGIN/END GENERATED spec-mirror` tables that `scripts/shared/generate-spec-mirrors.mjs` owns and `check:spec-mirrors` reconciles; a dependency-map change regenerates a row, and the commit gate then demands an owner-decision override for prose nobody wrote. **Property:** the gate judges only the hand-written part of a constitutional doc; a generated region is judged by its generator's check.

- **A code comment that states a workflow SHAPE or a prose ENUMERATION is checked by nothing
  (2026-08-31, medium, friction: tool_should_decide).** Since 2026-10-04 `check:comment-code-citations`
  resolves every backticked path and symbol in a source comment; its guard-reach row lists what it
  cannot reach. A shape or an enumeration names no single identifier, and a name the same file's code
  spells is not looked up (the 2026-08-31 `continuityScore` header). **Property:** a comment that
  states a workflow shape or an enumeration the code owns is reconciled against it mechanically, or it
  does not state one.

- **The TASK draw's coherence eligibility is still disjunctive and has never been measured for
  collapse (2026-08-19, medium).** The findings draw moved to `shared_file AND same_lens`;
  `TASK_DRAW_COHERENCE_POLICY` keeps `weighted_score_threshold` deliberately, because no measurement
  of `buildTaskCoherencePartition`'s components on a real graph exists. **Property:** the task draw's
  eligibility is either measured and shown not to collapse, or aligned with the findings draw's — it
  is not left disjunctive on the grounds that nobody looked.

- **Qualify opt-in stock-analyzer coverage receipts and reuse (2026-11-27, medium).** Remediation no longer treats a missing lead as clean without comparable scope/config and verified coverage; equivalent positive refires still block. **Remaining:** qualify individual stock adapters (original and recheck receipts with version, effective rules/config, admitted scope, scanned/skipped inputs and failure limits), and prove compatible imported receipts are reused without rerunning the scan or emitting duplicate lead questions. Adapters lacking verified comparability may supply leads but cannot certify absence. No live stock-adapter coverage claimed.
