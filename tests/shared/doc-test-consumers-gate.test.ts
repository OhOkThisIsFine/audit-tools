// Document content pins use the same declaration and production pre-commit
// projection as other subjects; configuration checks cannot replace execution.
import { describe, expect, it } from "vitest";
import { buildPreCommitLegs, reconcilePinObligations } from "../../scripts/shared/derived-file-preflight.mjs";

describe("document pin obligations", () => {
  it("a staged mapped document obliges its existing consumers", () => {
    const legs = buildPreCommitLegs({ guards: [], reach: [] });
    const triggered = legs.filter((leg) => leg.triggered({ root: ".", staged: ["docs/HANDOFF.md"] }));
    expect(triggered.map((leg) => leg.script)).toEqual([
      "tests/shared/handoff-roadmap.test.ts", "tests/shared/closeout-render.test.ts",
    ]);
    expect(legs.filter((leg) => leg.triggered({ root: ".", staged: ["nested/docs/HANDOFF.md"] }))).toEqual([]);
  });

  it("retains tracked subjects, tracked consumers, nonempty and build-free refusals", () => {
    const pins = new Map([
      ["docs/missing.md", ["tests/pin.test.ts"]],
      ["docs/empty.md", []],
      ["docs/stale.md", ["tests/missing.test.ts"]],
      ["docs/built.md", ["tests/pin.test.ts"]],
    ]);
    const errors = reconcilePinObligations(
      ["docs/empty.md", "docs/stale.md", "docs/built.md", "tests/pin.test.ts"],
      () => "import { X } from 'audit-tools/shared';", pins,
    );
    expect(errors).toHaveLength(4);
    expect(errors.join("\n")).toContain("NOT a tracked file");
    expect(errors.join("\n")).toContain("NO bound test");
    expect(errors.join("\n")).toContain("BUILT package");
  });
});
