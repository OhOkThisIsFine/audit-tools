import { test, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, sep } from "node:path";
import { AUDIT_TOOLS_CALLER_CWD_ENV } from "audit-tools/shared";

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
// getRootDir with NO --root: canonical discovery from the caller's cwd.
//
// The audit loader prompt used to mandate `--root` on every command because the
// default resolved the caller's cwd VERBATIM — running from `<repo>/src` rooted
// the run at `<repo>/src` and minted a second `.audit-tools/` tree there. The
// rule is now tool-guaranteed: any cwd inside the repository resolves the same
// root, and `--root` is only the explicit out-of-repo override.
// ---------------------------------------------------------------------------

/** Run `fn` with the wrapper-stamped caller cwd pointed at `dir`. */
function withCallerCwd<T>(dir: string, fn: () => T): T {
  const previous = process.env[AUDIT_TOOLS_CALLER_CWD_ENV];
  process.env[AUDIT_TOOLS_CALLER_CWD_ENV] = dir;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[AUDIT_TOOLS_CALLER_CWD_ENV];
    else process.env[AUDIT_TOOLS_CALLER_CWD_ENV] = previous;
  }
}

function tempRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "cli-args-root-"));
  mkdirSync(join(repo, ".git"), { recursive: true });
  return repo;
}

test("getRootDir: no --root resolves the repo root from a NESTED cwd inside the repo", () => {
  const repo = tempRepo();
  try {
    const nested = join(repo, "src", "audit", "cli");
    mkdirSync(nested, { recursive: true });
    expect(withCallerCwd(nested, () => getRootDir([]))).toBe(resolve(repo));
    // The artifacts dir follows, so no second .audit-tools tree can be minted.
    expect(withCallerCwd(nested, () => getArtifactsDir([]))).toBe(
      join(resolve(repo), ".audit-tools", "audit"),
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("getRootDir: no --root resolves the repo root from a cwd inside .audit-tools/", () => {
  const repo = tempRepo();
  try {
    const drifted = join(repo, ".audit-tools", "audit", "steps");
    mkdirSync(drifted, { recursive: true });
    expect(withCallerCwd(drifted, () => getRootDir([]))).toBe(resolve(repo));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("getRootDir: an explicit --root is honored verbatim and never marker-climbed", () => {
  const repo = tempRepo();
  try {
    // A sub-project inside a larger git repo: `--root` names it, so discovery
    // must not re-home it to the outer repo (the over-reach resolveRepoRoot
    // has always refused).
    const subProject = join(repo, "packages", "widget");
    mkdirSync(subProject, { recursive: true });
    expect(
      withCallerCwd(subProject, () => getRootDir(["--root", subProject])),
    ).toBe(resolve(subProject));
    // The explicit override also wins over the caller's cwd entirely — the
    // run-from-outside-the-target-repo case the loader keeps the flag for.
    const elsewhere = mkdtempSync(join(tmpdir(), "cli-args-elsewhere-"));
    try {
      expect(withCallerCwd(elsewhere, () => getRootDir(["--root", repo]))).toBe(
        resolve(repo),
      );
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
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
