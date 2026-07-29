/**
 * finding-grounding.test.ts — the shared grounding primitives (drift-plan E3/P7)
 * with emphasis on INV-GND-02: grounding is a TOTAL function — a finding with no
 * grounding verdict (undefined/absent) is treated as ungrounded → verify.
 */
import { test, expect } from "vitest";
import {
  normalizeForMatch,
  normalizeRepoPath,
  quoteMatches,
  verifyFindingGrounding,
  findingIsGrounded,
  findingNeedsVerificationBeforeFix,
} from "audit-tools/shared";
import type {
  Finding,
  FindingLocation,
  SourceReader,
} from "audit-tools/shared";

function finding(affected_files: FindingLocation[]): Finding {
  return {
    id: "F-1",
    title: "t",
    category: "c",
    severity: "medium",
    confidence: "high",
    lens: "security",
    summary: "s",
    affected_files,
    evidence: ["e"],
  };
}

test("normalizeForMatch strips CR and collapses whitespace", () => {
  expect(normalizeForMatch("  a\r\n  b\t c  ")).toBe("a b c");
});

test("normalizeRepoPath: trims, backslash→slash, strips ./, lowercases", () => {
  expect(normalizeRepoPath(".\\SRC\\A.ts")).toBe("src/a.ts");
  expect(normalizeRepoPath("  src/B.TS  ")).toBe("src/b.ts");
  expect(normalizeRepoPath("./pkg/x.ts")).toBe("pkg/x.ts");
});

test("quoteMatches is whitespace/CRLF-insensitive and content-based", () => {
  const file = "function foo() {\r\n    return bar();\r\n}\n";
  expect(quoteMatches(file, "return bar();")).toBe(true);
  expect(quoteMatches(file, "return baz();")).toBe(false);
  expect(quoteMatches(file, "   ")).toBe(false);
});

test("verifyFindingGrounding grounds a matching quote and flags an absent one", async () => {
  const reader: SourceReader = async () => "const secret = process.env.SECRET;\nreturn sign(secret);\n";
  const ok = await verifyFindingGrounding(
    "/repo",
    finding([{ path: "src/auth.ts", quoted_text: "return sign(secret);" }]),
    reader,
  );
  expect(ok.status).toBe("grounded");

  const bad = await verifyFindingGrounding(
    "/repo",
    finding([{ path: "src/auth.ts", quoted_text: "DROP TABLE users;" }]),
    reader,
  );
  expect(bad.status).toBe("ungrounded");
  expect(bad.reason ?? "").toMatch(/not found on disk/);
});

test("INV-GND-02: an undefined/absent grounding verdict is treated as ungrounded → verify", () => {
  // No grounding field at all → NOT grounded → needs verification.
  const noVerdict: Pick<Finding, "grounding"> = { grounding: undefined };
  expect(findingIsGrounded(noVerdict)).toBe(false);
  expect(findingNeedsVerificationBeforeFix(noVerdict)).toBe(true);

  const missingField: Pick<Finding, "grounding"> = {};
  expect(findingIsGrounded(missingField)).toBe(false);
  expect(findingNeedsVerificationBeforeFix(missingField)).toBe(true);

  // Explicitly ungrounded → needs verification.
  const ungrounded: Pick<Finding, "grounding"> = { grounding: { status: "ungrounded", reason: "x" } };
  expect(findingIsGrounded(ungrounded)).toBe(false);
  expect(findingNeedsVerificationBeforeFix(ungrounded)).toBe(true);

  // Only a positive 'grounded' verdict skips verification.
  const grounded: Pick<Finding, "grounding"> = { grounding: { status: "grounded" } };
  expect(findingIsGrounded(grounded)).toBe(true);
  expect(findingNeedsVerificationBeforeFix(grounded)).toBe(false);
});
