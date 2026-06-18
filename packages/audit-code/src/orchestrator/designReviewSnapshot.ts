/**
 * Diff-based re-review for audit-code's design-review passes (B2 parity port).
 *
 * Friction (the audit-code half of remediate-code's B2): when the structural
 * inputs to a design-review pass genuinely change, the verdict-bearing pass
 * (contract-assessment / conceptual-design-critique) re-runs as a FULL pass — an
 * expensive LLM review (or a multi-perspective fan-out + judge) burned from
 * scratch even when the change touches only a small part of what the review
 * reasoned about. Before this port the opposite failure also lurked: the
 * `*_reviewed` flags were carried forward unconditionally, so a real structural
 * change never re-triggered the review at all.
 *
 * Fix (mirrors `contractPipeline/reviewSnapshot.ts`): when a design-review pass
 * completes, snapshot the SEMANTIC PROJECTIONS of the exact structural inputs it
 * reviewed plus its own verdict (the findings it produced). The pass's staleness
 * is then keyed on those projections — a cosmetic upstream edit projects
 * identically and keeps the review fresh; a real structural change re-stales it.
 * When it does re-stale, the re-emit prompt carries the prior verdict + the
 * precise changed-since-last-review delta and instructs re-affirm-or-revise-only-
 * affected — never a blind full re-run. Enforced by the tool, not host memory.
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  diffProjections,
  readOptionalJsonFile,
  renderDiffReReviewSection,
  stableStringifyProjection,
  writeJsonFile,
  type ProjectionDiffEntry,
} from "@audit-tools/shared";
import type { Finding } from "../types.js";
import {
  DESIGN_REVIEW_INPUTS,
  projectDesignReviewInput,
  type DesignReviewBundle,
  type DesignReviewInput,
} from "./designReviewProjection.js";

/** The two verdict-bearing design-review passes (each snapshots independently). */
export const DESIGN_REVIEW_PASSES = ["contract", "conceptual"] as const;
export type DesignReviewPass = (typeof DESIGN_REVIEW_PASSES)[number];

const SNAPSHOT_SCHEMA_VERSION = "audit-code/design-review-snapshot/v1alpha1" as const;

export interface DesignReviewSnapshot {
  schema_version: typeof SNAPSHOT_SCHEMA_VERSION;
  pass: DesignReviewPass;
  /** ISO-8601 capture time (caller-supplied for deterministic tests). */
  reviewed_at: string;
  /** The findings this pass emitted — what a re-review re-affirms. */
  prior_findings: Finding[];
  /** Semantic projection of each structural input at review time. */
  reviewed_inputs: Record<DesignReviewInput, unknown>;
}

/** Bundle-side view: the loaded snapshots, keyed by pass (absent until captured). */
export type DesignReviewSnapshotBundle = Partial<
  Record<DesignReviewPass, DesignReviewSnapshot>
>;

const SNAPSHOT_DIRNAME = "design-review-snapshots";

function snapshotDir(artifactsDir: string): string {
  return join(artifactsDir, SNAPSHOT_DIRNAME);
}

export function designReviewSnapshotPath(
  artifactsDir: string,
  pass: DesignReviewPass,
): string {
  return join(snapshotDir(artifactsDir), `${pass}.json`);
}

export function designReviewSnapshotExists(
  artifactsDir: string,
  pass: DesignReviewPass,
): boolean {
  return existsSync(designReviewSnapshotPath(artifactsDir, pass));
}

export async function readDesignReviewSnapshot(
  artifactsDir: string,
  pass: DesignReviewPass,
): Promise<DesignReviewSnapshot | null> {
  return (
    (await readOptionalJsonFile<DesignReviewSnapshot>(
      designReviewSnapshotPath(artifactsDir, pass),
    )) ?? null
  );
}

/**
 * Load both design-review snapshots from disk into the bundle-side view, so the
 * synchronous `deriveAuditState` can compute pass staleness in-memory. Absent
 * snapshots are simply omitted.
 */
export async function loadDesignReviewSnapshots(
  artifactsDir: string,
): Promise<DesignReviewSnapshotBundle> {
  const out: DesignReviewSnapshotBundle = {};
  for (const pass of DESIGN_REVIEW_PASSES) {
    const snapshot = await readDesignReviewSnapshot(artifactsDir, pass);
    if (snapshot) out[pass] = snapshot;
  }
  return out;
}

