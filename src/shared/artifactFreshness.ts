import { contentSha256 } from "./submission/hostHandoffCore.js";

import { compareCodeUnits } from "./compareCodeUnits.js";
import { canonicalizeAffinityArtifactValue } from "./affinityArtifacts.js";
import { DESIGN_REVIEW_PROVENANCE_FIELDS } from "./types/intentCheckpoint.js";

// Non-semantic fields stripped before hashing, per artifact. A bare name is a
// TOP-LEVEL field; a dotted name (`design_review.answered_at`) is provenance
// nested inside a sub-object, where only that key is dropped. These are
// provenance (wall-clock stamps, run ids), NOT content: two rebuilds with
// identical data but different stamps must hash equal, or the artifact's
// revision churns every rebuild and perpetually re-stales its downstreams (e.g.
// audit-report.md depends on design_assessment) — a finalization-oscillation
// hazard.
//
// OBL-C006/CE-005: strip ALL non-semantic fields, not only `generated_at`. The
// set is per-artifact and extensible; add any field that is provenance rather
// than meaning. The synthesis-narrative marker carries only semantic counts, so
// it has no fields to strip — but it (and the narrative-bearing findings
// contract) get array canonicalization below so a byte-varying-but-
// semantically-stable narrative still produces a stable content hash, letting
// the synthesis<->narrative no-progress guard converge.
const NON_SEMANTIC_FIELDS_BY_ARTIFACT: Record<string, readonly string[]> = {
  "repo_manifest.json": ["generated_at"],
  "tooling_manifest.json": ["generated_at"],
  "audit_plan_metrics.json": ["generated_at"],
  // Rejection diagnostics guide submission repair; they do not change findings
  // or the structural inputs downstream artifacts consumed.
  "design_assessment.json": ["generated_at", "rejected_submissions"],
  // The narrative-bearing machine contract. `generated_at` (when present) is
  // provenance; the array canonicalization below makes theme/top-risk ordering
  // non-load-bearing for the content hash.
  "audit-findings.json": ["generated_at"],
  // The narrative marker. Carries only semantic counts today, but strip
  // `generated_at` defensively so a future provenance stamp can never churn the
  // synthesis<->narrative signature (OBL-C006).
  "synthesis-narrative.json": ["generated_at"],
  // Access-memory carries `run_id` as provenance only; it's run-constant so it
  // can't churn intra-run today, but stripping it keeps provenance out of the
  // semantic content hash defensively (mirrors the `generated_at` strips above).
  "access_memory.json": ["run_id"],
  // The charter family all stamp `generated_at = new Date()` on every run
  // (extraction, delta merge, clarification, challenge). Unstripped, every
  // semantically-identical rebuild bumped the artifact revision and re-staled
  // the DAG downstreams (charter_clarification, systemic_challenge,
  // audit-report.md) each cycle — live-observed churn, re-dogfood 2026-07-22.
  "charter_register.json": ["generated_at"],
  "charter_clarification.json": ["generated_at"],
  "systemic_challenge.json": ["generated_at"],
  // DD-9 layer 1: `confirmed_at`/`confirmed_by` are provenance — a re-confirm
  // that changes only them must not move the canonical hash (unstripped, every
  // provenance-only re-confirm re-staled the ENTIRE planning cascade purely on
  // the timestamp). The same holds for the provenance INSIDE `design_review`:
  // `answered_at` records WHICH confirmation answered the block, and a
  // re-confirm of the same depth necessarily stamps a fresh one, so leaving it
  // in the hash re-staled the cascade on that alone. `schema_version`
  // deliberately STAYS in the hash: a schema migration is a semantic
  // reinterpretation, not provenance.
  "intent_checkpoint.json": [
    "confirmed_at",
    "confirmed_by",
    ...DESIGN_REVIEW_PROVENANCE_FIELDS.map((field) => `design_review.${field}`),
  ],
};

function stripFields(
  record: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  if (fields.length === 0) return record;
  // Two shapes, one list, because the provenance this strips is not always at
  // the TOP level: a nested path (`design_review.answered_at`) names provenance
  // inside a sub-object, and the sub-object's remaining keys must survive —
  // dropping the whole `design_review` key would erase the dials themselves.
  // A bare name is a top-level strip.
  const topLevel = new Set(fields.filter((field) => !field.includes(".")));
  const nested = new Map<string, Set<string>>();
  for (const field of fields) {
    const dot = field.indexOf(".");
    if (dot < 0) continue;
    const parent = field.slice(0, dot);
    const child = field.slice(dot + 1);
    const children = nested.get(parent) ?? new Set<string>();
    children.add(child);
    nested.set(parent, children);
  }
  const stripped = Object.fromEntries(
    Object.entries(record).filter(([key]) => !topLevel.has(key)),
  );
  for (const [parent, children] of nested) {
    const value = stripped[parent];
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    stripped[parent] = Object.fromEntries(
      Object.entries(value as Record<string, unknown>).filter(
        ([key]) => !children.has(key),
      ),
    );
  }
  return stripped;
}

/**
 * Canonically order the semantically-unordered narrative arrays so that a host
 * narrative which differs ONLY in array order (or in stripped non-semantic
 * fields) hashes identically. Themes are ordered by `theme_id`, each theme's
 * `finding_ids` lexically, and `top_risks` lexically. Findings keep their
 * deterministic synthesis order (already stable). Applied to the narrative
 * fields wherever they appear (`audit-findings.json` after applyNarrative).
 */
function canonicalizeNarrativeArrays(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...record };

  if (Array.isArray(out.themes)) {
    out.themes = [...(out.themes as Array<Record<string, unknown>>)]
      .map((theme) => {
        if (theme && typeof theme === "object" && Array.isArray(theme.finding_ids)) {
          return {
            ...theme,
            finding_ids: [...(theme.finding_ids as string[])].sort(
              compareCodeUnits,
            ),
          };
        }
        return theme;
      })
      .sort((a, b) =>
        compareCodeUnits(
          String(a?.theme_id ?? ""),
          String(b?.theme_id ?? ""),
        ),
      );
  }

  if (Array.isArray(out.top_risks)) {
    out.top_risks = [...(out.top_risks as string[])].sort(compareCodeUnits);
  }

  return out;
}

export function normalizeForMetadataHash(
  artifactName: string,
  value: unknown,
): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  let record = value as Record<string, unknown>;
  const nonSemantic = NON_SEMANTIC_FIELDS_BY_ARTIFACT[artifactName];
  if (nonSemantic) {
    record = stripFields(record, nonSemantic);
  }
  if (
    artifactName === "audit-findings.json" ||
    artifactName === "synthesis-narrative.json"
  ) {
    record = canonicalizeNarrativeArrays(record);
  }
  return record;
}

export function hashArtifactValue(
  artifactName: string,
  value: unknown,
): string {
  return contentSha256(
    canonicalizeAffinityArtifactValue(
      artifactName,
      normalizeForMetadataHash(artifactName, value),
    ),
  );
}
