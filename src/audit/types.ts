// sites-pinned: tests/audit/lens-steward-surface.test.ts, tests/audit/host-handoff.test.ts, tests/audit/orchestrator-remediation.test.ts, tests/audit/schema-contracts.test.ts, tests/audit/review-packet-sizing.test.ts
import { z } from "zod";
import type { Finding as SharedFinding } from "audit-tools/shared";
import { FindingSchema } from "audit-tools/shared";

import type { Lens } from "audit-tools/shared";
export type { Lens } from "audit-tools/shared";
export { isLens } from "audit-tools/shared";

/** Single authoritative record for one audit lens, and the ONE home for lens
 * prose: the operator's catalog gloss and the worker's review guidance are both
 * read from here (a third copy, a JSON asset under `dispatch/`, lost its only
 * reader and silently stopped reaching workers). `order_weight` governs task
 * priority ordering — lower values sort earlier (higher urgency). */
export interface LensDefinition {
  id: Lens;
  display_name: string;
  /** Lower = higher priority in task ordering. */
  order_weight: number;
  default_enabled: boolean;
  /** One-line meaning, shown in the confirm-intent lens catalog. */
  summary: string;
  /** What a reviewer under this lens looks for; rendered into every work-item prompt. */
  focus: string;
  /** What belongs to other lenses; rendered beside `focus`. */
  do_not_report: string;
}

