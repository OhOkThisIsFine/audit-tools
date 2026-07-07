/**
 * Deterministic derivers for contract-pipeline artifacts.
 *
 * S1 of the contract-authoring determinism design
 * (`spec/contract-authoring-determinism-design.md`): the contract pipeline
 * historically had the LLM author every structured artifact and the backend
 * only validate it afterward. For the artifacts whose *structure* is a pure
 * function of an upstream artifact, that is wasted generation and a weak-model
 * failure surface ("emit a large, schema-conforming, internally-consistent JSON
 * artifact from scratch with correct ids and cross-refs"). This module owns
 * those derivations so the tool produces the structure and the model is left
 * only the irreducible judgment.
 *
 * `deriveObligationLedger` is the flagship: the obligation ledger is a 1:1
 * restructuring of the finalized module contracts — every module invariant and
 * failure mode becomes an obligation, and every module gets a
 * contract-conformance obligation — so no judgment is lost by generating it in
 * code. Construction goes through the shared `buildObligationLedger` so the
 * cycle check, version stamp, and envelope stay single-sourced with the rest of
 * the codebase (the non-negotiable "derivers and validators share one source —
 * no parallel logic").
 */
import {
  buildObligationLedger,
  isRecord,
  mintUniqueId,
  type ObligationEntry,
  type ObligationLedger,
} from "audit-tools/shared";
import {
  buildBaselineSymbolCorpus,
  classifyObligationChange,
  obligationScopeAnchors,
  readObligationChangeClassification,
} from "./changeClassification.js";
import { derivePhaseCut, phaseCutModulesFromContracts } from "./phaseCut.js";
import { payloadSemanticHash } from "./artifactStore.js";
import { CP_FINALIZED_MODULE_CONTRACTS_VERSION } from "../validation/contractPipeline.js";

/** The finalized-module-contract fields the obligation deriver reads. */
interface DerivableModuleContract {
  name: string;
  inputs: string[];
  outputs: string[];
  invariants: string[];
  failure_modes: string[];
  validation_boundary: string;
}

interface DerivableFinalizedContracts {
  goal_id: string;
  module_contracts: DerivableModuleContract[];
}

/** Options accepted by the derivers (created_at injected for deterministic tests). */
export interface DeriveOptions {
  /** Overrides the generated ISO-8601 timestamp (for deterministic snapshots). */
  created_at?: string;
}

/**
 * Derive the obligation ledger deterministically from the finalized module
 * contracts. Pure function of its input (modulo the `created_at` stamp): the
 * same contracts always yield the same obligations in the same order, so the
 * artifact hash / staleness DAG stays well-behaved.
 *
 * Mapping (the inverse of the obligation-ledger consumers' expectations):
 *  - one **structural** obligation per module ("implement this module per its
 *    finalized contract") — guarantees the ledger is never empty and every
 *    module has something the implementation DAG must cover, without inventing
 *    a paired-test burden (structural is not a testable kind);
 *  - one **invariant** obligation per declared module invariant (testable);
 *  - one **behavioral** obligation per declared module failure mode (testable).
 *
 * `depends_on` is left empty: the validated module-contract shape declares no
 * inter-obligation ordering, so an honest derivation asserts none (and the
 * ledger is acyclic by construction — `buildObligationLedger` cannot throw).
 */
