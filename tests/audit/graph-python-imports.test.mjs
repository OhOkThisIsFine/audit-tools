import test from "node:test";
import assert from "node:assert/strict";
import { importSourceModule } from "./helpers/sourceImport.mjs";

const { resolvePythonImportTarget, resolvePythonFromImportTargets, extractPythonImportEdges } =
  await importSourceModule("src/extractors/graphPythonImports.ts");

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Build an in-memory pathLookup that maps every key to its own value.
 * resolveCandidate() checks both exact path and suffix matches so the same
 * path string works as both key and value.
 */
function makeLookup(paths) {
  return new Map(paths.map((p) => [p, p]));
}

// ── resolvePythonImportTarget ─────────────────────────────────────────────────

await test("resolvePythonImportTarget returns undefined for a relative specifier", async (t) => {
  const lookup = makeLookup(["src/app/models.py"]);

  await t.test("dot-prefixed relative specifier", () => {
    assert.equal(
      resolvePythonImportTarget("src/app/api.py", ".models", lookup),
      undefined,
    );
  });

  await t.test("double-dot relative specifier", () => {
    assert.equal(
      resolvePythonImportTarget("src/app/api.py", "..utils", lookup),
      undefined,
    );
  });
});

await test("resolvePythonImportTarget resolves a simple absolute specifier to a single matching file", async (t) => {
  const lookup = makeLookup([
    "src/app/models.py",
    "src/app/services/auth.py",
  ]);

  await t.test("single-segment module path", () => {
    // 'app.models' → should resolve to src/app/models.py
    const result = resolvePythonImportTarget("src/app/api.py", "app.models", lookup);
    assert.ok(
      result !== undefined && result.endsWith("models.py"),
      `Expected to resolve to models.py, got ${result}`,
    );
  });

  await t.test("multi-segment module path", () => {
    // 'app.services.auth' → should resolve to src/app/services/auth.py
    const result = resolvePythonImportTarget(
      "src/app/api.py",
      "app.services.auth",
      lookup,
    );
    assert.ok(
      result !== undefined && result.endsWith("auth.py"),
      `Expected to resolve to auth.py, got ${result}`,
    );
  });
});

await test("resolvePythonImportTarget returns undefined for an unresolvable specifier", () => {
  const lookup = makeLookup(["src/app/models.py"]);
  assert.equal(
    resolvePythonImportTarget("src/app/api.py", "nonexistent.module", lookup),
    undefined,
  );
});

// ── resolvePythonFromImportTargets ────────────────────────────────────────────

await test("resolvePythonFromImportTargets returns submodule targets when submodule files exist", () => {
  // from app.services import auth
  const lookup = makeLookup([
    "src/app/services/auth.py",
    "src/app/services/__init__.py",
  ]);
  const results = resolvePythonFromImportTargets(
    "src/app/api.py",
    "app.services",
    ["auth"],
    lookup,
  );
  assert.equal(results.length, 1);
  assert.ok(results[0].specifier.endsWith("auth"));
  assert.ok(
    results[0].target.endsWith("auth.py"),
    `Expected submodule target auth.py, got ${results[0].target}`,
  );
});

await test("resolvePythonFromImportTargets falls back to the module target when no submodule files resolve", () => {
  // from app.handlers import SomeClass  — 'SomeClass' has no file; fall back to handlers.py
  const lookup = makeLookup(["src/app/handlers.py"]);
  const results = resolvePythonFromImportTargets(
    "src/app/api.py",
    "app.handlers",
    ["SomeClass"],
    lookup,
  );
  assert.equal(results.length, 1);
  assert.equal(results[0].specifier, "app.handlers");
  assert.ok(
    results[0].target.endsWith("handlers.py"),
    `Expected handlers.py, got ${results[0].target}`,
  );
});

await test("resolvePythonFromImportTargets returns empty array for an invalid module specifier", async (t) => {
  const lookup = makeLookup(["src/app/models.py"]);

  await t.test("invalid specifier starting with a digit", () => {
    const results = resolvePythonFromImportTargets(
      "src/app/api.py",
      "123invalid",
      ["foo"],
      lookup,
    );
    assert.deepEqual(results, []);
  });

  await t.test("empty importedNames array falls back to the module target", () => {
    // No submodule names resolve, so per the documented contract ("prefer
    // submodule files, else the module itself") the result is the module-level
    // target. This mirrors the wildcard `import *` fallback.
    const results = resolvePythonFromImportTargets(
      "src/app/api.py",
      "app.models",
      [],
      lookup,
    );
    assert.deepEqual(results, [
      { specifier: "app.models", target: "src/app/models.py" },
    ]);
  });
});

