# Audit skill

This directory is intended to hold the portable skill definition for code auditing.

## Intended components

- prompts
- task templates
- schemas
- orchestration rules
- lens definitions
- coverage rules

## Operating model

1. Collect structured artifacts using deterministic tools.
2. Normalize those artifacts into stable JSON schemas.
3. Dispatch bounded LLM tasks using the normalized artifacts.
4. Record reviewed file ranges and findings in structured form.
5. Requeue uncovered ranges until coverage rules are satisfied.
