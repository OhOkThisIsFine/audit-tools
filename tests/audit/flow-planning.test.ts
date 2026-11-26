import { expect, test } from "vitest";
import { selectFlowLenses } from "../../src/audit/orchestrator/flowPlanning.js";
import { ALL_LENSES } from "../../src/audit/types.js";

test("flow coverage admits every canonical lens and preserves declared order", () => {
  const declared = [...ALL_LENSES].reverse();
  expect(selectFlowLenses(["unknown", ...declared, null])).toEqual(declared);
});
