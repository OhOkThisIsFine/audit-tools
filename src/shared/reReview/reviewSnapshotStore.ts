// sites-pinned: tests/shared/review-snapshot-store.test.ts
/**
 * Diff-based re-review snapshot STORE (shared, B2/B3).
 *
 * Both orchestrators keep a diff-based re-review snapshot for each verdict-bearing
 * review phase: audit-code's design-review passes (contract / conceptual) and
 * remediate-code's review artifacts (critique, assessment, counterexample, judge).
 * The store step-for-step is identical on both sides — the `schema_version` stamp,
 * the record shape, the directory/path resolution, the
 * `discardOnSchemaVersionMismatch(readOptionalJsonFile(...)) ?? null` read, and the
 * `mkdir` + `writeJsonFile` write. This module owns that generic lifecycle ONCE.
 *
 * What stays genuinely per-mode is upstream in each orchestrator, not repeated
 * here:
 *   - the *input universe* each review reads (audit's `DesignReviewBundle`,
 *     remediate's `DEPENDENCY_MAP` edges),
 *   - the *projector* that maps an input to its load-bearing structure
 *     (`designReviewProjection.ts` / `semanticProjection.ts`),
 *   - the per-side *retention policy* — WHEN a snapshot is dropped (remediate's
 *     archive boundary `dropReviewSnapshot`; audit's promotion rollback), never an
 *     unconditional deletion,
 *   - the in-memory staleness/delta computation over an already-loaded snapshot
 *     (audit's `isDesignReviewStale` stays synchronous over the pre-loaded bundle),
 *   - the path OPINION (which directory a snapshot lives in), injected here as a
 *     resolver so a side that single-sources its paths elsewhere (remediate's
 *     `artifactStore`) keeps that single source.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { discardOnSchemaVersionMismatch } from "../io/schemaVersion.js";
import { readOptionalJsonFile, writeJsonFile } from "../io/json.js";

/**
 * A snapshot record's identity key: the field whose value is the snapshot's
 * filename (audit's `pass`, remediate's `artifact_name`). Kept as a generic string
 * key plus a `keyOf` extractor so the store never hardcodes a field name.
 */
export interface ReviewSnapshotStoreConfig<T extends { schema_version: string }> {
  /**
   * Resolve the snapshot DIRECTORY from the artifacts directory. The caller owns
   * this so a side whose paths are single-sourced elsewhere can route it there
   * (remediate delegates to `artifactStore.reviewSnapshotDirPath`); the store holds
   * no directory opinion of its own.
   */
  dirPath: (artifactsDir: string) => string;
  /**
   * Filename for a key. Defaults to `${key}.json`; both orchestrators use that shape.
   */
  fileFor?: (key: string) => string;
  /** The accepted `schema_version`; a mismatch reads as ABSENT (regenerable state). */
  schemaVersion: string;
  /** Extract the snapshot's identity key from its record (its filename). */
  keyOf: (snapshot: T) => string;
}

export interface ReviewSnapshotStore<T extends { schema_version: string }> {
  /** Path of the snapshot directory for `artifactsDir`. */
  dir(artifactsDir: string): string;
  /** On-disk path of the keyed snapshot. */
  path(artifactsDir: string, key: string): string;
  /**
   * Read a keyed snapshot, or `null` when none is usable: absent on disk, or
   * written under a different `schema_version` (regenerable state — treat as
   * absent so the pass re-reviews rather than being read under semantics it was
   * not written for).
   */
  read(artifactsDir: string, key: string): Promise<T | null>;
  /** Write a snapshot to its on-disk home (mkdir -p + atomic JSON write). */
  write(artifactsDir: string, snapshot: T): Promise<void>;
}

export function createReviewSnapshotStore<T extends { schema_version: string }>(
  config: ReviewSnapshotStoreConfig<T>,
): ReviewSnapshotStore<T> {
  const fileFor = config.fileFor ?? ((key: string) => `${key}.json`);

  return {
    dir(artifactsDir: string): string {
      return config.dirPath(artifactsDir);
    },
    path(artifactsDir: string, key: string): string {
      return join(config.dirPath(artifactsDir), fileFor(key));
    },
    async read(artifactsDir: string, key: string): Promise<T | null> {
      return (
        discardOnSchemaVersionMismatch(
          await readOptionalJsonFile<T>(this.path(artifactsDir, key)),
          config.schemaVersion,
        ) ?? null
      );
    },
    async write(artifactsDir: string, snapshot: T): Promise<void> {
      await mkdir(config.dirPath(artifactsDir), { recursive: true });
      await writeJsonFile(this.path(artifactsDir, config.keyOf(snapshot)), snapshot);
    },
  };
}
