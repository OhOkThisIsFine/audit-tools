/**
 * A step prompt's schema sketch and the validator that reads its output are the
 * SAME fact, and this file is what makes that true rather than remembered.
 *
 * The measured drifts this covers (all four existed at HEAD before
 * `contractPipeline/sketchSource.ts`):
 *
 *   - `cyclic_seam_resolution.status` — the sketch offered 2 values, the
 *     validator admitted 4;
 *   - `judge_report.repair_directive.target` — sketch 3, validator 4;
 *   - `verification_report` trace `kind` — sketch 5, validator 6;
 *   - `implementation_dag` node `status` — sketch showed 1 of the validator's 4.
 *
 * The METHOD here is deliberately not "compare two hand-kept lists". A test that
 * reads the validator's literal list and the sketch's literal list and compares
 * them is a drift test made of the same memory it is testing — it passes as long
 * as nobody edits either, which is exactly the state in which the drift is
 * harmless. Instead every vocabulary is PROBED OUT OF THE VALIDATOR: each
 * candidate value is fed to the validator in an otherwise-valid payload and the
 * value is "admitted" iff no issue names that path. The admitted set is then
 * compared to what the rendered prompt actually offers the worker.
 *
 * ── THE SWEEP: coverage by CONSTRUCTION, not by a field list ────────────────
 *
 * The per-field tests below are the readable statement of the property, but a
 * hand-kept list of fields is itself the drift risk — the next sketch to grow a
 * literal would simply not be in the list. So {@link enumerateSketches} finds
 * EVERY enum alternation in EVERY rendered role sketch, from the rendered TEXT
 * (both the `"a | b"` and the `"a|b"` forms; one-member `"a"` too), and each one
 * found must be matched to a PROBE. An alternation that cannot be matched FAILS,
 * naming the role and the field. A sketch added later is therefore covered the
 * moment it exists — the test does not have to be told about it.
 *
 * ── WHAT "EVERY" RANGES OVER ────────────────────────────────────────────────
 *
 * Every role sketch reachable through {@link SKETCH_SOURCE_MODULES} — the
 * contract-pipeline role sketches rendered by `contractPipelinePrompts.ts`, plus
 * the gate's inline shapes in `contractPipeline.ts`. That is NOT every schema
 * sketch this repo renders, and the gap is DECLARED rather than left to be
 * discovered: the clarification-resolution sketch in
 * `src/remediate/steps/prompts.ts` is outside the sweep, recorded as a
 * declared-gap row in `tests/shared/promptContractRegistry.ts`. So an
 * alternation there is covered by nothing in this file, and this file must not
 * be read as claiming otherwise — widening the sweep is a separate change, not
 * something to assume already happened.
 *
 * The probes themselves are the second half of that guarantee, and the sweep
 * checks it: for a probed path the test renders that SAME path with a sentinel
 * value and reads back whichever sentinel survives. A probe whose payload never
 * reaches the validator's check (a malformed fixture, a renamed field) would
 * report everything admitted or nothing admitted — so a probe that admits
 * neither the sentinel nor anything at all is itself refused, and the sentinel
 * check names the probe rather than letting it compare vacuously.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect } from "vitest";

import { ROLES, renderContractPipelinePrompt } from "../../src/remediate/steps/contractPipelinePrompts.js";
import {
  validateConceptualDesignCritique,
  validateContextBundle,
  validateContractAssessmentReport,
  validateCyclicSeamResolution,
  validateGoalSpec,
  validateImplementationDAG,
  validateJudgeReport,
  validateObligationLedger,
  validateSeamReconciliationReport,
  validateTestValidatorPlan,
  validateVerificationReport,
} from "../../src/remediate/validation/contractPipeline.js";
// The vocabularies are reached through the NAMESPACE import, never by name — a
// per-name import list is a second enumeration of the same declarations, and a
// name dropped from it but left in `DECLARED_VOCABULARIES` would still resolve,
// so the two could disagree without either failing. Only the three constants the
// assertions below name INDIVIDUALLY are imported by name.
import * as sketchSource from "../../src/remediate/contractPipeline/sketchSource.js";
import {
  CONTRACT_REPAIR_TARGETS_LEGACY,
  CREATED_AT_OWNER,
} from "../../src/remediate/contractPipeline/sketchSource.js";
import {
  CONTRACT_PIPELINE_CONCEPTUAL_DESIGN_CRITIQUE_VERSION,
  CONTRACT_PIPELINE_CONTRACT_ASSESSMENT_REPORT_VERSION,
  CONTRACT_PIPELINE_CONTEXT_BUNDLE_VERSION,
  CONTRACT_PIPELINE_GOAL_SPEC_VERSION,
  CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION,
  CONTRACT_PIPELINE_JUDGE_REPORT_VERSION,
  CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
  CONTRACT_PIPELINE_TEST_VALIDATOR_PLAN_VERSION,
  CONTRACT_PIPELINE_VERIFICATION_REPORT_VERSION,
  type ValidationIssue,
} from "audit-tools/shared";
import {
  CP_CYCLIC_SEAM_RESOLUTION_VERSION,
  CP_MODULE_DECOMPOSITION_VERSION,
  CP_SEAM_RECONCILIATION_REPORT_VERSION,
} from "../../src/remediate/validation/contractPipeline.js";
import {
  CP_ARTIFACT_NAMES,
  type ContractPipelineArtifactName,
} from "../../src/remediate/contractPipeline/artifactNames.js";

/**
 * DELIBERATELY out-of-vocabulary values a probe tries, so that a probe still
 * reports "refused" for a value no release admits and the sentinel check has
 * something to work with.
 *
 * This is NOT the candidate list. The candidate list is DERIVED below, from the
 * declarations `sketchSource.ts` exports — see {@link CANDIDATES}. It used to be
 * hand-written here, and that hand-writing was the same defect the rest of this
 * file exists to make impossible: a probe can only find a value it TRIES, so a
 * validator that grew a member outside the hand-kept copy stayed invisible
 * (measured 2026-09-11: two such inversions — a new judge verdict and a new goal
 * source type — both left this suite at 15 of 15 GREEN).
 */
const OUT_OF_VOCABULARY = [
  "not_a_real_value_anywhere",
  "redproof_member",
  "redproof_extra_member",
] as const;

/**
 * Every value vocabulary `sketchSource.ts` exports, by the name the validators
 * import it as.
 *
 * The list is hand-kept — it has to be, since the module is reached through a
 * namespace import and nothing at runtime enumerates its exports — but a
 * name that is MISSING or MISSPELLED cannot hide: the constant is `undefined`,
 * and the assertion below refuses an undefined vocabulary by name before any
 * probe runs. So the failure mode of this list is a red test, never a silently
 * narrowed candidate set.
 */
const DECLARED_VOCABULARIES = [
  "ASSESSMENT_FINDING_STATUSES",
  "ASSESSMENT_VERDICTS",
  "CONTRACT_REPAIR_TARGETS",
  "CONTRACT_REPAIR_TARGETS_LEGACY",
  "CONTEXT_ENTRY_KINDS",
  "COUNTEREXAMPLE_CLASSIFICATIONS",
  "CRITIQUE_ITEM_KINDS",
  "CRITIQUE_ITEM_SEVERITIES",
  "CRITIQUE_VERDICTS",
  "CYCLIC_SEAM_BREAK_STRATEGIES",
  "CYCLIC_SEAM_RESOLUTION_STATUSES",
  "GOAL_SOURCE_TYPES",
  "IMPLEMENTATION_EDGE_KINDS",
  "IMPLEMENTATION_NODE_STATUSES",
  "JUDGE_VERDICTS",
  "OBLIGATION_KINDS",
  "OBLIGATION_STATUSES",
  "SEAM_RESOLUTION_DECISIONS",
  "TEST_SPEC_KINDS",
  "VERIFICATION_FINDING_STATUSES",
  "VERIFICATION_REPORT_STATUSES",
  "VERIFICATION_TRACE_KINDS",
  "VERIFICATION_TRACE_STATUSES",
] as const;

/**
 * The probe candidate list, DERIVED from the declarations rather than copied
 * from them: every member of every vocabulary `sketchSource.ts` exports, plus
 * {@link OUT_OF_VOCABULARY}.
 *
 * Why derived. A probe decides membership by FEEDING a value to a validator and
 * reading back whether it was refused, so the probe can only ever find a value
 * it tried. A hand-written candidate list is therefore a blind spot shaped
 * exactly like the drift it is supposed to catch: when a validator stopped
 * reading the shared declaration and admitted a value from somewhere else, the
 * drift was invisible because the value was not in the list. Deriving the list
 * from the declarations removes the blind spot by construction — a member added
 * to ANY exported vocabulary is probed on the next run without this file being
 * edited.
 *
 * The residual blind spot is stated rather than hidden: a validator that admits
 * a value present in NO declaration at all (an inline literal, a spread of its
 * own) still cannot be found by a probe. That case is what the SOURCE-LEVEL
 * sweep below catches — it reads the validator's own text and refuses any
 * membership check whose vocabulary is not an identifier imported from
 * `sketchSource.ts`. The two halves cover each other: probes prove the
 * DECLARATION is what the validator admits, the source sweep proves the
 * validator reads the declaration at all.
 */
const CANDIDATES: readonly string[] = [
  ...new Set<string>([
    ...DECLARED_VOCABULARIES.flatMap((name) => {
      const declared: unknown = sketchSource[name];
      if (!Array.isArray(declared)) {
        throw new Error(
          `sketchSource.${name} is not an array (got ${typeof declared}) — DECLARED_VOCABULARIES ` +
            "names a vocabulary that does not exist, so the derived candidate list would silently " +
            "skip every member it declares and the probe could never find a value outside it.",
        );
      }
      return declared as string[];
    }),
    ...OUT_OF_VOCABULARY,
  ]),
];

