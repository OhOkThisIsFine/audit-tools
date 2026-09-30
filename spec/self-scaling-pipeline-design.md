# Self-scaling remediation pipeline — design

> Supersedes the earlier "give document input a separate lean fast path" framing of the
> *Make the loop cheaper* backlog item. Durable conceptual design; no dated status here.

## Principle

One reviewed-change-plan engine handles audit findings and free-form requests.
Scale detail and challenge to uncertainty and consequence; do not fork a trusted
fast path and a separate deep engine. A small change should not need a complete
model of unaffected modules merely to satisfy the same artifact sequence as a
cross-system redesign.

### Adversarial depth

Conceptual critique, critic and judge remain distinct responsibilities. Risk
changes how deeply they investigate and the evidence they need; it does not let
an author certify its own exit. A small change at an authentication or persistence
boundary can warrant deep review even if it touches one line.

### Authoring granularity

The executable plan is one semantic subject, with stable requirements and cohesive
units. One authoring round may describe several independent units; a difficult
boundary may require focused investigation and revision. Granularity follows real
decisions rather than a fixed number of representations or round trips.

A counterexample revises the actual plan and invalidates affected approval. Views,
coverage summaries and dispatch metadata are derived. There is no late semantic
planner after approval and no separate editable graph maintained only for a gate.

### Escalate on evidence

An initial risk assessment is provisional. New evidence of a cross-boundary
interaction, unhandled failure mode or inadequate test increases scrutiny of the
affected work. It does not restart unrelated accepted work or erase landed history.

## Shared risk signal

Use data available at the decision point: confirmed intent, affected source,
consequence and known boundary risks. The intake signal cannot depend on planning
artifacts that have not been authored. Uncertainty warrants investigation, never
silent exemption from verification. The shared signal informs depth and unit
coordination within the same pipeline.

## Relationship to execution

Source findings retain their identities and dispositions; execution units describe
work. Both input paths converge on the same reviewed plan and bound handoff. A
conversation request does not require an intermediate synthetic finding shape.
See [the workflow contract](remediation-workflow-design.md) for authority,
revision and acceptance boundaries.

## Invariants this must preserve

- Every change still passes the whole-repo green gate (build + check + tests) before it lands — the
  dials scale *design scrutiny + ceremony*, never the final verification.
- Nothing reaches zero adversarial scrutiny (light-floor).
- The risk/complexity signal is computed only from data available when it's needed (no
  pipeline-output circularity); unevaluable ⇒ fail toward more scrutiny, never less.