export function deriveObligationLedger(
  finalizedModuleContracts: unknown,
  options: DeriveOptions = {},
): ObligationLedger {
  const finalized = readFinalizedContracts(finalizedModuleContracts);
  const usedIds = new Set<string>();
  const obligations: ObligationEntry[] = [];

  // DC-5: baseline corpus of pre-existing symbols, built once from the declared
  // interface surface. A testable obligation that references a symbol in here is
  // classified a behavior CHANGE (deterministic FIRST pass); otherwise an
  // ADDITION. The verdict is recorded on each obligation so the paired-test gate
  // is driven by data, not by render-only prose (CE-013).
  const baselineSymbols = buildBaselineSymbolCorpus(finalizedModuleContracts);

  for (const mod of finalized.module_contracts) {
    const base = slug(mod.name) || "module";

    // Contract-conformance obligation — represents the module even when it
    // declares no invariants/failure modes (structural kind → not testable).
    obligations.push({
      id: mintUniqueId(usedIds, `OBL-${base}-contract`),
      description:
        `Implement module "${mod.name}" per its finalized contract ` +
        `(inputs: ${fmtList(mod.inputs)} → outputs: ${fmtList(mod.outputs)}; ` +
        `validation boundary: ${mod.validation_boundary || "n/a"}).`,
      kind: "structural",
      depends_on: [],
      status: "pending",
      source: "design_spec",
      module: mod.name,
    });

    mod.invariants.forEach((invariant, i) => {
      obligations.push({
        id: mintUniqueId(usedIds, `OBL-${base}-inv-${i + 1}`),
        description: invariant,
        kind: "invariant",
        depends_on: [],
        status: "pending",
        source: "design_spec",
        module: mod.name,
        change_classification: classifyObligationChange(invariant, baselineSymbols),
      });
    });

    mod.failure_modes.forEach((failureMode, j) => {
      obligations.push({
        id: mintUniqueId(usedIds, `OBL-${base}-fail-${j + 1}`),
        description: `Handle failure mode: ${failureMode}`,
        kind: "behavioral",
        depends_on: [],
        status: "pending",
        source: "design_spec",
        module: mod.name,
        change_classification: classifyObligationChange(failureMode, baselineSymbols),
      });
    });
  }

  return buildObligationLedger({
    goal_id: finalized.goal_id,
    obligations,
    created_at: options.created_at,
  });
}

// ── Finalized module contracts (deterministic attach) ─────────────────────────
//
// `contract_finalization` is a mechanical merge, not fresh authoring: it takes
// the drafted module contracts and the seam-reconciliation decisions and, per
// module, carries the draft interface verbatim while attaching the
// `agreed_interface` of every seam that touches the module as a `seam_adjustment`.
// No source is re-read and no judgment is spent — the judgment already happened
// upstream (the seam_reconciliation phase decided each mismatch's resolution).
// Attaching each agreed interface verbatim guarantees the reconciliation-derivation
// gate (INV-CO-12) passes, since its corpus is the union of every module's
// inputs/outputs/invariants/side_effects/seam_adjustments/validation_boundary.
//
// `neighbor_needs` is PRESERVED from the draft (the finalized schema tolerates the
// extra field): it is one of the two module-dependency signals `phaseCutModules
// FromContracts` / `applyModuleDependencyEdges` read (unioned with `artifact:<name>`
// producer/consumer tokens), so preserving it keeps the phase cut and node
// ordering intact without the tool having to synthesize artifact tokens. A weaker
// draft that leaves inputs/outputs empty, or a seam report referencing a module
// not in scope, surfaces at the downstream design/reconciliation gate and routes
// to an LLM re-author of `contract_finalization` — the only path that still needs
// judgment.

/** The seam-reconciliation `agreed_interface`s that touch a given module name. */
function seamAdjustmentsForModule(
  moduleName: string,
  seamReconciliationReport: unknown,
): string[] {
  const mismatches =
    isRecord(seamReconciliationReport) && Array.isArray(seamReconciliationReport.mismatches)
      ? seamReconciliationReport.mismatches
      : [];
  const adjustments: string[] = [];
  for (const mismatch of mismatches) {
    if (!isRecord(mismatch)) continue;
    if (mismatch.module_a !== moduleName && mismatch.module_b !== moduleName) continue;
    const resolution = isRecord(mismatch.resolution) ? mismatch.resolution : undefined;
    const agreed =
      resolution && typeof resolution.agreed_interface === "string"
        ? resolution.agreed_interface
        : "";
    if (agreed.length === 0) continue;
    const seamId = typeof mismatch.seam_id === "string" ? mismatch.seam_id : "";
    adjustments.push(seamId ? `${seamId}: ${agreed}` : agreed);
  }
  return adjustments;
}

/**
 * Derive `finalized_module_contracts` deterministically from the drafted
 * `module_contracts` and the `seam_reconciliation_report`. Pure function of its
 * inputs (modulo the `created_at` stamp): the same drafts + seam report always
 * yield the same finalized contracts in draft order, so the artifact hash /
 * staleness DAG stays well-behaved.
 *
 * Each finalized entry copies the draft's interface fields verbatim (already
 * validated `string[]` / string shapes, so no coercion is needed) and PRESERVES
 * `neighbor_needs` for the ordering derivation, then sets `seam_adjustments` to
 * the `agreed_interface`(s) of the seams that touch the module. A draft entry
 * that is not an object is passed through unchanged (the downstream validator
 * reports it).
 */
