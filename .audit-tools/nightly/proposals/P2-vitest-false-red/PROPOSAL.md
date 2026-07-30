# P2 — the vitest gate turns a green suite into a red one, and nothing catches it

**Leg 3 proposal. Nothing here has been landed.**

## The recurrence (counted, after adversarial correction)

The reviewer claimed 5 entries / 4 dates. The adversary refuted two of the five as a
different pattern (a *check that never ran* is a coverage gap, not an exit code lying)
and one as undated. What survives:

| Date | Entry | Direction |
|---|---|---|
| 2026-07-15 | `docs/backlog.md:885` — local `verify:release` exited **0** while reporting "3 failed"; a Gate-0 double-rank bug reached release CI | false GREEN |
| 2026-07-21/-22 | the retired partial-wave entry (git `7427c3dc^`) — product exit codes lied in **both** directions; its own words: *"False-red family (inverse of the vitest false-green)"* | both |
| 2026-07-24 | `docs/backlog.md:103` — full vitest run **exits 1** while reporting 7400 passed / 0 failed (`Timeout calling "onTaskUpdate"`), seen **twice in one lap** | false RED |

**3 distinct dates.** Above the "a one-off is not a pattern" bar.

## Why the reviewer's original mechanism was wrong

The reviewer proposed a new `scripts/verdict.mjs` that "exits on parsed counts, not on
the runner's status". That is a duplicate of an existing file *and* re-implements it the
way that file explicitly documents as unsound. `scripts/shared/run-vitest-gate.mjs:16-21`:

> Do not "fix" a slow/awkward result here by grepping stdout for `/failed/` or
> `/passed/`: the backlog documents two false hits from exactly that shortcut (a test
> literally named "fail-closed", and "Test Files 1 passed" matching before "Tests 12
> passed"). Prose contains arbitrary author-chosen test names by construction, so no
> keyword match over it is sound.

The gate already exists, is already wired into `test`, `test:single`, `test:doc-contract`,
`verify:guards` and `verify:release`, and already reads a **structured** `outcome` from a
token-bound ledger. The false-green half is closed.

## The actual residual — three lines

`scripts/shared/run-vitest-gate.mjs:64-66`:

```js
if (vitestExit !== 0) {
  process.exit(vitestExit);
}
```

The non-zero branch short-circuits **before** the ledger is consulted. So a harness
failure that leaves every test passing (the 2026-07-24 `onTaskUpdate` RPC timeout)
propagates as a red gate, and the ledger that proves the suite was green is never read.

## Proposed mechanism — class (b), narrowed

Consult the token-bound ledger on the non-zero branch too, and downgrade to green **only**
under conditions that cannot mask a real break:

1. the ledger's `runToken` matches this run (already the existing proof-of-freshness), AND
2. `outcome.failed === 0`, AND
3. `outcome.filesTotal` matches the expected count for this invocation (guards the
   dangerous direction: a crash that drops a whole file's results can report `failed: 0`).

If any condition fails → keep the non-zero exit. Print `HARNESS ERROR (not a test failure)`
loudly when the downgrade fires, so it never becomes silent.

**The dangerous direction, stated plainly.** Swallowing a non-zero exit whenever
`failed === 0` would turn an OOM'd worker or an unhandled rejection green *in a release
gate*. The token proves the reporter ran; it does not prove the reporter saw every task.
Condition 3 is what makes this safe, and it is the part that must not be dropped for
convenience. If a robust expected-file-count is not available, the correct fallback is to
restrict the downgrade to a known error-signature allowlist (`Timeout calling "onTaskUpdate"`)
rather than to loosen the predicate.

## What it would have caught

- 2026-07-24, both occurrences: green suite reported red, twice in one lap.
- It would **not** have caught 2026-07-15 (already closed by the existing ledger check).

## False-positive surface

Everyday cost: none — no new script, no new command, nothing an agent wants to do is
blocked. The whole risk lives in condition 3 being weak; see above.

## Explicitly dropped from the reviewer's version

- The new `scripts/verdict.mjs` — duplicate, unsound design.
- Wiring into `pre-commit-gate.mjs` — already reached via `test:doc-contract`.
- Bundling `check:doc-manifest` into the `ci` workflow — a *coverage gap*, not an
  exit-status lie, and already tracked twice (`docs/backlog.md:792`, `:1705`).

## Red-green tests (to be written under `tests/`, not beside the script)

`tests/shared/vitest-gate-false-red.test.mjs`:

1. **RED before the change** — ledger with matching token, `outcome.failed === 0`,
   `filesTotal` matching, vitest child exit 1 ⇒ gate must exit 0. Fails today.
2. **GREEN guard** — same, but `outcome.failed === 3` ⇒ gate exits non-zero.
3. **GREEN guard** — same, but ledger token mismatched ⇒ gate exits non-zero (fail closed).
4. **GREEN guard** — same, but `filesTotal` short of expected ⇒ gate exits non-zero
   (the dropped-results crash must NOT read as green).
5. **Regression** — existing false-green case (exit 0, `failed > 0`) still exits 1.

`vitest.config.ts` excludes `.claude/**`, so a test placed beside a hook never runs — these
belong under `tests/shared/`.
