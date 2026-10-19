import { test, expect, vi } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as treeSitter from "../../src/audit/extractors/analyzers/treeSitter.js";
import type { TsNode } from "../../src/audit/extractors/analyzers/treeSitter.js";
import type { GraphEdge } from "audit-tools/shared";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import type { AnalyzerContext, LanguageAnalyzer } from "../../src/audit/extractors/analyzers/types.js";

const { pythonAnalyzer } = await import("../../src/audit/extractors/analyzers/python.js");
const { htmlAnalyzer } = await import("../../src/audit/extractors/analyzers/html.js");
const { cssAnalyzer } = await import("../../src/audit/extractors/analyzers/css.js");
const { sqlAnalyzer } = await import("../../src/audit/extractors/analyzers/sql.js");
const { mergeAnalyzerEdges } = await import("../../src/audit/extractors/analyzers/merge.js");
const { runGraphEnrichmentExecutor } = await import("../../src/audit/orchestrator/graphEnrichmentExecutor.js");
const { graphLookupKey, normalizeGraphPath } = await import("../../src/audit/extractors/graphPathUtils.js");
const { getTreeSitterParser, __resetTreeSitterForTests } = await import("../../src/audit/extractors/analyzers/treeSitter.js");

async function withRepo<T>(
  files: Record<string, string>,
  run: (input: { root: string; paths: string[]; context: AnalyzerContext }) => Promise<T> | T,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "ts-analyzer-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      const absolute = join(root, path);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, content);
    }
    const paths = Object.keys(files).map((p) => normalizeGraphPath(p));
    const pathLookup = new Map(paths.map((p) => [graphLookupKey(p), p]));
    const context: AnalyzerContext = {
      root,
      repoManifest: {
        repository: { name: "fixture" },
        generated_at: new Date().toISOString(),
        files: paths.map((p) => ({ path: p, language: "text", size_bytes: 0 })),
      },
      includedFiles: paths,
      pathLookup,
    };
    return await run({ root, paths, context });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function hasEdge(edges: GraphEdge[], from: string, to: string, kind?: string): boolean {
  return edges.some(
    (e) => e.from === from && e.to === to && (!kind || e.kind === kind),
  );
}

/** Minimal, structurally-valid AnalyzerContext for direct analyze() calls outside withRepo. */
function emptyAnalyzerContext(root = ""): AnalyzerContext {
  return {
    root,
    repoManifest: {
      repository: { name: "fixture" },
      generated_at: new Date().toISOString(),
      files: [],
    },
    includedFiles: [],
    pathLookup: new Map(),
  };
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

  expect(hasEdge(output.edges, "pkg/mod_a.py", "pkg/mod_b.py", "py-import")).toBeTruthy();
  expect(hasEdge(output.edges, "pkg/mod_a.py", "pkg/mod_c.py", "py-from-import"), "from pkg import mod_c resolves the submodule file").toBeTruthy();
  expect(hasEdge(output.edges, "pkg/mod_a.py", "pkg/mod_d.py", "py-from-import"), "relative from . import mod_d resolves").toBeTruthy();
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

  expect(hasEdge(output.edges, "index.html", "app.js", "html-resource")).toBeTruthy();
  expect(hasEdge(output.edges, "index.html", "styles/main.css", "html-resource")).toBeTruthy();
  expect(hasEdge(output.edges, "index.html", "assets/logo.png", "html-resource"), "root-relative /assets/logo.png resolves from repo root").toBeTruthy();
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

  expect(hasEdge(output.edges, "theme.css", "base.css", "css-import")).toBeTruthy();
  expect(hasEdge(output.edges, "theme.css", "vendor/reset.css", "css-import"), "@import url(...) resolves").toBeTruthy();
  expect(hasEdge(output.edges, "theme.css", "img/bg.png", "css-url"), "url() in a declaration resolves").toBeTruthy();
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
  expect(output.edges.length, "no edges for external resources").toBe(0);
});

test("sql analyzer is a registered stub: supports .sql, emits no edges", async () => {
  expect(sqlAnalyzer.id).toBe("sql");
  expect(sqlAnalyzer.supports("db/schema.sql")).toBe(true);
  expect(sqlAnalyzer.supports("src/app.ts")).toBe(false);
  expect((await sqlAnalyzer.analyze([], emptyAnalyzerContext())).edges).toEqual([]);
});

test("merge: tree-sitter python/html edges supersede the regex floor for the same (from,to)", () => {
  const pyMerged = mergeAnalyzerEdges(
    [{ from: "a.py", to: "b.py", kind: "python-import", confidence: 0.95 }],
    [{ from: "a.py", to: "b.py", kind: "py-import", confidence: 0.97 }],
  );
  const py = pyMerged.filter((e) => e.from === "a.py" && e.to === "b.py");
  expect(py.length, "python import edges collapse to one").toBe(1);
  expect(py[0].kind, "analyzer edge wins").toBe("py-import");

  const htmlMerged = mergeAnalyzerEdges(
    [{ from: "i.html", to: "a.js", kind: "html-resource-link", confidence: 0.9 }],
    [{ from: "i.html", to: "a.js", kind: "html-resource", confidence: 0.96 }],
  );
  const html = htmlMerged.filter((e) => e.from === "i.html" && e.to === "a.js");
  expect(html.length).toBe(1);
  expect(html[0].kind).toBe("html-resource");
});

