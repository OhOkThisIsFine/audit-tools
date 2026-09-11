// The CONTRACT-TYPE registry — every validated contract type, paired with the
// zod schema whose field set IS the contract.
//
// WHY THIS EXISTS. "Which files construct `AuditResult`?" was answerable only by
// reading the tests, so the answer tracked where TESTS live rather than where the
// contract is consumed: adding a field to a type swept `tests/**`, missed the
// producers under `scripts/`, and failed release CI ([[lap-green-must-match-ci-evidence]]).
// A per-type gate written by hand for `AuditResult` closed that one instance and
// left the class open — the next contract type had the same hole, and nothing
// said so.
//
// WHAT IT HOLDS. One row per validated contract type: the schema a producer must
// go through to CONSTRUCT one, and the property shapes the gate compares that
// schema's rendered JSON Schema against. Rows are CONTRACT-TYPED, never
// author-supplied — a new contract lands here, and the reconciliation the gate
// performs follows from the row rather than from anyone remembering to add a
// check.
//
// WHY THE SHAPES ARE HERE AND NOT `z.infer`red. This module is imported through
// the package subpath (`audit-tools/shared`), which resolves through `dist/`, and
// the gate that reads it runs from `verify:checks` and from the pre-commit
// skeleton in a tree that may have no `dist/` at all. `zod` is a runtime
// dependency of the package, so importing zod here would put the gate behind a
// build — exactly the dependency the pre-commit legs are built to avoid. Zod's
// own type vocabulary is mirrored below as plain data instead, and
// `tests/shared/contract-construction-sites.test.ts` drives the real `ZodObject`
// values through the same walker, so the shapes cannot drift from the schemas
// they describe without a test going red.
//
// ADDING A CONTRACT TYPE: add the row, name the producer in that type's module
// (see `CONTRACT_SCHEMA_PRODUCERS` in `src/audit/contracts/workerSchemas.ts` for
// the shape), and mark each construction site in the source with the marker the
// gate derives from — `// construction-site: <type>` for a site inside a
// producer, and `// contract-construction-sites: exempt — <why>` for a site that
// deliberately has none. The gate reads `git grep` over the tracked tree, never a
// list in this file.

//
// sites-pinned: tests/shared/contract-construction-sites.test.ts
//   Each site of this file is pinned by the named tests; `npm run check:sites-pinned`
//   derives the sites from the staged diff and refuses an unbound one.

/**
 * The property shapes a construction-site walker must decide. Zod's own
 * vocabulary, mirrored as data — the `inner`/`key`/`value`/`shape` members carry
 * a nested shape, and `allowsUndefined` is `ZodType.isOptional()`.
 */
export interface ContractPropertyShape {
  /** `ZodObject` */
  readonly kind: "object" | "array" | "record" | "other";
  /** The declared target, e.g. `"FindingSchema"`. */
  readonly typeName?: string;
  /** `true` when the schema accepts `undefined` (`isOptional()`). */
  readonly allowsUndefined?: boolean;
  readonly inner?: ContractPropertyShape;
  readonly key?: ContractPropertyShape;
  readonly value?: ContractPropertyShape;
  readonly shape?: Readonly<Record<string, ContractPropertyShape>>;
}

/** One validated contract type: its canonical schema, and what that schema's fields are. */
export interface ContractTypeShape {
  /** The type this contract declares, as it appears in a construction-site marker. */
  readonly type: string;
  /**
   * The canonical schema a construction site must go through. This is the
   * CONSTRUCTION SITE the derivation starts from — not a typecheck assertion: a
   * cast silences a typecheck, and a cast is exactly how a producer would keep
   * missing a field the contract added.
   */
  readonly schema: string;
  /** The schema's own `shape`, for the comparison below. */
  readonly properties: Readonly<Record<string, ContractPropertyShape>>;
}

/** Shorthand: a property that is an object with its own shape, optionally itself optional. */
const object = (
  shape: Record<string, ContractPropertyShape>,
  allowsUndefined = false,
): ContractPropertyShape => ({ kind: "object", shape, allowsUndefined });

/** Shorthand: a property that is an object shared by several properties. */
const shaped = (typeName: string, shape: Record<string, ContractPropertyShape>): ContractPropertyShape => ({
  kind: "object",
  typeName,
  shape,
});

/** Shorthand: an array whose items carry a shape, optionally itself optional. */
const arrayOf = (inner: ContractPropertyShape, allowsUndefined = false): ContractPropertyShape => ({
  kind: "array",
  inner,
  allowsUndefined,
});