/** Audit-specific metadata is exhaustive over the shared lens vocabulary. */
const LENS_METADATA = {
  security: {
    display_name: "Security",
    order_weight: 10,
    default_enabled: true,
    summary: "Injection, authn/authz, secret handling, unsafe input, privilege boundaries.",
    focus: "Injection vulnerabilities (SQL, shell, path traversal), authentication/authorization flaws, secret exposure, insecure deserialization, privilege escalation, unsafe use of eval or child processes with user input.",
    do_not_report: "Performance or correctness issues that are not security-relevant.",
  },
  correctness: {
    display_name: "Correctness",
    order_weight: 20,
    default_enabled: true,
    summary: "Logic errors, wrong results, broken invariants, mishandled edge cases.",
    focus: "Logic errors, incorrect algorithm implementations, off-by-one bugs, type mismatches, wrong return values, incorrect state transitions, missing null/undefined guards, misuse of APIs. Focus on code that does the wrong thing.",
    do_not_report: "Style issues, naming problems, missing tests, or findings that belong to other lenses.",
  },
  reliability: {
    display_name: "Reliability",
    order_weight: 30,
    default_enabled: true,
    summary: "Failure modes, error handling, retries, resource leaks, recovery.",
    focus: "Failure modes without recovery, missing timeouts, unhandled promise rejections, race conditions, resource leaks (file handles, sockets, timers), incorrect retry logic, cascading failure risks.",
    do_not_report: "Correctness bugs that do not affect reliability under failure conditions.",
  },
  data_integrity: {
    display_name: "Data Integrity",
    order_weight: 40,
    default_enabled: true,
    summary: "Persistence correctness, schema/serialization drift, races, lost or duplicated state.",
    focus: "Missing input validation at trust boundaries, schema violations, inconsistent field naming across related schemas, data loss scenarios, missing required fields, enum values that are present in some schemas but not others.",
    do_not_report: "UI or presentation issues; operational or deployment concerns.",
  },
  performance: {
    display_name: "Performance",
    order_weight: 50,
    default_enabled: true,
    summary: "Hot paths, algorithmic complexity, allocation, avoidable I/O and work.",
    focus: "Algorithmic inefficiencies (O(n²) where O(n) is possible), unnecessary re-computation, missing caching, synchronous blocking in hot paths, excessive memory allocation.",
    do_not_report: "Correctness bugs unrelated to performance.",
  },
  architecture: {
    display_name: "Architecture",
    order_weight: 60,
    default_enabled: true,
    summary: "Structure, boundaries, coupling, dependency direction, layering.",
    focus: "Big-picture design, conceptual elegance, over-engineering, under-engineering, appropriate use of abstractions, and identifying opportunities where custom code should be replaced by third-party tools or standard libraries. Flag a missing single source of truth: the same logic, format, or contract realized in multiple components where it should live in one shared module — the durable fix is extraction to that shared source, not a test or convention that keeps the copies in sync. Flag structural findings that span multiple components as 'systemic: true'.",
    do_not_report: "Minor style issues, localized logic bugs, or formatting.",
  },
  operability: {
    display_name: "Operability",
    order_weight: 70,
    default_enabled: true,
    summary: "Deploy / runbooks, health, config surface, diagnosability in production.",
    focus: "Missing or low-quality log output, error messages that don't help operators diagnose problems, missing progress indicators for long operations, no elapsed-time reporting, lack of dry-run or preview modes for destructive operations.",
    do_not_report: "Correctness bugs or deployment configuration.",
  },
  config_deployment: {
    display_name: "Config & Deployment",
    order_weight: 80,
    default_enabled: true,
    summary: "Build, packaging, CI/CD, release, environment and config wiring.",
    focus: "CI/CD pipeline correctness (wrong triggers, missing branch filters, floating version pins), deployment safety (no gate before publish, missing rollback), insecure secret handling in configs, mutable action tags that should be pinned to commit SHAs.",
    do_not_report: "Runtime code issues; findings that belong to other lenses.",
  },
  observability: {
    display_name: "Observability",
    order_weight: 90,
    default_enabled: true,
    summary: "Logging, metrics, tracing, and signal quality for debugging incidents.",
    focus: "Logging quality, telemetry, distributed tracing context, meaningful metrics, and error reporting context.",
    do_not_report: "Correctness bugs or deployment configuration.",
  },
  maintainability: {
    display_name: "Maintainability",
    order_weight: 100,
    default_enabled: true,
    summary: "Readability, duplication, complexity, naming, dead code, change cost.",
    focus: "Code that is hard to change safely: excessive function length, deep nesting, tight coupling between unrelated modules, poor naming, magic constants, duplicated logic, inconsistent abstractions, unclear public APIs. A specific high-value smell: the same logic, format, or contract implemented in two or more places and kept consistent by a test or by convention instead of extracted to one shared source — flag the duplication and recommend single-sourcing it (the sync test is a workaround for the missing abstraction, not the fix). The change-cost tell is 'every edit must be made in N places to stay correct.'",
    do_not_report: "Correctness bugs, test gaps, or operational concerns.",
  },
  tests: {
    display_name: "Tests",
    order_weight: 110,
    default_enabled: true,
    summary: "Coverage gaps, brittle or flaky tests, missing negative cases, weak assertions.",
    focus: "Test coverage gaps for important paths, tests that assert incorrect behavior (pinning bugs as expected), fragile or non-deterministic tests, missing negative/edge-case tests, tests that silently pass on stale builds (e.g. importing compiled dist/ rather than source). Also flag a test whose purpose is to keep two copies of logic/format/output in sync (a drift guard): the real defect is the duplication it polices, which should be extracted to one shared source so the guard is unnecessary — report the test as the symptom and call out the duplication to single-source.",
    do_not_report: "Source code bugs — report only issues with the tests themselves.",
  },
} satisfies Record<Lens, Omit<LensDefinition, "id">>;

export const LENS_REGISTRY: readonly LensDefinition[] = Object.entries(LENS_METADATA)
  .map(([id, metadata]) => ({ id: id as Lens, ...metadata }))
  .sort((left, right) => left.order_weight - right.order_weight);

/** Canonical list of every valid {@link Lens}. Derived from {@link LENS_REGISTRY}
 * — import {@link isLens} / `ALL_LENSES` instead of hand-copying lens lists into
 * local guards, which drift (a copy omitting "observability" caused it to be
 * wrongly rejected in flow requeue). */
