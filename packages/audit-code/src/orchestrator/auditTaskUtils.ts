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

/**
 * Deterministic seed for a task's provider-neutral audit-risk estimate in
 * [0,1]. Derived from the same signals the (legacy) model-tier hint used —
 * priority, sensitive lens, critical-flow / analyzer / verification tags — so
 * planning produces a frozen risk number that just-in-time dispatch can route
 * on without re-deriving. The estimate-review step (N3) may refine this; it is
 * never a model/provider decision. See
 * docs/capability-discovery-and-tiered-dispatch-design.md.
 */
const SENSITIVE_LENSES = new Set(["security", "data_integrity", "reliability"]);

export function computeRiskEstimate(task: AuditTask): number {
  const base =
    task.priority === "high" ? 0.7 : task.priority === "medium" ? 0.4 : 0.15;
  const tags = task.tags ?? [];
  let bonus = 0;
  if (tags.some((t) => t === "critical_flow" || t.startsWith("critical_flow:"))) {
    bonus += 0.15;
  }
  if (
    tags.some(
      (t) => t === "external_analyzer_signal" || t.startsWith("external_tool:"),
    )
  ) {
    bonus += 0.1;
  }
  if (tags.includes("lens_verification")) bonus += 0.1;
  if (SENSITIVE_LENSES.has(task.lens)) bonus += 0.1;
  const score = base + bonus;
  return score < 0 ? 0 : score > 1 ? 1 : score;
}

export function sortLenses(lenses: Iterable<string>): string[] {
  const set = new Set(lenses);
  const canonical = LENS_ORDER.filter((lens) => set.has(lens));
  const custom = [...set].filter((l) => !LENS_ORDER.includes(l as Lens)).sort();
  return [...canonical, ...custom];
}
