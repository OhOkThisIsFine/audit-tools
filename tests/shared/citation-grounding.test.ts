// The shared citation core — ONE synchronous core, two draws.
//
// Pins the properties the remediate draw (`evidenceCitesRealPath`) and the audit
// draw (charter provenance checking) both rest on: the range grammar, the TRUE
// line count, the delivered-evidence check, the POSITIONAL prefix strip, and
// determinism of the result array.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkCitations,
  countSourceLines,
  extractCitationRefs,
  parseCitationRef,
  stripEmittedLinePrefix,
  type DeliveredExcerpt,
} from "../../src/shared/validation/citationGrounding.js";

const THREE_LINE = "alpha\nbeta\ngamma\n";
const TABLE_ROW = "| 12 | budget | 6000 |";

let root: string;
const corpus = new Set(["src/a.ts", "src/crlf.ts", "docs/table.md"]);

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "citation-grounding-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), THREE_LINE, "utf8");
  writeFileSync(join(root, "src", "crlf.ts"), "a\r\nb\r\nc\r\n", "utf8");
  writeFileSync(join(root, "docs", "table.md"), `# T\n\n${TABLE_ROW}\n`, "utf8");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function check(
  ref: string,
  extra: { quote?: string; delivered?: readonly DeliveredExcerpt[] } = {},
) {
  const result = checkCitations({
    root,
    corpus,
    citations: [{ owner_id: "c1", ref, ...(extra.quote ? { quote: extra.quote } : {}) }],
    ...(extra.delivered ? { delivered: extra.delivered } : {}),
  });
  return { result, verdict: result.checks[0]!.verdict, first: result.checks[0]! };
}

describe("parseCitationRef — path, single line, and RANGE", () => {
  it("reads a bare path, a single line, and a range", () => {
    expect(parseCitationRef("src/a.ts")).toMatchObject({ path: "src/a.ts" });
    expect(parseCitationRef("src/a.ts")!.start_line).toBeUndefined();
    expect(parseCitationRef("src/a.ts:12")).toMatchObject({
      path: "src/a.ts",
      start_line: 12,
    });
    expect(parseCitationRef("src/a.ts:12")!.end_line).toBeUndefined();
    expect(parseCitationRef("src/a.ts:12-19")).toMatchObject({
      path: "src/a.ts",
      start_line: 12,
      end_line: 19,
    });
  });

  it("keeps `raw` byte-identical — a reference is reported, never rewritten", () => {
    expect(parseCitationRef("  src/a.ts:900-905  ")!.raw).toBe("  src/a.ts:900-905  ");
  });

  it("refuses a reference carrying no path", () => {
    expect(parseCitationRef("")).toBeUndefined();
    expect(parseCitationRef("   ")).toBeUndefined();
    expect(parseCitationRef(":12-19")).toBeUndefined();
  });
});

describe("countSourceLines — the TRUE length, not the split length", () => {
  it("drops a single trailing empty segment", () => {
    expect(countSourceLines("alpha\nbeta\ngamma\n")).toBe(3);
    expect(countSourceLines("alpha\nbeta\ngamma")).toBe(3);
  });

  it("counts a CRLF file the same as its LF twin", () => {
    expect(countSourceLines("a\r\nb\r\nc\r\n")).toBe(3);
    expect(countSourceLines("a\nb\nc\n")).toBe(3);
  });

  it("counts an empty file as zero lines and keeps a deliberate blank last line", () => {
    expect(countSourceLines("")).toBe(0);
    expect(countSourceLines("a\n\n")).toBe(2);
  });
});

describe("extractCitationRefs — the embedded-citation grammar", () => {
  it("captures the RANGE half a start-only grammar dropped", () => {
    expect(extractCitationRefs("see src/a.ts:2-9999 — broken")).toEqual([
      "src/a.ts:2-9999",
    ]);
    expect(extractCitationRefs("src/a.ts:2 and src/b.ts")).toEqual([
      "src/a.ts:2",
      "src/b.ts",
    ]);
  });

  it("never matches bare prose", () => {
    expect(extractCitationRefs("the login flow loses the session")).toEqual([]);
  });
});

describe("checkCitations — verdicts", () => {
  it("accepts an in-range line and an in-range range", () => {
    expect(check("src/a.ts:2").verdict).toBe("ok");
    expect(check("src/a.ts:1-3").verdict).toBe("ok");
  });

  it("rejects a range whose END overshoots, and reports the real length", () => {
    const { verdict, first } = check("src/a.ts:2-9999");
    expect(verdict).toBe("line_out_of_range");
    expect(first.file_lines).toBe(3);
  });

  it("rejects an inverted range", () => {
    expect(check("src/a.ts:9-2").verdict).toBe("inverted_range");
  });

  it("rejects a path that does not resolve", () => {
    expect(check("src/ghost.ts:1").verdict).toBe("unknown_path");
  });

  it("counts CRLF lines correctly", () => {
    expect(check("src/crlf.ts:3").verdict).toBe("ok");
    expect(check("src/crlf.ts:4").verdict).toBe("line_out_of_range");
  });

  it("REPORTS a bad reference unchanged — it never repairs it", () => {
    const { first } = check("src/a.ts:900-905");
    expect(first.ref).toBe("src/a.ts:900-905");
    expect(first.verdict).toBe("line_out_of_range");
    expect(first.detail).toContain("900-905");
    expect(first.detail).toContain("3-line");
  });

  it("counts an unparseable reference but does not check it", () => {
    const result = checkCitations({
      root,
      corpus,
      citations: [{ owner_id: "c1", ref: "  " }],
    });
    expect(result.checks[0]!.verdict).toBe("unparseable");
    expect(result.checked_count).toBe(0);
  });
});

