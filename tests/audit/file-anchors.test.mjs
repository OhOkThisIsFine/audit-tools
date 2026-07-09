import { test, expect } from "vitest";
import { importSourceModule } from "./helpers/sourceImport.mjs";

const { buildFileAnchorSummary } = await importSourceModule(
  "src/orchestrator/fileAnchors.ts",
);
const { buildLargeFileSection } = await import(
  "../../src/audit/cli/dispatch/packetPrompt.ts"
);

test("symbol scan and keyword scan are independent — a line matching both SYMBOL_PATTERNS and KEYWORD_PATTERN produces both a symbol/route anchor and a keyword anchor", () => {
  // The function declaration matches SYMBOL_PATTERNS (function), and the
  // standalone parameter word 'secret' matches KEYWORD_PATTERN (\bsecret\b).
  // (The keyword must be a whole word — KEYWORD_PATTERN anchors on \b — so it
  // appears as a parameter rather than embedded in the function name.)
  const content = "export function run(secret) { return secret; }\n";
  const summary = buildFileAnchorSummary({
    path: "src/db/runner.ts",
    content,
    totalLines: 1,
  });

  const symbolAnchor = summary.anchors.find(
    (a) => a.kind === "symbol" || a.kind === "route" || a.kind === "export",
  );
  const keywordAnchor = summary.anchors.find((a) => a.kind === "keyword");

  expect(symbolAnchor, "Expected a symbol/route/export anchor for the function declaration").toBeTruthy();
  expect(keywordAnchor, "Expected a keyword anchor for the security-sensitive keyword").toBeTruthy();
  expect(summary.counts.symbols + summary.counts.routes >= 1, "symbolCount or routeCount must be at least 1").toBe(true);
  expect(summary.counts.keywords >= 1, "keywordCount must be at least 1").toBe(true);
});

test("symbol scan breaks after first SYMBOL_PATTERNS match — only one symbol anchor per line regardless of how many patterns match", () => {
  // A line that starts with 'export function' matches both the function pattern
  // and the export pattern in SYMBOL_PATTERNS. Only the first match should fire.
  const content = "export function handleAuth(req) {}\n";
  const summary = buildFileAnchorSummary({
    path: "src/api/auth.ts",
    content,
    totalLines: 1,
  });

  const symbolLikeAnchors = summary.anchors.filter(
    (a) => a.kind === "symbol" || a.kind === "route" || a.kind === "export" || a.kind === "import",
  );

  // Exactly one symbol-class anchor should be produced for this single line.
  expect(symbolLikeAnchors.length, `Expected exactly 1 symbol-class anchor for a single-function line, got ${symbolLikeAnchors.length}: ${JSON.stringify(symbolLikeAnchors.map((a) => a.kind))}`).toBe(1);
  expect(summary.counts.symbols + summary.counts.routes, "symbolCount + routeCount must be exactly 1 for a single matched line").toBe(1);
});

// ── symbol spans (increment 2d, path::symbol slicing) ─────────────────────────

test("symbol spans: consecutive symbols get [start, next-symbol-start-1]; the last runs to file end", () => {
  const content = [
    "function alpha() {", // line 1
    "  return 1;",         // 2
    "}",                    // 3
    "function beta() {",   // 4
    "  return 2;",         // 5
    "}",                    // 6
    "function gamma() {",  // 7
    "  return 3;",         // 8
    "}",                    // 9
  ].join("\n");
  const summary = buildFileAnchorSummary({
    path: "src/spans.ts",
    content,
    totalLines: 9,
  });
  const byName = (name) =>
    summary.anchors.find((a) => a.kind === "symbol" && a.name === name);

  expect(byName("alpha").line, "alpha starts at line 1").toBe(1);
  expect(byName("alpha").end_line, "alpha span ends the line before beta (3)").toBe(3);
  expect(byName("beta").line, "beta starts at line 4").toBe(4);
  expect(byName("beta").end_line, "beta span ends the line before gamma (6)").toBe(6);
  expect(byName("gamma").line, "gamma starts at line 7").toBe(7);
  expect(byName("gamma").end_line, "the last symbol span runs to file end (9)").toBe(9);
});

