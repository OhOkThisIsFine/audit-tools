# P2 — SHIPPED. Superseded by P4.

Verified at HEAD `430c25d9` on 2026-07-25 by the reviewer and independently by the adversary.

P2's residual — `run-vitest-gate.mjs` short-circuiting on a nonzero vitest exit before the ledger
was consulted — is closed by `5fc913a8` / `605fe61e`:

- `scripts/shared/run-vitest-gate.mjs:73-98` now reads the ledger on the nonzero branch.
- The predicate is single-sourced in `scripts/shared/vitestGateVerdict.mjs:34-41` (token match,
  `outcome.failed === 0`, known stderr signature) and fails **closed** on a missing, unparseable,
  stale-token or outcome-less ledger — all four verified.
- `tests/shared/vitest-gate-false-red.test.mjs` covers five of P2's six prescribed cases.

**One deliberate deviation:** P2's condition 3 (`filesTotal` matches the expected count) was NOT
implemented. The shipped design took P2's own stated fallback instead — a known error-signature
allowlist (`HARNESS_FAULT`).

That substitution is where the surviving defect lives. See
[`../P4-vitest-downgrade-launders-dropped-results/PROPOSAL.md`](../P4-vitest-downgrade-launders-dropped-results/PROPOSAL.md):
a leaf whose result never arrived is bucketed as `skipped`, not `failed`, and the downgrade trigger
is the very RPC that carries results — so a real failure can satisfy every downgrade condition.
Condition 3 would not have caught that either; the correct guard is a terminal-state check.

**Do not re-derive P2 as an open item.** It is done.
