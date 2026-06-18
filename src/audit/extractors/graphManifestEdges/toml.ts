import { parse as parseToml } from "smol-toml";

/**
 * Vetted-parser TOML helpers for the manifest-edge extractors. Replaces the
 * prior hand-rolled line scanner, which only understood `[section]` headers +
 * single-key arrays and silently dropped dotted-key (`workspace.members = …`),
 * inline-table (`workspace = { members = … }`), quoted-key, and multi-line
 * string forms — dropping the dependency-graph edges those manifests declare
 * (A5+A11). `smol-toml` is a pure-JS, TOML 1.0-compliant parser, so every
 * spelling resolves to the same object shape.
 *
 * All helpers degrade to empty on malformed input: the graph builder treats a
 * manifest it cannot parse as declaring no edges, and must never throw.
 */

/** Parse TOML, degrading to an empty object on malformed input (never throws). */
export function parseTomlSafe(content: string): Record<string, unknown> {
  try {
    const parsed = parseToml(content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** A nested object value (table) by key, or undefined when absent / not a table. */
export function asTomlTable(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The top-level TOML table for `key`, parsing `content` once. */
export function tomlTable(
  content: string,
  key: string,
): Record<string, unknown> | undefined {
  return asTomlTable(parseTomlSafe(content)[key]);
}

/**
 * Coerce a TOML value to a string[]: a string scalar → `[s]` (TOML allows a
 * bare `testpaths = "tests"`), a string array → its string elements, anything
 * else → `[]`. Trims and drops empties to match the prior extractor's behavior.
 */
export function tomlStringArray(value: unknown): string[] {
  const raw =
    typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value.filter((v): v is string => typeof v === "string")
        : [];
  return raw.map((s) => s.trim()).filter((s) => s.length > 0);
}
