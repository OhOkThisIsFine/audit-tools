import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";
import type { FanoutLaneSpec } from "../../src/audit/cli/fanoutLanes.js";

const { materializeFanoutLanes } = await import("../../src/audit/cli/fanoutLanes.js");

// Always-materialized fan-out lanes (design resolution 2, 2026-08-05).
// Constraint 6 (K-of-N resume) pinned at the unit: a lane whose RESULT file
// already exists is complete — excluded from the pending set, its prompt never
// rewritten, its result never touched.
describe("materializeFanoutLanes", () => {
  const lanes = (dir: string): FanoutLaneSpec[] => [
    {
      id: "alpha",
      label: "Alpha lane",
      promptFilename: "alpha-prompt.md",
      resultFilename: "alpha.json",
      promptText: `# alpha lane (${dir})`,
    },
    {
      id: "beta",
      label: "Beta lane",
      promptFilename: "beta-prompt.md",
      resultFilename: "beta.json",
      promptText: "# beta lane",
    },
  ];

  it("writes every pending lane's prompt file and declares paths for the step contract", async () => {
    const artifactsDir = await mkdtemp(join(os.tmpdir(), "audit-fanout-lanes-"));
    try {
      const fanout = await materializeFanoutLanes({ artifactsDir, lanes: lanes(artifactsDir) });
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
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  it("K-of-N resume: a lane with a result on disk is complete — prompt not rewritten, result untouched", async () => {
    const artifactsDir = await mkdtemp(join(os.tmpdir(), "audit-fanout-lanes-"));
    try {
      const incoming = join(artifactsDir, "incoming");
      await mkdir(incoming, { recursive: true });
      // Alpha already completed in a prior run: result present, prompt stale.
      await writeFile(join(incoming, "alpha.json"), '{"done":true}', "utf8");
      await writeFile(join(incoming, "alpha-prompt.md"), "STALE PRIOR PROMPT", "utf8");

      const fanout = await materializeFanoutLanes({ artifactsDir, lanes: lanes(artifactsDir) });

      expect(fanout.pendingLanes.map((l) => l.id)).toEqual(["beta"]);
      expect(fanout.lanes.find((l) => l.id === "alpha")?.resultExists).toBe(true);
      // Completed lane untouched: neither regenerated nor overwritten.
      expect(await readFile(join(incoming, "alpha-prompt.md"), "utf8")).toBe("STALE PRIOR PROMPT");
      expect(await readFile(join(incoming, "alpha.json"), "utf8")).toBe('{"done":true}');
      // Access paths instruct only the missing lane.
      expect(fanout.readPaths).toEqual([join(incoming, "beta-prompt.md")]);
      expect(fanout.writePaths).toEqual([join(incoming, "beta.json")]);
      // The whole fan-out is still described for the step contract.
      expect(Object.keys(fanout.artifactPaths)).toHaveLength(4);
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  it("re-materializes a completed lane's prompt when the file is missing (artifact_paths never names an absent file)", async () => {
    const artifactsDir = await mkdtemp(join(os.tmpdir(), "audit-fanout-lanes-"));
    try {
      const incoming = join(artifactsDir, "incoming");
      await mkdir(incoming, { recursive: true });
      // Alpha completed, but its prompt file was deleted out-of-band.
      await writeFile(join(incoming, "alpha.json"), '{"done":true}', "utf8");

      const fanout = await materializeFanoutLanes({ artifactsDir, lanes: lanes(artifactsDir) });

      expect(fanout.pendingLanes.map((l) => l.id)).toEqual(["beta"]);
      expect(await readFile(join(incoming, "alpha-prompt.md"), "utf8")).toContain("# alpha lane");
      expect(await readFile(join(incoming, "alpha.json"), "utf8")).toBe('{"done":true}');
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });
});
