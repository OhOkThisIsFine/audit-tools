/**
 * Suite hermeticity for the ACQUIRED (external) analyzer set.
 *
 * The heavy CLI fixtures run the real fold, which enables acquisition, and
 * `admitSpawn` runs a DEFAULT-set candidate with no consent token — so every
 * such fixture spawned `npx -y -p typescript@5.9.3 -p type-coverage@2.29.7` and
 * probed/downloaded the pinned `gitleaks` release. On a cold npx cache the first
 * spawn pays a full typescript install while the other workers serialize behind
 * npx's per-package lock: CI run 33830307675 (Linux, shard 3/4) timed
 * `audit-code-completion-present.test.ts` out at 300 s that way, and the same
 * class produced 45-minute local runs. No test may depend on the network or on
 * npx cache state.
 *
 * The control is the product's own seam, not a test-only escape hatch: a
 * recorded operator `declined` is read FIRST in `admitSpawn` and refuses the
 * spawn outright. `declineDefaultAcquiredAnalyzers` states that decision through
 * `persistAnalyzerConsent`, and every shared fixture creator calls it.
 *
 * Both halves are pinned here because either one alone is satisfiable without
 * the other: the fixtures WRITE the decision (cheap, per helper), and the fold
 * HONORS it end to end (the acquisition marker the tool writes).
 */
import { describe, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { EXTERNAL_ANALYZER_CANDIDATES, loadAnalyzerPolicy } from "audit-tools/shared";
import { ANALYZER_DENIAL_REASONS } from "../../src/shared/analyzers/acquisitionEngine.js";
import { HEAVY_AUDIT_TEST_TIMEOUT_MS } from "../helpers/heavy-timeout.mjs";
import { DEFAULT_ACQUIRED_ANALYZER_IDS } from "../helpers/analyzerConsentFixture.js";
import {
  callNextStep,
  withTempRepo as withCompletionRepo,
} from "./helpers/completion-harness.js";
import { withTempRepo as withNextStepRepo } from "./helpers/next-step-harness.js";
import { withTempRepo as withWrapperRepo } from "./helpers/wrapper-harness.js";
import { answerHostPause, MAX_HOST_PAUSES } from "./helpers/step-driver.js";
import { withTempDir } from "./helpers/withTempDir.mjs";

const { writeFixtureRepo } = await import("./helpers/fixture.mjs");

/** Every shared fixture creator that a CLI-driving test builds a repository with. */
const FIXTURE_CREATORS: ReadonlyArray<
  readonly [string, (fn: (root: string) => Promise<void>) => Promise<void>]
> = [
  ["completion-harness withTempRepo", withCompletionRepo],
  ["next-step-harness withTempRepo", withNextStepRepo],
  ["wrapper-harness withTempRepo", withWrapperRepo],
  [
    "fixture.mjs writeFixtureRepo",
    (fn) =>
      withTempDir("audit-code-fixture-consent-", async (tempDir) => {
        const root = join(tempDir, "repo");
        await writeFixtureRepo(root);
        await fn(root);
      }),
  ],
];

describe("shared CLI fixtures record the operator decline before any CLI call", () => {
  for (const [label, createFixture] of FIXTURE_CREATORS) {
    test(`${label} declines every default acquired analyzer`, async () => {
      await createFixture(async (root) => {
        const policy = await loadAnalyzerPolicy(root);
        // Derived from the registry: a new `defaultRun: true` candidate must be
        // declined by every fixture the day it lands.
        expect(DEFAULT_ACQUIRED_ANALYZER_IDS.length).toBeGreaterThan(0);
        for (const id of DEFAULT_ACQUIRED_ANALYZER_IDS) {
          expect(
            policy.analyzer_consent?.[id],
            `${label} left default acquired analyzer '${id}' undeclined — the fold ` +
              "would admit it with no consent token and spawn npx/a release download",
          ).toBe("declined");
        }
      });
    });
  }
});

test(
  "the fold refuses every default acquired analyzer against a fixture repo",
  { timeout: HEAVY_AUDIT_TEST_TIMEOUT_MS },
  async () => {
    await withCompletionRepo(async (root) => {
      const artifactsDir = join(root, ".audit-tools/audit");
      const markerPath = join(artifactsDir, "external_analyzer_acquisition.json");

      // Walk the real host pauses until the acquisition executor has run and
      // written its provenance marker.
      for (let i = 0; i < MAX_HOST_PAUSES && !existsSync(markerPath); i++) {
        const step = await callNextStep(root, artifactsDir);
        if (existsSync(markerPath)) break;
        if (!(await answerHostPause(step))) break;
      }
      expect(
        existsSync(markerPath),
        "next-step never ran the external-analyzer acquisition executor",
      ).toBe(true);

      const marker = JSON.parse(await readFile(markerPath, "utf8")) as {
        enabled: boolean;
        tool_statuses: Array<{ tool: string; resolved: boolean; error?: string }>;
      };
      // The fixture must exercise the REAL acquisition path — an `enabled:false`
      // hermetic no-op marker would make every assertion below vacuous.
      expect(marker.enabled).toBe(true);

      const applicable = EXTERNAL_ANALYZER_CANDIDATES.filter(
        (candidate) => candidate.defaultRun && candidate.detect(root),
      ).map((candidate) => candidate.id);
      // Anti-vacuity: this fixture really does reach both network-bound default
      // candidates — `gitleaks` (release download) and `type-coverage` (npx).
      expect(applicable).toEqual(
        expect.arrayContaining(["gitleaks", "type-coverage"]),
      );

      for (const id of applicable) {
        const status = marker.tool_statuses.find((entry) => entry.tool === id);
        expect(status, `no tool_status recorded for default candidate '${id}'`).toBeDefined();
        expect(
          status?.error,
          `default acquired analyzer '${id}' was not refused by the recorded ` +
            "operator decline — this fixture reaches the network",
        ).toBe(ANALYZER_DENIAL_REASONS.consent_declined);
        expect(status?.resolved).toBe(false);
      }
    });
  },
);
