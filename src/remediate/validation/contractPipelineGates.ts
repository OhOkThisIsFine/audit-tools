/**
 * Structural gates for the DesignSpec contract-pipeline artifact.
 *
 * Extracted from contractPipeline.ts to keep gate logic (structural checks,
 * obligation cross-checks, cycle detection) separate from the per-artifact
 * field validators. MNT-86b18f1b.
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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ValidationIssue,
  type Finding,
  type WorkBlockSeam,
  WorkBlockSeamSchema,
  isRecord,
  pushValidationIssue,
  groundDesignFinding,
  normalizeRepoPath,
  isBareBasename,
  resolveBasenameToTrackedPath,
  enumerateTrackedFilePaths,
  findCyclicComponents,
} from "audit-tools/shared";
import {
  evaluatePairing,
  obligationScopeAnchors,
  readObligationChangeClassification,
  extractSymbolTokens,
  type PairingVerdict,
} from "../contractPipeline/changeClassification.js";
import type { ContractPipelineArtifactName } from "../contractPipeline/artifactStore.js";
import { TESTABLE_OBLIGATION_KINDS } from "../contractPipeline/obligationKinds.js";

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
  if (!canEvaluateDesignSpec(designSpec)) return issues;

  type RequiredEntryShape = "array" | "string";
  type ModuleOrModuleContracts = "modules" | "module_contracts";
  type DesignSpecFieldCheck = {
    collections: readonly (
      | ModuleOrModuleContracts
      | "side_effects"
      | "external_dependencies"
      | "trust_boundaries"
    )[];
    field: string;
    expectedShape: RequiredEntryShape;
    message: (collection: string, index: number, field: string) => string;
  };

  const requiredFieldChecks: readonly DesignSpecFieldCheck[] = [
    {
      collections: ["modules", "module_contracts"] as const,
      field: "inputs",
      expectedShape: "array",
      message: (collection, index) =>
        `${collection}[${index}].inputs must be a non-empty array — every module must declare its inputs.`,
    },
    {
      collections: ["modules", "module_contracts"] as const,
      field: "outputs",
      expectedShape: "array",
      message: (collection, index) =>
        `${collection}[${index}].outputs must be a non-empty array — every module must declare its outputs.`,
    },
    {
      collections: ["side_effects"],
      field: "owner",
      expectedShape: "string",
      message: (_, index) =>
        `side_effects[${index}].owner must be a non-empty string — every side effect must have an owner.`,
    },
    {
      collections: ["external_dependencies"],
      field: "failure_semantics",
      expectedShape: "string",
      message: (collection, index, field) =>
        `${collection}[${index}].${field} must be a non-empty string — every external dependency must declare its failure semantics.`,
    },
    {
      collections: ["trust_boundaries"],
      field: "untrusted_inputs",
      expectedShape: "array",
      message: (collection, index, field) =>
        `${collection}[${index}].${field} must be a non-empty array — every trust boundary must declare its untrusted inputs.`,
    },
    {
      collections: ["trust_boundaries"],
      field: "validation_ref",
      expectedShape: "string",
      message: (collection, index, field) =>
        `${collection}[${index}].${field} must be a non-empty string — every trust boundary must have a validation reference.`,
    },
  ];

  const checksGate1And2 = requiredFieldChecks.slice(0, 3);
  const checksGate4And5 = requiredFieldChecks.slice(3);
  const specRecord = designSpec as Record<string, unknown>;

  const resolveCollection = (
    check: DesignSpecFieldCheck,
  ):
    | "modules"
    | "module_contracts"
    | "side_effects"
    | "external_dependencies"
    | "trust_boundaries"
    | undefined => {
    if (check.collections.includes("modules")) {
      if (Array.isArray(specRecord.modules)) return "modules";
      if (Array.isArray(specRecord.module_contracts)) return "module_contracts";
    }
    return check.collections.find((collection): collection is
      | "side_effects"
      | "external_dependencies"
      | "trust_boundaries"
      | "module_contracts" => Array.isArray(specRecord[collection]));
  };

  const runDesignSpecFieldChecks = (
    checks: readonly DesignSpecFieldCheck[],
  ): void => {
    const isInvalid = (shape: RequiredEntryShape, value: unknown): boolean => {
      if (shape === "array") {
        return !Array.isArray(value) || value.length === 0;
      }
      return typeof value !== "string" || value.length === 0;
    };

    const collectionOrder: string[] = [];
    for (const check of checks) {
      const collection = resolveCollection(check);
      if (collection && !collectionOrder.includes(collection)) {
        collectionOrder.push(collection);
      }
    }

    for (const collection of collectionOrder) {
      const maybeEntries = specRecord[collection as keyof typeof specRecord];
      if (!Array.isArray(maybeEntries)) continue;
      const checksForCollection = checks.filter(
        (check) => resolveCollection(check) === collection,
      );
      for (const [index, entry] of maybeEntries.entries()) {
        if (!isRecord(entry)) continue;
        for (const check of checksForCollection) {
          if (isInvalid(check.expectedShape, entry[check.field])) {
            pushValidationIssue(
              issues,
              `${collection}[${index}].${check.field}`,
              check.message(collection, index, check.field),
            );
          }
        }
      }
    }
  };

  runDesignSpecFieldChecks(checksGate1And2);

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
        // substring false-positives (e.g. "INV-1" ⊂ "INV-10"). COR-cca3801c:
        // invId is worker-authored and must be escaped before interpolation —
        // unescaped, a metacharacter id (e.g. "INV-(1") threw and aborted the
        // whole cross-gate evaluation, losing all eight gate results, not just
        // this one. Mirrors the sibling fix
        // already applied to fid in validateDigestCoverage below.
        return oblId === invId || new RegExp(`(?<![\\w-])${escapeRegExp(invId)}(?![\\w-])`).test(oblDesc);
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

  runDesignSpecFieldChecks(checksGate4And5);

  // Gate 6: circular obligation dependency detection (warning, not error).
  // Exact cycle membership from the shared directed-cycle core: the reported
  // ids are the strongly connected components' own members, so an obligation
  // merely DOWNSTREAM of a cycle is not named (the Kahn drain this replaced
  // reported every node it could not drain, tails included). The ledger is
  // untrusted host-authored input, so the shape guards stay here at the call
  // site — the core takes typed nodes.
  if (isRecord(obligationLedger) && Array.isArray(obligationLedger.obligations)) {
    const obligations = obligationLedger.obligations as unknown[];
    const nodes: { id: string; depends_on: string[] }[] = [];
    for (const obl of obligations) {
      if (!isRecord(obl) || typeof obl.id !== "string") continue;
      nodes.push({
        id: obl.id,
        depends_on: Array.isArray(obl.depends_on)
          ? (obl.depends_on as unknown[]).filter((d): d is string => typeof d === "string")
          : [],
      });
    }

    const cycleIds = findCyclicComponents(nodes, { includeSelfLoops: true }).flat();
    if (cycleIds.length > 0) {
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
  if (!canEvaluateImplementationDagIntegrity(dagPayload)) return issues;

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
// them inspect or select a model identity.
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

/**
 * Testable obligation kinds — THE single source of truth for whether an
 * obligation needs a test-plan spec (derive.ts's buildTestValidatorPlanScaffold)
 * and whether the coverage gate below requires that spec to be filled
 * (validatePairedObligations). MNT-e10b9d9b: previously duplicated by hand as
 * TESTABLE_KINDS in derive.ts and TESTABLE_OBLIGATION_KINDS here, and the two
 * copies had already diverged — derive.ts failed OPEN on an unrecognized kind
 * (conservatively testable) while this file failed CLOSED (silently skipped,
 * i.e. treated as non-testable, so a scaffold-offered spec was never actually
 * required). The subset is now derived from the full vocabulary in
 * contractPipeline/obligationKinds.ts; this module owns only the fail-open
 * classification policy.
 */
