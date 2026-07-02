import { test, expect } from "vitest";

const { resolveResourceUrl } = await import("../../src/audit/extractors/analyzers/resourceUrl.ts");
const { graphLookupKey } = await import("../../src/audit/extractors/graphPathUtils.ts");

/**
 * Build a pathLookup Map<lowercasedPath, normalizedPath> from an array of
 * repo-relative paths, matching the shape produced by the audit pipeline.
 */
function makeLookup(paths) {
  return new Map(paths.map((p) => [graphLookupKey(p), p]));
}

// ── Edge cases: empty / whitespace / external URLs ─────────────────────────

test("resolveResourceUrl returns undefined for empty or whitespace-only URL", () => {
  const lookup = makeLookup(["src/index.html"]);
  expect(resolveResourceUrl("src/index.html", "", lookup)).toBe(undefined);
  expect(resolveResourceUrl("src/index.html", "   ", lookup)).toBe(undefined);
});

test("resolveResourceUrl returns undefined for external URLs (http, https, data, mailto)", () => {
  const lookup = makeLookup(["src/index.html"]);
  expect(resolveResourceUrl("src/index.html", "https://cdn.example.com/x.css", lookup)).toBe(undefined);
  expect(resolveResourceUrl("src/index.html", "http://example.com/x.js", lookup)).toBe(undefined);
  expect(resolveResourceUrl(
      "src/index.html",
      "data:image/png;base64,AAAA",
      lookup,
    )).toBe(undefined);
  expect(resolveResourceUrl("src/index.html", "mailto:a@b.com", lookup)).toBe(undefined);
});

test("resolveResourceUrl returns undefined for protocol-relative URLs", () => {
  const lookup = makeLookup(["src/index.html"]);
  expect(resolveResourceUrl("src/index.html", "//cdn.example.com/x.css", lookup)).toBe(undefined);
});

test("resolveResourceUrl returns undefined for fragment-only URLs", () => {
  const lookup = makeLookup(["src/index.html"]);
  expect(resolveResourceUrl("src/index.html", "#section", lookup)).toBe(undefined);
});

// ── Query-string and fragment stripping ────────────────────────────────────

test("resolveResourceUrl strips query string before resolving", () => {
  const lookup = makeLookup(["index.html", "app.js"]);
  expect(resolveResourceUrl("index.html", "app.js?v=2", lookup)).toBe("app.js");
});

test("resolveResourceUrl strips fragment before resolving", () => {
  const lookup = makeLookup(["index.html", "app.js"]);
  expect(resolveResourceUrl("index.html", "app.js#main", lookup)).toBe("app.js");
});

test("resolveResourceUrl strips both query string and fragment before resolving", () => {
  const lookup = makeLookup(["index.html", "app.js"]);
  expect(resolveResourceUrl("index.html", "app.js?v=2#main", lookup)).toBe("app.js");
});

// ── Root-relative URLs ─────────────────────────────────────────────────────

test("resolveResourceUrl resolves root-relative URL from repo root regardless of fromPath", () => {
  const lookup = makeLookup(["subdir/page.html", "assets/logo.png"]);
  expect(resolveResourceUrl("subdir/page.html", "/assets/logo.png", lookup)).toBe("assets/logo.png");
  expect(resolveResourceUrl("a/b/c/page.html", "/assets/logo.png", lookup)).toBe("assets/logo.png");
});

// ── Relative URLs resolved from the referencing file's directory ───────────

test("resolveResourceUrl resolves relative URL from the referencing file's directory", () => {
  const lookup = makeLookup([
    "subdir/page.html",
    "img/logo.png",
    "index.html",
    "app.js",
  ]);
  // ../img/logo.png from subdir/ → img/logo.png
  expect(resolveResourceUrl("subdir/page.html", "../img/logo.png", lookup)).toBe("img/logo.png");
  // same-directory reference from a root-level file
  expect(resolveResourceUrl("index.html", "app.js", lookup)).toBe("app.js");
});

// ── Unknown path → undefined ───────────────────────────────────────────────

test("resolveResourceUrl returns undefined when resolved candidate is not in pathLookup", () => {
  const emptyLookup = makeLookup([]);
  expect(resolveResourceUrl("index.html", "missing.js", emptyLookup)).toBe(undefined);
});
