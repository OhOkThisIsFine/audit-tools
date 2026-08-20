import { test, expect } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { RepoManifest } from "../../src/audit/types.js";
import type { GraphBundle, GraphEdge } from "../../src/shared/index.js";
import {
  buildGraphBundle,
  mergeAnalyzerGraphContribution,
  uniqueSortedEdges,
  GRAPH_EDGE_CACHE_KEY_VERSION,
} from "../../src/audit/extractors/graph.js";
import type { GraphEdgeCache } from "../../src/audit/extractors/graph.js";

// C2 incremental graph-build — per-file edge cache.
//
// The cache MUST be transparent: an incremental build (prior cache fed in) is
// byte-identical to a full build. These tests prove (a) equivalence in every
// reuse/invalidation case, and (b) that reuse actually happens (via a doctored
// cache whose sentinel only appears if the cached contribution was used, not
// re-extracted).

function file(
  path: string,
  { hash, size = 256 }: { hash?: string; size?: number } = {},
): RepoManifest["files"][number] {
  return { path, size_bytes: size, language: "typescript", excluded: false, ...(hash ? { hash } : {}) };
}

function manifest(files: RepoManifest["files"]): RepoManifest {
  return {
    repository: { name: "graph-edge-cache-fixture" },
    generated_at: "2026-01-01T00:00:00.000Z",
    files,
  };
}

const A = "src/a.ts";
const B = "src/b.ts";

function baseContents(): Record<string, string> {
  return {
    [A]: "import { b } from './b';\nexport const a = () => b();\n",
    [B]: "export const b = () => 1;\n",
  };
}

function fullBuild(m: RepoManifest, fileContents: Record<string, string>): GraphBundle {
  return buildGraphBundle(m, undefined, { fileContents });
}

function incrementalBuild(
  m: RepoManifest,
  fileContents: Record<string, string>,
  priorEdgeCache: GraphEdgeCache | undefined,
): { bundle: GraphBundle; cache: GraphEdgeCache } {
  const edgeCacheSink: { cache?: GraphEdgeCache } = {};
  const bundle = buildGraphBundle(m, undefined, {
    fileContents,
    priorEdgeCache,
    edgeCacheSink,
  });
  return { bundle, cache: edgeCacheSink.cache! };
}

test("sink-only build is byte-identical to a plain full build; cache covers all in-scope files", () => {
  const m = manifest([file(A, { hash: "ha" }), file(B, { hash: "hb" })]);
  const contents = baseContents();

  const plain = fullBuild(m, contents);
  const { bundle, cache } = incrementalBuild(m, contents, undefined);

  expect(bundle, "sink-collecting build must equal the plain build").toEqual(plain);
  expect(cache, "a cache must be produced into the sink").toBeTruthy();
  expect(Object.keys(cache.entries).sort(), "cache must cover exactly the in-scope files").toEqual([A, B]);
  expect(typeof cache.path_lookup_hash).toBe("string");
});

test("feeding the prior cache back (unchanged) yields a byte-identical bundle", () => {
  const m = manifest([file(A, { hash: "ha" }), file(B, { hash: "hb" })]);
  const contents = baseContents();

  const { cache } = incrementalBuild(m, contents, undefined);
  const plain = fullBuild(m, contents);
  const { bundle } = incrementalBuild(m, contents, cache);

  expect(bundle, "unchanged incremental build must equal the full build").toEqual(plain);
});

test("a cached contribution is REUSED (not re-extracted) when content_key + pathLookup match", () => {
  const m = manifest([file(A, { hash: "ha" }), file(B, { hash: "hb" })]);
  const contents = baseContents();
  const { cache } = incrementalBuild(m, contents, undefined);

  // Doctor B's cached contribution with a sentinel reference edge. If B is reused,
  // the sentinel appears in the output; if re-extracted, it does not.
  const sentinel: GraphEdge = { from: B, to: "SENTINEL-REUSED", kind: "reference", confidence: 1 };
  cache.entries[B].contribution.references.push(sentinel);

  const { bundle } = incrementalBuild(m, contents, cache);
  const refs = bundle.graphs?.references ?? [];
  expect(refs.some((e) => e.to === "SENTINEL-REUSED"), "B's cached (doctored) contribution must be reused verbatim").toBeTruthy();
});

