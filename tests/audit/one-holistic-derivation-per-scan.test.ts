import { test, expect, vi } from "vitest";

// CX-02 design gate. The nested double drain leaves audit with TWO obligation
// registries whose `derive` functions disagree on cost and on semantics:
//
//   - the INNER drain (`deriveObligationState` in orchestrator/advance.ts) is
//     memoized on bundle IDENTITY, so one engine scan runs the holistic
//     `deriveAuditState` ONCE and every obligation reads that one result. It
//     also passes `emitStaleness: false`, so a regen cascade emits ONE
//     consolidated staleness record at the boundary.
//   - the OUTER fold (`deriveObligationState` in cli/nextStepHelpers.ts) is not
//     memoized at all and passes no options, so it takes the emit-on-stale
//     default.
//
// `findNextObligation` calls EVERY registered def's `derive` on every scan, so
// the outer fold pays a full holistic derivation per obligation per scan — the
// same ~23x regression commit 6145a1a3 measured and fixed on the inner side,
// still live on the outer one. This test states the invariant that survives the
// unification: ONE scan, ONE derivation.
//
// RED at HEAD by construction. It goes green when the two registries become one
// and that one registry derives through a single memoized read.

const { deriveSpy } = vi.hoisted(() => ({ deriveSpy: vi.fn() }));

vi.mock("../../src/audit/orchestrator/state.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/audit/orchestrator/state.js")>();
  return {
    ...actual,
    deriveAuditState: (...args: unknown[]) => {
      deriveSpy(...args);
      // A stub rather than a call-through: the property under test is the
      // NUMBER of holistic derivations one scan performs, not what any one of
      // them returns. Calling through would make the test depend on a full
      // artifact bundle it does not need.
      return { status: "in_progress", obligations: [] };
    },
  };
});

test("one fold scan performs ONE holistic audit-state derivation, not one per obligation", async () => {
  const { buildAuditObligations } = await import(
    "../../src/audit/cli/nextStepHelpers.js"
  );

  const obligations = buildAuditObligations();
  expect(
    obligations.length,
    "the fold registry should be non-empty, or this test proves nothing",
  ).toBeGreaterThan(1);

  // One engine scan: `findNextObligation` maps over every def and calls its
  // `derive` against the SAME state object.
  const bundle = {} as never;
  deriveSpy.mockClear();
  for (const def of obligations) def.derive(bundle);

  expect(
    deriveSpy.mock.calls.length,
    `one scan over ${obligations.length} obligations should derive the holistic audit state once; ` +
      `it derived it ${deriveSpy.mock.calls.length} times`,
  ).toBe(1);
});