/**
 * A sentinel no vocabulary contains and no candidate equals. Fed into a probed
 * path, it either comes back as the admitted set or the probe never reached the
 * validator's check — which is what {@link probeReachesValidator} detects.
 */
const SENTINEL = "zz_probe_sentinel_zz";

function issuesAt(issues: readonly ValidationIssue[], path: string): string[] {
  return issues
    .filter((issue) => issue.path === path)
    .map((issue) => `${issue.path}: ${issue.message}`);
}

/**
 * The values a validator ADMITS at `path`, discovered by probing — not read off
 * its source. A candidate is admitted when an otherwise-valid payload carrying
 * it produces no issue at that exact path.
 */
function admittedValues(
  build: (candidate: string) => unknown,
  validate: (value: unknown) => ValidationIssue[],
  path: string,
): string[] {
  return CANDIDATES.filter(
    (candidate) => issuesAt(validate(build(candidate)), path).length === 0,
  );
}

/**
 * Proof that a probe actually reaches the validator's check for `path`.
 *
 * A probe is a payload-BUILDER plus a validator plus a path, and the path is a
 * bare string — so a probe whose builder writes the value somewhere else, or
 * whose payload is refused before the check under test runs, reports "admitted:
 * everything (or nothing)" at a path nothing ever writes. Comparing that to a
 * sketch would then be comparing the sketch to a constant.
 *
 * The sentinel is what distinguishes the two: a payload built with
 * {@link SENTINEL} must produce an ISSUE at that path, because the sentinel is in
 * no vocabulary this repo ships. A probe that admits it is not gating at that
 * path at all; a probe that reports no issue either way has drifted off its
 * target. Both are refused HERE, by name, rather than silently widening a
 * comparison.
 */
function probeReachesValidator(
  label: string,
  build: (candidate: string) => unknown,
  validate: (value: unknown) => ValidationIssue[],
  path: string,
): void {
  expect(
    issuesAt(validate(build(SENTINEL)), path).length,
    `probe "${label}" does not gate ${path}: an out-of-vocabulary sentinel was admitted, ` +
      "so the probe is not reaching the validator's check and any comparison it makes is vacuous",
  ).toBeGreaterThan(0);
}

/**
 * The schema sketch a rendered prompt carries — everything inside the ```json
 * fence after "conform to this JSON schema shape". Reading the RENDERED prompt
 * rather than the source constant is the point: this is the text a worker
 * actually sees, and it is why a probe cannot accidentally compare a constant to
 * itself.
 */
function sketchOf(prompt: string): string {
  const marker = "conform to this JSON schema shape:";
  const section = prompt.split(marker)[1];
  if (section === undefined) return "";
  const fenced = section.split("```json")[1];
  if (fenced === undefined) return "";
  return fenced.split("```")[0]!;
}

/** Every value a sketch offers for `"field": "<a | b | c>"`. */
function offeredValues(sketch: string, field: string): string[] {
  return [...sketch.matchAll(new RegExp(`"${field}": "([^"]*)"`, "g"))].flatMap(
    (match) =>
      match[1]!
        .split("|")
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
  );
}

/** Every distinct value a sketch offers for `"field"` — the union form. */
function offeredValueSet(sketch: string, field: string): string[] {
  return [...new Set(offeredValues(sketch, field))].sort();
}

/**
 * Resolved artifact paths for every contract-pipeline artifact. The values are
 * never read by the renderer (it only prints them), so a fixed synthetic root
 * is enough and keeps this file free of filesystem setup.
 */
const PATHS = Object.fromEntries(
  CP_ARTIFACT_NAMES.map((name) => [
    name,
    `/project/.audit-tools/remediation/intake/contract/${name}.json`,
  ]),
) as Record<ContractPipelineArtifactName, string>;

// ── Payload builders: minimal valid shapes carrying one probed value ──────────

const STAMP = "2026-01-01T00:00:00.000Z";

function goalSpecPayload(sourceType: string): unknown {
  return {
    contract_version: CONTRACT_PIPELINE_GOAL_SPEC_VERSION,
    goal_id: "GOAL-001",
    objective: "o",
    non_goals: [],
    success_criteria: ["s"],
    source_type: sourceType,
    created_at: STAMP,
  };
}

function contextBundlePayload(kind: string): unknown {
  return {
    contract_version: CONTRACT_PIPELINE_CONTEXT_BUNDLE_VERSION,
    goal_id: "GOAL-001",
    entries: [{ path: "src/a.ts", kind, relevance_reason: "r" }],
    context_summary: "c",
    created_at: STAMP,
  };
}

function seamReconciliationPayload(decision: string): unknown {
  return {
    contract_version: CP_SEAM_RECONCILIATION_REPORT_VERSION,
    goal_id: "GOAL-001",
    mismatches: [
      {
        seam_id: "S-1",
        module_a: "a",
        module_b: "b",
        description: "d",
        resolution: { decision, agreed_interface: "i" },
      },
    ],
    created_at: STAMP,
  };
}

function critiquePayload(patch: {
  kind?: unknown;
  severity?: unknown;
  verdict?: unknown;
}): unknown {
  return {
    contract_version: CONTRACT_PIPELINE_CONCEPTUAL_DESIGN_CRITIQUE_VERSION,
    goal_id: "GOAL-001",
    items: [
      {
        id: "C-1",
        kind: patch.kind ?? "concern",
        description: "d",
        severity: patch.severity ?? "advisory",
      },
    ],
    verdict: patch.verdict ?? "approved",
    created_at: STAMP,
  };
}

function cyclicSeamPayload(status: string): unknown {
  return {
    contract_version: CP_CYCLIC_SEAM_RESOLUTION_VERSION,
    goal_id: "GOAL-001",
    cycles: [],
    status,
    created_at: STAMP,
  };
}

function seamCyclePayload(breakStrategy: string): unknown {
  return {
    contract_version: CP_CYCLIC_SEAM_RESOLUTION_VERSION,
    goal_id: "GOAL-001",
    cycles: [
      {
        members: ["OBL-a", "OBL-b"],
        break_strategy: breakStrategy,
        resolution_description: "x",
        exception_registration: null,
      },
    ],
    status: "resolved",
    created_at: STAMP,
  };
}

function obligationLedgerPayload(status: string): unknown {
  return {
    contract_version: CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
    goal_id: "GOAL-001",
    obligations: [
      {
        id: "OBL-1",
        description: "d",
        kind: "invariant",
        depends_on: [],
        status,
      },
    ],
    created_at: STAMP,
  };
}

function testValidatorPlanPayload(kind: string): unknown {
  return {
    contract_version: CONTRACT_PIPELINE_TEST_VALIDATOR_PLAN_VERSION,
    goal_id: "GOAL-001",
    test_specs: [
      { obligation_id: "OBL-1", name: "n", kind, assertions: ["a"] },
    ],
    created_at: STAMP,
  };
}

function assessmentPayload(patch: {
  status?: unknown;
  verdict?: unknown;
}): unknown {
  return {
    contract_version: CONTRACT_PIPELINE_CONTRACT_ASSESSMENT_REPORT_VERSION,
    goal_id: "GOAL-001",
    findings: [
      {
        obligation_id: "OBL-1",
        status: patch.status ?? "satisfied",
        evidence: ["e"],
        rationale: "r",
      },
    ],
    verdict: patch.verdict ?? "passed",
    created_at: STAMP,
  };
}

function judgePayload(patch: {
  target?: unknown;
  verdict?: unknown;
  classification?: unknown;
}): unknown {
  return {
    contract_version: CONTRACT_PIPELINE_JUDGE_REPORT_VERSION,
    goal_id: "GOAL-001",
    verdict: patch.verdict ?? "needs_repair",
    classifications: [
      {
        counterexample_id: "CE-1",
        classification: patch.classification ?? "accepted",
        rationale: "r",
      },
    ],
    repair_directive: {
      target: patch.target ?? "obligation_ledger",
      instruction: "regenerate it",
    },
    created_at: STAMP,
  };
}

function verificationPayload(kind: string): unknown {
  return {
    contract_version: CONTRACT_PIPELINE_VERIFICATION_REPORT_VERSION,
    goal_id: "GOAL-001",
    findings: [
      {
        finding_id: "F-1",
        traces: [
          {
            trace_id: "T-1",
            kind,
            label: "x",
            evidence: ["y"],
            status: "passed",
          },
        ],
        overall_status: "passed",
      },
    ],
    overall_status: "passed",
    created_at: STAMP,
  };
}

function verificationTraceStatusPayload(status: string): unknown {
  const payload = verificationPayload("requirement") as {
    findings: { traces: { status: unknown }[] }[];
  };
  payload.findings[0]!.traces[0]!.status = status;
  return payload;
}

function verificationFindingStatusPayload(status: string): unknown {
  const payload = verificationPayload("requirement") as {
    findings: { overall_status: unknown }[];
  };
  payload.findings[0]!.overall_status = status;
  return payload;
}

function verificationReportStatusPayload(status: string): unknown {
  const payload = verificationPayload("requirement") as { overall_status: unknown };
  payload.overall_status = status;
  return payload;
}

function dagPayload(nodeStatus: string, edgeKind = "dependency"): unknown {
  return {
    contract_version: CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION,
    goal_id: "GOAL-001",
    nodes: [
      {
        id: "N-1",
        title: "t",
        description: "d",
        satisfies_obligations: ["OBL-1"],
        addresses_counterexamples: [],
        depends_on: [],
        output_files: ["src/a.ts"],
        verification_obligation_ids: [],
        targeted_commands: ["npm test"],
        status: nodeStatus,
      },
      {
        id: "N-2",
        title: "t2",
        description: "d2",
        satisfies_obligations: ["OBL-2"],
        addresses_counterexamples: [],
        depends_on: [],
        output_files: ["src/b.ts"],
        verification_obligation_ids: [],
        targeted_commands: ["npm test"],
        status: "pending",
      },
    ],
    edges: [{ from: "N-1", to: "N-2", kind: edgeKind }],
    created_at: STAMP,
  };
}

