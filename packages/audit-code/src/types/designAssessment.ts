import type { Finding } from "../types.js";

export interface DesignAssessment {
  generated_at: string;
  findings: Finding[];
  review_findings?: Finding[];
  reviewed?: boolean;
}
