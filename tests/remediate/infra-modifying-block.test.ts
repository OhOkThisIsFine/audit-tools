import { describe, it, expect } from "vitest";
import { isInfraModifyingBlock } from "../../src/remediate/steps/dispatch.js";

// ---------------------------------------------------------------------------
// isInfraModifyingBlock — predicate unit tests
// ---------------------------------------------------------------------------

// Post-A12 the package is single-tree: infra modules live at
// `src/remediate/...`, NOT the former `packages/remediate-code/src/...`. These
// cases pin the predicate to the REAL on-disk layout — they would all fail
// against the stale pre-A12 path list (which matched nothing after the collapse,
// so every infra block rendered as non-infra).
describe("isInfraModifyingBlock returns true for engine files (current src/remediate layout)", () => {
  it("predicate returns true when write_paths includes nextStep.ts", () => {
    expect(isInfraModifyingBlock(["src/remediate/steps/nextStep.ts"])).toBe(true);
  });

  it("predicate returns true when write_paths includes dispatch.ts", () => {
    expect(isInfraModifyingBlock(["src/remediate/steps/dispatch.ts"])).toBe(true);
  });

  it("predicate returns true when write_paths includes store.ts", () => {
    expect(isInfraModifyingBlock(["src/remediate/state/store.ts"])).toBe(true);
  });

  it("predicate returns true when write_paths includes contractPipeline.ts", () => {
    expect(isInfraModifyingBlock(["src/remediate/steps/contractPipeline.ts"])).toBe(true);
  });

  it("predicate returns true when write_paths includes stepWriter.ts", () => {
    expect(isInfraModifyingBlock(["src/remediate/steps/stepWriter.ts"])).toBe(true);
  });

  it("predicate returns true for absolute path ending in the infra segment", () => {
    expect(
      isInfraModifyingBlock(["/some/absolute/repo/src/remediate/steps/dispatch.ts"]),
    ).toBe(true);
  });

  it("predicate returns true for Windows-style absolute path (backslashes normalized)", () => {
    expect(
      isInfraModifyingBlock([
        "C:\\Code\\audit-tools\\src\\remediate\\steps\\dispatch.ts",
      ]),
    ).toBe(true);
  });

  it("predicate returns true for a worktree absolute path (the dogfood spelling)", () => {
    expect(
      isInfraModifyingBlock([
        "C:\\Code\\audit-tools\\.audit-tools\\worktrees\\remediate-X\\src\\remediate\\state\\store.ts",
      ]),
    ).toBe(true);
  });

  it("predicate returns true when infra path is mixed with non-infra paths", () => {
    expect(
      isInfraModifyingBlock([
        "src/remediate/phases/plan.ts",
        "src/remediate/steps/dispatch.ts",
      ]),
    ).toBe(true);
  });
});

describe("isInfraModifyingBlock returns false for non-infra files", () => {
  it("predicate returns false when write_paths contains only plan.ts", () => {
    expect(isInfraModifyingBlock(["src/remediate/phases/plan.ts"])).toBe(false);
  });

  it("predicate returns false when write_paths contains only a test file path", () => {
    expect(
      isInfraModifyingBlock(["tests/remediate/next-step.test.ts"]),
    ).toBe(false);
  });

  it("predicate returns false for an empty write_paths array", () => {
    expect(isInfraModifyingBlock([])).toBe(false);
  });

  it("predicate returns false for the now-removed waveScheduler.ts (inlined into dispatch)", () => {
    // waveScheduler.ts no longer exists post-inlining; it must NOT be flagged.
    expect(
      isInfraModifyingBlock(["src/remediate/steps/waveScheduler.ts"]),
    ).toBe(false);
  });

  it("predicate returns false for unrelated source files", () => {
    expect(
      isInfraModifyingBlock([
        "src/remediate/intake.ts",
        "src/remediate/reporting/report.ts",
      ]),
    ).toBe(false);
  });

  it("predicate returns false for a same-basename file in another area (src/audit)", () => {
    // 'dispatch.ts' under src/audit must not match src/remediate's infra entry.
    expect(
      isInfraModifyingBlock(["src/audit/steps/dispatch.ts"]),
    ).toBe(false);
  });

  it("predicate returns false for the stale pre-A12 monorepo path", () => {
    // The old packages/remediate-code/... spelling no longer corresponds to any
    // real file and must not be treated as infra.
    expect(
      isInfraModifyingBlock(["packages/remediate-code/src/steps/dispatch.ts"]),
    ).toBe(false);
  });
});
