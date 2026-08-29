import { test, expect, vi } from "vitest";

// CX-02 scan-cost invariant: ONE fold scan performs ONE holistic audit-state
// derivation. `findNextObligation` calls EVERY registered def's `derive` on
// every scan, so an unmemoized registry pays a full `deriveAuditState` per
// obligation per scan — the ~23x regression commit 6145a1a3 measured and
// memoized away. Under the ONE registry both draws share the per-call
// bundle-identity memo, and this test pins that property so a future registry
// change cannot silently reintroduce the per-obligation derivation.
//
// History (recorded so the test's role stays honest): this test predates the
// registry unification and was born RED against the then-outer fold; an
// interim per-bundle cache turned it green while two registries still stood,
// which is why the CX-02 record classifies it as pinning a SEPARABLE
// performance defect — never the acceptance test for the structural collapse.

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
