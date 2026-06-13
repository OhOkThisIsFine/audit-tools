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

/**
 * Capture process.stderr.write chunks during fn(), then parse them into the
 * structured `graph_enrichment_analyzer_failed` events the executor emits.
 * Returns { result, events[], rawLines[] }.
 */
async function withCapturedStderr(fn) {
  const chunks = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  let result;
  try {
    result = await fn();
  } finally {
    process.stderr.write = original;
  }
  const rawLines = chunks
    .join("")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const events = [];
  for (const line of rawLines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && parsed.kind === "graph_enrichment_analyzer_failed") {
        events.push(parsed);
      }
    } catch {
      // non-JSON stderr noise — ignore
    }
  }
  return { result, events, rawLines };
}

// ── structured stderr diagnostic on analyzer throw ─────────────────────────
// Diagnostics moved from console.warn to structured stderr JSON events
// (audit-orchestrator-observability). One throwing analyzer → exactly one
// `graph_enrichment_analyzer_failed` event carrying the analyzer id + note.

test("graphEnrichmentExecutor emits a structured stderr event when an analyzer throws", async () => {
  const thrower = throwingAnalyzer("ts-tree-sitter");
  const { events } = await withCapturedStderr(() =>
    runGraphEnrichmentExecutor(minBundle(), {
      root: "/virtual/root",
      registry: [thrower],
    }),
  );

  assert.equal(events.length, 1, "should emit exactly one structured stderr event for one throwing analyzer");
  assert.equal(
    events[0].analyzer_id,
    "ts-tree-sitter",
    `event should carry the analyzer id; got: ${JSON.stringify(events[0])}`,
  );
  assert.ok(
    String(events[0].note).includes("deliberate test failure") ||
      String(events[0].note).includes("Analyzer failed"),
    `event note should include the error summary; got: ${JSON.stringify(events[0])}`,
  );
});

test("graphEnrichmentExecutor structured stderr event includes the analyzer id", async () => {
  const thrower = throwingAnalyzer("py-tree-sitter");
  const { events } = await withCapturedStderr(() =>
    runGraphEnrichmentExecutor(minBundle(), {
      root: "/virtual/root",
      registry: [thrower],
    }),
  );

  assert.ok(events.length >= 1, "should have at least one structured stderr event");
  assert.equal(
    events[0].analyzer_id,
    "py-tree-sitter",
    `event should carry the analyzer id 'py-tree-sitter'; got: ${JSON.stringify(events[0])}`,
  );
});

test("graphEnrichmentExecutor structured stderr event includes the error summary text", async () => {
  const thrower = throwingAnalyzer("ts-tree-sitter");
  const { events } = await withCapturedStderr(() =>
    runGraphEnrichmentExecutor(minBundle(), {
      root: "/virtual/root",
      registry: [thrower],
    }),
  );

  assert.ok(events.length >= 1, "should have at least one structured stderr event");
  // The note starts with "Analyzer failed" and should include the error message.
  assert.ok(
    String(events[0].note).includes("deliberate test failure"),
    `event note should include the original error text; got: ${JSON.stringify(events[0])}`,
  );
});

// ── omitted progress_summary includes failed analyzer ids ──────────────────

test("graphEnrichmentExecutor omitted progress_summary includes failed analyzer ids", async () => {
  const thrower = throwingAnalyzer("ts-tree-sitter");
  const { result } = await withCapturedStderr(() =>
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
  const { result, events } = await withCapturedStderr(() =>
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
  assert.equal(events.length, 0, "no analyzer-failed events should be emitted for skip resolutions");
});

test("graphEnrichmentExecutor does NOT emit a structured stderr event for skip resolutions", async () => {
  const skipper = skipAnalyzer("fake-skip");
  const { events } = await withCapturedStderr(() =>
    runGraphEnrichmentExecutor(minBundle(), {
      root: "/virtual/root",
      registry: [skipper],
    }),
  );

  assert.equal(events.length, 0, "no analyzer-failed event should be emitted for skipped analyzers");
});
