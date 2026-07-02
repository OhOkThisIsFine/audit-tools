import { test, expect } from "vitest";

const { parseReflectionsNdjson, aggregateReflections, renderProcessFeedbackSection } =
  await import("../../src/shared/agentReflections.ts");

test("parseReflectionsNdjson keeps only schema-valid lines and preserves optional arrays", () => {
  const ndjson = [
    JSON.stringify({
      task_id: "T1",
      instruction_clarity: "ambiguous",
      severity: "high",
      tool_friction: ["flaky lock"],
      ambiguities: ["scope unclear"],
    }),
    "", // blank → skipped
    "not json", // non-JSON → skipped
    JSON.stringify({ task_id: "T2", severity: "low" }), // missing instruction_clarity → skipped
    JSON.stringify({ task_id: "T3", instruction_clarity: "bogus", severity: "low" }), // bad enum → skipped
    JSON.stringify([1, 2, 3]), // array, not object → skipped
    JSON.stringify({ task_id: "T4", instruction_clarity: "clear", severity: "info", suggestions: ["doc it"] }),
  ].join("\n");

  const parsed = parseReflectionsNdjson(ndjson);
  expect(parsed.length).toBe(2);
  expect(parsed.map((r) => r.task_id)).toEqual(["T1", "T4"]);
  expect(parsed[0].tool_friction).toEqual(["flaky lock"]);
  expect(parsed[1].suggestions).toEqual(["doc it"]);
});

test("aggregateReflections tallies clarity/severity and dedupes notes ranked by max severity", () => {
  const agg = aggregateReflections([
    { task_id: "A", instruction_clarity: "ambiguous", severity: "low", tool_friction: ["dup note"] },
    { task_id: "B", instruction_clarity: "clear", severity: "high", tool_friction: ["dup note", "rare"] },
  ]);
  expect(agg.total).toBe(2);
  expect(agg.clarity_breakdown.ambiguous).toBe(1);
  expect(agg.clarity_breakdown.clear).toBe(1);
  expect(agg.severity_breakdown.high).toBe(1);
  expect(agg.severity_breakdown.low).toBe(1);
  // "dup note" appears twice (max severity high); "rare" once at high → tie broken alphabetically.
  expect(agg.friction).toEqual(["dup note", "rare"]);
});

test("renderProcessFeedbackSection omits the section when empty and renders it otherwise", () => {
  expect(renderProcessFeedbackSection([])).toEqual([]);

  const section = renderProcessFeedbackSection([
    {
      task_id: "A",
      instruction_clarity: "unclear",
      severity: "high",
      tool_friction: ["lock EPERM under load"],
      suggestions: ["retry transient unlink"],
    },
  ]).join("\n");

  expect(section).toMatch(/## Process Feedback/);
  expect(section).toMatch(/Instruction clarity: unclear: 1/);
  expect(section).toMatch(/Reported impact: high: 1/);
  expect(section).toMatch(/### Tool & instruction friction/);
  expect(section).toMatch(/- lock EPERM under load/);
  expect(section).toMatch(/### Suggestions/);
  expect(section).toMatch(/- retry transient unlink/);
});