describe("checkCitations — quote re-verification", () => {
  it("accepts a quote that appears in the cited file and rejects one that does not", () => {
    expect(check("src/a.ts:2", { quote: "beta" }).verdict).toBe("ok");
    expect(check("src/a.ts:2", { quote: "not in this file" }).verdict).toBe(
      "quote_not_found",
    );
  });

  it("accepts a quote still carrying the emitted `N| ` prefix, stripped POSITIONALLY", () => {
    const delivered: DeliveredExcerpt[] = [
      { source_path: "src/a.ts", line_runs: [{ start: 1, end: 3 }], prefix_width: 4 },
    ];
    // `  2| beta` as the packet rendered it, prefix width 4 (`  2|`).
    expect(check("src/a.ts:2", { quote: "  2| beta", delivered }).verdict).toBe("ok");
  });

  it("does NOT mutilate a markdown table row quoted verbatim (the regex-strip collision)", () => {
    // A `^\s*\d+\| ` regex strip would eat `| 12 | ` out of this doc row before
    // matching. The raw quote is tried FIRST, so a correctly de-prefixed quote is
    // never damaged by a strip it did not need.
    const delivered: DeliveredExcerpt[] = [
      { source_path: "docs/table.md", line_runs: [{ start: 1, end: 3 }], prefix_width: 4 },
    ];
    expect(check("docs/table.md:3", { quote: TABLE_ROW, delivered }).verdict).toBe("ok");
    expect(stripEmittedLinePrefix(TABLE_ROW, 0)).toBe(TABLE_ROW);
  });
});

describe("checkCitations — delivered evidence", () => {
  const delivered: DeliveredExcerpt[] = [
    { source_path: "src/a.ts", line_runs: [{ start: 1, end: 1 }, { start: 3, end: 3 }], prefix_width: 4 },
  ];

  it("accepts a citation inside a delivered run", () => {
    expect(check("src/a.ts:3", { delivered }).verdict).toBe("ok");
  });

  it("refuses a real, in-range citation that lies in NO delivered run", () => {
    // Line 2 exists in the file but was never handed to the author: the runs are
    // 1-1 and 3-3. A first-to-last SPAN (1-3) would have certified it.
    const { verdict, first } = check("src/a.ts:2", { delivered });
    expect(verdict).toBe("outside_delivered_evidence");
    expect(first.detail).toContain("no delivered run");
  });

  it("refuses a RANGED citation to a file no excerpt delivered", () => {
    expect(check("docs/table.md:1-2", { delivered }).verdict).toBe(
      "outside_delivered_evidence",
    );
  });

  it("leaves a PATH-ONLY citation alone — it makes no line claim", () => {
    // The structural packet names every member in its file tree while a member
    // with no top-level declarations yields no excerpt; refusing those would be
    // a false red, not a caught defect.
    expect(check("docs/table.md", { delivered }).verdict).toBe("ok");
  });

  it("SKIPS the check when no manifest is available, and says so", () => {
    const withManifest = checkCitations({
      root,
      corpus,
      citations: [{ owner_id: "c1", ref: "src/a.ts:2" }],
      delivered,
    });
    const without = checkCitations({
      root,
      corpus,
      citations: [{ owner_id: "c1", ref: "src/a.ts:2" }],
    });
    expect(withManifest.delivered_evidence_checked).toBe(true);
    expect(without.delivered_evidence_checked).toBe(false);
    expect(without.checks[0]!.verdict).toBe("ok");
  });
});

describe("checkCitations — deterministic result order", () => {
  it("returns the same array whatever order the citations arrive in", () => {
    const citations = [
      { owner_id: "ch-2", ref: "src/a.ts:1" },
      { owner_id: "ch-1", ref: "src/a.ts:9999" },
      { owner_id: "ch-1", ref: "src/a.ts:2" },
    ];
    const forward = checkCitations({ root, corpus, citations });
    const reversed = checkCitations({ root, corpus, citations: [...citations].reverse() });
    expect(JSON.stringify(forward.checks)).toBe(JSON.stringify(reversed.checks));
    expect(forward.checks.map((c) => `${c.owner_id}|${c.ref}`)).toEqual([
      "ch-1|src/a.ts:2",
      "ch-1|src/a.ts:9999",
      "ch-2|src/a.ts:1",
    ]);
  });
});