test("a content change re-extracts ONLY the changed file; the rest stay reused", () => {
  const m1 = manifest([file(A, { hash: "ha" }), file(B, { hash: "hb" })]);
  const contents = baseContents();
  const { cache } = incrementalBuild(m1, contents, undefined);

  // Sentinel both entries; A's content_key changes, B's does not.
  cache.entries[A].contribution.references.push({ from: A, to: "SENTINEL-A", kind: "reference", confidence: 1 });
  cache.entries[B].contribution.references.push({ from: B, to: "SENTINEL-B", kind: "reference", confidence: 1 });

  // A edited: new hash → content_key drift → re-extract A (sentinel-A dropped).
  const m2 = manifest([file(A, { hash: "ha2" }), file(B, { hash: "hb" })]);
  const editedContents = { ...contents, [A]: contents[A] + "// edit\n" };

  const { bundle } = incrementalBuild(m2, editedContents, cache);
  const refs = bundle.graphs?.references ?? [];
  expect(!refs.some((e) => e.to === "SENTINEL-A"), "A must be re-extracted (its sentinel gone)").toBeTruthy();
  expect(refs.some((e) => e.to === "SENTINEL-B"), "B must stay reused (its sentinel kept)").toBeTruthy();

  // And the result equals a clean full build of the edited tree.
  const plain = fullBuild(m2, editedContents);
  const cleanRefs = (plain.graphs?.references ?? []).map((e) => e.to);
  expect(!cleanRefs.includes("SENTINEL-A") && !cleanRefs.includes("SENTINEL-B")).toBeTruthy();
});

test("a file WITHOUT a content hash is never reused (size fallback is unsound) — fail-safe re-extract", () => {
  // No `hash` on either file → content_key would degrade to size; the cache must
  // refuse to reuse so an equal-size edit can't be falsely served from cache.
  const m = manifest([file(A), file(B)]);
  const contents = baseContents();
  const { cache } = incrementalBuild(m, contents, undefined);

  // Nothing should have been cached for hash-less files.
  expect(Object.keys(cache.entries), "hash-less files must not be cached").toEqual([]);

  // Even if a doctored entry is fed in, a hash-less file must NOT reuse it.
  const doctored: GraphEdgeCache = {
    path_lookup_hash: cache.path_lookup_hash,
    entries: {
      [B]: {
        content_key: `size:${256}`,
        contribution: { imports: [], calls: [], references: [{ from: B, to: "SENTINEL-STALE", kind: "reference", confidence: 1 }], heuristics: [], routes: [] },
      },
    },
  };
  const { bundle } = incrementalBuild(m, contents, doctored);
  const refs = bundle.graphs?.references ?? [];
  expect(!refs.some((e) => e.to === "SENTINEL-STALE"), "hash-less file must re-extract, never reuse").toBeTruthy();
  expect(bundle, "hash-less build must equal the full build").toEqual(fullBuild(m, contents));
});

// COR-11e067ab / inv-2: content AVAILABILITY is part of the cache key.
//
// `extractPerFileContribution` silently degrades to heuristics + a fallback route
// when a file's content is missing (the no-root structure branch passes no
// fileContents at all; the fs branch omits any file it could not read). Keyed on
// the content hash alone, that degraded contribution was replayed against a later
// build that DID have the content, permanently dropping the file's real edges.
test("inv-2: a content-FREE contribution is never reused by a build that HAS the content", () => {
  const m = manifest([file(A, { hash: "ha" }), file(B, { hash: "hb" })]);
  const contents = baseContents();

  // Build 1: no fileContents at all (the no-root branch), collecting a cache.
  const sink1: { cache?: GraphEdgeCache } = {};
  const degraded = buildGraphBundle(m, undefined, { edgeCacheSink: sink1 });
  expect(degraded.graphs.imports ?? [], "no content → no import edges to cache").toEqual([]);

  // Build 2: same manifest/hashes, real content, fed the degraded cache.
  const { bundle } = incrementalBuild(m, contents, sink1.cache);

  const imports = bundle.graphs?.imports ?? [];
  expect(imports.some((e) => e.from === A && e.to === B), "A→B import edge must come back from real content, not the degraded cache").toBeTruthy();
  expect(bundle, "the content-ful build must equal a clean full build").toEqual(fullBuild(m, contents));
});

