// Marker artifact recording whether the optional Phase 6 synthesis-narrative
// pass was applied or deliberately omitted. Its presence (and freshness against
// `audit-findings.json`) satisfies the `synthesis_narrative_current` obligation;
// the narrative content itself lives in `audit-findings.json`.

export type SynthesisNarrativeStatus = "applied" | "omitted";

export interface SynthesisNarrativeRecord {
  status: SynthesisNarrativeStatus;
  theme_count: number;
  executive_summary_present: boolean;
  top_risk_count: number;
}
