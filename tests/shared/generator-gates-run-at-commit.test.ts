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
