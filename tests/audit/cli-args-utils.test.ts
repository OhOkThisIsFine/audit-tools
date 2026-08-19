import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, sep } from "node:path";

const {
  getArtifactsDir,
  getRootDir,
} = await import("../../src/audit/cli/args.js");

const ARGS_SOURCE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
  "audit",
  "cli",
  "args.ts",
);

// ---------------------------------------------------------------------------
// getArtifactsDir / getRootDir — default rebases onto --root (latent bug fix)
// ---------------------------------------------------------------------------

test("getArtifactsDir: --root <X> with no --artifacts-dir resolves under <X>/.audit-tools/audit", () => {
  const rootX = resolve(sep, "tmp", "some-target-root");
  const argv = ["--root", rootX];
  expect(getRootDir(argv)).toBe(rootX);
  // The default MUST rebase onto --root, not resolve `.audit-tools/audit`
  // against the process CWD.
  expect(getArtifactsDir(argv)).toBe(join(rootX, ".audit-tools", "audit"));
});

test("getArtifactsDir: bare default (no flags) resolves under CWD/.audit-tools/audit", () => {
  expect(getArtifactsDir([])).toBe(join(resolve("."), ".audit-tools", "audit"));
});

test("getArtifactsDir: explicit --artifacts-dir is honored verbatim (ignores --root)", () => {
  const rootX = resolve(sep, "tmp", "some-target-root");
  const explicit = resolve(sep, "var", "artifacts", "elsewhere");
  const argv = ["--root", rootX, "--artifacts-dir", explicit];
  expect(getArtifactsDir(argv)).toBe(explicit);
});

// ---------------------------------------------------------------------------
// Guard: no other `.audit-tools` path-join literal in CLI args code.
// The single allowed `.audit-tools` literal is the DIRECT_CLI_DEFAULTS default
// sentinel (which getArtifactsDir rebases through the shared auditToolsPaths
// helper). Any other occurrence in code means a join literal was reintroduced
// instead of routing through audit-tools/shared — which is exactly the drift
// this module exists to prevent.
// ---------------------------------------------------------------------------

/** Strip `//` line comments and `/* *\/` block comments so only code remains. */
function stripComments(source: string): string {
  const withoutBlock = source.replace(/\/\*[\s\S]*?\*\//g, "");
  return withoutBlock
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

test("CLI args code has no `.audit-tools` path-join literal beyond the single default sentinel", () => {
  const code = stripComments(readFileSync(ARGS_SOURCE_PATH, "utf8"));
  const occurrences = (code.match(/\.audit-tools/g) ?? []).length;
  expect(occurrences, `Expected exactly one '.audit-tools' literal (the DIRECT_CLI_DEFAULTS default) in ${ARGS_SOURCE_PATH}, found ${occurrences}. Route path construction through audit-tools/shared auditToolsPaths instead of re-spelling the join literal.`).toBe(1);
  // The one allowed occurrence is the default-value sentinel, not a join() arg.
  expect(code).toMatch(/artifactsDir:\s*"\.audit-tools\/audit"/);
  expect(code, "No join()/resolve() call in CLI args code may take a '.audit-tools' literal — use the shared auditToolsPaths helpers.").not.toMatch(/(?:join|resolve)\([^)]*\.audit-tools/);
});
