import test from "node:test";
import assert from "node:assert/strict";

const { chunkLineCount } = await import("../src/orchestrator/chunking.ts");

test("chunkLineCount returns empty array for totalLines=0", () => {
  assert.deepEqual(chunkLineCount(0), []);
});

test("chunkLineCount returns empty array for totalLines=-1", () => {
  assert.deepEqual(chunkLineCount(-1), []);
});

test("chunkLineCount handles single-line file", () => {
  assert.deepEqual(chunkLineCount(1), [{ start: 1, end: 1 }]);
});

test("chunkLineCount exact multiple of default chunkSize (200)", () => {
  const result = chunkLineCount(200);
  assert.deepEqual(result, [{ start: 1, end: 200 }]);
  assert.equal(result.length, 1);
});

test("chunkLineCount non-multiple of default chunkSize", () => {
  const result = chunkLineCount(250);
  assert.deepEqual(result, [
    { start: 1, end: 200 },
    { start: 201, end: 250 },
  ]);
  assert.equal(result[result.length - 1].end, 250);
});

test("chunkLineCount respects custom chunkSize", () => {
  const result = chunkLineCount(25, 10);
  assert.deepEqual(result, [
    { start: 1, end: 10 },
    { start: 11, end: 20 },
    { start: 21, end: 25 },
  ]);
  // Verify all ranges are contiguous and non-overlapping.
  for (let i = 1; i < result.length; i++) {
    assert.equal(result[i].start, result[i - 1].end + 1);
  }
});

test("chunkLineCount with chunkSize=1 produces one range per line", () => {
  assert.deepEqual(chunkLineCount(3, 1), [
    { start: 1, end: 1 },
    { start: 2, end: 2 },
    { start: 3, end: 3 },
  ]);
});
