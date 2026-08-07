import { test, expect, describe } from "vitest";
import {
  normalizeAnalyzerSnippet,
  hashAnalyzerSnippet,
  analyzerProvenanceKey,
  AnalyzerLeadProvenanceSchema,
} from "../../src/shared/analyzers/provenance.js";
import { normalizeGenericExternalResults } from "../../src/shared/analyzers/normalizeExternal.js";
import { ExternalAnalyzerResultItemSchema } from "../../src/shared/analyzers/types.js";

const SOURCE = [
  "function add(a, b) {",
  "  return a + b;",
  "}",
  "",
  "function sub(a, b) {",
  "  return a - b;",
  "}",
].join("\n");

describe("hashAnalyzerSnippet — content anchoring", () => {
  test("identical span hashes identically; layout-only changes do not move it", () => {
    const base = hashAnalyzerSnippet(SOURCE, 1, 3);
    expect(base).toBeDefined();
    // Whitespace-only reformat: indentation widened, blank line injected, CRLF.
    const reformatted = [
      "function add(a, b) {",
      "",
      "    return  a + b;",
      "}",
    ].join("\r\n");
    expect(hashAnalyzerSnippet(reformatted, 1, 4)).toBe(base);
  });

  test("a real edit to the flagged code changes the hash", () => {
    const base = hashAnalyzerSnippet(SOURCE, 1, 3);
    const edited = SOURCE.replace("a + b", "a + b + 1");
    expect(hashAnalyzerSnippet(edited, 1, 3)).not.toBe(base);
  });

  test("degrades to undefined off the end of the file, on bad line numbers, and on empty spans", () => {
    expect(hashAnalyzerSnippet(SOURCE, 99)).toBeUndefined();
    expect(hashAnalyzerSnippet(SOURCE, 0)).toBeUndefined();
    expect(hashAnalyzerSnippet(SOURCE, -3, 2)).toBeUndefined();
    expect(hashAnalyzerSnippet("\n \n\t\n", 1, 3)).toBeUndefined();
  });

  test("line_end below line_start falls back to the single start line", () => {
    expect(hashAnalyzerSnippet(SOURCE, 2, 1)).toBe(hashAnalyzerSnippet(SOURCE, 2));
  });
});

describe("normalizeAnalyzerSnippet", () => {
  test("trims, collapses runs, drops empty lines", () => {
    expect(normalizeAnalyzerSnippet("  a   b\r\n\r\n\tc  ")).toBe("a b\nc");
  });
});

describe("normalizeGenericExternalResults — provenance attach", () => {
  const items = [
    { path: "src/a.ts", line_start: 1, line_end: 3, summary: "clone", rule: "jscpd-clone" },
    { path: "src/a.ts", summary: "no line info, no provenance" },
    { path: "missing.ts", line_start: 1, summary: "unreadable file" },
  ];
  const readSource = (path: string) => (path === "src/a.ts" ? SOURCE : undefined);

  test("attaches content-anchored provenance when a reader is supplied", () => {
    const normalized = normalizeGenericExternalResults("jscpd", items, { readSource });
    const [withProv, noLine, unreadable] = normalized.results;
    expect(withProv.provenance).toEqual({
      analyzer_id: "jscpd",
      rule: "jscpd-clone",
      path: "src/a.ts",
      snippet_hash: hashAnalyzerSnippet(SOURCE, 1, 3),
    });
    expect(noLine.provenance).toBeUndefined();
    expect(unreadable.provenance).toBeUndefined();
  });

  test("attaches nothing without a reader (optional everywhere)", () => {
    const normalized = normalizeGenericExternalResults("jscpd", items);
    expect(normalized.results.every((r) => r.provenance === undefined)).toBe(true);
  });

  test("the result-item contract accepts provenance and stays strict", () => {
    const normalized = normalizeGenericExternalResults("jscpd", items, { readSource });
    for (const result of normalized.results) {
      expect(() => ExternalAnalyzerResultItemSchema.parse(result)).not.toThrow();
    }
    expect(() =>
      AnalyzerLeadProvenanceSchema.parse({
        analyzer_id: "jscpd",
        path: "src/a.ts",
        snippet_hash: "abc",
        extra: "nope",
      }),
    ).toThrow();
  });
});

describe("analyzerProvenanceKey", () => {
  test("keys identically with and without rule folded as empty", () => {
    const a = analyzerProvenanceKey({ analyzer_id: "x", path: "p", snippet_hash: "h" });
    const b = analyzerProvenanceKey({ analyzer_id: "x", rule: "", path: "p", snippet_hash: "h" });
    expect(a).toBe(b);
    const c = analyzerProvenanceKey({ analyzer_id: "x", rule: "r", path: "p", snippet_hash: "h" });
    expect(c).not.toBe(a);
  });
});
