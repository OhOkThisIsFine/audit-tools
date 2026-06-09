import test from "node:test";
import assert from "node:assert/strict";

const { parseReflectionsNdjson, aggregateReflections, renderProcessFeedbackSection } =
  await import("../src/reporting/agentReflections.ts");
const { renderAuditReportMarkdown } = await import("../src/reporting/synthesis.ts");

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
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed.map((r) => r.task_id), ["T1", "T4"]);
  assert.deepEqual(parsed[0].tool_friction, ["flaky lock"]);
  assert.deepEqual(parsed[1].suggestions, ["doc it"]);
});

test("aggregateReflections tallies clarity/severity and dedupes notes ranked by max severity", () => {
  const agg = aggregateReflections([
    { task_id: "A", instruction_clarity: "ambiguous", severity: "low", tool_friction: ["dup note"] },
    { task_id: "B", instruction_clarity: "clear", severity: "high", tool_friction: ["dup note", "rare"] },
  ]);
  assert.equal(agg.total, 2);
  assert.equal(agg.clarity_breakdown.ambiguous, 1);
  assert.equal(agg.clarity_breakdown.clear, 1);
  assert.equal(agg.severity_breakdown.high, 1);
  assert.equal(agg.severity_breakdown.low, 1);
  // "dup note" appears twice (max severity high); "rare" once at high → tie broken alphabetically.
  assert.deepEqual(agg.friction, ["dup note", "rare"]);
});

test("renderProcessFeedbackSection omits the section when empty and renders it otherwise", () => {
  assert.deepEqual(renderProcessFeedbackSection([]), []);

  const section = renderProcessFeedbackSection([
    {
      task_id: "A",
      instruction_clarity: "unclear",
      severity: "high",
      tool_friction: ["lock EPERM under load"],
      suggestions: ["retry transient unlink"],
    },
  ]).join("\n");

  assert.match(section, /## Process Feedback/);
  assert.match(section, /Instruction clarity: unclear: 1/);
  assert.match(section, /Reported impact: high: 1/);
  assert.match(section, /### Tool & instruction friction/);
  assert.match(section, /- lock EPERM under load/);
  assert.match(section, /### Suggestions/);
  assert.match(section, /- retry transient unlink/);
});

test("renderAuditReportMarkdown includes a Process Feedback section only when reflections are supplied", () => {
  const base = {
    summary: {
      finding_count: 0,
      work_block_count: 0,
      severity_breakdown: {},
      audited_file_count: 0,
      excluded_file_count: 0,
    },
    findings: [],
    work_blocks: [],
  };

  const withReflections = renderAuditReportMarkdown(base, {
    reflections: [
      { task_id: "A", instruction_clarity: "clear", severity: "info", tool_friction: ["minor"] },
    ],
  });
  assert.match(withReflections, /## Process Feedback/);

  const without = renderAuditReportMarkdown(base, {});
  assert.doesNotMatch(without, /## Process Feedback/);
});
