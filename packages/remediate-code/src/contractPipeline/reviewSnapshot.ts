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
import { readOptionalJsonFile, writeJsonFile } from "@audit-tools/shared";
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

/** Flatten a projection to leaf path → stable string value. */
function flatten(value: unknown, prefix: string, out: Map<string, string>): void {
  if (value === null || value === undefined) {
    out.set(prefix || "(root)", "null");
    return;
  }
  if (typeof value !== "object") {
    out.set(prefix || "(root)", JSON.stringify(value));
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.set(prefix || "(root)", "[]");
      return;
    }
    value.forEach((item, i) => flatten(item, `${prefix}[${i}]`, out));
    return;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  if (keys.length === 0) {
    out.set(prefix || "(root)", "{}");
    return;
  }
  for (const key of keys) {
    flatten(
      (value as Record<string, unknown>)[key],
      prefix ? `${prefix}.${key}` : key,
      out,
    );
  }
}

const MAX_DIFF_LINES = 40;

/** A truncated value for display (long strings get an ellipsis). */
function short(value: string): string {
  return value.length > 120 ? `${value.slice(0, 117)}...` : value;
}

/**
 * Render a leaf-level diff between two projections as `+`/`-`/`~` lines. Returns
 * an empty array when the projections are identical. Bounded to MAX_DIFF_LINES
 * with an explicit overflow note (never silently truncated).
 */
export function diffProjections(prior: unknown, current: unknown): string[] {
  const a = new Map<string, string>();
  const b = new Map<string, string>();
  flatten(prior, "", a);
  flatten(current, "", b);

  const allKeys = [...new Set([...a.keys(), ...b.keys()])].sort();
  const lines: string[] = [];
  for (const key of allKeys) {
    const before = a.get(key);
    const after = b.get(key);
    if (before === after) continue;
    if (before === undefined) lines.push(`+ ${key}: ${short(after!)}`);
    else if (after === undefined) lines.push(`- ${key}: ${short(before)}`);
    else lines.push(`~ ${key}: ${short(before)} → ${short(after)}`);
  }
  if (lines.length > MAX_DIFF_LINES) {
    const shown = lines.slice(0, MAX_DIFF_LINES);
    shown.push(`… and ${lines.length - MAX_DIFF_LINES} more changed field(s).`);
    return shown;
  }
  return lines;
}

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
 * does not affect it, or revise only the affected items otherwise.
 */
export function renderReReviewSection(
  name: ContractPipelineArtifactName,
  snapshot: ReviewSnapshot,
  delta: ReReviewDelta,
): string {
  const priorJson = JSON.stringify(snapshot.prior_payload, null, 2);
  const deltaBlock = delta.allUnchanged
    ? "_No upstream semantic change was detected._ The inputs you reviewed are unchanged in substance; re-emit your prior verdict verbatim (only the provenance/timestamp differs)."
    : delta.changedInputs
        .map(
          (entry) =>
            `### Changed: \`${entry.dep}\`\n\n\`\`\`diff\n${entry.lines.join("\n")}\n\`\`\``,
        )
        .join("\n\n");

  return `## Diff-Based Re-Review — only re-examine what changed

This artifact was already reviewed; its upstreams then changed, so it must be
re-emitted. **Do NOT re-run the full review.** Diff against your prior verdict
and re-examine ONLY the changes below.

### Your prior verdict (re-affirm it verbatim if the changes below do not affect it)

\`\`\`json
${priorJson}
\`\`\`

### Changed since your prior verdict

${deltaBlock}

### How to respond

- If the changes above do **not** affect any item in your prior verdict, re-emit
  the prior verdict unchanged (you may freshen ids/timestamps the schema requires).
- If they **do**, revise ONLY the affected items and leave the rest as they were.
- Do not invent new findings unrelated to the changes above.
`;
}
