import test from "node:test";
import assert from "node:assert/strict";

const { severityRank, confidenceRank } = await import(
  "../src/reporting/findingRanks.ts"
);

test("severityRank returns correct ordinal for each severity level", () => {
  assert.equal(severityRank("critical"), 5);
  assert.equal(severityRank("high"), 4);
  assert.equal(severityRank("medium"), 3);
  assert.equal(severityRank("low"), 2);
  assert.equal(severityRank("info"), 1);
  assert.ok(severityRank("critical") > severityRank("high"));
  assert.ok(severityRank("high") > severityRank("medium"));
  assert.ok(severityRank("medium") > severityRank("low"));
  assert.ok(severityRank("low") > severityRank("info"));
});

test("confidenceRank returns correct ordinal for each confidence level", () => {
  assert.equal(confidenceRank("high"), 3);
  assert.equal(confidenceRank("medium"), 2);
  assert.equal(confidenceRank("low"), 1);
  assert.ok(confidenceRank("high") > confidenceRank("medium"));
  assert.ok(confidenceRank("medium") > confidenceRank("low"));
});
