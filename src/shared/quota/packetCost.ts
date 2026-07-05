// Output-envelope packet cost — the reservation amount the admission ledger leases
// for one packet (spec/audit/dispatch-admission-control.md, Resolved decision 1).
//
// A packet's INPUT cost is deterministic (`estimateTokensFromBytes`), but its
// OUTPUT (the findings) is unknown until generated, and output is frequently the
// binding rate-limit constraint. Reserving on input alone systematically
// under-reserves. So a reservation is `input_estimate + output_reservation`, where
// the output reservation is:
//   - the LEARNED output/input ratio for the (resourceKey, lens) once completions
//     have measured it (`input_estimate * ratio`), else
//   - the packet's DECLARED output cap as a cold-start envelope, else
//   - zero (no output signal at all — input-only; the reactive floor still catches
//     any under-reservation).
//
// Pure functions: the caller supplies the learned ratio (from quota-state
// `output_per_input[lens]`) and the declared cap; this module never reads state.

export interface OutputReservationInput {
  /** Deterministic input token estimate for the packet. */
  inputEstimate: number;
  /** Learned output/input ratio for the (resourceKey, lens); null/absent at cold start. */
  learnedRatio?: number | null;
  /** Packet's declared output cap — the cold-start envelope when no ratio is learned. */
  declaredOutputCap?: number | null;
}

export interface PacketCost {
  inputEstimate: number;
  outputReservation: number;
  /** Total reservation the ledger leases: `inputEstimate + outputReservation`. */
  cost: number;
}

function positiveFinite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Resolve the output-token envelope to reserve for a packet. Prefers the learned
 * ratio (measured reality), falls back to the declared cap (cold start), then to 0
 * (no signal). Never throws; a non-positive/non-finite input estimate yields a 0
 * envelope regardless (nothing meaningful to scale).
 */
export function resolveOutputReservation(input: OutputReservationInput): number {
  const inputEstimate = positiveFinite(input.inputEstimate);
  if (inputEstimate === null) return 0;
  const ratio = positiveFinite(input.learnedRatio);
  if (ratio !== null) return inputEstimate * ratio;
  const declared = positiveFinite(input.declaredOutputCap);
  if (declared !== null) return declared;
  return 0;
}

/**
 * The full packet reservation cost: input estimate + output envelope. This is the
 * `cost` the admission ledger leases against a resourceKey's live budget before
 * dispatch; on completion the lease reconciles against actual (input+output) tokens
 * and the learned ratio updates.
 */
export function estimatePacketCost(input: OutputReservationInput): PacketCost {
  const inputEstimate =
    typeof input.inputEstimate === "number" && Number.isFinite(input.inputEstimate) && input.inputEstimate > 0
      ? input.inputEstimate
      : 0;
  const outputReservation = resolveOutputReservation(input);
  return { inputEstimate, outputReservation, cost: inputEstimate + outputReservation };
}
