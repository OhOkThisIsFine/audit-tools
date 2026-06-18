# External analyzer adapters

This directory is for adapters that normalize outputs from external tools into the repository's stable artifact formats.

Initial targets:

- semgrep-like SAST results
- dependency vulnerability scanners
- secret scanners
- lint/typecheck diagnostics
- test coverage summaries

Adapter rule:

- parse tool-native output
- normalize into repository schemas
- avoid embedding tool-specific assumptions into downstream prompts when possible