test("inv-2: the reverse direction also re-extracts — a content-ful entry is not replayed for a content-free build", () => {
  const m = manifest([file(A, { hash: "ha" }), file(B, { hash: "hb" })]);
  const contents = baseContents();
  const { cache } = incrementalBuild(m, contents, undefined);

  // Sentinel the content-ful entry; a content-FREE build must not pick it up.
  cache.entries[B].contribution.references.push({ from: B, to: "SENTINEL-CONTENTFUL", kind: "reference", confidence: 1 });

  const sink: { cache?: GraphEdgeCache } = {};
  const bundle = buildGraphBundle(m, undefined, { priorEdgeCache: cache, edgeCacheSink: sink });
  const refs = bundle.graphs?.references ?? [];
  expect(!refs.some((e) => e.to === "SENTINEL-CONTENTFUL"), "a contribution built WITH content must not be replayed for a content-free build").toBeTruthy();
  expect(bundle, "the content-free build must equal a clean content-free build").toEqual(buildGraphBundle(m, undefined, {}));
});

test("inv-2: a cache written under an older key format self-invalidates (fail-safe re-extract)", () => {
  const m = manifest([file(A, { hash: "ha" }), file(B, { hash: "hb" })]);
  const contents = baseContents();
  const { cache } = incrementalBuild(m, contents, undefined);

  // The pre-fix format keyed entries on the bare content hash.
  const legacy: GraphEdgeCache = {
    path_lookup_hash: cache.path_lookup_hash,
    entries: {
      [B]: {
        content_key: "hb",
        contribution: { imports: [], calls: [], references: [{ from: B, to: "SENTINEL-LEGACY", kind: "reference", confidence: 1 }], heuristics: [], routes: [] },
      },
    },
  };
  const { bundle } = incrementalBuild(m, contents, legacy);
  const refs = bundle.graphs?.references ?? [];
  expect(!refs.some((e) => e.to === "SENTINEL-LEGACY"), "an entry keyed in the old format must never be replayed").toBeTruthy();
  expect(bundle).toEqual(fullBuild(m, contents));
});

test("inv-2: a structurally invalid cache entry degrades to re-extraction instead of throwing", () => {
  // The cache is read back from a JSON file nothing schema-validates.
  const m = manifest([file(A, { hash: "ha" }), file(B, { hash: "hb" })]);
  const contents = baseContents();
  const { cache } = incrementalBuild(m, contents, undefined);

  const corrupted: GraphEdgeCache = JSON.parse(JSON.stringify(cache));
  // `references` truncated away entirely — spreading it would throw.
  delete (corrupted.entries[B].contribution as { references?: unknown }).references;

  const { bundle } = incrementalBuild(m, contents, corrupted);
  expect(bundle, "a corrupt entry must fall back to a fresh extraction").toEqual(fullBuild(m, contents));
});

// inv-5: the cache stays TRANSPARENT — reuse must not move per-extractor push
// order, so a reused build serializes byte-identically to a fresh one.
test("inv-5: a cache-reusing build is BYTE-identical (JSON) to a fully-fresh build", () => {
  const m = manifest([file(A, { hash: "ha" }), file(B, { hash: "hb" })]);
  const contents = baseContents();

  const { cache } = incrementalBuild(m, contents, undefined);
  const { bundle: reused } = incrementalBuild(m, contents, cache);

  expect(JSON.stringify(reused), "cached reuse must serialize byte-identically").toBe(JSON.stringify(fullBuild(m, contents)));
});