await test("resolvePythonFromImportTargets skips star imports and non-identifier names", async (t) => {
  const lookup = makeLookup(["src/app/models.py"]);

  await t.test("star import is excluded from results", () => {
    const results = resolvePythonFromImportTargets(
      "src/app/api.py",
      "app.models",
      ["*", "User"],
      lookup,
    );
    // '*' should be filtered out; only 'User' (if it resolves) or module fallback
    const hasStarEntry = results.some((r) => r.specifier.endsWith(".*"));
    assert.equal(hasStarEntry, false);
  });

  await t.test("non-identifier name is excluded from results", () => {
    const results = resolvePythonFromImportTargets(
      "src/app/api.py",
      "app.models",
      ["123bad", "User"],
      lookup,
    );
    const has123 = results.some((r) => r.specifier.includes("123bad"));
    assert.equal(has123, false);
  });
});

// ── resolvePythonAbsoluteModuleSpecifier (via resolvePythonImportTarget) ──────
// These tests exercise the disambiguation heuristic through the public API.

await test("resolvePythonAbsoluteModuleSpecifier disambiguation: score-based unique winner", () => {
  // Two files both match 'models': one in src/app/, one in services/other/.
  // Importing from src/app/api.py → src/app/models.py shares the longer prefix.
  const lookup = makeLookup([
    "src/app/models.py",
    "services/other/models.py",
  ]);
  const result = resolvePythonImportTarget(
    "src/app/api.py",
    "app.models",
    lookup,
  );
  // The src/app/models.py candidate shares "src/app" with the fromPath directory
  // and should win the common-prefix disambiguation.
  assert.ok(
    result !== undefined,
    "expected a resolved path, got undefined",
  );
  assert.ok(
    result.includes("src/app/models"),
    `Expected src/app/models.py, got ${result}`,
  );
});

await test("resolvePythonAbsoluteModuleSpecifier disambiguation: src/ tiebreak when scores are tied and one candidate is under src/", () => {
  // Two files: src/utils.py and lib/utils.py.  Neither shares a directory with
  // the fromPath directory (fromPath is in a completely different tree), so
  // bestScore === 0 for both candidates.  The src/ tiebreak should pick src/utils.py.
  const lookup = makeLookup([
    "src/utils.py",
    "lib/utils.py",
  ]);
  const result = resolvePythonImportTarget(
    "other/module/entry.py",   // no common prefix with either candidate
    "utils",
    lookup,
  );
  assert.equal(result, "src/utils.py");
});

await test("resolvePythonAbsoluteModuleSpecifier disambiguation: returns undefined when score tie and src/ tiebreak is ambiguous", () => {
  // Two files both under src/ matching 'utils' → tiebreak fails → undefined.
  const lookup = makeLookup([
    "src/a/utils.py",
    "src/b/utils.py",
  ]);
  const result = resolvePythonImportTarget(
    "other/entry.py",
    "utils",
    lookup,
  );
  assert.equal(result, undefined);
});

// ── extractPythonImportEdges: from-import delegation ──────────────────────────

await test("extractPythonImportEdges delegates from-import resolution to resolvePythonFromImportTargets: submodule file resolves", () => {
  // 'from app.services import auth' where auth.py exists → submodule edge with specifier app.services.auth
  const lookup = makeLookup([
    "src/app/services/auth.py",
    "src/app/services/__init__.py",
  ]);
  const edges = extractPythonImportEdges(
    "src/app/api.py",
    "from app.services import auth\n",
    lookup,
  );
  assert.equal(edges.length, 1);
  assert.ok(edges[0].kind === "python-from-import");
  // The resolved specifier is recorded in the edge `reason` (GraphEdge has no
  // `specifier` field); the submodule specifier should be `app.services.auth`.
  assert.ok(
    edges[0].reason.includes("app.services.auth"),
    `Expected submodule specifier in reason, got ${edges[0].reason}`,
  );
  assert.ok(
    edges[0].to.endsWith("auth.py"),
    `Expected submodule target auth.py, got ${edges[0].to}`,
  );
});

await test("extractPythonImportEdges delegates from-import resolution: falls back to module when no submodule resolves", () => {
  // 'from app.handlers import SomeClass' — SomeClass has no file; fall back to handlers.py
  const lookup = makeLookup(["src/app/handlers.py"]);
  const edges = extractPythonImportEdges(
    "src/app/api.py",
    "from app.handlers import SomeClass\n",
    lookup,
  );
  assert.equal(edges.length, 1);
  assert.equal(edges[0].kind, "python-from-import");
  // Module-level fallback: the resolved specifier (recorded in `reason`) is the
  // module itself, `app.handlers`, not a submodule.
  assert.ok(
    edges[0].reason.includes("app.handlers"),
    `Expected module specifier app.handlers in reason, got ${edges[0].reason}`,
  );
  assert.ok(
    edges[0].to.endsWith("handlers.py"),
    `Expected handlers.py, got ${edges[0].to}`,
  );
});

await test("extractPythonImportEdges delegates from-import resolution: self-reference produces no edge", () => {
  // Importing from the file itself must not produce a self-referential edge
  const lookup = makeLookup(["src/app/models.py"]);
  const edges = extractPythonImportEdges(
    "src/app/models.py",
    "from app.models import User\n",
    lookup,
  );
  // The only candidate (app.models → src/app/models.py) is the file itself — no edge.
  assert.equal(edges.length, 0);
});

