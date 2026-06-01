# Remediation plan — from `meta-audit-log.md` (2026-05-31)

This directory is the **durable, machine-portable** copy of a `/remediate-code`
run that consumed [`meta-audit-log.md`](../../meta-audit-log.md) (the host-agent
journal of auditing this repo with `/audit-code`). The live run state lives in
`.remediation-artifacts/`, which is **gitignored and machine-local** — these files
are committed so the plan is accessible from any machine and survives cleanup.

The full narrative, root-cause analysis, and recommendations are in
[`../../meta-remediation-report.md`](../../meta-remediation-report.md). Start there.

## Two separate outcomes

1. **A bug in `remediate-code` itself — FIXED.** The run surfaced `RC-BUG-1`: the
   no-op detector (`NO_CHANGE_RE`) overrode an explicit `no_change: false`,
   mis-bucketing 5 substantive findings (incl. the central quota fix) as "Already
   Correct" and mislabeling them on merge. Fixed on branch
   **`fix/no-change-honors-explicit-flag`** (commit `a9fdf47`, full suite 375/375,
   pushed). Open the PR:
   <https://github.com/OhOkThisIsFine/audit-tools/pull/new/fix/no-change-honors-explicit-flag>

2. **A remediation plan for `audit-code` — PAUSED, NOT IMPLEMENTED.** The 14
   findings below were planned and documented but **no audit-code source was
   modified.** The run paused at the implementation approval gate (status
   `documenting`). These specs are the input for resuming implementation later.

## Why implementation was paused

- The `/remediate-code` skill runs from the **globally-installed bin** (`remediator-lambda@0.4.3`),
  which is a separate copy from this working tree and is **stale** — it lacks the
  RC-BUG-1 fix, so a live run would still corrupt the final report. Resume only
  after the fix is published/deployed, or by driving the run against the local
  build (`node packages/remediate-code/remediate-code.mjs`).
- The session was driven from multiple machines via remote control; pausing avoids
  a half-applied implementation split across machines.

## How to resume the audit-code implementation

1. Deploy the RC-BUG-1 fix (merge + publish `remediator-lambda`, or drive via the
   local wrapper above).
2. From a single machine at the repo root, re-run `remediate-code next-step`. The
   run state in `.remediation-artifacts/` resumes at the approval gate. (If that
   state was cleaned, re-seed from this directory's `extracted-plan.json` +
   `item-specs/`.)
3. Approve at the gate, then proceed through the implement phase. Build order
   matters: **build `@audit-tools/shared` first** (stale `shared/dist` produces
   misleading TS errors in dependents).

## Contents

| File | What it is |
|---|---|
| `remediation-brief.md` | Launch brief — full scope, both clarifications resolved (full scope + maximal quota depth). |
| `extracted-plan.json` | The 14 findings and 7 blocks (the plan skeleton). |
| `impl-risk-reviewed.json` | Reviewed risk tiers (2 rule false-positives corrected). |
| `item-specs/document-FINDING-0NN.result.json` | One ItemSpec per finding: concrete change + tests to write. **The implementation contract.** |

## The 14 findings (see `item-specs/` for the concrete change each)

| ID | Tier | Title |
|---|---|---|
| F-001 | substantive | Provider resolution forces `local-subprocess`; active backend never detected |
| F-002 | substantive | Canonical dispatch path never acquires live quota (**central regression**) |
| F-003 | substantive | No provider implements real quota querying (`queryLimits` stub) |
| F-004 | substantive | Cascading quota-signal fallback chain (single-source it) |
| F-005 | substantive | Add Codex + Antigravity providers (resolution + best-effort quota) |
| F-006 | substantive | Windows path-join bug → malformed artifacts dir name |
| F-007 | safe | CLAUDE.md priority chain drifted from live `PRIORITY[]` |
| F-008 | substantive | Single-worker canary before dispatch fan-out |
| F-009 | substantive | Sampling / coverage-budget (top-K) mode with honest partial reporting |
| F-010 | substantive | Human-in-the-loop confirmation before large fan-out |
| F-011 | substantive | Anchor loader commands to an explicit cwd |
| F-012 | substantive | Echo resolved scope before writing artifacts |
| F-013 | substantive | Bounded effort budget for `design_review` |
| F-014 | safe | Point findings output at a machine-validatable JSON Schema |

> ⚠️ The ItemSpecs reference specific source locations (line numbers, function
> names) verified against the working tree on 2026-05-31. Re-verify against current
> source before implementing — these are an advisory plan, not a patch.
