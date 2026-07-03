/**
 * Structural gates for the DesignSpec contract-pipeline artifact.
 *
 * Extracted from contractPipeline.ts to keep gate logic (structural checks,
 * obligation cross-checks, Kahn's topological sort) separate from the
 * per-artifact field validators. MNT-86b18f1b.
 *
 * Re-exported from contractPipeline.ts for backward-compatible imports.
 *
 * Also contains:
 *   validateGoalIdConsistency — ARC-86b18f1b: goal_id equality across all
 *     contract-pipeline artifacts that carry one.
 *   validateImplementationDAGIntegrity — ARC-86b18f1b-2: referential integrity
 *     and bidirectional coverage for the implementation DAG.
 */
import { spawnSync } from "node:child_process";
import {
  type ValidationIssue,
  type DispatchModelTier,
  type Finding,
  isRecord,
  pushValidationIssue,
  groundDesignFinding,
  normalizeRepoPath,
} from "audit-tools/shared";
import {
  evaluatePairing,
  obligationScopeAnchors,
  readObligationChangeClassification,
  extractSymbolTokens,
  type PairingVerdict,
} from "../contractPipeline/changeClassification.js";

// ── DesignSpec structural gates ───────────────────────────────────────────────

/**
 * Deterministic structural gates run before the adversarial critic phase.
 * Returns ValidationIssue[] — errors block the pipeline (re-emit design phase),
 * warnings are advisory (appended to the critic prompt). Circular obligation
 * dependency detection yields a warning (not an error) routing to N-R21.
 *
 * Call this with the design_spec payload and, optionally, the obligation_ledger
 * payload for the invariant-coverage cross-check.
 */
export function validateDesignSpecGates(
  designSpec: unknown,
  obligationLedger?: unknown,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isRecord(designSpec)) return issues;

  // Gate 1: every module entry must have non-empty inputs and outputs.
  // Checks both DesignSpec.modules (optional annotation array) and
  // finalized_module_contracts.module_contracts (used when called with the
  // finalized design artifact).
  const moduleEntries: unknown[] = Array.isArray(designSpec.modules)
    ? (designSpec.modules as unknown[])
    : Array.isArray(designSpec.module_contracts)
      ? (designSpec.module_contracts as unknown[])
      : [];
  const moduleFieldName = Array.isArray(designSpec.modules)
    ? "modules"
    : "module_contracts";
  for (const [i, mod] of moduleEntries.entries()) {
    if (!isRecord(mod)) continue;
    if (!Array.isArray(mod.inputs) || mod.inputs.length === 0) {
      pushValidationIssue(
        issues,
        `${moduleFieldName}[${i}].inputs`,
        `${moduleFieldName}[${i}].inputs must be a non-empty array — every module must declare its inputs.`,
      );
    }
    if (!Array.isArray(mod.outputs) || mod.outputs.length === 0) {
      pushValidationIssue(
        issues,
        `${moduleFieldName}[${i}].outputs`,
        `${moduleFieldName}[${i}].outputs must be a non-empty array — every module must declare its outputs.`,
      );
    }
  }

  // Gate 2: every side-effect entry must have a non-empty owner.
  if (Array.isArray(designSpec.side_effects)) {
    for (const [i, se] of (designSpec.side_effects as unknown[]).entries()) {
      if (!isRecord(se)) continue;
      if (typeof se.owner !== "string" || se.owner.length === 0) {
        pushValidationIssue(
          issues,
          `side_effects[${i}].owner`,
          `side_effects[${i}].owner must be a non-empty string — every side effect must have an owner.`,
        );
      }
    }
  }

  // Gate 3: invariant/obligation ledger cross-check.
  // Every invariant in the design_spec must have at least one obligation in the ledger
  // with kind === 'invariant' and whose description or id references the invariant's id.
  if (
    Array.isArray(designSpec.invariants) &&
    isRecord(obligationLedger) &&
    Array.isArray(obligationLedger.obligations)
  ) {
    const obligations = obligationLedger.obligations as unknown[];
    for (const inv of designSpec.invariants as unknown[]) {
      if (!isRecord(inv) || typeof inv.id !== "string") continue;
      const invId = inv.id;
      const covered = obligations.some((obl) => {
        if (!isRecord(obl)) return false;
        if (obl.kind !== "invariant") return false;
        const oblId = typeof obl.id === "string" ? obl.id : "";
        const oblDesc = typeof obl.description === "string" ? obl.description : "";
        // Exact id match or word-boundary containment in description to avoid
        // substring false-positives (e.g. "INV-1" ⊂ "INV-10").
        return oblId === invId || new RegExp(`(?<![\\w-])${invId}(?![\\w-])`).test(oblDesc);
      });
      if (!covered) {
        pushValidationIssue(
          issues,
          `invariants[${invId}]`,
          `Invariant "${invId}" has no verification obligation in the obligation ledger — add an obligation with kind "invariant" that references "${invId}".`,
        );
      }
    }
  }

  // Gate 4: every external_dependency entry must have non-empty failure_semantics.
  if (Array.isArray(designSpec.external_dependencies)) {
    for (const [i, dep] of (designSpec.external_dependencies as unknown[]).entries()) {
      if (!isRecord(dep)) continue;
      if (typeof dep.failure_semantics !== "string" || dep.failure_semantics.length === 0) {
        pushValidationIssue(
          issues,
          `external_dependencies[${i}].failure_semantics`,
          `external_dependencies[${i}].failure_semantics must be a non-empty string — every external dependency must declare its failure semantics.`,
        );
      }
    }
  }

  // Gate 5: every trust_boundary entry must have non-empty untrusted_inputs and validation_ref.
  if (Array.isArray(designSpec.trust_boundaries)) {
    for (const [i, tb] of (designSpec.trust_boundaries as unknown[]).entries()) {
      if (!isRecord(tb)) continue;
      if (!Array.isArray(tb.untrusted_inputs) || tb.untrusted_inputs.length === 0) {
        pushValidationIssue(
          issues,
          `trust_boundaries[${i}].untrusted_inputs`,
          `trust_boundaries[${i}].untrusted_inputs must be a non-empty array — every trust boundary must declare its untrusted inputs.`,
        );
      }
      if (typeof tb.validation_ref !== "string" || tb.validation_ref.length === 0) {
        pushValidationIssue(
          issues,
          `trust_boundaries[${i}].validation_ref`,
          `trust_boundaries[${i}].validation_ref must be a non-empty string — every trust boundary must have a validation reference.`,
        );
      }
    }
  }

  // Gate 6: circular obligation dependency detection (warning, not error).
  // Uses Kahn's algorithm (iterative topological sort).
  if (isRecord(obligationLedger) && Array.isArray(obligationLedger.obligations)) {
    const obligations = obligationLedger.obligations as unknown[];
    const ids = new Set<string>();
    const dependsOnMap = new Map<string, string[]>();
    for (const obl of obligations) {
      if (!isRecord(obl) || typeof obl.id !== "string") continue;
      ids.add(obl.id);
      dependsOnMap.set(
        obl.id,
        Array.isArray(obl.depends_on)
          ? (obl.depends_on as unknown[]).filter((d): d is string => typeof d === "string")
          : [],
      );
    }

    // Build in-degree count and adjacency list (edge: dependency → dependent).
    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();
    for (const id of ids) {
      inDegree.set(id, 0);
      adjacency.set(id, []);
    }
    for (const [id, deps] of dependsOnMap.entries()) {
      for (const dep of deps) {
        if (!ids.has(dep)) continue; // ignore external refs
        adjacency.get(dep)!.push(id);
        inDegree.set(id, (inDegree.get(id) ?? 0) + 1);
      }
    }

    const queue: string[] = [];
    for (const [id, deg] of inDegree.entries()) {
      if (deg === 0) queue.push(id);
    }
    let visited = 0;
    while (queue.length > 0) {
      const node = queue.shift()!;
      visited++;
      for (const next of adjacency.get(node) ?? []) {
        const newDeg = (inDegree.get(next) ?? 0) - 1;
        inDegree.set(next, newDeg);
        if (newDeg === 0) queue.push(next);
      }
    }

    if (visited < ids.size) {
      // Remaining nodes with inDegree > 0 are part of the cycle.
      const cycleIds = [...ids].filter((id) => (inDegree.get(id) ?? 0) > 0);
      issues.push({
        path: "obligation_ledger.obligations",
        message: `Circular interface-definition dependency detected among obligations: [${cycleIds.join(", ")}]; route to N-R21 for resolution`,
        severity: "warning",
      });
    }
  }

  return issues;
}

