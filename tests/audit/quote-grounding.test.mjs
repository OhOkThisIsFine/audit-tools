import { test, expect } from "vitest";
import {
  normalizeForMatch,
  quoteMatches,
  verifyFindingGrounding,
} from "../../src/audit/validation/quoteGrounding.js";

function finding(affected_files) {
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

test("quoteMatches is whitespace/CRLF-insensitive and content-based", () => {
  const file = "function foo() {\r\n    return bar();\r\n}\n";
  // Differently-indented, LF-only quote still matches.
  expect(quoteMatches(file, "return bar();")).toBe(true);
  // Multi-line span matches across the (normalized) content.
  expect(quoteMatches(file, "function foo() {\n  return bar();")).toBe(true);
  // Absent text does not match.
  expect(quoteMatches(file, "return baz();")).toBe(false);
  // An empty quote grounds nothing.
  expect(quoteMatches(file, "   ")).toBe(false);
});

test("verifyFindingGrounding: a matching quote grounds the finding", async () => {
  const reader = async () => "const secret = process.env.SECRET;\nreturn sign(secret);\n";
  const result = await verifyFindingGrounding(
    "/repo",
    finding([{ path: "src/auth.ts", line_start: 1, line_end: 2, quoted_text: "return sign(secret);" }]),
    reader,
  );
  expect(result.status).toBe("grounded");
});

test("verifyFindingGrounding: matching is content-based, robust to line-number drift", async () => {
  // The quote lives at the top of the file, but the finding cites lines 999-1000.
  const reader = async () => "export function login() { return ok; }\n";
  const result = await verifyFindingGrounding(
    "/repo",
    finding([{ path: "src/auth.ts", line_start: 999, line_end: 1000, quoted_text: "return ok;" }]),
    reader,
  );
  expect(result.status).toBe("grounded");
});

test("verifyFindingGrounding: a quote not present on disk is ungrounded", async () => {
  const reader = async () => "export function login() {}\n";
  const result = await verifyFindingGrounding(
    "/repo",
    finding([{ path: "src/auth.ts", line_start: 1, line_end: 1, quoted_text: "DROP TABLE users;" }]),
    reader,
  );
  expect(result.status).toBe("ungrounded");
  expect(result.reason ?? "").toMatch(/src\/auth\.ts/);
  expect(result.reason ?? "").toMatch(/not found on disk/);
});

test("verifyFindingGrounding: a finding with no quoted_text is ungrounded", async () => {
  const reader = async () => "anything";
  const result = await verifyFindingGrounding(
    "/repo",
    finding([{ path: "src/auth.ts", line_start: 1, line_end: 1 }]),
    reader,
  );
  expect(result.status).toBe("ungrounded");
  expect(result.reason ?? "").toMatch(/no .*quoted_text/i);
});

test("verifyFindingGrounding: one matching span among several grounds the finding", async () => {
  const reader = async (absPath) =>
    absPath.endsWith("b.ts") ? "the real code is here();" : "unrelated();";
  const result = await verifyFindingGrounding(
    "/repo",
    finding([
      { path: "src/a.ts", line_start: 1, line_end: 1, quoted_text: "missing();" },
      { path: "src/b.ts", line_start: 1, line_end: 1, quoted_text: "the real code is here();" },
    ]),
    reader,
  );
  expect(result.status).toBe("grounded");
});

test("verifyFindingGrounding: an unreadable file yields an ungrounded reason", async () => {
  const reader = async () => {
    throw new Error("ENOENT");
  };
  const result = await verifyFindingGrounding(
    "/repo",
    finding([{ path: "src/missing.ts", line_start: 1, line_end: 1, quoted_text: "x();" }]),
    reader,
  );
  expect(result.status).toBe("ungrounded");
  expect(result.reason ?? "").toMatch(/could not be read/);
});