// ── Probes: what a field's vocabulary IS, derived from the validator ─────────

interface Vocabulary {
  /** Role name as it appears in ROLES. */
  readonly role: string;
  /** The field name as the sketch renders it. */
  readonly field: string;
  readonly build: (candidate: string) => unknown;
  readonly validate: (value: unknown) => ValidationIssue[];
  /**
   * The validator issue path this probe reads — which is also, for the sweep's
   * per-occurrence comparison, the address of the SPECIFIC occurrence this probe
   * settles. Two entries may share (role, field); their paths are what tell them
   * apart, and {@link computeOccurrences} derives each one's render position from
   * its own path.
   *
   * Deliberately the path the validator actually reports on, even where that is
   * a record rather than the field itself — `verification_report.findings[0]
   * .overall_status` addresses the finding, which is exactly what the sketch
   * renders for that occurrence.
   */
  readonly path: string;
  /**
   * The DECLARATION naming the values the validator admits that the sketch
   * deliberately does not offer — the accept-legacy / emit-current split.
   *
   * The values themselves used to be spelled out here, which reintroduced the
   * very defect this file bans: a hand-kept copy of a vocabulary, edited in
   * lockstep with the thing it describes. It is a REFERENCE to the declaration
   * now, so the legacy set has exactly one home
   * (`sketchSource.CONTRACT_REPAIR_TARGETS_LEGACY`) and the sweep subtracts it
   * at comparison time.
   */
  readonly offeredExclusions?: readonly string[];
}

/**
 * The per-role vocabularies, declared as DATA (role + field → probe).
 *
 * It is a MATCH TABLE, not the property: the sweep below reads the rendered
 * sketches to find what needs matching, and fails on anything this table cannot
 * match. Adding a vocabulary to this table is how a NEW sketch gets covered;
 * forgetting to is impossible to do silently, because the sweep reds and names
 * the role and field.
 */
const VOCABULARIES: readonly Vocabulary[] = [
  {
    role: "goal_normalization",
    field: "source_type",
    build: goalSpecPayload,
    validate: validateGoalSpec,
    path: "goal_spec.source_type",
  },
  {
    role: "context_collection",
    field: "kind",
    build: contextBundlePayload,
    validate: validateContextBundle,
    path: "context_bundle.entries[0].kind",
  },
  {
    role: "seam_reconciliation",
    field: "decision",
    build: seamReconciliationPayload,
    validate: validateSeamReconciliationReport,
    path: "seam_reconciliation_report.mismatches[0].resolution.decision",
  },
  {
    role: "critique",
    field: "kind",
    build: (candidate) => critiquePayload({ kind: candidate }),
    validate: validateConceptualDesignCritique,
    path: "conceptual_design_critique.items[0].kind",
  },
  {
    role: "critique",
    field: "severity",
    build: (candidate) => critiquePayload({ severity: candidate }),
    validate: validateConceptualDesignCritique,
    path: "conceptual_design_critique.items[0].severity",
  },
  {
    role: "critique",
    field: "verdict",
    build: (candidate) => critiquePayload({ verdict: candidate }),
    validate: validateConceptualDesignCritique,
    path: "conceptual_design_critique.verdict",
  },
  {
    role: "cyclic_seam_resolution",
    field: "break_strategy",
    build: seamCyclePayload,
    validate: validateCyclicSeamResolution,
    path: "cyclic_seam_resolution.cycles[0].break_strategy",
  },
  {
    role: "cyclic_seam_resolution",
    field: "status",
    build: cyclicSeamPayload,
    validate: validateCyclicSeamResolution,
    path: "cyclic_seam_resolution.status",
  },
  {
    role: "obligation_ledger",
    field: "kind",
    build: (candidate) => {
      // Built from a SPREAD, not a cast-then-mutate. `obligationLedgerPayload`
      // is annotated `unknown`, and an `as { obligations: {kind: unknown}[] }`
      // assertion over it erases the very check the probe is making — the
      // compiler stops tracing the field, so a builder that wrote the value
      // somewhere else would still typecheck and the probe would quietly admit
      // junk (this exact mistake was caught by the sweep reporting 2 of 4 kinds
      // admitted, which is what the sentinel check now refuses by name).
      const { obligations: _ignored, ...rest } = obligationLedgerPayload(
        "pending",
      ) as Record<string, unknown>;
      return {
        ...rest,
        obligations: [
          {
            id: "OBL-1",
            description: "d",
            kind: candidate,
            depends_on: [],
            status: "pending",
          },
        ],
      };
    },
    validate: validateObligationLedger,
    path: "obligation_ledger.obligations[0].kind",
  },
  {
    role: "obligation_ledger",
    field: "status",
    build: obligationLedgerPayload,
    validate: validateObligationLedger,
    path: "obligation_ledger.obligations[0].status",
  },
  {
    role: "test_validator_plan",
    field: "kind",
    build: testValidatorPlanPayload,
    validate: validateTestValidatorPlan,
    path: "test_validator_plan.test_specs[0].kind",
  },
  {
    role: "assessment",
    field: "status",
    build: (candidate) => assessmentPayload({ status: candidate }),
    validate: validateContractAssessmentReport,
    path: "contract_assessment_report.findings[0].status",
  },
  {
    role: "assessment",
    field: "verdict",
    build: (candidate) => assessmentPayload({ verdict: candidate }),
    validate: validateContractAssessmentReport,
    path: "contract_assessment_report.verdict",
  },
  {
    role: "judge",
    field: "verdict",
    build: (candidate) => judgePayload({ verdict: candidate }),
    validate: validateJudgeReport,
    path: "judge_report.verdict",
  },
  {
    role: "judge",
    field: "target",
    build: (candidate) => judgePayload({ target: candidate }),
    validate: validateJudgeReport,
    path: "judge_report.repair_directive.target",
    // The accept-legacy / emit-current split: a judge report written by an
    // older release still LOADS (the validator keeps accepting `design_spec`,
    // with a named back-compat test behind it), while no NEW report should be
    // authored against a name the repair loop immediately normalizes away. The
    // set is READ OFF the shared declaration, never re-listed.
    offeredExclusions: CONTRACT_REPAIR_TARGETS_LEGACY,
  },
  {
    role: "judge",
    field: "classification",
    build: (candidate) => judgePayload({ classification: candidate }),
    validate: validateJudgeReport,
    path: "judge_report.classifications[0].classification",
  },
  {
    role: "implementation_planning",
    field: "status",
    build: (candidate) => dagPayload(candidate),
    validate: validateImplementationDAG,
    path: "implementation_dag.nodes[0].status",
  },
  {
    role: "implementation_planning",
    field: "kind",
    build: (candidate) => dagPayload("pending", candidate),
    validate: validateImplementationDAG,
    path: "implementation_dag.edges[0].kind",
  },
  {
    role: "closing",
    field: "kind",
    build: verificationPayload,
    validate: validateVerificationReport,
    path: "verification_report.findings[0].traces[0].kind",
  },
  {
    role: "closing",
    field: "status",
    build: verificationTraceStatusPayload,
    validate: validateVerificationReport,
    path: "verification_report.findings[0].traces[0].status",
  },
  {
    role: "closing",
    field: "overall_status",
    build: verificationFindingStatusPayload,
    validate: validateVerificationReport,
    path: "verification_report.findings[0].overall_status",
  },
  {
    role: "closing",
    field: "overall_status",
    build: verificationReportStatusPayload,
    validate: validateVerificationReport,
    path: "verification_report.overall_status",
  },
];

/**
 * Fields whose sketch offers a value but which no probe settles — asserted
 * EMPTY, so the only way to silence the sweep is to add a real probe.
 *
 * It exists at all so the sweep can be honest about the one legitimate case: a
 * sketch may carry a value placeholder that is not an enumeration of ADMITTED
 * values, and the sweep would still see an alternation in it. Today there are
 * none, and nothing may be added here without the reasoning that makes the
 * field genuinely unprobeable — which is the review this list forces.
 */
const UNPROBED_FIELDS: readonly string[] = [];

// ── The sweep ────────────────────────────────────────────────────────────────

/**
 * One enum alternation found in a rendered sketch, located by its own text.
 *
 * The `values` are exactly the pipe-separated members the sketch renders, so a
 * sketch that hand-writes `"a|b"` and one that renders `"a | b"` are the same
 * finding — the separators are not part of the comparison, only of the parse.
 */
interface SketchAlternation {
  readonly role: string;
  readonly field: string;
  /**
   * Which appearance of this field within the sketch, in render order, counting
   * from 0. Two probes may share one field name in one sketch (`closing` renders
   * `overall_status` per finding and again at report level, and the two disagree
   * — the report level excludes `skipped`), and the sketch carries no label
   * saying which is which. Render order is the only in-sketch fact that
   * separates them, so it is what {@link vocabularyFor} matches on.
   */
  readonly occurrence: number;
  readonly values: string[];
}

/**
 * A contract-version literal — one or more lowercase id segments then `/v<semver>`,
 * e.g. `remediate-code-contract-pipeline/goal-spec/v1alpha1` or the
 * two-segment `remediate-code-verification-report/v1alpha1`. Every sketch opens
 * with one, and it is an IDENTITY rather than a vocabulary: the validator does
 * not admit a set of them, it checks one exact value.
 */
const CONTRACT_VERSION_LITERAL =
  /^[a-z0-9-]+(\/[a-z0-9-]+)*\/v\d+[a-z0-9]*$/;

