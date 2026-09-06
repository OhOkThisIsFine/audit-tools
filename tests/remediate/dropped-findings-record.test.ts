import { describe, test, expect } from "vitest";
import { renderDroppedFindingsRecord } from "../../src/remediate/droppedFindingsRecord.js";
import type { FindingFilterResult } from "../../src/remediate/findingFilter.js";
import type { Finding } from "audit-tools/shared";

// The defect this pins: the intake filter removes findings for four different
// reasons, and the machine record kept only their IDS. A reader asking what
// happened to a finding got an id and nothing else. The no-evidence class was
// the sharpest case — a high-severity, high-confidence finding could be
// discarded leaving no trace a person would ever encounter.
//
// The owner's decision (2026-09-06) shapes WHERE this lands: a document that is
// not surfaced in the operator's conversation but can be reviewed afterwards.
// The review gate still shows survivors only; that 2026-06-16 lock is untouched.

function finding(id: string, over: Partial<Finding> = {}): Finding {
  return {
    id,
    title: `Title for ${id}`,
    severity: "high",
    confidence: "high",
    lens: "architecture",
    ...over,
  } as Finding;
}

function filterResult(over: Partial<FindingFilterResult> = {}): FindingFilterResult {
  return {
    survivors: [],
    mergeMap: new Map(),
    droppedNoEvidence: [],
    droppedPhantomPaths: new Map(),
    phantomPathsRemoved: new Map(),
    droppedByCheckpoint: [],
    ...over,
  };
}

describe("renderDroppedFindingsRecord", () => {
  test("a no-evidence drop names the finding, not just its id", () => {
    const dropped = finding("MNT-c2dc7f9c", {
      title: "The wrapper pair duplicates ~2,400 lines",
      severity: "high",
      confidence: "high",
      lens: "maintainability",
    });
    const record = renderDroppedFindingsRecord(
      [dropped],
      filterResult({ droppedNoEvidence: ["MNT-c2dc7f9c"] }),
    );

    expect(record).toContain("MNT-c2dc7f9c");
    expect(record).toContain("The wrapper pair duplicates ~2,400 lines");
    expect(record).toContain("high");
    expect(record).toContain("maintainability");
    // The reason is stated, so a reader never has to infer it.
    expect(record).toMatch(/no `evidence` entries/);
  });

  test("each drop class is stated separately with its own reason", () => {
    const record = renderDroppedFindingsRecord(
      [finding("A"), finding("B"), finding("C"), finding("D"), finding("E")],
      filterResult({
        survivors: [finding("E")],
        droppedNoEvidence: ["A"],
        droppedPhantomPaths: new Map([["B", ["src/gone.ts"]]]),
        droppedByCheckpoint: ["C"],
        mergeMap: new Map([["D", "E"]]),
      }),
    );

    expect(record).toMatch(/## Dropped — no evidence \(1\)/);
    expect(record).toMatch(/## Dropped — every cited path was phantom \(1\)/);
    expect(record).toMatch(/## Dropped — excluded by the intent checkpoint \(1\)/);
    expect(record).toMatch(/## Folded into another finding \(1\)/);
    // The phantom class names the paths that were not there.
    expect(record).toContain("src/gone.ts");
    // A folded finding says where it went, so it does not read as lost.
    expect(record).toContain("folded into `E`");
  });

  test("the counts reconcile against what the filter saw", () => {
    const record = renderDroppedFindingsRecord(
      [finding("A"), finding("B"), finding("C")],
      filterResult({ survivors: [finding("C")], droppedNoEvidence: ["A", "B"] }),
    );
    expect(record).toContain("Findings seen by the filter: **3**");
    expect(record).toContain("Survived: **1**");
    expect(record).toContain("Removed or folded: **2**");
  });

  // A success-shaped empty needs an affirmation. Writing the file on a clean pass
  // is what makes its ABSENCE mean "the pass did not run" rather than "nothing
  // was dropped" — two very different facts that would otherwise look identical.
  test("a pass that dropped nothing says so, rather than writing nothing", () => {
    const record = renderDroppedFindingsRecord(
      [finding("A")],
      filterResult({ survivors: [finding("A")] }),
    );
    expect(record).toContain("Nothing was removed on this pass");
    expect(record).toContain("Removed or folded: **0**");
  });

  test("an omitted class is named, so an omission is not read as a missing class", () => {
    const record = renderDroppedFindingsRecord(
      [finding("A")],
      filterResult({ droppedNoEvidence: ["A"] }),
    );
    expect(record).toMatch(/No finding was removed for:/);
    expect(record).toContain("*Dropped — excluded by the intent checkpoint*");
  });

  test("an id with no recorded payload is stated as such, never silently skipped", () => {
    const record = renderDroppedFindingsRecord(
      [],
      filterResult({ droppedNoEvidence: ["GHOST-1"] }),
    );
    expect(record).toContain("GHOST-1");
    expect(record).toContain("payload not present in the recorded originals");
  });
});
