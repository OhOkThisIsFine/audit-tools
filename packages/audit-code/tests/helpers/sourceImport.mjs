import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

let compiledSourceDir;

function getRepoRoot() {
  return resolve(import.meta.dirname, "..", "..");
}

function getWorkspaceRoot() {
  return resolve(getRepoRoot(), "..", "..");
}

function ensureCompiledSource() {
  if (compiledSourceDir) {
    return compiledSourceDir;
  }

  const repoRoot = getRepoRoot();
  compiledSourceDir = mkdtempSync(join(tmpdir(), "audit-code-source-"));
  const tscPath = join(
    repoRoot,
    "node_modules",
    "typescript",
    "bin",
    "tsc",
  );

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
    // resolve from the compiled temp directory. In an npm workspace, hoisted
    // packages live in the workspace root's node_modules.
    const candidates = [
      join(repoRoot, "node_modules"),
      join(getWorkspaceRoot(), "node_modules"),
    ];
    const src = candidates.find(
      (p) => existsSync(join(p, "@audit-tools", "shared")),
    ) ?? candidates[0];
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