// fail-4: a caller inspecting a PerFileGraphContribution CANNOT tell
// degraded-by-missing-content from degraded-by-cache-reuse — the documented gap.
test("fail-4: a degraded contribution is shape-identical whether it was re-extracted or replayed", () => {
  const m = manifest([file(A, { hash: "ha" }), file(B, { hash: "hb" })]);

  const sink1: { cache?: GraphEdgeCache } = {};
  buildGraphBundle(m, undefined, { edgeCacheSink: sink1 });
  const extracted = sink1.cache!.entries[A].contribution;

  const sink2: { cache?: GraphEdgeCache } = {};
  buildGraphBundle(m, undefined, { priorEdgeCache: sink1.cache, edgeCacheSink: sink2 });
  const replayed = sink2.cache!.entries[A].contribution;

  expect(replayed, "no field distinguishes a replayed degraded contribution from a freshly degraded one").toEqual(extracted);
  expect(extracted.imports, "degraded means: no content-derived edges").toEqual([]);
  expect(extracted.calls).toEqual([]);
  expect(extracted.references).toEqual([]);
  expect(extracted.metrics, "and no node metrics").toBe(undefined);
});

// inv-6: the extractor array-order invariant, edge half.
test("inv-6: uniqueSortedEdges output is independent of input order", () => {
  const edges: GraphEdge[] = [
    { from: "b.ts", to: "c.ts", kind: "esm", confidence: 0.95 },
    { from: "a.ts", to: "c.ts", kind: "esm", confidence: 0.95 },
    { from: "a.ts", to: "b.ts", kind: "esm", confidence: 0.95 },
    // Same SIGNATURE (from/to/kind) as the previous edge but different provenance:
    // the survivor must be picked by content, never by arrival order.
    { from: "a.ts", to: "b.ts", kind: "esm", confidence: 0.72, reason: "weaker" },
    { from: "a.ts", to: "b.ts", kind: "reference" },
    { from: "self.ts", to: "self.ts", kind: "esm" },
  ];
  const expected = JSON.stringify(uniqueSortedEdges(edges));

  expect(JSON.stringify(uniqueSortedEdges([...edges].reverse())), "reversed input").toBe(expected);
  expect(JSON.stringify(uniqueSortedEdges([edges[3], edges[5], edges[0], edges[4], edges[2], edges[1]])), "shuffled input").toBe(expected);
  expect(uniqueSortedEdges(edges).some((e) => e.from === e.to), "self-edges are dropped").toBe(false);
});

// F2: the dedupe survivor must be the STRONGEST edge. Signature-colliding edges
// carry different provenance, and the analyzer merge seam runs through the same
// dedupe — picking by serialization alone made it absorb DOWNWARD, because
// "confidence" sorts first among the serialized keys.
test("inv-6: the dedupe survivor is the strongest edge, never the weakest or the last", () => {
  const weak: GraphEdge = { from: "a.ts", to: "b.ts", kind: "esm", confidence: 0.4, reason: "weak" };
  const strong: GraphEdge = { from: "a.ts", to: "b.ts", kind: "esm", confidence: 0.95, reason: "strong" };

  expect(uniqueSortedEdges([weak, strong]), "strong arrives last").toEqual([strong]);
  expect(uniqueSortedEdges([strong, weak]), "strong arrives first — same survivor").toEqual([strong]);

  // A genuine tie still resolves by content, so the output stays order-free.
  const tieA: GraphEdge = { from: "a.ts", to: "b.ts", kind: "esm", confidence: 0.5, reason: "aaa" };
  const tieB: GraphEdge = { from: "a.ts", to: "b.ts", kind: "esm", confidence: 0.5, reason: "bbb" };
  expect(uniqueSortedEdges([tieA, tieB])).toEqual(uniqueSortedEdges([tieB, tieA]));
});

test("F2: mergeAnalyzerGraphContribution keeps a STRONGER contributed edge over a weaker existing one", () => {
  const existing: GraphEdge = { from: "a.ts", to: "b.ts", kind: "reference", confidence: 0.2, reason: "existing heuristic" };
  const contributed: GraphEdge = { from: "a.ts", to: "b.ts", kind: "reference", confidence: 0.88, reason: "analyzer dataflow" };
  const bundle: GraphBundle = {
    graphs: { imports: [], calls: [], references: [existing], routes: [], heuristics: [] },
  };

  const merged = mergeAnalyzerGraphContribution(bundle, [contributed]);
  expect(merged.graphs.references, "the merge seam must not absorb downward").toEqual([contributed]);

  // And the reverse: a weaker contribution never displaces a stronger incumbent.
  const reverse = mergeAnalyzerGraphContribution(
    { graphs: { imports: [], calls: [], references: [contributed], routes: [], heuristics: [] } },
    [existing],
  );
  expect(reverse.graphs.references).toEqual([contributed]);
});

