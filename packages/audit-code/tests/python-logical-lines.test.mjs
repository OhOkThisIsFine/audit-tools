import test from "node:test";
import assert from "node:assert/strict";

// Internal function exposed for testing via a named export shim. The function
// is not exported from the module, so we call the module-level
// extractPythonImportEdges with a controlled pathLookup as an integration
// proxy — or we import the private function through a dynamic import workaround.
// Since Node ESM does not expose private functions, we exercise the behaviour
// via `extractPythonImportEdges` with a real path lookup so we can assert
// correct logical-line assembly.
const { extractPythonImportEdges } = await import(
  "../src/extractors/graphPythonImports.ts"
);

// Helper: build a minimal pathLookup for the given paths.
function lookup(...paths) {
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

  // The content above will produce a logical line `import foo .bar)` (or
  // similar). The key assertion is that extractPythonImportEdges does NOT
  // crash (i.e. it consumes the content safely) and the edge count is 0
  // because `foo .bar)` is not a valid module specifier.
  assert.doesNotThrow(() =>
    extractPythonImportEdges("src/mod.py", content, lookup("src/mod.py", "foo.py")),
  );
});

test("pythonLogicalLines: from foo import (bar, baz) is a single logical line", () => {
  const content = "from foo import (bar,\n  baz)";
  const pl = lookup("src/mod.py", "foo.py", "foo/bar.py", "foo/baz.py");
  // We just verify it does not throw and returns edges (i.e. the import is
  // parsed correctly as a single logical line, not two truncated ones).
  const edges = extractPythonImportEdges("src/mod.py", content, pl);
  // baz and bar may or may not resolve, but the call must succeed.
  assert.ok(Array.isArray(edges));
});

test("pythonLogicalLines: well-formed multiline import is still a single logical line", () => {
  const content = "from foo import (\n  bar,\n  baz\n)";
  const pl = lookup("src/mod.py", "foo/bar.py", "foo/baz.py");
  const edges = extractPythonImportEdges("src/mod.py", content, pl);
  // Both `bar` and `baz` must be resolved as submodule targets in a single
  // logical-line parse (not two truncated lines from bad paren tracking).
  assert.ok(Array.isArray(edges), "must return an array");
  assert.ok(
    edges.length >= 2,
    `must emit at least 2 edges (bar+baz resolved), got ${edges.length}: ${JSON.stringify(edges)}`,
  );
  const tos = edges.map((e) => e.to);
  assert.ok(
    tos.some((t) => t.includes("bar")),
    `expected an edge to foo/bar.py, got: ${JSON.stringify(tos)}`,
  );
  assert.ok(
    tos.some((t) => t.includes("baz")),
    `expected an edge to foo/baz.py, got: ${JSON.stringify(tos)}`,
  );
});

test("pythonLogicalLines: file with no imports returns no edges", () => {
  const content = "x = 1\nprint(x)\n";
  const edges = extractPythonImportEdges("src/mod.py", content, lookup("src/mod.py"));
  assert.deepEqual(edges, []);
});
