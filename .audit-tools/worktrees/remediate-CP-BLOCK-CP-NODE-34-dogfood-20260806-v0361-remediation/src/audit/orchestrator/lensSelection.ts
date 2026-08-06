/**
 * Lens selection resolver for operator-selected audit lenses.
 *
 * Accepts the `lenses.selected` array from session-config, validates it,
 * de-duplicates, sorts with the canonical LENSES registry order, and always
 * unions in the mandatory base set required for cross-perspective coverage.
 */
import { LENSES, VALID_LENSES, type Lens } from "audit-tools/shared";

/**
 * The mandatory base lenses that are always included regardless of the
 * operator's selection. These are required for cross-perspective obligations
 * that every audit must satisfy.
 */
export const MANDATORY_LENSES: readonly Lens[] = [
  "security",
  "correctness",
  "reliability",
  "data_integrity",
] as const;

const MANDATORY_LENS_SET: ReadonlySet<Lens> = new Set(MANDATORY_LENSES);

/**
 * Resolve the effective lens set from the operator-selected lenses.
 *
 * - When `selected` is undefined/null, returns all canonical lenses.
 * - When `selected` is an array of lens names, unions in the mandatory base
 *   lenses, de-duplicates, sorts canonical lenses to registry order, and
 *   appends any custom (non-canonical) lenses at the end.
 */
export function resolveEffectiveLenses(selected: string[] | undefined | null): string[] {
  if (selected === undefined || selected === null) {
    return [...LENSES];
  }

  const canonicalSelected = selected.filter((s): s is Lens => VALID_LENSES.has(s));
  const customSelected = selected.filter((s) => !VALID_LENSES.has(s));

  // Union canonical with mandatory base lenses.
  const combined = new Set<Lens>([...canonicalSelected, ...MANDATORY_LENSES]);

  // Canonical in registry order, then custom appended (preserving input order).
  const canonical = LENSES.filter((lens) => combined.has(lens));
  const seenCustom = new Set<string>();
  const dedupedCustom = customSelected.filter((s) => {
    if (seenCustom.has(s)) return false;
    seenCustom.add(s);
    return true;
  });
  return [...canonical, ...dedupedCustom];
}

/** Returns true when the given lens is in the mandatory base set. */
export function isMandatoryLens(lens: string): boolean {
  return MANDATORY_LENS_SET.has(lens as Lens);
}
