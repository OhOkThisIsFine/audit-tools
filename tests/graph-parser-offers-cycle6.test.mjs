import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { needsInstallDecision, resolveAnalyzerPlan } from "../dist/audit/extractors/analyzers/registry.js";
import { getTreeSitterParser } from "../dist/audit/extractors/analyzers/treeSitter.js";
import { runGraphEnrichmentExecutor } from "../dist/audit/orchestrator/graphEnrichmentExecutor.js";
import { graphEnrichmentUnresolvedAnalyzers } from "../dist/audit/orchestrator/hostInputPause.js";

const source = {
  "app.py": "import helper\n",
  "helper.py": "value = 1\n",
  "index.html": '<link rel="stylesheet" href="site.css">',
  "site.css": '@import "./extra.css";',
  "extra.css": "",
};
const analyzers = { python: "ephemeral", html: "permanent", css: "ephemeral" };

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "audit-graph-parser-offers-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "repo");
  const cacheRoot = join(directory, "cache");
  await mkdir(root);
  await mkdir(cacheRoot);
  for (const [path, content] of Object.entries(source)) {
    await writeFile(join(root, path), content);
  }
  const bundle = {
    repo_manifest: { files: Object.keys(source).map((path) => ({ path })) },
    graph_bundle: { graphs: {} },
  };
  return { root, cacheRoot, bundle };
}

test("cold bare parsers do not pause for an install or enter the install path", async (t) => {
  const { root, cacheRoot, bundle } = await fixture(t);
  const previousCache = process.env.AUDIT_TOOLS_ANALYZER_CACHE;
  process.env.AUDIT_TOOLS_ANALYZER_CACHE = cacheRoot;
  t.after(() => {
    if (previousCache === undefined) delete process.env.AUDIT_TOOLS_ANALYZER_CACHE;
    else process.env.AUDIT_TOOLS_ANALYZER_CACHE = previousCache;
  });
  assert.deepEqual(graphEnrichmentUnresolvedAnalyzers(bundle, { root }), []);
  const result = await runGraphEnrichmentExecutor(bundle, { root, cacheRoot, analyzers });
  const entries = result.updated.analyzer_capability.analyzers
    .filter((entry) => Object.hasOwn(analyzers, entry.id));
  assert.equal(entries.length, 3);
  for (const entry of entries) {
    assert.equal(entry.setting, analyzers[entry.id]);
    assert.equal(entry.resolution, "absent");
    assert.equal(entry.edges_added, 0);
    assert.match(entry.note, /not found in repo or cache; kept regex floor/);
    assert.doesNotMatch(entry.note, /install/i);
  }
  assert.equal(result.updated.graph_bundle, bundle.graph_bundle);
  assert.deepEqual(result.artifacts_written, ["analyzer_capability.json"]);
  assert.deepEqual(await readdir(cacheRoot), []);
});

test("the real decision predicate still offers a cold versioned declaration", () => {
  const entry = {
    id: "synthetic-parser",
    dependency: "@fixture/parser-runtime@1.2.3",
    resolution: "absent",
    setting: "auto",
    supportedCount: 1,
  };
  assert.equal(needsInstallDecision(entry), true);
  assert.equal(needsInstallDecision({ ...entry, dependency: "@fixture/parser-runtime@" }), false);
  assert.equal(needsInstallDecision({ ...entry, setting: "skip" }), false);
  assert.equal(needsInstallDecision({ ...entry, resolution: "cache" }), false);
});

