/**
 * Shared test utilities for file and directory operations.
 * Extracted from duplicated implementations across multiple test files.
 */

import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Recursively collect every `*.ts` file under `dir`.
 */
export function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}
