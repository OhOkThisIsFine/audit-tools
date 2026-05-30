import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const { pythonAnalyzer } = await import("../dist/extractors/analyzers/python.js");
const { htmlAnalyzer } = await import("../dist/extractors/analyzers/html.js");
const { cssAnalyzer } = await import("../dist/extractors/analyzers/css.js");
const { sqlAnalyzer } = await import("../dist/extractors/analyzers/sql.js");
const { mergeAnalyzerEdges } = await import("../dist/extractors/analyzers/merge.js");
const { runGraphEnrichmentExecutor } = await import(
  "../dist/orchestrator/graphEnrichmentExecutor.js"
);
const { graphLookupKey, normalizeGraphPath } = await import(
  "../dist/extractors/graphPathUtils.js"
);

async function withRepo(files, run) {
  const root = await mkdtemp(join(tmpdir(), "ts-analyzer-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      const absolute = join(root, path);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, content);
    }
    const paths = Object.keys(files).map((p) => normalizeGraphPath(p));
    const pathLookup = new Map(paths.map((p) => [graphLookupKey(p), p]));
    const context = {
      root,
      repoManifest: { files: paths.map((p) => ({ path: p })) },
      includedFiles: paths,
      pathLookup,
    };
    return await run({ root, paths, context });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function hasEdge(edges, from, to, kind) {
  return edges.some(
    (e) => e.from === from && e.to === to && (!kind || e.kind === kind),
  );
}

test("python analyzer resolves absolute, from-submodule, and relative imports", async () => {
  const output = await withRepo(
    {
      "pkg/__init__.py": "",
      "pkg/mod_a.py":
        "import pkg.mod_b\nfrom pkg import mod_c\nfrom . import mod_d\n",
      "pkg/mod_b.py": "",
      "pkg/mod_c.py": "",
      "pkg/mod_d.py": "",
    },
    ({ paths, context }) =>
      pythonAnalyzer.analyze(
        paths.filter((p) => p.endsWith(".py")),
        context,
      ),
  );

  assert.ok(hasEdge(output.edges, "pkg/mod_a.py", "pkg/mod_b.py", "py-import"));
  assert.ok(
    hasEdge(output.edges, "pkg/mod_a.py", "pkg/mod_c.py", "py-from-import"),
    "from pkg import mod_c resolves the submodule file",
  );
  assert.ok(
    hasEdge(output.edges, "pkg/mod_a.py", "pkg/mod_d.py", "py-from-import"),
    "relative from . import mod_d resolves",
  );
});

test("html analyzer extracts script/link/img resource references", async () => {
  const output = await withRepo(
    {
      "index.html":
        '<script src="app.js"></script><link href="styles/main.css" rel="stylesheet"><img src="/assets/logo.png">',
      "app.js": "",
      "styles/main.css": "",
      "assets/logo.png": "",
    },
    ({ paths, context }) =>
      htmlAnalyzer.analyze(
        paths.filter((p) => p.endsWith(".html")),
        context,
      ),
  );

  assert.ok(hasEdge(output.edges, "index.html", "app.js", "html-resource"));
  assert.ok(
    hasEdge(output.edges, "index.html", "styles/main.css", "html-resource"),
  );
  assert.ok(
    hasEdge(output.edges, "index.html", "assets/logo.png", "html-resource"),
    "root-relative /assets/logo.png resolves from repo root",
  );
});

test("css analyzer extracts @import and url() references", async () => {
  const output = await withRepo(
    {
      "theme.css":
        '@import "base.css";\n@import url("vendor/reset.css");\n.x { background: url(img/bg.png); }',
      "base.css": "",
      "vendor/reset.css": "",
      "img/bg.png": "",
    },
    ({ paths, context }) =>
      cssAnalyzer.analyze(
        paths.filter((p) => p.endsWith(".css")),
        context,
      ),
  );

  assert.ok(hasEdge(output.edges, "theme.css", "base.css", "css-import"));
  assert.ok(
    hasEdge(output.edges, "theme.css", "vendor/reset.css", "css-import"),
    "@import url(...) resolves",
  );
  assert.ok(
    hasEdge(output.edges, "theme.css", "img/bg.png", "css-url"),
    "url() in a declaration resolves",
  );
});

test("css analyzer skips external and protocol-relative URLs", async () => {
  const output = await withRepo(
    {
      "theme.css":
        '@import url("https://cdn.example.com/x.css");\n.x { background: url(//cdn/y.png); }\n.y { background: url(data:image/png;base64,AAAA); }',
    },
    ({ paths, context }) =>
      cssAnalyzer.analyze(
        paths.filter((p) => p.endsWith(".css")),
        context,
      ),
  );
  assert.equal(output.edges.length, 0, "no edges for external resources");
});

test("sql analyzer is a registered stub: supports .sql, emits no edges", () => {
  assert.equal(sqlAnalyzer.id, "sql");
  assert.equal(sqlAnalyzer.supports("db/schema.sql"), true);
  assert.equal(sqlAnalyzer.supports("src/app.ts"), false);
  assert.deepEqual(sqlAnalyzer.analyze().edges, []);
});

test("merge: tree-sitter python/html edges supersede the regex floor for the same (from,to)", () => {
  const pyMerged = mergeAnalyzerEdges(
    [{ from: "a.py", to: "b.py", kind: "python-import", confidence: 0.95 }],
    [{ from: "a.py", to: "b.py", kind: "py-import", confidence: 0.97 }],
  );
  const py = pyMerged.filter((e) => e.from === "a.py" && e.to === "b.py");
  assert.equal(py.length, 1, "python import edges collapse to one");
  assert.equal(py[0].kind, "py-import", "analyzer edge wins");

  const htmlMerged = mergeAnalyzerEdges(
    [{ from: "i.html", to: "a.js", kind: "html-resource-link", confidence: 0.9 }],
    [{ from: "i.html", to: "a.js", kind: "html-resource", confidence: 0.96 }],
  );
  const html = htmlMerged.filter((e) => e.from === "i.html" && e.to === "a.js");
  assert.equal(html.length, 1);
  assert.equal(html[0].kind, "html-resource");
});

test("graph-enrichment executor routes py-import into the imports bucket and supersedes the floor", async () => {
  const bundle = {
    repo_manifest: {
      files: [
        { path: "a.py", size_bytes: 16, language: "python", excluded: false },
        { path: "b.py", size_bytes: 16, language: "python", excluded: false },
      ],
    },
    file_disposition: { files: [] },
    graph_bundle: {
      graphs: {
        imports: [
          { from: "a.py", to: "b.py", kind: "python-import", confidence: 0.95, direction: "directed" },
        ],
        calls: [],
        references: [],
        routes: [],
      },
    },
  };
  // A dependency-free fake analyzer (always resolvable) emitting an analyzer edge.
  const fakePy = {
    id: "python",
    supports: (f) => f.endsWith(".py"),
    analyze: () => ({
      edges: [{ from: "a.py", to: "b.py", kind: "py-import", confidence: 0.97, direction: "directed" }],
    }),
  };
  const result = await runGraphEnrichmentExecutor(bundle, {
    root: "/virtual/root",
    registry: [fakePy],
  });
  const imports = result.updated.graph_bundle.graphs.imports.filter(
    (e) => e.from === "a.py" && e.to === "b.py",
  );
  assert.equal(imports.length, 1);
  assert.equal(imports[0].kind, "py-import");
});

test("tree-sitter analyzer omits and keeps the floor when web-tree-sitter is absent", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "ts-cache-"));
  const root = await mkdtemp(join(tmpdir(), "ts-root-"));
  try {
    await writeFile(join(root, "a.py"), "import b\n");
    await writeFile(join(root, "b.py"), "");
    const bundle = {
      repo_manifest: {
        files: [
          { path: "a.py", size_bytes: 8, language: "python", excluded: false },
          { path: "b.py", size_bytes: 0, language: "python", excluded: false },
        ],
      },
      file_disposition: { files: [] },
      graph_bundle: { graphs: { imports: [], calls: [], references: [], routes: [] } },
    };
    const floorJson = JSON.stringify(bundle.graph_bundle);
    const result = await runGraphEnrichmentExecutor(bundle, {
      root,
      registry: [pythonAnalyzer],
      cacheRoot,
      analyzers: { python: "auto" },
    });
    assert.equal(result.updated.analyzer_capability.status, "omitted");
    assert.equal(JSON.stringify(result.updated.graph_bundle), floorJson);
    const entry = result.updated.analyzer_capability.analyzers.find((a) => a.id === "python");
    assert.equal(entry.resolution, "absent");
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
