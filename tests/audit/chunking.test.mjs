import { test, expect } from "vitest";

const { chunkLineCount } = await import("../../src/audit/orchestrator/chunking.ts");

test("chunkLineCount returns empty array for totalLines=0", () => {
  expect(chunkLineCount(0)).toEqual([]);
});

test("chunkLineCount returns empty array for totalLines=-1", () => {
  expect(chunkLineCount(-1)).toEqual([]);
});

test("chunkLineCount handles single-line file", () => {
  expect(chunkLineCount(1)).toEqual([{ start: 1, end: 1 }]);
});

test("chunkLineCount exact multiple of default chunkSize (200)", () => {
  const result = chunkLineCount(200);
  expect(result).toEqual([{ start: 1, end: 200 }]);
  expect(result.length).toBe(1);
});

test("chunkLineCount non-multiple of default chunkSize", () => {
  const result = chunkLineCount(250);
  expect(result).toEqual([
    { start: 1, end: 200 },
    { start: 201, end: 250 },
  ]);
  expect(result[result.length - 1].end).toBe(250);
});

test("chunkLineCount respects custom chunkSize", () => {
  const result = chunkLineCount(25, 10);
  expect(result).toEqual([
    { start: 1, end: 10 },
    { start: 11, end: 20 },
    { start: 21, end: 25 },
  ]);
  // Verify all ranges are contiguous and non-overlapping.
  for (let i = 1; i < result.length; i++) {
    expect(result[i].start).toBe(result[i - 1].end + 1);
  }
});

test("chunkLineCount with chunkSize=1 produces one range per line", () => {
  expect(chunkLineCount(3, 1)).toEqual([
    { start: 1, end: 1 },
    { start: 2, end: 2 },
    { start: 3, end: 3 },
  ]);
});
