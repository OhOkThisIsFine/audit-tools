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

export function sortLenses(lenses: Iterable<Lens>): Lens[] {
  const set = new Set(lenses);
  return LENS_ORDER.filter((lens) => set.has(lens));
}
