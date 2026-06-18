import test from "node:test";
import assert from "node:assert/strict";

const {
  renderCommand,
  toPosixCommandToken,
  quoteCommandArg,
} = await import("../../src/audit/cli/args.ts");

// ── toPosixCommandToken ────────────────────────────────────────────────────

test("toPosixCommandToken converts Windows absolute path separators to forward slashes", () => {
  assert.equal(
    toPosixCommandToken("C:\\Code\\audit-tools\\audit-code.mjs"),
    "C:/Code/audit-tools/audit-code.mjs",
  );
});

test("toPosixCommandToken converts UNC paths to forward slashes", () => {
  assert.equal(
    toPosixCommandToken("\\\\server\\share\\file.mjs"),
    "//server/share/file.mjs",
  );
});

test("toPosixCommandToken converts relative Windows paths with backslashes", () => {
  assert.equal(
    toPosixCommandToken("packages\\audit-code\\audit-code.mjs"),
    "packages/audit-code/audit-code.mjs",
  );
});

test("toPosixCommandToken does not touch POSIX paths", () => {
  assert.equal(
    toPosixCommandToken("/usr/local/bin/node"),
    "/usr/local/bin/node",
  );
});

test("toPosixCommandToken does not touch plain command names", () => {
  assert.equal(toPosixCommandToken("node"), "node");
  assert.equal(toPosixCommandToken("audit-code"), "audit-code");
  assert.equal(toPosixCommandToken("--root"), "--root");
});

test("toPosixCommandToken does not corrupt regex-like strings without backslash paths", () => {
  // A regex string that has backslashes but doesn't look like a Windows path
  // should not be mangled.
  const regex = String.raw`^\d+\w+$`;
  assert.equal(toPosixCommandToken(regex), regex);
});

// ── quoteCommandArg ────────────────────────────────────────────────────────

test("quoteCommandArg wraps arguments containing spaces in double quotes", () => {
  assert.equal(quoteCommandArg("C:/Path With Spaces/tool.mjs"), '"C:/Path With Spaces/tool.mjs"');
});

test("quoteCommandArg escapes embedded double quotes", () => {
  assert.equal(quoteCommandArg('a"b'), '"a\\"b"');
});

test("quoteCommandArg returns plain tokens unchanged", () => {
  assert.equal(quoteCommandArg("node"), "node");
  assert.equal(quoteCommandArg("--root"), "--root");
  assert.equal(quoteCommandArg("C:/simple/path.mjs"), "C:/simple/path.mjs");
});

// ── renderCommand ──────────────────────────────────────────────────────────

test("renderCommand converts Windows absolute path tokens to forward slashes", () => {
  const result = renderCommand([
    "node",
    "C:\\Code\\audit-tools\\packages\\audit-code\\audit-code.mjs",
    "next-step",
  ]);
  assert.equal(
    result,
    "node C:/Code/audit-tools/packages/audit-code/audit-code.mjs next-step",
  );
});

test("renderCommand preserves argument boundaries and quotes path tokens containing spaces", () => {
  const result = renderCommand([
    "node",
    "C:\\Path With Spaces\\audit-code.mjs",
    "--root",
    "C:\\My Repo",
  ]);
  assert.equal(
    result,
    'node "C:/Path With Spaces/audit-code.mjs" --root "C:/My Repo"',
  );
});

test("renderCommand does not modify non-path flag tokens", () => {
  const result = renderCommand([
    "audit-code",
    "next-step",
    "--root",
    "/repo",
    "--artifacts-dir",
    "/repo/.audit-tools/audit",
  ]);
  assert.equal(
    result,
    "audit-code next-step --root /repo --artifacts-dir /repo/.audit-tools/audit",
  );
});

test("renderCommand handles a mix of Windows and POSIX tokens", () => {
  const result = renderCommand([
    "node",
    "packages\\audit-code\\audit-code.mjs",
    "--root",
    "/repo",
  ]);
  assert.equal(result, "node packages/audit-code/audit-code.mjs --root /repo");
});
