import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

let compiledSourceDir;

function getRepoRoot() {
  return resolve(import.meta.dirname, "..", "..");
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

  // The package emits ESM (audit-code is "type": "module"), but the temp outDir
  // has no package.json, so Node would load the compiled .js as CommonJS and
  // choke on `export`. Mark the temp tree as ESM so the output loads correctly.
  writeFileSync(
    join(compiledSourceDir, "package.json"),
    JSON.stringify({ type: "module" }),
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
    ],
    {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const destNodeModules = join(compiledSourceDir, "node_modules");
  if (!existsSync(destNodeModules)) {
    // Symlink node_modules so workspace-linked packages (e.g. @audit-tools/shared)
    // resolve from the compiled temp directory.
    const src =
      findNodeModules(repoRoot, join("@audit-tools", "shared")) ??
      typescriptNodeModules;
    symlinkSync(src, destNodeModules, "junction");
  }

  return compiledSourceDir;
}

export async function importSourceModule(sourceRelativePath) {
  const distDir = ensureCompiledSource();
  const normalized = sourceRelativePath
    .replace(/^src[\\/]/, "")
    .replace(/\.ts$/u, ".js")
    .replace(/\\/g, "/");
  return await import(pathToFileURL(join(distDir, normalized)).href);
}

process.once("exit", () => {
  if (compiledSourceDir) {
    rmSync(compiledSourceDir, { recursive: true, force: true });
  }
});
