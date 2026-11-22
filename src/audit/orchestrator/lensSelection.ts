// sites-pinned: tests/audit/lens-selection.test.ts
import { BUILT_IN_REVIEW_LENSES, ReviewLensSchema } from "../../shared/types/reviewQuestion.js";

/** The operator's confirmed question scope, not an additive minimum. */
export interface LensSelection {
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly omission_reasons?: Readonly<Record<string, string>>;
}

export function questionLensSelectionIssue(selection: LensSelection | undefined): string | undefined {
  if (selection === undefined) return undefined;
  if (selection === null || typeof selection !== "object" || Array.isArray(selection)) return "Review lens selection must be an object.";
  const { include, exclude, omission_reasons: reasons } = selection;
  if ((include !== undefined && !Array.isArray(include)) || (exclude !== undefined && !Array.isArray(exclude))) {
    return "Review lens inclusion and exclusion must be arrays.";
  }
  if (reasons !== undefined && (reasons === null || typeof reasons !== "object" || Array.isArray(reasons))) {
    return "Review lens omission reasons must be an object keyed by lens ID.";
  }
  for (const id of [...(include ?? []), ...(exclude ?? []), ...Object.keys(reasons ?? {})]) {
    if (!ReviewLensSchema.safeParse(id).success) {
      return `Review lens '${id}' is not a current built-in or custom:<slug> ID. Reconfirm lens scope before planning.`;
    }
  }
  const explicitlyExcluded = new Set(exclude ?? []);
  const overlap = include?.find((lens) => explicitlyExcluded.has(lens));
  if (overlap !== undefined) return `Review lens '${overlap}' is both included and excluded; reconfirm the intended choice.`;
  const included = new Set(include ?? BUILT_IN_REVIEW_LENSES);
  for (const [id, reason] of Object.entries(reasons ?? {})) {
    if (typeof reason !== "string" || reason.trim().length === 0) return `Review lens '${id}' has no usable omission reason.`;
    if (included.has(id) && !explicitlyExcluded.has(id)) return `Review lens '${id}' is selected; an omission reason belongs to an omitted lens.`;
  }
  return undefined;
}

/**
 * The single selection draw. An explicit allowlist is exact; exclude-only
 * selects the seven built-ins minus exclusions. Undefined asks the planner
 * to choose applicable built-ins from evidence, not to fill up a quota.
 */
export function resolveIntentLensSelection(selection: LensSelection | undefined): string[] | undefined {
  const issue = questionLensSelectionIssue(selection);
  if (issue) throw new Error(issue);
  if (selection?.include === undefined && selection?.exclude === undefined) return undefined;
  const excluded = new Set(selection.exclude ?? []);
  const selected = new Set(selection.include ?? BUILT_IN_REVIEW_LENSES);
  const canonical = BUILT_IN_REVIEW_LENSES.filter((lens) => selected.has(lens) && !excluded.has(lens));
  const custom = [...selected].filter((lens): lens is `custom:${string}` =>
    lens.startsWith("custom:") && !excluded.has(lens));
  return [...canonical, ...custom];
}
