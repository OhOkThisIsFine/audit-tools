<!-- review-routing: backlog-forward -->

# Verified repository review and governance simplification plan — 2026-09-19

## Scope

This record re-verifies the current `main` tree at `d0f33a55` and separates confirmed defects from recommendations that did not survive inspection. It is also the single source for the governance-reduction work that follows from that review.

The current repository is **one npm package**, not the older three-package/workspace shape. Audit, remediation and shared code are subsystems under `src/audit/`, `src/remediate/` and `src/shared/`. At the reviewed HEAD, both GitHub workflows were green; the dedicated orchestration suite passed all 12 Node/shard jobs across Node 22, 24 and 26.

## Corrections to the initial review

Three points needed narrowing after direct code inspection.

1. **The old “three-package monorepo” description is stale.** The package has been consolidated into one root `package.json`.
2. **The orchestration-child hang is no longer accurately described as an unidentified 300-second timeout that leaks a child.** Commit `c2408bad` added `runBounded()`, a 120-second per-CLI-call deadline, SIGTERM→SIGKILL escalation, tracked-child attribution, and sync-spawn timing. The original failure class is substantially closed. What remains is locating pathological slowness when it occurs; the backlog entry should be read as a performance/diagnostic residual, not as the pre-fix correctness failure.
3. **Large files are not a sufficient refactor criterion here.** The earlier recommendation to split several 3–5k-line files was too broad. The existing ceremony review correctly distinguishes cohesive large modules from mixed-responsibility ones. The strongest split candidates remain `src/remediate/steps/nextStep.ts` and the ingest path in `src/remediate/steps/dispatch/hostHandoff.ts`; `contractPipeline.ts` and audit `nextStepHelpers.ts` are large but structurally cohesive enough that size alone is not evidence.

## Confirmed product gaps

### 1. Arbitrary target repositories can remediate without a repository-wide phase/final gate

This is confirmed directly in production code.

`toolOwnedFinalGateCommands()` in `src/remediate/steps/gateCommands.ts` returns an empty command list unless `isAuditToolsMonorepo(root)` is true. `runToolOwnedFinalGate()` in `src/remediate/steps/finalGate.ts` converts that empty list into a non-blocking result:

- `passed: true`
- `outcome: "scoped_out"`
- `scoped_out: true`

The close-phase fallback in `src/remediate/phases/close.ts` does not close the gap: an absent `plan.test_command` is represented as `ran: false` while retaining `passed: true`.

So a non-audit-tools repository can pass every phase boundary without a repository-wide build/typecheck/test floor, and can finish without one when no plan test command was supplied.

**Required property:** derive a real repository-wide gate from the target repository's own declared commands at each phase boundary and before close. If no safe gate can be derived, surface that fact to the operator; do not treat it as `scoped_out`.

This is already tracked in `docs/backlog/open-bugs.md`; this review confirms the entry's mechanism.

### 2. Release resumption is not idempotent after the version bump

This is also confirmed.

In `scripts/release-and-publish.mjs`, `main()` computes:

`expectedTag = v\${nextVersion(packageBefore.version, bump)}`

before asking `planReleaseResume()` whether the existing journal should resume.

That works only before the bump. After a release has already bumped package version V and then stalls in an observation phase such as npm propagation, a fresh invocation reads V from `package.json`, computes V+1 as `expectedTag`, and compares the journal's tag for V against V+1. The journal therefore cannot resume the release it actually records.

The unit tests for `planReleaseResume()` are locally correct but do not cover this composition: they pass the already-correct tag into the pure function. The missing test is the post-bump main-flow case.

The defect has already been observed twice, including the `0.52.1 → 0.52.2` duplicate forward bump recorded in the backlog.

**Required property:** when the journal identifies an unfinished release V whose destructive creation phases already completed, re-entry resumes V's observation/completion phases before computing any new version. Add an integration-level regression around the caller composition, not another isolated `planReleaseResume()` case.