// F3: entry validation reaches per ELEMENT — that is where the damage lands.
test("inv-2: a cache entry with a null edge element re-extracts instead of crashing the dedupe pass", () => {
  const m = manifest([file(A, { hash: "ha" }), file(B, { hash: "hb" })]);
  const contents = baseContents();
  const { cache } = incrementalBuild(m, contents, undefined);

  const corrupted: GraphEdgeCache = JSON.parse(JSON.stringify(cache));
  (corrupted.entries[B].contribution as { references: unknown }).references = [null];

  const { bundle } = incrementalBuild(m, contents, corrupted);
  expect(bundle, "a null element must fall back to a fresh extraction").toEqual(fullBuild(m, contents));
});

test("inv-2: a cache entry with non-object metrics re-extracts instead of persisting garbage into node_metrics", () => {
  const m = manifest([file(A, { hash: "ha" }), file(B, { hash: "hb" })]);
  const contents = baseContents();
  const { cache } = incrementalBuild(m, contents, undefined);

  const corrupted: GraphEdgeCache = JSON.parse(JSON.stringify(cache));
  (corrupted.entries[B].contribution as { metrics: unknown }).metrics = "garbage";

  const { bundle } = incrementalBuild(m, contents, corrupted);
  expect(bundle.node_metrics?.[B], "garbage must never reach the persisted metrics artifact").not.toBe("garbage");
  expect(bundle).toEqual(fullBuild(m, contents));
});

// F4: the cache-key version guards OTHER modules' behavior, so nothing about
// editing them forces the bump. This test is that forcing function: it pins the
// version against the content of every module whose output lands in a cached
// per-file contribution.
const __dirname_cache = dirname(fileURLToPath(import.meta.url));
const EXTRACTORS_DIR = resolve(__dirname_cache, "..", "..", "src", "audit", "extractors");

/** Every relative import/export specifier a module names. */
function relativeSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  // `import … from "./x.js"` and `export … from "./x.js"` (the barrel form).
  for (const match of source.matchAll(/\bfrom\s+["'](\.[^"']*)["']/g)) {
    specifiers.push(match[1]);
  }
  // `await import("./x.js")`.
  for (const match of source.matchAll(/\bimport\s*\(\s*["'](\.[^"']*)["']\s*\)/g)) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

/** Resolve a NodeNext specifier (`./x.js`, a directory barrel) to its source file. */
function resolveExtractorModule(fromFile: string, specifier: string): string | undefined {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [base.replace(/\.js$/, ".ts"), `${base}.ts`, join(base, "index.ts")];
  return candidates.find((candidate) => existsSync(candidate));
}

/**
 * Every module whose behavior a cached PerFileGraphContribution depends on,
 * DERIVED — graph.ts's transitive relative-import closure, restricted to the
 * extractors tree.
 *
 * A hand-enumerated list is the trap this test exists to prevent, one level up:
 * it silently missed `pathPatterns.ts` (whose `isTestPath` /
 * `normalizeExtractorPath` decide what graphTestSources and graphSuites emit) and
 * `analyzers/html.ts` (whose `HTML_RESOURCE_ATTRIBUTE` drives
 * `extractHtmlResourceEdges`), so widening either replayed stale caches with the
 * pin still green — and every NEW per-file extractor would have had to be
 * REMEMBERED into the array. The closure cannot forget.
 */
function cachedContributionModules(): string[] {
  const extractorsRoot = `${EXTRACTORS_DIR}${sep}`;
  const seen = new Set<string>();
  const queue = [join(EXTRACTORS_DIR, "graph.ts")];

  while (queue.length > 0) {
    const current = queue.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const specifier of relativeSpecifiers(readFileSync(current, "utf8"))) {
      const resolved = resolveExtractorModule(current, specifier);
      // Restricted to src/audit/extractors/**: shared contracts and the audit
      // types live under their own gates, and pulling them in would make this
      // pin fire on edits that cannot change a cached contribution.
      if (!resolved || !resolved.startsWith(extractorsRoot)) continue;
      if (!seen.has(resolved)) queue.push(resolved);
    }
  }

  // Path-sorted: the digest is derived from content, never from walk order.
  return [...seen].sort();
}

