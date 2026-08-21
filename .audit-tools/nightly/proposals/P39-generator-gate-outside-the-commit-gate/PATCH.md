# P39 — the patch

Two parts. Apply part 1 first, then part 2, so the red-green ordering is real.

## Part 1 — `scripts/guard-reach-data.mjs`

Add the import at the top of the module, beside the existing imports:

```js
import { RUNTIME_NAME_SOURCES } from "./shared/generate-runtime-artifact-names.mjs";
```

Change the gate row (currently at the `check:runtime-artifact-names` entry):

```js
  {
    id: 'check:runtime-artifact-names',
    kind: 'gate',
    impl: 'check:runtime-artifact-names',
    preCommit: 'reach',
    fix: 'runtime-artifact-names.generated.mjs is stale — run node scripts/shared/generate-runtime-artifact-names.mjs',
  },
```

Add a REACH row whose `files` are DERIVED from the generator's own declared input set, so the
reach cannot drift narrower than what the generator reads:

```js
  {
    area: 'runtime artifact-name layout sources',
    // DERIVED from the generator's declared input set — never hand-listed. A path
    // added to RUNTIME_NAME_SOURCES joins the commit gate's reach in the same edit.
    files: [
      ...RUNTIME_NAME_SOURCES.map((s) => s.file),
      'scripts/shared/generate-runtime-artifact-names.mjs',
      'scripts/shared/runtime-artifact-names.generated.mjs',
    ],
    guardedBy: ['check:runtime-artifact-names'],
  },
```

`npm run check:guard-reach` reconciles the registry against the tracked tree, so a path in
`RUNTIME_NAME_SOURCES` that no longer exists turns the build red rather than silently narrowing
the leg.

## Part 2 — `tests/shared/generator-gates-run-at-commit.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { GUARDS } from "../../scripts/guard-reach-data.mjs";

// A gate whose fix is "regenerate the tracked render" only protects the tree if
// it runs where the staleness is created: at commit. Registered preCommit:false
// it is a pre-tag check, and a stale render lands green (2026-08-20, the
// dispatch-plan.json render; regenerated after the fact in 85609eb7).
const REGENERATE_SHAPED = /regenerat|generate-|--write|is stale/i;

describe("a generator-parity gate runs in the commit gate", () => {
  it("no gate with a regenerate-shaped fix is registered preCommit:false", () => {
    const offenders = GUARDS.filter(
      (g) =>
        g.kind === "gate" &&
        typeof g.fix === "string" &&
        REGENERATE_SHAPED.test(g.fix) &&
        g.preCommit === false,
    ).map((g) => `${g.id}: ${g.fix}`);

    expect(
      offenders,
      "a gate that says 'regenerate this tracked file' must have preCommit 'reach' | 'always' | " +
        "'final' — with preCommit:false the stale render lands through a green commit gate and " +
        "is caught only at release",
    ).toEqual([]);
  });
});
```

## Red-green validation

1. At HEAD, before part 1: run the test. It must FAIL, naming exactly
   `check:runtime-artifact-names`. Paste the failing output.
2. Apply part 1. Run the test. It must PASS.
3. Run `npm run check:guard-reach` — the registry reconciliation must stay green.
4. Run `npm run build && npm run check && npm test` on the clean tree before pushing.

Do not land part 2 without seeing step 1 red. A gate test authored against an already-green tree
pins nothing.
