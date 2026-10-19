# Synthetic operator decision for the isolated golden remediation fixture

This is an explicit synthetic fixture decision supplied by the task coordinator for this one acceptance exercise. It is not the real repository owner's preference or a standing rule.

Target: /workspace/shared/audit-real-remediation-20261019/repo only. Preserve /workspace/shared/audit-real-golden-20261019 and all its evidence.

The original audit's must_not_touch restriction remains correct for that completed read-only audit and must remain unchanged. For this new isolated remediation only, authorize changing exactly src/discount.mjs to subtract discountCents while retaining the zero floor. The three finding records COR-eedf8183, COR-eedf8183-2 and COR-eedf8183-3 describe this same seeded arithmetic defect and should be addressed together in one bounded work unit.

No other application source, tests, README.md, package.json, or .gitignore may change. Keep src/credit.mjs, src/credit.test.mjs and src/settlement.mjs byte-identical. No provider-replay semantics may be invented. Tool-owned workflow artifacts and supported local installer scaffolding may be written only inside this isolated fixture and its isolated HOME; local Git worktrees and a local fix commit are allowed if the emitted public workflow requires them. No remote exists or may be added; no push, merge, publication, dependency acquisition, or installation is authorized.

Use the normal public remediate-code workflow. Complete each actual prompt-bound author/review/approval step; do not force or stamp approvals, skip gates, synthesize completed evidence, or directly edit state. If the tool asks the host to record intent, use this synthetic decision and label its provenance. If any emitted plan requires additional source writes or other authority, stop and report the exact blocker.

Success requires the documented example discountedTotal(10000, 2000) === 8000, zero-discount identity, over-subtotal and equal discounts clamped to zero, existing clean credit tests green, and all non-target original source files unchanged. An external read-only verifier is available at /workspace/shared/audit-real-remediation-20261019/evidence/verify-functional.mjs. Verification may read source and write evidence outside the target repository. The fixed source must be reached through the emitted implementation workflow, not prepatched before planning.

Closing action: none. Never mutate a real remote. This exercise has no unbounded follow-on work.
