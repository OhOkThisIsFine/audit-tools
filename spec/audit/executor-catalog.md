# Executor catalog

## Purpose

This document defines the bounded executable steps available to the orchestrator.

## Executors

### `intake_executor`

Produces:

- `repo_manifest.json`

### `disposition_executor`

Produces:

- `file_disposition.json`

### `structure_executor`

Produces:

- `unit_manifest.json`
- `surface_manifest.json`
- `graph_bundle.json`
- `critical_flows.json`
- `risk_register.json`

### `coverage_initializer`

Produces:

- `coverage_matrix.json`
- `flow_coverage.json`

### `task_generation_executor`

Produces:

- `audit_tasks.json`

### `requeue_executor`

Produces:

- `requeue_tasks.json`

### `result_ingestion_executor`

Consumes:

- `audit_results.json`
  Produces:
- refreshed `coverage_matrix.json`
- refreshed `flow_coverage.json`
- refreshed `requeue_tasks.json`
- refreshed synthesis if configured

### `runtime_validation_planner`

Produces:

- `runtime_validation_tasks.json`
- baseline or merged `runtime_validation_report.json`

### `runtime_validation_update_executor`

Consumes:

- runtime validation update payload
  Produces:
- refreshed `runtime_validation_report.json`
- refreshed `synthesis_report.json`

### `synthesis_executor`

Produces:

- `merged_findings.json`
- `root_cause_clusters.json`
- `synthesis_report.json`

### `validation_executor`

Consumes current artifacts
Produces validation result in-memory or as future artifact

## Bounded-step expectations

Each executor should:

- have clear inputs
- have clear outputs
- verify its own result as much as possible
- avoid mixing unrelated responsibilities

## Future executor categories

- external analyzer import executor
- semantic audit task dispatcher
- runtime validation execution adapter
- completion checker
