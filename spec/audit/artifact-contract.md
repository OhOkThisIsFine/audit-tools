# Artifact contract

## Purpose

Artifacts are the continuity layer for the single-entrypoint audit engine. They are the authoritative representation of current audit state between invocations.

## Artifact rules

1. Every artifact must have a defined producer.
2. Every artifact must have a defined consumer.
3. Every artifact must have defined freshness dependencies.
4. Artifacts must be machine-readable and stable.
5. Orchestration decisions should be based on artifacts, not hidden transient reasoning.

## Core artifacts

### `repo_manifest.json`

Producer: intake executor
Consumers: almost everything downstream
Stale if: repository intake changes

### `file_disposition.json`

Producer: disposition executor
Consumers: unit planning, coverage initialization, extraction filtering
Stale if: repo manifest changes or disposition logic changes

### `unit_manifest.json`

Producer: unit planning executor
Consumers: task generation, risk, runtime validation, coverage
Stale if: repo manifest or file disposition changes

### `surface_manifest.json`

Producer: surface extractor
Consumers: flow inference, risk, semantic audit planning
Stale if: repo manifest or file disposition changes

### `graph_bundle.json`

Producer: graph extractor
Consumers: structural review, synthesis, future clustering improvements
Stale if: repo manifest or file disposition changes

### `critical_flows.json`

Producer: flow extractor
Consumers: flow-aware tasks, flow coverage, runtime validation
Stale if: surface manifest or repo structure changes

### `risk_register.json`

Producer: risk planner
Consumers: prioritization, runtime validation planning
Stale if: unit manifest or critical flows change

### `coverage_matrix.json`

Producer: coverage initializer / result ingestion / coverage reconciler
Consumers: requeue, completion, validation
Stale if: audit results change or planning baseline changes

### `flow_coverage.json`

Producer: flow coverage reconciler
Consumers: flow requeue, runtime validation planning, completion
Stale if: critical flows or coverage matrix change

### `audit_tasks.json`

Producer: task generation executor
Consumers: external audit execution loop
Stale if: unit manifest or flow planning changes materially

### `requeue_tasks.json`

Producer: requeue executor
Consumers: external audit execution loop
Stale if: coverage or flow coverage changes

### `runtime_validation_tasks.json`

Producer: runtime validation planner
Consumers: external runtime validation execution
Stale if: risk, units, or flow coverage change

### `runtime_validation_report.json`

Producer: runtime validation update executor
Consumers: synthesis
Stale if: tasks change or new evidence arrives

### `audit_results.json`

Producer: external LLM/task execution loop
Consumers: coverage, synthesis
Stale if: new results are added or replaced

### `external_analyzer_results.json`

Producer: external analyzer adapters
Consumers: future risk/synthesis/planning enrichers
Stale if: imported analyzer data changes

### `design_assessment.json`

Producer: deterministic design assessment executor and optional design review worker
Consumers: synthesis and planning context
Stale if: repository structure, dependency graph, surfaces, or critical flows change

The optional design-review portion may include observational contract assessment.
That mode infers existing contracts from the repository artifacts and inspected
code: invariants, trust boundaries, preconditions, postconditions, data
lifecycle obligations, and critical-flow guarantees. It should attack those
inferred contracts with concrete counterexamples and report evidenced gaps using
categories such as `inferred_contract_gap`, `trust_boundary_gap`,
`invariant_counterexample`, and `critical_invariant_coverage_gap`. It must not
invent a new contract DSL, create a remediation plan, edit source code, or turn
audit-code into an implementation pipeline.

### `merged_findings.json`

Producer: synthesis executor
Consumers: end users, future prioritization layers
Stale if: audit results or runtime validation report change

### `root_cause_clusters.json`

Producer: synthesis executor
Consumers: end users, remediation planning
Stale if: merged findings or runtime validation report change

### `synthesis_report.json`

Producer: synthesis executor
Consumers: end users, completion logic
Stale if: synthesis inputs change
