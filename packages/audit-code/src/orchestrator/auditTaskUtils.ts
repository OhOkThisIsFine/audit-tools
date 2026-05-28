import type { AuditTask, Lens } from "../types.js";

export const LENS_ORDER: Lens[] = [
  "security",
  "correctness",
  "reliability",
  "data_integrity",
  "performance",
  "operability",
  "config_deployment",
  "observability",
  "maintainability",
  "tests",
];

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
