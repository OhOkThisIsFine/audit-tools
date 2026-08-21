import { test, expect } from "vitest";

const { globMatches, pathMatchesPrefix } = await import("../../src/shared/intent/pathScope.js");

// ---------------------------------------------------------------------------
// Zero-segment `**` (CP-NODE-16 / COR-ef7a209d): a `**` segment folds its
// ADJACENT separator into its own regex fragment as OPTIONAL, so `**` may match
// ZERO whole path segments. The pre-fix char-by-char translator left the glob's
// literal `/` mandatory, so the most idiomatic must_not_touch forms silently
// failed to match a path with no intermediate directory.
// ---------------------------------------------------------------------------

test("globMatches — interior `**` matches zero segments ('a/**/b' vs 'a/b')", () => {
  expect(globMatches("a/b", "a/**/b"), "'a/**/b' must match 'a/b' with no intermediate directory").toBe(true);
});

test("globMatches — interior `**` still matches one or more segments", () => {
  expect(globMatches("a/x/b", "a/**/b")).toBe(true);
  expect(globMatches("a/x/y/b", "a/**/b")).toBe(true);
});

test("globMatches — 'src/**/*.ts' matches a file directly under src/", () => {
  expect(globMatches("src/index.ts", "src/**/*.ts"), "zero intermediate directories must match").toBe(true);
  expect(globMatches("src/shared/intent/pathScope.ts", "src/**/*.ts")).toBe(true);
});

test("globMatches — leading `**` matches a repo-root file ('**/*.env' vs 'secrets.env')", () => {
  expect(globMatches("secrets.env", "**/*.env"), "a leading `**` must consume zero leading segments").toBe(true);
  expect(globMatches("config/dev/secrets.env", "**/*.env")).toBe(true);
});

test("globMatches — trailing `**` matches the bare directory entry itself", () => {
  expect(globMatches("vendor", "vendor/**"), "'vendor/**' must match the bare 'vendor' entry").toBe(true);
  expect(globMatches("vendor/pkg/index.js", "vendor/**")).toBe(true);
});

test("globMatches — a bare `**` glob matches any path", () => {
  expect(globMatches("x.ts", "**")).toBe(true);
  expect(globMatches("a/b/c.ts", "**")).toBe(true);
});

// ---------------------------------------------------------------------------
// The zero-segment rewrite must not widen matching into substring matching.
// ---------------------------------------------------------------------------

test("globMatches — '**/gen/**' matches the gen directory but not a 'general' sibling", () => {
  expect(globMatches("src/gen/api.ts", "**/gen/**")).toBe(true);
  expect(globMatches("gen", "**/gen/**")).toBe(true);
  expect(globMatches("general", "**/gen/**"), "a substring must not satisfy a whole-segment glob").toBe(false);
  expect(globMatches("src/general/api.ts", "**/gen/**")).toBe(false);
});

// ---------------------------------------------------------------------------
// Ordinary (single-`*`, `?`, literal) matching — the suite stands alone.
// ---------------------------------------------------------------------------

test("globMatches — a single `*` stays within one path segment", () => {
  expect(globMatches("src/index.ts", "src/*.ts")).toBe(true);
  expect(globMatches("src/nested/index.ts", "src/*.ts"), "`*` must not cross a separator").toBe(false);
});

test("globMatches — `?` matches exactly one non-separator character", () => {
  expect(globMatches("ab.ts", "a?.ts")).toBe(true);
  expect(globMatches("abc.ts", "a?.ts")).toBe(false);
  expect(globMatches("a/.ts", "a?.ts"), "`?` must not match a separator").toBe(false);
});

test("globMatches — a `.` in the glob is a literal, not a regex wildcard", () => {
  expect(globMatches("src/a.ts", "src/*.ts")).toBe(true);
  expect(globMatches("src/axts", "src/*.ts"), "the '.' must be escaped").toBe(false);
});

test("globMatches — a wildcard-free glob falls back to prefix matching", () => {
  expect(globMatches("src/api/handler.ts", "src/api")).toBe(true);
  expect(globMatches("src/api", "src/api")).toBe(true);
  expect(globMatches("src/apix/handler.ts", "src/api"), "a prefix must stop at a segment boundary").toBe(false);
  expect(pathMatchesPrefix("src/api/handler.ts", "src/api")).toBe(true);
});

test("globMatches — separators are normalized, so a Windows path matches a `/` glob", () => {
  expect(globMatches("src\\index.ts", "src/**/*.ts")).toBe(true);
  expect(globMatches("src\\nested\\index.ts", "src/**/*.ts")).toBe(true);
});

test("globMatches — never throws on a malformed glob", () => {
  expect(globMatches("a/b.ts", "a/[unclosed*")).toBe(false);
  expect(globMatches("a/b.ts", "**/(*")).toBe(false);
});