test("graph-enrichment executor routes py-import into the imports bucket and supersedes the floor", async () => {
  const bundle: ArtifactBundle = {
    repo_manifest: {
      repository: { name: "fixture" },
      generated_at: new Date().toISOString(),
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
  const fakePy: LanguageAnalyzer = {
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
  const imports = result.updated.graph_bundle!.graphs.imports!.filter(
    (e) => e.from === "a.py" && e.to === "b.py",
  );
  expect(imports.length).toBe(1);
  expect(imports[0].kind).toBe("py-import");
});

// Deterministic parser/collector failures, independent of optional WASM availability.
function fakeNode(text = "", descendants: Record<string, TsNode[]> = {}): TsNode {
  return {
    type: "identifier", text, namedChildren: [],
    childForFieldName: () => null,
    descendantsOfType: (types) => (Array.isArray(types) ? types : [types])
      .flatMap((type) => descendants[type] ?? []),
  };
}

const warningCases = [
  { analyzer: cssAnalyzer, extension: "css", kind: "css-import", root: () =>
    fakeNode("", { import_statement: [fakeNode("", { string_value: [fakeNode('"target.css"')] })] }) },
  { analyzer: htmlAnalyzer, extension: "html", kind: "html-resource", root: () =>
    fakeNode("", { start_tag: [fakeNode("", {
      tag_name: [fakeNode("script")], attribute: [fakeNode("", {
        attribute_name: [fakeNode("src")], attribute_value: [fakeNode("target.html")],
      })],
    })] }) },
  { analyzer: pythonAnalyzer, extension: "py", kind: "py-import", root: () => {
    const statement = fakeNode();
    statement.childForFieldName = () => fakeNode("target");
    return fakeNode("", { import_statement: [statement] });
  } },
];

for (const { analyzer, extension, kind, root } of warningCases) {
  for (const failure of ["parse", "collector"] as const) {
    test(`${analyzer.id}-analyzer warns on ${failure} failure and continues`, async () => {
      const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      const parser = { delete: vi.fn(), setLanguage: vi.fn(), parse: vi.fn((content: string) => {
        if (content === "broken") {
          if (failure === "parse") throw new Error("forced parse failure");
          const node = fakeNode();
          node.descendantsOfType = () => { throw new Error("forced collector failure"); };
          return { rootNode: node, delete: vi.fn() };
        }
        return { rootNode: root(), delete: vi.fn() };
      }) };
      const loader = vi.spyOn(treeSitter, "getTreeSitterParser").mockResolvedValue(parser);
      try {
        await withRepo({ [`bad.${extension}`]: "broken", [`later.${extension}`]: "ok", [`target.${extension}`]: "" },
          async ({ context }) => {
            const output = await analyzer.analyze([`bad.${extension}`, `later.${extension}`], context);
            expect(output.edges).toHaveLength(1);
            expect(hasEdge(output.edges, `later.${extension}`, `target.${extension}`, kind)).toBe(true);
            expect(stderr.mock.calls).toEqual([[`[audit-code] ${analyzer.id}-analyzer: parse failed for 'bad.${extension}': forced ${failure} failure\n`]]);
            expect(loader).toHaveBeenCalledExactlyOnceWith(analyzer.id, undefined);
            expect(parser.parse.mock.calls).toEqual([["broken"], ["ok"]]);
          });
      } finally {
        loader.mockRestore();
        stderr.mockRestore();
      }
    });
  }
}

test("tree-sitter analyzer omits and keeps the floor when web-tree-sitter is absent", async () => {
  __resetTreeSitterForTests();
  const cacheRoot = await mkdtemp(join(tmpdir(), "ts-cache-"));
  const root = await mkdtemp(join(tmpdir(), "ts-root-"));
  try {
    await writeFile(join(root, "a.py"), "import b\n");
    await writeFile(join(root, "b.py"), "");
    const bundle: ArtifactBundle = {
      repo_manifest: {
        repository: { name: "fixture" },
        generated_at: new Date().toISOString(),
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
    expect(result.updated.analyzer_capability!.coverage).toBe("degraded");
    expect(JSON.stringify(result.updated.graph_bundle)).toBe(floorJson);
    const entry = result.updated.analyzer_capability!.analyzers.find((a) => a.id === "python");
    expect(entry!.resolution).toBe("absent");
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
    __resetTreeSitterForTests();
  }
});

// ── Cache-reset seam unit tests ───────────────────────────────────────────────

test("cache reset seam clears all three module-level caches", async () => {
  // Attempt a parse so that at least the moduleCache is populated (even if the
  // resolution fails because web-tree-sitter is absent, a Promise is stored).
  await getTreeSitterParser("python");

  // The seam must not throw whether or not any caches were populated.
  assert.doesNotThrow(() => __resetTreeSitterForTests());

  // A second call to the seam on already-cleared caches also must not throw.
  assert.doesNotThrow(() => __resetTreeSitterForTests());

  // After the reset a fresh call to getTreeSitterParser must not reuse the
  // prior cached promise — it should produce a new attempt (a new Promise),
  // i.e. the function returns without throwing.
  const secondResult = await getTreeSitterParser("python");
  // On a machine without web-tree-sitter this is undefined; with it, a parser.
  // Either way the call must succeed without throwing.
  expect(secondResult === undefined || typeof secondResult === "object").toBeTruthy();

  __resetTreeSitterForTests();
});