export const ALL_LENSES: readonly Lens[] = LENS_REGISTRY.map((d) => d.id);

/** The registry record for `lens`, or undefined for an operator-added custom lens. */
export function lensDefinition(lens: string): LensDefinition | undefined {
  return LENS_REGISTRY.find((definition) => definition.id === lens);
}

export const FileRecordSchema = z.object({
  path: z.string(),
  language: z.string(),
  size_bytes: z.number(),
  hash: z.string().optional(),
  excluded: z.boolean().optional(),
  exclusion_reason: z.string().optional(),
});

export const RepoManifestSchema = z.object({
  repository: z.object({
    name: z.string(),
    root: z.string().optional(),
    default_branch: z.string().optional(),
  }),
  generated_at: z.string(),
  files: z.array(FileRecordSchema),
  /**
   * Content key of the git INDEX state for this manifest's candidate paths —
   * the tracked intersection, sorted and hashed. Set by the live probe
   * (`scopeIndexBaseline.ts`) on every advance, like `tooling_manifest.json`'s
   * environment probe, so an index-only move (a file staged or unstaged with no
   * content edit) moves the manifest's content hash and re-stales
   * `file_disposition.json` through the EXISTING declared edge.
   *
   * It lives on the manifest rather than as its own artifact deliberately: the
   * index is an input the manifest's own reader (`buildFileDisposition`) is
   * already downstream of, so the edge needs no addition to the staleness DAG —
   * `spec/audit/dependency-map.md` is untouched. Absent when git could not be
   * read (no root / no work tree / git absent): absence is "no index claim",
   * never a claim that the index is empty.
   */
  scope_index_key: z.string().optional(),
});
export type RepoManifest = z.infer<typeof RepoManifestSchema>;

export const AuditUnitSchema = z
  .object({
    unit_id: z.string(),
    name: z.string(),
    kind: z.string().optional(),
    files: z.array(z.string()),
    risk_score: z.number().min(0).max(10).optional(),
    required_lenses: z.array(z.string()),
    critical_flows: z.array(z.string()).optional(),
  })
  .strict();
export type AuditUnit = z.infer<typeof AuditUnitSchema>;

export const UnitManifestSchema = z.object({
  units: z.array(AuditUnitSchema),
});
export type UnitManifest = z.infer<typeof UnitManifestSchema>;

export interface FileCoverageRecord {
  path: string;
  total_lines: number;
  pass_id: string;
  lens?: string;
  agent_role?: string;
}

/** Single source of truth for coverage-matrix classification statuses (mirrors
 * the LENS_REGISTRY-derives-Lens pattern above). The value set is
 * {unclassified, classified} plus the audit-excluded subset of
 * FileDispositionStatus (excluded | generated | vendor | binary | doc_only)
 * plus the scope/trivial-audit statuses written by scope.ts
 * (out_of_scope_delta, out_of_scope_intent) and trivialAudit.ts
 * (excluded_trivial). The coverage_matrix JSON schema is GENERATED from
 * {@link CoverageMatrixSchema}, so it can never drift from this enum. */
export const ClassificationStatusSchema = z.enum([
  "unclassified",
  "classified",
  "excluded",
  "generated",
  "vendor",
  "binary",
  "doc_only",
  "out_of_scope_delta",
  "excluded_trivial",
  "out_of_scope_intent",
]);

export type ClassificationStatus = z.infer<typeof ClassificationStatusSchema>;

export const CoverageFileRecordSchema = z.object({
  path: z.string(),
  unit_ids: z.array(z.string()),
  classification_status: ClassificationStatusSchema,
  audit_status: z.string(),
  required_lenses: z.array(z.string()),
  completed_lenses: z.array(z.string()),
});
export type CoverageFileRecord = z.infer<typeof CoverageFileRecordSchema>;

export const CoverageMatrixSchema = z.object({
  files: z.array(CoverageFileRecordSchema),
});
export type CoverageMatrix = z.infer<typeof CoverageMatrixSchema>;

