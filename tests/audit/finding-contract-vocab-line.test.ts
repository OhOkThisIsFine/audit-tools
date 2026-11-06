// N5 (A1 re-review F6-2) read "…lens one of …" unconditionally two lines above
// "lens is optional" — a worker obeying it literally would invent a lens on every
// finding. Decision 5 of the 2026-11-06 dogfood audit (cut C7) removed the lens
// vocabulary and the "lens is optional" line: the `finding_lens_matches_task`
// rule ("match the assigned task lens, or omit it") leaves one valid value. The
// closed-vocabularies line stays DERIVED for severity and confidence, and the
// memoization must keep returning byte-stable lines.
import { describe, expect, it } from "vitest";

import { findingContractPromptLines } from "../../src/audit/contracts/findingContractPrompt.js";
import { CONFIDENCES, LENSES, SEVERITIES } from "audit-tools/shared";

describe("contract:finding-contract-scopes-the-lens-vocabulary", () => {
  const lines = findingContractPromptLines();
  const vocabLine = lines.find((line) => line.startsWith("Closed vocabularies"));

  it("renders exactly one closed-vocabularies line", () => {
    expect(vocabLine).toBeDefined();
    expect(lines.filter((line) => line.startsWith("Closed vocabularies"))).toHaveLength(1);
  });

  it("offers no lens vocabulary and no separate lens-optional line", () => {
    expect(vocabLine).not.toMatch(/\blens\b/u);
    expect(lines.some((line) => line.startsWith("lens is optional"))).toBe(false);
    // No line lists the eleven lens values a reader could pick a wrong one from.
    for (const line of lines) {
      expect(LENSES.every((lens) => line.includes(lens)), line).toBe(false);
    }
  });

  it("keeps severity and confidence unconditional and every value derived", () => {
    expect(vocabLine).toContain(`severity must be one of ${SEVERITIES.join("|")}`);
    expect(vocabLine).toContain(`confidence one of ${CONFIDENCES.join("|")}`);
  });

  it("stays memoized byte-stable across calls", () => {
    expect(findingContractPromptLines()).toBe(lines);
  });
});
