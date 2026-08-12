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

For setup repair or inspection, use `audit-code ensure`, `audit-code install`,
`audit-code verify-install`, or `audit-code prompt-path`.

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
workload and result-map path under `.audit-tools/audit/`. Result ingestion checks
the run id, work-item id, prompt digest, expected file coverage, and strict
result schema before state advances. Replaying an already accepted result is a
no-op.

There are no provider, model, routing, quota, context-window, worker-command, or
headless-launch settings in audit-tools. Parallelism and concrete execution
choices belong to the host runtime.

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
audit-code validate-results
audit-code requeue
audit-code synthesize
audit-code resynthesize
audit-code cleanup --dry-run
```

Lower-level `intake`, `plan`, `ingest-results`,
`import-external-analyzer`, and `update-runtime-validation` commands exist for
debugging and artifact recovery. Normal conversation use should stay on
`next-step`.

`audit-code cleanup` removes `.audit-tools/audit/` only when the persisted run
is complete or not started. Active, blocked, or missing-state runs are refused
unless the operator explicitly supplies `--force`; `--dry-run` previews the
decision.

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

Durable external-analyzer choices live separately at:

```text
.audit-tools/audit/analyzer-policy.json
```

That strict artifact may contain `analyzers` resolution choices and
`analyzer_consent` decisions. Per-run consent tokens are deliberately not
persistable.

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
