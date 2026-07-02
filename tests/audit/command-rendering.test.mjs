import { test, expect } from "vitest";

const {
  renderCommand,
  toPosixCommandToken,
  quoteCommandArg,
} = await import("../../src/audit/cli/args.ts");

// ── toPosixCommandToken ────────────────────────────────────────────────────

test("toPosixCommandToken converts Windows absolute path separators to forward slashes", () => {
  expect(toPosixCommandToken("C:\\Code\\audit-tools\\audit-code.mjs")).toBe("C:/Code/audit-tools/audit-code.mjs");
});

test("toPosixCommandToken converts UNC paths to forward slashes", () => {
  expect(toPosixCommandToken("\\\\server\\share\\file.mjs")).toBe("//server/share/file.mjs");
});

test("toPosixCommandToken converts relative Windows paths with backslashes", () => {
  expect(toPosixCommandToken("packages\\audit-code\\audit-code.mjs")).toBe("packages/audit-code/audit-code.mjs");
});

test("toPosixCommandToken does not touch POSIX paths", () => {
  expect(toPosixCommandToken("/usr/local/bin/node")).toBe("/usr/local/bin/node");
});

test("toPosixCommandToken does not touch plain command names", () => {
  expect(toPosixCommandToken("node")).toBe("node");
  expect(toPosixCommandToken("audit-code")).toBe("audit-code");
  expect(toPosixCommandToken("--root")).toBe("--root");
});

test("toPosixCommandToken does not corrupt regex-like strings without backslash paths", () => {
  // A regex string that has backslashes but doesn't look like a Windows path
  // should not be mangled.
  const regex = String.raw`^\d+\w+$`;
  expect(toPosixCommandToken(regex)).toBe(regex);
});

// ── quoteCommandArg ────────────────────────────────────────────────────────

test("quoteCommandArg wraps arguments containing spaces in double quotes", () => {
  expect(quoteCommandArg("C:/Path With Spaces/tool.mjs")).toBe('"C:/Path With Spaces/tool.mjs"');
});

test("quoteCommandArg escapes embedded double quotes", () => {
  expect(quoteCommandArg('a"b')).toBe('"a\\"b"');
});

test("quoteCommandArg returns plain tokens unchanged", () => {
  expect(quoteCommandArg("node")).toBe("node");
  expect(quoteCommandArg("--root")).toBe("--root");
  expect(quoteCommandArg("C:/simple/path.mjs")).toBe("C:/simple/path.mjs");
});

// ── renderCommand ──────────────────────────────────────────────────────────

test("renderCommand converts Windows absolute path tokens to forward slashes", () => {
  const result = renderCommand([
    "node",
    "C:\\Code\\audit-tools\\packages\\audit-code\\audit-code.mjs",
    "next-step",
  ]);
  expect(result).toBe("node C:/Code/audit-tools/packages/audit-code/audit-code.mjs next-step");
});

test("renderCommand preserves argument boundaries and quotes path tokens containing spaces", () => {
  const result = renderCommand([
    "node",
    "C:\\Path With Spaces\\audit-code.mjs",
    "--root",
    "C:\\My Repo",
  ]);
  expect(result).toBe('node "C:/Path With Spaces/audit-code.mjs" --root "C:/My Repo"');
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
  expect(result).toBe("audit-code next-step --root /repo --artifacts-dir /repo/.audit-tools/audit");
});

test("renderCommand handles a mix of Windows and POSIX tokens", () => {
  const result = renderCommand([
    "node",
    "packages\\audit-code\\audit-code.mjs",
    "--root",
    "/repo",
  ]);
  expect(result).toBe("node packages/audit-code/audit-code.mjs --root /repo");
});