// ── Goal-ID consistency gate ──────────────────────────────────────────────────

/**
 * ARC-86b18f1b: validate that every contract-pipeline artifact that carries a
 * `goal_id` field contains the SAME value. A mismatch indicates that two
 * artifacts were produced for different goals and must not be used together.
 *
 * Pass in a map of artifact-name → payload. Payloads that are not records, or
 * that have no `goal_id` field, are silently skipped (the per-artifact
 * validators already flag missing goal_ids). Issues are errors.
 */
export function validateGoalIdConsistency(
  artifacts: Record<string, unknown>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  let canonical: string | undefined;
  let canonicalSource: string | undefined;

  for (const [name, payload] of Object.entries(artifacts)) {
    if (!isRecord(payload)) continue;
    if (typeof payload.goal_id !== "string" || payload.goal_id.length === 0) continue;
    const id = payload.goal_id;
    if (canonical === undefined) {
      canonical = id;
      canonicalSource = name;
    } else if (id !== canonical) {
      pushValidationIssue(
        issues,
        `${name}.goal_id`,
        `goal_id mismatch: "${name}" has goal_id "${id}" but "${canonicalSource}" has "${canonical}". All contract-pipeline artifacts must share the same goal_id.`,
      );
    }
  }

  return issues;
}

// ── Implementation-DAG referential-integrity gate ─────────────────────────────

/**
 * ARC-86b18f1b-2: validate the implementation_dag against the obligation_ledger
 * and counterexample/judge artifacts for:
 *
 *   1. Referential integrity — every id referenced in `satisfies_obligations`,
 *      `verification_obligation_ids`, and `addresses_counterexamples` must exist
 *      in the obligation_ledger or as an accepted counterexample in the judge
 *      report (respectively).
 *
 *   2. Bidirectional coverage — every obligation in the ledger, and every
 *      accepted counterexample (per the judge report), must be addressed by at
 *      least one DAG node.
 *
 * All issues are errors. Accepts `undefined` payloads for missing artifacts —
 * referential checks are skipped when the target artifact is absent (the caller
 * is responsible for ensuring the artifacts exist before calling this gate).
 */