export function deriveFinalizedModuleContracts(
  draftedModuleContracts: unknown,
  seamReconciliationReport: unknown,
  options: DeriveOptions = {},
): {
  contract_version: string;
  goal_id: string;
  module_contracts: unknown[];
  created_at: string;
} {
  const goalId =
    isRecord(draftedModuleContracts) && typeof draftedModuleContracts.goal_id === "string"
      ? draftedModuleContracts.goal_id
      : "";
  const drafts =
    isRecord(draftedModuleContracts) && Array.isArray(draftedModuleContracts.module_contracts)
      ? draftedModuleContracts.module_contracts
      : [];
  const module_contracts = drafts.map((mod) => {
    if (!isRecord(mod) || typeof mod.name !== "string") return mod;
    const finalized: Record<string, unknown> = {
      name: mod.name,
      inputs: mod.inputs,
      outputs: mod.outputs,
      invariants: mod.invariants,
      side_effects: mod.side_effects,
      validation_boundary: mod.validation_boundary,
      failure_modes: mod.failure_modes,
      seam_adjustments: seamAdjustmentsForModule(mod.name, seamReconciliationReport),
    };
    // Preserve the draft's directional neighbor edges when present — one of the
    // two module-dependency signals the phase-cut / DAG ordering derivation reads.
    if (Array.isArray(mod.neighbor_needs)) finalized.neighbor_needs = mod.neighbor_needs;
    return finalized;
  });
  return {
    contract_version: CP_FINALIZED_MODULE_CONTRACTS_VERSION,
    goal_id: goalId,
    module_contracts,
    created_at: options.created_at ?? new Date().toISOString(),
  };
}

// ── Scaffolds (S3): skeletons for the partially-derivable artifacts ────────────
//
// The test plan and implementation DAG have an irreducible judgment slot
// (assertion text; node title/description/commands) so they cannot be derived
// in full. Instead the tool derives their SKELETON — structure, ids, and
// cross-references populated, only the judgment fields blank — and shows it to
// the model so it fills just those slots and cannot drop, misname, or
// mis-reference an obligation. These are NOT writable artifacts: the blank
// fields fail validation by design (that is the point — the model must fill
// them). They are rendered into the dispatch prompt as a pre-filled skeleton.

// NOTE(follow-up unification): this testable-kind set is duplicated in
// `../validation/contractPipelineGates.ts` (~438, `TESTABLE_OBLIGATION_KINDS`).
// The two should be single-sourced; for now they are kept in parity by hand.
// Do NOT edit gates.ts here — that unification is tracked separately.
const TESTABLE_KINDS = new Set(["invariant", "behavioral"]);

/**
 * Shared obligation-membership predicates — the single source for which
 * obligations each downstream scaffold covers.
 *
 * `isTestablePhaseObligation`: testable (invariant/behavioral) → true; the
 * structural contract-conformance kind → false; an unknown/unexpected kind →
 * conservatively true (fail-OPEN into the paired-test gate rather than silently
 * skipping coverage).
 *
 * `isDagPhaseObligation`: every obligation is covered by the implementation DAG,
 * so this is always true. It exists so both scaffolds derive their membership
 * from a named predicate rather than an inline ad-hoc filter.
 */
export function isTestablePhaseObligation(kind: string): boolean {
  if (TESTABLE_KINDS.has(kind)) return true;
  if (kind === "structural") return false;
  return true; // unknown kind → conservatively testable
}

export function isDagPhaseObligation(_kind: string): boolean {
  return true;
}

/** A short, stable test name from an obligation description. */
function scaffoldName(obligation: ObligationEntry): string {
  const text = obligation.description.replace(/\s+/g, " ").trim();
  if (!text) return obligation.id;
  return text.length > 64 ? `${text.slice(0, 61)}...` : text;
}

export interface TestValidatorPlanScaffold {
  test_specs: Array<{
    obligation_id: string;
    name: string;
    kind: string;
    /**
     * The change's scope anchors (touched symbols / file) the negative assertion
     * must name to pass the CE-006 negative-scoping gate. Derived here so the
     * host sees them IN the skeleton instead of discovering them only after a
     * write is rejected (D1). Advisory context — the host reads them, the gate
     * enforces them; an empty array means no change-scope constraint applies.
     */
    scope_anchors: string[];
    assertions: string[];
  }>;
}

