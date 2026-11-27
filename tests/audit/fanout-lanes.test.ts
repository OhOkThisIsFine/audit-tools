import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readAuditReviewBinding } from "../../src/audit/cli/auditReviewBindings.js";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import os from "node:os";
import type { FanoutLaneSpec } from "../../src/audit/cli/fanoutLanes.js";
import { sourceTreeInstruction } from "../../src/audit/io/runSnapshot.js";

const { materializeFanoutLanes } = await import("../../src/audit/cli/fanoutLanes.js");
const { laneSubmissionPath, AUDIT_GATE_SUBMISSION_SCOPE, GATE_LANES, charterExtractionLane } = await import(
  "../../src/audit/cli/laneSubmissions.js"
);
const { laneAssetsDir, expectedSubmissionsPath } = await import("../../src/shared/io/auditToolsPaths.js");

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
  it("binds packet-only charter lanes without granting or instructing source reads", async () => {
    const dir = await mkdtemp(join(os.tmpdir(), "review-packet-only-"));
    try {
      const sourceRoot = join(dir, "frozen-source");
      const packet = join(dir, "packet.md");
      await writeFile(packet, "packet evidence");
      const ids = [charterExtractionLane("stated"), charterExtractionLane("structural"),
        charterExtractionLane("revealed"), GATE_LANES.charter_fidelity];
      const emit = () => materializeFanoutLanes({
        artifactsDir: dir, sourceRoot, runId: AUDIT_GATE_SUBMISSION_SCOPE,
        lanes: ids.map(id => ({
          id, label: id, fileCount: 0, riskScore: 0,
          promptFilename: `${id}.md`, promptText: "Read your packet only.",
          contextPaths: [packet],
        })),
      });
      const fanout = await emit();
      expect(fanout.readPaths).toContain(packet);
      expect(fanout.readPaths).not.toContain(sourceRoot);
      for (const lane of fanout.lanes) {
        const prompt = await readFile(lane.promptPath, "utf8");
        expect(prompt).toContain("Read your packet only.");
        expect(prompt).not.toContain("## Source tree");
        expect(prompt).not.toContain(sourceRoot);
        expect(prompt).toContain("## Bound review submission");
        expect(await readAuditReviewBinding(dir, lane.id)).toMatchObject({
          inputs: [{ path: packet, sha256: createHash("sha256").update("packet evidence").digest("hex") }],
        });
      }
      await writeFile(packet, "new packet bytes");
      expect(await readAuditReviewBinding(dir, ids[0]!)).toBeUndefined();
      await emit();
      const updatedDigest = createHash("sha256").update("new packet bytes").digest("hex");
      for (const lane of ids) {
        expect(await readAuditReviewBinding(dir, lane)).toMatchObject({ inputs: [{ path: packet, sha256: updatedDigest }] });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("binds the pre-trailer body and the completed prompt file independently on emission and replay", async () => {
    const dir = await mkdtemp(join(os.tmpdir(), "review-digests-"));
    const lane = GATE_LANES.design_review_contract;
    const emit = () => materializeFanoutLanes({
      artifactsDir: dir, sourceRoot: dir, runId: AUDIT_GATE_SUBMISSION_SCOPE,
      lanes: [{ id: lane, label: "Review", fileCount: 0, riskScore: 0, promptFilename: "review.md", promptText: "Review this contract." }],
    });
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    try {
      const verifyBinding = async () => {
        const fanout = await emit();
        const prompt = await readFile(fanout.lanes[0]!.promptPath, "utf8");
        const trailer = prompt.lastIndexOf("\n\n## Bound review submission\n");
        expect(trailer).toBeGreaterThan(0);
        const expectedBody = hash(prompt.slice(0, trailer));
        const expectedSet = JSON.parse(await readFile(expectedSubmissionsPath(dir), "utf8"));
        expect(expectedSet.entries[0].prompt_sha256).toBe(expectedBody);
        expect(await readAuditReviewBinding(dir, lane)).toMatchObject({
          promptSha256: expectedBody, promptContentSha256: hash(prompt),
        });
        return fanout.lanes[0]!;
      };
      const first = await verifyBinding();
      await mkdir(dirname(first.resultPath), { recursive: true });
      await writeFile(first.resultPath, "{}", "utf8");
      await writeFile(first.promptPath, "damaged prompt", "utf8");
      expect((await verifyBinding()).resultExists).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  const lanes = (dir: string): FanoutLaneSpec[] => [
    {
      id: "alpha",
      label: "Alpha lane",
      fileCount: 0,
      riskScore: 0,
      promptFilename: "alpha-prompt.md",
      promptText: `# alpha lane (${dir})`,
    },
    {
      id: "beta",
      label: "Beta lane",
      fileCount: 0,
      riskScore: 0,
      promptFilename: "beta-prompt.md",
      promptText: "# beta lane",
    },
  ];

  const materialize = (artifactsDir: string) =>
    materializeFanoutLanes({
      artifactsDir,
      sourceRoot: artifactsDir,
      runId: AUDIT_GATE_SUBMISSION_SCOPE,
      lanes: lanes(artifactsDir),
    });

  it("writes every pending lane's prompt file and declares paths for the step contract", async () => {
    const artifactsDir = await mkdtemp(join(os.tmpdir(), "audit-fanout-lanes-"));
    try {
      const fanout = await materialize(artifactsDir);
      expect(fanout.pendingLanes.map((l) => l.id)).toEqual(["alpha", "beta"]);
      expect(await readFile(fanout.lanes[0].promptPath, "utf8")).toContain("# alpha lane");
      // Source-reading lanes state where the run's frozen snapshot is.
      expect(await readFile(fanout.lanes[0].promptPath, "utf8")).toContain(sourceTreeInstruction(artifactsDir));
      expect(Object.keys(fanout.artifactPaths).sort()).toEqual([
        "alpha_prompt",
        "alpha_results",
        "beta_prompt",
        "beta_results",
      ]);
      // The step grants the frozen root for lanes instructed to read it.
      expect(fanout.readPaths).toEqual([...fanout.pendingLanes.map((l) => l.promptPath), artifactsDir]);
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
      // Access paths instruct only the missing lane (plus the granted source root).
      expect(fanout.readPaths).toEqual([join(promptDir, "beta-prompt.md"), artifactsDir]);
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
