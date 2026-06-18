/**
 * Deterministic derivers for contract-pipeline artifacts.
 *
 * S1 of the contract-authoring determinism design
 * (`docs/contract-authoring-determinism-design.md`): the contract pipeline
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
    });

    mod.invariants.forEach((invariant, i) => {
      obligations.push({
        id: mintUniqueId(usedIds, `OBL-${base}-inv-${i + 1}`),
        description: invariant,
        kind: "invariant",
        depends_on: [],
        status: "pending",
        source: "design_spec",
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
      });
    });
  }

  return buildObligationLedger({
    goal_id: finalized.goal_id,
    obligations,
    created_at: options.created_at,
  });
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

const TESTABLE_KINDS = new Set(["invariant", "behavioral"]);

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
    assertions: string[];
  }>;
}

/**
 * Build the test-plan skeleton: one spec per *testable* (invariant/behavioral)
 * obligation, with `obligation_id`/`name`/`kind` filled and `assertions` left
 * blank for the model. The model fills only the assertions (each spec needs a
 * paired positive + negative assertion per the OBL-CO-01 gate).
 */
export function buildTestValidatorPlanScaffold(
  ledger: ObligationLedger | undefined,
): TestValidatorPlanScaffold {
  const obligations = ledger?.obligations ?? [];
  return {
    test_specs: obligations
      .filter((o) => TESTABLE_KINDS.has(o.kind))
      .map((o) => ({
        obligation_id: o.id,
        name: scaffoldName(o),
        kind: o.kind === "invariant" ? "invariant" : "unit",
        assertions: [],
      })),
  };
}

export interface ImplementationDagScaffoldNode {
  id: string;
  title: string;
  description: string;
  satisfies_obligations: string[];
  addresses_counterexamples: string[];
  depends_on: string[];
  verification_obligation_ids: string[];
  targeted_commands: string[];
  status: string;
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
 * Build the implementation-DAG skeleton: one node per obligation (covering it),
 * blank title/description/targeted_commands for the model, and accepted
 * counterexamples attached so coverage holds by construction. Empty edges (the
 * derived ledger declares no inter-obligation ordering). Advisory: the model
 * fills the blanks and may merge nodes as long as coverage is preserved.
 */
export function buildImplementationDagScaffold(
  ledger: ObligationLedger | undefined,
  acceptedCeIds: string[],
): ImplementationDagScaffold {
  const obligations = ledger?.obligations ?? [];
  const nodes: ImplementationDagScaffoldNode[] = obligations.map((o, i) => ({
    id: `CP-NODE-${i + 1}`,
    title: "",
    description: "",
    satisfies_obligations: [o.id],
    addresses_counterexamples: [],
    depends_on: [],
    verification_obligation_ids: [o.id],
    targeted_commands: [],
    status: "pending",
  }));

  if (acceptedCeIds.length > 0) {
    if (nodes.length === 0) {
      nodes.push({
        id: "CP-NODE-1",
        title: "",
        description: "",
        satisfies_obligations: [],
        addresses_counterexamples: [...acceptedCeIds],
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