export function validateImplementationDAGIntegrity(
  dagPayload: unknown,
  obligationLedgerPayload: unknown,
  counterexamplePayload: unknown,
  judgeReportPayload: unknown,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isRecord(dagPayload) || !Array.isArray(dagPayload.nodes)) return issues;

  // Build reference sets from sibling artifacts.
  const obligationIds = new Set<string>();
  if (isRecord(obligationLedgerPayload) && Array.isArray(obligationLedgerPayload.obligations)) {
    for (const obl of obligationLedgerPayload.obligations as unknown[]) {
      if (isRecord(obl) && typeof obl.id === "string" && obl.id.length > 0) {
        obligationIds.add(obl.id);
      }
    }
  }

  const counterexampleIds = new Set<string>();
  if (isRecord(counterexamplePayload) && Array.isArray(counterexamplePayload.counterexamples)) {
    for (const ce of counterexamplePayload.counterexamples as unknown[]) {
      if (isRecord(ce) && typeof ce.id === "string" && ce.id.length > 0) {
        counterexampleIds.add(ce.id);
      }
    }
  }

  const acceptedCounterexampleIds = new Set<string>();
  if (isRecord(judgeReportPayload) && Array.isArray(judgeReportPayload.classifications)) {
    for (const cls of judgeReportPayload.classifications as unknown[]) {
      if (
        isRecord(cls) &&
        cls.classification === "accepted" &&
        typeof cls.counterexample_id === "string" &&
        cls.counterexample_id.length > 0
      ) {
        acceptedCounterexampleIds.add(cls.counterexample_id);
      }
    }
  }

  // Track which obligations and accepted counterexamples are covered.
  const coveredObligationIds = new Set<string>();
  const coveredCounterexampleIds = new Set<string>();

  const nodes = dagPayload.nodes as unknown[];
  for (const [i, node] of nodes.entries()) {
    if (!isRecord(node)) continue;

    // 1a. Referential integrity: satisfies_obligations → obligation_ledger.
    if (obligationIds.size > 0 && Array.isArray(node.satisfies_obligations)) {
      for (const oblId of node.satisfies_obligations as unknown[]) {
        if (typeof oblId !== "string") continue;
        if (!obligationIds.has(oblId)) {
          pushValidationIssue(
            issues,
            `implementation_dag.nodes[${i}].satisfies_obligations`,
            `Node "${node.id}" references obligation "${oblId}" in satisfies_obligations, but no such obligation exists in the obligation_ledger.`,
          );
        } else {
          coveredObligationIds.add(oblId);
        }
      }
    } else if (Array.isArray(node.satisfies_obligations)) {
      for (const oblId of node.satisfies_obligations as unknown[]) {
        if (typeof oblId === "string") coveredObligationIds.add(oblId);
      }
    }

    // 1b. Referential integrity: verification_obligation_ids → obligation_ledger.
    if (obligationIds.size > 0 && Array.isArray(node.verification_obligation_ids)) {
      for (const oblId of node.verification_obligation_ids as unknown[]) {
        if (typeof oblId !== "string") continue;
        if (!obligationIds.has(oblId)) {
          pushValidationIssue(
            issues,
            `implementation_dag.nodes[${i}].verification_obligation_ids`,
            `Node "${node.id}" references obligation "${oblId}" in verification_obligation_ids, but no such obligation exists in the obligation_ledger.`,
          );
        } else {
          coveredObligationIds.add(oblId);
        }
      }
    } else if (Array.isArray(node.verification_obligation_ids)) {
      for (const oblId of node.verification_obligation_ids as unknown[]) {
        if (typeof oblId === "string") coveredObligationIds.add(oblId);
      }
    }

    // 1c. Referential integrity: addresses_counterexamples → counterexample artifact.
    if (Array.isArray(node.addresses_counterexamples)) {
      for (const ceId of node.addresses_counterexamples as unknown[]) {
        if (typeof ceId !== "string") continue;
        if (counterexampleIds.size > 0 && !counterexampleIds.has(ceId)) {
          pushValidationIssue(
            issues,
            `implementation_dag.nodes[${i}].addresses_counterexamples`,
            `Node "${node.id}" references counterexample "${ceId}" in addresses_counterexamples, but no such counterexample exists in the counterexample artifact.`,
          );
        }
        if (acceptedCounterexampleIds.has(ceId)) {
          coveredCounterexampleIds.add(ceId);
        }
      }
    }
  }

  // 2. Bidirectional coverage: every obligation must be covered.
  if (obligationIds.size > 0) {
    for (const oblId of obligationIds) {
      if (!coveredObligationIds.has(oblId)) {
        pushValidationIssue(
          issues,
          "implementation_dag.coverage",
          `Obligation "${oblId}" from the obligation_ledger is not addressed by any implementation_dag node (neither in satisfies_obligations nor verification_obligation_ids).`,
        );
      }
    }
  }

  // 2b. Bidirectional coverage: every accepted counterexample must be covered.
  if (acceptedCounterexampleIds.size > 0) {
    for (const ceId of acceptedCounterexampleIds) {
      if (!coveredCounterexampleIds.has(ceId)) {
        pushValidationIssue(
          issues,
          "implementation_dag.coverage",
          `Judge-accepted counterexample "${ceId}" is not addressed by any implementation_dag node in addresses_counterexamples.`,
        );
      }
    }
  }

  return issues;
}

// ── Contract-obligations gates (CP-BLOCK-N-contract-obligations) ───────────────
//
// The gates below enforce the auditor-agnostic robustness invariants for the
// contract-obligations module. Each is a pure, deterministic function that
// returns ValidationIssue[] (errors block promotion — fail-closed). None of
// them inspect a model identity: tier derivation is by relative complexity rank
// only (no-hardcoded-models invariant).
//
//   OBL-CO-01 validatePairedObligations    — every testable obligation is
//             covered by a test spec that asserts BOTH the satisfied path and a
//             negative/failure path (paired positive+negative obligation).
//   OBL-CO-03 validateEvidenceThreaded     — upstream evidence is threaded into
//             the artifacts that consume it (no evidence is dropped at a seam).
//   OBL-CO-04 validateDigestCoverage       — source_type-scoped: for an
//             enumerable (structured_audit) intake, every enumerated finding
//             maps to at least one obligation; non-enumerable sources pass
//             vacuously.
//   OBL-CO-12 validateReconciliationDerivation — INV-CO-12 fail-closed
//             derivation gate: every reconciled seam mismatch is derived into
//             the finalized module contracts.
//   deriveNodeModelTier                    — relative complexity → relative rank.

const TESTABLE_OBLIGATION_KINDS = new Set(["invariant", "behavioral"]);

/**
 * OBL-CO-01 / DC-5 — paired-obligation gate (fail-closed, change-scoped).
 *
 * Every TESTABLE (invariant / behavioral) obligation must be covered by at least
 * one test_validator_plan spec. Whether that coverage must be a positive+negative
 * PAIR depends on the obligation's change-vs-addition classification (CE-013):
 *
 *  - A behavior CHANGE (it touches an existing symbol) requires BOTH a positive
 *    (satisfied-path) assertion AND a negative (failure-path) assertion, and the
 *    negative must be SCOPED to the changed symbol/file (CE-006): an unscoped,
 *    repo-wide negative does not count. A narrow positive-only test, or a negative
 *    that greps the whole tree, is the exact latent failure mode this gate stops.
 *  - A pure ADDITION has no prior behavior to regress, so it is NEVER forced to
 *    pair — coverage by any spec is sufficient.
 *  - An UNCLASSIFIED testable obligation is treated as a CHANGE (fail-closed): a
 *    dropped classification can never silently relax the requirement.
 *
 * The classification is recorded on the ledger by `deriveObligationLedger`
 * (deterministic first pass, LLM-confirmable). Pairing/scoping/polarity are all
 * evaluated through the single-source `changeClassification` helpers so this gate
 * and the `mergeImplementResults` verify gate agree exactly.
 *
 * An obligation may opt out only via an explicit, falsifiable `inapplicable_claim`
 * on a spec that cites that obligation id — bare omission is an error.
 *
 * Accepts `undefined` for a missing test_validator_plan: with testable
 * obligations present and no plan at all, every testable obligation is reported
 * uncovered (fail-closed).
 */
