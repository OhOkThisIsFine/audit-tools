# Operator Guide

## Install and bootstrap

Install once:

```bash
npm install -g audit-tools
```

Then invoke `/audit-code` in a supported host. The prompt idempotently
bootstraps the current repository with:

```bash
audit-code ensure --quiet
```

For setup repair or inspection, use the installer verbs, plus the
`audit-code prompt-path` helper. Their one home is
[`product.md`](product.md#supported-surfaces): the installer-verb block there is
generated from the module both bins read, and `audit-code <verb> --help` prints
the same summary plus its options.

The install surface includes the repo-local import prompt, getting-started
guide, manifest, and the host-specific command or skill files supported by the
active environment. `.audit-code/install/GETTING-STARTED.md` is the canonical
repo-local bootstrap handoff.

## Conversation and host boundary

The conversation is the product surface. audit-tools owns deterministic
discovery, planning, persisted state, result validation, and synthesis. It does
not select or launch execution backends. When semantic review is ready it emits
a complete, provider-neutral host workload; the conversation host decides how
to assign those bounded items and writes the bound result files.

Each `next-step` invocation writes:

```text
.audit-tools/audit/steps/current-step.json
.audit-tools/audit/steps/current-prompt.md
```

Follow only the returned prompt. A review handoff also writes a versioned host
workload and result-map path under `.audit-tools/audit/`. Result ingestion binds
every result to its run, work item and prompt and verifies it before state
advances; the mechanical check set is the generated block in
[`contracts.md`](contracts.md). Replaying an already accepted result is a no-op.

There are no provider, model, routing, quota, context-window, worker-command, or
headless-launch settings in audit-tools. Parallelism and concrete execution
choices belong to the host runtime.

## Functional preflight and review context

The first audit `next-step` emits a `functional_preflight` prompt with the exact
report path and current run identity. The host records source and relationship
inspection it actually performed. Installed tool names alone do not establish
capability. Both capabilities permit `ready`; unavailable source inspection
requires `stop`. Limited relationship inspection permits `degraded` only with an
explicit operator decision and a concrete limitation carried into the audit report.
A missing or stale declaration does not permit semantic work, including through
direct ingestion or recovery commands. Follow the emitted prompt rather than
inventing capability fields or reusing another run's declaration.

Some review lanes require an independent context. Their prompts specify a bound
review envelope and output path; ordinary work items retain their normal result
contract. Unavailable required review pauses instead of silently becoming self-review.
A declaration describes the host's context, not verified reviewer identity. See
[semantic review submissions](contracts.md#semantic-review-submissions).

## Backend fallback

From the target repository root:

```bash
audit-code next-step
```

The wrapper defaults artifacts to `<repo-root>/.audit-tools/audit` and advances
one bounded, persisted step. Useful diagnostic and recovery commands include:

```bash
audit-code status
audit-code validate
audit-code synthesize
audit-code resynthesize
audit-code cleanup --dry-run
```

`synthesize` (also `force-synthesis`) renders the deterministic working report
once all current review questions have accepted answers. It does not accept
staged results, skip earlier obligations, or finish the narrative and report
handoff. Run `next-step` to advance any of those steps.

Use `audit-code plan` to prepare the question plan without dispatching review.
Submit a response to an issued question with the exact `audit-code submit`
command in its assignment. Submit validates the binding and records the result
in the current run; a refusal does not change the ledger.

The question-based machine report records current and historical accepted
answers, part-level coverage, gaps, disagreements and their recorded decisions,
and evidence identities. A report can be incomplete while carrying confirmed
defects. Findings on one part don't close another. Design opportunities and
leads are visible but are not actionable remediation findings. Consolidation
requires a recorded same-cause, same-repair decision; each source claim and
its verification obligations remain distinct.

Before finalizing the active run, use `audit-code consolidate-findings --from <path>`
only for a reviewed same-cause, same-repair decision. The JSON records a
`decision_id`, `decided_by`, a `reason`, and at least two `sources` with exact
`answer_id` and `finding_id` values from current accepted answers. Stale or
overlapping decisions are refused. This does not rewrite a finished report.

`audit-code resynthesize` regenerates Markdown only while the current question
plan and working report still own the promoted v2 machine report. It leaves
the machine JSON unchanged and requires any explicit input to match it exactly.
After rollover, retained Markdown is left intact together with its charter
and process feedback evidence.

A reported observation should say what actually ran and under what conditions.
Analyzer findings are leads, not proof that a particular behavior occurred.
Report cases you could not observe as unmeasured or inconclusive. A copied log,
an old source key, or a reviewer assertion cannot stand in for a bound execution
receipt. Accepted question answers remain in the ledger; do not edit or delete
them to hide disagreements.

A completed audit keeps `.audit-tools/audit/`: the next `next-step` rolls it
over, keeping the derived work (so only what changed is reviewed again) and the
session intent file below, and deleting everything that belonged to the finished
run — the analyzer policy file below included, so each audit asks its analyzer
questions again.

`audit-code cleanup` removes `.audit-tools/audit/` only when nothing in the
directory is still owed to the host: the persisted run is `not_started`, or it
is `complete` and every artifact promotion archives is already one level up.
Active or blocked runs are refused, and so is a complete run whose report is not
fully promoted — that directory holds the only copy. All three refusals are
waived by `--force`. A directory with no `audit_state.json`
marker is refused whether or not `--force` is supplied: `--force` waives the
evidence about a run's STATUS, never the evidence about its IDENTITY, and the
verb will not delete a directory it cannot prove is an audit run. `--dry-run`
previews the decision.

## Repository intent and analyzer policy

Every ordinary `audit-code` run prepares evidence before asking whether to
continue with an audit:

1. `analyzer_selection` inventories the admitted source and its build and CI
   configuration. Select the relevant registered candidates and identify
   suitable repository-specific checks. This decision is not execution or
   installation consent.
2. The selected checks run under the current run's permissions.
   `analyzer_calibration` asks the orchestrator to verify signal quality and
   coverage, fix or tune what it can, and rerun only affected tools on the
   frozen source. The step exposes the graph and an import command for
   authorized supplementary checks. Unresolved gaps stay in the evidence.
3. At `confirm_intent`, either stop with the analyzer results, calibration
   record, and queryable graph, or confirm scope and lenses and continue.
   Stopping does not write an intent checkpoint or mark an audit complete.
   A subsequent continuation reuses the same evidence while it is current.

The one repository session-intent file is:

```text
.audit-tools/audit/session-config.json
```

It is optional. Absence means the strict defaults below; a present file with an
unknown key or invalid value fails closed.

```json
{
  "review_mode": "attended",
  "observability": "standard"
}
```

`review_mode` accepts `attended` or `autonomous` and records user intent only;
it never authorizes audit-tools to launch semantic work. `observability`
accepts `standard` or `verbose`.

External-analyzer choices for the current audit live separately at:

```text
.audit-tools/audit/analyzer-policy.json
```

That strict artifact retains `analyzers` resolution choices across the
continuations of one audit, not standing permission to install or run
analyzers; the next audit's rollover deletes it. Grants and declines apply only to the
current audit, recorded in its tool-owned `run-consent.json`. Resume keeps that
run's decisions; a fresh run asks again. Legacy `analyzer_consent` entries are
ignored as authorization. Transient consent tokens are never persisted.

Audits leave source bytes unchanged by default. Formatting requires explicit
per-run `next-step --auto-fix` approval. Once `--dry-run` is selected, formatting
stays disabled for the rest of that run, even when later continuations omit it.

## Remediation control and verification

From the target repository, the host can use:

```bash
remediate-code next-step --plan-only
remediate-code pause
remediate-code resume
remediate-code cancel
```

Plan-only completes planning and persists a pause before implementation dispatch.
Pause preserves the current phase, accepted work and workload binding; resume
continues from that live state. Cancel is terminal for the current run and
preserves its work and diagnostics. Follow the emitted continuation after each
command; pause and cancel are not cleanup commands.

Remediation planning and plan review can query dependency links on demand. A matching
audit graph is reused, including the compact copy retained when the audit is
cleaned up. If that graph is missing or its source bytes have changed, remediation
builds a native graph using the same extractor. Links guide source inspection;
they do not replace verification. This handoff does not require a host-local
Codebase Memory index to survive the audit.

Remediation runs the target repository's declared build, typecheck, lint and test
commands at verification boundaries. If no executable verification is available,
the workflow asks for a command or a stop instead of reporting success. An approved
`next-step --verification-command <command>` supplies the test command without
silently dropping other declared checks.

To request independent per-result contract conformance review, set
`conformance_review: true` in the confirmed intent checkpoint before the first
implementation handoff. It is off by default. The tool binds that choice to the
run. In ordinary ingestion, landed and no-change results pass structural
checks and bound independent review before required tests are run. A passing
review never replaces those tests; the tool rechecks the binding afterward.
Changed result or contract content invalidates the review.
Insufficient evidence requests repair; unavailable independent review pauses.
Accepted review declarations survive closeout in the outcomes and report.

For one release with independent fixes, give each unit focused test commands,
omit optional phase ordinals, and let native close run the full suite after
the fixes have been merged and accepted. An explicit phase boundary can run
its own checks. A previous external suite log, even one naming the merged
commit, cannot substitute for native close verification.

## Generated deliverables

The machine contracts are authoritative:

```text
.audit-tools/audit-findings.json
.audit-tools/remediation-outcomes.json
```

Their Markdown reports are renders. Run `audit-code validate` after manual
artifact recovery and before treating an interrupted audit as complete.

## Windows notes

Run the wrapper from the repository root when possible. Runtime validation
handles package-manager shims such as `npm`, `npx`, `pnpm`, and `yarn` through
the Windows command shell. A `not_confirmed` runtime result may still be an
environmental failure when a project command starts but cannot write its build
output.
