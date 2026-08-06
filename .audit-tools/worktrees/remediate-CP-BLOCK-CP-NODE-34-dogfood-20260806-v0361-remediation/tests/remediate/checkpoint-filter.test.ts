import { describe, it, expect } from "vitest";
import { filterFindingsByCheckpoint } from "../../src/remediate/intent/checkpointFilter.js";

function finding(id: string, opts: any = {}): any {
  return {
    id,
    title: id,
    category: opts.category ?? "correctness",
    severity: opts.severity ?? "high",
    confidence: "high",
    lens: opts.lens ?? "correctness",
    summary: "s",
    affected_files: (opts.files ?? ["src/a.ts"]).map((path: string) => ({ path })),
    evidence: ["src/a.ts:1 - x"],
    ...(opts.theme_id ? { theme_id: opts.theme_id } : {}),
  };
}

function checkpoint(overrides: any = {}): any {
  return {
    schema_version: "intent-checkpoint/v1",
    confirmed_at: "2026-06-09T00:00:00Z",
    confirmed_by: "host",
    scope_summary: "s",
    intent_summary: "i",
    ...overrides,
  };
}

describe("filterFindingsByCheckpoint", () => {
  it("keeps everything when the checkpoint has no constraints", () => {
    const { kept, droppedIds } = filterFindingsByCheckpoint(
      [finding("A"), finding("B")],
      checkpoint(),
    );
    expect(kept).toHaveLength(2);
    expect(droppedIds).toEqual([]);
  });

  it("keeps everything when the checkpoint is undefined", () => {
    expect(
      filterFindingsByCheckpoint([finding("A")], undefined).kept,
    ).toHaveLength(1);
  });

  it("drops findings failing the severity filter", () => {
    const { kept, droppedIds } = filterFindingsByCheckpoint(
      [finding("A", { severity: "high" }), finding("B", { severity: "low" })],
      checkpoint({ filters: { severity: ["high", "critical"] } }),
    );
    expect(kept.map((f) => f.id)).toEqual(["A"]);
    expect(droppedIds).toEqual(["B"]);
  });

  it("drops findings failing the lens filter", () => {
    const { kept } = filterFindingsByCheckpoint(
      [finding("A", { lens: "security" }), finding("B", { lens: "tests" })],
      checkpoint({ filters: { lenses: ["security"] } }),
    );
    expect(kept.map((f) => f.id)).toEqual(["A"]);
  });

  it("drops findings outside the package filter (path prefix)", () => {
    const { kept } = filterFindingsByCheckpoint(
      [
        finding("A", { files: ["packages/core/x.ts"] }),
        finding("B", { files: ["packages/ui/y.ts"] }),
      ],
      checkpoint({ filters: { packages: ["packages/core"] } }),
    );
    expect(kept.map((f) => f.id)).toEqual(["A"]);
  });

  it("matches the theme filter via theme_id or category", () => {
    const { kept } = filterFindingsByCheckpoint(
      [
        finding("A", { theme_id: "T1" }),
        finding("B", { category: "io-boundary" }),
        finding("C", {}),
      ],
      checkpoint({ filters: { themes: ["T1", "io-boundary"] } }),
    );
    expect(kept.map((f) => f.id).sort()).toEqual(["A", "B"]);
  });

  it("drops findings whose files fall under excluded_scope (directory prefix)", () => {
    const { kept, droppedIds } = filterFindingsByCheckpoint(
      [
        finding("A", { files: ["src/a.ts"] }),
        finding("B", { files: ["scratch/tmp.ts"] }),
        finding("C", { files: ["src/scratchpad.ts"] }),
      ],
      checkpoint({ excluded_scope: [{ path: "scratch", reason: "scratch dir" }] }),
    );
    // `scratch` matches the scratch/ directory, NOT the sibling src/scratchpad.ts.
    expect(droppedIds).toEqual(["B"]);
    expect(kept.map((f) => f.id)).toEqual(["A", "C"]);
  });

  it("drops findings whose files match a must_not_touch glob", () => {
    const { kept } = filterFindingsByCheckpoint(
      [
        finding("A", { files: ["src/a.ts"] }),
        finding("B", { files: ["src/gen/api.ts"] }),
      ],
      checkpoint({ must_not_touch: ["**/gen/**"] }),
    );
    expect(kept.map((f) => f.id)).toEqual(["A"]);
  });

  // Symmetric with audit's intentScopeDisposition (both consume the shared
  // fileExclusionReason): a disposition_overrides entry with an excluded status
  // (excluded/generated/vendor) drops a finding under that path — remediate
  // previously ignored disposition_overrides entirely.
  it("drops findings under a disposition_overrides excluded status (symmetric with audit)", () => {
    const { kept, droppedIds } = filterFindingsByCheckpoint(
      [
        finding("A", { files: ["src/a.ts"] }),
        finding("B", { files: ["vendor/lib/x.ts"] }),
      ],
      checkpoint({
        disposition_overrides: [
          { path: "vendor", status: "vendor", reason: "third-party" },
        ],
      }),
    );
    expect(kept.map((f) => f.id)).toEqual(["A"]);
    expect(droppedIds).toEqual(["B"]);
  });

  it("keeps a finding under an 'included' disposition_overrides status", () => {
    const { kept } = filterFindingsByCheckpoint(
      [finding("A", { files: ["src/a.ts"] })],
      checkpoint({
        disposition_overrides: [{ path: "src", status: "included", reason: "kept" }],
      }),
    );
    expect(kept.map((f) => f.id)).toEqual(["A"]);
  });
});
