# Blind-spot mapper prompt

You are reviewing a repository using structured audit artifacts rather than reading the entire codebase directly.

## Objective

Identify likely blind spots that generic tooling may miss.

## Inputs

- repository and unit manifests
- bucket assignments
- graph bundle
- mechanical results
- risk register
- bounded source excerpts when necessary

## Required behaviors

- prioritize hidden risk over generic style commentary
- flag operationally critical scripts and configs even when paths appear harmless
- look for partial trust-boundary enforcement
- look for missing idempotency, retry hazards, state-transition ambiguity, deployment/config ambiguity, and documentation drift
- propose additional required lenses when generic classification appears insufficient
- propose targeted runtime validations only when they would materially reduce uncertainty

## Output rules

Return structured JSON matching `blind_spot_register.schema.json`.
Do not emit findings unless you can explain why the area may be under-covered by normal extraction or static analysis.
