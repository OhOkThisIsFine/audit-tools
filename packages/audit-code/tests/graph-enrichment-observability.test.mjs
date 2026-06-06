import test from "node:test";
import assert from "node:assert/strict";

const { runGraphEnrichmentExecutor } = await import(
  "../src/orchestrator/graphEnrichmentExecutor.ts"
);

function floorGraph() {
  return { graphs: { imports: [], calls: [], references: [], routes: [] } };
}

function minBundle(extra = {}) {
  return {
    repo_manifest: {
      files: [
        { path: "src/a.ts", size_bytes: 32, language: "typescript", excluded: false },
      ],
    },
    file_disposition: { files: [] },
    graph_bundle: floorGraph(),
    ...extra,
  };
}

/** A fake analyzer that always throws when analyze() is called. */
function throwingAnalyzer(id = "fake-thrower") {
  return {
    id,
    supports: (file) => file.endsWith(".ts"),
    analyze: () => {
      throw new Error("deliberate test failure");
    },
  };
}

/** A fake analyzer that always skips (no supported files). */
function skipAnalyzer(id = "fake-skip") {
  return {
    id,
    supports: () => false,
    analyze: () => ({ edges: [] }),
  };
}

/** Capture console.warn calls during fn(). Returns { result, warnings[] }. */
async function withWarnCapture(fn) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  try {
    const result = await fn();
    return { result, warnings };
  } finally {
    console.warn = original;
  }
}

// ── console.warn on analyzer throw ─────────────────────────────────────────

test("graphEnrichmentExecutor emits console.warn when an analyzer throws", async () => {
  const thrower = throwingAnalyzer("ts-tree-sitter");
  const { result, warnings } = await withWarnCapture(() =>
    runGraphEnrichmentExecutor(minBundle(), {
      root: "/virtual/root",
      registry: [thrower],
    }),
  );

  assert.equal(warnings.length, 1, "should emit exactly one console.warn for one throwing analyzer");
  assert.ok(
    warnings[0].includes("ts-tree-sitter"),
    `warn message should include analyzer id; got: ${warnings[0]}`,
  );
  assert.ok(
    warnings[0].includes("deliberate test failure") || warnings[0].includes("Analyzer failed"),
    `warn message should include the error summary; got: ${warnings[0]}`,
  );
});

test("graphEnrichmentExecutor console.warn message includes the analyzer id", async () => {
  const thrower = throwingAnalyzer("py-tree-sitter");
  const { warnings } = await withWarnCapture(() =>
    runGraphEnrichmentExecutor(minBundle(), {
      root: "/virtual/root",
      registry: [thrower],
    }),
  );

  assert.ok(warnings.length >= 1, "should have at least one warning");
  assert.ok(
    warnings[0].includes("py-tree-sitter"),
    `warn message should include the analyzer id 'py-tree-sitter'; got: ${warnings[0]}`,
  );
});

test("graphEnrichmentExecutor console.warn message includes the error summary text", async () => {
  const thrower = throwingAnalyzer("ts-tree-sitter");
  const { warnings } = await withWarnCapture(() =>
    runGraphEnrichmentExecutor(minBundle(), {
      root: "/virtual/root",
      registry: [thrower],
    }),
  );

  assert.ok(warnings.length >= 1, "should have at least one warning");
  // The note starts with "Analyzer failed" and should include the error message
  assert.ok(
    warnings[0].includes("deliberate test failure"),
    `warn message should include the original error text; got: ${warnings[0]}`,
  );
});

// ── omitted progress_summary includes failed analyzer ids ──────────────────

test("graphEnrichmentExecutor omitted progress_summary includes failed analyzer ids", async () => {
  const thrower = throwingAnalyzer("ts-tree-sitter");
  const { result } = await withWarnCapture(() =>
    runGraphEnrichmentExecutor(minBundle(), {
      root: "/virtual/root",
      registry: [thrower],
    }),
  );

  assert.ok(
    result.progress_summary.includes("ts-tree-sitter"),
    `progress_summary should name the failed analyzer; got: ${result.progress_summary}`,
  );
});

test("graphEnrichmentExecutor omitted progress_summary stays clean when no analyzers throw", async () => {
  const skipper = skipAnalyzer("fake-skip");
  const { result, warnings } = await withWarnCapture(() =>
    runGraphEnrichmentExecutor(minBundle(), {
      root: "/virtual/root",
      registry: [skipper],
    }),
  );

  assert.equal(
    result.progress_summary,
    "Graph enrichment omitted; deterministic regex graph retained.",
    "progress_summary should be unmodified when no analyzer throws",
  );
  assert.equal(warnings.length, 0, "no warnings should be emitted for skip resolutions");
});

test("graphEnrichmentExecutor does NOT emit console.warn for skip resolutions", async () => {
  const skipper = skipAnalyzer("fake-skip");
  const { warnings } = await withWarnCapture(() =>
    runGraphEnrichmentExecutor(minBundle(), {
      root: "/virtual/root",
      registry: [skipper],
    }),
  );

  assert.equal(warnings.length, 0, "console.warn should not be called for skipped analyzers");
});