test("symbol spans: a lone symbol spans to the file end", () => {
  const content = ["function solo() {", "  return 1;", "}", "", ""].join("\n");
  const summary = buildFileAnchorSummary({
    path: "src/solo.ts",
    content,
    totalLines: 5,
  });
  const solo = summary.anchors.find((a) => a.kind === "symbol" && a.name === "solo");
  expect(solo.line, "solo starts at line 1").toBe(1);
  expect(solo.end_line, "a lone symbol spans to file end (5)").toBe(5);
});

test("symbol spans: a mid-body keyword anchor does NOT truncate the enclosing symbol span", () => {
  // The `token` keyword on line 2 produces a keyword anchor, but keyword anchors
  // are not declaration boundaries — the first symbol's span must still extend to
  // the line before the next symbol.
  const content = [
    "function first() {",     // 1 symbol
    "  const token = get();", // 2 keyword (mid-body) — must NOT bound the span
    "  return token;",        // 3
    "}",                       // 4
    "function second() {}",   // 5 symbol
  ].join("\n");
  const summary = buildFileAnchorSummary({
    path: "src/kw.ts",
    content,
    totalLines: 5,
  });
  const first = summary.anchors.find((a) => a.kind === "symbol" && a.name === "first");
  expect(first.end_line, "first span must reach line 4 (before second), not stop at the keyword line").toBe(4);
});

test("symbol spans: end_line never exceeds totalLines and is >= the start line", () => {
  const content = ["function only() {}"].join("\n");
  const summary = buildFileAnchorSummary({
    path: "src/clamp.ts",
    content,
    totalLines: 1,
  });
  const only = summary.anchors.find((a) => a.kind === "symbol" && a.name === "only");
  expect(only.end_line, "single-line file → span clamps to [1,1]").toBe(1);
  expect(only.end_line >= only.line, "end_line must be >= start line").toBe(true);
});

test("symbol spans: only symbol-kind anchors carry end_line (routes/keywords/imports do not)", () => {
  const content = [
    "import { x } from './x';", // 1 import
    "function handler() {}",     // 2 symbol
    "app.get('/p', handler);",   // 3 route
    "// TODO revisit",           // 4 keyword
  ].join("\n");
  const summary = buildFileAnchorSummary({
    path: "src/kinds.ts",
    content,
    totalLines: 4,
  });
  for (const anchor of summary.anchors) {
    if (anchor.kind !== "symbol") {
      expect(anchor.end_line, `${anchor.kind} anchor must not carry an end_line`).toBe(undefined);
    }
  }
  const handler = summary.anchors.find((a) => a.kind === "symbol" && a.name === "handler");
  // The route on line 3 is a declaration boundary → handler's span stops at 2.
  expect(handler.end_line, "handler span bounded by the route at line 3 → [2,2]").toBe(2);
});

test("symbol spans reach the worker prompt as a path:START-END targeted read range", () => {
  const content = [
    "function alpha() {",
    "  return 1;",
    "}",
    "function beta() {}",
  ].join("\n");
  const summary = buildFileAnchorSummary({
    path: "src/render.ts",
    content,
    totalLines: 4,
  });
  const section = buildLargeFileSection(true, summary, "run/anchors.json").join("\n");
  // alpha spans [1,3] → rendered as a range; the guidance names the slice discipline.
  expect(section.includes("src/render.ts:1-3 [symbol] alpha"), section).toBe(true);
  expect(section.includes("approximate line span"), "guidance must frame spans as advisory").toBe(true);
});

// ── MAX_ANCHORS cap ───────────────────────────────────────────────────────────

