# Audit Report

## Work Blocks

### B-001

- Findings: F-001
- Depends on: none

### B-002

- Findings: F-002
- Depends on: none

## Findings

### F-001 — Unvalidated user input in login handler

- Severity: high
- Confidence: high
- Lens: security
- Summary: The login route passes user-supplied email directly to the query.
- Files: src/auth/login.ts
- Evidence:
  - Line 42: `db.query("SELECT * FROM users WHERE email = " + req.body.email)`

### F-002 — Missing rate limiting on password reset

- Severity: medium
- Confidence: medium
- Lens: security
- Summary: The password reset endpoint has no rate limiting.
- Files: src/auth/reset.ts
- Evidence:
  - No rate-limit middleware applied in src/auth/reset.ts

## Scope and Coverage

This report covers the authentication module only.
