/**
 * The single deterministic JSON serializer for content hashing across the
 * codebase (INV-CK-2 / content-key-seam-fail-2). Object keys are sorted, so two
 * structurally-equal values with differently-ordered keys serialize identically.
 * `undefined` is normalized to `null` (both top-level and inside arrays) so a
 * present-but-undefined field can never change the hash.
 *
 * There must be exactly ONE such serializer — never write a second. Both the
 * artifact-freshness metadata hash (`src/audit/orchestrator/artifactFreshness.ts`,
 * which re-exports this) and the content-key seam (`src/shared/contentKey.ts`)
 * route through this function.
 */
export function stableStringify(value: unknown): string {
  if (value === undefined) {
    return "null";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item ?? null)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}