/** Shorthand: a string, or a string the contract also allows to be absent. */
const str = (allowsUndefined = false): ContractPropertyShape => ({ kind: "other", allowsUndefined });

// The shared contracts a finding carries, walked as their own types as well.
// Each shape mirrors its zod declaration exactly — a `true` here means the zod
// field carries `.optional()`, nothing else.
const FINDING_LOCATION_SHAPE = {
  path: str(),
  line_start: str(true),
  line_end: str(true),
  symbol: str(true),
  quoted_text: str(true),
  hash_at_plan_time: str(true),
};
/**
 * `AnchorExpectationSchema` is a discriminated union on `kind`, not an object —
 * its variants are `{kind:"exit_zero"}`, `{kind:"exit_nonzero"}`,
 * `{kind:"output_includes", text}` and `{kind:"output_excludes", text}`. It is
 * walked as its own type with the fields all four variants share; `text` is
 * present only on two of them, so it is optional here.
 */
const ANCHOR_EXPECTATION_SHAPE = { kind: str(), text: str(true) };
const EXECUTABLE_ANCHOR_SHAPE = {
  command: arrayOf(str()),
  confirm_if: object(ANCHOR_EXPECTATION_SHAPE),
  claim: str(true),
};
const ANALYZER_LEAD_PROVENANCE_SHAPE = {
  analyzer_id: str(),
  rule: str(true),
  path: str(),
  snippet_hash: str(),
};
const FINDING_GROUNDING_SHAPE = { status: str(), reason: str(true) };
const CONTENT_COHERENCE_TRACE_SHAPE = {
  normalized_items: arrayOf(object({})),
  components: arrayOf(arrayOf(str())),
};
const COVERAGE_FILE_RECORD_SHAPE = { path: str(), total_lines: str(), reviewed_lines: str(true) };
const AUDIT_VERIFICATION_SHAPE = {
  verified: str(),
  needs_followup: str(),
  concerns: arrayOf(str()),
  coverage_concerns: arrayOf(str()),
  confidence_concerns: arrayOf(str()),
  followup_tasks: arrayOf(object({})),
};

/**
 * The canonical Finding contract (`FindingSchema`, src/shared/types/finding.ts).
 * The auditor narrows `lens` to its `Lens` union; the remediator consumes the
 * field as a plain string — both go through this one shape.
 */
const FINDING_SHAPE: Record<string, ContractPropertyShape> = {
  id: str(),
  title: str(),
  category: str(),
  severity: str(),
  severity_downgraded_from: str(true),
  confidence: str(),
  lens: str(),
  summary: str(),
  affected_files: arrayOf(shaped("FindingLocationSchema", FINDING_LOCATION_SHAPE)),
  impact: str(true),
  likelihood: str(true),
  // Optional on the base contract; the per-file WORKER contract requires it
  // (`.min(1)`). That asymmetry is the one `FindingEvidenceLaneSchema` documents
  // — a consumer that tests `evidence` tests a field half its inputs were never
  // asked for — and it is a declared `requiredOverride` on the schema pairing.
  evidence: arrayOf(str(), true),
  reproduction: arrayOf(str(), true),
  systemic: str(true),
  related_findings: arrayOf(str(), true),
  theme_id: str(true),
  blast_radius: str(true),
  evidence_grounded: str(true),
  grounding: object(FINDING_GROUNDING_SHAPE, true),
  evidence_lane: str(true),
  verification_status: str(true),
  executable_anchor: object(EXECUTABLE_ANCHOR_SHAPE, true),
  contract_goal_id: str(true),
  contract_obligation_ids: arrayOf(str(), true),
  verification_obligation_ids: arrayOf(str(), true),
  targeted_commands: arrayOf(str(), true),
  analyzer_provenance: object(ANALYZER_LEAD_PROVENANCE_SHAPE, true),
  lead_lineage: object({ producer: str(), source_hash: str() }, true),
};

