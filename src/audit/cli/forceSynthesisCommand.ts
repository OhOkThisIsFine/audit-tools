import { runStepCommand } from "./stepScaffold.js";

/**
 * Deterministically synthesize from the evidence currently accepted by the
 * audit ledger. This recovery command does not invent completion, strand work,
 * or mutate execution state; uncovered tasks remain visible as uncovered.
 */
export async function cmdForceSynthesis(argv: string[]): Promise<void> {
  await runStepCommand(argv, { preferredExecutor: "synthesis_executor" });
}
