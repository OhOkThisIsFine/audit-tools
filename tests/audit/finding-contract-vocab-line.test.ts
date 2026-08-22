// N5 (A1 re-review F6-2): the closed-vocabularies line read
// "…lens one of …" unconditionally two lines above "lens is optional" — a
// worker obeying it literally would invent a lens on every finding. The line
// must scope the lens clause to supplied findings while staying DERIVED from
// LENSES (never a hand-written list), and the memoization must keep returning
// byte-stable lines.
import { describe, expect, it } from "vitest";

import { findingContractPromptLines } from "../../src/audit/contracts/findingContractPrompt.js";
import { LENSES } from "audit-tools/shared";

describe("contract:finding-contract-scopes-the-lens-vocabulary", () => {
  const lines = findingContractPromptLines();
  const vocabLine = lines.find((line) => line.startsWith("Closed vocabularies"));

  it("renders exactly one closed-vocabularies line", () => {
    expect(vocabLine).toBeDefined();
    expect(lines.filter((line) => line.startsWith("Closed vocabularies"))).toHaveLength(1);
  });

  it("scopes the lens vocabulary to findings that supply one", () => {
    expect(vocabLine).toContain("lens, when supplied, one of");
    // The old unconditional phrasing must not survive anywhere on the line.
    expect(vocabLine).not.toMatch(/;\s*lens one of/u);
    expect(vocabLine).not.toMatch(/^\s*lens one of/u);
  });

  it("keeps severity and confidence unconditional and every lens value derived", () => {
    expect(vocabLine).toMatch(/severity must be one of/u);
    expect(vocabLine).toMatch(/confidence one of/u);
    // Derived from the shared vocabulary, not hand-typed: every lens value the
    // tool accepts appears verbatim.
    for (const lens of LENSES) {
      expect(vocabLine).toContain(lens);
    }
  });

  it("stays memoized byte-stable across calls", () => {
    expect(findingContractPromptLines()).toBe(lines);
  });
});
