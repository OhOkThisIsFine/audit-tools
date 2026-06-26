import { z } from "zod";
import type { Finding as SharedFinding } from "audit-tools/shared";
import { FindingSchema } from "audit-tools/shared";

export type Lens =
  | "correctness"
  | "architecture"
  | "maintainability"
  | "security"
  | "reliability"
  | "performance"
  | "data_integrity"
  | "tests"
  | "operability"
  | "config_deployment"
  | "observability";

/** Single authoritative record for one audit lens. `order_weight` governs task
 * priority ordering — lower values sort earlier (higher urgency). */
export interface LensDefinition {
  id: Lens;
  display_name: string;
  /** Lower = higher priority in task ordering. */
  order_weight: number;
  default_enabled: boolean;
}

/** Single source of truth for all lens metadata. Adding or renaming a lens
 * requires a single edit here; `ALL_LENSES`, `ENABLED_LENSES`, and
 * `LENS_ORDER` (in auditTaskUtils) are all derived from this registry. */
export const LENS_REGISTRY: readonly LensDefinition[] = [
  { id: "security",           display_name: "Security",           order_weight: 10, default_enabled: true },
  { id: "correctness",        display_name: "Correctness",        order_weight: 20, default_enabled: true },
  { id: "reliability",        display_name: "Reliability",        order_weight: 30, default_enabled: true },
  { id: "data_integrity",     display_name: "Data Integrity",     order_weight: 40, default_enabled: true },
  { id: "performance",        display_name: "Performance",        order_weight: 50, default_enabled: true },
  { id: "architecture",       display_name: "Architecture",       order_weight: 60, default_enabled: true },
  { id: "operability",        display_name: "Operability",        order_weight: 70, default_enabled: true },
  { id: "config_deployment",  display_name: "Config & Deployment",order_weight: 80, default_enabled: true },
  { id: "observability",      display_name: "Observability",      order_weight: 90, default_enabled: true },
  { id: "maintainability",    display_name: "Maintainability",    order_weight: 100, default_enabled: true },
  { id: "tests",              display_name: "Tests",              order_weight: 110, default_enabled: true },
];

/** Canonical list of every valid {@link Lens}. Derived from {@link LENS_REGISTRY}
 * — import {@link isLens} / `ALL_LENSES` instead of hand-copying lens lists into
 * local guards, which drift (a copy omitting "observability" caused it to be
 * wrongly rejected in flow requeue). */
export const ALL_LENSES: readonly Lens[] = LENS_REGISTRY.map((d) => d.id);

/** Lenses enabled by default (all entries in the registry with default_enabled true). */
export const ENABLED_LENSES: readonly Lens[] = LENS_REGISTRY
  .filter((d) => d.default_enabled)
  .map((d) => d.id);

export function isLens(value: unknown): value is Lens {
  return (
    typeof value === "string" && (ALL_LENSES as readonly string[]).includes(value)
  );
}

export const FileRecordSchema = z.object({
  path: z.string(),
  language: z.string(),
  size_bytes: z.number(),
  hash: z.string().optional(),
  excluded: z.boolean().optional(),
  exclusion_reason: z.string().optional(),
});
export type FileRecord = z.infer<typeof FileRecordSchema>;

export const RepoManifestSchema = z.object({
  repository: z.object({
    name: z.string(),
    root: z.string().optional(),
    default_branch: z.string().optional(),
  }),
  generated_at: z.string(),
  files: z.array(FileRecordSchema),
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

export const CLASSIFICATION_STATUSES = ClassificationStatusSchema.options;

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

export type AuditTaskStatus = "pending" | "complete";

export const AuditTaskSchema = z.object({
  task_id: z.string(),
  unit_id: z.string(),
  pass_id: z.string(),
  lens: z.string(),
  file_paths: z.array(z.string()),
  file_line_counts: z.record(z.string(), z.number()).optional(),
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
   * refined/frozen by the estimate-review step. Drives just-in-time risk-mass
   * packetization and model-tier routing; never a model/provider decision.
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

export const AuditVerificationSchema = z.object({
  verified: z.boolean(),
  needs_followup: z.boolean(),
  concerns: z.array(z.string()).optional(),
  coverage_concerns: z.array(z.string()).optional(),
  confidence_concerns: z.array(z.string()).optional(),
  followup_tasks: z.array(AuditTaskSchema).optional(),
});
export type AuditVerification = z.infer<typeof AuditVerificationSchema>;

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
