/**
 * Structural gates for the DesignSpec contract-pipeline artifact.
 *
 * Extracted from contractPipeline.ts to keep gate logic (structural checks,
 * obligation cross-checks, Kahn's topological sort) separate from the
 * per-artifact field validators. MNT-86b18f1b.
 *
 * Re-exported from contractPipeline.ts for backward-compatible imports.
 */
import {
  type ValidationIssue,
  isRecord,
  pushValidationIssue,
} from "@audit-tools/shared";

// ── DesignSpec structural gates ───────────────────────────────────────────────

/**
 * Deterministic structural gates run before the adversarial critic phase.
 * Returns ValidationIssue[] — errors block the pipeline (re-emit design phase),
 * warnings are advisory (appended to the critic prompt). Circular obligation
 * dependency detection yields a warning (not an error) routing to N-R21.
 *
 * Call this with the design_spec payload and, optionally, the obligation_ledger
 * payload for the invariant-coverage cross-check.
 */
export function validateDesignSpecGates(
  designSpec: unknown,
  obligationLedger?: unknown,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isRecord(designSpec)) return issues;

  // Gate 1: every module entry must have non-empty inputs and outputs.
  // Checks both DesignSpec.modules (optional annotation array) and
  // finalized_module_contracts.module_contracts (used when called with the
  // finalized design artifact).
  const moduleEntries: unknown[] = Array.isArray(designSpec.modules)
    ? (designSpec.modules as unknown[])
    : Array.isArray(designSpec.module_contracts)
      ? (designSpec.module_contracts as unknown[])
      : [];
  const moduleFieldName = Array.isArray(designSpec.modules)
    ? "modules"
    : "module_contracts";
  for (const [i, mod] of moduleEntries.entries()) {
    if (!isRecord(mod)) continue;
    if (!Array.isArray(mod.inputs) || mod.inputs.length === 0) {
      pushValidationIssue(
        issues,
        `${moduleFieldName}[${i}].inputs`,
        `${moduleFieldName}[${i}].inputs must be a non-empty array — every module must declare its inputs.`,
      );
    }
    if (!Array.isArray(mod.outputs) || mod.outputs.length === 0) {
      pushValidationIssue(
        issues,
        `${moduleFieldName}[${i}].outputs`,
        `${moduleFieldName}[${i}].outputs must be a non-empty array — every module must declare its outputs.`,
      );
    }
  }

  // Gate 2: every side-effect entry must have a non-empty owner.
  if (Array.isArray(designSpec.side_effects)) {
    for (const [i, se] of (designSpec.side_effects as unknown[]).entries()) {
      if (!isRecord(se)) continue;
      if (typeof se.owner !== "string" || se.owner.length === 0) {
        pushValidationIssue(
          issues,
          `side_effects[${i}].owner`,
          `side_effects[${i}].owner must be a non-empty string — every side effect must have an owner.`,
        );
      }
    }
  }

  // Gate 3: invariant/obligation ledger cross-check.
  // Every invariant in the design_spec must have at least one obligation in the ledger
  // with kind === 'invariant' and whose description or id references the invariant's id.
  if (
    Array.isArray(designSpec.invariants) &&
    isRecord(obligationLedger) &&
    Array.isArray(obligationLedger.obligations)
  ) {
    const obligations = obligationLedger.obligations as unknown[];
    for (const inv of designSpec.invariants as unknown[]) {
      if (!isRecord(inv) || typeof inv.id !== "string") continue;
      const invId = inv.id;
      const covered = obligations.some((obl) => {
        if (!isRecord(obl)) return false;
        if (obl.kind !== "invariant") return false;
        const oblId = typeof obl.id === "string" ? obl.id : "";
        const oblDesc = typeof obl.description === "string" ? obl.description : "";
        // Exact id match or word-boundary containment in description to avoid
        // substring false-positives (e.g. "INV-1" ⊂ "INV-10").
        return oblId === invId || new RegExp(`(?<![\\w-])${invId}(?![\\w-])`).test(oblDesc);
      });
      if (!covered) {
        pushValidationIssue(
          issues,
          `invariants[${invId}]`,
          `Invariant "${invId}" has no verification obligation in the obligation ledger — add an obligation with kind "invariant" that references "${invId}".`,
        );
      }
    }
  }

  // Gate 4: every external_dependency entry must have non-empty failure_semantics.
  if (Array.isArray(designSpec.external_dependencies)) {
    for (const [i, dep] of (designSpec.external_dependencies as unknown[]).entries()) {
      if (!isRecord(dep)) continue;
      if (typeof dep.failure_semantics !== "string" || dep.failure_semantics.length === 0) {
        pushValidationIssue(
          issues,
          `external_dependencies[${i}].failure_semantics`,
          `external_dependencies[${i}].failure_semantics must be a non-empty string — every external dependency must declare its failure semantics.`,
        );
      }
    }
  }

  // Gate 5: every trust_boundary entry must have non-empty untrusted_inputs and validation_ref.
  if (Array.isArray(designSpec.trust_boundaries)) {
    for (const [i, tb] of (designSpec.trust_boundaries as unknown[]).entries()) {
      if (!isRecord(tb)) continue;
      if (!Array.isArray(tb.untrusted_inputs) || tb.untrusted_inputs.length === 0) {
        pushValidationIssue(
          issues,
          `trust_boundaries[${i}].untrusted_inputs`,
          `trust_boundaries[${i}].untrusted_inputs must be a non-empty array — every trust boundary must declare its untrusted inputs.`,
        );
      }
      if (typeof tb.validation_ref !== "string" || tb.validation_ref.length === 0) {
        pushValidationIssue(
          issues,
          `trust_boundaries[${i}].validation_ref`,
          `trust_boundaries[${i}].validation_ref must be a non-empty string — every trust boundary must have a validation reference.`,
        );
      }
    }
  }

  // Gate 6: circular obligation dependency detection (warning, not error).
  // Uses Kahn's algorithm (iterative topological sort).
  if (isRecord(obligationLedger) && Array.isArray(obligationLedger.obligations)) {
    const obligations = obligationLedger.obligations as unknown[];
    const ids = new Set<string>();
    const dependsOnMap = new Map<string, string[]>();
    for (const obl of obligations) {
      if (!isRecord(obl) || typeof obl.id !== "string") continue;
      ids.add(obl.id);
      dependsOnMap.set(
        obl.id,
        Array.isArray(obl.depends_on)
          ? (obl.depends_on as unknown[]).filter((d): d is string => typeof d === "string")
          : [],
      );
    }

    // Build in-degree count and adjacency list (edge: dependency → dependent).
    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();
    for (const id of ids) {
      inDegree.set(id, 0);
      adjacency.set(id, []);
    }
    for (const [id, deps] of dependsOnMap.entries()) {
      for (const dep of deps) {
        if (!ids.has(dep)) continue; // ignore external refs
        adjacency.get(dep)!.push(id);
        inDegree.set(id, (inDegree.get(id) ?? 0) + 1);
      }
    }

    const queue: string[] = [];
    for (const [id, deg] of inDegree.entries()) {
      if (deg === 0) queue.push(id);
    }
    let visited = 0;
    while (queue.length > 0) {
      const node = queue.shift()!;
      visited++;
      for (const next of adjacency.get(node) ?? []) {
        const newDeg = (inDegree.get(next) ?? 0) - 1;
        inDegree.set(next, newDeg);
        if (newDeg === 0) queue.push(next);
      }
    }

    if (visited < ids.size) {
      // Remaining nodes with inDegree > 0 are part of the cycle.
      const cycleIds = [...ids].filter((id) => (inDegree.get(id) ?? 0) > 0);
      issues.push({
        path: "obligation_ledger.obligations",
        message: `Circular interface-definition dependency detected among obligations: [${cycleIds.join(", ")}]; route to N-R21 for resolution`,
        severity: "warning",
      });
    }
  }

  return issues;
}
