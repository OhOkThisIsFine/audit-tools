// N4 (A1 re-review F6-1): FINDING_LINE_ORDER_RULE stated the order rule
// unconditionally, but `findingLocationLineIssues` enforces it only when BOTH
// ends are cited — a location citing line_start alone never violates it, so the
// constant overstated the rule the prompt renders verbatim. Reworded to state
// the condition; this pins the conditional wording BY IMPORTING the constant
// (never retyping it), so the prompt and both validators follow automatically.
import { describe, expect, it } from "vitest";

import {
  FINDING_LINE_END_INTEGER_RULE,
  FINDING_LINE_ORDER_RULE,
  FINDING_LINE_START_INTEGER_RULE,
  findingLocationLineIssues,
} from "../../src/shared/types/finding.js";

describe("contract:finding-line-order-rule-states-its-condition", () => {
  it("states the both-ends-cited condition in the exported constant", () => {
    expect(FINDING_LINE_ORDER_RULE).toMatch(/when both ends are cited/u);
  });

  it("keeps the enforcement matched to the wording: one cited end never violates the order rule", () => {
    // Either end alone is legal — the order rule cannot apply — so the
    // statement must not claim an unconditional ordering.
    expect(findingLocationLineIssues({ line_start: 9 })).toEqual([]);
    expect(findingLocationLineIssues({ line_end: 1 })).toEqual([]);
    // Both ends, inverted: the rule fires WITH its (conditional) statement.
    expect(
      findingLocationLineIssues({ line_start: 3, line_end: 1 }).map(
        (issue) => issue.message,
      ),
    ).toContain(FINDING_LINE_ORDER_RULE);
  });

  it("leaves the integer rules unconditional", () => {
    expect(FINDING_LINE_START_INTEGER_RULE).toMatch(/must be an integer/u);
    expect(FINDING_LINE_END_INTEGER_RULE).toMatch(/must be an integer/u);
  });
});