/**
 * A prior round's authored test spec, keyed by obligation_id, used to diff-carry
 * unchanged assertions across a re-emit (C3). Carries the identity signals
 * (`name` + `scope_anchors`) the carry decision is gated on plus the assertions.
 */
export interface PriorTestSpec {
  name: string;
  scope_anchors: string[];
  assertions: string[];
}

function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((x) => setB.has(x));
}

/**
 * Build the test-plan skeleton: one spec per *testable* (invariant/behavioral)
 * obligation, with `obligation_id`/`name`/`kind`/`scope_anchors` filled and
 * `assertions` left blank for the model. The model fills only the assertions
 * (each spec needs a paired positive + negative assertion per the OBL-CO-01
 * gate, and the negative must name one of `scope_anchors` per CE-006).
 *
 * C3 diff-carry: when `priorByObligation` carries a prior round's authored spec
 * for an obligation whose premise is UNCHANGED (same `name` + same
 * `scope_anchors`), its assertions are pre-filled instead of left blank, so an
 * unchanged obligation is not re-authored from scratch every repair round. A
 * changed premise (renamed/re-scoped obligation) carries nothing — the host
 * re-authors it (fail-safe toward re-author, never toward stale carry).
 */
export function buildTestValidatorPlanScaffold(
  ledger: ObligationLedger | undefined,
  priorByObligation: Record<string, PriorTestSpec> = {},
): TestValidatorPlanScaffold {
  const obligations = ledger?.obligations ?? [];
  return {
    test_specs: obligations
      .filter((o) => isTestablePhaseObligation(o.kind))
      .map((o) => {
        const name = scaffoldName(o);
        const scope_anchors = obligationScopeAnchors(
          o.id,
          o.description,
          readObligationChangeClassification(o),
        );
        const prior = priorByObligation[o.id];
        const carried =
          prior &&
          prior.name === name &&
          sameStringSet(prior.scope_anchors, scope_anchors) &&
          prior.assertions.length > 0
            ? [...prior.assertions]
            : [];
        return {
          obligation_id: o.id,
          name,
          kind: o.kind === "invariant" ? "invariant" : "unit",
          scope_anchors,
          assertions: carried,
        };
      }),
  };
}

export interface ImplementationDagScaffoldNode {
  id: string;
  title: string;
  description: string;
  satisfies_obligations: string[];
  addresses_counterexamples: string[];
  /**
   * Advisory conceptual-critique item ids this node addresses (B3). The
   * conceptual-design critique's `advisory`-severity items have no obligation or
   * counterexample to attach to, so without a structural slot the host smuggles
   * them into prose or test assertions. This carrier gives each one a first-class
   * home: the host records which advisory items a node's implementation honours.
   * Blank in the skeleton (the host fills it); advisory, so it is not gated.
   */
  addressed_critique_items: string[];
  depends_on: string[];
  verification_obligation_ids: string[];
  targeted_commands: string[];
  status: string;
}

/** An advisory conceptual-critique item the host should account for in the DAG. */
export interface AdvisoryCritiqueItem {
  id: string;
  description: string;
}

/**
 * Advisory-severity items from a conceptual_design_critique payload (defensive
 * read). Blocking items drive the design-repair loop and are consumed there;
 * advisory items survive past the critique gate and need a structural home in
 * the implementation DAG — this surfaces them so the skeleton can list them (B3).
 */
export function advisoryCritiqueItems(critique: unknown): AdvisoryCritiqueItem[] {
  const items =
    isRecord(critique) && Array.isArray(critique.items) ? critique.items : [];
  return items
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .filter((item) => item.severity === "advisory")
    .map((item) => ({
      id: typeof item.id === "string" ? item.id : "",
      description: typeof item.description === "string" ? item.description : "",
    }))
    .filter((item) => item.id.length > 0);
}

export interface ImplementationDagScaffold {
  nodes: ImplementationDagScaffoldNode[];
  edges: never[];
}

/** Accepted counterexample ids from a judge_report payload (defensive read). */
export function acceptedCounterexampleIds(judgeReport: unknown): string[] {
  const record = isRecord(judgeReport) ? judgeReport : {};
  const classifications = Array.isArray(record.classifications)
    ? record.classifications
    : [];
  const ids: string[] = [];
  for (const cls of classifications) {
    if (
      isRecord(cls) &&
      cls.classification === "accepted" &&
      typeof cls.counterexample_id === "string"
    ) {
      ids.push(cls.counterexample_id);
    }
  }
  return ids;
}

