/**
 * The ONE field vocabulary of a module contract, at both layers.
 *
 * A module contract's shape was spelled out by hand in THREE places: the
 * finalizer's object literal (`derive.ts`, `deriveFinalizedModuleContracts`),
 * the defensive reader's field-by-field narrowing (`derive.ts`,
 * `readFinalizedContracts`), and the staleness projection's narrowing
 * (`semanticProjection.ts`, `DERIVABLE_MODULE_CONTRACT_FIELDS`). They had
 * already drifted — the finalizer wrote eight fields, the reader read seven,
 * and nothing made the difference (`seam_adjustments`, which finalization
 * DERIVES and no deterministic consumer reads) legible as intentional rather
 * than as a dropped field. A field added to the finalizer and forgotten in the
 * reader is a silent narrowing of everything downstream of the ledger.
 *
 * The vocabulary is therefore stated once, here, beside the finalizer that
 * writes it — with the two DISTINCTIONS the three copies were groping at made
 * explicit, because they are real:
 *
 *   - {@link COPIED_MODULE_CONTRACT_FIELDS} are copied verbatim from the drafted
 *     contract. They are the load-bearing interface, and they are what a
 *     deterministic consumer may read.
 *   - {@link DERIVED_MODULE_CONTRACT_FIELDS} are computed by finalization from
 *     the seam reconciliation report. No deterministic consumer reads them, so
 *     they are excluded from the staleness projection — a re-agreed seam
 *     changes `seam_adjustments` without changing any obligation.
 *
 * Anything that must know a module contract's field set reads it from here.
 */
import { compareCodeUnits } from "../../shared/compareCodeUnits.js";

/**
 * Fields finalization COPIES VERBATIM from the drafted module contract, in
 * canonical order. This is the load-bearing interface: `deriveObligationLedger`
 * derives the obligation set and test-plan premises from it, and
 * `buildBaselineSymbolCorpus` (`changeClassification.ts`) builds the
 * change-vs-addition corpus from the declared surface — `inputs`, `outputs`,
 * `side_effects`, `validation_boundary` — so a side_effects-only edit is
 * exactly as load-bearing as an interface edit.
 */
export const COPIED_MODULE_CONTRACT_FIELDS = [
  "name",
  "inputs",
  "outputs",
  "invariants",
  "side_effects",
  "validation_boundary",
  "failure_modes",
] as const;

/**
 * Fields finalization DERIVES from the seam reconciliation report rather than
 * copying. Excluded from the staleness projection: a re-agreed seam is not a
 * change to the interface any downstream consumes.
 */
export const DERIVED_MODULE_CONTRACT_FIELDS = ["seam_adjustments"] as const;

/**
 * Every field a finalized module contract carries — copied first, derived
 * second. The finalizer builds exactly this key set, and the reader reads
 * exactly this key set; they are two draws over one list rather than two
 * lists that happen to agree.
 */
export const FINALIZED_MODULE_CONTRACT_FIELDS: readonly string[] = [
  ...COPIED_MODULE_CONTRACT_FIELDS,
  ...DERIVED_MODULE_CONTRACT_FIELDS,
].sort(compareCodeUnits);

/**
 * The fields the staleness projection narrows a module entry to — the COPIED
 * set alone (see this module's header for why `seam_adjustments` is excluded).
 * Exported under the name `semanticProjection.ts` already used, so the
 * projection reads the shared vocabulary instead of owning a third copy.
 */
export const DERIVABLE_MODULE_CONTRACT_FIELDS: readonly string[] = [
  ...COPIED_MODULE_CONTRACT_FIELDS,
];

/**
 * The runtime shape of a finalized module entry as the deterministic derivers
 * read it — `name` is required and always a string; the array fields are read
 * through a defensive `string[]` coercion; `validation_boundary` is a string.
 * `seam_adjustments` is deliberately absent: no deriver reads it.
 *
 * The field NAMES here are the compiler-checked twin of
 * {@link COPIED_MODULE_CONTRACT_FIELDS}; the `satisfies` clause below is what
 * keeps the two from drifting, which is the whole point of this module.
 */
export interface DerivableModuleContract {
  name: string;
  inputs: string[];
  outputs: string[];
  invariants: string[];
  failure_modes: string[];
  side_effects: string[];
  validation_boundary: string;
}

type ContractFieldNames<T> = Extract<keyof T, string>;

// COMPILE-TIME drift guard. If a field is added to either side — the runtime
// list or the interface — the mutual-assignability requirement below fails and
// the build names the mismatch, instead of the two silently diverging the way
// the three hand-written copies did.
type ListedButNotTyped = Exclude<
  (typeof COPIED_MODULE_CONTRACT_FIELDS)[number],
  ContractFieldNames<DerivableModuleContract>
>;
type TypedButNotListed = Exclude<
  ContractFieldNames<DerivableModuleContract>,
  (typeof COPIED_MODULE_CONTRACT_FIELDS)[number]
>;
const _everyListedFieldIsTyped: ListedButNotTyped extends never ? true : never = true;
const _everyTypedFieldIsListed: TypedButNotListed extends never ? true : never = true;
void _everyListedFieldIsTyped;
void _everyTypedFieldIsListed;
