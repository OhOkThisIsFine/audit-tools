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

/** The operator's confirmed lens choice, as recorded on the intent checkpoint. */
export interface LensSelection {
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
}

/**
 * Resolve `intent_checkpoint.lens_selection` into the effective lens set — the
 * ONE resolution every draw reads, so planning and result-ingestion can never
 * disagree about what the operator admitted.
 *
 * `include` is additive (mandatory lenses are always re-unioned by
 * `resolveEffectiveLenses`); `exclude` then removes non-mandatory lenses and the
 * result is re-resolved so a mandatory lens can never be excluded away.
 *
 * Returns `undefined` — never the full lens list — when the operator expressed
 * no limit at all, because "no limit" and "every lens" are different answers to
 * a consumer that gates on the set only when one exists.
 */
export function resolveIntentLensSelection(
  selection: LensSelection | undefined,
): string[] | undefined {
  if (selection?.include === undefined && selection?.exclude === undefined) {
    return undefined;
  }
  const resolved = resolveEffectiveLenses(
    selection.include === undefined ? null : [...selection.include],
  );
  if (selection.exclude === undefined || selection.exclude.length === 0) {
    return resolved;
  }
  const excluded = new Set(selection.exclude);
  return resolveEffectiveLenses(resolved.filter((lens) => !excluded.has(lens)));
}