/**
 * Build the implementation-DAG skeleton: ONE node per finalized *module*
 * (grouping all that module's obligations), blank title/description/
 * targeted_commands for the model, and accepted counterexamples attached so
 * coverage holds by construction. Grouping by module means a 1-module change
 * derives 1 node instead of N obligation-nodes the host then has to merge (B2);
 * obligations with no module home (counterexample/critique-sourced) fall back
 * to one node each. Advisory: the model fills the blanks and may further
 * merge/split nodes as long as coverage is preserved.
 *
 * `depends_on` is DERIVED, not left for the host: when `finalizedContracts` is
 * supplied, each module node depends on the nodes of the modules it needs first
 * (producer/consumer `artifact:<name>` matching over `inputs`/`outputs`, unioned
 * with `neighbor_needs` — the same module-dependency DAG `phase_cut` uses). This
 * makes cross-node ordering tool-enforced instead of a thing the host must
 * remember to hand-add. Edges are oriented by phase ordinal so the result is
 * acyclic by construction: only an edge to a strictly-earlier-phase module is
 * kept, which drops the back-edge of any dependency cycle (fail-toward-later,
 * mirroring `derivePhaseCut`). The `edges` array stays empty — node `depends_on`
 * is the ordering the block promotion reads.
 */
export function buildImplementationDagScaffold(
  ledger: ObligationLedger | undefined,
  acceptedCeIds: string[],
  finalizedContracts?: unknown,
): ImplementationDagScaffold {
  const obligations = (ledger?.obligations ?? []).filter((o) =>
    isDagPhaseObligation(o.kind),
  );
  // Group by module in first-appearance order; obligations with no module key
  // on their own id (one node each, preserving coverage).
  const groups: Array<{ key: string; obligations: ObligationEntry[] }> = [];
  const groupIndex = new Map<string, number>();
  for (const o of obligations) {
    const key = o.module ? `module:${o.module}` : `obligation:${o.id}`;
    let idx = groupIndex.get(key);
    if (idx === undefined) {
      idx = groups.length;
      groupIndex.set(key, idx);
      groups.push({ key, obligations: [] });
    }
    groups[idx].obligations.push(o);
  }
  const nodes: ImplementationDagScaffoldNode[] = groups.map((g, i) => {
    const ids = g.obligations.map((o) => o.id);
    return {
      id: `CP-NODE-${i + 1}`,
      title: "",
      description: "",
      satisfies_obligations: [...ids],
      addresses_counterexamples: [],
      addressed_critique_items: [],
      depends_on: [],
      verification_obligation_ids: [...ids],
      targeted_commands: [],
      status: "pending",
    };
  });

  applyModuleDependencyEdges(nodes, groups, finalizedContracts);

  if (acceptedCeIds.length > 0) {
    if (nodes.length === 0) {
      nodes.push({
        id: "CP-NODE-1",
        title: "",
        description: "",
        satisfies_obligations: [],
        addresses_counterexamples: [...acceptedCeIds],
        addressed_critique_items: [],
        depends_on: [],
        verification_obligation_ids: [],
        targeted_commands: [],
        status: "pending",
      });
    } else {
      nodes[0].addresses_counterexamples = [...acceptedCeIds];
    }
  }

  return { nodes, edges: [] };
}

/**
 * Fill each module node's `depends_on` from the finalized contracts'
 * module-dependency DAG (producer/consumer artifact tokens ∪ neighbor_needs), the
 * SAME source `phase_cut` uses so the node ordering and the phase barrier agree.
 * Only a group keyed on a real module can be a dependency target (obligation- and
 * counterexample-only nodes have no module home). Edges are oriented by phase
 * ordinal — kept only when the dependency module sits in a strictly-earlier phase
 * — so a dependency cycle contributes no back-edge and the result is acyclic by
 * construction. No-op when contracts are absent (existing behaviour: no edges).
 */
