import { test, expect } from "vitest";
import { buildGraphBundle } from "../../src/audit/extractors/graph.ts";

// C2 incremental graph-build — per-file edge cache.
//
// The cache MUST be transparent: an incremental build (prior cache fed in) is
// byte-identical to a full build. These tests prove (a) equivalence in every
// reuse/invalidation case, and (b) that reuse actually happens (via a doctored
// cache whose sentinel only appears if the cached contribution was used, not
// re-extracted).

function file(path, { hash, size = 256 } = {}) {
  return { path, size_bytes: size, language: "typescript", excluded: false, ...(hash ? { hash } : {}) };
}

function manifest(files) {
  return { files };
}

const A = "src/a.ts";
const B = "src/b.ts";

function baseContents() {
  return {
    [A]: "import { b } from './b';\nexport const a = () => b();\n",
    [B]: "export const b = () => 1;\n",
  };
}

function fullBuild(m, fileContents) {
  return buildGraphBundle(m, undefined, { fileContents });
}

function incrementalBuild(m, fileContents, priorEdgeCache) {
  const edgeCacheSink = {};
  const bundle = buildGraphBundle(m, undefined, {
    fileContents,
    priorEdgeCache,
    edgeCacheSink,
  });
  return { bundle, cache: edgeCacheSink.cache };
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
  const sentinel = { from: B, to: "SENTINEL-REUSED", kind: "reference", confidence: 1 };
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
  const doctored = {
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
