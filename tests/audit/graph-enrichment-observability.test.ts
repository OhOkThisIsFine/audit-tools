import { test, expect } from "vitest";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import type { GraphBundle } from "audit-tools/shared";
import type { LanguageAnalyzer } from "../../src/audit/extractors/analyzers/types.js";

const { runGraphEnrichmentExecutor } = await import("../../src/audit/orchestrator/graphEnrichmentExecutor.js");

function floorGraph(): GraphBundle {
  return { graphs: { imports: [], calls: [], references: [], routes: [] } };
}

function minBundle(extra: Partial<ArtifactBundle> = {}): ArtifactBundle {
  return {
    repo_manifest: {
      repository: { name: "test-repo" },
      generated_at: "2026-01-01T00:00:00.000Z",
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
function throwingAnalyzer(id = "fake-thrower"): LanguageAnalyzer {
  return {
    id,
    supports: (file: string) => file.endsWith(".ts"),
    analyze: () => {
      throw new Error("deliberate test failure");
    },
  };
}

/** A fake analyzer that always skips (no supported files). */
function skipAnalyzer(id = "fake-skip"): LanguageAnalyzer {
  return {
    id,
    supports: () => false,
    analyze: () => ({ edges: [] }),
  };
}

/** The structured stderr event runGraphEnrichmentExecutor emits on an analyzer throw. */
interface AnalyzerFailedEvent {
  kind: "graph_enrichment_analyzer_failed";
  analyzer_id: string;
  resolution: string;
  note: string;
  ts: string;
}

/**
 * Capture process.stderr.write chunks during fn(), then parse them into the
 * structured `graph_enrichment_analyzer_failed` events the executor emits.
 * Returns { result, events[], rawLines[] }.
 */
async function withCapturedStderr<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; events: AnalyzerFailedEvent[]; rawLines: string[] }> {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  let result: T;
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
  const events: AnalyzerFailedEvent[] = [];
  for (const line of rawLines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && parsed.kind === "graph_enrichment_analyzer_failed") {
        events.push(parsed as AnalyzerFailedEvent);
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

  expect(events.length, "should emit exactly one structured stderr event for one throwing analyzer").toBe(1);
  expect(events[0].analyzer_id, `event should carry the analyzer id; got: ${JSON.stringify(events[0])}`).toBe("ts-tree-sitter");
  expect(String(events[0].note).includes("deliberate test failure") ||
      String(events[0].note).includes("Analyzer failed"), `event note should include the error summary; got: ${JSON.stringify(events[0])}`).toBeTruthy();
});

test("graphEnrichmentExecutor structured stderr event includes the analyzer id", async () => {
  const thrower = throwingAnalyzer("py-tree-sitter");
  const { events } = await withCapturedStderr(() =>
    runGraphEnrichmentExecutor(minBundle(), {
      root: "/virtual/root",
      registry: [thrower],
    }),
  );

  expect(events.length >= 1, "should have at least one structured stderr event").toBeTruthy();
  expect(events[0].analyzer_id, `event should carry the analyzer id 'py-tree-sitter'; got: ${JSON.stringify(events[0])}`).toBe("py-tree-sitter");
});

test("graphEnrichmentExecutor structured stderr event includes the error summary text", async () => {
  const thrower = throwingAnalyzer("ts-tree-sitter");
  const { events } = await withCapturedStderr(() =>
    runGraphEnrichmentExecutor(minBundle(), {
      root: "/virtual/root",
      registry: [thrower],
    }),
  );

  expect(events.length >= 1, "should have at least one structured stderr event").toBeTruthy();
  // The note starts with "Analyzer failed" and should include the error message.
  expect(String(events[0].note).includes("deliberate test failure"), `event note should include the original error text; got: ${JSON.stringify(events[0])}`).toBeTruthy();
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

  expect(result.progress_summary.includes("ts-tree-sitter"), `progress_summary should name the failed analyzer; got: ${result.progress_summary}`).toBeTruthy();
});

test("graphEnrichmentExecutor omitted progress_summary stays clean when no analyzers throw", async () => {
  const skipper = skipAnalyzer("fake-skip");
  const { result, events } = await withCapturedStderr(() =>
    runGraphEnrichmentExecutor(minBundle(), {
      root: "/virtual/root",
      registry: [skipper],
    }),
  );

  expect(result.progress_summary, "progress_summary should be unmodified when no analyzer throws").toBe("Graph enrichment omitted; deterministic regex graph retained.");
  expect(events.length, "no analyzer-failed events should be emitted for skip resolutions").toBe(0);
});

test("graphEnrichmentExecutor does NOT emit a structured stderr event for skip resolutions", async () => {
  const skipper = skipAnalyzer("fake-skip");
  const { events } = await withCapturedStderr(() =>
    runGraphEnrichmentExecutor(minBundle(), {
      root: "/virtual/root",
      registry: [skipper],
    }),
  );

  expect(events.length, "no analyzer-failed event should be emitted for skipped analyzers").toBe(0);
});
