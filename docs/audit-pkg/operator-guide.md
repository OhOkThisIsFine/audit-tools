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
advances; the full check set is the generated block in
[`contracts.md`](contracts.md). Replaying an already accepted result is a no-op.

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
bad (for example a result accepted before a validator change). It refuses a
pair it cannot validate, records each removal so a repaired run stays
distinguishable from a clean one, invalidates the persisted step contract, and
the next `next-step` re-reads the bound result files for the dropped items.

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

Durable external-analyzer choices live separately at:

```text
.audit-tools/audit/analyzer-policy.json
```

That strict artifact holds `analyzers` resolution choices only (`repo`, `ephemeral`,
`permanent`, `skip`, `auto`). Analyzer consent — grants and declines alike — is
strictly per-run: the `analyzer_consent` offer step asks the operator fresh on every
run, and a legacy `analyzer_consent` key left by an older release is ignored (it can
neither authorize nor veto the new run). Per-run consent tokens are deliberately not
persistable.

## Audit mutation is opt-in

An audit leaves the audited tree unchanged by default. The phase-1 deterministic
auto-fix (formatters such as prettier, black, sqlfluff, gofmt over the audited
in-scope files) runs only when the current run explicitly opts in:

```text
audit-code next-step --allow-auto-fix
```

`--auto-fix-dry-run` reports what the phase would do without spawning a formatter
and keeps precedence over the opt-in. The plan draw (`audit-code plan`) honors the
same flags.

## Remediation planning and review choices

To complete planning and stop before the first implementation handoff, start
from the target repository with:

```bash
remediate-code plan-only --input <path>
```

Follow the emitted prompts and use bare `remediate-code next-step` calls through
the normal intake, clarification, and planning gates. The tool saves the
completed plan as a paused run before dispatching implementation work. Later,
run `remediate-code resume`, then `remediate-code next-step` to continue from
that plan without repeating accepted work. `plan-only` also accepts
`--worktree-location` and `--worktree-outcome` to record the host's worktree
information with the pause; the tool does not create or remove that worktree.

An independent per-result review of cited contract evidence is optional. To
choose it for a new remediation run, use:

```bash
remediate-code next-step --input <path> --conformance-review
```

The choice may also be made during planning, before the first implementation
dispatch. It then persists across bare `next-step` calls and `recover-ingest`;
there is no need to repeat the flag. The default is off, and a first-time
opt-in after dispatch is refused. This review judges whether cited evidence
demonstrates conformance to the carried contracts. It never replaces the
mechanical obligation-coverage or required-test checks.

For a run created by an older release without the current review policy, the
tool conservatively treats the choice as off and does not allow late opt-in.
If an old selection sidecar remains without a primary review policy, ingestion
refuses regardless of that sidecar's contents. A current run whose review
policy is missing or does not match its plan is also refused. To opt in after
either refusal, start a fresh run from the original source in a **new**
artifacts directory:

```bash
remediate-code next-step --input <source> --artifacts-dir <new-directory> --conformance-review
```

Keep the older artifacts directory intact as the record of the interrupted
run. Do not edit its state or selection sidecar to make it pass.

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
