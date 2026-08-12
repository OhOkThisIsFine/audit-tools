import { rmSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDir, "../..");
const distPath = resolve(repositoryRoot, "dist");
const target = relative(repositoryRoot, distPath);

if (target !== "dist" || isAbsolute(target)) {
  throw new Error(`Refusing to clean unexpected build target: ${distPath}`);
}

rmSync(distPath, { recursive: true, force: true });
