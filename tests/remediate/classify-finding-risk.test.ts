import { describe, it, expect } from "vitest";
import type { Finding } from "audit-tools/shared";
import {
  classifyFindingRisk,
  type FindingClassification,
} from "../../src/remediate/steps/nextStep.js";

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "F-001",
    title: "A finding",
    category: "correctness",
    severity: "high",
    confidence: "high",
    lens: "security",
    summary: "Something to fix.",
    affected_files: [{ path: "src/a.ts" }],
    evidence: [],
    ...overrides,
  };
}

describe("classifyFindingRisk", () => {
  it("returns context_dependent when confidence is low", () => {
    const result: FindingClassification = classifyFindingRisk(
      makeFinding({ lens: "security", confidence: "low", severity: "high", summary: "Add null check" }),
    );
    expect(result.tier).toBe("context_dependent");
    expect(result.reason).toBeTruthy();
    expect(result.reason.toLowerCase()).toContain("confidence");
  });

  it("returns context_dependent when lens contains an api-breaking keyword (api-break)", () => {
    const result = classifyFindingRisk(
      makeFinding({ lens: "api-break", confidence: "high", severity: "low", summary: "Add null check" }),
    );
    expect(result.tier).toBe("context_dependent");
    expect(result.reason).toBeTruthy();
  });

  it("returns context_dependent when lens contains an api-breaking keyword (interface)", () => {
    const result = classifyFindingRisk(
      makeFinding({ lens: "interface", confidence: "high", severity: "low", summary: "Add null check" }),
    );
    expect(result.tier).toBe("context_dependent");
  });

  it("returns context_dependent when lens contains an api-breaking keyword (compat)", () => {
    const result = classifyFindingRisk(
      makeFinding({ lens: "compat", confidence: "high", severity: "low", summary: "Add null check" }),
    );
    expect(result.tier).toBe("context_dependent");
  });

  it("returns context_dependent when lens contains an api-breaking keyword (breaking)", () => {
    const result = classifyFindingRisk(
      makeFinding({ lens: "breaking", confidence: "high", severity: "low", summary: "Add null check" }),
    );
    expect(result.tier).toBe("context_dependent");
    expect(result.reason).toBeTruthy();
  });

  it("returns context_dependent when the finding prose contains destructive verb: removes", () => {
    const result = classifyFindingRisk(
      makeFinding({ lens: "security", confidence: "high", severity: "high", summary: "Removes the deprecated endpoint" }),
    );
    expect(result.tier).toBe("context_dependent");
    expect(result.reason).toBeTruthy();
  });

  it("returns context_dependent when the finding prose contains destructive verb: deletes", () => {
    const result = classifyFindingRisk(
      makeFinding({ lens: "security", confidence: "high", severity: "high", summary: "Deletes the legacy parser" }),
    );
    expect(result.tier).toBe("context_dependent");
  });

  it("returns context_dependent when the finding prose contains destructive verb: disables", () => {
    const result = classifyFindingRisk(
      makeFinding({ lens: "security", confidence: "high", severity: "high", summary: "Disables the old cache" }),
    );
    expect(result.tier).toBe("context_dependent");
  });

  it("returns context_dependent when the finding prose contains destructive verb: no longer", () => {
    const result = classifyFindingRisk(
      makeFinding({ lens: "security", confidence: "high", severity: "high", summary: "No longer retries on 429" }),
    );
    expect(result.tier).toBe("context_dependent");
    expect(result.reason).toBeTruthy();
  });

  it("returns safe when lens is a style keyword", () => {
    const result = classifyFindingRisk(
      makeFinding({ lens: "style", confidence: "high", severity: "high", summary: "Rename variable" }),
    );
    expect(result.tier).toBe("safe");
    expect(result.reason).toBeTruthy();
  });

  it("returns safe when lens is a format keyword", () => {
    const result = classifyFindingRisk(
      makeFinding({ lens: "format", confidence: "high", severity: "high", summary: "Reformat the file" }),
    );
    expect(result.tier).toBe("safe");
  });

  it("returns safe when lens is a lint keyword", () => {
    const result = classifyFindingRisk(
      makeFinding({ lens: "lint", confidence: "high", severity: "high", summary: "Fix lint rule" }),
    );
    expect(result.tier).toBe("safe");
  });

  it("returns safe when lens is a config keyword", () => {
    const result = classifyFindingRisk(
      makeFinding({ lens: "config", confidence: "high", severity: "high", summary: "Update tsconfig setting" }),
    );
    expect(result.tier).toBe("safe");
    expect(result.reason).toBeTruthy();
  });

  it("returns safe when severity is low and confidence is high (no breaking/safe-lens signal)", () => {
    const result = classifyFindingRisk(
      makeFinding({ lens: "security", confidence: "high", severity: "low", summary: "Add bounds check" }),
    );
    expect(result.tier).toBe("safe");
    expect(result.reason).toBeTruthy();
    expect(result.reason.toLowerCase()).toMatch(/severity|confidence/);
  });

  it("returns safe when severity is info and confidence is high", () => {
    const result = classifyFindingRisk(
      makeFinding({ lens: "observability", confidence: "high", severity: "info", summary: "Add log line" }),
    );
    expect(result.tier).toBe("safe");
    expect(result.reason).toBeTruthy();
  });

  it("returns substantive as the default fallback when no safe/breaking signal matches", () => {
    const result = classifyFindingRisk(
      makeFinding({ lens: "security", confidence: "high", severity: "high", summary: "Add input validation" }),
    );
    expect(result.tier).toBe("substantive");
    expect(result.reason).toBeTruthy();
  });

  it("confidence=low overrides a style/safe lens (context_dependent wins)", () => {
    const result = classifyFindingRisk(
      makeFinding({ lens: "style", confidence: "low", severity: "low", summary: "Rename variable" }),
    );
    expect(result.tier).toBe("context_dependent");
  });

  it("breaking lens overrides low severity + high confidence (context_dependent wins)", () => {
    const result = classifyFindingRisk(
      makeFinding({ lens: "api-break", confidence: "high", severity: "low", summary: "Add overload" }),
    );
    expect(result.tier).toBe("context_dependent");
  });
});
