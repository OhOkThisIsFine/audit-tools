<!-- audit-tools/audit-report/v1 -->
# Audit Report

## Summary

- Findings: 3
- Work blocks: 2
- Severity breakdown: high: 1, medium: 1, low: 1
- Fully audited files: 3
- Excluded non-auditable files: 1

## Work Blocks

### block-1

- Max severity: high
- Units: src-auth
- Owned files: src/api/auth.ts, src/lib/session.ts
- Findings: AUD-001, AUD-002
- Depends on: none
- Rationale: All findings map to the same owned unit and should be remediated together.

### block-2

- Max severity: low
- Units: src-billing
- Owned files: src/billing/invoice.ts
- Findings: AUD-003
- Depends on: block-1
- Rationale: Findings share owned units transitively and should remain one non-overlapping remediation block.

## Findings

### AUD-001 — Session token accepted without expiry validation

- Severity: high
- Confidence: high
- Lens: security
- Files: src/api/auth.ts
- Summary: Authentication accepts session tokens even when their expiry timestamp is stale.
- Evidence:
  - src/api/auth.ts:42 - token.exp is decoded but never checked against the current time.
  - runtime:auth-expiry: expired token still returned 200.

### AUD-002 — Session refresh path lacks regression coverage

- Severity: medium
- Confidence: medium
- Lens: tests
- Files: src/api/auth.ts, src/lib/session.ts
- Summary: The refresh-token branch has no regression test for rejected expired sessions.
- Evidence:
  - tests/auth.test.ts - no case covers expired refresh sessions.

### AUD-003 — Invoice status can be overwritten after finalization

- Severity: low
- Confidence: high
- Lens: correctness
- Files: src/billing/invoice.ts
- Summary: Finalized invoices can be moved back to draft by a generic status update.
- Evidence:
  - src/billing/invoice.ts:88 - updateStatus does not guard finalized invoices.

## Scope and Coverage

This report is deterministic output from the completed audit. Non-auditable files were excluded from scope before task generation.
