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
import {
  type ValidationIssue,
  type DispatchModelTier,
  isRecord,
  pushValidationIssue,
} from "audit-tools/shared";

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

/** Phrases that mark a negative/failure assertion (paired-obligation half). */
const NEGATIVE_ASSERTION_PATTERN =
  /\b(reject|rejected|throw|throws|error|errors|fail|fails|failure|invalid|disallow|forbidden|must not|does not|should not|never|negative|missing|absent|empty)\b/i;

/** Phrases that mark a positive/satisfied assertion (paired-obligation half). */
const POSITIVE_ASSERTION_PATTERN =
  /\b(accept|accepted|allow|allowed|succeed|succeeds|returns?|produces?|valid|present|satisfies|satisfied|passes?|emits?|writes?|equal|equals|matches?)\b/i;

/**
 * OBL-CO-01 — paired-obligation gate (fail-closed).
 *
 * Every obligation whose kind is testable (invariant / behavioral) must be
 * covered by at least one test_validator_plan spec, and that coverage must
 * include BOTH a positive (satisfied-path) assertion and a negative
 * (failure-path) assertion. A single positive-only assertion set is the latent
 * failure mode this gate exists to prevent: a narrow positive test passes while
 * the obligation's negative half goes unverified.
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

  // Index test specs by obligation id, tracking the assertion polarity each
  // covering spec provides and whether any spec declares the obligation
  // inapplicable with a falsifiable claim.
  interface Coverage {
    positive: boolean;
    negative: boolean;
    covered: boolean;
    inapplicable: boolean;
  }
  const coverage = new Map<string, Coverage>();
  const ensure = (id: string): Coverage => {
    let entry = coverage.get(id);
    if (!entry) {
      entry = { positive: false, negative: false, covered: false, inapplicable: false };
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

    const assertions = Array.isArray(spec.assertions)
      ? (spec.assertions as unknown[]).filter((a): a is string => typeof a === "string")
      : [];
    for (const assertion of assertions) {
      // An explicit POSITIVE:/NEGATIVE: label is authoritative: it sets exactly
      // that one polarity and the keyword regexes are skipped for this assertion
      // (so e.g. "POSITIVE: must not exceed N" counts only as positive, even
      // though its free text matches a negative keyword). Only unlabeled
      // assertions fall through to the keyword fallback.
      const label = /^\s*(POSITIVE|NEGATIVE)\s*:/i.exec(assertion);
      if (label) {
        if (label[1].toUpperCase() === "POSITIVE") entry.positive = true;
        else entry.negative = true;
        continue;
      }
      if (NEGATIVE_ASSERTION_PATTERN.test(assertion)) entry.negative = true;
      if (POSITIVE_ASSERTION_PATTERN.test(assertion)) entry.positive = true;
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
        `Testable obligation "${id}" (kind "${obl.kind}") has no test spec — every invariant/behavioral obligation must be covered by a paired positive+negative test spec, or declared inapplicable with a falsifiable claim.`,
      );
      continue;
    }
    if (entry.inapplicable) continue;

    if (!entry.positive) {
      pushValidationIssue(
        issues,
        `test_validator_plan.coverage[${id}].positive`,
        `Testable obligation "${id}" has no positive (satisfied-path) assertion — a paired obligation must assert the behavior holds in the success case.`,
      );
    }
    if (!entry.negative) {
      pushValidationIssue(
        issues,
        `test_validator_plan.coverage[${id}].negative`,
        `Testable obligation "${id}" has no negative (failure-path) assertion — a paired obligation must assert the failure mode is rejected, not only the positive case.`,
      );
    }
  }

  return issues;
}

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
 * A derivation is satisfied when every salient token (length >= 4) of the agreed
 * interface appears in the finalized-contract corpus. This tolerates rewording
 * (the finalized contract need not be a verbatim copy) while still failing when
 * the agreed interface left no trace at all.
 */
function corpusContainsAgreedInterface(corpus: string, agreed: string): boolean {
  const tokens = normalizeForMatch(agreed)
    .split(" ")
    .filter((t) => t.length >= 4);
  if (tokens.length === 0) {
    // No salient tokens — fall back to a normalized substring check.
    const normAgreed = normalizeForMatch(agreed);
    return normAgreed.length === 0 || corpus.includes(normAgreed);
  }
  return tokens.every((t) => corpus.includes(t));
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

// ── (removed) Downstream-only repair propagation — S2, dropped ─────────────────
// The dead `repairDownstreamPhases` / `CONTRACT_PHASE_SEQUENCE` / `ARTIFACT_NAME_TO_PHASE`
// were deleted (contract-authoring determinism design, S2). A linear phase-slice
// ("every phase after the repaired one") is a coarser, AD-HOC re-run authority that
// would conflict with the project's "dependency DAG is truth, never ad-hoc freshness"
// invariant. The hash-based DEPENDENCY_MAP staleness DAG (`artifactStore` +
// `detectStaleArtifacts`, consumed in `buildNextContractPipelineStep`) ALREADY
// re-derives exactly the genuinely-affected downstream artifacts after a repair, so
// this function had no correct caller. Verified via the S2/S4 dogfood (2026-06-15);
// see `docs/contract-authoring-determinism-design.md` S2. Do not re-add it.