test("MAX_ANCHORS cap limits anchors to 160 and sets omitted_anchor_count", () => {
  // Generate >160 unique symbol lines so the raw anchor list exceeds MAX_ANCHORS.
  // Each 'function fn_N' line produces a distinct symbol anchor.
  const lines = [];
  for (let i = 0; i < 200; i++) {
    lines.push(`function fn_${i}() {}`);
  }
  const content = lines.join("\n");
  const summary = buildFileAnchorSummary({
    path: "src/big.ts",
    content,
    totalLines: lines.length,
  });

  expect(summary.anchors.length, "anchors must be capped at 160").toBe(160);
  expect(summary.omitted_anchor_count > 0, "omitted_anchor_count must be > 0 when cap is hit").toBeTruthy();
  // Conservation: file_start boundary + file_end boundary + 200 symbol anchors
  // = 202 total collected (after dedup). The kept anchors (capped at 160) plus
  // the omitted count must equal that uncapped total — i.e. nothing is lost or
  // double-counted by the cap (TST-8d6f7754: previously a self-comparison
  // tautology that asserted nothing).
  const total = summary.anchors.length + summary.omitted_anchor_count;
  expect(total, "kept + omitted must equal the uncapped collected total (2 boundaries + 200 symbols)").toBe(202);
  expect(summary.omitted_anchor_count, "omitted_anchor_count must account for exactly the anchors dropped by the 160 cap").toBe(total - 160);
});

test("omitted_anchor_count is 0 when total anchors are within cap", () => {
  // 3 symbol lines + 2 boundary anchors = 5 total, well under 160.
  const content = [
    "function alpha() {}",
    "function beta() {}",
    "function gamma() {}",
  ].join("\n");
  const summary = buildFileAnchorSummary({
    path: "src/small.ts",
    content,
    totalLines: 3,
  });

  expect(summary.omitted_anchor_count, "omitted_anchor_count must be 0 when under cap").toBe(0);
  expect(summary.anchors.length > 0, "anchors must be non-empty").toBeTruthy();
});

// ── KEYWORD_PATTERN matching ──────────────────────────────────────────────────

test("KEYWORD_PATTERN matches security-sensitive keywords and produces keyword anchors", () => {
  const keywords = [
    "auth", "token", "password", "secret", "sql", "exec",
    "encrypt", "decrypt", "TODO", "FIXME", "cache", "retry",
    "timeout", "transaction", "lock",
  ];
  for (const kw of keywords) {
    // The keyword must appear as a standalone word: KEYWORD_PATTERN anchors on
    // \b boundaries, so embedding it in an identifier (e.g. use_auth_here) would
    // not match. A comment line keeps the keyword whole and avoids tripping any
    // SYMBOL_PATTERN.
    const content = `// uses ${kw} here`;
    const summary = buildFileAnchorSummary({
      path: "src/test.ts",
      content,
      totalLines: 1,
    });
    const kwAnchor = summary.anchors.find((a) => a.kind === "keyword");
    expect(kwAnchor, `Expected a keyword anchor for line containing '${kw}'; got none`).toBeTruthy();
    expect(kwAnchor.name.toLowerCase().includes(kw.toLowerCase()), `keyword anchor name '${kwAnchor.name}' should reflect '${kw}'`).toBeTruthy();
  }
});

test("lines with no recognized keyword produce no keyword anchor", () => {
  const content = "const result = computeValue(input);";
  const summary = buildFileAnchorSummary({
    path: "src/plain.ts",
    content,
    totalLines: 1,
  });
  const kwAnchor = summary.anchors.find((a) => a.kind === "keyword");
  expect(kwAnchor, "Expected no keyword anchor for an innocuous line").toBe(undefined);
  expect(summary.counts.keywords, "keyword count must be 0").toBe(0);
});

// ── Windows path normalization for graph edge matching ────────────────────────

test("normalizePath converts Windows backslashes to forward slashes for graph edge matching", () => {
  const graphBundle = {
    graphs: {
      imports: [
        { from: "src\\foo.ts", to: "src\\bar.ts", kind: "imports" },
      ],
    },
  };
  const summary = buildFileAnchorSummary({
    path: "src/foo.ts",
    content: "",
    totalLines: 1,
    graphBundle,
  });
  const graphAnchor = summary.anchors.find((a) => a.kind === "graph");
  expect(graphAnchor, "Expected a graph anchor when a backslash edge matches the normalized path").toBeTruthy();
  expect(graphAnchor.detail.includes("outbound"), `Expected outbound detail for an edge FROM src/foo.ts; got '${graphAnchor.detail}'`).toBeTruthy();
  expect(summary.counts.graph_edges, "graph_edges count must be 1").toBe(1);
});

