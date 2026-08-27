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
import { findFirstCycleWitness } from "../graph/directedCycles.js";

/**
 * Detect cycles in an obligation dependency graph. Returns the IDs of
 * obligations forming the first cycle detected as a witness path with its start
 * repeated at the end (`["A","B","A"]`), or null when the graph is acyclic.
 *
 * A thin draw over the shared directed-cycle core: an obligation that depends
 * on ITSELF is a cycle here (self-loops included), and dependencies naming an
 * id outside the ledger are external references the core ignores.
 *
 * INV-shared-core-07: called at construction time so a cycle is caught early
 * rather than causing an infinite loop or confusing error at scheduling time.
 */
export function detectObligationCycle(
  obligations: readonly ObligationEntry[],
): string[] | null {
  return findFirstCycleWitness(obligations, { includeSelfLoops: true });
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
