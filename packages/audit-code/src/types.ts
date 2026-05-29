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
  required_lenses: Lens[];
  critical_flows?: string[];
}

export interface UnitManifest {
  units: AuditUnit[];
}

export interface FileCoverageRecord {
  path: string;
  total_lines: number;
  pass_id: string;
  lens?: Lens;
  agent_role?: string;
}

export interface CoverageFileRecord {
  path: string;
  unit_ids: string[];
  classification_status: string;
  audit_status: string;
  required_lenses: Lens[];
  completed_lenses: Lens[];
}

export interface CoverageMatrix {
  files: CoverageFileRecord[];
}

export type AuditTaskStatus = "pending" | "complete";

export interface AuditTask {
  task_id: string;
  unit_id: string;
  pass_id: string;
  lens: Lens;
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
  tags?: string[];
  status?: AuditTaskStatus;
  completed_at?: string;
  completion_reason?: string;
}

// The canonical field set lives in @audit-tools/shared. The auditor narrows
// `lens` to its strongly-typed `Lens` union; everything else is inherited so
// the wire contract stays in sync (including `theme_id` added in Phase 6).
export interface Finding extends Omit<SharedFinding, "lens"> {
  lens: Lens;
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
  lens: Lens;
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
}