export function validatePairedObligations(
  obligationLedgerPayload: unknown,
  testValidatorPlanPayload: unknown,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isRecord(obligationLedgerPayload) || !Array.isArray(obligationLedgerPayload.obligations)) {
    return issues;
  }

  // Index covering test specs by obligation id: gather every assertion string and
  // whether any spec declares the obligation inapplicable with a falsifiable claim.
  interface Coverage {
    covered: boolean;
    inapplicable: boolean;
    assertions: string[];
  }
  const coverage = new Map<string, Coverage>();
  const ensure = (id: string): Coverage => {
    let entry = coverage.get(id);
    if (!entry) {
      entry = { covered: false, inapplicable: false, assertions: [] };
      coverage.set(id, entry);
    }
    return entry;
  };

  const specs =
    isRecord(testValidatorPlanPayload) && Array.isArray(testValidatorPlanPayload.test_specs)
      ? (testValidatorPlanPayload.test_specs as unknown[])
      : [];
  for (const spec of specs) {
    if (!isRecord(spec) || typeof spec.obligation_id !== "string") continue;
    const entry = ensure(spec.obligation_id);
    entry.covered = true;

    // An inapplicable_claim that cites this same obligation id opts it out.
    if (
      isRecord(spec.inapplicable_claim) &&
      spec.inapplicable_claim.obligation_id === spec.obligation_id &&
      typeof spec.inapplicable_claim.reason === "string" &&
      spec.inapplicable_claim.reason.length > 0
    ) {
      entry.inapplicable = true;
    }

    if (Array.isArray(spec.assertions)) {
      for (const a of spec.assertions as unknown[]) {
        if (typeof a === "string") entry.assertions.push(a);
      }
    }
  }

  for (const obl of obligationLedgerPayload.obligations as unknown[]) {
    if (!isRecord(obl) || typeof obl.id !== "string") continue;
    if (typeof obl.kind !== "string" || !TESTABLE_OBLIGATION_KINDS.has(obl.kind)) continue;
    const id = obl.id;
    const entry = coverage.get(id);

    if (!entry || !entry.covered) {
      pushValidationIssue(
        issues,
        `test_validator_plan.coverage[${id}]`,
        `Testable obligation "${id}" (kind "${obl.kind}") has no test spec — every invariant/behavioral obligation must be covered by a test spec (a paired positive+negative for a behavior change), or declared inapplicable with a falsifiable claim.`,
      );
      continue;
    }
    if (entry.inapplicable) continue;

    // A pure ADDITION is not forced to pair — coverage by any spec is enough.
    const classification = readObligationChangeClassification(obl);
    if (classification?.change_kind === "addition") continue;

    // CHANGE (or fail-closed unclassified): require the scoped positive+negative
    // pair, evaluated by the single-source helper against the change's anchors.
    const description = typeof obl.description === "string" ? obl.description : "";
    const anchors = obligationScopeAnchors(id, description, classification);
    const verdict: PairingVerdict = evaluatePairing(entry.assertions, anchors);

    if (!verdict.hasPositive) {
      pushValidationIssue(
        issues,
        `test_validator_plan.coverage[${id}].positive`,
        `Testable obligation "${id}" (behavior change) has no positive (satisfied-path) assertion — a paired obligation must assert the behavior holds in the success case.`,
      );
    }
    if (!verdict.hasNegative) {
      const detail = verdict.negativeUnscoped
        ? `its negative assertion is not scoped to the changed symbol/file (anchors: ${anchors.join(", ") || "none"}) — an unscoped, repo-wide negative is rejected (CE-006)`
        : `it has no negative (failure-path) assertion`;
      pushValidationIssue(
        issues,
        `test_validator_plan.coverage[${id}].negative`,
        `Testable obligation "${id}" (behavior change) ${detail}. A paired obligation must assert the failure mode is rejected, scoped to the change, not only the positive case.`,
      );
    }
  }

  return issues;
}

/** Re-exported PairingVerdict so importers of this gate module can type the result. */
export type { PairingVerdict };

/**
 * OBL-CO-03 — evidence-threading gate (fail-closed).
 *
 * Evidence produced upstream must survive every downstream seam:
 *
 *  1. A contract_assessment_report finding with status "violated" must carry
 *     non-empty evidence — a violation asserted without evidence is unfalsifiable.
 *  2. Every judge-accepted counterexample must be threaded forward into the
 *     implementation_dag (a node must list it in addresses_counterexamples).
 *     This is the seam where adversarial evidence is most often dropped.
 *  3. Every DAG node that satisfies an obligation must carry obligation-derived
 *     evidence in its description (the node must not be an empty placeholder).
 *
 * Accepts `undefined` payloads — a check whose source artifact is absent is
 * skipped, except the counterexample-threading check, which is fail-closed when
 * accepted counterexamples exist but the DAG is missing.
 */
