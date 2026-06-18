import test from "node:test";
import assert from "node:assert/strict";
import { importSourceModule } from "./helpers/sourceImport.mjs";

const { buildFileAnchorSummary } = await importSourceModule(
  "src/orchestrator/fileAnchors.ts",
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

  assert.ok(symbolAnchor, "Expected a symbol/route/export anchor for the function declaration");
  assert.ok(keywordAnchor, "Expected a keyword anchor for the security-sensitive keyword");
  assert.equal(summary.counts.symbols + summary.counts.routes >= 1, true, "symbolCount or routeCount must be at least 1");
  assert.equal(summary.counts.keywords >= 1, true, "keywordCount must be at least 1");
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
  assert.equal(
    symbolLikeAnchors.length,
    1,
    `Expected exactly 1 symbol-class anchor for a single-function line, got ${symbolLikeAnchors.length}: ${JSON.stringify(symbolLikeAnchors.map((a) => a.kind))}`,
  );
  assert.equal(
    summary.counts.symbols + summary.counts.routes,
    1,
    "symbolCount + routeCount must be exactly 1 for a single matched line",
  );
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

  assert.equal(summary.anchors.length, 160, "anchors must be capped at 160");
  assert.ok(summary.omitted_anchor_count > 0, "omitted_anchor_count must be > 0 when cap is hit");
  // Conservation: file_start boundary + file_end boundary + 200 symbol anchors
  // = 202 total collected (after dedup). The kept anchors (capped at 160) plus
  // the omitted count must equal that uncapped total — i.e. nothing is lost or
  // double-counted by the cap (TST-8d6f7754: previously a self-comparison
  // tautology that asserted nothing).
  const total = summary.anchors.length + summary.omitted_anchor_count;
  assert.equal(total, 202, "kept + omitted must equal the uncapped collected total (2 boundaries + 200 symbols)");
  assert.equal(
    summary.omitted_anchor_count,
    total - 160,
    "omitted_anchor_count must account for exactly the anchors dropped by the 160 cap",
  );
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

  assert.equal(summary.omitted_anchor_count, 0, "omitted_anchor_count must be 0 when under cap");
  assert.ok(summary.anchors.length > 0, "anchors must be non-empty");
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
    assert.ok(
      kwAnchor,
      `Expected a keyword anchor for line containing '${kw}'; got none`,
    );
    assert.ok(
      kwAnchor.name.toLowerCase().includes(kw.toLowerCase()),
      `keyword anchor name '${kwAnchor.name}' should reflect '${kw}'`,
    );
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
  assert.equal(kwAnchor, undefined, "Expected no keyword anchor for an innocuous line");
  assert.equal(summary.counts.keywords, 0, "keyword count must be 0");
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
  assert.ok(
    graphAnchor,
    "Expected a graph anchor when a backslash edge matches the normalized path",
  );
  assert.ok(
    graphAnchor.detail.includes("outbound"),
    `Expected outbound detail for an edge FROM src/foo.ts; got '${graphAnchor.detail}'`,
  );
  assert.equal(summary.counts.graph_edges, 1, "graph_edges count must be 1");
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
  assert.equal(
    boundaryAnchors.length,
    1,
    "file_start boundary anchor must appear exactly once",
  );
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
  assert.equal(
    graphAnchors.length,
    1,
    "graph anchor for the same edge appearing in two buckets must be deduplicated to 1",
  );
  // Note: counts.graph_edges tracks raw collected edges (pre-dedup), not
  // the number of anchors emitted. The anchor array is the dedup'd surface.
  assert.equal(summary.counts.graph_edges, 2, "counts.graph_edges reflects raw edge count (2), not anchor count");
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
  assert.equal(
    graphAnchors.length,
    2,
    "two distinct outbound edges must produce two separate graph anchors",
  );
  assert.equal(summary.counts.graph_edges, 2, "graph_edges count must be 2");
});

// ── boundary anchors ──────────────────────────────────────────────────────────

test("boundary anchors: single-line file emits only file_start boundary", () => {
  const summary = buildFileAnchorSummary({
    path: "src/one.ts",
    content: "const x = 1;",
    totalLines: 1,
  });
  const boundaries = summary.anchors.filter((a) => a.kind === "boundary");
  assert.equal(boundaries.length, 1, "single-line file should have exactly 1 boundary anchor");
  assert.equal(boundaries[0].name, "file_start", "the single boundary must be file_start");
  const fileEnd = summary.anchors.find((a) => a.kind === "boundary" && a.name === "file_end");
  assert.equal(fileEnd, undefined, "single-line file must not emit file_end");
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
  assert.ok(fileStart, "multi-line file must have a file_start boundary");
  assert.equal(fileStart.line, 1, "file_start must be at line 1");
  assert.ok(fileEnd, "multi-line file must have a file_end boundary");
  assert.equal(fileEnd.line, 5, "file_end must be at totalLines (5)");
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

  const externalAnalyzerResults = {
    results: [
      { id: "rule-1", path: "src/counts.ts", category: "security", rule: "no-secret", summary: "secret found", line_start: 3 },
      { id: "rule-2", path: "src/other.ts", category: "style", rule: "no-var", summary: "use const", line_start: 1 },
    ],
  };

  const summary = buildFileAnchorSummary({
    path: "src/counts.ts",
    content,
    totalLines: 3,
    graphBundle,
    externalAnalyzerResults,
  });

  assert.equal(summary.counts.symbols, 1, "symbols count must be 1");
  assert.equal(summary.counts.routes, 1, "routes count must be 1");
  assert.ok(summary.counts.keywords >= 1, "keywords count must be >= 1 (secret)");
  assert.equal(summary.counts.graph_edges, 2, "graph_edges count must be 2 (both edges touch src/counts.ts)");
  assert.equal(summary.counts.analyzer_signals, 1, "analyzer_signals count must be 1 (only the matching path)");
});

// ── analyzer signal filtering ─────────────────────────────────────────────────

test("analyzer signals are filtered to the given file path (case-insensitive, backslash-normalized)", () => {
  const externalAnalyzerResults = {
    results: [
      { id: "sig-1", path: "src\\Target.ts", category: "security", rule: "rule-a", summary: "match", line_start: 1 },
      { id: "sig-2", path: "src/unrelated.ts", category: "style", rule: "rule-b", summary: "no match", line_start: 1 },
    ],
  };

  // Pass the target path with forward slashes; the analyzer result uses backslashes.
  const summary = buildFileAnchorSummary({
    path: "src/target.ts",
    content: "",
    totalLines: 1,
    externalAnalyzerResults,
  });

  const sigAnchors = summary.anchors.filter((a) => a.kind === "analyzer_signal");
  assert.equal(sigAnchors.length, 1, "only one analyzer_signal anchor should be present (matching path)");
  assert.equal(sigAnchors[0].name, "rule-a", "anchor should be for rule-a");
  assert.equal(summary.counts.analyzer_signals, 1, "analyzer_signals count must be 1");
});

// ── path normalization in returned summary ────────────────────────────────────

test("path in the returned FileAnchorSummary is normalized (leading ./ stripped, backslashes to slashes)", () => {
  const summary = buildFileAnchorSummary({
    path: ".\\src\\foo.ts",
    content: "",
    totalLines: 1,
  });
  assert.equal(summary.path, "src/foo.ts", "summary.path must be normalized to src/foo.ts");
});
