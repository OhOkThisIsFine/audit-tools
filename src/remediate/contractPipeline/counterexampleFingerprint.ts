/**
 * Content fingerprint for a counterexample.
 *
 * The judge↔repair convergence gate ({@link evaluateJudgeGate} in
 * `../steps/contractPipeline.js`) must detect genuine re-occurrence of the
 * same unrepaired defect across independent adversarial rounds. The
 * reviewer-supplied counterexample `id` is free text (see
 * `Counterexample.id` in `audit-tools/shared`'s obligations types) and is NOT
 * a stable cross-round identity: two independent critic rounds each commonly
 * label their genuinely-distinct top counterexample "CE-001" (the prompt
 * schema's own example value). Keying convergence on the raw id string then
 * misreads "two different CEs that happen to share a label" as "the same CE
 * re-accepted after a repair" and falsely escalates a stall while a real new
 * defect is being correctly repaired.
 *
 * This fingerprint keys on CONTENT instead: the tool-constrained
 * `violated_obligation_ids` vocabulary (sorted, normalized) paired with the
 * normalized `claim` prose, falling back to the normalized claim alone when
 * no obligations are cited. Mirrors the derivation style of
 * `src/shared/findingIdentitySignature.ts` (tiered stable fields, aggressive
 * title normalization, truncated content hash) rather than introducing a
 * second identity convention.
 */
import { hashContent, normalizeTitle, type Counterexample } from "audit-tools/shared";

/** Deterministic, content-derived identity for a counterexample. */
export function counterexampleFingerprint(ce: Counterexample): string {
  const obligations = (ce.violated_obligation_ids ?? [])
    .map((id) => id.trim().toLowerCase())
    .filter((id) => id.length > 0)
    .sort();
  const claim = normalizeTitle(ce.claim);
  const key =
    obligations.length > 0
      ? `obligations|${obligations.join(",")}|${claim}`
      : `claim|${claim}`;
  return hashContent(key, { length: 8 });
}
