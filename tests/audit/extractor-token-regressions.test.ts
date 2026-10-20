import { describe, expect, it } from "vitest";
import { computeComplexityMetric } from "../../src/audit/extractors/analyzers/complexityDuplication.js";
import { isInterfacePath, normalizeExtractorPath } from "../../src/audit/extractors/pathPatterns.js";

describe("extractor token regressions", () => {
  describe("nullish-coalescing branch counting (complexityDuplication)", () => {
    it("counts `??` as one branch token, same as `||`", () => {
      const nullish = computeComplexityMetric("a.ts", "const x = a ?? b;");
      const logicalOr = computeComplexityMetric("a.ts", "const x = a || b;");
      expect(nullish?.value).toBe(2);
      expect(nullish?.value).toBe(logicalOr?.value);
    });

    it("does not count optional chaining `?.` as a branch token", () => {
      const optionalChain = computeComplexityMetric("a.ts", "const x = a?.b;");
      expect(optionalChain?.value).toBe(1);
    });

    it("still counts a ternary's bare `?` as a branch token", () => {
      const ternary = computeComplexityMetric("a.ts", "const x = a ? b : c;");
      expect(ternary?.value).toBe(2);
    });
  });

  describe("acronym-to-TitleCase boundary (pathPatterns)", () => {
    it("classifies an all-caps-acronym controller path as an interface path", () => {
      expect(isInterfacePath(normalizeExtractorPath("src/APIController.ts"))).toBe(true);
    });

    it("still classifies normal camelCase controller paths as interface paths", () => {
      expect(isInterfacePath(normalizeExtractorPath("src/ApiController.ts"))).toBe(true);
      expect(isInterfacePath(normalizeExtractorPath("src/myController.ts"))).toBe(true);
    });
  });
});
