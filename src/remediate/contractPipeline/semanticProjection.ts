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
 * (`src/shared/artifactFreshness.ts`): strip non-semantic provenance fields
 * universally, then apply a per-artifact structural projection. The two
 * orchestrators stay in conceptual parity (semantic-projection staleness) while
 * each owns the projection table for its own artifact set.
 */
import { isRecord, stableStringifyProjection } from "audit-tools/shared";
import type { ContractPipelineArtifactName } from "./artifactNames.js";

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

/**
 * The FINALIZED contracts additionally expose `side_effects` as load-bearing:
 * `buildBaselineSymbolCorpus` (`contractPipeline/changeClassification.ts`) draws
 * the baseline symbol corpus from inputs / outputs / side_effects, so the corpus
 * — and therefore every obligation's deterministic change-vs-addition verdict
 * and its CE-006 scope anchors — is a function of the finalized `side_effects`
 * too. Narrowing it away meant a side_effects-only edit projected identically,
 * left the obligation_ledger fresh, and carried stale classification inputs
 * forward (OBL-seam-prep-remediate-core-inv-4 / MNT-4baae04e).
 */
const FINALIZED_MODULE_CONTRACT_FIELDS: readonly string[] = [
  ...DERIVABLE_MODULE_CONTRACT_FIELDS,
  "side_effects",
];

function projectModuleContract(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  const record = isRecord(value) ? value : {};
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    // Skip ABSENT fields rather than projecting them as undefined: a projection
    // must be stable across a JSON round-trip (the review snapshot stores its
    // reviewed_inputs as JSON, and JSON.stringify drops undefined values), so
    // `side_effects: undefined` on the live side would read as an ADDED field
    // against the round-tripped snapshot and fabricate a re-review delta.
    if (record[field] === undefined) continue;
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
  // carry the same module-entry shape; narrow each entry to its derivable fields —
  // plus, at the FINALIZED layer only, `side_effects`, which the baseline symbol
  // corpus reads (see FINALIZED_MODULE_CONTRACT_FIELDS). A reworded per-module
  // rationale / a tweaked non-derivable array (seam_adjustments / neighbor_needs)
  // projects identically while a changed interface / new invariant / side effect
  // does not. Keep every top-level field
  // (contract_version, goal_id, …): the narrowing is per-entry, so any top-level
  // field a downstream might read still participates in staleness.
  if (name === "finalized_module_contracts" || name === "module_contracts") {
    // `side_effects` participates ONLY at the finalized layer (the corpus reads
    // the finalized contracts; the intermediate draft's side_effects is still
    // non-derivable prose — see the pinned narrowing tests).
    const fields =
      name === "finalized_module_contracts"
        ? FINALIZED_MODULE_CONTRACT_FIELDS
        : DERIVABLE_MODULE_CONTRACT_FIELDS;
    if (Array.isArray(stripped.module_contracts)) {
      return normalizeWhitespaceDeep({
        ...stripped,
        module_contracts: stripped.module_contracts.map((entry) =>
          projectModuleContract(entry, fields),
        ),
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