export function validateEvidenceThreaded(
  assessmentReportPayload: unknown,
  judgeReportPayload: unknown,
  dagPayload: unknown,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // 1. violated assessment findings must carry evidence.
  if (isRecord(assessmentReportPayload) && Array.isArray(assessmentReportPayload.findings)) {
    for (const [i, finding] of (assessmentReportPayload.findings as unknown[]).entries()) {
      if (!isRecord(finding)) continue;
      if (finding.status !== "violated") continue;
      const evidence = Array.isArray(finding.evidence)
        ? (finding.evidence as unknown[]).filter((e) => typeof e === "string" && e.length > 0)
        : [];
      if (evidence.length === 0) {
        pushValidationIssue(
          issues,
          `contract_assessment_report.findings[${i}].evidence`,
          `Assessment finding for obligation "${
            typeof finding.obligation_id === "string" ? finding.obligation_id : "?"
          }" is "violated" but carries no evidence — a violation must thread concrete evidence forward.`,
        );
      }
    }
  }

  // 2. accepted counterexamples must be threaded into the DAG.
  const acceptedCounterexampleIds = new Set<string>();
  if (isRecord(judgeReportPayload) && Array.isArray(judgeReportPayload.classifications)) {
    for (const cls of judgeReportPayload.classifications as unknown[]) {
      if (
        isRecord(cls) &&
        cls.classification === "accepted" &&
        typeof cls.counterexample_id === "string" &&
        cls.counterexample_id.length > 0
      ) {
        acceptedCounterexampleIds.add(cls.counterexample_id);
      }
    }
  }

  if (acceptedCounterexampleIds.size > 0) {
    const threaded = new Set<string>();
    const nodes =
      isRecord(dagPayload) && Array.isArray(dagPayload.nodes)
        ? (dagPayload.nodes as unknown[])
        : [];
    for (const node of nodes) {
      if (!isRecord(node) || !Array.isArray(node.addresses_counterexamples)) continue;
      for (const ceId of node.addresses_counterexamples as unknown[]) {
        if (typeof ceId === "string") threaded.add(ceId);
      }
    }
    for (const ceId of acceptedCounterexampleIds) {
      if (!threaded.has(ceId)) {
        pushValidationIssue(
          issues,
          "implementation_dag.evidence_threading",
          `Judge-accepted counterexample "${ceId}" is not threaded into any implementation_dag node (addresses_counterexamples) — accepted adversarial evidence must reach implementation.`,
        );
      }
    }
  }

  // 3. obligation-satisfying nodes must not be empty placeholders.
  if (isRecord(dagPayload) && Array.isArray(dagPayload.nodes)) {
    for (const [i, node] of (dagPayload.nodes as unknown[]).entries()) {
      if (!isRecord(node)) continue;
      const satisfies = Array.isArray(node.satisfies_obligations)
        ? (node.satisfies_obligations as unknown[]).filter((o) => typeof o === "string")
        : [];
      if (satisfies.length === 0) continue;
      const description = typeof node.description === "string" ? node.description.trim() : "";
      if (description.length === 0) {
        pushValidationIssue(
          issues,
          `implementation_dag.nodes[${i}].description`,
          `Node "${
            typeof node.id === "string" ? node.id : "?"
          }" satisfies obligations but has an empty description — the evidence of what work satisfies the obligation must not be blank.`,
        );
      }
    }
  }

  return issues;
}

/**
 * OBL-CO-04 — source_type-scoped digest-coverage gate (fail-closed for
 * enumerable sources).
 *
 * For a `structured_audit` (enumerable) intake every enumerated finding must map
 * to at least one obligation in the ledger, so no auditor finding silently
 * vanishes between intake and the contract. For `conversation` / `document`
 * sources — or any finding-enumeration explicitly marked `is_enumerable:false`
 * — the gate passes vacuously, because there is no closed finding set to cover.
 *
 * The mapping is established by finding-id appearing in any obligation's
 * `source_finding_ids` (preferred) OR being referenced by id within an
 * obligation's `description` (word-boundary match, fallback).
 *
 * `sourceType` comes from goal_spec.source_type. `findingEnumerationPayload` is
 * the intake finding-enumeration.json ({ is_enumerable, findings:[{id}] }).
 */