/**
 * A concrete instance a sketch shows IN PLACE OF a placeholder — today the
 * critic's `"id": "CE-001"`, which demonstrates the id format rather than
 * enumerating an admitted set. Recognized by SHAPE as an id token: uppercase
 * prefix, dash, digits. Deliberately narrow, so it cannot swallow a real
 * one-member vocabulary.
 */
const EXEMPLAR_ID_LITERAL = /^[A-Z][A-Z0-9]*-[0-9]+$/;

/**
 * A placeholder that NAMES a field of the same object — `<module-name — must
 * match module_decomposition>`, `<the clause_id above>`. Not a vocabulary: the
 * sketch is pointing at a field the validator checks against another object,
 * often with prose around the reference.
 */
const FIELD_REFERENCE_PLACEHOLDER = /^<[^>]*\b[a-z][a-z0-9]*_[a-z0-9_]*\b[^>]*>$/;

/**
 * Every `"field": "a | b"` / `"field": "a|b"` / `"field": "a"` alternation in a
 * rendered sketch, found from the RENDERED TEXT — never from a list of fields
 * this file keeps. That is what makes a sketch added later covered on the day it
 * exists rather than on the day someone remembers to extend a table.
 *
 * A single-member `"field": "a"` counts too: a one-value "vocabulary" is exactly
 * the shape the `implementation_dag` node `status` drift had at HEAD (1 shown,
 * 4 admitted), and skipping it because it has no `|` would let that drift back
 * in.
 */
function findAlternations(role: string, sketch: string): SketchAlternation[] {
  const found: SketchAlternation[] = [];
  // `occurrence` counts this field's appearances WITHIN THIS SKETCH, in render
  // order. Two probes may share one field name in one sketch (`closing` renders
  // `overall_status` per finding and again at report level; the two disagree —
  // the report level excludes `skipped`), and the sketch does not label which is
  // which. Render order is the only in-sketch fact that separates them, so it is
  // the index {@link vocabularyFor} matches on.
  const seen = new Map<string, number>();
  for (const match of sketch.matchAll(/"([a-z_][a-z0-9_]*)": "([^"]*)"/g)) {
    const field = match[1]!;
    const raw = match[2]!;
    // A sketch slot WRAPS a rendered vocabulary in prose when it carries a
    // separator: `"decision": "<which side adjusts — A | B | both>"`. That is a
    // real alternation the worker reads, so the wrapping bracket is peeled —
    // but ONLY when a `|` proves the slot is an alternation. Peeling first and
    // testing after would turn every free-text placeholder (`<module-name>`,
    // `<repo-relative>`) into a one-member "vocabulary" and red on the whole
    // renderer.
    const wrappedAlternation = raw.includes("|")
      ? raw.replace(/^</, "").replace(/>$/, "").trim()
      : raw;
    // …and any prose LEADING the alternation is dropped, so `"<which side
    // adjusts — A | B | both>"` yields `[A, B, both]` rather than gluing the
    // preamble onto `A`. The first value begins after the last em-dash or colon
    // in the preamble; a slot with no such marker parses from its own start.
    const unwrapped = wrappedAlternation.includes("|")
      ? wrappedAlternation.replace(/^.*[—:]\s*/, "")
      : wrappedAlternation;
    // What survives as free text — `<repo-relative>`, a bare `...`, an empty
    // string — carries no admitted set, and the angle-bracket/ellipsis shape is
    // how every sketch in this repo spells one. Skipped by SHAPE rather than by
    // name, so rewording a placeholder does not need this file touched.
    if (unwrapped.length === 0) continue;
    if (FIELD_REFERENCE_PLACEHOLDER.test(raw)) continue;
    if (/[<>]/.test(unwrapped)) continue;
    if (unwrapped === "...") continue;
    // A schema-version literal is not a vocabulary either, and the fallback for
    // a field the sweep has never seen is to treat it as one — which is the safe
    // direction, because an unmatched alternation fails the suite rather than
    // being ignored. This is the ONE genre skipped by SHAPE alone, and the shape
    // is the contract-version id grammar itself (`<tool>/<artifact>/v<semver>`),
    // which every sketch in this repo spells the same way.
    if (CONTRACT_VERSION_LITERAL.test(unwrapped)) continue;
    if (EXEMPLAR_ID_LITERAL.test(unwrapped)) continue;
    const values = unwrapped
      .split("|")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (values.length === 0) continue;
    const occurrence = seen.get(field) ?? 0;
    seen.set(field, occurrence + 1);
    found.push({ role, field, occurrence, values });
  }
  return found;
}

/**
 * A vocabulary bound to the occurrence of its field it owns.
 *
 * The same (role, field) pair can carry more than one probe, and most of the
 * time the pair is unique — `computeOccurrences` binds every such entry to
 * occurrence 0 and shares that binding across the whole table, so the common
 * case costs one derivation rather than a per-entry special case.
 */
interface BoundVocabulary {
  readonly entry: Vocabulary;
  readonly occurrence: number;
}

/**
 * The NESTING ORDER a vocabulary's path descends through, e.g.
 * `verification_report.findings[0].traces[0].kind` → `["findings", "traces"]`.
 * Array-typed fields only: a record-valued field (`repair_directive`) does not
 * separate occurrences, because two occurrences of one field name inside one
 * object would render as the same key and be indistinguishable in the sketch
 * anyway.
 */
function nestingPath(path: string): string[] {
  return [...path.matchAll(/([a-z_][a-z0-9_]*)\[\d+\]/g)].map((match) => match[1]!);
}

/**
 * Bind every vocabulary to its occurrence index.
 *
 * An entry is the SOLE probe for its (role, field) pair in every common case, and
 * occurrence 0 is the whole of the relationship. Where two entries share the
 * pair, their order is derived from the sketch the role renders — the character
 * position at which each one's field is reached — rather than declared as
 * "finding is 0, report is 1". Deriving it is what keeps the binding honest:
 * reorder the schema and the binding moves with it, so the comparison cannot
 * silently point at the wrong validator.
 */
function computeOccurrences(): BoundVocabulary[] {
  const byPair = new Map<string, Vocabulary[]>();
  for (const entry of VOCABULARIES) {
    const key = `${entry.role}.${entry.field}`;
    byPair.set(key, [...(byPair.get(key) ?? []), entry]);
  }

  const bound: BoundVocabulary[] = [];
  for (const [key, entries] of byPair) {
    if (entries.length === 1) {
      bound.push({ entry: entries[0]!, occurrence: 0 });
      continue;
    }
    const sketch = sketchOf(
      renderContractPipelinePrompt({
        role: entries[0]!.role,
        artifactPaths: PATHS,
      }).prompt,
    );
    // Order the entries by WHERE their field occurs in the rendered text, read
    // off the sketch rather than declared: the sketch is what the worker sees,
    // and the sweep compares occurrence N of a field against the Nth occurrence
    // the sketch actually rendered. A field nested inside `findings` is found by
    // walking to the array's own line first; a field at the sketch root is found
    // at the root. Both are positions in the SAME character stream, so ordering
    // them is a sort on one comparable.
    const positions = entries.map((entry) => {
      const nesting = nestingPath(entry.path);
      const head = nesting[nesting.length - 1];
      const anchor =
        head === undefined
          ? sketch.indexOf(`"${entry.field}"`)
          : sketch.indexOf(`"${head}": [{`);
      const keyAt = sketch.indexOf(`"${entry.field}"`, anchor < 0 ? 0 : anchor);
      return { entry, at: anchor < 0 ? -1 : keyAt };
    });
    for (const { entry, at } of positions) {
      if (at < 0) {
        throw new Error(
          `cannot locate the occurrence of "${key}" in the ${entry.role} sketch: its path ` +
            `(${entry.path}) descends through a field the rendered sketch does not carry. Either ` +
            `the path is wrong or the sketch no longer renders that nesting — the sweep refuses ` +
            `to guess which validator a rendered alternation belongs to.`,
        );
      }
    }
    positions.sort((a, b) => a.at - b.at);
    positions.forEach(({ entry }, index) => bound.push({ entry, occurrence: index }));
  }
  return bound;
}

const VOCABULARY_OCCURRENCES: readonly BoundVocabulary[] = computeOccurrences();

/**
 * Find the vocabulary entry a rendered occurrence resolves to, if any.
 *
 * The match is (role, field, occurrence-in-render-order). The order is READ OFF
 * each vocabulary's own payload SHAPE — the path's record indices are the
 * nesting depth, and the sketch renders records in the shape's own order — which
 * is the same derivation for the single-occurrence case (everything is index 0)
 * as for the two that collide. A vocabulary whose position cannot be derived is
 * reported by the caller as unmatched, never guessed at: a guess would compare a
 * sketch to the WRONG validator, which is worse than no comparison.
 */
function vocabularyFor(
  alternation: SketchAlternation,
): Vocabulary | undefined {
  const matches = VOCABULARY_OCCURRENCES.filter(
    (candidate) =>
      candidate.entry.role === alternation.role &&
      candidate.entry.field === alternation.field &&
      candidate.occurrence === alternation.occurrence,
  );
  return matches.length === 1 ? matches[0]!.entry : undefined;
}

// ── The source sweep: every membership check reads a declaration ─────────────

