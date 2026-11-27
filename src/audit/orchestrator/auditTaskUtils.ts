// sites-pinned: tests/audit/audit-task-utils.test.ts
import type { AuditTask, Lens } from "../types.js";
import { LENS_REGISTRY } from "../types.js";

/** Lens ordering for task prioritization, derived from {@link LENS_REGISTRY}
 * (sorted ascending by `order_weight`). Deriving this from the registry ensures
 * every lens — including `architecture`, which was previously absent from the
 * hardcoded array — is automatically included when added to the registry. */
export const LENS_ORDER: Lens[] = [...LENS_REGISTRY]
  .sort((a, b) => a.order_weight - b.order_weight)
  .map((d) => d.id);

export function priorityRank(priority: AuditTask["priority"]): number {
  switch (priority) {
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
    default:
      return 1;
  }
}

/** The lenses whose findings carry the most risk; every priority rule reads this set. */
export const SENSITIVE_LENS_IDS: readonly Lens[] = [
  "security",
  "data_integrity",
  "reliability",
];
/** {@link SENSITIVE_LENS_IDS} as a set a task's (possibly custom) lens name is tested against. */
export const SENSITIVE_LENSES: ReadonlySet<string> = new Set(SENSITIVE_LENS_IDS);

export function sortLenses(lenses: Iterable<string>): string[] {
  const set = new Set(lenses);
  const canonical = LENS_ORDER.filter((lens) => set.has(lens));
  const custom = [...set].filter((l) => !LENS_ORDER.includes(l as Lens)).sort();
  return [...canonical, ...custom];
}
