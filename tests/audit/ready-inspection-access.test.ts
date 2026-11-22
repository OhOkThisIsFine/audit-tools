import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";

import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import type { runDeterministicForNextStep } from "../../src/audit/cli/nextStepHelpers.js";
import type { StepArtifact } from "../../src/audit/cli/steps.js";
import { withTempRepo } from "./helpers/next-step-harness.js";

type Frontier = Awaited<ReturnType<typeof runDeterministicForNextStep>>;
const planner = vi.hoisted(() => ({ result: undefined as Frontier | undefined }));
// Stub only the planner's selected frontier. The CLI, emission scaffold, charter
// packets and access grants remain real. Question ingestion is tested separately.
vi.mock("../../src/audit/cli/nextStepHelpers.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/audit/cli/nextStepHelpers.js")>(),
  runDeterministicForNextStep: vi.fn(async () => planner.result),
}));
const { cmdNextStep } = await import("../../src/audit/cli/nextStepCommand.js");

test("charter access stays isolated even beside a large question workload", async () => {
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-tools", "audit");
    const runId = "ready-inspection-run";
    const runDir = join(artifactsDir, "runs", runId);
    await mkdir(runDir, { recursive: true });
    const doc = "# Charter\nPreserve every named document through its final line.\n";
    await writeFile(join(root, "README.md"), doc);
    await writeFile(join(root, "src/a.ts"), "// Preserve this named comment.\nexport const value = 1;\n");
    const bundle: ArtifactBundle = {
      repo_manifest: {
        repository: { name: "ready-inspection-fixture" }, generated_at: "2026-01-01T00:00:00Z",
        files: [
          { path: "src/a.ts", language: "typescript", size_bytes: 58 },
          { path: "README.md", language: "markdown", size_bytes: doc.length },
        ],
      },
      file_disposition: { files: [{ path: "README.md", status: "doc_only" }] },
      // The charter read set is the unit partition's non-test files (R5).
      unit_manifest: {
        units: [{ unit_id: "source", name: "source", kind: "module", files: ["src/a.ts"], required_lenses: [] }],
      },
      structure_decomposition: {
        generated_at: "2026-01-01T00:00:00Z", target: "structure", node_universe_size: 1,
        source_ids: [], consensus: [{ node_id: "source", members: ["src/a.ts"],
          agreed_across_source: 1, stable_across_scale: 1, contested: false }],
        contested: [], findings: [],
      },
      intent_checkpoint: {
        schema_version: "intent-checkpoint/v1", confirmed_at: "2026-01-01T00:00:00Z",
        confirmed_by: "host", scope_summary: "fixture", intent_summary: "full audit",
        design_review: { ceiling: { rung: "deep" } },
      },
    };
    const workloadPath = join(runDir, "host-workload.json");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    async function emit(): Promise<StepArtifact> {
      planner.result = {
        kind: "charter_extraction", bundle, sourceRoot: root,
        state: { status: "active", obligations: [] },
      };
      await cmdNextStep(["--root", root, "--artifacts-dir", artifactsDir]);
      return JSON.parse(await readFile(join(artifactsDir, "steps/current-step.json"), "utf8"));
    }
    try {
      const ownStep = await emit();
      expect(ownStep.step_kind).toBe("charter_extraction");
      expect(ownStep.access!.write_paths).toHaveLength(3);
      expect(ownStep.artifact_paths.host_workload).toBeUndefined();
      await writeFile(workloadPath, JSON.stringify({ work_items: [{ assignment_id: "other-question-0" }] }));
      const one = await emit();
      const queued = JSON.stringify({
        work_items: Array.from({ length: 470 }, (_, i) => ({ assignment_id: "other-question-" + i })),
      });
      await writeFile(workloadPath, queued);
      const many = await emit();
      expect(many).toEqual(one);
      expect(await readFile(workloadPath, "utf8")).toBe(queued);
      expect(many.access!.read_paths).not.toContain(workloadPath.replaceAll("\\", "/"));
      for (const [key, path] of Object.entries(many.artifact_paths)) {
        if (!key.startsWith("charter_extraction_") || !key.endsWith("_prompt")) continue;
        const prompt = await readFile(path!, "utf8");
        expect(prompt).not.toContain("host-workload.json");
        expect(prompt).not.toContain("other-question-");
      }
      const statedPacket = many.access!.read_paths.find(path => path.endsWith("charter-extraction-stated-packet.md"))!;
      const packet = await readFile(statedPacket, "utf8");
      for (const line of doc.trimEnd().split("\n")) expect(packet).toContain(line);
      expect(packet).toContain("Preserve this named comment.");

    } finally {
      log.mockRestore();
      planner.result = undefined;
    }
  });
});
