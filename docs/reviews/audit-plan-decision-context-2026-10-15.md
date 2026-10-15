# Refactor plan decision context

<!-- review-routing: backlog-bugs -->

The [canonical plan](audit-final-refactor-plan.md) replaces the October 14 plan at
the same path. Its supplied source is Git blob
`fa34c62817d6d7ac0bcd66f3c056d4f1a64dee78` (29,035 bytes, SHA256
`ade3041d540f62fd65b49d8ac5933df6234d5086f8eaf086feb11e7b137585b6`).
The only addition to those source bytes is the required review-routing declaration.
This record preserves decision continuity; it does not qualify future patches.

## Prior decisions that still apply

The earlier plan's eleven-unit program is superseded by the new bounded repair
set and optional equivalence work. Its safety constraints remain: replace a
mechanism atomically with its callers and tests; preserve independent review,
result revalidation, checksum-first verification, cycle guards and scope/index
freshness. No provider inventory, routing/quota subsystem, new orchestration
framework or revival of the discarded October 5 dogfood run follows from this plan.

Snapshot cleanup/recovery authority and managed artifact-write safety remain on
hold. Their presence in the old plan never established delivery or renewed
authorization. Preserve user artifacts and unknown recovery work.

The public runner exposure (prior SEC-04) remains confirmed and deferred for an
explicit compatibility/trust-contract decision. Basename restriction alone is
insufficient; no new production wiring or read-only sandbox guarantee is allowed.
Source-observation sharing still needs a frozen-source invalidation proof. npm
publish-cache hardening remains optional/deferred. The new plan's deferred register
is the current scope authority; prior accepted work now present in the baseline
must not be repeated.

## Full-history retirement findings for the priority units

Inspection used the exact plan baseline and a non-shallow checkout, including the
former package paths. Symbol pickaxe searches and
`git log --oneline --grep=retire --grep=revert --grep=delete -i -20` found no
retirement forbidding the three proposed repairs. This is bounded historical
evidence, not independent patch review or red/green test evidence.

- Delta: `5bc92311` introduced newline-trimmed discovery; `e549cfa6` introduced
  honest full-audit fallback for unusable refs and explicit coverage inheritance.
  `e65c990c` replaced the permissive private NUL reader with the existing structured,
  complete-output discovery boundary. Reuse that boundary without restoring silent
  unknown-as-clean authority. `ea39087a` requires asynchronous fold-reachable
  children; `c00c5bd4` preserves frozen-source Git and live/source identity semantics.
  The compatibility array adapter does not establish scope authority.
- Release: `1135d644` established default-branch release restrictions and tokenless
  OIDC; `c93f1fba` extended live restrictions to manual dispatch while preserving
  off-default dry runs. `84ab9248` retired the three-package workflow.
  `4de57c36` split checks and sharded tests, keeping publish dependent on both.
  `e33d2bdb` added full history to test jobs for benchmark pins; ancestry verification
  needs history in its own job too. A workflow-scoped pickaxe search for
  `merge-base` found no earlier ancestry check to restore or contradict.
- Landing: `3b927aba` introduced protection-derived requirements, pinned app
  identity, latest-run precedence and legacy commit-status fallback. Only all-pinned
  requirements make statuses irrelevant; mixed/legacy/unpinned requirements still
  need them. Preserve exact-SHA qualification and transient-failure backoff.
  `b547a88f` changed already-deleted branch cleanup, not polling policy. Direct
  pushes remain superseded by required-check landing; do not restore a separate
  mandatory PR-review requirement.

Commands included `git log --oneline -S<symbol>` for `changedFiles`,
`readGitPathList`, `gitPathsOrNull`, `resolveAuditScope`,
`evaluateRequiredChecks`, `/check-runs` and `/status`, plus workflow pickaxes for
`TARGET`, `Gate release to default branch` and `merge-base`. The delta searches
included both current source and former package locations; the matching commits
were inspected with `git show` rather than treating commit subjects as verdicts.
