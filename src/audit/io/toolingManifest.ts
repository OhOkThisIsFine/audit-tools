import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolingManifest } from "../types/toolingManifest.js";
import { compareCodeUnits } from "../../shared/compareCodeUnits.js";

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
  "wrapper/audit-code-wrapper-lib.mjs",
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
  for (const entry of entries.sort((a, b) => compareCodeUnits(a.name, b.name))) {
    files.push(...(await collectFiles(join(path, entry.name))));
  }
  return files;
}

/**
 * Read `version` from the package.json under `packageRoot`, or `null` when the
 * file is absent, unreadable, malformed, or carries a non-string version — a
 * missing tooling version must never abort manifest construction.
 *
 * Exported and root-parameterized so its failure branch is reachable from a
 * test against a temp directory: the regression it guards (a parse failure that
 * reports to stderr and degrades to `null`) is only actually guarded by a test
 * that runs THIS function, not a copy of it.
 */
export async function readPackageVersion(
  packageRoot: string,
): Promise<string | null> {
  const packageJsonPath = join(packageRoot, "package.json");
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
    for (const file of files.sort((a, b) => compareCodeUnits(a, b))) {
      hash.update(relative(PACKAGE_ROOT, file).replace(/\\/g, "/"));
      hash.update("\n");
      hash.update(await readFile(file));
      hash.update("\n");
    }
  }

  return {
    generated_at: new Date().toISOString(),
    package_root: PACKAGE_ROOT,
    package_version: await readPackageVersion(PACKAGE_ROOT),
    implementation_hash: hash.digest("hex"),
    inputs: existingInputs,
  };
}