function applyModuleDependencyEdges(
  nodes: ImplementationDagScaffoldNode[],
  groups: Array<{ key: string; obligations: ObligationEntry[] }>,
  finalizedContracts: unknown,
): void {
  if (finalizedContracts === undefined || finalizedContracts === null) return;
  // module name → node id (1 node per module by construction).
  const moduleToNodeId = new Map<string, string>();
  groups.forEach((g, i) => {
    if (g.key.startsWith("module:")) {
      moduleToNodeId.set(g.key.slice("module:".length), nodes[i].id);
    }
  });
  if (moduleToNodeId.size === 0) return;

  const phaseModules = phaseCutModulesFromContracts(finalizedContracts);
  const depsByModule = new Map(phaseModules.map((m) => [m.name, m.depends_on]));
  const phaseOf = derivePhaseCut(phaseModules).module_phase;
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  for (const [moduleName, nodeId] of moduleToNodeId) {
    const node = nodeById.get(nodeId);
    if (!node) continue;
    const deps = new Set<string>();
    for (const depModule of depsByModule.get(moduleName) ?? []) {
      const depNodeId = moduleToNodeId.get(depModule);
      if (!depNodeId || depNodeId === nodeId) continue;
      if ((phaseOf[depModule] ?? 0) < (phaseOf[moduleName] ?? 0)) deps.add(depNodeId);
    }
    node.depends_on = [...deps].sort();
  }
}

// ── Incremental reconvergence: item-scoped re-validation (INV-IR-1 / IR-4) ─────
//
// contract-incremental-reconvergence. When a localized upstream change re-stales a
// downstream artifact, only the items deriving from the changed upstream item need
// re-validation — the rest carry forward verbatim. The provenance key is
// `ObligationEntry.module` for obligations and `obligation_id` for test specs.
//
// Fail-closed everywhere: an item whose provenance key cannot be established (no
// `module`; a spec with no `obligation_id`; an id absent from the prior payload), or
// whose `module` resolves to a name absent from the CURRENT upstream (re-slug / id
// reuse → a wrong/nonexistent upstream item), falls into the FULL re-validation set.
// Scoping must never UNDER-invalidate: a silently-missed real staleness is the worst
// outcome (failure_mode "Under-invalidation").

/** The per-item re-validation decision: which items re-validate vs. carry forward. */
export interface ItemRevalidationScope {
  /** Item ids (obligation id / obligation_id) that must be re-validated. */
  revalidate: string[];
  /** Item ids whose provenance resolves to an UNCHANGED upstream item (carry verbatim). */
  carried_forward: string[];
}

export interface FinalizedModuleDelta {
  /** Module names whose load-bearing projection differs from the prior contracts (incl. newly added). */
  changed: Set<string>;
  /** Module names the CURRENT (re-derived) contracts declare — the known-upstream set. */
  current: Set<string>;
}

/** Finalized-module entries keyed by name (first occurrence wins; unnamed dropped). */
function finalizedModulesByName(payload: unknown): Map<string, unknown> {
  const record = isRecord(payload) ? payload : {};
  const modules = Array.isArray(record.module_contracts) ? record.module_contracts : [];
  const byName = new Map<string, unknown>();
  for (const mod of modules) {
    if (isRecord(mod) && typeof mod.name === "string" && mod.name.length > 0 && !byName.has(mod.name)) {
      byName.set(mod.name, mod);
    }
  }
  return byName;
}

/**
 * Load-bearing semantic hash of ONE finalized module, computed through the SAME
 * `payloadSemanticHash` projection the DEPENDENCY_MAP staleness walk uses (INV-IR-3)
 * — so a module the scoping judges "unchanged" is exactly one the DAG judges
 * non-stale, and a load-bearing reword flips both together (never a private,
 * drift-prone per-module projection).
 */
function finalizedModuleSemanticHash(mod: unknown): string {
  return payloadSemanticHash("finalized_module_contracts", { module_contracts: [mod] });
}

/**
 * Diff two `finalized_module_contracts` payloads module-by-module on their
 * load-bearing semantic projection. A module present in the current contracts but
 * absent in the prior, or one whose projection differs, is `changed`. `current` is
 * every module name the current upstream declares — the set a downstream item's
 * provenance key must resolve into, else it is a nonexistent/re-slugged upstream
 * (fail-closed change, see `scopeObligationRevalidation`).
 */
export function diffFinalizedModules(
  priorFinalized: unknown,
  reDerivedFinalized: unknown,
): FinalizedModuleDelta {
  const priorMods = finalizedModulesByName(priorFinalized);
  const currentMods = finalizedModulesByName(reDerivedFinalized);
  const changed = new Set<string>();
  for (const [name, mod] of currentMods) {
    const priorMod = priorMods.get(name);
    if (
      priorMod === undefined ||
      finalizedModuleSemanticHash(mod) !== finalizedModuleSemanticHash(priorMod)
    ) {
      changed.add(name);
    }
  }
  return { changed, current: new Set(currentMods.keys()) };
}