// Each nested contract a finding carries, walked as its own type as well. Each
// shape mirrors its zod declaration exactly: a `true` argument means the zod
// field carries `.optional()`, and nothing else does.
const FINDING_LOCATION_TYPE: ContractTypeShape = {
  type: "FindingLocation",
  schema: "FindingLocationObjectSchema",
  properties: FINDING_LOCATION_SHAPE,
};
const EXECUTABLE_ANCHOR_TYPE: ContractTypeShape = {
  type: "ExecutableAnchor",
  schema: "ExecutableAnchorSchema",
  properties: EXECUTABLE_ANCHOR_SHAPE,
};
const ANALYZER_LEAD_PROVENANCE_TYPE: ContractTypeShape = {
  type: "AnalyzerLeadProvenance",
  schema: "AnalyzerLeadProvenanceSchema",
  properties: ANALYZER_LEAD_PROVENANCE_SHAPE,
};
const FINDING_GROUNDING_TYPE: ContractTypeShape = {
  type: "FindingGrounding",
  schema: "FindingGroundingSchema",
  properties: FINDING_GROUNDING_SHAPE,
};
const CONTENT_COHERENCE_TRACE_TYPE: ContractTypeShape = {
  type: "ContentCoherenceTrace",
  schema: "ContentCoherenceTraceSchema",
  properties: CONTENT_COHERENCE_TRACE_SHAPE,
};

// The worker contract's own nested types (src/audit/types.ts).
const AUDIT_VERIFICATION_TYPE: ContractTypeShape = {
  type: "AuditVerification",
  schema: "AuditVerificationSchema",
  properties: AUDIT_VERIFICATION_SHAPE,
};
const COVERAGE_FILE_RECORD_TYPE: ContractTypeShape = {
  type: "CoverageFileRecord",
  schema: "CoverageFileRecordSchema",
  properties: COVERAGE_FILE_RECORD_SHAPE,
};
const AUDIT_TASK_TYPE: ContractTypeShape = {
  type: "AuditTask",
  schema: "AuditTaskSchema",
  properties: {
    task_id: str(),
    unit_id: str(),
    pass_id: str(),
    lens: str(),
    file_paths: arrayOf(str()),
    // All four are `.optional()` in `AuditTaskSchema`; the row said required.
    // Found by the widened optionality half (D5) — the row was never checked
    // against its own schema before, because the test skipped `AuditTask`.
    file_line_counts: { kind: "record", value: str(), allowsUndefined: true },
    line_ranges: arrayOf(object({ path: str(), start: str(), end: str() }), true),
    inputs: { kind: "record", value: str(), allowsUndefined: true },
    rationale: str(),
    priority: str(true),
    token_estimate: str(true),
    risk_estimate: str(true),
    tags: arrayOf(str(), true),
    status: str(true),
    completed_at: str(true),
    completion_reason: str(true),
  },
};

const AUDIT_RESULT_TYPE: ContractTypeShape = {
  type: "AuditResult",
  schema: "AuditResultSchema",
  properties: {
    task_id: str(),
    unit_id: str(),
    pass_id: str(),
    lens: str(),
    agent_role: str(true),
    // `WorkerAuditResultSchema` strengthens this to a non-empty array.
    file_coverage: arrayOf(source("CoverageFileRecordSchema")),
    findings: arrayOf(source("FindingSchema")),
    reviewed_clean: str(true),
    // `notes` and `followup_tasks` are optional in the contract, and the row said
    // required — exactly the drift the optionality half of the registry suite
    // exists to catch, found the moment that half stopped checking `Finding`
    // alone (D5).
    notes: arrayOf(str(), true),
    requires_followup: str(true),
    followup_tasks: arrayOf(str(), true),
    verification: { ...source("AuditVerificationSchema"), allowsUndefined: true },
    run_id: str(true),
    submitted_at: str(true),
    instance_id: str(true),
    identity_key: str(true),
    idempotency_key: str(true),
    emit_source: str(true),
    attempt: str(true),
  },
};

/**
 * A property whose shape is another ROW of this registry — resolved by the
 * walker, so the contract graph is followed rather than restated. `typeName` is
 * the schema name; the walker looks it up below.
 */
function source(schemaName: string): ContractPropertyShape {
  return { kind: "object", typeName: schemaName };
}

/** The registry. One row per validated contract type; nothing else is derived by hand. */
export const CONTRACT_PROPERTY_SHAPES: readonly ContractTypeShape[] = [
  {
    type: "Finding",
    schema: "FindingSchema",
    properties: FINDING_SHAPE,
  },
  FINDING_LOCATION_TYPE,
  EXECUTABLE_ANCHOR_TYPE,
  ANALYZER_LEAD_PROVENANCE_TYPE,
  FINDING_GROUNDING_TYPE,
  CONTENT_COHERENCE_TRACE_TYPE,
  AUDIT_RESULT_TYPE,
  AUDIT_TASK_TYPE,
  AUDIT_VERIFICATION_TYPE,
  COVERAGE_FILE_RECORD_TYPE,
];