/**
 * The validator modules the probes call, and — for each — the validator
 * function names it is expected to carry.
 *
 * A module is listed here when its vocabulary checks are the ones a sketch's
 * writer must obey. `contractPipelineGates.ts` is NOT listed, and the reason is
 * a checked fact rather than an omission: its `.includes(` calls are on
 * per-payload COLLECTIONS (`mod.prepares_seam_ids`, `check.collections`) and on
 * substring probes (`corpus.includes(t)`), not on value vocabularies — the
 * `membershipCheckSites` sweep excludes array-receiver calls by shape, so
 * listing the module would add no coverage.
 *
 * `remediationState.ts` is likewise absent, and the reason is about its
 * MECHANISM as well as its subject: its vocabularies (`VALID_SEVERITIES` and
 * friends) are `new Set([...])` compared with `.has(...)`, not `.includes(` —
 * so the `membershipCheckSites` sweep, which keys on `.includes(`, sees nothing
 * in the module to check in the first place. Listing it would not even be
 * vacuous coverage; the sweep would simply find no site. Its subject is the
 * other half of the reason: those sets gate the remediator's OWN state file,
 * which no contract-pipeline sketch renders, so bringing the module in properly
 * would mean inventing probes for sketches that do not exist.
 *
 * A module added to a validator path later belongs here; the floor assertion in
 * the "reaches the validators" test is what makes forgetting visible.
 */
const VALIDATOR_MODULES: ReadonlyMap<string, readonly string[]> = new Map([
  [
    "src/remediate/validation/contractPipeline.ts",
    [
      "validateGoalSpec",
      "validateContextBundle",
      "validateSeamReconciliationReport",
      "validateConceptualDesignCritique",
      "validateObligationLedger",
      "validateTestValidatorPlan",
      "validateContractAssessmentReport",
      "validateJudgeReport",
      "validateImplementationDAG",
      "validateVerificationReport",
      "validateCyclicSeamResolution",
    ],
  ],
]);

/**
 * Every module that renders a schema sketch — the texts whose alternations the
 * sweeps above compare against a validator.
 *
 * `contractPipelinePrompts.ts` is the renderer proper (ROLES' outputSchema, plus
 * the repair prompt's per-target schema, which reuses those same role strings).
 * `contractPipeline.ts` is the second sketch source: the gate's inline prompts
 * carry their own JSON shapes (the cyclic-seam record, and the per-module shard
 * shape the module wave emits).
 */
const SKETCH_SOURCE_MODULES: readonly string[] = [
  "src/remediate/steps/contractPipelinePrompts.ts",
  "src/remediate/steps/contractPipeline.ts",
];

/**
 * A `"field": "a | b | …"` slot spelled out as a literal inside a sketch.
 *
 * The match is on a string literal containing a `|` in a value position of an
 * object literal — `"kind": "source|test"`, `"decision": "<A | B | both>"`. A
 * slot rendered from a declaration reads `"kind": "${sketchValues(KINDS)}"`,
 * whose literal contains no `|`, so it never matches.
 *
 * Only files in {@link SKETCH_SOURCE_MODULES} are scanned, and within them only
 * this shape. That narrowness is deliberate: a broad "any string containing a
 * pipe" rule would fire on every markdown table and prose sentence in these
 * modules and train the reader to skip the test, which is how a gate dies.
 */
function literalAlternations(source: string, file: string): string[] {
  const findings: string[] = [];
  for (const [index, line] of source.split("\n").entries()) {
    for (const match of line.matchAll(/"([a-z_][a-z0-9_]*)"\s*:\s*"([^"]*)"/g)) {
      const value = match[2]!;
      if (!value.includes("|")) continue;
      findings.push(
        `${file}:${index + 1} — \`"${match[1]}": "${value}"\` spells out its alternation. ` +
          "Render it through `sketchValues(<declaration>)` so the sketch cannot disagree with the " +
          "validator that reads the field.",
      );
    }
  }
  return findings;
}

/**
 * Repo root, resolved from THIS file's own location rather than from `cwd`.
 *
 * The source sweep reads validator modules off disk, so it needs a path that
 * holds wherever vitest is invoked from — `process.cwd()` does not, and a
 * cwd-relative read is the failure mode where the sweep silently reads nothing
 * and reports clean.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** One `something.member(…, VOCABULARY, …)` call site, addressed by line. */
interface MembershipCheckSite {
  readonly file: string;
  readonly line: number;
  /** The callee, e.g. `requireOneOf` (from `requireOneOf(...)`) or `includes`. */
  readonly callee: string;
  /** The argument in the vocabulary position, as written. */
  readonly argument: string;
  /** Which argument position the vocabulary occupies, 0-based (1 for `requireOneOf`). */
  readonly argumentIndex: number;
  /** The full call text, so a failure can quote it rather than describe it. */
  readonly text: string;
}

/**
 * Every value-vocabulary membership check in a module's source, found by
 * SHAPE.
 *
 * Two shapes count, and they are the two the validators actually use:
 *
 *   1. `requireOneOf(value, VOCAB, path, issues)` — the shared helper in
 *      `validation/contractPipeline.ts`. Its vocabulary is argument 1.
 *   2. `<expr>.includes(<arg>)` where `<expr>` is a BARE IDENTIFIER — a
 *      module-level constant such as `VALID_SEVERITIES`. The bare-identifier
 *      receiver is what separates a vocabulary from a per-payload collection:
 *      `mod.prepares_seam_ids.includes(id)` has a PROPERTY receiver and is
 *      excluded, which is correct and is why `contractPipelineGates.ts` needs
 *      no exemption.
 *
 * A `.some(`/`.filter(` over a string array is deliberately NOT matched: those
 * carry predicates, not vocabularies, and matching them would make the sweep
 * demand a declaration for `file_scope.some((p) => p.endsWith(".ts"))` — a rule
 * that would be wrong and would train the reader to skip the whole test.
 */
function membershipCheckSites(source: string): MembershipCheckSite[] {
  const sites: MembershipCheckSite[] = [];
  // ⚠ Scanned over the WHOLE SOURCE, never line by line. A line-based scan
  // silently drops every call whose arguments wrap — which is most of them:
  // `requireOneOf(\n  cycle.break_strategy,\n  CYCLIC_SEAM_BREAK_STRATEGIES,…`
  // puts the vocabulary on line 2, so a per-line regex sees only the callee and
  // no argument. Measured 2026-09-11: a spread added to the multi-line
  // seam-decision call left this sweep GREEN. The line number is recovered from
  // the match OFFSET rather than from the loop index for the same reason.
  for (const match of source.matchAll(/\b(requireOneOf|requireOneOfStrict)\s*\(/g)) {
    // The helper's own DECLARATION is not a call site: `function requireOneOf(`
    // is followed by the parameter list `value, allowed: readonly string[], …`,
    // so argument 1 is the PARAMETER TYPE, not a vocabulary. Only a call is
    // audited; a declaration is skipped by the `function` keyword that
    // immediately precedes it.
    const before = source.slice(Math.max(0, match.index - 24), match.index);
    if (/\bfunction\s+$/.test(before)) continue;
    const open = match.index + match[0].length - 1;
    const raw = balancedCallBody(source, open);
    if (raw === undefined) continue;
    const args = splitTopLevelArgs(raw);
    if (args.length < 2) continue;
    sites.push({
      file: "",
      line: lineOf(source, match.index),
      callee: match[1]!,
      argument: args[1]!.trim(),
      argumentIndex: 1,
      text: raw.trim().split("\n")[0]!.trim(),
    });
  }
  for (const match of source.matchAll(/\b([A-Z][A-Z0-9_]*)\s*\.\s*includes\s*\(/g)) {
    sites.push({
      file: "",
      line: lineOf(source, match.index),
      callee: "includes",
      argument: match[1]!,
      argumentIndex: 0,
      text: match[0].trim(),
    });
  }
  return sites;
}

/** 1-based line number of a character offset. */
function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i += 1) if (source[i] === "\n") line += 1;
  return line;
}

/**
 * The text between a call's opening `(` at `openIndex` and its MATCHING `)`.
 *
 * Bracket-balanced over the whole source, so a call whose arguments wrap over
 * six lines, nest template literals with `${…}` interpolation, or contain
 * nested calls is read whole. Returns `undefined` on an unbalanced tail, which
 * the caller skips rather than guessing at.
 */
function balancedCallBody(source: string, openIndex: number): string | undefined {
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    const char = source[i]!;
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, i);
    }
  }
  return undefined;
}

/**
 * Split a call's argument list on TOP-LEVEL commas only.
 *
 * Needed because the vocabulary argument is routinely a multi-line spread on
 * the second line of the call:
 *
 *     requireOneOf(
 *       cycle.break_strategy,
 *       CYCLIC_SEAM_BREAK_STRATEGIES,
 *       `${path}.cycles[${i}].break_strategy`,
 *       issues,
 *     );
 *
 * A naive `split(",")` would chop the template literal's `${path}` in half and
 * mis-index every argument after it.
 */
function splitTopLevelArgs(raw: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i]!;
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") {
      if (depth === 0) break;
      depth -= 1;
    } else if (char === "," && depth === 0) {
      args.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim().length > 0) args.push(current);
  return args;
}

/**
 * Whether a vocabulary argument is a bare identifier — the only shape that can
 * be a declaration.
 *
 * `JUDGE_VERDICTS` is; every one of these is not:
 *
 *   - `[...JUDGE_VERDICTS, "redproof_member"]` — a spread, which is an inline
 *     list wearing the declaration's name;
 *   - `["a", "b"]` — an inline list outright;
 *   - `LOCAL_LIST` declared in the same function body — a bare identifier, but
 *     not one the module IMPORTS, which is why the sweep also checks the import.
 *   - `GOAL_SOURCE_TYPES.concat("x")`, `VALUES as readonly string[]` — an
 *     expression, so not a bare identifier.
 */
function isDeclarationBacked(argument: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(argument.trim());
}

/**
 * Audit one module: every membership check's vocabulary argument must be a bare
 * identifier IMPORTED from `sketchSource.ts`.
 *
 * The import check is what makes "named the same thing locally" insufficient.
 * A validator that declares its own `const JUDGE_VERDICTS = [...]` is a bare
 * identifier and would pass a shape-only test while being exactly the second
 * copy this file bans.
 */
