import { test, expect } from "vitest";

// Internal function exposed for testing via a named export shim. The function
// is not exported from the module, so we call the module-level
// extractPythonImportEdges with a controlled pathLookup as an integration
// proxy — or we import the private function through a dynamic import workaround.
// Since Node ESM does not expose private functions, we exercise the behaviour
// via `extractPythonImportEdges` with a real path lookup so we can assert
// correct logical-line assembly.
const { extractPythonImportEdges } = await import("../../src/audit/extractors/graphPythonImports.js");

// Helper: build a minimal pathLookup for the given paths.
function lookup(...paths: string[]): Map<string, string> {
  return new Map(paths.map((p) => [p.toLowerCase(), p]));
}

test("pythonLogicalLines: does not flush on parenDepth underflow from mismatched closing paren in continuation", () => {
  // A backslash-continued import line whose continuation body contains a bare )
  // with no matching (. Before the fix, parenDepth would go negative, which
  // satisfies `parenDepth <= 0` prematurely and emits a truncated logical line.
  // With clamping, the depth stays at 0 and no flush fires until the real end.
  const content = [
    "import foo\\",
    "  .bar)",  // bare ) — mismatched; depth must be clamped to 0, not go to -1
  ].join("\n");

  // The content above assembles into the logical line `import foo .bar)`, which
  // is not a valid module specifier — so the RESOLVED EDGE SET is the assertion,
  // not merely that the call survives. `doesNotThrow` alone stayed green under
  // the very regression this test names: an early flush on negative parenDepth
  // emits a truncated logical line, which throws nothing and simply produces a
  // spurious edge. Pinning `length === 0` is what makes that reintroduction red.
  const edges = extractPythonImportEdges(
    "src/mod.py",
    content,
    lookup("src/mod.py", "foo.py"),
  );
  expect(
    edges.length,
    `a truncated logical line must resolve to nothing, got: ${JSON.stringify(edges)}`,
  ).toBe(0);
});

test("pythonLogicalLines: from foo import (bar, baz) is a single logical line", () => {
  const content = "from foo import (bar,\n  baz)";
  const pl = lookup("src/mod.py", "foo.py", "foo/bar.py", "foo/baz.py");
  const edges = extractPythonImportEdges("src/mod.py", content, pl);
  // The SAME assertions the well-formed-multiline sibling below makes. The
  // "bar and baz may or may not resolve" hedge that used to sit here conceded
  // exactly the outcome this test exists to pin: once logical-line assembly is
  // correct, a parenthesized import resolves identically whether it is written
  // on one line or several, so anything weaker cannot see the regression.
  expect(
    edges.length >= 2,
    `must emit at least 2 edges (bar+baz resolved), got ${edges.length}: ${JSON.stringify(edges)}`,
  ).toBeTruthy();
  const tos = edges.map((e) => e.to);
  expect(
    tos.some((t) => t.includes("bar")),
    `expected an edge to foo/bar.py, got: ${JSON.stringify(tos)}`,
  ).toBeTruthy();
  expect(
    tos.some((t) => t.includes("baz")),
    `expected an edge to foo/baz.py, got: ${JSON.stringify(tos)}`,
  ).toBeTruthy();
});

test("pythonLogicalLines: well-formed multiline import is still a single logical line", () => {
  const content = "from foo import (\n  bar,\n  baz\n)";
  const pl = lookup("src/mod.py", "foo/bar.py", "foo/baz.py");
  const edges = extractPythonImportEdges("src/mod.py", content, pl);
  // Both `bar` and `baz` must be resolved as submodule targets in a single
  // logical-line parse (not two truncated lines from bad paren tracking).
  expect(Array.isArray(edges), "must return an array").toBeTruthy();
  expect(edges.length >= 2, `must emit at least 2 edges (bar+baz resolved), got ${edges.length}: ${JSON.stringify(edges)}`).toBeTruthy();
  const tos = edges.map((e) => e.to);
  expect(tos.some((t) => t.includes("bar")), `expected an edge to foo/bar.py, got: ${JSON.stringify(tos)}`).toBeTruthy();
  expect(tos.some((t) => t.includes("baz")), `expected an edge to foo/baz.py, got: ${JSON.stringify(tos)}`).toBeTruthy();
});

test("pythonLogicalLines: file with no imports returns no edges", () => {
  const content = "x = 1\nprint(x)\n";
  const edges = extractPythonImportEdges("src/mod.py", content, lookup("src/mod.py"));
  expect(edges).toEqual([]);
});
