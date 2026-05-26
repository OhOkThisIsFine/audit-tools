# Implementation alignment

## Purpose

This document explains how current implementation pieces should map to the target single-entrypoint product architecture.

## Current state

The repository currently exposes multiple CLI commands for convenience during development:

- intake
- plan
- ingest-results
- update-runtime-validation
- validate
- requeue
- synthesize
- sample-run

These are useful during build-out, but they are not the intended final product surface.

## Target state

The final product surface should be a single orchestration entrypoint that internally selects one of these executor-like behaviors.

## Mapping

### Current command: `intake`

Target role: `intake_executor`

### Current command: `plan`

Target role: combination of:

- `disposition_executor`
- `structure_executor`
- `coverage_initializer`
- `task_generation_executor`
- `runtime_validation_planner`

This command will likely need to be split internally into multiple discrete executors even if development convenience keeps it grouped for a while.

### Current command: `ingest-results`

Target role: `result_ingestion_executor`

### Current command: `update-runtime-validation`

Target role: `runtime_validation_update_executor`

### Current command: `requeue`

Target role: `requeue_executor`

### Current command: `synthesize`

Target role: `synthesis_executor`

### Current command: `validate`

Target role: `validation_executor`

## Refactor direction

The implementation should gradually move toward:

- explicit audit state representation
- executor registry
- dependency-aware staleness computation
- orchestrator choosing one executor per invocation
- CLI becoming mostly a debugging/development surface

## Anti-drift rule

No new feature should be added without answering:

1. which obligation does it satisfy?
2. which executor owns it?
3. how does `advance_audit` know when to call it?
4. what artifacts does it read/write?
5. what becomes stale when it changes?