### 3. “Audit is read-only” contradicts the default auto-fix behavior

`docs/project-philosophy.md` describes auditing and remediation as the read-only and write/apply draws of one core.

But `src/audit/orchestrator/autoFixExecutor.ts` mutates audited files by running formatters such as Prettier, Black, sqlfluff and gofmt. `autoFixGateRefusal()` stops the phase only when:

- `enabled === false`, or
- `dryRun === true`.

With default options, auto-fix is therefore enabled. `tests/audit/auto-fix-gate.test.ts` explicitly keeps an ungated control that proves the formatter runs by default.

The opt-out and dry-run mechanisms are sound; the remaining problem is the contract.

**Required property:** either make audit auto-fix opt-in, preserving “read-only” as the default product contract, or explicitly redefine the audit contract to name mutation as a deliberate exception. Code, tests and philosophy must state the same default.

This is already tracked in `docs/backlog/forward-tracks.md`.

## Maintainability finding that survives verification

Do not launch a broad “split the biggest files” project.

The useful decomposition work is narrower:

- `src/remediate/steps/nextStep.ts` combines the state machine with separable concerns including recovery, friction closeout, path-A dispositions, intent persistence and obligation registries.
- `src/remediate/steps/dispatch/hostHandoff.ts` has an ingest path that mixes corroboration, required-test reruns, recovery bookkeeping and state mutation.

Extract those bounded responsibilities when doing so removes independent change surfaces. Do not split `contractPipeline.ts`, audit `nextStepHelpers.ts`, or other large files merely to reduce line count.

## Governance diagnosis

The governance layer is not weak; it is over-represented.

At the reviewed HEAD:

- `verify:checks` expands to **54** check/build/smoke steps.
- `package.json` contains **47** `check:*` scripts.
- `scripts/guard-reach-data.mjs` is about **150 KB** by itself.

The recurring cost is not simply “too many checks.” It is that one governance fact is often represented several times and then guarded by another mechanism that proves the representations still agree.

The repository already has the right principle for product code: one source of truth, with generated or projected consumers. Apply that principle to the governance layer itself.

## Governance simplification plan

### A. Delete the gate-enumeration subsystem

`check:gate-enumeration` currently derives the real `verify:checks` step list from `package.json` and reproduces all 54 names inside `.claude/skills/ship/SKILL.md`.

There is one enumeration target. The ship skill already tells the operator to run `npm run verify:checks`; duplicating the entire executable step list in prose adds no operational capability.

Delete:

- `scripts/gate-enumeration-data.mjs`
- `scripts/check-gate-enumeration.mjs`
- its dedicated contract test
- its npm-script and guard/reach registrations
- the generated 54-step prose block

Replace the prose with one sentence stating that `npm run verify:checks` is the authoritative gate.

**Safety preserved:** execution remains unchanged; only a generated restatement disappears.

### B. Make one gate catalog executable

Today a normal gate is represented by several independently maintained facts:

1. an npm script in `package.json`;
2. membership/order inside `verify:checks`;
3. a `GUARDS` row;
4. one or more `REACH` rows;
5. pre-commit metadata;
6. generated CI trigger paths;
7. sometimes generated documentation.

`check-guard-reach.mjs` now needs `gateHomeGaps()` because registering a gate correctly became a multi-home operation.

Invert that relationship. Keep one ordered data declaration for gate identity, command, reach, pre-commit policy and fix text, and have a single runner execute it for the release profile. Derive pre-commit legs and CI paths from the same declaration.

The exact shape can evolve, but the endpoint should be:

- one declaration adds or removes a gate;
- release execution is generated from it;
- pre-commit execution is generated from it;
- CI reach is generated from it;
- no meta-check exists solely to prove that separate gate lists agree.

Preserve current order, fail-fast behavior and special phases such as build/smoke where their ordering is load-bearing.

### C. Collapse backlog micro-checks into one backlog validator