export const AuditTaskSchema = z.object({
  task_id: z.string(),
  unit_id: z.string(),
  pass_id: z.string(),
  lens: z.string(),
  file_paths: z.array(z.string()),
  file_line_counts: z.record(z.string(), z.number()).optional(),
  /**
   * How much of `file_paths` the reviewer must cover.
   *
   * `"complete"` (the default when absent) is the per-file lane: every assigned
   * file is reviewed, and a result that omits one is refused. `"selective"` is
   * the lens steward: the assignment is the whole SURFACE its lens was applied
   * to, and the steward chooses which of those files to open, so a coverage set
   * smaller than the assignment is the contract rather than a violation.
   *
   * The axis exists because the old steward assignment was a score-ranked
   * sample of twelve files. A file COUNT measures no cost — twelve files of ten
   * lines is not a bounded review, and twelve files of a hundred thousand lines
   * is not one either — and the sample also capped what a steward could NAME in
   * a follow-up, which costs only a path. Widening the assignment to the whole
   * surface is only safe once the completeness gates know the two lanes apart.
   */
  coverage_policy: z.enum(["complete", "selective"]).optional(),
  /**
   * Per-file metrics for a `"selective"` assignment: what the tool already
   * knows about each file on the surface, so the reviewer can choose what to
   * open from evidence rather than from a name.
   *
   * `score` ranks prior signal (priority, critical-flow and large-file tags, an
   * external-analyzer path match, a suspiciously clean high-risk result, and the
   * severity of findings already recorded against the path). It is a HINT, never
   * a cap: the reviewer may open any file on the surface, in any order.
   */
  file_metrics: z
    .array(
      z.object({
        path: z.string(),
        total_lines: z.number(),
        score: z.number(),
        /** One token per contributing signal, path-stable and sorted. */
        signals: z.array(z.string()),
        /** Findings the base pass already recorded for this path, by severity. */
        prior_findings: z.record(z.string(), z.number()),
      }),
    )
    .optional(),
  line_ranges: z
    .array(
      z.object({
        path: z.string(),
        start: z.number(),
        end: z.number(),
      }),
    )
    .optional(),
  inputs: z.record(z.string(), z.string()).optional(),
  rationale: z.string(),
  priority: z.enum(["high", "medium", "low"]).optional(),
  /**
   * Frozen, provider-neutral estimate of the content tokens this task's files
   * contribute to a review prompt. Seeded deterministically at planning
   * (byte-based) and refined/frozen by the estimate-review step. Authoritative
   * input to just-in-time dispatch packetization — see
   * spec/audit-workflow-design.md.
   */
  token_estimate: z.number().optional(),
  /**
   * Frozen, provider-neutral audit-risk score in [0,1] (likelihood × stakes of
   * latent defects). Seeded deterministically from priority/lens/tags and
   * refined/frozen by the estimate-review step. Drives task prioritization and
   * coherent review grouping; never an execution-selection decision.
   */
  risk_estimate: z.number().optional(),
  tags: z.array(z.string()).optional(),
  status: z.enum(["pending", "complete"]).optional(),
  completed_at: z.string().optional(),
  completion_reason: z.string().optional(),
});
export type AuditTask = z.infer<typeof AuditTaskSchema>;

// The canonical field set lives in audit-tools/shared. The auditor accepts
// any string as lens (canonical + custom); SharedFinding already types `lens`
// as a string, so the former Omit<…,"lens"> re-narrowing was a no-op — this is
// now a direct alias so the wire contract can never drift from shared.
export type Finding = SharedFinding;