function auditMembershipChecks(
  source: string,
  file: string,
  validatorNames: readonly string[],
): string[] {
  const findings: string[] = [];
  const imported = sketchSourceIdentifiers(source);
  for (const site of membershipCheckSites(source)) {
    if (!isDeclarationBacked(site.argument)) {
      findings.push(
        `${file}:${site.line} — ${site.callee}(…) takes its vocabulary from an inline expression ` +
          `\`${site.argument}\`, not from a declaration. An inline list (or a spread of one) is a ` +
          `second copy of a vocabulary and is free to drift from the sketch and from the other ` +
          `readers. Import the declaration from contractPipeline/sketchSource.ts.`,
      );
      continue;
    }
    if (!imported.has(site.argument)) {
      findings.push(
        `${file}:${site.line} — ${site.callee}(…) reads \`${site.argument}\`, which is NOT imported ` +
          `from contractPipeline/sketchSource.ts. A locally declared constant of the same name is ` +
          `the same defect as an inline array: the sketch renders the shared declaration while this ` +
          `check enforces a private one.`,
      );
    }
  }
  // A module that declares validators but has NO membership check at all is a
  // sweep that read the wrong file — reported here so the failure names the
  // file rather than surfacing as a mysterious drop in the floor count.
  if (validatorNames.length > 0 && membershipCheckSites(source).length === 0) {
    findings.push(
      `${file} declares ${validatorNames.length} validator(s) but carries no membership check the ` +
        "sweep can see — either the checks moved or the sweep is reading the wrong text.",
    );
  }
  return findings;
}

/**
 * The identifiers a module imports from `sketchSource.ts`, aliases included.
 *
 * Resolved against the source's own import declaration so a renamed import
 * (`GOAL_SOURCE_TYPES as GOAL_TYPES`) counts, and a same-named LOCAL constant
 * does not.
 *
 * ⚠ The body is matched with `[^}]*`, NOT the obvious `[\s\S]*?`. A lazy
 * any-character run still consumes ACROSS a closing brace when the text after
 * it does not match, so `import { A } from "shared"; import { B } from
 * "sketchSource.js";` is matched ONCE — from the FIRST `{` to the LAST `}` —
 * and the function returns the OTHER module's imports. That exact bug shipped
 * in the first draft of this sweep and reported a correctly-imported
 * `ASSESSMENT_FINDING_STATUSES` as locally declared. A brace cannot appear
 * inside an import specifier list, so excluding it is both correct and the
 * reason the bug cannot come back.
 */
function sketchSourceIdentifiers(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(
    /import\s*\{([^}]*)\}\s*from\s*["'][^"']*contractPipeline\/sketchSource\.js["']/g,
  )) {
    for (const entry of match[1]!.split(",")) {
      const parts = entry.trim().split(/\s+as\s+/);
      const local = (parts[1] ?? parts[0])?.trim();
      if (local && local !== "type") names.add(local);
    }
  }
  return names;
}