/**
 * Capture a design-review snapshot for a freshly-completed pass: the semantic
 * projection of every structural input plus the pass's own findings (verdict).
 */
export async function captureDesignReviewSnapshot(
  artifactsDir: string,
  pass: DesignReviewPass,
  priorFindings: Finding[],
  bundle: DesignReviewBundle,
  reviewedAt: string,
): Promise<void> {
  const reviewed_inputs = {} as Record<DesignReviewInput, unknown>;
  for (const input of DESIGN_REVIEW_INPUTS) {
    reviewed_inputs[input] = projectDesignReviewInput(input, bundle);
  }
  const snapshot: DesignReviewSnapshot = {
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    pass,
    reviewed_at: reviewedAt,
    prior_findings: priorFindings,
    reviewed_inputs,
  };
  await mkdir(snapshotDir(artifactsDir), { recursive: true });
  await writeJsonFile(designReviewSnapshotPath(artifactsDir, pass), snapshot);
}

export interface DesignReReviewDelta {
  /** Per-input diff lines, keyed by input name; empty for unchanged. */
  changedInputs: ProjectionDiffEntry[];
  /** True when no structural input projection actually changed. */
  allUnchanged: boolean;
}

/**
 * Compute the re-review delta for a design-review pass against its snapshot:
 * which structural inputs changed (by semantic projection) since the prior
 * verdict, and the field-level diff for each.
 */
export function computeDesignReReviewDelta(
  snapshot: DesignReviewSnapshot,
  bundle: DesignReviewBundle,
): DesignReReviewDelta {
  const changedInputs: ProjectionDiffEntry[] = [];
  for (const input of DESIGN_REVIEW_INPUTS) {
    const current = projectDesignReviewInput(input, bundle);
    const prior = snapshot.reviewed_inputs[input];
    const lines = diffProjections(prior, current);
    if (lines.length > 0) changedInputs.push({ label: input, lines });
  }
  return { changedInputs, allUnchanged: changedInputs.length === 0 };
}

/**
 * Whether a design-review pass is stale relative to its snapshot — i.e. the
 * semantic projection of any structural input has changed since the verdict was
 * recorded. The synchronous staleness signal `deriveAuditState` consumes.
 */
export function isDesignReviewStale(
  snapshot: DesignReviewSnapshot,
  bundle: DesignReviewBundle,
): boolean {
  for (const input of DESIGN_REVIEW_INPUTS) {
    const prior = stableStringifyProjection(snapshot.reviewed_inputs[input]);
    const current = stableStringifyProjection(
      projectDesignReviewInput(input, bundle),
    );
    if (prior !== current) return true;
  }
  return false;
}

/**
 * Render the diff-based re-review section appended to a design-review pass's
 * re-emit prompt. Delegates the prompt body to the shared
 * `renderDiffReReviewSection` so the shape matches remediate-code's contract
 * pipeline exactly.
 */
export function renderDesignReReviewSection(
  snapshot: DesignReviewSnapshot,
  delta: DesignReReviewDelta,
): string {
  return renderDiffReReviewSection({
    priorPayload: snapshot.prior_findings,
    changedInputs: delta.changedInputs,
    allUnchanged: delta.allUnchanged,
    subjectNoun: "design-review pass",
  });
}

/**
 * Build the diff-based re-review section for a design-review pass being re-emitted
 * after staleness, or `undefined` when this is not a re-review (no prior
 * snapshot — i.e. first authoring). Mirrors remediate-code's
 * `buildReReviewSection`. The pass-level step is only emitted when the pass is
 * `missing` (no snapshot → `undefined`) or `stale` (snapshot present → section),
 * so the section appears exactly on a genuine re-review.
 */
export async function buildDesignReReviewSection(
  artifactsDir: string,
  bundle: DesignReviewBundle,
  pass: DesignReviewPass,
): Promise<string | undefined> {
  const snapshot = await readDesignReviewSnapshot(artifactsDir, pass);
  if (!snapshot) return undefined;
  const delta = computeDesignReReviewDelta(snapshot, bundle);
  return renderDesignReReviewSection(snapshot, delta);
}