// contract-construction-sites: exempt — AuditVerification is authored by the HOST:
// it answers the verification work item, and the tool only VALIDATES what arrives
// (`validateOneAuditResult`). No producer in this repo constructs one, so there is
// no site to mark — the absence is the design, not an oversight. The schema's own
// required fields are still reconciled against the rendered worker schema.
export const AuditVerificationSchema = z.object({
  verified: z.boolean(),
  needs_followup: z.boolean(),
  concerns: z.array(z.string()).optional(),
  coverage_concerns: z.array(z.string()).optional(),
  confidence_concerns: z.array(z.string()).optional(),
  /**
   * How the steward chose which of its surface files to open, and which it left.
   *
   * A steward under `coverage_policy: "selective"` is granted the whole surface
   * its lens was applied to and picks what to review, so the CHOICE is half of
   * its answer: without it, a one-file coverage over a 300-file surface arrives
   * with nothing to judge it by. The host door enforces it as REQUIRED and
   * non-empty (`verificationContractFailure`); it is optional here for the same
   * reason every other field of this schema is — the follow-up builder reads a
   * partial object, and this schema is the tolerant reader, not the gate.
   */
  // sites-pinned: tests/audit/host-handoff.test.ts, tests/audit/validation-remediation.test.ts
  selection_rationale: z.string().optional(),
  followup_tasks: z.array(AuditTaskSchema).optional(),
});

export const AuditResultSchema = z.object({
  task_id: z.string(),
  unit_id: z.string(),
  pass_id: z.string(),
  lens: z.string(),
  agent_role: z.string().optional(),
  file_coverage: z.array(
    z.object({
      path: z.string(),
      total_lines: z.number(),
    }),
  ),
  // The auditor accepts any string as lens (canonical + custom); the shared
  // FindingSchema already types lens as string, so a Finding here IS a
  // SharedFinding (the former Omit<…,"lens"> narrowing was a no-op).
  findings: z.array(FindingSchema),
  /**
   * Worker-authored affirmation that an EMPTY `findings` array is a reviewed
   * result, not a silent failure. REQUIRED when `findings` is empty and refused
   * otherwise (enforced at ingest by `validateResultFindings`, which is the gate
   * workers actually hit — the zod contract only advertises the field).
   *
   * Exists because a lane that errors, truncates, or returns an empty completion
   * produces output shaped exactly like a genuine clean review, and nothing
   * downstream could tell the two apart: a broken lane read as a weak one. An
   * affirmation cannot be produced by accident, so a zero-finding result now
   * carries positive evidence that a review happened.
   */
  reviewed_clean: z.boolean().optional(),
  notes: z.array(z.string()).optional(),
  requires_followup: z.boolean().optional(),
  followup_tasks: z.array(z.string()).optional(),
  verification: AuditVerificationSchema.optional(),
  run_id: z.string().optional(),
  submitted_at: z.string().optional(),
  // Ledger keys (O2). Stamped by the tool at ingest from the shared content-key
  // seam (src/shared/contentKey.ts) — never authored by a worker. `instance_id`
  // is the per-record primary key (the append-only ledger keys on this);
  // `identity_key` is the one-to-many grouping key for re-association;
  // `idempotency_key` is the logical-identity anchor a replay is a no-op on.
  instance_id: z.string().optional(),
  identity_key: z.string().optional(),
  idempotency_key: z.string().optional(),
  // Tool-owned emit lineage (O3). Stamped by the ingestion path, never authored
  // by a worker: a base result whose owning task's content has DRIFTED from its
  // recorded baseline is re-keyed `emit_source: 'redispatch'` with a 1-based
  // `attempt`, giving it a DISTINCT idempotency_key so the append-only ledger
  // accepts the fresh findings (a same-coordinate replay would otherwise no-op
  // on the signature-stable base key). `emitSourceFor` reads `emit_source` first;
  // supersession (`selectCurrentResults`) keeps only the highest attempt per
  // base lineage so a superseded result's stale findings never reach synthesis.
  emit_source: z.enum(["base", "deepening", "steward", "redispatch"]).optional(),
  attempt: z.number().int().min(1).optional(),
});
export type AuditResult = z.infer<typeof AuditResultSchema>;
