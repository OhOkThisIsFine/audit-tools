import { test, expect } from "vitest";
import {
  normalizeForMatch,
  quoteMatches,
  groundFinding,
} from "../../src/shared/index.js";
import type { Finding } from "../../src/audit/types.js";
import type { SourceReader } from "../../src/shared/index.js";

function finding(affected_files: Finding["affected_files"]): Finding {
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

test("groundFinding: a matching quote grounds the finding", async () => {
  const reader = async () => "const secret = process.env.SECRET;\nreturn sign(secret);\n";
  const result = await groundFinding(
    "/repo",
    finding([{ path: "src/auth.ts", line_start: 1, line_end: 2, quoted_text: "return sign(secret);" }]),
    reader,
  );
  expect(result.status).toBe("grounded");
});

test("groundFinding: matching is content-based, and the quote's real span replaces a drifted one", async () => {
  // The quote lives at the top of the file, but the finding cites lines 999-1000.
  const reader = async () => "export function login() { return ok; }\n";
  const cited = finding([
    { path: "src/auth.ts", line_start: 999, line_end: 1000, quoted_text: "return ok;" },
  ]);
  const result = await groundFinding("/repo", cited, reader);
  expect(result.status).toBe("grounded");
  expect(cited.grounding).toEqual(result);
  expect(cited.affected_files?.[0]).toMatchObject({ line_start: 1, line_end: 1 });
});

test("groundFinding: a multi-line quote maps to the raw lines it spans, CRLF and re-indentation included", async () => {
  const reader = async () =>
    "import x;\r\n\r\nfunction foo() {\r\n    return bar();\r\n}\r\n";
  const cited = finding([
    { path: "src/a.ts", quoted_text: "function foo() {\n  return bar();\n}" },
  ]);
  await groundFinding("/repo", cited, reader);
  expect(cited.affected_files?.[0]).toMatchObject({ line_start: 3, line_end: 5 });
});

test("groundFinding: a quote that occurs more than once names no location and does not ground", async () => {
  // `aa` occurs twice in `aaa` — overlapping occurrences are still two places.
  const reader = async () => "aaa\nreturn null;\nx();\nreturn null;\n";
  for (const quoted_text of ["return null;", "aa"]) {
    const cited = finding([
      { path: "src/a.ts", line_start: 2, line_end: 2, quoted_text },
    ]);
    const result = await groundFinding("/repo", cited, reader);
    expect(result.status).toBe("ungrounded");
    expect(result.reason ?? "").toMatch(/src\/a\.ts: quoted_text occurs 2 times/);
    expect(cited.affected_files?.[0]?.line_start).toBeUndefined();
    expect(cited.affected_files?.[0]?.line_end).toBeUndefined();
  }
});

test("groundFinding: entries without a locatable quote lose their supplied lines; the located one keeps its own", async () => {
  const reader: SourceReader = async (absPath) =>
    absPath.endsWith("b.ts") ? "first();\nsecond();\n" : "unrelated();";
  const cited = finding([
    { path: "src/a.ts", line_start: 7, line_end: 9, quoted_text: "missing();" },
    { path: "src/b.ts", line_start: 1, line_end: 1, quoted_text: "second();" },
    { path: "src/c.ts", line_start: 3, line_end: 4, no_quotable_span: "the guard is absent" },
  ]);
  await groundFinding("/repo", cited, reader);
  const [a, b, c] = cited.affected_files ?? [];
  expect(a?.line_start).toBeUndefined();
  expect(b).toMatchObject({ line_start: 2, line_end: 2 });
  expect(c?.line_start).toBeUndefined();
  expect(c?.line_end).toBeUndefined();
});

test("groundFinding: a quote not present on disk is ungrounded", async () => {
  const reader = async () => "export function login() {}\n";
  const result = await groundFinding(
    "/repo",
    finding([{ path: "src/auth.ts", line_start: 1, line_end: 1, quoted_text: "DROP TABLE users;" }]),
    reader,
  );
  expect(result.status).toBe("ungrounded");
  expect(result.reason ?? "").toMatch(/src\/auth\.ts/);
  expect(result.reason ?? "").toMatch(/not found on disk/);
});

test("groundFinding: a finding with no quoted_text is ungrounded", async () => {
  const reader = async () => "anything";
  const result = await groundFinding(
    "/repo",
    finding([{ path: "src/auth.ts", line_start: 1, line_end: 1 }]),
    reader,
  );
  expect(result.status).toBe("ungrounded");
  expect(result.reason ?? "").toMatch(/no .*quoted_text/i);
});

test("groundFinding: one matching span among several grounds the finding", async () => {
  const reader: SourceReader = async (absPath) =>
    absPath.endsWith("b.ts") ? "the real code is here();" : "unrelated();";
  const result = await groundFinding(
    "/repo",
    finding([
      { path: "src/a.ts", line_start: 1, line_end: 1, quoted_text: "missing();" },
      { path: "src/b.ts", line_start: 1, line_end: 1, quoted_text: "the real code is here();" },
    ]),
    reader,
  );
  expect(result.status).toBe("grounded");
});

test("groundFinding: an unreadable file yields an ungrounded reason", async () => {
  const reader = async () => {
    throw new Error("ENOENT");
  };
  const result = await groundFinding(
    "/repo",
    finding([{ path: "src/missing.ts", line_start: 1, line_end: 1, quoted_text: "x();" }]),
    reader,
  );
  expect(result.status).toBe("ungrounded");
  expect(result.reason ?? "").toMatch(/could not be read/);
});