test("bare parser runtime is reused from the repo or cache; skip still wins", async (t) => {
  const parserEntry = fileURLToPath(import.meta.resolve("web-tree-sitter"));
  const manifest = JSON.parse(await readFile(join(dirname(parserEntry), "package.json"), "utf8"));
  assert.equal(manifest.version, "0.25.10");
  assert.equal(manifest.main, undefined);
  assert.equal(manifest.module, undefined);
  assert.equal(manifest.exports["."].import, "./tree-sitter.js");
  assert.equal(manifest.exports["."].require, "./tree-sitter.cjs");
  for (const via of ["repo", "cache"]) {
    await t.test(via, async (t) => {
      const { root, cacheRoot, bundle } = await fixture(t);
      const location = via === "repo" ? root : join(cacheRoot, "web-tree-sitter@fixture");
      const parserPackage = join(location, "node_modules", "web-tree-sitter");
      await cp(dirname(parserEntry), parserPackage, { recursive: true });
      const settings = { ...analyzers, html: "skip" };
      const plan = resolveAnalyzerPlan(root, settings, Object.keys(source), { cacheRoot });
      assert.equal(plan.find(({ id }) => id === "python").resolution, via);
      assert.equal(plan.find(({ id }) => id === "html").resolution, "skip");
      assert.equal(plan.some(needsInstallDecision), false);
      const result = await runGraphEnrichmentExecutor(bundle, { root, cacheRoot, analyzers: settings });
      const entries = Object.fromEntries(result.updated.analyzer_capability.analyzers
        .map((entry) => [entry.id, entry]));
      for (const id of ["python", "css"]) {
        assert.equal(entries[id].resolution, via);
        assert.equal(entries[id].edges_added, 1);
      }
      assert.equal(entries.html.resolution, "skip");
      assert.equal(entries.html.edges_added, 0);
      assert.deepEqual(result.updated.graph_bundle.analyzers_used, ["css", "python"]);
      assert.deepEqual(await readdir(cacheRoot), via === "cache" ? ["web-tree-sitter@fixture"] : []);
    });
  }
});

test("an exports-only selected parser is used instead of the working loader-owned parser", async (t) => {
  const { root } = await fixture(t);
  const parserPackage = join(root, "node_modules", "web-tree-sitter");
  await mkdir(parserPackage, { recursive: true });
  await writeFile(join(parserPackage, "package.json"), JSON.stringify({
    name: "web-tree-sitter",
    exports: { ".": { require: "./fixture.cjs" } },
  }));
  await writeFile(join(parserPackage, "fixture.cjs"), `
    module.exports = {
      Parser: class FixtureParser {
        static async init() {}
        setLanguage() {}
        parse() { return { rootNode: { type: "selected-fixture" } }; }
        delete() {}
      },
      Language: { async load() { return {}; } }
    };
  `);
  const loaderParser = await getTreeSitterParser("python");
  assert.ok(loaderParser);
  try {
    const tree = loaderParser.parse(source["app.py"]);
    try {
      assert.equal(tree.rootNode.type, "module");
    } finally {
      tree.delete();
    }
  } finally {
    loaderParser.delete();
  }
  const localParser = await getTreeSitterParser("python", parserPackage);
  assert.ok(localParser);
  try {
    assert.equal(localParser.parse(source["app.py"]).rootNode.type, "selected-fixture");
  } finally {
    localParser.delete();
  }
});

test("missing or incompatible selected parsers do not borrow the loader runtime", async (t) => {
  const { root, cacheRoot, bundle } = await fixture(t);
  const parserPackage = join(root, "node_modules", "web-tree-sitter");
  assert.equal(await getTreeSitterParser("python", parserPackage), undefined);
  const incompatiblePackage = join(cacheRoot, "web-tree-sitter@fixture", "node_modules", "web-tree-sitter");
  await mkdir(incompatiblePackage, { recursive: true });
  await writeFile(join(incompatiblePackage, "package.json"), JSON.stringify({
    name: "web-tree-sitter",
    exports: "./incompatible.cjs",
  }));
  await writeFile(join(incompatiblePackage, "incompatible.cjs"), "module.exports = { Parser: {} };");
  assert.equal(await getTreeSitterParser("python", incompatiblePackage), undefined);
  const result = await runGraphEnrichmentExecutor(bundle, { root, cacheRoot, analyzers });
  const python = result.updated.analyzer_capability.analyzers.find(({ id }) => id === "python");
  assert.equal(python.resolution, "cache");
  assert.equal(python.edges_added, 0);
  assert.equal(result.updated.graph_bundle, bundle.graph_bundle);
});