describe("step prompt sketches derive from the validators that read their output", () => {
  it("every name in DECLARED_VOCABULARIES is a real array on sketchSource", () => {
    // The derived candidate list reads its members through a namespace import,
    // so a name that is absent or misspelled would contribute NOTHING rather
    // than failing — the candidate list would silently narrow to whatever the
    // remaining names declare, and every probe against the missing vocabulary
    // would report an admitted set drawn from someone else's values. Asserted
    // by name, before any probe runs, so the failure reads as the typo it is.
    const broken = DECLARED_VOCABULARIES.filter(
      (name) => !Array.isArray(sketchSource[name]),
    );
    expect(
      broken,
      `these names in DECLARED_VOCABULARIES are not arrays on sketchSource: ${broken.join(", ")}`,
    ).toEqual([]);
  });

  it("the probe candidate list CONTAINS every declared member, by construction", () => {
    // The superset property, which used to be asserted against a hand-written
    // list. It now holds by construction — CANDIDATES is a spread of these very
    // declarations — so what is asserted here is the CONSTRUCTION, not the
    // contents: the values really did arrive from the declarations (a filter or
    // a slice that quietly dropped some would red here), and the
    // out-of-vocabulary values are still present so a probe can still report
    // "refused".
    const declared = DECLARED_VOCABULARIES.flatMap(
      (name) => sketchSource[name] as readonly string[],
    );
    const missing = [...new Set(declared)].filter((value) => !CANDIDATES.includes(value));
    expect(missing, `the derived list dropped these: ${missing.join(", ")}`).toEqual([]);
    expect(CANDIDATES.length).toBeGreaterThan(new Set(declared).size);
    for (const value of OUT_OF_VOCABULARY) {
      expect(CANDIDATES, `${value} must stay in the list`).toContain(value);
    }
  });

  it("every probe reaches the validator check it names (no vacuous comparison)", () => {
    for (const entry of VOCABULARIES) {
      probeReachesValidator(
        `${entry.role}.${entry.field}`,
        entry.build,
        entry.validate,
        entry.path,
      );
    }
  });

  it("EVERY enum alternation in EVERY role sketch matches a validator probe", () => {
    // The property, swept. Every role in ROLES is rendered, every alternation in
    // the rendered text is found, and each one must resolve to a probe that
    // derives its admitted set. A role with no sketch at all, a field with no
    // probe, or a probe that disagrees with the sketch all surface here — by
    // role and field — rather than waiting for someone to notice.
    const alternations: SketchAlternation[] = [];
    for (const role of Object.keys(ROLES)) {
      const sketch = sketchOf(
        renderContractPipelinePrompt({ role, artifactPaths: PATHS }).prompt,
      );
      alternations.push(...findAlternations(role, sketch));
    }

    // The sweep must FIND something, or a renderer change that emptied the
    // sketches would make this test pass by having nothing to check.
    expect(
      alternations.length,
      "the sweep found no enum alternations at all — the sketches are not being rendered",
    ).toBeGreaterThan(10);

    // …and it must find each one in the role that OWNS it. A relocated sketch
    // (a field moved to another role's outputSchema, or a role's sketch lost to
    // a refactor) would otherwise pass silently: the alternation is still found,
    // and still matched to its probe, but the prompt that renders it is no
    // longer the prompt the worker reads for that phase.
    const foundByRole = new Set(alternations.map((a) => a.role));
    const expectedRoles = VOCABULARIES.map((entry) => entry.role);
    const missingRoles = [...new Set(expectedRoles)].filter(
      (role) => !foundByRole.has(role),
    );
    expect(
      missingRoles,
      "these roles render no enum alternation at all, yet vocabularies are declared against them — " +
        "the sketch moved or was emptied, and the probe is now comparing nothing",
    ).toEqual([]);

    const unmatched: string[] = [];
    const mismatched: string[] = [];
    for (const alternation of alternations) {
      const key = `${alternation.role}.${alternation.field}`;
      if (UNPROBED_FIELDS.includes(key)) continue;
      const entry = vocabularyFor(alternation);
      if (!entry) {
        unmatched.push(
          `${key} renders ${JSON.stringify(alternation.values)} with no matching probe`,
        );
        continue;
      }
      const admitted = admittedValues(entry.build, entry.validate, entry.path)
        .filter((value) => !(entry.offeredExclusions ?? []).includes(value))
        .sort();
      const offered = [...alternation.values].sort();
      if (JSON.stringify(admitted) !== JSON.stringify(offered)) {
        mismatched.push(
          `${key}: sketch offers [${offered.join(", ")}], validator admits [${admitted.join(", ")}]`,
        );
      }
    }

    expect(
      unmatched,
      "a rendered alternation with no validator probe is a vocabulary nothing holds to its reader — " +
        "add a probe (role, field, payload builder, validator, issue path) to VOCABULARIES, or name the " +
        "field in UNPROBED_FIELDS with the reasoning that makes it unprobeable",
    ).toEqual([]);
    expect(
      mismatched,
      "the sketch and the validator that reads its output disagree",
    ).toEqual([]);
  });

  it("EVERY membership check in the validators reads a declaration, not an inline list", () => {
    // ── Why a SOURCE read, in a file whose whole thesis is "never parse source" ─
    //
    // Everything above derives a vocabulary by FEEDING values to a validator,
    // which is what makes it immune to how the validator spells its check. That
    // method has exactly one blind spot, and this test closes it: a probe can
    // only find a value it TRIES, so a validator that stops reading the shared
    // declaration and admits something else produces an admitted set the probe
    // cannot see — the drift and the probe's own candidate list are the same
    // shape (measured 2026-09-11: appending a member to `JUDGE_VERDICTS`'s
    // inline spread left this whole suite 15-of-15 GREEN).
    //
    // So the property here is deliberately NOT "the values agree" — that is the
    // probes' job — but "the check reads the declaration at all". That IS a fact
    // about the source text, and reading it is the only way to state it. What
    // makes this safe where the file's earlier "never read source" argument
    // warned against the opposite: this test does not care WHAT the values are,
    // only that the vocabulary ARGUMENT is a bare identifier. A validator may
    // reparenthesize, reformat or rename its locals freely; the assertion moves
    // only when the check stops being declaration-backed, which is exactly the
    // event it exists to catch.
    for (const [file, validatorNames] of VALIDATOR_MODULES) {
      const source = readFileSync(resolve(REPO_ROOT, file), "utf8");
      const findings = auditMembershipChecks(source, file, validatorNames);
      expect(
        findings,
        "a validator's membership check no longer reads a declaration imported from " +
          "sketchSource.ts — an inline array, a spread or a local constant is a SECOND copy of a " +
          "vocabulary, and the copy is what drifts. Name the declaration in sketchSource.ts and " +
          "import it, or (if the vocabulary is genuinely not one) add the module to " +
          "VALIDATOR_MODULES' exempt list with the reasoning.",
      ).toEqual([]);
    }
  });

  it("the membership sweep REACHES the validators it claims to audit", () => {
    // A source sweep that matched nothing would pass vacuously — the same
    // failure the probe sentinel exists to prevent, one level up. So the sweep
    // is held to a floor: each validator module must yield at least the number
    // of declaration-backed checks it is known to carry.
    for (const [file, validatorNames] of VALIDATOR_MODULES) {
      const source = readFileSync(resolve(REPO_ROOT, file), "utf8");
      const checks = membershipCheckSites(source);
      expect(
        checks.length,
        `${file} yielded no membership check at all — the sweep is reading the wrong text, so its ` +
          "verdict is vacuous",
      ).toBeGreaterThan(0);
      const backed = checks.filter((site) => isDeclarationBacked(site.argument)).length;
      expect(
        backed,
        `${file} has ${checks.length} membership checks but only ${backed} read a declaration — ` +
          `known validators: ${validatorNames.length}`,
      ).toBeGreaterThanOrEqual(validatorNames.length);
    }
  });

  it("NO sketch source carries a hand-written value alternation", () => {
    // ── The hole this closes, measured ────────────────────────────────────────
    //
    // The alternation sweep matches a rendered `"field": "a | b"` to a probe by
    // (role, field). That catches a sketch whose OFFERED SET is wrong. It does
    // NOT catch a sketch that stops deriving and hand-writes the CORRECT values
    // — the rendered text is identical, so every probe still matches and the
    // suite stays 15-of-15 GREEN. Measured 2026-09-11: replacing
    // `sketchValues(GOAL_SOURCE_TYPES)` with the literal
    // `"conversation | document | structured_audit | mixed"` left the whole
    // file green. That is the exact drift this packet exists to close, one
    // level up: the sketch and the validator had already been reconciled, and
    // the reconciliation was reversible without a red.
    //
    // So the property is stated on the SOURCE of the sketches rather than on
    // their rendered output: a value alternation inside a schema sketch must be
    // rendered by `sketchValues(<identifier>)`, never spelled out. Matching on
    // the rendered text cannot express this — the rendered text is the same
    // either way, which is precisely why the hole existed.
    //
    // What counts is narrow, so the rule stays readable: a `"field": "..."` slot
    // whose string literal CONTAINS a `|`, inside a file that renders sketches.
    // Prose alternations in a worker-FACING sentence (`Read only the artifact
    // files…`) are not `"field": "…"` slots and are not matched; a placeholder
    // slot like `"kind": "<a | b>"` IS matched and must also be rendered.
    for (const file of SKETCH_SOURCE_MODULES) {
      const source = readFileSync(resolve(REPO_ROOT, file), "utf8");
      expect(
        literalAlternations(source, file),
        "a sketch spells out its value alternation instead of rendering it from the declaration. " +
          "The rendered prompt is identical either way — which is why no probe can catch this — so " +
          "the hand-written copy drifts from its validator in silence. Render it through " +
          "`sketchValues(<declaration>)`.",
      ).toEqual([]);
    }
  });

  it("the import reader sees ONLY the sketchSource import, not a neighbour's", () => {
    // The sweep's verdict rests on this set, so it is asserted against a
    // fixture that carries the shape that broke it: an ES import is NOT
    // brace-balanced, and a lazy `[\s\S]*?` run matches from the FIRST `{` to
    // the LAST `}`, swallowing a neighbouring module's specifiers. The first
    // draft did exactly that and reported a correctly-imported constant as
    // locally declared. Pinned as a unit here so the parser cannot regress
    // silently — the integrated sweep below would only red if the mis-parse
    // happened to change a verdict, which it does not always.
    const fixture = [
      'import { OTHER_THING } from "audit-tools/shared";',
      'import {',
      "  ALPHA_THING,",
      "  BETA_THING as RENAMED_THING,",
      '} from "../contractPipeline/sketchSource.js";',
      'import { NOT_MINE } from "./somewhere-else.js";',
    ].join("\n");
    expect([...sketchSourceIdentifiers(fixture)].sort()).toEqual([
      "ALPHA_THING",
      "RENAMED_THING",
    ]);
  });

  it("an `offeredExclusions` entry still exempts something", () => {
    // ── Why the exclusion needs a consumer of its own ─────────────────────────
    //
    // `offeredExclusions` has exactly ONE effect: it subtracts values from the
    // admitted set before the sweep compares it to the sketch. That subtraction
    // is invisible whenever the subtraction is a NO-OP — an entry naming a value
    // the validator no longer admits, or that the sketch already omits, changes
    // nothing and the sweep stays green. The exclusion then reads as a live
    // accept-legacy/emit-current decision while exempting nothing: a legacy
    // alias quietly dropped from the validator would keep its exemption on the
    // books, and the next value added to the declaration in its place would be
    // exempted by accident, in the entry's name, without anyone deciding it.
    //
    // So the property stated here is on the DECLARATION rather than on the
    // comparison: every value an entry excludes must still be one the validator
    // ADMITS, and one the sketch does NOT offer. Red-proof: add a value to
    // `CONTRACT_REPAIR_TARGETS_LEGACY` that the validator refuses — the entry
    // now exempts nothing, and the assertion below names it.
    for (const entry of VOCABULARIES) {
      const exclusions = entry.offeredExclusions ?? [];
      if (exclusions.length === 0) continue;
      const admitted = admittedValues(entry.build, entry.validate, entry.path);
      const offered = offeredValueSet(
        sketchOf(
          renderContractPipelinePrompt({
            role: entry.role,
            artifactPaths: PATHS,
          }).prompt,
        ),
        entry.field,
      );
      for (const excluded of exclusions) {
        expect(
          admitted,
          `${entry.role}.${entry.field}: \`${excluded}\` is excluded from the offered set, but the ` +
            "validator does not admit it either — the exclusion exempts nothing and should be deleted",
        ).toContain(excluded);
        expect(
          offered,
          `${entry.role}.${entry.field}: \`${excluded}\` is excluded from the offered set, but the ` +
            "sketch offers it anyway — the exclusion is not being applied where it claims to be",
        ).not.toContain(excluded);
      }
    }
  });

  it("UNPROBED_FIELDS stays empty", () => {
    // The escape hatch, asserted shut. An entry here exempts a rendered
    // vocabulary from the sweep, so it is a decision that must be argued for
    // rather than a convenient silence.
    expect(
      UNPROBED_FIELDS,
      "an unprobed sketch field is a vocabulary whose reader is not checked — argue it or probe it",
    ).toEqual([]);
  });

  // ── The measured drifts, named so a regression reads as itself ─────────────

  it("cyclic_seam_resolution renders every status the validator admits", () => {
    const admitted = admittedValues(
      cyclicSeamPayload,
      (value) => validateCyclicSeamResolution(value),
      "cyclic_seam_resolution.status",
    );
    expect(admitted.length, "the probe found no admitted status at all").toBeGreaterThan(1);

    const sketch = sketchOf(
      renderContractPipelinePrompt({
        role: "cyclic_seam_resolution",
        artifactPaths: PATHS,
      }).prompt,
    );
    expect(
      offeredValueSet(sketch, "status"),
      "the sketch must offer exactly the statuses the validator admits",
    ).toEqual([...admitted].sort());
    // The two values missing from the sketch at HEAD, named so a regression
    // reads as itself rather than as a set difference.
    expect(admitted).toContain("user_decision_required");
    expect(admitted).toContain("blocked");
  });

  it("the cyclic-seam CONTRACT validator gates break_strategy, not just the later re-check", () => {
    // Before this packet the vocabulary was enforced ONLY on the authored-
    // resolution path (`contractPipeline.ts`, two inline literals), so a cycle
    // record naming an unsanctioned strategy passed the CONTRACT validator that
    // decides whether the artifact is admissible at all. The probe caught this:
    // it reported every candidate admitted, because nothing at this path was
    // gating. Asserted directly so the gate is named rather than only implied by
    // the sketch comparison below.
    expect(
      issuesAt(
        validateCyclicSeamResolution(seamCyclePayload("not_a_strategy")),
        "cyclic_seam_resolution.cycles[0].break_strategy",
      ).length,
      "an unsanctioned break strategy must be refused by the artifact validator",
    ).toBeGreaterThan(0);
    expect(
      issuesAt(
        validateCyclicSeamResolution(seamCyclePayload("mediator")),
        "cyclic_seam_resolution.cycles[0].break_strategy",
      ).length,
    ).toBe(0);
  });

  it("cyclic_seam_resolution renders every break strategy the validator admits", () => {
    const admitted = admittedValues(
      seamCyclePayload,
      (value) => validateCyclicSeamResolution(value),
      "cyclic_seam_resolution.cycles[0].break_strategy",
    );
    expect(admitted.length).toBeGreaterThan(1);

    const sketch = sketchOf(
      renderContractPipelinePrompt({
        role: "cyclic_seam_resolution",
        artifactPaths: PATHS,
      }).prompt,
    );
    expect(offeredValueSet(sketch, "break_strategy")).toEqual([...admitted].sort());
  });

  it("judge_report OFFERS every repair target the validator admits, minus the legacy alias", () => {
    const admitted = admittedValues(
      (candidate) => judgePayload({ target: candidate }),
      (value) => validateJudgeReport(value),
      "judge_report.repair_directive.target",
    );
    const sketch = sketchOf(
      renderContractPipelinePrompt({
        role: "judge",
        artifactPaths: PATHS,
      }).prompt,
    );
    // The legacy alias(es) are the ONE deliberate exception, and they are
    // asserted rather than filtered silently: the validator keeps accepting them
    // so a judge report written by an older release still loads (named
    // back-compat test in validation.test.ts), while no NEW report should be
    // authored against a name the repair loop normalizes away.
    //
    // The expected offered set is the SUBTRACTION WRITTEN OUT, not
    // `CONTRACT_REPAIR_TARGETS_OFFERED`. That constant is what the sketch itself
    // renders, so expecting it here put the sketch and its expectation in
    // lockstep: a target quietly dropped from the offered set moved both sides
    // together and stayed green. The hidden cost of the earlier reasoning is
    // that `CONTRACT_REPAIR_TARGETS_OFFERED` is DERIVED — so it is exactly as
    // unknown to this assertion as the sketch is, which is what an expected
    // value must not be. `offeredExclusions` is the other half: an exclusion
    // that no longer exempts anything is caught below.
    for (const legacy of CONTRACT_REPAIR_TARGETS_LEGACY) {
      expect(admitted, `${legacy} must stay admissible for back-compat`).toContain(legacy);
      expect(offeredValueSet(sketch, "target")).not.toContain(legacy);
    }
    expect(admitted).toContain("counterexample");
    expect(admitted).toContain("finalized_module_contracts");
    expect(admitted).toContain("obligation_ledger");
    expect(admitted).toContain("contract_assessment_report");
    const expectedOffered = [
      "contract_assessment_report",
      "counterexample",
      "finalized_module_contracts",
      "obligation_ledger",
    ];
    expect(
      [...admitted].sort(),
      "the probe's admitted set is written out, never read off the sketch",
    ).toEqual([...expectedOffered, ...CONTRACT_REPAIR_TARGETS_LEGACY].sort());
    expect(
      offeredValueSet(sketch, "target"),
      "a repair target the validator admits but the sketch omits is a repair the judge can never order",
    ).toEqual(expectedOffered);
  });

  it("verification_report renders every trace kind, trace status and finding status the validator admits", () => {
    const traceKind = admittedValues(
      verificationPayload,
      (value) => validateVerificationReport(value),
      "verification_report.findings[0].traces[0].kind",
    );
    const traceStatus = admittedValues(
      verificationTraceStatusPayload,
      (value) => validateVerificationReport(value),
      "verification_report.findings[0].traces[0].status",
    );
    const findingStatus = admittedValues(
      verificationFindingStatusPayload,
      (value) => validateVerificationReport(value),
      "verification_report.findings[0].overall_status",
    );
    const reportStatus = admittedValues(
      verificationReportStatusPayload,
      (value) => validateVerificationReport(value),
      "verification_report.overall_status",
    );

    const sketch = sketchOf(
      renderContractPipelinePrompt({
        role: "closing",
        artifactPaths: PATHS,
      }).prompt,
    );
    expect(offeredValueSet(sketch, "kind")).toEqual([...traceKind].sort());
    // `status` appears on the TRACE only — the finding level spells its own as
    // `overall_status` — so this key is the trace vocabulary exactly.
    expect(offeredValueSet(sketch, "status")).toEqual([...traceStatus].sort());
    // `overall_status` appears twice (per finding, and report level), so the
    // sketch offers the UNION of the two — and each is asserted separately
    // below, so a member dropped from either occurrence still reds.
    expect(offeredValueSet(sketch, "overall_status")).toEqual(
      [...new Set([...findingStatus, ...reportStatus])].sort(),
    );
    // The per-finding-only value and the report-level strictness, named: the
    // report level deliberately excludes `skipped`.
    expect(traceKind).toContain("counterexample");
    expect(findingStatus).toContain("skipped");
    expect(reportStatus).not.toContain("skipped");
  });

  it("implementation_dag renders every node status and edge kind the validator admits", () => {
    const nodeStatus = admittedValues(
      (candidate) => dagPayload(candidate),
      (value) => validateImplementationDAG(value),
      "implementation_dag.nodes[0].status",
    );
    const edgeKind = admittedValues(
      (candidate) => dagPayload("pending", candidate),
      (value) => validateImplementationDAG(value),
      "implementation_dag.edges[0].kind",
    );
    expect(nodeStatus.length).toBeGreaterThan(1);

    const sketch = sketchOf(
      renderContractPipelinePrompt({
        role: "implementation_planning",
        artifactPaths: PATHS,
      }).prompt,
    );
    expect(
      offeredValueSet(sketch, "status"),
      "the sketch showed 1 of the 4 node statuses at HEAD",
    ).toEqual([...nodeStatus].sort());
    expect(offeredValueSet(sketch, "kind")).toEqual([...edgeKind].sort());
    expect(nodeStatus).toContain("in_progress");
    expect(nodeStatus).toContain("blocked");
  });
});

