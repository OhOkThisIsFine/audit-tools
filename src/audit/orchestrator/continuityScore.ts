// Continuity scoring is single-sourced in `audit-tools/shared`
// (`computeContinuityScores`) so the audit and remediate orchestrators bias on
// the IDENTICAL scorer — the auditor/remediator mirroring the harvest core
// (`deriveAccessMemoryFromEvents`) already established. Audit consumes it to bias
// review-packet ordering (`orderReviewPackets`); remediate to bias file-ownership
// sub-wave admission. This re-export keeps audit's import sites stable; the byte-
// identical behaviour is unchanged from the pre-extraction audit-local scorer.
export { computeContinuityScores } from "audit-tools/shared";
