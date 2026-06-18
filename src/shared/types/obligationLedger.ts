/**
 * Obligation ledger construction utilities with cycle detection.
 *
 * INV-shared-core-07: ObligationEntry.depends_on must be cycle-checked at
 * construction time — not deferred to scheduling. This module provides
 * `buildObligationLedger()` which validates the DAG and throws immediately
 * if a dependency cycle is present.
 */

import type {
  ObligationEntry,
  ObligationLedger,
} from "./contractPipeline.js";
import {
  CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
} from "./contractPipeline.js";

/**
 * Detect cycles in an obligation dependency graph using DFS with three-color
 * marking (white/gray/black). Returns the IDs of obligations forming the first
 * cycle detected, or null when the graph is acyclic.
 *
 * INV-shared-core-07: called at construction time so a cycle is caught early
 * rather than causing an infinite loop or confusing error at scheduling time.
 */
export function detectObligationCycle(
  obligations: readonly ObligationEntry[],
): string[] | null {
  const idSet = new Set(obligations.map((o) => o.id));
  const depMap = new Map<string, string[]>();
  for (const o of obligations) {
    depMap.set(o.id, o.depends_on.filter((dep) => idSet.has(dep)));
  }

  // Three-color DFS: 0 = unvisited, 1 = in-stack (gray), 2 = done (black).
  const color = new Map<string, number>();
  const path: string[] = [];

  function dfs(id: string): string[] | null {
    const c = color.get(id) ?? 0;
    if (c === 2) return null; // already done
    if (c === 1) {
      // Cycle detected: return the cycle slice.
      const cycleStart = path.indexOf(id);
      return path.slice(cycleStart).concat(id);
    }
    color.set(id, 1);
    path.push(id);
    for (const dep of depMap.get(id) ?? []) {
      const cycle = dfs(dep);
      if (cycle) return cycle;
    }
    path.pop();
    color.set(id, 2);
    return null;
  }

  for (const o of obligations) {
    const cycle = dfs(o.id);
    if (cycle) return cycle;
  }
  return null;
}

export interface BuildObligationLedgerOptions {
  goal_id: string;
  obligations: ObligationEntry[];
  created_at?: string;
}

/**
 * Build a validated ObligationLedger.
 *
 * Validates the dependency graph for cycles at construction time and throws
 * a descriptive error if any cycle is detected. This enforces
 * INV-shared-core-07: callers cannot produce a ledger with a cyclic
 * depends_on graph — the error is immediate, not deferred to scheduling.
 *
 * @throws {Error} when a depends_on cycle is detected among the obligations.
 */
export function buildObligationLedger(
  options: BuildObligationLedgerOptions,
): ObligationLedger {
  const { goal_id, obligations, created_at } = options;

  const cycle = detectObligationCycle(obligations);
  if (cycle) {
    throw new Error(
      `ObligationLedger construction rejected: dependency cycle detected among obligations: ${cycle.join(" → ")}`,
    );
  }

  return {
    contract_version: CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
    goal_id,
    obligations,
    created_at: created_at ?? new Date().toISOString(),
  };
}
