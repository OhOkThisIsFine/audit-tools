import type { Finding as SharedFinding } from "@audit-tools/shared";

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

export interface FileRecord {
  path: string;
  language: string;
  size_bytes: number;
  hash?: string;
  excluded?: boolean;
  exclusion_reason?: string;
}

export interface RepoManifest {
  repository: {
    name: string;
    root?: string;
    default_branch?: string;
  };
  generated_at: string;
  files: FileRecord[];
}

export interface AuditUnit {
  unit_id: string;
  name: string;
  kind?: string;
  files: string[];
  risk_score?: number;
  required_lenses: string[];
  critical_flows?: string[];
}

export interface UnitManifest {
  units: AuditUnit[];
}

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
 * (excluded_trivial). schemas/coverage_matrix.schema.json must list the same
 * enum — tests/classification-status-drift.test.mjs enforces set equality. */
export const CLASSIFICATION_STATUSES = [
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
] as const;

export type ClassificationStatus = (typeof CLASSIFICATION_STATUSES)[number];

export interface CoverageFileRecord {
  path: string;
  unit_ids: string[];
  classification_status: ClassificationStatus;
  audit_status: string;
  required_lenses: string[];
  completed_lenses: string[];
}

export interface CoverageMatrix {
  files: CoverageFileRecord[];
}

export type AuditTaskStatus = "pending" | "complete";

export interface AuditTask {
  task_id: string;
  unit_id: string;
  pass_id: string;
  lens: string;
  file_paths: string[];
  file_line_counts?: Record<string, number>;
  line_ranges?: Array<{
    path: string;
    start: number;
    end: number;
  }>;
  inputs?: Record<string, string>;
  rationale: string;
  priority?: "high" | "medium" | "low";
  /**
   * Frozen, provider-neutral estimate of the content tokens this task's files
   * contribute to a review prompt. Seeded deterministically at planning
   * (byte-based) and refined/frozen by the estimate-review step. Authoritative
   * input to just-in-time dispatch packetization — see
   * docs/audit-workflow-design.md.
   */
  token_estimate?: number;
  /**
   * Frozen, provider-neutral audit-risk score in [0,1] (likelihood × stakes of
   * latent defects). Seeded deterministically from priority/lens/tags and
   * refined/frozen by the estimate-review step. Drives just-in-time risk-mass
   * packetization and model-tier routing; never a model/provider decision.
   */
  risk_estimate?: number;
  tags?: string[];
  status?: AuditTaskStatus;
  completed_at?: string;
  completion_reason?: string;
}

// The canonical field set lives in @audit-tools/shared. The auditor accepts
// any string as lens (canonical + custom); everything else is inherited so
// the wire contract stays in sync (including `theme_id` added in Phase 6).
export interface Finding extends Omit<SharedFinding, "lens"> {
  lens: string;
}

export interface AuditVerification {
  verified: boolean;
  needs_followup: boolean;
  concerns?: string[];
  coverage_concerns?: string[];
  confidence_concerns?: string[];
  followup_tasks?: AuditTask[];
}

export interface AuditResult {
  task_id: string;
  unit_id: string;
  pass_id: string;
  lens: string;
  agent_role?: string;
  file_coverage: Array<{
    path: string;
    total_lines: number;
  }>;
  findings: Finding[];
  notes?: string[];
  requires_followup?: boolean;
  followup_tasks?: string[];
  verification?: AuditVerification;
  run_id?: string;
  submitted_at?: string;
}
