# P0 deep-review rewiring — pre-implementation design gate (2026-08-31)

## Scope and evidence quality

Lap baseline: `82783e00986559f604582fec4cc3d80a1e76fe9f`.

Goal: implement the remaining P0 sequence in
`audit-tools-simplification-workflow-gap-2026-08-26.md` (steps 1–2 and 4–7;
the required Mathematician and Minimalist perspective reservation in step 3 is
already live).

`codebase-memory-mcp` was unavailable (`Transport closed`) for project lookup,
index status, and coverage checks. The maps below therefore use bounded source,
test, history, backlog, and project-memory reads. They are verified positive
seams, not exhaustive negative claims.

## Current seam map

### Intent and review controls

- `src/shared/types/intentCheckpoint.ts` already carries `conceptual_depth`,
  `ceiling`, and `attention`; `ceiling.rung` already admits `deepest`.
- `src/audit/cli/confirmIntentStep.ts` still presents shallow as the normal
  default and renders only `conceptual_depth` plus perspectives in its example.
- `src/audit/orchestrator/charterExtractionExecutor.ts` resolves an explicit
  ceiling first, maps legacy `conceptual_depth: deep` to `deep`, and otherwise
  chooses `shallow`.
- `src/audit/orchestrator/systemicChallengeExecutor.ts` omits the systemic layer
  when the resolved ceiling does not request charters.
- `docs/backlog/open-bugs.md` records that review-depth choices are per-run and
  must not be silently reused from a prior audit. P0 defaulting comprehensive
  intent to deep must therefore remain a fresh-run proposal/confirmation, not a
  persisted preference.

### Conceptual and systemic evidence flow

- `src/audit/orchestrator/designReviewPrompt.ts::renderCharterContext` currently
  renders subsystem members and charter purposes only. The register already
  contains goal graph, deltas, triangulated items, disagreements, and validation
  provenance that are not projected into the perspective or judge prompts.
- `src/audit/cli/conceptualDispatch.ts::prepareConceptualDispatch` materializes
  independent perspective lanes and one judge lane. Perspective result files are
  read by the judge; only the judge's `findings` envelope is ingested.
- `src/audit/orchestrator/designReviewPrompt.ts::renderConceptualJudgePrompt`
  asks the judge to retain, merge, resolve, or drop candidates, but the output
  contract contains only admitted findings. It does not preserve explicit
  rejection dispositions.
- `src/audit/cli/nextStepCommand.ts::emitSystemicChallenge` passes only round,
  prior-finding count, and aggregate metrics to
  `renderSecondOrderAdversaryPrompt`.
- `docs/backlog/open-bugs.md` independently records that this prompt withholds
  the banked finding set and that convergence deduplicates by worker-minted
  identity rather than content.

### Capability limitation reporting

- The install/runtime directive is sourced from
  `skills/audit-code/audit-code.prompt.md` and rendered through the wrapper host
  asset pipeline.
- No structural-capability preflight exists today.
- `src/shared/agentReflections.ts` already accepts `tool_friction` reflections;
  the audit artifact loader carries them into synthesis.
- `src/audit/reporting/synthesis.ts` currently renders all reflections under
  `## Process Feedback`. P0 can promote only the reserved
  `audit-capability-preflight` high/critical subset to `## Audit Limitations`
  without changing the machine contract.
- The preflight must stay in the installed host directive. `CLAUDE.md`, project
  philosophy, and the P0 record all forbid making audit-tools an MCP/provider
  client or restoring the retired execution/routing substrate.

## Retirement and collision verdict

### Clean boundaries

- No history exists for a production `audit-capability-preflight` or
  `Audit Limitations` implementation; the only prior occurrence is the P0 design
  record.
- Reusing the existing perspective lanes, judge, reflection channel, and report
  renderer does not recreate a retired lane kind, provider registry, execution
  adapter, or objective schema.
- The reserved Mathematician/Minimalist selection already shipped and must not be
  rebuilt.

### Collision requiring resolution

`src/audit/types/docsDigest.ts` defines `docs_digest.json` as a
scope-confirmation-only leaf and says nothing downstream may depend on it. The
dependency-map rationale repeats that the digest has deliberately no downstream
row. P0 step 5 nevertheless instructs the systemic adversary to receive the docs
digest. Reading it in the systemic prompt would create a real downstream semantic
dependency while leaving staleness metadata blind to it.

The implementation must choose one explicit contract:

1. promote `docs_digest.json` into the systemic dependency graph and accept that
   a relevant documentation change re-stales systemic review; or
2. preserve the confirmation-only leaf decision and supply systemic review a
   bounded stated-purpose projection derived from an artifact it already depends
   on (for example the charter register), not from `docs_digest.json`.

### Candidate-disposition tension

