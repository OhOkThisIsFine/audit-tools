// sites-pinned: tests/audit/graph-path-index.test.ts
import { posix } from "node:path";
import { isJsonSchemaPath, normalizeGraphPath } from "./graphPathUtils.js";

/** Immutable, invocation-local snapshot. Never retained against a mutable lookup. */
export interface GraphPathIndex {
  readonly paths: readonly string[];
  pythonModuleMatches(modulePath: string): readonly string[];
  schemaBasenameMatches(basename: string): readonly string[];
}

export function buildGraphPathIndex(pathLookup: Map<string, string>): GraphPathIndex {
  const paths = Object.freeze([...new Set(pathLookup.values())]);
  const python = new Map<string, string[]>();
  const schemas = new Map<string, string[]>();
  const append = (buckets: Map<string, string[]>, key: string, path: string): void => {
    const bucket = buckets.get(key);
    if (bucket) bucket.push(path);
    else buckets.set(key, [path]);
  };
  for (const path of paths) {
    const normalized = normalizeGraphPath(path).toLowerCase();
    if (isJsonSchemaPath(normalized)) append(schemas, posix.basename(normalized), path);
    if (!/\.pyi?$/.test(normalized)) continue;
    const stem = normalized.replace(/\.pyi?$/, "");
    const keys = new Set<string>();
    const addSuffixes = (value: string): void => {
      keys.add(value);
      for (let at = value.indexOf("/"); at >= 0; at = value.indexOf("/", at + 1)) {
        keys.add(value.slice(at + 1));
      }
    };
    addSuffixes(stem);
    if (stem.endsWith("/__init__")) addSuffixes(stem.slice(0, -"/__init__".length));
    for (const key of keys) append(python, key, path);
  }
  // Maps remain private; neither buckets nor the distinct original values can mutate.
  for (const bucket of python.values()) Object.freeze(bucket);
  for (const bucket of schemas.values()) Object.freeze(bucket);
  const empty: readonly string[] = Object.freeze([]);
  return Object.freeze({
    paths,
    pythonModuleMatches: (modulePath: string) =>
      python.get(normalizeGraphPath(modulePath).toLowerCase()) ?? empty,
    schemaBasenameMatches: (basename: string) => schemas.get(basename.toLowerCase()) ?? empty,
  });
}
