# Audit Goals

This document is the normative product definition for the auditor. Other specs
and docs should defer to it.

## Core principles

1. The auditor is deterministic by default.
2. The LLM is used only for bounded semantic code review and explicit
   critical-flow fallback when deterministic inference fails a defined
   confidence bar.
3. The audit is binary: it is either complete or it is not.
4. The final retained output is deterministic Markdown at `audit-report.md`.

## Deterministic vs LLM boundaries

Deterministic responsibilities:

- repository intake and file discovery
- scope exclusion
- unit, graph, surface, and initial critical-flow inference
- task generation
- result validation and coverage accounting
- runtime command discovery and execution
- completion checks
- work-block generation
- final Markdown rendering
- cleanup and resume behavior

LLM responsibilities:

- semantic review of assigned auditable source files
- critical-flow fallback only when deterministic flow inference explicitly marks
  itself below the confidence bar

## Auditable scope

Only auditable code/config artifacts may create audit obligations.

The following must be excluded from auditable scope:

- logs
- licenses
- lockfiles
- generated artifacts
- vendored artifacts
- binary artifacts
- trivial non-code files

Excluded files may remain visible in intake/disposition, but they must not
produce units, audit tasks, requeue tasks, runtime-validation tasks, or
completion blockers.

## Coverage semantics

- Whole-file review is the unit of audit coverage.
- Audit results must declare `file_coverage: [{ path, total_lines }]`.
- Partial-range review is not a supported completion unit.
- A task is complete only when all of its assigned files are covered.

## Runtime validation

- Runtime validation is planned only when a deterministic command can be
  discovered from known project signals.
- When planned, runtime validation is part of the audit and must resolve before
  completion.
- If no deterministic runtime path exists, runtime validation is treated as not
  required and must not leave placeholder pending blockers.

## Critical flows

- Critical-flow inference is deterministic first.
- The deterministic flow pass must record whether it met the confidence bar.
- LLM fallback is allowed only when that explicit confidence check fails.

## Completion

The audit is complete only when:

- all auditable coverage obligations are satisfied
- all planned runtime-validation obligations are resolved
- the final deterministic Markdown report has been rendered

No partial-success status should be introduced.

## Final output and cleanup

- The final authoritative output is repo-root `audit-report.md`.
- The report must be deterministic and work-block-first.
- Root-cause clustering is not part of the product.
- Once the audit completes, other audit artifacts should be cleared out.
- During incomplete or blocked runs, only minimal resumable state should remain
  under `.audit-artifacts/`.
