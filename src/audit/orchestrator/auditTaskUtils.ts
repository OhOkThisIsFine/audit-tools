// sites-pinned: tests/audit/audit-task-utils.test.ts
import type { Lens } from "../types.js";
import { LENS_REGISTRY } from "../types.js";

/** Lens ordering for task prioritization, derived from {@link LENS_REGISTRY}
 * (sorted ascending by `order_weight`). Deriving this from the registry ensures
 * every lens — including `architecture`, which was previously absent from the
 * hardcoded array — is automatically included when added to the registry. */
export const LENS_ORDER: Lens[] = [...LENS_REGISTRY]
  .sort((a, b) => a.order_weight - b.order_weight)
  .map((d) => d.id);

export function sortLenses(lenses: Iterable<string>): string[] {
  const set = new Set(lenses);
  const canonical = LENS_ORDER.filter((lens) => set.has(lens));
  const custom = [...set].filter((l) => !LENS_ORDER.includes(l as Lens)).sort();
  return [...canonical, ...custom];
}