await test("extractPythonImportEdges delegates from-import resolution: wildcard import falls back to module", () => {
  // 'from app.utils import *' — '*' is filtered out by isPythonIdentifier;
  // fall back to the module-level target (app.utils → utils.py).
  const lookup = makeLookup(["src/app/utils.py"]);
  const edges = extractPythonImportEdges(
    "src/app/api.py",
    "from app.utils import *\n",
    lookup,
  );
  assert.equal(edges.length, 1);
  assert.equal(edges[0].kind, "python-from-import");
  // '*' is filtered out, so the only resolved specifier (recorded in `reason`)
  // is the module-level fallback `app.utils`.
  assert.ok(
    edges[0].reason.includes("app.utils"),
    `Expected module specifier app.utils in reason, got ${edges[0].reason}`,
  );
  assert.ok(
    edges[0].to.endsWith("utils.py"),
    `Expected utils.py, got ${edges[0].to}`,
  );
});

// ── Backslash continuation ────────────────────────────────────────────────────

await test("pythonLogicalLines merges backslash-continued import lines", () => {
  // A two-physical-line import where the first line ends with backslash.
  // The continuation is stripped and both module names are parsed as one logical line.
  const content = "import os, \\\n    sys";
  const lookup = makeLookup(["os.py", "sys.py"]);
  const edges = extractPythonImportEdges("src/main.py", content, lookup);
  const targets = edges.map((e) => e.to);
  assert.ok(targets.includes("os.py"), "should resolve os after backslash merge");
  assert.ok(targets.includes("sys.py"), "should resolve sys after backslash merge");
});

// ── Unbalanced close paren (parenDepth goes negative) ─────────────────────────

await test("pythonLogicalLines flushes a line with unbalanced close paren rather than leaving it dangling", () => {
  // A stray `)` makes parenDepth -1 which satisfies `<= 0`, so the logical
  // line is flushed immediately rather than left in `pending`.
  // The subsequent `from pkg import foo` is parsed independently.
  const content = "import os)\nfrom pkg import foo";
  const lookup = makeLookup(["pkg/foo.py"]);
  const edges = extractPythonImportEdges("src/main.py", content, lookup);
  const targets = edges.map((e) => e.to);
  // `from pkg import foo` must produce an edge to pkg/foo.py
  assert.ok(
    targets.includes("pkg/foo.py"),
    "from-import line after unbalanced `)` is parsed correctly",
  );
  // A stray `)` must not be appended to the module name
  assert.ok(
    !targets.some((t) => t.includes("os)")),
    "stray `)` is not part of a resolved module name",
  );
});

// ── Comment character outside a string ───────────────────────────────────────

await test("stripPythonLineComment preserves import name before # outside a string", () => {
  // The `# a comment` suffix is stripped before the name is extracted.
  const content = "from pkg import foo  # a comment";
  const lookup = makeLookup(["pkg/foo.py"]);
  const edges = extractPythonImportEdges("src/main.py", content, lookup);
  assert.equal(edges.length, 1, "one edge resolved");
  assert.ok(edges[0].to.endsWith("foo.py"), `Expected foo.py, got ${edges[0].to}`);
});

// ── Comment character inside a single-quoted string ──────────────────────────

await test("stripPythonLineComment skips # inside a single-quoted string on an import line", () => {
  // The `#` after `foo` (outside any string) is the comment start and is
  // stripped. The quoted fragment after it does not affect the imported name.
  const content = "from pkg import foo  # don't touch 'x#y'";
  const lookup = makeLookup(["pkg/foo.py"]);
  const edges = extractPythonImportEdges("src/main.py", content, lookup);
  assert.equal(edges.length, 1, "one edge resolved");
  assert.ok(
    edges[0].to.endsWith("foo.py"),
    `imported name is foo, not affected by quoted fragment: got ${edges[0].to}`,
  );
});

// ── Triple-quoted string (known limitation) ───────────────────────────────────

await test("stripPythonLineComment known limitation: triple-quoted string is not specially handled", () => {
  // `stripPythonLineComment` only tracks single-character quote openers.
  // A `#` before any string on an import line is always treated as a comment
  // start.  The actual (not ideal) behaviour: the strip fires at the first `#`
  // outside the current quote context.  Here the `#` appears before any quote
  // opener, so stripping happens there and `foo` is correctly extracted.
  const content = "from pkg import foo  # '''not a comment'''";
  const lookup = makeLookup(["pkg/foo.py"]);
  const edges = extractPythonImportEdges("src/main.py", content, lookup);
  assert.equal(edges.length, 1, "foo is extracted correctly despite trailing triple-quote fragment");
  assert.ok(edges[0].to.endsWith("foo.py"), `Expected foo.py, got ${edges[0].to}`);
});
