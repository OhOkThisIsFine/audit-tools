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
audit-code explain-task <task_id>
audit-code validate
audit-code validate-results --results <file>
audit-code requeue
audit-code synthesize
audit-code resynthesize
audit-code unaccept-results --work-item <id>   # repeatable, or --all
audit-code cleanup --dry-run
```

Lower-level `intake`, `plan`, `ingest-results`,
`import-external-analyzer`, and `update-runtime-validation` commands exist for
debugging and artifact recovery. Normal conversation use should stay on
`next-step`.

`audit-code unaccept-results` removes entries from the run's accepted
host-results pair — the supported way back out of an acceptance that turned out
bad and that `next-step` does not withdraw itself (it withdraws a pending
task's entry that no longer validates, for example after a validator change).
It refuses a
pair it cannot validate, records each removal so a repaired run stays
distinguishable from a clean one, invalidates the persisted step contract, and
the next `next-step` re-reads the bound result files for the dropped items.

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

Remediation runs the target repository's declared build, typecheck, lint and test
commands at verification boundaries. If no executable verification is available,
the workflow asks for a command or a stop instead of reporting success. An approved
`next-step --verification-command <command>` supplies the test command without
silently dropping other declared checks.

To request independent per-result contract conformance review, set
`conformance_review: true` in the confirmed intent checkpoint before the first
implementation handoff. It is off by default. The tool binds that choice to the
run; successful landed and no-change outcomes then require the bound review after
mechanical checks. Changed result or contract content invalidates the review.
Insufficient evidence requests repair; unavailable independent review pauses.
Accepted review declarations survive closeout in the outcomes and report.

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