export function validateDigestCoverage(
  sourceType: string | undefined,
  findingEnumerationPayload: unknown,
  obligationLedgerPayload: unknown,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Non-enumerable sources have no closed finding set: pass vacuously.
  if (sourceType !== "structured_audit" && sourceType !== "mixed") return issues;
  if (!isRecord(findingEnumerationPayload)) return issues;
  if (findingEnumerationPayload.is_enumerable === false) return issues;

  const findingIds: string[] = Array.isArray(findingEnumerationPayload.findings)
    ? (findingEnumerationPayload.findings as unknown[])
        .map((f) => (isRecord(f) && typeof f.id === "string" ? f.id : undefined))
        .filter((id): id is string => id !== undefined)
    : [];
  if (findingIds.length === 0) return issues;

  const obligations =
    isRecord(obligationLedgerPayload) && Array.isArray(obligationLedgerPayload.obligations)
      ? (obligationLedgerPayload.obligations as unknown[])
      : [];

  // Build the set of finding ids any obligation maps to.
  const mapped = new Set<string>();
  for (const obl of obligations) {
    if (!isRecord(obl)) continue;
    if (Array.isArray(obl.source_finding_ids)) {
      for (const fid of obl.source_finding_ids as unknown[]) {
        if (typeof fid === "string") mapped.add(fid);
      }
    }
  }
  const descriptions = obligations
    .map((obl) => (isRecord(obl) && typeof obl.description === "string" ? obl.description : ""))
    .join("\n");

  for (const fid of findingIds) {
    if (mapped.has(fid)) continue;
    // Fallback: a word-boundary mention of the finding id in any description.
    const referenced = new RegExp(`(?<![\\w-])${escapeRegExp(fid)}(?![\\w-])`).test(descriptions);
    if (!referenced) {
      pushValidationIssue(
        issues,
        `obligation_ledger.digest_coverage[${fid}]`,
        `Enumerated finding "${fid}" maps to no obligation (neither via source_finding_ids nor by reference in any obligation description) — an enumerable (${sourceType}) intake must cover every finding.`,
      );
    }
  }

  return issues;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * OBL-CO-12 / INV-CO-12 — reconciliation-derivation gate (fail-closed).
 *
 * Every mismatch reconciled in the seam_reconciliation_report must be DERIVED
 * into the finalized_module_contracts: the report's `agreed_interface` for each
 * mismatch must be reflected in the finalized contracts (matched against the
 * union of every finalized module's inputs/outputs/invariants/side_effects text).
 * A reconciliation decision that never reaches the finalized contract is a
 * dropped derivation — the exact failure INV-CO-12 forbids.
 *
 * Fail-closed: if the report declares mismatches but the finalized contracts
 * artifact is absent, every mismatch is reported as underived.
 */
export function validateReconciliationDerivation(
  seamReconciliationReportPayload: unknown,
  finalizedModuleContractsPayload: unknown,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (
    !isRecord(seamReconciliationReportPayload) ||
    !Array.isArray(seamReconciliationReportPayload.mismatches)
  ) {
    return issues;
  }
  const mismatches = seamReconciliationReportPayload.mismatches as unknown[];
  if (mismatches.length === 0) return issues;

  // Build a single normalized corpus of all finalized-contract interface text.
  const corpusParts: string[] = [];
  const moduleContracts =
    isRecord(finalizedModuleContractsPayload) &&
    Array.isArray(finalizedModuleContractsPayload.module_contracts)
      ? (finalizedModuleContractsPayload.module_contracts as unknown[])
      : [];
  for (const mod of moduleContracts) {
    if (!isRecord(mod)) continue;
    for (const field of [
      "inputs",
      "outputs",
      "invariants",
      "side_effects",
      "seam_adjustments",
    ] as const) {
      if (Array.isArray(mod[field])) {
        for (const entry of mod[field] as unknown[]) {
          if (typeof entry === "string") corpusParts.push(entry);
        }
      }
    }
    if (typeof mod.validation_boundary === "string") corpusParts.push(mod.validation_boundary);
  }
  const corpus = normalizeForMatch(corpusParts.join("\n"));

  for (const [i, mismatch] of mismatches.entries()) {
    if (!isRecord(mismatch)) continue;
    const resolution = isRecord(mismatch.resolution) ? mismatch.resolution : undefined;
    const agreed =
      resolution && typeof resolution.agreed_interface === "string"
        ? resolution.agreed_interface
        : "";
    const seamId = typeof mismatch.seam_id === "string" ? mismatch.seam_id : `#${i}`;

    if (agreed.length === 0) {
      // No agreed interface text to derive — the reconciliation is incomplete.
      pushValidationIssue(
        issues,
        `seam_reconciliation_report.mismatches[${i}].resolution.agreed_interface`,
        `Seam "${seamId}" has no agreed_interface to derive into the finalized contracts (INV-CO-12).`,
      );
      continue;
    }

    if (moduleContracts.length === 0) {
      pushValidationIssue(
        issues,
        `finalized_module_contracts.derivation[${seamId}]`,
        `Seam "${seamId}" was reconciled but finalized_module_contracts has no module contracts to carry the agreed interface — reconciliation was not derived (INV-CO-12, fail-closed).`,
      );
      continue;
    }

    if (!corpusContainsAgreedInterface(corpus, agreed)) {
      pushValidationIssue(
        issues,
        `finalized_module_contracts.derivation[${seamId}]`,
        `Seam "${seamId}" agreed interface "${agreed}" is not reflected in any finalized module contract — the reconciliation decision was not derived downstream (INV-CO-12).`,
      );
    }
  }

  return issues;
}

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Function words that are length >= 4 but carry no interface meaning. Excluded from
 * the salient-token set so a derivation is judged on its CONTENT terms, not on filler
 * — otherwise "must"/"than"/"with" force the finalized contract to echo the agreed
 * interface near-verbatim (the dogfood: a faithful paraphrase failed INV-CO-12).
 */
const DERIVATION_STOPWORDS = new Set([
  "must", "shall", "should", "will", "would", "with", "that", "this", "from", "into",
  "when", "then", "than", "they", "them", "their", "there", "have", "been", "were",
  "what", "which", "while", "your", "here", "where", "also", "only", "such", "each",
  "both", "more", "most", "some", "very", "upon", "onto", "does", "done",
]);

/**
 * A derivation is satisfied when a strong majority of the agreed interface's salient
 * CONTENT tokens (length >= 4, excluding function-word stopwords) appear in the
 * finalized-contract corpus. Substring matching already tolerates morphology
 * (`flush` ⊂ `flushes`); dropping stopwords and requiring a majority rather than ALL
 * tolerates genuine rewording (a synonym or two), while still failing when the agreed
 * interface left little or no trace — the INV-CO-12 fail-closed property.
 */
function corpusContainsAgreedInterface(corpus: string, agreed: string): boolean {
  const tokens = normalizeForMatch(agreed)
    .split(" ")
    .filter((t) => t.length >= 4 && !DERIVATION_STOPWORDS.has(t));
  if (tokens.length === 0) {
    // No salient content tokens — fall back to a normalized substring check.
    const normAgreed = normalizeForMatch(agreed);
    return normAgreed.length === 0 || corpus.includes(normAgreed);
  }
  const present = tokens.filter((t) => corpus.includes(t)).length;
  // Require ~60% of content tokens — one reworded term in a short interface passes,
  // a mostly-absent interface fails. ceil keeps 1–2-token interfaces strict.
  const required = Math.max(1, Math.ceil(tokens.length * 0.6));
  return present >= required;
}

// ── Node model-tier derivation (relative rank, never a model name) ─────────────

export interface NodeComplexitySignals {
  /** Number of upstream dependencies (depends_on length). */
  dependencyCount: number;
  /** Number of obligations the node satisfies + verifies. */
  obligationCount: number;
  /** Number of files in the node's declared write scope. */
  fileScopeSize: number;
  /** Number of accepted counterexamples the node addresses. */
  counterexampleCount: number;
  /** True when the node's lens is a high-stakes lens (security/correctness/etc.). */
  highStakesLens: boolean;
}

/**
 * Lenses whose defects carry the highest blast radius. A node on one of these
 * lenses is nudged one rank up. This is a property of the *lens*, never of any
 * model — it never selects a model identity.
 */
const HIGH_STAKES_LENSES = new Set([
  "security",
  "correctness",
  "data_integrity",
  "reliability",
]);

/**
 * Derive a *relative* model tier ("small" | "standard" | "deep") for an
 * implementation DAG node from its complexity signals.
 *
 * INV (no-hardcoded-models): the return value is a RELATIVE rank from the shared
 * DispatchModelTier union. This function NEVER references a model name, context
 * window, or per-model limit — the concrete model behind each rank is discovered
 * at the dispatch handshake. Complexity, not identity, decides the rank.
 *
 * Scoring (monotonic in every signal):
 *   +1 per upstream dependency (deep coordination)
 *   +1 per obligation beyond the first (breadth of contract)
 *   +1 per file beyond the first two (write-scope breadth)
 *   +2 per accepted counterexample addressed (adversarial difficulty)
 *   +2 when the node targets a high-stakes lens
 *
 *   score >= 6 → "deep"   (top relative rank)
 *   score >= 3 → "standard" (middle)
 *   else       → "small"  (cheapest)
 */
export function deriveNodeModelTier(signals: NodeComplexitySignals): DispatchModelTier {
  let score = 0;
  score += Math.max(0, signals.dependencyCount);
  score += Math.max(0, signals.obligationCount - 1);
  score += Math.max(0, signals.fileScopeSize - 2);
  score += 2 * Math.max(0, signals.counterexampleCount);
  if (signals.highStakesLens) score += 2;

  if (score >= 6) return "deep";
  if (score >= 3) return "standard";
  return "small";
}

/**
 * Extract complexity signals from a raw implementation-DAG node payload, then
 * derive its relative tier. Tolerant of partial/unknown node shapes.
 */
export function deriveNodeModelTierFromNode(nodePayload: unknown): DispatchModelTier {
  const node = isRecord(nodePayload) ? nodePayload : {};
  const lenLike = (v: unknown): number => (Array.isArray(v) ? v.length : 0);
  const satisfies = lenLike(node.satisfies_obligations);
  const verifies = lenLike(node.verification_obligation_ids);
  const fileScope = Math.max(
    lenLike(node.output_files),
    lenLike(node.files_likely_touched),
    lenLike(node.affected_files),
  );
  const lens = typeof node.lens === "string" ? node.lens : "";
  return deriveNodeModelTier({
    dependencyCount: lenLike(node.depends_on),
    obligationCount: satisfies + verifies,
    fileScopeSize: fileScope,
    counterexampleCount: lenLike(node.addresses_counterexamples),
    highStakesLens: HIGH_STAKES_LENSES.has(lens),
  });
}

// ── M-B3: source-grounded citation gate (repo-tree knownPaths) ────────────────
//
// A contract-pipeline finding (assessment finding, conceptual-critique finding,
// counterexample) must point at something REAL in the working tree: either a
// file path that exists, or a code symbol that appears in some real path. A
// finding that cites only a non-existent path AND only non-existent symbols is
// `ungrounded` — it points at nothing checkable — and blocks promotion.
//
// Why git ls-files and NOT a manifest artifact (CE-001): remediate has no repo
// manifest (unlike audit-code). Enumerating the working tree at repo_root via
// `git ls-files` is the authoritative, OS-agnostic source of truth for "what
// files exist" — never a stale or absent artifact.
//
// Symbol-only citations are NOT excused (the gap groundDesignFinding alone
// leaves): groundDesignFinding rejects a finding that cites no `affected_files`
// path, but a finding that cites a real-looking symbol in its description and no
// path would otherwise be waved through as "cites no component". Here a citation
// that is symbol-shaped only is grounded against the symbol corpus derived from
// the real path set — a symbol that matches no real path token is rejected.
//
// Fail-closed ONLY when the repo-tree enumeration itself fails or returns empty:
// a normal document/conversation run with legitimately groundless prose findings
// is NOT bricked — only an UNREADABLE tree (no files at all) blocks, because in
// that state nothing can be grounded and silently passing would defeat the gate.

/** A finding-shaped citation the gate grounds. Reuses the shared Finding shape. */
export interface ContractCitationGroundingResult {
  /** True when the repo tree could be enumerated (≥1 path). */
  treeReadable: boolean;
  /** ValidationIssue[] — errors block promotion / re-emit the producing phase. */
  issues: ValidationIssue[];
}

/**
 * Enumerate the working-tree paths at `repoRoot` via `git ls-files`, normalized
 * through the shared `normalizeRepoPath`. Returns an empty set when git is
 * unavailable or the tree is empty (caller treats empty as the fail-closed
 * unreadable-tree signal). OS-agnostic: `shell: false`, forward-slash output.
 */
export function enumerateRepoTreePaths(repoRoot: string): Set<string> {
  const known = new Set<string>();
  let result;
  try {
    result = spawnSync("git", ["ls-files"], {
      cwd: repoRoot,
      encoding: "utf8",
      shell: false,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return known;
  }
  if (!result || result.status !== 0 || typeof result.stdout !== "string") {
    return known;
  }
  for (const line of result.stdout.split("\n")) {
    const path = normalizeRepoPath(line);
    if (path.length > 0) known.add(path);
  }
  return known;
}

/**
 * Whether `repoRoot` is inside a VALID git working tree, via
 * `git rev-parse --is-inside-work-tree`. This distinguishes the two reasons
 * `enumerateRepoTreePaths` can return empty: (a) git missing / not a repo →
 * `false` (genuinely unreadable — fail-closed); (b) a valid git work tree that
 * simply has zero tracked files yet (a fresh/never-committed repo) → `true`
 * (the citations may be sound; degrade to pass-with-warning, never hard-block).
 * OS-agnostic: `shell: false`. NEVER throws — any failure is treated as not-a-tree.
 */
export function isInsideGitWorkTree(repoRoot: string): boolean {
  let result;
  try {
    result = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: repoRoot,
      encoding: "utf8",
      shell: false,
    });
  } catch {
    return false;
  }
  return (
    !!result &&
    result.status === 0 &&
    typeof result.stdout === "string" &&
    result.stdout.trim() === "true"
  );
}

/**
 * Build the corpus of pre-existing symbol tokens from the known repo paths, so a
 * symbol-shaped citation can be grounded against "a token that actually names a
 * real file or a segment of one". Each path is split on path/extension separators
 * (`/`, `.`, `_`, `-`) into segments (`src/auth.ts` → {src, auth, ts}), so a bare
 * symbol citation like `auth` grounds against the real file `src/auth.ts`. Single-
 * letter / very short segments (<3) are dropped as noise.
 */
function buildKnownSymbolCorpus(knownPaths: ReadonlySet<string>): Set<string> {
  const corpus = new Set<string>();
  for (const path of knownPaths) {
    for (const segment of path.split(/[/._\-]+/)) {
      const token = segment.toLowerCase();
      if (token.length >= 3) corpus.add(token);
    }
  }
  return corpus;
}

/**
 * Every ancestor directory of a known path (`src/a/b.ts` → {src, src/a}), so a
 * path-shaped citation to a brand-new file that does not exist yet can still
 * ground against a REAL tracked directory. This is the create-file case a module
 * cannot pre-ground any other way (its deliverable does not exist until it runs,
 * so `git ls-files` never lists it) — yet the module is not hallucinating when the
 * file lands in a real location. A fully-invented path under a non-existent
 * directory (`made/up/dir/x.ts`) still fails, so the hallucination signal is kept
 * for the case it can actually catch. Normalized, forward-slash, no trailing slash.
 */
function buildKnownDirs(knownPaths: ReadonlySet<string>): Set<string> {
  const dirs = new Set<string>();
  for (const path of knownPaths) {
    let slash = path.lastIndexOf("/");
    while (slash > 0) {
      const dir = path.slice(0, slash);
      if (dirs.has(dir)) break;
      dirs.add(dir);
      slash = dir.lastIndexOf("/");
    }
  }
  return dirs;
}

/** The parent directory of a normalized path token, or "" for a top-level file. */
function parentDir(token: string): string {
  const slash = token.lastIndexOf("/");
  return slash > 0 ? token.slice(0, slash) : "";
}

/**
 * A token is path-shaped when it contains a path separator or a file-extension
 * dot (`src/a.ts`, `a/b`, `foo.ts`); otherwise it is symbol-shaped (`writeRecord`,
 * `flush_buffer`). The partition decides which grounding set a citation token is
 * checked against (CE: a symbol-only citation to a non-existent symbol is
 * rejected, not excused as "cites no component").
 */
function isPathShaped(token: string): boolean {
  return token.includes("/") || /\.[a-z0-9]+$/i.test(token);
}

/**
 * M-B3 — source-grounded citation gate (fail-closed only on an unreadable tree).
 *
 * For each finding:
 *   1. If it cites at least one real `affected_files` path → grounded (delegates
 *      to the shared `groundDesignFinding` against the repo-tree path set — no
 *      re-implementation).
 *   2. Otherwise, partition the citation tokens (affected_files paths that did
 *      not resolve + symbol tokens from the description) into path-shaped vs
 *      symbol-shaped. A path-shaped token grounds against the known-path set; a
 *      symbol-shaped token grounds against the symbol corpus. If ANY token
 *      grounds, the finding passes. If NONE grounds — including a finding that
 *      cites only non-existent symbols — it is rejected (error).
 *
 * `findings` is the array of finding-shaped citations to ground (each carries
 * `affected_files` and an optional `description`). `repoRoot` is the working-tree
 * root enumerated by `git ls-files`.
 */
export function validateContractCitationGrounding(
  findings: readonly Finding[],
  repoRoot: string,
): ContractCitationGroundingResult {
  const issues: ValidationIssue[] = [];
  const knownPaths = enumerateRepoTreePaths(repoRoot);

  // An empty path set has two distinct causes — distinguish them so a legitimately
  // new/empty git repo is not hard-blocked (the grounding edge):
  //   - git missing / not a repo  → genuinely unreadable → ERROR (fail-closed).
  //   - valid work tree, 0 tracked → nothing to ground against, but the citations
  //     may be sound → WARNING (pass-with-warning; callers block only on errors).
  if (knownPaths.size === 0) {
    if (isInsideGitWorkTree(repoRoot)) {
      pushValidationIssue(
        issues,
        "contract_citation_grounding.repo_tree",
        `The working tree at "${repoRoot}" is a valid git repo but has no tracked files yet (git ls-files is empty) — citation grounding cannot run, so it is SKIPPED with a warning rather than blocking promotion. Citations were not verified against the tree.`,
        "warning",
      );
      // treeReadable: the tree IS readable — it is just empty. No error issue, so
      // the gate degrades to pass-with-warning (callers filter on severity:error).
      return { treeReadable: true, issues };
    }
    pushValidationIssue(
      issues,
      "contract_citation_grounding.repo_tree",
      `Could not enumerate the working tree at "${repoRoot}" (git unavailable or not a git work tree) — citation grounding cannot run, so the gate fails closed. Verify repo_root points at a git working tree.`,
    );
    return { treeReadable: false, issues };
  }

  const knownSymbols = buildKnownSymbolCorpus(knownPaths);
  const knownDirs = buildKnownDirs(knownPaths);

  findings.forEach((finding, index) => {
    // 1. Real path citation → grounded by the shared design-finding primitive.
    const pathVerdict = groundDesignFinding(finding, knownPaths);
    if (pathVerdict.status === "grounded") return;

    // 2. No real path. Gather every citation token and partition it.
    const tokens = new Set<string>();
    for (const file of finding.affected_files ?? []) {
      const normalized = normalizeRepoPath(file?.path ?? "");
      if (normalized.length > 0) tokens.add(normalized);
    }
    // The canonical Finding shape carries no `description`; its prose lives in
    // `summary` (+ title). Pull candidate symbol tokens from both so a symbol-only
    // citation is grounded against the real-symbol corpus.
    for (const token of extractSymbolTokens(`${finding.summary ?? ""} ${finding.title ?? ""}`)) {
      tokens.add(token);
    }

    let grounded = false;
    for (const token of tokens) {
      if (isPathShaped(token)) {
        // A real path grounds directly; a not-yet-tracked path grounds when its
        // parent directory is real (a legitimate brand-new-file deliverable in an
        // existing tracked location — the create-file case, which by definition
        // cannot cite an existing path). A path under a non-existent directory
        // still fails, preserving the hallucination signal.
        if (knownPaths.has(token) || knownDirs.has(parentDir(token))) {
          grounded = true;
          break;
        }
      } else if (knownSymbols.has(token)) {
        grounded = true;
        break;
      }
    }

    if (!grounded) {
      const findingId =
        typeof finding.id === "string" && finding.id.length > 0 ? finding.id : `#${index}`;
      const cited = [...tokens].slice(0, 5).join(", ") || "(no path or symbol citation)";
      pushValidationIssue(
        issues,
        `contract_citation_grounding.findings[${findingId}]`,
        `Finding "${findingId}" cites no real component: no cited path exists in the working tree and no cited symbol (${cited}) names anything in the repository. A finding must point at a real path or a real symbol.`,
      );
    }
  });

  return { treeReadable: true, issues };
}

// ── (removed) Downstream-only repair propagation — S2, dropped ─────────────────
// The dead `repairDownstreamPhases` / `CONTRACT_PHASE_SEQUENCE` / `ARTIFACT_NAME_TO_PHASE`
// were deleted (contract-authoring determinism design, S2). A linear phase-slice
// ("every phase after the repaired one") is a coarser, AD-HOC re-run authority that
// would conflict with the project's "dependency DAG is truth, never ad-hoc freshness"
// invariant. The hash-based DEPENDENCY_MAP staleness DAG (`artifactStore` +
// `detectStaleArtifacts`, consumed in `buildNextContractPipelineStep`) ALREADY
// re-derives exactly the genuinely-affected downstream artifacts after a repair, so
// this function had no correct caller. Verified via the S2/S4 dogfood (2026-06-15);
// see `spec/contract-authoring-determinism-design.md` S2. Do not re-add it.