P0 requires every concrete simplification/telos candidate to be retained,
merged, or explicitly rejected, and says attractive rejections are evidence that
must not be discarded. The current judge contract ingests only a `findings`
array. A prompt-only instruction cannot preserve rejected candidates after lane
consumption. Adding a typed disposition field would contradict P0's instruction
to add no new persistent schema before the benchmark demonstrates a failed axis.
An implementation needs an existing durable channel or an owner-approved narrow
exception; silently dropping the disposition is not compliance.

## Proposed red-first proofs

1. Bare whole-repository/comprehensive intent proposes deep review, while quick,
   named-file, and tightly-scoped intent remains shallow; a new run does not reuse
   a prior run's depth choice.
2. Confirmation renders and round-trips existing `ceiling` (including `deepest`)
   and `attention` controls; shallow output says non-comprehensive.
3. Perspective and judge prompts receive bounded goal/delta/triangulation/
   disagreement/provenance context from the charter register.
4. Systemic prompt contains the actual banked findings and the required
   perspective/judge evidence, plus repository-read and source-verification
   instructions.
5. Every judge candidate has a durable retained/merged/rejected disposition.
6. Installed directive refuses to label a graph-incapable run comprehensive;
   accepted degraded execution records the reserved high/critical reflection.
7. Only matching high/critical preflight reflections render under
   `## Audit Limitations`; unrelated or lower-severity reflections remain Process
   Feedback.

## Independent refutation questions

1. Does any proposed path reintroduce a deliberately retired mechanism?
2. Which adjacent strand becomes newly reachable, and what breaks there?
3. What is the smallest test that fails on the current tree and passes only after
   the intended correction?

## Independent refutation verdict

Reviewer: AGY Gemini 3.7 Flash medium, read-only plan/sandbox lane. The reviewer
received this provenanced map and did not author the plan.

- **Retirement:** clean. The remaining P0 path reuses live lanes and artifacts and
  does not recreate the retired router, provider client, execution adapter, fourth
  extraction lane, or analyzer.
- **Digest collision:** confirmed. The reviewer recommends preserving
  `docs_digest.json` as a confirmation-only leaf and feeding systemic review a
  bounded stated-purpose projection from `charter_register.json`, which is already
  in the systemic dependency graph.
- **Adjacent strand:** making comprehensive intent deep reaches charter
  extraction, clarification, all perspective lanes, and the systemic loop. The
  current systemic prompt is evidence-starved, and current depth reuse can carry a
  prior run's choice into a new run; both must be corrected together with the
  default change.
- **Smallest red proof:** `tests/audit/intent-checkpoint.test.ts` should assert that
  a full-repository confirmation renders deep as the default. It fails today on
  the hard-coded shallow default in `confirmIntentStep.ts`.

### Refuted reviewer suggestion

The reviewer suggested encoding rejected candidates as `info` findings with a
`disposition: rejected` phrase in their summaries. Source verification disproves
that as a durable non-actionable channel: ordinary findings remain in the main
machine contract and work blocks, while only tool-refuted `quarantined_findings`
are excluded (`src/audit/reporting/synthesis.ts`). The suggestion would turn
judge-rejected ideas into remediation inputs and is therefore rejected.

## Owner decisions required before red tests

1. **Docs digest:** preserve the confirmation-only leaf and use a charter-derived
   stated-purpose projection for systemic review, or deliberately promote
   `docs_digest.json` into the systemic dependency/staleness graph.
2. **Rejected candidates:** authorize the smallest persisted disposition extension
   now, despite P0's no-new-schema-before-benchmark rule, or narrow P0 step 6 to
   prompt-enforced judgment whose accepted findings persist while explicit
   rejection evidence remains in transient perspective/judge lane material.

Per the design-check gate, implementation and red-test authoring stop here until
these collisions are resolved.

## Owner resolution (2026-08-31)

1. **Docs digest:** preserve the confirmation-only leaf. Systemic review receives
   a bounded stated-purpose projection derived from `charter_register.json`; no
   dependency edge from `docs_digest.json` is added.
2. **Rejected candidates:** authorize a narrow persisted disposition extension.
   It must preserve every contributor candidate and show how each final result was
   assembled: contributor identity, retained/merged/rejected disposition, target
   final finding, estimated contribution percentage, estimated modification
   percentage, and a concise transformation or rejection rationale.

The percentages are bounded semantic judgments authored by the independent judge,
not tool-invented similarity scores. Tooling owns structural enforcement: all
source candidates accounted for exactly once, all referenced contributors and
final finding IDs real, percentages in `[0,100]`, and contribution shares for each
final finding totaling 100 (including an explicit judge share for judge-added or
judge-synthesized content). This is the owner-approved narrow exception to the P0
no-new-persistent-schema constraint.
