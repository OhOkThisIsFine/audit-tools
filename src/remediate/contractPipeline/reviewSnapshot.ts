/**
 * Diff-based re-review for the contract pipeline (B2).
 *
 * Friction: when an upstream artifact genuinely changes, the verdict-bearing
 * review phases (conceptual critique, contract assessment, adversarial critic,
 * adversarial judge) re-run as FULL passes — the host must burn another ~100-190k
 * token critic/judge subagent (or hand-re-emit the prior verdict) even when the
 * change touches only a small part of what the review reasoned about.
 *
 * Fix: when a review artifact is produced, snapshot the SEMANTIC PROJECTIONS of
 * the exact upstreams it reviewed plus its own verdict. On a later staleness
 * re-emit of that phase, diff the snapshot's inputs against the current upstream
 * projections and hand the worker (a) its prior verdict and (b) the precise
 * changed-since-last-review delta — so it confirms "prior verdict still holds"
 * cheaply when the delta does not affect it, and revises only the affected items
 * otherwise. This is enforced by the tool (the re-emit prompt carries the delta),
 * never left to the host to remember.
 *
 * Snapshots are bounded to the review phases — the only ones whose re-run is an
 * expensive verdict, not a deterministic/scaffolded restructuring.
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  diffProjections,
  readOptionalJsonFile,
  renderDiffReReviewSection,
  writeJsonFile,
} from "audit-tools/shared";

export { diffProjections };
import {
  contractPipelineDir,
  DEPENDENCY_MAP,
  readContractArtifact,
  type ContractPipelineArtifactEnvelope,
  type ContractPipelineArtifactName,
} from "./artifactStore.js";
import { semanticProjection } from "./semanticProjection.js";

/** The verdict-bearing review artifacts whose re-run is expensive (diff-eligible). */
export const REVIEW_ARTIFACTS: ReadonlySet<ContractPipelineArtifactName> = new Set([
  "conceptual_design_critique",
  "contract_assessment_report",
  "counterexample",
  "judge_report",
]);

export function isReviewArtifact(name: ContractPipelineArtifactName): boolean {
  return REVIEW_ARTIFACTS.has(name);
}

const SNAPSHOT_SCHEMA_VERSION =
  "remediate-code-contract-pipeline/review-snapshot/v1alpha1" as const;

export interface ReviewSnapshot {
  schema_version: typeof SNAPSHOT_SCHEMA_VERSION;
  artifact_name: ContractPipelineArtifactName;
  /** ISO-8601 capture time (caller-supplied for deterministic tests). */
  reviewed_at: string;
  /** The verdict payload this review emitted — what a re-review re-affirms. */
  prior_payload: unknown;
  /** Semantic projection of each upstream dependency at review time. */
  reviewed_inputs: Partial<Record<ContractPipelineArtifactName, unknown>>;
}

function reviewSnapshotDir(artifactsDir: string): string {
  return join(contractPipelineDir(artifactsDir), "review-snapshots");
}

export function reviewSnapshotPath(
  artifactsDir: string,
  name: ContractPipelineArtifactName,
): string {
  return join(reviewSnapshotDir(artifactsDir), `${name}.json`);
}

export function reviewSnapshotExists(
  artifactsDir: string,
  name: ContractPipelineArtifactName,
): boolean {
  return existsSync(reviewSnapshotPath(artifactsDir, name));
}

export async function readReviewSnapshot(
  artifactsDir: string,
  name: ContractPipelineArtifactName,
): Promise<ReviewSnapshot | null> {
  return (
    (await readOptionalJsonFile<ReviewSnapshot>(
      reviewSnapshotPath(artifactsDir, name),
    )) ?? null
  );
}

/**
 * Capture a review snapshot for a freshly-produced review artifact: the semantic
 * projection of each current upstream dependency plus the review's own payload.
 * No-op for non-review artifacts. The dependency envelopes are read from disk, so
 * this must run after the upstreams are enveloped (always true post-ingest).
 */
export async function captureReviewSnapshot(
  artifactsDir: string,
  name: ContractPipelineArtifactName,
  payload: unknown,
  reviewedAt: string,
): Promise<void> {
  if (!isReviewArtifact(name)) return;
  const reviewed_inputs: Partial<Record<ContractPipelineArtifactName, unknown>> = {};
  for (const dep of DEPENDENCY_MAP[name]) {
    const depEnvelope = await readContractArtifact(artifactsDir, dep);
    if (depEnvelope) {
      reviewed_inputs[dep] = semanticProjection(dep, depEnvelope.payload);
    }
  }
  const snapshot: ReviewSnapshot = {
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    artifact_name: name,
    reviewed_at: reviewedAt,
    prior_payload: payload,
    reviewed_inputs,
  };
  await mkdir(reviewSnapshotDir(artifactsDir), { recursive: true });
  await writeJsonFile(reviewSnapshotPath(artifactsDir, name), snapshot);
}

// ── Projection diffing ─────────────────────────────────────────────────────────
// The leaf-level diff algorithm is the shared `diffProjections`
// (`audit-tools/shared`) — single-sourced so audit-code and remediate-code
// produce identical re-review deltas.

export interface ReReviewDelta {
  /** Per-dependency diff lines, keyed by dependency name; empty for unchanged. */
  changedInputs: { dep: ContractPipelineArtifactName; lines: string[] }[];
  /** True when no upstream projection actually changed (re-affirm verbatim). */
  allUnchanged: boolean;
}

/**
 * Compute the re-review delta for a review phase against its snapshot: which
 * upstream dependencies changed (by semantic projection) since the prior verdict,
 * and the field-level diff for each. Dependencies present now but absent in the
 * snapshot (or vice-versa) are reported as wholesale add/remove diffs.
 */
export async function computeReReviewDelta(
  artifactsDir: string,
  name: ContractPipelineArtifactName,
  snapshot: ReviewSnapshot,
): Promise<ReReviewDelta> {
  const changedInputs: ReReviewDelta["changedInputs"] = [];
  for (const dep of DEPENDENCY_MAP[name]) {
    const depEnvelope = await readContractArtifact(artifactsDir, dep);
    const current = depEnvelope
      ? semanticProjection(dep, depEnvelope.payload)
      : undefined;
    const prior = snapshot.reviewed_inputs[dep];
    const lines = diffProjections(prior, current);
    if (lines.length > 0) changedInputs.push({ dep, lines });
  }
  return { changedInputs, allUnchanged: changedInputs.length === 0 };
}

/**
 * Render the diff-based re-review section appended to a review phase's re-emit
 * prompt. Carries the prior verdict and the precise changed-since-last-review
 * delta, and instructs the worker to re-affirm the prior verdict when the delta
 * does not affect it, or revise only the affected items otherwise. Delegates the
 * prompt body to the shared `renderDiffReReviewSection` (single-sourced shape).
 */
export function renderReReviewSection(
  _name: ContractPipelineArtifactName,
  snapshot: ReviewSnapshot,
  delta: ReReviewDelta,
): string {
  return renderDiffReReviewSection({
    priorPayload: snapshot.prior_payload,
    changedInputs: delta.changedInputs.map((entry) => ({
      label: entry.dep,
      lines: entry.lines,
    })),
    allUnchanged: delta.allUnchanged,
    subjectNoun: "artifact",
  });
}
