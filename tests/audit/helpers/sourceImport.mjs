import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

let compiledSourceDir;

function getRepoRoot() {
  // tests/audit/helpers/ -> three levels up is the (single-package) repo root.
  return resolve(import.meta.dirname, "..", "..", "..");
}

// Walk up from `startDir` looking for a `node_modules` directory that contains
// `marker`. Returns the node_modules path, or null. npm hoists dependencies to
// whichever ancestor it installed at: the package itself, the workspace root,
// or — when this package is checked out as a git worktree nested under the main
// repo — the main repo's root, two or more levels above the worktree.
function findNodeModules(startDir, marker) {
  let dir = startDir;
  for (;;) {
    const nodeModules = join(dir, "node_modules");
    if (existsSync(join(nodeModules, marker))) {
      return nodeModules;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

function ensureCompiledSource() {
  if (compiledSourceDir) {
    return compiledSourceDir;
  }

  const repoRoot = getRepoRoot();
  compiledSourceDir = mkdtempSync(join(tmpdir(), "audit-code-source-"));

  // The package emits ESM ("type": "module"), but the temp outDir has no
  // package.json, so Node would load the compiled .js as CommonJS and choke on
  // `export`. Mark the temp tree as ESM. It ALSO carries the package name +
  // shared exports so the inlined `audit-tools/shared` self-reference resolves
  // to the compiled shared tree (tempDir/shared/index.js) from within the sandbox.
  writeFileSync(
    join(compiledSourceDir, "package.json"),
    JSON.stringify({
      type: "module",
      name: "audit-tools",
      exports: {
        "./shared": "./shared/index.js",
        "./shared/*": "./shared/*.js",
      },
    }),
  );

  const typescriptNodeModules = findNodeModules(repoRoot, "typescript");
  if (!typescriptNodeModules) {
    throw new Error(
      `Could not locate the 'typescript' package in any node_modules above ${repoRoot}. Run 'npm install' from the repo root.`,
    );
  }
  const tscPath = join(typescriptNodeModules, "typescript", "bin", "tsc");

  execFileSync(
    process.execPath,
    [
      tscPath,
      "-p",
      join(repoRoot, "tsconfig.json"),
      "--outDir",
      compiledSourceDir,
      "--declaration",
      "false",
      "--declarationMap",
      "false",
      "--sourceMap",
      "false",
    ],
    {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const destNodeModules = join(compiledSourceDir, "node_modules");
  if (!existsSync(destNodeModules)) {
    // Symlink the repo node_modules so third-party deps (smol-toml, yaml, zod)
    // resolve from the compiled temp directory. The `audit-tools/shared`
    // self-reference resolves via the temp package.json exports above, not here.
    symlinkSync(typescriptNodeModules, destNodeModules, "junction");
  }

  return compiledSourceDir;
}

export async function importSourceModule(sourceRelativePath) {
  const distDir = ensureCompiledSource();
  // Callers pass audit-relative paths (`src/extractors/graph.ts`); the single
  // package compiles audit source to `<tempDir>/audit/...`, so map src/ → audit/.
  const normalized = sourceRelativePath
    .replace(/^src[\\/]/, "audit/")
    .replace(/\.ts$/u, ".js")
    .replace(/\\/g, "/");
  return await import(pathToFileURL(join(distDir, normalized)).href);
}

process.once("exit", () => {
  if (compiledSourceDir) {
    rmSync(compiledSourceDir, { recursive: true, force: true });
  }
});