// ── deduplication ─────────────────────────────────────────────────────────────

test("deduplication: identical kind+line+name+detail anchors are collapsed to one", () => {
  // Two adjacent lines that would each produce a keyword anchor with the same
  // matched keyword; because the line numbers differ the dedup key differs, but
  // if we manufacture the same line repeated we still get two distinct line-based
  // keys.  Instead, test the boundary dedup: file_start at line 1 is added once
  // regardless of how many times the internals would try to insert it.
  const content = "const x = 1;";
  const summary1 = buildFileAnchorSummary({
    path: "src/dedup.ts",
    content,
    totalLines: 1,
  });
  const boundaryAnchors = summary1.anchors.filter((a) => a.kind === "boundary" && a.name === "file_start");
  expect(boundaryAnchors.length, "file_start boundary anchor must appear exactly once").toBe(1);
});

// TST-91fc5147: anchor deduplication — negative tests
test("TST-91fc5147: graph edge that appears in two buckets with the same kind field is deduplicated to one anchor", () => {
  // The same logical edge {from, to, kind: "imports"} appears in BOTH the
  // "imports" bucket and the "calls" bucket. Because addAnchor keys on
  // kind\0line\0name\0detail and edge.kind is taken from the record's `kind`
  // field (not the bucket name), the dedup key is identical for both occurrences
  // → only one graph anchor should be emitted even though collectGraphEdges
  // returns 2 raw edges.
  const graphBundle = {
    graphs: {
      imports: [
        { from: "src/dedup.ts", to: "src/dep.ts", kind: "imports" },
      ],
      calls: [
        // Same logical edge, same kind field — duplicate
        { from: "src/dedup.ts", to: "src/dep.ts", kind: "imports" },
      ],
    },
  };
  const summary = buildFileAnchorSummary({
    path: "src/dedup.ts",
    content: "",
    totalLines: 1,
    graphBundle,
  });
  const graphAnchors = summary.anchors.filter((a) => a.kind === "graph");
  expect(graphAnchors.length, "graph anchor for the same edge appearing in two buckets must be deduplicated to 1").toBe(1);
  // Note: counts.graph_edges tracks raw collected edges (pre-dedup), not
  // the number of anchors emitted. The anchor array is the dedup'd surface.
  expect(summary.counts.graph_edges, "counts.graph_edges reflects raw edge count (2), not anchor count").toBe(2);
});

test("TST-91fc5147: two distinct graph edges (different to-targets) each produce separate anchors", () => {
  // Verify that legitimate distinct edges are NOT collapsed together — dedup
  // should only suppress actual duplicates.
  const graphBundle = {
    graphs: {
      imports: [
        { from: "src/dedup.ts", to: "src/dep-a.ts", kind: "imports" },
        { from: "src/dedup.ts", to: "src/dep-b.ts", kind: "imports" },
      ],
    },
  };
  const summary = buildFileAnchorSummary({
    path: "src/dedup.ts",
    content: "",
    totalLines: 1,
    graphBundle,
  });
  const graphAnchors = summary.anchors.filter((a) => a.kind === "graph");
  expect(graphAnchors.length, "two distinct outbound edges must produce two separate graph anchors").toBe(2);
  expect(summary.counts.graph_edges, "graph_edges count must be 2").toBe(2);
});

// ── boundary anchors ──────────────────────────────────────────────────────────

test("boundary anchors: single-line file emits only file_start boundary", () => {
  const summary = buildFileAnchorSummary({
    path: "src/one.ts",
    content: "const x = 1;",
    totalLines: 1,
  });
  const boundaries = summary.anchors.filter((a) => a.kind === "boundary");
  expect(boundaries.length, "single-line file should have exactly 1 boundary anchor").toBe(1);
  expect(boundaries[0].name, "the single boundary must be file_start").toBe("file_start");
  const fileEnd = summary.anchors.find((a) => a.kind === "boundary" && a.name === "file_end");
  expect(fileEnd, "single-line file must not emit file_end").toBe(undefined);
});

