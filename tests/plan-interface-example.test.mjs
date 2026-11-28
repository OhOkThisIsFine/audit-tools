import assert from "node:assert/strict";
import test from "node:test";
import { renderLockedPlanHistory, renderPlanAuthorPrompt } from "../dist/remediate/steps/contractPipelinePrompts.js";
import { ExecutionUnitSchema } from "../dist/shared/types/executionPlan.js";

test("plan author example teaches only the validator's affected interface shape", () => {
  const lockedHistory = renderLockedPlanHistory(new Map([["UNIT-locked", { requirement_ids: ["REQ-locked"] }]]));
  const prompt = renderPlanAuthorPrompt({
    root: ".", source: { plan_id: "plan-fixture", findings: [] },
    sourcePath: "source.json", planPath: "plan.json", outputPath: "submission.json",
    history: { accepted_ids: [], counterexamples: [], repair_rounds: 0 }, lockedHistory,
  });
  const [, example] = prompt.match(/with this shape:\n(\{[\s\S]*?\n\})/u);
  const [unit] = JSON.parse(example).plan.units;
  const [entry] = unit.affected_interfaces;
  assert.equal(unit.affected_interfaces.length, 1);
  assert.deepEqual(Object.keys(entry).sort(), ["description", "name"]);
  assert.deepEqual(ExecutionUnitSchema.parse(unit).affected_interfaces, [entry]);
  assert.deepEqual(ExecutionUnitSchema.parse({ ...unit, affected_interfaces: [] }).affected_interfaces, []);
  assert.match(prompt, /Use affected_interfaces: \[\] when no boundary is changed or endangered\./u);
  assert.ok(prompt.includes(lockedHistory));
});
