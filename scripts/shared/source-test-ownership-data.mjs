// Source → test OWNERSHIP, held as ONE data mapping shared by the change checks
// (`check:sites-pinned`) and the pin obligations (`reconcilePinObligations`).
//
// WHY THIS EXISTS. Two mechanisms phrase the same question — "which test asserts
// this source's content?" — from different trigger points: the sites-pinned gate
// asks it of a STAGED hunk (and takes the answer from an author-supplied
// `// sites-pinned:` declaration), and the PINS graph asks it of a pinned subject
// (and takes the answer from this data). When the two disagree, or when one is a
// hand-written copy of the other, the answer drifts: a duplicated derived literal
// went red in CI shard-by-shard because each copy was updated independently
// (O11). ONE map, consulted by both, means the "which test owns this source" fact
// has a single home that a divergence cannot split.
//
// SHAPE. One row per SOURCE path whose behaviour is asserted by tests. `tests`
// are the owning test files; `what` states what they pin, so a reader can judge
// whether their edit touches the asserted content (the same shape the DOC pin
// rows carry inline in `derived-file-preflight.mjs`). This is a CURATED map for
// the PRODUCT source tree — the DOC side lives folded into the `PINS` graph
// (packet 23); this module owns `src/`, `scripts/`, `wrapper/` and `dispatch/`
// subjects only.
//
// WHAT IS NOT PROVEN, stated because a partly-enforced trap is not deletable:
// a row says a test OWNS the source; it does not prove the test still EXECUTES it
// or asserts its behaviour. That half is `scripts/shared/source-test-reach.mjs`,
// which both consumers import to VERIFY the row mechanically — execution reach
// (the test run under `@vitest/coverage-v8` and the subject's runtime coverage
// inspected) and behavioural evidence as separate results, never an author's
// claim about their own import statements.

// sites-pinned: tests/shared/source-test-ownership.test.ts
//   Every row is reconciled (tracked source + tracked tests) by the pin-obligation
//   check; the execution-reach + behavioural classifiers that both consumers
//   share are pinned here.

/** @typedef {{source: string, tests: string[], what: string}} OwnershipRow */

/** @type {OwnershipRow[]} */
export const SOURCE_TEST_OWNERSHIP = [
  {
    source: "src/shared/loopCorePaths.ts",
    tests: ["tests/shared/loop-core-gate-parity.test.ts"],
    what: "the loop-core pattern set and the generated hook sibling must stay equal",
  },
  {
    source: "scripts/guard-reach-data.mjs",
    tests: [
      "tests/shared/precommit-leg-derivation.test.ts",
      "tests/shared/guard-form-reach.test.ts",
      "tests/shared/guard-reach-gate.test.ts",
    ],
    what: "every guard row and its reach/forms are reconciled against the tree — each bound test asserts GUARDS/REACH directly",
  },
  {
    source: "scripts/shared/derived-file-preflight.mjs",
    tests: [
      "tests/shared/precommit-leg-derivation.test.ts",
      "tests/shared/attest-derived-file-preflight.test.ts",
    ],
    what: "the derived pre-commit leg set and pin-obligation reconciliation single-sourced between the gate and both attest scripts",
  },
  {
    source: "src/shared/constitutionalDocPaths.ts",
    tests: ["tests/shared/doc-manifest-gate.test.ts"],
    what: "the constitutional-doc path set is projected into the doc-manifest routing",
  },
];
