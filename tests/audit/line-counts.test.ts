import { describe, it, expect } from "vitest";

const { lineCountForPath, lineCountFromSources, resultLineIndexFor } =
  await import("../../src/audit/orchestrator/lineCounts.js");

const result = (
  coverage: Array<{ path: string; total_lines: number }>,
): { file_coverage: Array<{ path: string; total_lines: number }> } => ({
  file_coverage: coverage,
});

describe("lineCountForPath", () => {
  it("takes the task's assigned count when a task is supplied", () => {
    expect(
      lineCountForPath("a.ts", {
        task: { file_line_counts: { "a.ts": 10 } },
        result: result([{ path: "a.ts", total_lines: 20 }]),
      }),
    ).toBe(10);
  });

  // The property that lets one helper serve two opposite precedences. A caller
  // building a follow-up FROM a result omits the task, so the measured coverage
  // wins over a count that may already be stale. If precedence were baked in,
  // one of the two call sites would be silently wrong.
  it("takes the result's measured coverage when NO task is supplied", () => {
    expect(
      lineCountForPath("a.ts", {
        result: result([{ path: "a.ts", total_lines: 20 }]),
        lineIndex: { "a.ts": 30 },
      }),
    ).toBe(20);
  });

  it("falls through to the index, then to 0", () => {
    expect(lineCountForPath("a.ts", { lineIndex: { "a.ts": 30 } })).toBe(30);
    expect(lineCountForPath("a.ts", {})).toBe(0);
    expect(lineCountForPath("a.ts")).toBe(0);
  });

  it("lets a stated 0 win over a later source", () => {
    // A file with zero lines is an answer, not a missing value — `??` and not `||`.
    expect(
      lineCountForPath("a.ts", {
        task: { file_line_counts: { "a.ts": 0 } },
        lineIndex: { "a.ts": 30 },
      }),
    ).toBe(0);
  });
});

describe("resultLineIndexFor", () => {
  it("builds the index once per result object", () => {
    const r = result([{ path: "a.ts", total_lines: 5 }]);
    expect(resultLineIndexFor(r)).toBe(resultLineIndexFor(r));
  });

  it("keeps the FIRST entry for a duplicated path", () => {
    // The two deleted twins disagreed here — `find` took the first, and
    // `Object.fromEntries` kept the last. One answer is stated now.
    const r = result([
      { path: "a.ts", total_lines: 5 },
      { path: "a.ts", total_lines: 99 },
    ]);
    expect(resultLineIndexFor(r)["a.ts"]).toBe(5);
    expect(lineCountFromSources("a.ts", [], [r])).toBe(5);
  });
});

describe("lineCountFromSources", () => {
  it("takes the first task that states a count, then the first result", () => {
    expect(
      lineCountFromSources(
        "a.ts",
        [{ file_line_counts: {} }, { file_line_counts: { "a.ts": 7 } }],
        [result([{ path: "a.ts", total_lines: 20 }])],
      ),
    ).toBe(7);
    expect(
      lineCountFromSources(
        "a.ts",
        [{ file_line_counts: {} }],
        [result([]), result([{ path: "a.ts", total_lines: 20 }])],
      ),
    ).toBe(20);
  });
});
