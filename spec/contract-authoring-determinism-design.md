# Plan authoring: judgment, structure and evidence

Companion to [the remediation workflow](remediation-workflow-design.md).

## One semantic authority

The accepted executable plan owns requirements, units, affected interfaces,
dependencies and acceptance assertions. Original source findings/request are
provenance; review verdicts and landed execution are evidence/history. These are
separate facts, not multiple editable answers to the same design question.

The model authors meaning: what should change, which behavior must survive, what
an interface promises, what counterexample matters, and which assertion would
falsify the proposed solution. The tool validates identities, references, scope,
coverage, dependency acyclicity and revision bindings, and derives prompt and
report views. Do not ask a model to maintain deterministic projections as a
second authority and then repair disagreements between the copies.

## Stable identity and revision

Requirements and execution units keep identities across presentation order changes.
Insertion of an unrelated requirement cannot erase accepted assertions for unchanged
requirements. A materially changed or retired requirement is explicit, not a side
effect of numbering an array again.

A semantic submission names its expected accepted base revision. The tool refuses
stale or wrong-target submissions. Review binds the exact accepted plan revision;
semantic changes invalidate the review that no longer applies. Accepted landed
history remains intact, with explicit follow-up units for subsequent changes.

A revision is a replacement of the semantic plan, not a general JSON patch language.
There is no generic patch engine or linear “invalidate every later phase” mechanism.
Dependencies determine which evidence and decisions a change affects. Revision
binding may conservatively require renewed review when finer independence has not
been established; it must not erase source provenance or completed execution.

## Structural floor before semantic judgment

Use the same schema/validation authority for authoring feedback and ingestion.
Reject malformed plans before commissioning semantic review: duplicate or dangling
identities, uncovered approved sources, invalid paths, cycles, missing requirements,
and inadequate assertion shape are mechanical problems.

A valid schema does not establish an adequate design. Keep independent conceptual
critique, critic and judge, and preserve accepted counterexamples. Positive and
negative assertions need to describe observable behavior, not simply repeat the
requirement. A no-change claim needs explicit evidence and disposition rather than
an invented implementation unit. A structural change still needs an appropriate
verification command or an independently reviewed explanation of inapplicability.

## Derive workload views, not new decisions

After review, generate the implementation frontier, prompts, current-source bindings
and result paths from the accepted plan. Scope and dependency decisions have already
been reviewed. New semantic choices return to plan revision instead of hiding in
late workload generation.

Read and write scope are distinct. The tool grounds paths and enforces the approved
write grant against actual results. A worker's response cannot widen its own grant.
Host-neutral complexity and token estimates describe work; they never select a
provider or shape the plan around backend limits.

## Ground claims, not read attestations

Evidence should support the actual claim. A cited span can establish that quoted
source exists; it cannot by itself prove the interpretation is correct. Tool-observed
commands can establish what ran and its result; a green test does not prove that all
important behavior was tested. Coverage declarations describe the claimed breadth
of investigation, not proof that a model understood every line.

- Verify source anchors against the current bound source; surface missing or stale
  anchors instead of admitting them as grounded facts.
- Distinguish observed command evidence from a worker's unsupported assertion.
- Preserve uncertainty where the tool cannot establish semantic truth.
- Use independent challenge for interpretation, severity, alternatives and adequacy.

Reviewers need bounded relevant source/test context when checking repository premises.
Reviewing a design and supplied evidence is legitimate, but is not automatically an
independent check of the current implementation. Conceptual inquiry retains room for
first-principles judgment; see [conceptual review](conceptual-design-review-design.md).

## Completion evidence

The outcome is a verified change or an explicit unresolved/declined outcome, not a
complete set of intermediate artifacts. Test source-to-unit coverage, stale review
refusal, scope enforcement, interruption recovery and actual integrated behavior.
Keep independent judgments; remove representation maintenance that contributes no
new decision or evidence.