// ── created_at: the one asymmetry, resolved in one place ─────────────────────

describe("the created_at asymmetry is a DECISION, not a drift", () => {
  it("names the ONE owner of the field, so the decision has a home", () => {
    // The decision above is only a decision if something records WHO stamps the
    // field. `stampToolCreatedAt` is that owner, and the constant naming it is
    // asserted here rather than left as a comment — a comment cannot red.
    expect(CREATED_AT_OWNER).toBe("stampToolCreatedAt");
  });

  it("no sketch declares created_at, because the tool stamps it", () => {
    // EVERY role, not a sample: the asymmetry is a property of the whole
    // renderer, and a new sketch that asks the host for a clock reading is the
    // one regression a sampled role list would miss.
    for (const role of Object.keys(ROLES)) {
      const sketch = sketchOf(
        renderContractPipelinePrompt({
          role,
          artifactPaths: PATHS,
        }).prompt,
      );
      expect(
        sketch.includes('"created_at"'),
        `${role}'s sketch must not ask the host for a timestamp the tool owns`,
      ).toBe(false);
    }
  });

  it("every one of those validators REQUIRES created_at on the post-stamp payload", () => {
    // The other half of the decision: the validators keep requiring it, because
    // the requirement is enforced after `stampToolCreatedAt` has run, not on
    // what the worker wrote. Dropping either half makes the asymmetry a bug.
    const judge = judgePayload({}) as Record<string, unknown>;
    delete judge.created_at;
    expect(
      issuesAt(validateJudgeReport(judge), "judge_report.created_at").length,
      "the validator must still require the stamp the tool supplies",
    ).toBeGreaterThan(0);

    const dag = dagPayload("pending") as Record<string, unknown>;
    delete dag.created_at;
    expect(
      issuesAt(validateImplementationDAG(dag), "implementation_dag.created_at").length,
    ).toBeGreaterThan(0);

    // …and the same for every other validator, swept rather than sampled: the
    // requirement is what makes the decision coherent for ALL fifteen.
    for (const entry of VOCABULARIES) {
      if (entry.role === "judge" || entry.role === "implementation_planning") continue;
      const payload = entry.build(
        admittedValues(entry.build, entry.validate, entry.path)[0] ?? "pending",
      ) as Record<string, unknown>;
      const isRecord = payload !== null && typeof payload === "object";
      if (!isRecord) continue;
      delete payload.created_at;
      const stampPath = `${entry.path.split(".")[0]}.created_at`;
      expect(
        issuesAt(entry.validate(payload), stampPath).length,
        `${stampPath} must still be required on the post-stamp payload`,
      ).toBeGreaterThan(0);
    }
  });
});

// ── The declared vocabularies are the shipped ones ───────────────────────────

describe("sketchSource declares the vocabularies the validators gate on", () => {
  it("the module_decomposition version constant is not reused as an artifact name", () => {
    // Cheap canary that this file's own imports stay honest: the version
    // constants imported for payload construction belong to DIFFERENT artifacts,
    // and swapping them would make every probe above vacuously "admitted".
    expect(CP_MODULE_DECOMPOSITION_VERSION).not.toBe(CP_CYCLIC_SEAM_RESOLUTION_VERSION);
    expect(CONTRACT_PIPELINE_GOAL_SPEC_VERSION).toContain("goal-spec");
  });

  it("each declared vocabulary is exactly what its validator admits", () => {
    // The declaration is the thing the sketch renders; this asserts the
    // declaration itself matches the reader, independently of any sketch, so a
    // vocabulary edited in `sketchSource.ts` alone cannot pass by having its
    // sketch edited in the same move.
    const expected: ReadonlyArray<[string, readonly string[], Vocabulary]> = [
      ["goal source types", sketchSource.GOAL_SOURCE_TYPES, VOCABULARIES[0]!],
      ["context entry kinds", sketchSource.CONTEXT_ENTRY_KINDS, VOCABULARIES[1]!],
      ["seam resolution decisions", sketchSource.SEAM_RESOLUTION_DECISIONS, VOCABULARIES[2]!],
      ["critique item kinds", sketchSource.CRITIQUE_ITEM_KINDS, VOCABULARIES[3]!],
      ["critique item severities", sketchSource.CRITIQUE_ITEM_SEVERITIES, VOCABULARIES[4]!],
      ["critique verdicts", sketchSource.CRITIQUE_VERDICTS, VOCABULARIES[5]!],
      ["judge verdicts", sketchSource.JUDGE_VERDICTS, VOCABULARIES[13]!],
      ["counterexample classifications", sketchSource.COUNTEREXAMPLE_CLASSIFICATIONS, VOCABULARIES[15]!],
      ["assessment finding statuses", sketchSource.ASSESSMENT_FINDING_STATUSES, VOCABULARIES[11]!],
      ["assessment verdicts", sketchSource.ASSESSMENT_VERDICTS, VOCABULARIES[12]!],
    ];
    for (const [label, declared, probe] of expected) {
      const admitted = admittedValues(probe.build, probe.validate, probe.path);
      expect(
        admitted.sort(),
        `${label}: ${declared.join(", ")} is the declaration the sketch renders`,
      ).toEqual([...declared].sort());
    }
  });
});
