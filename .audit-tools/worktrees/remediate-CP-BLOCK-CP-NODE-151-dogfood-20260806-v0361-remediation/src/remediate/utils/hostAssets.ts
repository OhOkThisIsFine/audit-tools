import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Strip YAML frontmatter from a text file, returning only the body.
 * Consumed by `ensureGlobalAssets` (the `remediate-code ensure` CLI command,
 * src/remediate/index.ts). scripts/remediate/postinstall.mjs has its own
 * copy in scripts/shared/install-host-assets.mjs — that script runs before
 * `tsc` has produced dist/, so it cannot import this TS module.
 */
export function splitFrontmatter(text: string): { body: string } {
  const normalized = text.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n[\s\S]*?\n---\n?/u);
  return { body: match ? normalized.slice(match[0].length) : normalized };
}

/**
 * Write a generated file, creating parent directories as needed.
 * Returns "installed" on first write, "updated" on subsequent writes.
 */
export function writeGeneratedFile(path: string, content: Buffer): string {
  const action = existsSync(path) ? "updated" : "installed";
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return action;
}

/**
 * Coerce an unknown value to a plain object (non-array).
 * Returns {} for primitives, arrays, and null.
 */
export function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