test("boundary anchors: multi-line file emits both file_start and file_end", () => {
  const lines = ["const a = 1;", "const b = 2;", "const c = 3;", "const d = 4;", "const e = 5;"];
  const summary = buildFileAnchorSummary({
    path: "src/multi.ts",
    content: lines.join("\n"),
    totalLines: 5,
  });
  const fileStart = summary.anchors.find((a) => a.kind === "boundary" && a.name === "file_start");
  const fileEnd = summary.anchors.find((a) => a.kind === "boundary" && a.name === "file_end");
  expect(fileStart, "multi-line file must have a file_start boundary").toBeTruthy();
  expect(fileStart.line, "file_start must be at line 1").toBe(1);
  expect(fileEnd, "multi-line file must have a file_end boundary").toBeTruthy();
  expect(fileEnd.line, "file_end must be at totalLines (5)").toBe(5);
});

// ── counts accuracy ───────────────────────────────────────────────────────────

test("counts fields accurately reflect tallied symbols, routes, keywords, graph edges, and analyzer signals", () => {
  const content = [
    "function mySymbol() {}",      // symbol
    "app.get('/path', handler);",  // route
    "// secret handling here",     // keyword (a comment, so it is not also a binding symbol)
  ].join("\n");

  const graphBundle = {
    graphs: {
      imports: [
        { from: "src/counts.ts", to: "src/dep.ts", kind: "imports" },
        { from: "src/other.ts", to: "src/counts.ts", kind: "imports" },
      ],
    },
  };

  const externalAnalyzerResults = [
    {
      tool: "test-analyzer",
      results: [
        { id: "rule-1", path: "src/counts.ts", category: "security", rule: "no-secret", summary: "secret found", line_start: 3 },
        { id: "rule-2", path: "src/other.ts", category: "style", rule: "no-var", summary: "use const", line_start: 1 },
      ],
    },
  ];

  const summary = buildFileAnchorSummary({
    path: "src/counts.ts",
    content,
    totalLines: 3,
    graphBundle,
    externalAnalyzerResults,
  });

  expect(summary.counts.symbols, "symbols count must be 1").toBe(1);
  expect(summary.counts.routes, "routes count must be 1").toBe(1);
  expect(summary.counts.keywords >= 1, "keywords count must be >= 1 (secret)").toBeTruthy();
  expect(summary.counts.graph_edges, "graph_edges count must be 2 (both edges touch src/counts.ts)").toBe(2);
  expect(summary.counts.analyzer_signals, "analyzer_signals count must be 1 (only the matching path)").toBe(1);
});

// ── analyzer signal filtering ─────────────────────────────────────────────────

test("analyzer signals are filtered to the given file path (case-insensitive, backslash-normalized)", () => {
  const externalAnalyzerResults = [
    {
      tool: "test-analyzer",
      results: [
        { id: "sig-1", path: "src\\Target.ts", category: "security", rule: "rule-a", summary: "match", line_start: 1 },
        { id: "sig-2", path: "src/unrelated.ts", category: "style", rule: "rule-b", summary: "no match", line_start: 1 },
      ],
    },
  ];

  // Pass the target path with forward slashes; the analyzer result uses backslashes.
  const summary = buildFileAnchorSummary({
    path: "src/target.ts",
    content: "",
    totalLines: 1,
    externalAnalyzerResults,
  });

  const sigAnchors = summary.anchors.filter((a) => a.kind === "analyzer_signal");
  expect(sigAnchors.length, "only one analyzer_signal anchor should be present (matching path)").toBe(1);
  expect(sigAnchors[0].name, "anchor should be for rule-a").toBe("rule-a");
  expect(summary.counts.analyzer_signals, "analyzer_signals count must be 1").toBe(1);
});

// ── path normalization in returned summary ────────────────────────────────────

test("path in the returned FileAnchorSummary is normalized (leading ./ stripped, backslashes to slashes)", () => {
  const summary = buildFileAnchorSummary({
    path: ".\\src\\foo.ts",
    content: "",
    totalLines: 1,
  });
  expect(summary.path, "summary.path must be normalized to src/foo.ts").toBe("src/foo.ts");
});
