# Audit Goals

This document is the normative product definition for the auditor. Other specs
and docs should defer to it. The human-facing product overview and strategy live
in [`docs/audit-pkg/product.md`](../../docs/audit-pkg/product.md).

## Product identity and boundary

The auditor's product behavior is not "run a particular phase" or "run a
particular tool." It is: **advance the audit by executing the highest-priority
valid next step from the current audit state.** Repeated invocations of the
single entrypoint eventually produce normalized repository understanding,
bounded audit tasks, verified coverage, synthesized findings, runtime-validation
follow-up where needed, and a final completion or blocked status.

The auditor is a single logical skill entrypoint, a stateful audit engine, a
deterministic artifact producer/consumer, a bounded LLM orchestration system,
and a resumable workflow invoked repeatedly until completion. It is **not** a
prompt pack, a CLI toolbox, a static-analysis wrapper, a bare report generator,
or a collection of one-off audit phases.

## Core principles

1. The auditor uses the right tool for each job — it is **not** "100%
   deterministic." Where a mechanical/deterministic tool does the job as well as
   or better than an LLM, it uses the tool; where a bit of non-deterministic LLM
   judgment strongly improves quality, it uses the LLM (bounded and recorded).
2. The LLM is used for bounded semantic code review, synthesis, ambiguity
   resolution, and explicit fallback when deterministic inference fails a defined
   confidence bar — and any property that *can* be guaranteed mechanically is
   enforced in tooling rather than left to LLM instruction-following.
3. The audit is binary: it is either complete or it is not.
4. The final retained output is deterministic Markdown at `audit-report.md`.

## Invariants

1. The system is obligation-driven, not phase-driven.
2. Deterministic artifacts are the source of continuity.
3. LLM work must be bounded and attributable.
4. Progress must be resumable across invocations.
5. Every invocation must make valid progress, report a blocker, or report completion.
6. Prefer deterministic execution whenever possible.
7. The orchestration layer must be able to explain why a particular next step was chosen.

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

The audit is complete only when all of the following hold:

- intake, structure, and planning artifacts are current
- every auditable file/lens coverage obligation is satisfied
- every required critical-flow obligation is satisfied
- all planned deterministic runtime-validation obligations are resolved
- the final deterministic Markdown report (`audit-report.md`) has been rendered
- no blocking condition remains active

The audit is not complete if any work remains inside auditable scope, even if it
is low priority — with one sanctioned exception: a bounded livelock-safety valve.
When the rolling dispatcher cannot make progress on the remaining frontier after a
bounded number of pause/resume cycles (a persistent provider wall or an irreducible
strand), it may stamp a `partial_completion_terminal` and transition to a completed
status on partial coverage rather than looping forever. This is safe precisely
because the audit is read-only; it is a deliberate, recorded terminal
(`recordPartialCompletionTerminal`), never a silent partial-success. Outside that
valve, no partial-success status is introduced.

## Final output and cleanup

- The final authoritative output is repo-root `audit-report.md`.
- The report must be deterministic and work-block-first.
- Root-cause clustering is not part of the mandatory deterministic core: the
  retained deterministic report is work-block-first and does not cluster by root
  cause. The optional LLM synthesis-narrative provider may add an *additive* themes
  layer (carrying a root-cause field) on top of the deterministic report when
  configured; it never replaces, gates, or is required by the deterministic output.
- Cleanup of audit artifacts is available via the `cleanup` CLI command / pre-run cleanup path
  (`cleanupStaleArtifactsDir`), but is decoupled from the completion transition by design — the
  transition itself never triggers it; it also explicitly skips deletion while a run is
  `active`/`blocked`, so artifacts persist through incomplete or blocked runs rather than staying
  minimal.