/** Defensive read of an obligation-ledger payload's obligation records. */
function readLedgerObligations(ledger: unknown): Record<string, unknown>[] {
  const record = isRecord(ledger) ? ledger : {};
  const obligations = Array.isArray(record.obligations) ? record.obligations : [];
  return obligations.filter((o): o is Record<string, unknown> => isRecord(o));
}

/** Defensive read of a test_validator_plan payload's spec records. */
function readTestSpecs(plan: unknown): Record<string, unknown>[] {
  const record = isRecord(plan) ? plan : {};
  const specs = Array.isArray(record.test_specs) ? record.test_specs : [];
  return specs.filter((s): s is Record<string, unknown> => isRecord(s));
}

/**
 * Decide which obligations must re-validate vs. carry forward after a localized
 * `finalized_module_contracts` change (INV-IR-1). Provenance key = `module`.
 * An obligation re-validates when:
 *   - it has no `module` (provenance key unestablishable) — fail-closed;
 *   - its `module` is absent from `delta.current` (wrong/nonexistent — re-slug/id
 *     reuse) — fail-closed as a change;
 *   - its `module` is in `delta.changed`.
 * Otherwise it carries forward (its upstream module is byte-identical).
 */
export function scopeObligationRevalidation(
  ledger: ObligationLedger | unknown,
  delta: FinalizedModuleDelta,
): ItemRevalidationScope {
  const revalidate: string[] = [];
  const carried_forward: string[] = [];
  for (const o of readLedgerObligations(ledger)) {
    const id = typeof o.id === "string" ? o.id : "";
    if (!id) continue;
    const mod = typeof o.module === "string" ? o.module : "";
    if (!mod || !delta.current.has(mod) || delta.changed.has(mod)) {
      revalidate.push(id);
    } else {
      carried_forward.push(id);
    }
  }
  return { revalidate, carried_forward };
}

/**
 * Decide which `test_validator_plan` specs must re-validate vs. carry forward
 * (INV-IR-1). Test specs are keyed by `obligation_id`. A spec re-validates when:
 *   - it has no `obligation_id` (provenance key unestablishable) — fail-closed;
 *   - its `obligation_id` is absent from the PRIOR plan (a new item) — fail-closed;
 *   - its `obligation_id`'s obligation is in `revalidatedObligationIds`.
 * Otherwise it carries forward.
 */
export function scopeTestSpecRevalidation(
  reDerivedPlan: unknown,
  priorPlan: unknown,
  revalidatedObligationIds: ReadonlySet<string>,
): ItemRevalidationScope {
  const priorIds = new Set(
    readTestSpecs(priorPlan)
      .map((s) => (typeof s.obligation_id === "string" ? s.obligation_id : ""))
      .filter((id) => id.length > 0),
  );
  const revalidate: string[] = [];
  const carried_forward: string[] = [];
  for (const spec of readTestSpecs(reDerivedPlan)) {
    const id = typeof spec.obligation_id === "string" ? spec.obligation_id : "";
    if (!id || !priorIds.has(id) || revalidatedObligationIds.has(id)) {
      revalidate.push(id);
    } else {
      carried_forward.push(id);
    }
  }
  return { revalidate, carried_forward };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtList(items: string[]): string {
  return items.length > 0 ? items.join(", ") : "none";
}

/** Lowercase, hyphenate, trim — a stable, readable id fragment from a name. */
function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function strArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

/** Defensive read of the validated finalized-module-contracts payload. */
function readFinalizedContracts(payload: unknown): DerivableFinalizedContracts {
  const record = isRecord(payload) ? payload : {};
  const goalId = typeof record.goal_id === "string" ? record.goal_id : "";
  const rawModules = Array.isArray(record.module_contracts)
    ? record.module_contracts
    : [];
  const module_contracts = rawModules.map((m): DerivableModuleContract => {
    const mr = isRecord(m) ? m : {};
    return {
      name: typeof mr.name === "string" ? mr.name : "module",
      inputs: strArray(mr.inputs),
      outputs: strArray(mr.outputs),
      invariants: strArray(mr.invariants),
      failure_modes: strArray(mr.failure_modes),
      validation_boundary:
        typeof mr.validation_boundary === "string" ? mr.validation_boundary : "",
    };
  });
  return { goal_id: goalId, module_contracts };
}
