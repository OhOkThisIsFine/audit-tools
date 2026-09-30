import type { ArtifactBundle } from "../../../src/audit/io/artifacts.js";
import {
  buildDesignReviewSnapshot,
  DESIGN_REVIEW_PASSES,
  writeDesignReviewSnapshot,
} from "../../../src/audit/orchestrator/designReviewSnapshot.js";

/** Establish completed-review evidence at setup, before any intentional context mutation. */
export function captureCompletedDesignReviews<T extends ArtifactBundle>(bundle: T): T {
  const snapshots = { ...bundle.design_review_snapshots };
  for (const pass of DESIGN_REVIEW_PASSES) {
    if (bundle.design_assessment?.[`${pass}_reviewed`] === true) {
      snapshots[pass] = buildDesignReviewSnapshot(
        pass, bundle.design_assessment[`${pass}_findings`] ?? [], bundle,
        "2026-01-01T00:00:00Z",
      );
    }
  }
  return { ...bundle, design_review_snapshots: snapshots };
}

/** Core artifact IO deliberately excludes snapshots; CLI fixtures persist their captured evidence explicitly. */
export async function persistDesignReviewSnapshots(artifactsDir: string, bundle: ArtifactBundle): Promise<void> {
  for (const snapshot of Object.values(bundle.design_review_snapshots ?? {})) {
    if (snapshot) await writeDesignReviewSnapshot(artifactsDir, snapshot);
  }
}