The backlog currently pays separate command/registry/reach overhead for at least:

- `check:backlog-budget`
- `check:backlog-status`
- `check:backlog-line-numbers`
- `check:backlog-friction-tags`

These rules operate over the same small document family, and multiple checks already share `scripts/shared/backlog-entry-grammar.mjs`.

Keep the individual validators as functions, but expose one `check:backlog` command that parses the corpus once and applies:

- entry-boundary/size/property checks;
- status-marker checks;
- line-citation checks;
- friction-vocabulary checks.

Have `generate-backlog-index.mjs` consume the same parsed representation.

**Safety preserved:** the rules remain independent in diagnostics and tests; only execution and registration collapse.

### D. Fold doc-test consumers into the existing pin-obligation declaration

The `DOC_TEST_CONSUMERS` map is not merely advisory. `scripts/shared/derived-file-preflight.mjs` projects every row into `PINS`, so staging a mapped document already obliges the tests it names.

That means the conceptual source is already the pin graph. Generalize the pin row shape to carry an optional rationale/description and represent both source pins and doc pins there.

Then one reconciler can require:

- tracked subject;
- tracked tests;
- non-empty consumer set;
- build-free pre-commit tests;
- optional explanatory text when useful.

Retire the separate `check:doc-test-consumers` configuration checker and data module after migration.

**Safety preserved:** the actual pre-commit test obligation stays. Only its second registry disappears.

### E. Reduce `guard-reach-data.mjs` to executable facts

The registry is valuable; the historical narrative embedded in many rows is not required to run it.

Keep:

- `id`
- `kind`
- `impl`
- `preCommit`
- concise `fix`
- reach/globs
- actual positive `forms`
- a concise `uncovered` statement where needed

Move incident chronology, design argument and post-mortem prose to the review/commit that established the mechanism.

The registry should answer **what exists, what it inspects, and how it is wired**. It should not become a second history of why each guard exists.

### F. Finish the already-identified governance single-sourcing work

The existing backlog has concrete examples that should be completed before adding new governance layers:

- friction taxonomy copied across production/hooks/closeout consumers;
- memory-directory derivation implemented twice with different sanitization;
- audit/remediate installer behavior split around the same host-asset plan;
- HANDOFF/closeout narration of state that can be derived mechanically.

These are the same class as the gate catalog: collapse the source, do not add another parity checker.

### G. New-governance rule

Before adding any new checker whose subject is another governance representation, ask:

> Can the two representations be collapsed into one source and derived consumers?

If yes, collapse them. Add a parity checker only when the two representations must remain independently authored.

This is a design rule, not another gate.

## What should remain strict

The simplification work should not remove checks that directly interrogate external truth or a real artifact boundary. Keep, or preserve equivalent coverage for:

- TypeScript build/typechecking and the test suite;
- lint/dead-code/duplication/dependency-cycle checks;
- shared-layer import boundaries;
- package and host-install smokes;
- schema-version read gates;
- generated schema/artifact parity;
- dead markdown links and code citations;
- the document manifest;
- the underlying guard-reach concept.

The deletion targets are primarily mechanisms whose subject is **another copy of governance state**, not mechanisms that check the product or repository directly.

## Suggested sequence

1. Fix release resume identity and add the caller-level regression test.
2. Design and implement arbitrary-repository phase/final gate derivation.
3. Resolve the audit read-only versus default-auto-fix contract.
4. Delete gate enumeration.
5. Introduce one executable gate catalog and migrate current release/pre-commit/CI consumers to it.
6. Collapse the backlog validators.
7. Merge doc-test consumer rows into the pin graph.
8. Slim guard-reach metadata and finish the existing single-source governance residuals.
9. Only then reassess whether any remaining meta-gates still justify their own independent representation.

The goal is not fewer safeguards for its own sake. The goal is fewer independently authored governance facts while retaining the safeguards that have concrete subjects.
