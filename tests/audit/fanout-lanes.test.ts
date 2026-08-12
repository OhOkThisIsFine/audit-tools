import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import os from "node:os";
import type { FanoutLaneSpec } from "../../src/audit/cli/fanoutLanes.js";

const { materializeFanoutLanes } = await import("../../src/audit/cli/fanoutLanes.js");
const { laneSubmissionPath, AUDIT_GATE_SUBMISSION_SCOPE } = await import(
  "../../src/audit/cli/laneSubmissions.js"
);
const { laneAssetsDir } = await import("../../src/shared/io/auditToolsPaths.js");

// Always-materialized fan-out lanes (design resolution 2, 2026-08-05).
// Constraint 6 (K-of-N resume) pinned at the unit: a lane whose SUBMISSION
// already exists is complete — excluded from the pending set, its prompt never
// rewritten, its submission never touched.
//
// Post-P25 a lane spec no longer names its own result file: it declares an id,
// and the tool derives the bound submission path from it. So these tests ask the
// tool where the submission goes rather than re-spelling a filename — which is
// the property, not an inconvenience.
describe("materializeFanoutLanes", () => {
  const lanes = (dir: string): FanoutLaneSpec[] => [
    {
      id: "alpha",
      label: "Alpha lane",
      promptFilename: "alpha-prompt.md",
      promptText: `# alpha lane (${dir})`,
    },
    {
      id: "beta",
      label: "Beta lane",
      promptFilename: "beta-prompt.md",
      promptText: "# beta lane",
    },
  ];

  const materialize = (artifactsDir: string) =>
    materializeFanoutLanes({
      artifactsDir,
      runId: AUDIT_GATE_SUBMISSION_SCOPE,
      lanes: lanes(artifactsDir),
    });

  it("writes every pending lane's prompt file and declares paths for the step contract", async () => {
    const artifactsDir = await mkdtemp(join(os.tmpdir(), "audit-fanout-lanes-"));
    try {
      const fanout = await materialize(artifactsDir);
      expect(fanout.pendingLanes.map((l) => l.id)).toEqual(["alpha", "beta"]);
      expect(await readFile(fanout.lanes[0].promptPath, "utf8")).toContain("# alpha lane");
      expect(Object.keys(fanout.artifactPaths).sort()).toEqual([
        "alpha_prompt",
        "alpha_results",
        "beta_prompt",
        "beta_results",
      ]);
      expect(fanout.readPaths).toEqual(fanout.pendingLanes.map((l) => l.promptPath));
      expect(fanout.writePaths).toEqual(fanout.pendingLanes.map((l) => l.resultPath));
      // The bound path is tool-computed, never the lane's own spelling.
      for (const lane of fanout.lanes) {
        expect(lane.resultPath).toBe(laneSubmissionPath(artifactsDir, lane.id));
        expect(lane.resultPath.replaceAll("\\", "/")).toMatch(
          /\/submissions\/[0-9a-f]{64}\.json$/u,
        );
      }
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  it("K-of-N resume: a lane with a submission on disk is complete — prompt not rewritten, submission untouched", async () => {
    const artifactsDir = await mkdtemp(join(os.tmpdir(), "audit-fanout-lanes-"));
    try {
      const promptDir = laneAssetsDir(artifactsDir);
      const alphaSubmission = laneSubmissionPath(artifactsDir, "alpha");
      await mkdir(promptDir, { recursive: true });
      await mkdir(dirname(alphaSubmission), { recursive: true });
      // Alpha already completed in a prior run: submission present, prompt stale.
      await writeFile(alphaSubmission, '{"done":true}', "utf8");
      await writeFile(join(promptDir, "alpha-prompt.md"), "STALE PRIOR PROMPT", "utf8");

      const fanout = await materialize(artifactsDir);

      expect(fanout.pendingLanes.map((l) => l.id)).toEqual(["beta"]);
      expect(fanout.lanes.find((l) => l.id === "alpha")?.resultExists).toBe(true);
      // Completed lane untouched: neither regenerated nor overwritten.
      expect(await readFile(join(promptDir, "alpha-prompt.md"), "utf8")).toBe(
        "STALE PRIOR PROMPT",
      );
      expect(await readFile(alphaSubmission, "utf8")).toBe('{"done":true}');
      // Access paths instruct only the missing lane.
      expect(fanout.readPaths).toEqual([join(promptDir, "beta-prompt.md")]);
      expect(fanout.writePaths).toEqual([laneSubmissionPath(artifactsDir, "beta")]);
      // The whole fan-out is still described for the step contract.
      expect(Object.keys(fanout.artifactPaths)).toHaveLength(4);
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  it("re-materializes a completed lane's prompt when the file is missing (artifact_paths never names an absent file)", async () => {
    const artifactsDir = await mkdtemp(join(os.tmpdir(), "audit-fanout-lanes-"));
    try {
      const promptDir = laneAssetsDir(artifactsDir);
      const alphaSubmission = laneSubmissionPath(artifactsDir, "alpha");
      await mkdir(dirname(alphaSubmission), { recursive: true });
      // Alpha completed, but its prompt file was deleted out-of-band.
      await writeFile(alphaSubmission, '{"done":true}', "utf8");

      const fanout = await materialize(artifactsDir);

      expect(fanout.pendingLanes.map((l) => l.id)).toEqual(["beta"]);
      expect(await readFile(join(promptDir, "alpha-prompt.md"), "utf8")).toContain(
        "# alpha lane",
      );
      expect(await readFile(alphaSubmission, "utf8")).toBe('{"done":true}');
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });
});
