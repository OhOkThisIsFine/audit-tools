import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolingManifest } from "../types/toolingManifest.js";

// dist/audit/io/toolingManifest.js → repo root is three levels up
// (io → audit → dist → repo root).
const PACKAGE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

export const TOOLING_INPUTS = [
  "audit-code.mjs",
  "audit-code-wrapper-lib.mjs",
  "package.json",
  "dist",
  "schemas",
  "skills/audit-code",
] as const;

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function collectFiles(path: string): Promise<string[]> {
  const info = await stat(path);
  if (info.isFile()) {
    return [path];
  }
  if (!info.isDirectory()) {
    return [];
  }

  const entries = await readdir(path, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    files.push(...(await collectFiles(join(path, entry.name))));
  }
  return files;
}

async function readPackageVersion(): Promise<string | null> {
  const packageJsonPath = join(PACKAGE_ROOT, "package.json");
  if (!(await pathExists(packageJsonPath))) {
    return null;
  }

  try {
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      version?: unknown;
    };
    return typeof packageJson.version === "string" ? packageJson.version : null;
  } catch (error) {
    process.stderr.write(
      `[audit-code] readPackageVersion: failed to read/parse ${packageJsonPath}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return null;
  }
}

export async function buildToolingManifest(): Promise<ToolingManifest> {
  const hash = createHash("sha256");
  const existingInputs: string[] = [];

  for (const input of TOOLING_INPUTS) {
    const absolute = join(PACKAGE_ROOT, input);
    if (!(await pathExists(absolute))) {
      continue;
    }
    existingInputs.push(input);
    const files = await collectFiles(absolute);
    for (const file of files.sort((a, b) => a.localeCompare(b))) {
      hash.update(relative(PACKAGE_ROOT, file).replace(/\\/g, "/"));
      hash.update("\n");
      hash.update(await readFile(file));
      hash.update("\n");
    }
  }

  return {
    generated_at: new Date().toISOString(),
    package_root: PACKAGE_ROOT,
    package_version: await readPackageVersion(),
    implementation_hash: hash.digest("hex"),
    inputs: existingInputs,
  };
}
