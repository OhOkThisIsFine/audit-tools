/**
 * Content-addressed, GRANULAR staleness for the coverage matrix (T5 #12 — the
 * general DAG-model extension that pairs with the per-result baseline store in
 * `resultBaseline.ts`).
 *
 * Today `runPlanningExecutor` rebuilds the whole coverage matrix on every re-plan
 * and resets every in-scope file to `pending`, so a re-plan triggered by an
 * upstream change unrelated to a given file (e.g. an intent-checkpoint edit, a
 * unit reassignment elsewhere, a new external-analyzer result) re-audits files
 * whose own audit inputs never changed. This module keys staleness at the
 * granularity of the actual unit of work — ONE coverage file — so only files
 * whose audit inputs genuinely moved re-derive; the rest keep their prior
 * completion by construction.
 *
 * Mirrors the result-baseline design exactly:
 *  - the per-element baseline (a content key per file path) lives OUTSIDE the
 *    coverage artifact, in `artifact_metadata.coverage_element_baselines`, so
 *    recording a baseline never mutates the coverage matrix;
 *  - the comparison driver is a signature-SENSITIVE content key derived from the
 *    file's audit inputs (its content signal + required lenses + unit membership);
 *  - a file with no recorded baseline is never preserved (first plan establishes
 *    the baseline; the run after a ship behaves exactly as before).
 *
 * Content-precision note: the per-file content signal is the repo-manifest
 * `hash` when file hashing is enabled, else `size_bytes`. This is exactly the
 * precision the rest of the staleness DAG already runs at — a same-size file edit
 * with hashing off does not change the repo manifest either, so it does not
 * re-stale coverage today and is not falsely preserved here relative to current
 * behavior. Enabling manifest hashing tightens both at once.
 */
import { hashContent, stableStringify } from "audit-tools/shared";
import type { ArtifactMetadataManifest } from "../types/artifactMetadata.js";
import { METADATA_SCHEMA_VERSION } from "../types/artifactMetadata.js";
import type { CoverageMatrix, CoverageFileRecord, RepoManifest } from "../types.js";

/** Per-coverage-file baseline: file path → signature-sensitive content key. */
export type CoverageElementBaselineStore = Record<string, string>;

/**
 * The per-file content signal that determines whether a file's audit must be
 * redone: the repo-manifest content `hash` when present, else its `size_bytes`.
 * Returns a map keyed by repo-manifest path. Files absent from the manifest (no
 * signal) are simply omitted — a file with no signal gets no baseline and is
 * never preserved (fail-safe to re-audit).
 */
export function coverageContentSignature(
  repoManifest: RepoManifest,
): Record<string, string> {
  const sig: Record<string, string> = {};
  for (const file of repoManifest.files) {
    sig[file.path] = file.hash ?? `size:${file.size_bytes}`;
  }
  return sig;
}

/**
 * Derive the signature-SENSITIVE content key for one coverage file from its audit
 * inputs: the file's content signal, its required lenses, and its unit
 * membership. Any change to any input moves the key, forcing a re-audit; an
 * identical set of inputs reproduces the same key, enabling preservation. Lenses
 * and unit ids are sorted so ordering noise never moves the key.
 */
export function deriveCoverageElementKey(
  file: CoverageFileRecord,
  contentSig: string | undefined,
): string {
  return hashContent(
    stableStringify({
      path: file.path,
      content_sig: contentSig ?? null,
      required_lenses: [...file.required_lenses].sort(),
      unit_ids: [...file.unit_ids].sort(),
    }),
  );
}

/**
 * Build the fresh per-element baseline store for a coverage matrix: a content key
 * for every file that carries audit work (not excluded). Excluded files are
 * omitted — they have no work to preserve. Pure.
 */
export function recordCoverageElementBaselines(
  coverage: CoverageMatrix,
  contentSigByPath: Record<string, string>,
): CoverageElementBaselineStore {
  const store: CoverageElementBaselineStore = {};
  for (const file of coverage.files) {
    if (file.audit_status === "excluded") continue;
    store[file.path] = deriveCoverageElementKey(file, contentSigByPath[file.path]);
  }
  return store;
}

/** Read the carried-forward coverage-element baselines off the artifact metadata. */
export function readCoverageElementBaselines(
  metadata: ArtifactMetadataManifest | undefined,
): CoverageElementBaselineStore | undefined {
  return metadata?.coverage_element_baselines;
}

/**
 * Carry the executor's freshly-recorded coverage-element baselines onto the
 * bundle's artifact metadata so `computeArtifactMetadata` persists them (the same
 * carry-forward path `result_baselines` uses). Returns a new manifest; never
 * mutates the input. Stamps the F1 schema version when seeding a fresh manifest
 * so the CE-007 freshness gate recognizes the store on the next run.
 */
export function withCoverageElementBaselines(
  metadata: ArtifactMetadataManifest | undefined,
  baselines: CoverageElementBaselineStore,
): ArtifactMetadataManifest {
  return {
    metadata_schema_version: METADATA_SCHEMA_VERSION,
    artifacts: {},
    ...(metadata ?? {}),
    coverage_element_baselines: baselines,
  };
}

/**
 * Preserve prior completion for coverage files whose audit inputs are UNCHANGED
 * from the recorded baseline — content-addressed granular staleness. Mutates
 * `coverage` in place and returns the number of files preserved.
 *
 * A file is preserved iff: it still carries pending work (not excluded), a prior
 * baseline exists for its path, the freshly-computed live key EQUALS that
 * baseline, AND a prior coverage record exists for the path. The prior record's
 * `completed_lenses` / `audit_status` are carried verbatim — valid because the
 * content key includes `required_lenses`, so an unchanged key guarantees an
 * unchanged required-lens set (partial completion is preserved too, not only
 * fully-complete files).
 *
 * No baseline, a moved key, or a missing prior record all leave the file at its
 * freshly-built (pending) state — fail-safe to re-audit.
 */
export function applyContentAddressedPreservation(
  coverage: CoverageMatrix,
  priorCoverage: CoverageMatrix | undefined,
  priorBaselines: CoverageElementBaselineStore | undefined,
  contentSigByPath: Record<string, string>,
): number {
  if (!priorBaselines || !priorCoverage) return 0;
  const priorByPath = new Map(priorCoverage.files.map((f) => [f.path, f]));
  let preserved = 0;
  for (const file of coverage.files) {
    if (file.audit_status === "excluded") continue;
    // Already complete (e.g. trivial-auto-complete or delta out-of-scope carry):
    // nothing to preserve.
    if (file.audit_status === "complete") continue;
    const baseline = priorBaselines[file.path];
    if (baseline === undefined) continue;
    const liveKey = deriveCoverageElementKey(file, contentSigByPath[file.path]);
    if (liveKey !== baseline) continue;
    const prior = priorByPath.get(file.path);
    if (!prior) continue;
    file.completed_lenses = [...prior.completed_lenses];
    file.audit_status = prior.audit_status;
    preserved += 1;
  }
  return preserved;
}