test("inv-2: the pinned module set is DERIVED from graph.ts's import closure, not remembered", () => {
  const modules = cachedContributionModules().map(
    (modulePath) => modulePath.replace(/\\/g, "/").split("/src/audit/extractors/")[1],
  );

  // The two the hand-written list forgot — named explicitly, because forgetting
  // them is exactly the failure this derivation replaces.
  expect(modules, "isTestPath/normalizeExtractorPath decide what the suite + test-source extractors emit").toContain("pathPatterns.ts");
  expect(modules, "HTML_RESOURCE_ATTRIBUTE drives extractHtmlResourceEdges").toContain("analyzers/html.ts");

  // The rest of the per-file extraction surface.
  for (const expected of [
    "graph.ts",
    "graphRoutes.ts",
    "graphPythonImports.ts",
    "graphSuites.ts",
    "graphTestSources.ts",
    "graphPathUtils.ts",
    "browserExtension.ts",
    "analyzers/complexityDuplication.ts",
    "graphManifestEdges/index.ts",
  ]) {
    expect(modules, `${expected} feeds a cached contribution`).toContain(expected);
  }

  // A floor: an import-walk that silently returns a handful of files must not be
  // able to fake a green pin below.
  expect(
    modules.length,
    `the closure collapsed to ${modules.length} module(s) — the import walk is broken, not the tree`,
  ).toBeGreaterThanOrEqual(20);
});

test("inv-2: GRAPH_EDGE_CACHE_KEY_VERSION is pinned to the extractor module set that feeds a cached contribution", () => {
  const digest = createHash("sha256");
  for (const modulePath of cachedContributionModules()) {
    // Normalize line endings so the pin is identical on win32 and CI.
    digest.update(`${modulePath.replace(/\\/g, "/").split("/src/")[1]}\n`);
    digest.update(readFileSync(modulePath, "utf8").replace(/\r\n/g, "\n"));
    digest.update("\0");
  }

  expect(
    digest.digest("hex"),
    "An extractor feeding a cached per-file contribution changed. A prior cache " +
      "would now replay contributions built under the OLD rules, so bump " +
      "GRAPH_EDGE_CACHE_KEY_VERSION in src/audit/extractors/graph.ts (which " +
      "invalidates every prior entry) and update this pin in the same commit.",
  ).toBe("9afe22acdafb14b43cbeae60ec4554580ddc9b19fce76159b83a671e5bca521f");
  expect(GRAPH_EDGE_CACHE_KEY_VERSION, "bump this alongside the digest above").toBe("v2");
});

test("a pathLookup change (file added) invalidates the ENTIRE prior cache", () => {
  const m1 = manifest([file(A, { hash: "ha" }), file(B, { hash: "hb" })]);
  const contents = baseContents();
  const { cache } = incrementalBuild(m1, contents, undefined);

  // Sentinel a still-content-identical file; adding a third file moves the global
  // path_lookup_hash → the whole prior cache is ignored → B re-extracted too.
  cache.entries[B].contribution.references.push({ from: B, to: "SENTINEL-B", kind: "reference", confidence: 1 });

  const C = "src/c.ts";
  const m2 = manifest([file(A, { hash: "ha" }), file(B, { hash: "hb" }), file(C, { hash: "hc" })]);
  const contents2 = { ...contents, [C]: "export const c = 3;\n" };

  const { bundle, cache: cache2 } = incrementalBuild(m2, contents2, cache);
  const refs = bundle.graphs?.references ?? [];
  expect(!refs.some((e) => e.to === "SENTINEL-B"), "a pathLookup change must invalidate every entry (B's sentinel gone)").toBeTruthy();
  expect(cache2.path_lookup_hash, "path_lookup_hash must move").not.toBe(cache.path_lookup_hash);

  const plain = fullBuild(m2, contents2);
  expect(bundle, "invalidated incremental build must equal the full build").toEqual(plain);
});