export { TESTABLE_OBLIGATION_KINDS };

/**
 * testable (invariant/behavioral) → true; the structural contract-conformance
 * kind → false; an unrecognized/unexpected kind → true (fail-OPEN into the
 * paired-test gate rather than silently skipping coverage — matches
 * derive.ts's original scaffold semantics, which this predicate now also
 * governs on the coverage-gate side, closing the divergence).
 */
export function isTestablePhaseObligation(kind: string): boolean {
  if (TESTABLE_OBLIGATION_KINDS.has(kind)) return true;
  if (kind === "structural") return false;
  return true;
}

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
  if (!canEvaluatePairedObligations(obligationLedgerPayload)) return issues;

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
    if (typeof obl.kind !== "string" || !isTestablePhaseObligation(obl.kind)) continue;
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
      // Polarity escape-hatch (INV-CVG-3 / CE): the keyword classifier reads a
      // satisfied path whose success is a block/`exit 2` action as "no positive"
      // (a block/exit reads as a failure). Point the author at the explicit label
      // override so a false negative is always recoverable without euphemising.
      pushValidationIssue(
        issues,
        `test_validator_plan.coverage[${id}].positive`,
        `Testable obligation "${id}" (behavior change) has no positive (satisfied-path) assertion — a paired obligation must assert the behavior holds in the success case. ` +
          `If the success case is a block / \`exit 2\` action the polarity heuristic misreads as "no positive", prefix that assertion with an explicit \`POSITIVE:\` (or \`NEGATIVE:\`) label to override the classifier.`,
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
  if (!canEvaluateDigestCoverage(sourceType, findingEnumerationPayload)) return issues;

  const findingEnumeration = findingEnumerationPayload as Record<string, unknown>;
  const findingIds: string[] = Array.isArray(findingEnumeration.findings)
    ? (findingEnumeration.findings as unknown[])
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

/**
 * Path-A work-topology gate. Every dangerous audit overlap must have exactly one
 * distinct seam-preparation module, and both participating implementation blocks
 * must remain represented by implementation modules. This turns the auditor's
 * overlap metadata into a mechanically enforced decomposition boundary instead
 * of prompt-only advice.
 */
export function validateWorkBlockSeamPreparation(
  pathASeedPayload: unknown,
  moduleDecompositionPayload: unknown,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isRecord(pathASeedPayload) || !Array.isArray(pathASeedPayload.work_block_seams)) {
    return issues;
  }
  // Parse every seam against the contract BEFORE gating on it. The contested-file
  // check used to read `typeof seam.file === "string" ? … : skip`, so an
  // old-shape or malformed seed lost the check and the gate still reported green
  // — a fail-OPEN on exactly the record that authorizes parallel writes.
  const parsedSeams: WorkBlockSeam[] = [];
  for (const [index, candidate] of (
    pathASeedPayload.work_block_seams as unknown[]
  ).entries()) {
    const parsed = WorkBlockSeamSchema.safeParse(candidate);
    if (!parsed.success) {
      const seamLabel =
        isRecord(candidate) && typeof candidate.id === "string"
          ? candidate.id
          : `#${index}`;
      pushValidationIssue(
        issues,
        `path_a_seed.work_block_seams[${index}]`,
        `Seam "${seamLabel}" does not match the work-block seam contract, so its preparation cannot be checked: ${parsed.error.issues
          .map((issue) => `${issue.path.map(String).join(".") || "<root>"}: ${issue.message}`)
          .join("; ")}`,
      );
      continue;
    }
    parsedSeams.push(parsed.data);
  }
  const requiredSeams = parsedSeams.filter(
    (seam) => seam.requires_preparation === true,
  );
  if (requiredSeams.length === 0) return issues;

  const workBlocks = Array.isArray(pathASeedPayload.work_blocks)
    ? (pathASeedPayload.work_blocks as unknown[]).filter(isRecord)
    : [];
  const blockById = new Map<string, Record<string, unknown>>();
  for (const block of workBlocks) {
    if (typeof block.id === "string") blockById.set(block.id, block);
  }
  const modules =
    isRecord(moduleDecompositionPayload) && Array.isArray(moduleDecompositionPayload.modules)
      ? (moduleDecompositionPayload.modules as unknown[]).filter(isRecord)
      : [];
  const requiredSeamIds = new Set(requiredSeams.map((seam) => seam.id));

  for (const [index, mod] of modules.entries()) {
    const sourceIds = Array.isArray(mod.source_work_block_ids)
      ? (mod.source_work_block_ids as unknown[]).filter((id): id is string => typeof id === "string")
      : [];
    const preparedIds = Array.isArray(mod.prepares_seam_ids)
      ? (mod.prepares_seam_ids as unknown[]).filter((id): id is string => typeof id === "string")
      : [];
    for (const blockId of sourceIds) {
      if (!blockById.has(blockId)) {
        pushValidationIssue(
          issues,
          `module_decomposition.modules[${index}].source_work_block_ids`,
          `Module references unknown audit work block "${blockId}".`,
        );
      }
    }
    for (const seamId of preparedIds) {
      if (!requiredSeamIds.has(seamId)) {
        pushValidationIssue(
          issues,
          `module_decomposition.modules[${index}].prepares_seam_ids`,
          `Module references unknown or non-required audit seam "${seamId}".`,
        );
      }
    }
  }

  for (const seam of requiredSeams) {
    const seamId = seam.id;
    const preparers = modules.filter(
      (mod) =>
        Array.isArray(mod.prepares_seam_ids) &&
        (mod.prepares_seam_ids as unknown[]).includes(seamId),
    );
    if (preparers.length !== 1) {
      pushValidationIssue(
        issues,
        `module_decomposition.seam_preparation[${seamId}]`,
        `Required audit seam "${seamId}" must be prepared by exactly one module; found ${preparers.length}.`,
      );
      continue;
    }
    const preparer = preparers[0]!;
    const preparerFiles = new Set(
      Array.isArray(preparer.file_scope)
        ? (preparer.file_scope as unknown[]).filter((file): file is string => typeof file === "string")
        : [],
    );
    if (!preparerFiles.has(seam.file)) {
      pushValidationIssue(
        issues,
        `module_decomposition.seam_preparation[${seamId}].file_scope`,
        `The module preparing seam "${seamId}" must own its contested file (${seam.file}).`,
      );
    }

    for (const blockId of seam.block_ids) {
      const block = blockById.get(blockId);
      if (!block) {
        pushValidationIssue(
          issues,
          `path_a_seed.work_block_seams[${seamId}].block_ids`,
          `Seam "${seamId}" references unknown work block "${blockId}".`,
        );
        continue;
      }
      const implementationOwners = modules.filter(
        (mod) =>
          mod !== preparer &&
          Array.isArray(mod.source_work_block_ids) &&
          (mod.source_work_block_ids as unknown[]).includes(blockId),
      );
      const preparerOwnsCoordinationBlock =
        block.role === "coordination" &&
        Array.isArray(preparer.source_work_block_ids) &&
        (preparer.source_work_block_ids as unknown[]).includes(blockId);
      if (implementationOwners.length === 0 && !preparerOwnsCoordinationBlock) {
        pushValidationIssue(
          issues,
          `module_decomposition.work_block_coverage[${blockId}]`,
          `Work block "${blockId}" participating in required seam "${seamId}" has no distinct implementation module.`,
        );
      }
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
  if (!canEvaluateReconciliationDerivation(seamReconciliationReportPayload)) return issues;
  const mismatches = (seamReconciliationReportPayload as Record<string, unknown>)
    .mismatches as unknown[];
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
  const corpus = normalizeToContentTokens(corpusParts.join("\n"));

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

/**
 * Lossy semantic-token normalization: lowercases and collapses every run of
 * non-alphanumeric characters (punctuation, symbols, whitespace) to a single
 * space, so a reworded/repunctuated interface still matches by content tokens
 * (INV-CO-12). Deliberately lossy — NOT the same contract as shared
 * `normalizeForMatch` (`audit-tools/shared`), which is whitespace-only and
 * lossless because it backs verbatim quote-and-verify grounding. Kept distinct
 * (and distinctly named) so the two contracts can never be confused.
 */
function normalizeToContentTokens(value: string): string {
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
  const tokens = normalizeToContentTokens(agreed)
    .split(" ")
    .filter((t) => t.length >= 4 && !DERIVATION_STOPWORDS.has(t));
  if (tokens.length === 0) {
    // No salient content tokens — fall back to a normalized substring check.
    const normAgreed = normalizeToContentTokens(agreed);
    return normAgreed.length === 0 || corpus.includes(normAgreed);
  }
  const present = tokens.filter((t) => corpus.includes(t)).length;
  // Require ~60% of content tokens — one reworded term in a short interface passes,
  // a mostly-absent interface fails. ceil keeps 1–2-token interfaces strict.
  const required = Math.max(1, Math.ceil(tokens.length * 0.6));
  return present >= required;
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
 * Enumerate the working-tree paths at `repoRoot`, normalized through the shared
 * `normalizeRepoPath` for membership matching. This is the lowercased *draw* over
 * the one shared corpus — `enumerateTrackedFilePaths` owns the git invocation and
 * its NUL-delimited parsing, so the two corpora cannot drift on how a path is
 * read off the index (they did: both split newline-terminated `ls-files` output,
 * so a C-quoted non-ASCII path corrupted both). Returns an empty set when git is
 * unavailable or the tree is empty (caller treats empty as the fail-closed
 * unreadable-tree signal).
 */
export function enumerateRepoTreePaths(repoRoot: string): Set<string> {
  const known = new Set<string>();
  for (const tracked of enumerateTrackedFilePaths(repoRoot)) {
    const path = normalizeRepoPath(tracked);
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
      windowsHide: true,
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

// ── B5: decomposition file_scope points at real logic (not a re-export shim) ──
//
// A module_decomposition assigns each module a `file_scope[]` — the files where
// that module's named responsibility logic is supposed to live. A latent failure
// mode (B5): a decomposition scopes a module at a thin re-export barrel/shim
// (`export * from "./real.js"`) instead of the file that actually implements the
// responsibility. The implement worker then edits a file that holds no logic, or
// hunts for the real site itself. This gate rejects a module whose file_scope
// resolves ONLY to re-export shims.
//
// The shim signal is STRUCTURAL (a re-export/barrel shape), never a line-count
// heuristic: a genuinely small real module (a five-line installer) must pass. It
// is a rebuttable lead — a module that scopes at least one real-logic file passes
// even if it also lists a barrel.
//
// Grounding reuses the SHARED, dotfile-safe resolver (findingGrounding.ts —
// normalizeRepoPath keeps a dotfile-dir leading dot; resolveBasenameToTrackedPath
// resolves a bare basename to its unique tracked path), so a scoped `.claude/x`
// or bare `advance.ts` grounds identically to the M-B3 gate — no private copy of
// dotfile/basename logic. Fail-closed ONLY on an unreadable git tree (mirrors
// validateContractCitationGrounding); a valid-but-empty tree degrades to warning.

/**
 * A file is a re-export shim/barrel when — after stripping comments — every
 * top-level statement is an import or a re-export, and at least one is a
 * re-export (`export … from`, `export *`). A statement that defines logic (a
 * function/class/enum, or a `const/let/var X = <value>` that is not itself a
 * re-export) makes the file real. Structural, not line-count based.
 *
 * A file that cannot be read is treated as NOT a shim (never false-reject on an
 * unreadable file — the tree-readability gate below is the only fail-closed path).
 */
function isReExportShim(absPath: string): boolean {
  let content: string;
  try {
    content = readFileSync(absPath, "utf8");
  } catch {
    return false;
  }
  // Strip block + line comments so a doc-comment mentioning code is not counted.
  const stripped = content
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const statements = stripped
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0);
  if (statements.length === 0) return false;

  let hasReExport = false;
  for (const stmt of statements) {
    // `export * from "..."` / `export * as ns from "..."`
    if (/^export\s+\*(?:\s+as\s+[A-Za-z0-9_$]+)?\s+from\s+['"]/.test(stmt)) {
      hasReExport = true;
      continue;
    }
    // `export { a, b } from "..."` / `export type { T } from "..."`
    if (/^export\s+(?:type\s+)?\{[^}]*\}\s*from\s+['"]/.test(stmt)) {
      hasReExport = true;
      continue;
    }
    // `export { a, b }` (bare local re-list — carries no logic of its own)
    if (/^export\s+(?:type\s+)?\{[^}]*\}$/.test(stmt)) continue;
    // `export { default } from "..."` handled by the from-form above.
    // A plain import (side-effect or named) carries no logic.
    if (/^import\b/.test(stmt)) continue;
    // Anything else — an `export function`, `export class`, `export const X = …`,
    // or a bare statement — is real logic; the file is not a shim.
    return false;
  }
  return hasReExport;
}

/**
 * INV-CVG-4 (B5) — reject a module whose `file_scope` points ONLY at thin
 * re-export shims rather than the file where its named responsibility logic
 * lives. `moduleDecompositionPayload` is the (envelope-unwrapped) module_decomposition
 * payload; `repoRoot` is the working-tree root enumerated via `git ls-files`.
 *
 * Behaviour:
 *   - A scoped path that does not resolve to any tracked file is SKIPPED here (the
 *     M-B3 citation gate owns path-existence; this gate only judges resolved files).
 *   - A module is flagged only when it resolves ≥1 scoped path and EVERY resolved
 *     path is a re-export shim (no real-logic file among them).
 *   - Fail-closed only on an unreadable git tree (git missing / not a repo → error);
 *     a valid-but-empty tree degrades to a warning (never hard-block a fresh repo).
 */
export function validateDecompositionFileScope(
  moduleDecompositionPayload: unknown,
  repoRoot: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!canEvaluateDecompositionFileScope(moduleDecompositionPayload)) return issues;
  const modules = (moduleDecompositionPayload as Record<string, unknown>).modules as unknown[];

  // Does any module actually declare a file_scope? If not, nothing to ground —
  // do not spawn git or fail-closed on an unrelated empty tree.
  const anyScope = modules.some(
    (mod) =>
      isRecord(mod) &&
      Array.isArray(mod.file_scope) &&
      (mod.file_scope as unknown[]).some((p) => typeof p === "string" && p.length > 0),
  );
  if (!anyScope) return issues;

  // Tree readability gate (mirror validateContractCitationGrounding): the M-B3
  // gate's `enumerateRepoTreePaths` (lowercased) decides readable-vs-empty; the
  // shared case-preserving corpus is what we resolve + read files against.
  const knownLower = enumerateRepoTreePaths(repoRoot);
  if (knownLower.size === 0) {
    if (isInsideGitWorkTree(repoRoot)) {
      pushValidationIssue(
        issues,
        "decomposition_file_scope.repo_tree",
        `The working tree at "${repoRoot}" is a valid git repo but has no tracked files yet (git ls-files is empty) — decomposition file_scope grounding cannot run, so it is SKIPPED with a warning rather than blocking. file_scope was not verified against the tree.`,
        "warning",
      );
      return issues;
    }
    pushValidationIssue(
      issues,
      "decomposition_file_scope.repo_tree",
      `Could not enumerate the working tree at "${repoRoot}" (git unavailable or not a git work tree) — decomposition file_scope grounding cannot run, so the gate fails closed. Verify repo_root points at a git working tree.`,
    );
    return issues;
  }

  const caseCorpus = enumerateTrackedFilePaths(repoRoot);
  // normalizeRepoPath(tracked) → real on-disk case, so a scoped path grounds
  // through the shared dotfile-safe normalizer without a private copy.
  const byNorm = new Map<string, string>();
  for (const p of caseCorpus) byNorm.set(normalizeRepoPath(p), p);

  const resolveScoped = (scoped: string): string | undefined => {
    const norm = normalizeRepoPath(scoped);
    const direct = byNorm.get(norm);
    if (direct) return direct;
    if (isBareBasename(scoped)) return resolveBasenameToTrackedPath(scoped, caseCorpus);
    return undefined;
  };

  for (const [i, mod] of modules.entries()) {
    if (!isRecord(mod)) continue;
    const fileScope = Array.isArray(mod.file_scope)
      ? (mod.file_scope as unknown[]).filter((p): p is string => typeof p === "string" && p.length > 0)
      : [];
    if (fileScope.length === 0) continue;

    let anyResolved = false;
    let anyRealLogic = false;
    const shims: string[] = [];
    for (const scoped of fileScope) {
      const real = resolveScoped(scoped);
      if (!real) continue; // path existence is the M-B3 gate's concern
      anyResolved = true;
      if (isReExportShim(join(repoRoot, real))) {
        shims.push(scoped);
      } else {
        anyRealLogic = true;
      }
    }

    if (anyResolved && !anyRealLogic && shims.length > 0) {
      const name = typeof mod.name === "string" && mod.name.length > 0 ? mod.name : `#${i}`;
      pushValidationIssue(
        issues,
        `module_decomposition.modules[${i}].file_scope`,
        `Module "${name}" file_scope points only at thin re-export shim(s) [${shims.join(", ")}] — a barrel/re-export carries no responsibility logic. Scope this module at the file where its named logic ACTUALLY lives, not a re-export shim.`,
      );
    }
  }

  return issues;
}

// ── INV-CO-13: the finalized module SET is preserved from the drafts ──────────

/** Non-empty `name` values of a `{module_contracts: [...]}` payload, in order. */
function moduleContractNames(payload: unknown): string[] {
  const record = isRecord(payload) ? payload : {};
  const modules = Array.isArray(record.module_contracts) ? record.module_contracts : [];
  const names: string[] = [];
  for (const mod of modules) {
    if (isRecord(mod) && typeof mod.name === "string" && mod.name.length > 0) {
      names.push(mod.name);
    }
  }
  return names;
}

/**
 * INV-CO-13 — `finalized_module_contracts` must carry EXACTLY the module names
 * its drafted `module_contracts` input carries. Finalization is a mechanical
 * merge (`deriveFinalizedModuleContracts` maps the drafts 1:1), and the
 * contract_finalization role text says "for every module contract in
 * module_contracts", so this is a POST-CONDITION on a guarantee the pipeline
 * already states — not a new authoring requirement on any host.
 *
 * It exists because the derive is not the only writer: a judge repair or a
 * critique repair re-emits `contract_finalization` as an LLM step, and that
 * rewrite re-enters through ingestion, whose validator for this artifact
 * (`validateFinalizedModuleContracts`) is shape-only and structurally cannot see
 * the drafts. An LLM rewrite that merges two modules under an invented name and
 * drops a third is therefore shape-valid, and every downstream consumer — the
 * phase cut, the derived obligation ids, and the DAG write-scope prefix join —
 * is then built on a module set that has already silently lost a module. That is
 * not hypothetical: it collapsed 7 modules to 4 in the
 * dispatch-effectiveness-observability run and stranded two DAG nodes with an
 * empty write scope (docs/reviews/observability-dag-scope-join-2026-08-09.md).
 *
 * Ground truth is unambiguous and no host discretion is involved, so this is an
 * exact comparison rather than any form of tolerant matching: a renamed module is
 * reported as BOTH a drop and an invention, which is exactly what it is. It checks
 * multiplicity as well as membership — a repeated name is set-equal to the drafts
 * but still loses content, since consumers keep the first entry per name.
 *
 * Absent-tolerant on both sides (a run that has not reached finalization yet, or
 * a partial single-artifact self-check, must never fabricate an issue).
 */
export function validateFinalizedModuleSetPreserved(
  draftedModuleContracts: unknown,
  finalizedModuleContracts: unknown,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!canEvaluateFinalizedModuleSet(draftedModuleContracts, finalizedModuleContracts)) {
    return issues;
  }
  const drafted = new Set(moduleContractNames(draftedModuleContracts));
  const finalizedNames = moduleContractNames(finalizedModuleContracts);
  const finalized = new Set(finalizedNames);
  if (drafted.size === 0) return issues;

  const dropped = [...drafted].filter((name) => !finalized.has(name)).sort();
  const invented = [...finalized].filter((name) => !drafted.has(name)).sort();
  // Multiplicity, not just membership: a name repeated in the finalized contracts
  // is set-equal to the drafts and would slip past the comparison above, but every
  // consumer keys modules BY NAME and keeps the first occurrence — so the second
  // entry's interface is silently discarded, which is the same content loss by
  // another route.
  const duplicated = [
    ...new Set(finalizedNames.filter((name, i) => finalizedNames.indexOf(name) !== i)),
  ].sort();

  for (const name of dropped) {
    pushValidationIssue(
      issues,
      `finalized_module_contracts.module_contracts[${name}]`,
      `Drafted module "${name}" is missing from finalized_module_contracts. Finalization carries every drafted module through verbatim — it may adjust a module's interface per the seam reconciliation, but it may never drop, merge, or rename one. Re-emit the finalized contracts with all ${drafted.size} drafted module(s): ${[...drafted].sort().join(", ")}.`,
    );
  }
  for (const name of invented) {
    pushValidationIssue(
      issues,
      `finalized_module_contracts.module_contracts[${name}]`,
      `Module "${name}" appears in finalized_module_contracts but in no drafted module contract. Finalization may not invent or merge module names — downstream obligation ids and the DAG write-scope join are keyed on the drafted names, so an invented name resolves to an empty scope. Use only the drafted module names: ${[...drafted].sort().join(", ")}.`,
    );
  }
  for (const name of duplicated) {
    pushValidationIssue(
      issues,
      `finalized_module_contracts.module_contracts[${name}]`,
      `Module "${name}" appears more than once in finalized_module_contracts. Every consumer keys modules by name and keeps the FIRST entry, so the duplicate's interface is silently discarded. Emit exactly one finalized contract per drafted module.`,
    );
  }
  return issues;
}

// ── Gate-outcome classification (OBS-cca3801c / OBS-cca3801c-2) ────────────────
//
// A skipped cross-gate and a passing one both return an empty ValidationIssue[]
// — nothing before this section told them apart. Each predicate below is the
// SAME boolean condition the corresponding gate's own early-return already
// calls (see the edits above): never a second, hand-mirrored copy of the
// condition, which is exactly the class of drift MNT-e10b9d9b names for
// TESTABLE_KINDS vs TESTABLE_OBLIGATION_KINDS. A gate and its own
// evaluated/skipped classification therefore cannot diverge — there is one
// boolean expression per gate, called from both places.

function canEvaluatePairedObligations(
  x: unknown,
): x is Record<string, unknown> & { obligations: unknown[] } {
  return isRecord(x) && Array.isArray(x.obligations);
}

function canEvaluateEvidenceThreaded(
  assessmentReportPayload: unknown,
  judgeReportPayload: unknown,
  dagPayload: unknown,
): boolean {
  return (
    isRecord(assessmentReportPayload) ||
    isRecord(judgeReportPayload) ||
    isRecord(dagPayload)
  );
}

function canEvaluateDigestCoverage(
  sourceType: string | undefined,
  findingEnumerationPayload: unknown,
): boolean {
  return (
    (sourceType === "structured_audit" || sourceType === "mixed") &&
    isRecord(findingEnumerationPayload) &&
    findingEnumerationPayload.is_enumerable !== false
  );
}

function digestCoverageSkipReason(
  sourceType: string | undefined,
  findingEnumerationPayload: unknown,
): string {
  if (sourceType !== "structured_audit" && sourceType !== "mixed") {
    return "source not enumerable — source_type is not structured_audit or mixed";
  }
  if (!isRecord(findingEnumerationPayload)) {
    return "finding-enumeration payload is absent or malformed";
  }
  return "source not enumerable — is_enumerable is false";
}

function canEvaluateReconciliationDerivation(
  x: unknown,
): x is Record<string, unknown> & { mismatches: unknown[] } {
  return isRecord(x) && Array.isArray(x.mismatches);
}

function canEvaluateDesignSpec(x: unknown): x is Record<string, unknown> {
  return isRecord(x);
}

function canEvaluateImplementationDagIntegrity(
  x: unknown,
): x is Record<string, unknown> & { nodes: unknown[] } {
  return isRecord(x) && Array.isArray(x.nodes);
}

function canEvaluateDecompositionFileScope(
  x: unknown,
): x is Record<string, unknown> & { modules: unknown[] } {
  return isRecord(x) && Array.isArray(x.modules);
}

function canEvaluateFinalizedModuleSet(
  draftedModuleContracts: unknown,
  finalizedModuleContracts: unknown,
): boolean {
  if (
    !isRecord(draftedModuleContracts) ||
    !Array.isArray(draftedModuleContracts.module_contracts)
  ) {
    return false;
  }
  if (
    !isRecord(finalizedModuleContracts) ||
    !Array.isArray(finalizedModuleContracts.module_contracts)
  ) {
    return false;
  }
  return moduleContractNames(draftedModuleContracts).length > 0;
}

/**
 * Whether one of the eight cross-artifact gates genuinely ran (`evaluated`),
 * or was skipped because its primary input was absent, malformed, or (digest
 * coverage only) its source was not enumerable — OBS-cca3801c / OBS-cca3801c-2.
 * An empty `issues` array alone cannot distinguish "ran clean" from "never
 * ran"; `evaluated` can. `reason` is present only when `evaluated` is false.
 *
 * INV-CPGV-OUTCOME-RECORD-OWNER: this module owns this record. The finalized
 * module contract's fuller design places the shared type in audit-tools/shared
 * so both adopters (contract-pipeline-orchestration,
 * remediate-nextstep-and-final-gate) import one shape — that relocation needs
 * an edit outside this work item's write scope (src/remediate/validation/ +
 * src/remediate/contractPipeline/ only), so it is deliberately deferred to
 * whichever work item can touch src/shared. The type is defined here,
 * additively, alongside the gates it classifies, so the OBS-cca3801c /
 * OBS-cca3801c-2 signalling obligation is discharged now rather than blocked
 * on that follow-up; see CP-BLOCK-CP-NODE-14's result deviations.
 */
export interface GateOutcome {
  /** Stable identity, in evaluateContractPipelineCrossGateOutcomes's fixed canonical order. */
  gate:
    | "paired_obligations"
    | "evidence_threaded"
    | "digest_coverage"
    | "reconciliation_derivation"
    | "design_spec"
    | "implementation_dag_integrity"
    | "decomposition_file_scope"
    | "finalized_module_set_preserved";
  evaluated: boolean;
  issues: ValidationIssue[];
  /** Present only when `evaluated` is false. */
  reason?: string;
}

/** Build one GateOutcome — the single place `reason` is attached only when `evaluated` is false. */
function gateOutcome(
  gate: GateOutcome["gate"],
  evaluated: boolean,
  issues: ValidationIssue[],
  reason: string,
): GateOutcome {
  return evaluated ? { gate, evaluated, issues } : { gate, evaluated, issues, reason };
}

// ── Single-sourced cross-gate SET (MNT — validate-artifact self-check parity) ──
//
// The 8 CROSS-artifact gates below (as opposed to the per-artifact structural
// CONTRACT_PIPELINE_VALIDATORS) are run by BOTH the plural `validate-artifacts`
// sweep (validation/artifacts.ts) and the singular `validate-artifact --name X`
// self-check (index.ts). Single-sourcing them here means a self-check can never
// diverge from what next-step enforces — the trap this closes: a shape-valid
// `test_validator_plan` missing its scoped positive+negative pair could
// self-validate "ok" via validate-artifact, then fail at next-step because the
// cross-gates never ran against it (an authoring round-trip a self-check exists
// to prevent).

/** Input to {@link evaluateContractPipelineCrossGateOutcomes}. */
export interface ContractPipelineCrossGateInputs {
  /** Every contract-pipeline artifact payload currently known, by name. An
   *  absent entry means "this artifact is not available" — every gate below
   *  tolerates that (see the absent-tolerance note on the function itself). */
  payloads: ReadonlyMap<ContractPipelineArtifactName, unknown>;
  /** The intake finding-enumeration payload (already read from disk), or
   *  undefined when absent/not applicable. Passed through to
   *  validateDigestCoverage verbatim. */
  findingEnumeration?: unknown;
  /** Working-tree root, used by validateDecompositionFileScope's git-tree
   *  enumeration. */
  root: string;
}

/**
 * Evaluate the SAME 8 cross-artifact gates the plural `validate-artifacts`
 * sweep runs, returning one {@link GateOutcome} PER gate in a FIXED canonical
 * order. This is the single cross-gate entry point: callers that need only
 * issues flatten `outcome.issues` in returned order, while callers that need
 * per-gate counts or evaluated/skipped classification retain the outcome
 * records (OBS-cca3801c / OBS-cca3801c-2).
 *
 * Absent-input tolerance is guaranteed PER GATE, not by this runner — this
 * function adds NO extra tolerance logic of its own, it only wires named
 * payloads to each gate's positional arguments. Every gate below already
 * early-returns `[]` when its primary payload is missing/malformed:
 *
 *   1. validatePairedObligations       — returns [] when obligationLedgerPayload
 *      is not a record with an `obligations` array (see its own guard, top of
 *      the function body, above in this file).
 *   2. validateEvidenceThreaded        — has no single top-level guard; each of
 *      its 3 checks is individually gated by its own `isRecord(...)` /
 *      `Array.isArray(...)` condition, so with every payload absent all 3
 *      checks are skipped and it returns [].
 *   3. validateDigestCoverage          — returns [] unless sourceType is
 *      "structured_audit"/"mixed" AND findingEnumerationPayload is a record
 *      AND is_enumerable !== false AND it has a non-empty findings array.
 *   4. validateReconciliationDerivation — returns [] when
 *      seamReconciliationReportPayload is not a record with a `mismatches`
 *      array (or that array is empty).
 *   5. validateDesignSpecGates         — returns [] when its first argument is
 *      not a record (called here with finalizedContracts as that argument).
 *   6. validateImplementationDAGIntegrity — returns [] when dagPayload is not a
 *      record with a `nodes` array.
 *   7. validateDecompositionFileScope  — returns [] when moduleDecompositionPayload
 *      is not a record with a `modules` array.
 *   8. validateFinalizedModuleSetPreserved — returns [] unless BOTH the drafted
 *      and the finalized module contracts are records with a `module_contracts`
 *      array (and the drafted one names at least one module).
 *
 * So a partial pipeline (most artifacts absent — e.g. a single-artifact
 * self-check in an otherwise-empty run) can never false-fail: every gate
 * lacking its input contributes an empty array, not a fabricated issue.
 */
export function evaluateContractPipelineCrossGateOutcomes(
  inputs: ContractPipelineCrossGateInputs,
): GateOutcome[] {
  const { payloads, findingEnumeration, root } = inputs;

  const goalSpec = payloads.get("goal_spec");
  const sourceType =
    isRecord(goalSpec) && typeof goalSpec.source_type === "string"
      ? goalSpec.source_type
      : undefined;
  const obligationLedger = payloads.get("obligation_ledger");
  const testValidatorPlan = payloads.get("test_validator_plan");
  const finalizedContracts = payloads.get("finalized_module_contracts");
  const draftedContracts = payloads.get("module_contracts");
  const seamReport = payloads.get("seam_reconciliation_report");
  const assessment = payloads.get("contract_assessment_report");
  const judge = payloads.get("judge_report");
  const counterexample = payloads.get("counterexample");
  const dag = payloads.get("implementation_dag");
  const moduleDecomposition = payloads.get("module_decomposition");

  return [
    gateOutcome(
      "paired_obligations",
      canEvaluatePairedObligations(obligationLedger),
      validatePairedObligations(obligationLedger, testValidatorPlan),
      "obligation_ledger payload is absent or malformed (not a record with an obligations array)",
    ),
    gateOutcome(
      "evidence_threaded",
      canEvaluateEvidenceThreaded(assessment, judge, dag),
      validateEvidenceThreaded(assessment, judge, dag),
      "all three input payloads (contract_assessment_report, judge_report, implementation_dag) are absent or malformed",
    ),
    gateOutcome(
      "digest_coverage",
      canEvaluateDigestCoverage(sourceType, findingEnumeration),
      validateDigestCoverage(sourceType, findingEnumeration, obligationLedger),
      digestCoverageSkipReason(sourceType, findingEnumeration),
    ),
    gateOutcome(
      "reconciliation_derivation",
      canEvaluateReconciliationDerivation(seamReport),
      validateReconciliationDerivation(seamReport, finalizedContracts),
      "seam_reconciliation_report payload is absent or malformed (not a record with a mismatches array)",
    ),
    gateOutcome(
      "design_spec",
      canEvaluateDesignSpec(finalizedContracts),
      validateDesignSpecGates(finalizedContracts, obligationLedger),
      "design payload (finalized_module_contracts) is absent or malformed",
    ),
    gateOutcome(
      "implementation_dag_integrity",
      canEvaluateImplementationDagIntegrity(dag),
      validateImplementationDAGIntegrity(dag, obligationLedger, counterexample, judge),
      "implementation_dag payload is absent or malformed (not a record with a nodes array)",
    ),
    gateOutcome(
      "decomposition_file_scope",
      canEvaluateDecompositionFileScope(moduleDecomposition),
      validateDecompositionFileScope(moduleDecomposition, root),
      "module_decomposition payload is absent or malformed (not a record with a modules array)",
    ),
    gateOutcome(
      "finalized_module_set_preserved",
      canEvaluateFinalizedModuleSet(draftedContracts, finalizedContracts),
      validateFinalizedModuleSetPreserved(draftedContracts, finalizedContracts),
      "drafted or finalized module_contracts payload is absent, malformed, or names no modules",
    ),
  ];
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

