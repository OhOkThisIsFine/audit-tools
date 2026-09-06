import { test, expect } from "vitest";
import {
  parseReflectionsNdjson,
  aggregateReflections,
  renderProcessFeedbackSection,
} from "../../src/shared/agentReflections.js";

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

  const { reflections } = parseReflectionsNdjson(ndjson);
  expect(reflections.length).toBe(2);
  expect(reflections.map((r) => r.task_id)).toEqual(["T1", "T4"]);
  expect(reflections[0].tool_friction).toEqual(["flaky lock"]);
  expect(reflections[1].suggestions).toEqual(["doc it"]);
});

// The skip is unchanged; what is new is that the caller is TOLD. Before this,
// a line the parser rejected left no trace on any surface — which is how the
// shipped audit loader prompt came to ask hosts for a reflection shape the
// parser discarded whole, undetected (owner decision `6aebffe0c4e32e11`).
test("parseReflectionsNdjson reports every discarded line with a reason and a line number", () => {
  const ndjson = [
    JSON.stringify({ task_id: "T1", instruction_clarity: "clear", severity: "low" }), // line 1: kept
    "", // line 2: blank → not a discard, it is formatting
    "not json", // line 3
    JSON.stringify([1, 2, 3]), // line 4
    JSON.stringify({ instruction_clarity: "clear", severity: "low" }), // line 5
    // Line 6 is the exact shape the shipped prompt used to ask for.
    JSON.stringify({ task_id: "audit-capability-preflight", severity: "high" }),
    JSON.stringify({ task_id: "T7", instruction_clarity: "clear", severity: "nope" }), // line 7
  ].join("\n");

  const { reflections, discarded } = parseReflectionsNdjson(ndjson);

  expect(reflections.map((r) => r.task_id)).toEqual(["T1"]);
  expect(discarded.map((d) => [d.line, d.reason])).toEqual([
    [3, "not_json"],
    [4, "not_an_object"],
    [5, "missing_task_id"],
    [6, "missing_or_invalid_instruction_clarity"],
    [7, "missing_or_invalid_severity"],
  ]);
  // The excerpt identifies the offending line without dumping a payload.
  expect(discarded[3].excerpt).toContain("audit-capability-preflight");
});

test("parseReflectionsNdjson reports nothing for a clean file, so a healthy run stays silent", () => {
  const clean = JSON.stringify({
    task_id: "T1",
    instruction_clarity: "clear",
    severity: "info",
  });
  expect(parseReflectionsNdjson(clean).discarded).toEqual([]);
  expect(parseReflectionsNdjson("").discarded).toEqual([]);
  expect(parseReflectionsNdjson("\n\n\n").discarded).toEqual([]);
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
