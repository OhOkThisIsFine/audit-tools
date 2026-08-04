import { describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";

const { gateHostFanout } = await import(
  "../../src/audit/cli/dispatch/hostFanoutGate.js",
);
const { stampDesignReviewSkipped, stampSystemicChallengeSkipped } = await import(
  "../../src/audit/cli/nextStepHelpers.js",
);
const { readDesignReviewSnapshot, isDesignReviewStale } = await import(
  "../../src/audit/orchestrator/designReviewSnapshot.js",
);

function units(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `unit-${index + 1}`,
    estInputBytes: 4_000,
  }));
}

describe("host fan-out handoff", () => {
  test("returns the complete panel without local walls or quota state", async () => {
    const outcome = await gateHostFanout({ units: units(5) });

    expect(outcome).toEqual({
      atWall: false,
      livelocked: false,
      earliestResetAt: null,
      reason: null,
      emptyGrantCause: null,
      grantedCount: 5,
      requiredCount: 5,
      dispatchQuotaPath: null,
      bindingWindow: null,
      perPacketCost: null,
    });
  });
});

describe("host fan-out skip stamps", () => {
  test("stampDesignReviewSkipped satisfies both review passes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skip-design-"));
    try {
      const bundle: ArtifactBundle = {
        repo_manifest: {
          repository: { name: "fixture" },
          generated_at: "2026-07-23T00:00:00Z",
          files: [],
        },
      };
      await stampDesignReviewSkipped(dir, bundle);
      const assessment = JSON.parse(
        await readFile(join(dir, "design_assessment.json"), "utf8"),
      );
      expect(assessment.contract_reviewed).toBe(true);
      expect(assessment.conceptual_reviewed).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("stampDesignReviewSkipped remains fresh on the next derive", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skip-design-stick-"));
    try {
      const inputBundle: ArtifactBundle = {
        repo_manifest: {
          repository: { name: "fixture" },
          generated_at: "2026-07-23T00:00:00Z",
          files: [],
        },
      };
      await stampDesignReviewSkipped(dir, inputBundle);
      const writtenAssessment = JSON.parse(
        await readFile(join(dir, "design_assessment.json"), "utf8"),
      );
      const nextBundle = { ...inputBundle, design_assessment: writtenAssessment };

      for (const pass of ["contract", "conceptual"] as const) {
        const snapshot = await readDesignReviewSnapshot(dir, pass);
        expect(snapshot).toBeTruthy();
        expect(isDesignReviewStale(snapshot!, nextBundle)).toBe(false);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("stampSystemicChallengeSkipped converges the loop", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skip-systemic-"));
    try {
      await stampSystemicChallengeSkipped(dir, {});
      const register = JSON.parse(
        await readFile(join(dir, "systemic_challenge.json"), "utf8"),
      );
      expect(register.converged).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
