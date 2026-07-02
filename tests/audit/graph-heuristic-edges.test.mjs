import { test, expect } from "vitest";
import { buildGraphBundle } from "../../src/audit/extractors/graph.ts";

function manifest(paths) {
  return {
    files: paths.map((path) => ({
      path,
      size_bytes: 256,
      language: "typescript",
      excluded: false,
    })),
  };
}

// ── heuristic container edges land in heuristics, not imports ─────────────────

test("heuristic container edges land in heuristics graph, not imports", () => {
  // A file two-or-more directories deep triggers extractHeuristicContainerEdges.
  const m = manifest(["src/utils/helper.ts", "src/utils/other.ts"]);
  const bundle = buildGraphBundle(m, undefined, { fileContents: {} });
  const graphs = bundle.graphs ?? {};

  // At least one heuristic edge should be present (container heuristic)
  expect(Array.isArray(graphs.heuristics), "graphs.heuristics should be an array").toBeTruthy();
  expect(graphs.heuristics.length > 0, "graphs.heuristics should contain at least one edge for deeply-nested paths").toBeTruthy();

  // No edge with confidence < 1 should bleed into imports
  const imports = graphs.imports ?? [];
  const leakedHeuristics = imports.filter(
    (e) => typeof e.confidence === "number" && e.confidence < 1,
  );
  expect(leakedHeuristics.length, "no heuristic-confidence edges should appear in graphs.imports").toBe(0);
});

test("all edges in heuristics graph have confidence < 1", () => {
  const m = manifest(["src/utils/helper.ts"]);
  const bundle = buildGraphBundle(m, undefined, { fileContents: {} });
  const graphs = bundle.graphs ?? {};
  const heuristics = graphs.heuristics ?? [];

  for (const edge of heuristics) {
    expect(typeof edge.confidence === "number" && edge.confidence < 1, `heuristic edge from=${edge.from} to=${edge.to} should have confidence < 1, got ${edge.confidence}`).toBeTruthy();
  }
});

// ── auth-session heuristic edges land in heuristics, not imports ──────────────

test("auth-session heuristic edges land in heuristics graph, not imports", () => {
  // One auth file and one session file triggers extractHeuristicAuthSessionEdges.
  const paths = ["src/auth/middleware.ts", "src/session/store.ts"];
  const m = manifest(paths);
  const bundle = buildGraphBundle(m, undefined, { fileContents: {} });
  const graphs = bundle.graphs ?? {};

  expect(Array.isArray(graphs.heuristics), "graphs.heuristics should be an array").toBeTruthy();
  const authSessionEdge = (graphs.heuristics ?? []).find(
    (e) =>
      e.from === "src/auth/middleware.ts" && e.to === "src/session/store.ts",
  );
  expect(authSessionEdge !== undefined, "graphs.heuristics should contain an edge between the auth file and the session file").toBeTruthy();

  // That edge should not appear in imports
  const imports = graphs.imports ?? [];
  const crossEdgeInImports = imports.find(
    (e) =>
      e.from === "src/auth/middleware.ts" && e.to === "src/session/store.ts",
  );
  expect(crossEdgeInImports, "auth-session edge should not appear in graphs.imports").toBe(undefined);
});

test("auth-session heuristic edges are absent from imports even with file content present", () => {
  // Provide empty file content to trigger the content-edge path as well; the
  // heuristic edges should still not appear in imports.
  const paths = ["src/auth/handler.ts", "src/session/manager.ts"];
  const m = manifest(paths);
  const fileContents = {
    "src/auth/handler.ts": "export function handle() {}",
    "src/session/manager.ts": "export function manage() {}",
  };
  const bundle = buildGraphBundle(m, undefined, { fileContents });
  const graphs = bundle.graphs ?? {};

  const imports = graphs.imports ?? [];
  const leakedEdge = imports.find(
    (e) =>
      (e.from === "src/auth/handler.ts" &&
        e.to === "src/session/manager.ts") ||
      (e.from === "src/session/manager.ts" &&
        e.to === "src/auth/handler.ts"),
  );
  expect(leakedEdge, "auth-session heuristic edge must not bleed into imports even when file content is present").toBe(undefined);
});

// ── extractHeuristicContainerEdges: Windows backslash path normalization ───────

test("extractHeuristicContainerEdges produces a container edge for a backslash-separated path", () => {
  // On Windows the manifest may store paths with backslashes. Without
  // normalizeGraphPath the split produces a single element and the function
  // silently returns []. After the fix the path is normalized to forward
  // slashes before splitting, so the container edge is emitted correctly.
  const m = manifest(["src\\utils\\helpers.ts"]);
  const bundle = buildGraphBundle(m, undefined, { fileContents: {} });
  const heuristics = bundle.graphs?.heuristics ?? [];

  const containerEdge = heuristics.find(
    (e) =>
      e.from === "src/utils/helpers.ts" && e.to === "src/utils",
  );
  expect(containerEdge !== undefined, "should produce a heuristic container edge with normalized from/to paths for a backslash-separated input").toBeTruthy();
});

test("extractHeuristicContainerEdges continues to work for a forward-slash path", () => {
  // Baseline: forward-slash paths must still produce the same container edge
  // they always have (regression guard).
  const m = manifest(["src/utils/helpers.ts"]);
  const bundle = buildGraphBundle(m, undefined, { fileContents: {} });
  const heuristics = bundle.graphs?.heuristics ?? [];

  const containerEdge = heuristics.find(
    (e) =>
      e.from === "src/utils/helpers.ts" && e.to === "src/utils",
  );
  expect(containerEdge !== undefined, "forward-slash path should continue to produce a heuristic container edge").toBeTruthy();
});
