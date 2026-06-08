/**
 * Lens selection resolver for operator-selected audit lenses.
 *
 * Accepts the `lenses.selected` array from session-config, validates it,
 * de-duplicates, sorts with the canonical LENSES registry order, and always
 * unions in the mandatory base set required for cross-perspective coverage.
 */
import { LENSES, VALID_LENSES, type Lens } from "@audit-tools/shared";
import type { ValidationIssue } from "@audit-tools/shared";
import { pushValidationIssue } from "@audit-tools/shared";

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
 * Validate the `lenses.selected` session-config value and return any errors.
 * Returns an empty array when the value is undefined (meaning "all lenses").
 */
export function validateLensSelection(
  value: unknown,
  path = "lenses.selected",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (value === undefined || value === null) {
    return issues;
  }
  if (!Array.isArray(value)) {
    pushValidationIssue(issues, path, `${path} must be an array of lens names.`);
    return issues;
  }
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || !VALID_LENSES.has(item)) {
      pushValidationIssue(
        issues,
        `${path}[${index}]`,
        `${path}[${index}] "${String(item)}" is not a valid lens. Valid lenses: ${[...LENSES].join(", ")}.`,
      );
    }
  }
  return issues;
}

/**
 * Resolve the effective lens set from the operator-selected lenses.
 *
 * - When `selected` is undefined/null, returns all lenses (current behavior).
 * - When `selected` is an array of valid lens names, unions in the mandatory
 *   base lenses, de-duplicates, and sorts to the canonical LENSES order.
 */
export function resolveEffectiveLenses(selected: string[] | undefined | null): Lens[] {
  if (selected === undefined || selected === null) {
    // Default: all lenses.
    return [...LENSES];
  }

  // Filter to valid lenses only (invalid ones are caught by validation; tolerate
  // them here so the runtime path doesn't throw on a misconfigured file).
  const validSelected = selected.filter((s): s is Lens => VALID_LENSES.has(s));

  // Union with mandatory base lenses.
  const combined = new Set<Lens>([...validSelected, ...MANDATORY_LENSES]);

  // Sort to canonical registry order.
  return LENSES.filter((lens) => combined.has(lens));
}

/** Returns true when the given lens is in the effective set. */
export function isLensEffective(lens: Lens, effectiveLenses: Lens[]): boolean {
  return effectiveLenses.includes(lens);
}

/** Returns true when the given lens is in the mandatory base set. */
export function isMandatoryLens(lens: Lens): boolean {
  return MANDATORY_LENS_SET.has(lens);
}
