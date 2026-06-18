import { parse as parseYaml } from "yaml";

/**
 * Vetted-parser YAML helpers for the manifest-edge extractors. Replaces the
 * prior line scanner, which understood only `key: value` / `- item` lines and a
 * single-line flow list, silently missing block sequences nested under maps,
 * flow collections, multi-line scalars, and anchors — dropping the path edges
 * those YAML configs declare (A5+A11). `yaml` (eemeli) is a pure-JS,
 * spec-compliant parser. All helpers degrade to empty on malformed input: the
 * graph builder treats an unparseable manifest as declaring no edges, never
 * throwing.
 */

/** Parse YAML, degrading to `undefined` on malformed input (never throws). */
export function parseYamlSafe(content: string): unknown {
  try {
    return parseYaml(content);
  } catch {
    return undefined;
  }
}

/** The top-level object value of a parsed YAML document, or undefined. */
export function yamlRootObject(content: string): Record<string, unknown> | undefined {
  const root = parseYamlSafe(content);
  return root && typeof root === "object" && !Array.isArray(root)
    ? (root as Record<string, unknown>)
    : undefined;
}

/** Coerce a YAML value to a string[]: a scalar → `[s]`, a sequence → its strings. */
export function yamlStringArray(value: unknown): string[] {
  const raw =
    typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value.filter((v): v is string => typeof v === "string")
        : [];
  return raw.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Every string SCALAR VALUE reachable in a parsed YAML value, walked depth-first
 * through maps and sequences (map keys are not collected — only values, matching
 * the prior extractor that read the value side of `key: value` and list items).
 * Nested structures the line scanner could not reach are now included.
 */
export function collectYamlStringScalars(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectYamlStringScalars(item, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectYamlStringScalars(v, out);
  }
  return out;
}
