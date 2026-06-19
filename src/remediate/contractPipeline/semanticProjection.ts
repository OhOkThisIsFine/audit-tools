/**
 * Semantic projection for contract-pipeline staleness (B3).
 *
 * The staleness DAG used to key every dependency on the upstream's RAW payload
 * content hash, so any byte change to an upstream — a reworded rationale, a
 * regenerated `created_at` stamp, a reordered list — re-staled the entire
 * downstream chain and forced a full (often LLM-driven) re-authoring of
 * artifacts whose load-bearing inputs had not actually changed. That is the
 * exact friction B3 names: "an edit to finalized_module_contracts re-stales
 * obligation_ledger → test_validator_plan → contract_assessment even when the
 * obligation set is unchanged."
 *
 * The fix is to make staleness content/semantics-aware: a dependency is recorded
 * and compared by the hash of its *semantic projection* — only the structure a
 * downstream actually consumes — not its raw bytes. A cosmetic upstream edit
 * projects to the same value, so downstreams stay fresh; a real change to the
 * load-bearing structure (a new module invariant, a changed interface) projects
 * differently and correctly re-stales.
 *
 * This mirrors audit-code's `normalizeForMetadataHash`
 * (`orchestrator/artifactFreshness.ts`): strip non-semantic provenance fields
 * universally, then apply a per-artifact structural projection. The two
 * orchestrators stay in conceptual parity (semantic-projection staleness) while
 * each owns the projection table for its own artifact set.
 */
import { isRecord, stableStringifyProjection } from "audit-tools/shared";
import type { ContractPipelineArtifactName } from "./artifactStore.js";

export { stableStringifyProjection };

/**
 * Non-semantic top-level fields stripped from EVERY artifact before projecting.
 * These are provenance (wall-clock stamps), never meaning: re-deriving the
 * obligation ledger or re-emitting any artifact mints a fresh `created_at`, and
 * without stripping it the artifact's hash churns on every rebuild and
 * perpetually re-stales its downstreams — a finalization-oscillation hazard.
 */
const UNIVERSAL_NON_SEMANTIC_FIELDS: readonly string[] = ["created_at", "generated_at"];

/**
 * The finalized-module-contract fields that are load-bearing for ALL of its
 * downstreams. These are exactly the fields `deriveObligationLedger` consumes
 * (`contractPipeline/derive.ts`): the obligation set, the test plan, the
 * conceptual critique, and the contract assessment all reason about the module
 * boundaries, interfaces, invariants, and failure modes — never the surrounding
 * rationale/narrative/seam prose. Projecting to these fields means a pure-prose
 * edit to the finalized contracts leaves the whole obligation-bearing chain
 * fresh, while a changed interface or a new invariant correctly re-stales it.
 */
const DERIVABLE_MODULE_CONTRACT_FIELDS: readonly string[] = [
  "name",
  "inputs",
  "outputs",
  "invariants",
  "failure_modes",
  "validation_boundary",
];

function stripFields(
  record: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  const drop = new Set(fields);
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => !drop.has(key)),
  );
}

function projectModuleContract(value: unknown): Record<string, unknown> {
  const record = isRecord(value) ? value : {};
  const out: Record<string, unknown> = {};
  for (const field of DERIVABLE_MODULE_CONTRACT_FIELDS) {
    out[field] = record[field];
  }
  return out;
}

/**
 * Collapse cosmetic whitespace in every projected string (trim + runs → single
 * space), recursively. A reflow / trailing-space / indentation edit to a contract
 * field is not a semantic change, but without this it churns the projection hash
 * and re-stales the downstream chain. Safe: the downstream gates/derivers match on
 * word boundaries and substrings, which whitespace normalization never alters.
 */
function normalizeWhitespaceDeep(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (Array.isArray(value)) return value.map(normalizeWhitespaceDeep);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) out[key] = normalizeWhitespaceDeep(v);
    return out;
  }
  return value;
}

/**
 * Project a contract-pipeline artifact payload to only its load-bearing
 * structure for downstream-staleness purposes. The universal provenance strip
 * applies to every artifact; `finalized_module_contracts` additionally projects
 * its `module_contracts` to the derivable fields. Artifacts with no special case
 * fall back to the provenance-stripped payload (conservative: behaves like the
 * raw payload minus stamps).
 *
 * Non-object payloads pass through unchanged.
 */
export function semanticProjection(
  name: ContractPipelineArtifactName,
  payload: unknown,
): unknown {
  if (!isRecord(payload)) return payload;
  const stripped = stripFields(payload, UNIVERSAL_NON_SEMANTIC_FIELDS);

  // Both the intermediate `module_contracts` and the `finalized_module_contracts`
  // carry the same module-entry shape; narrow each entry to its derivable fields for
  // BOTH so a reworded per-module rationale / a tweaked non-derivable array
  // (side_effects / seam_adjustments / neighbor_needs) projects identically while a
  // changed interface / new invariant does not. Keep every top-level field
  // (contract_version, goal_id, …): the narrowing is per-entry, so any top-level
  // field a downstream might read still participates in staleness.
  if (name === "finalized_module_contracts" || name === "module_contracts") {
    if (Array.isArray(stripped.module_contracts)) {
      return normalizeWhitespaceDeep({
        ...stripped,
        module_contracts: stripped.module_contracts.map(projectModuleContract),
      });
    }
    return normalizeWhitespaceDeep(stripped);
  }

  return normalizeWhitespaceDeep(stripped);
}

/**
 * The order-independent stable serialization used to hash a projection is the
 * shared `stableStringifyProjection` (re-exported above) — single-sourced in
 * `audit-tools/shared` so audit-code and remediate-code hash projections
 * identically.
 */
