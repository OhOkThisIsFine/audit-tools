/**
 * Fixture hermeticity for the ACQUIRED analyzer set.
 *
 * The heavy CLI tests drive the real `next-step` fold against a temp fixture
 * repository, and the real fold enables external-analyzer acquisition
 * (`buildExternalAcquisitionOptions` sets `enabled: true`). `admitSpawn` lets a
 * DEFAULT-set candidate run with no consent token at all, so every such fixture
 * reached the network: `type-coverage` through
 * `npx -y -p typescript@5.9.3 -p type-coverage@2.29.7`, and `gitleaks` — whose
 * `detect` is `() => true`, so it is applicable to EVERY fixture — through the
 * checksum-verified GitHub release download. On a cold npx cache the first test
 * to spawn it pays the whole typescript install while every parallel worker
 * serializes behind npx's per-package lock; CI run 33830307675 (Linux, shard
 * 3/4) timed `audit-code-completion-present.test.ts` out at 300 s that way. A
 * suite must not depend on the network or on npx cache state.
 *
 * The fix uses the seam the product already owns rather than a test-only escape
 * hatch: a recorded operator `declined` is consulted FIRST in `admitSpawn`,
 * ahead of the settings channel, the DEFAULT-set short-circuit and any consent
 * token, so it refuses the spawn outright. The fixture states that operator
 * decision through `persistAnalyzerConsent` — the same durable policy store
 * (`.audit-tools/audit/analyzer-policy.json`) the CLI itself reads — before the
 * first `next-step`. Production admission logic is untouched, and there is no
 * environment flag to remember.
 *
 * The id list is DERIVED from the candidate registry, never hand-written: a new
 * `defaultRun: true` candidate is declined by every fixture the day it lands.
 * The non-default candidates are already declined per fixture through the
 * `analyzer_consent` host offer, which this deliberately leaves in place — the
 * offer step is real coverage, and declining the whole registry here would
 * delete it.
 */
import {
  EXTERNAL_ANALYZER_CANDIDATES,
  persistAnalyzerConsent,
  type AnalyzerConsentDecision,
} from "audit-tools/shared";

/** Every candidate `admitSpawn` would run with no consent token — derived, never listed. */
export const DEFAULT_ACQUIRED_ANALYZER_IDS: readonly string[] =
  EXTERNAL_ANALYZER_CANDIDATES.filter((candidate) => candidate.defaultRun).map(
    (candidate) => candidate.id,
  );

/**
 * Record the operator's decline of every default-set acquired analyzer into
 * `root`'s durable analyzer policy. Call it once, when a fixture repository is
 * created and before any CLI invocation against it.
 */
export async function declineDefaultAcquiredAnalyzers(root: string): Promise<void> {
  await persistAnalyzerConsent(
    root,
    Object.fromEntries(
      DEFAULT_ACQUIRED_ANALYZER_IDS.map(
        (id) => [id, "declined" satisfies AnalyzerConsentDecision] as const,
      ),
    ),
  );
}
