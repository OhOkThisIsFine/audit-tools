import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { expect, test, vi } from "vitest";

import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import type { runDeterministicForNextStep } from "../../src/audit/cli/nextStepHelpers.js";
import type { StepArtifact } from "../../src/audit/cli/steps.js";
import { ingestAuditHostResults, type AuditHostWorkItem, type AuditHostWorkload } from "../../src/audit/cli/dispatch/hostHandoff.js";
import { withTempRepo } from "./helpers/next-step-harness.js";

type Frontier = Awaited<ReturnType<typeof runDeterministicForNextStep>>;
const planner = vi.hoisted(() => ({ result: undefined as Frontier | undefined }));
// Stub only the planner's selected frontier. The CLI, emission scaffold, charter
// packets, workload, persisted task bindings and result ingestion remain real.
vi.mock("../../src/audit/cli/nextStepHelpers.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/audit/cli/nextStepHelpers.js")>(),
  runDeterministicForNextStep: vi.fn(async () => planner.result),
}));
const { cmdNextStep } = await import("../../src/audit/cli/nextStepCommand.js");

test("ready inspection keeps the architecture contract constant at 470 pending results", async () => {
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
    const inspectionRun = {
      contract_version: "audit-review-run/v1alpha1" as const, run_id: runId,
      review_run_path: join(runDir, "review-run.json"),
      pending_audit_tasks_path: join(runDir, "pending-audit-tasks.json"),
      host_workload_path: join(runDir, "host-workload.json"),
      host_result_map_path: join(runDir, "host-result-map.json"),
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    async function emit(count: number | undefined): Promise<StepArtifact> {
      bundle.audit_tasks = Array.from({ length: count ?? 0 }, (_, index) => ({
        task_id: `task-${String(index).padStart(3, "0")}`, unit_id: "source", pass_id: "base",
        lens: "correctness", file_paths: ["src/a.ts"], file_line_counts: { "src/a.ts": 2 },
        rationale: "Review the assigned source", priority: "medium", token_estimate: 100,
      }));
      await writeFile(inspectionRun.pending_audit_tasks_path, JSON.stringify(bundle.audit_tasks));
      planner.result = {
        kind: "charter_extraction", bundle, sourceRoot: root,
        state: { status: "active", obligations: [] },
        ...(count === undefined ? {} : { inspectionRun }),
      };
      await cmdNextStep(["--root", root, "--artifacts-dir", artifactsDir]);
      return JSON.parse(await readFile(join(artifactsDir, "steps/current-step.json"), "utf8"));
    }
    try {
      const ownStep = await emit(undefined);
      expect(ownStep.step_kind).toBe("charter_extraction");
      expect(ownStep.access!.write_paths).toHaveLength(3);
      expect(ownStep.artifact_paths.host_workload).toBeUndefined();
      const one = await emit(1);
      const many = await emit(470); // The pending count in the reported oversized run.
      expect(many.access!.write_paths,
        `step JSON bytes: 1 pending=${JSON.stringify(one, null, 2).length}, 470 pending=${JSON.stringify(many, null, 2).length}`,
      ).toEqual(ownStep.access!.write_paths);
      expect(many).toEqual(one);
      expect(many.access!.read_paths).toEqual([
        ...ownStep.access!.read_paths,
        inspectionRun.host_workload_path, inspectionRun.host_result_map_path,
        inspectionRun.pending_audit_tasks_path,
      ]);

      const workload: AuditHostWorkload = JSON.parse(await readFile(inspectionRun.host_workload_path, "utf8"));
      expect(workload.work_items).toHaveLength(470);
      const first = workload.work_items[0]!;
      const sibling = workload.work_items[1]!;
      for (const item of workload.work_items) {
        expect(item.prompt.text).toContain(item.result_path);
        expect(many.access!.write_paths).not.toContain(resolve(root, item.result_path));
      }
      expect(first.prompt.text).not.toContain(sibling.result_path);
      for (const [key, path] of Object.entries(many.artifact_paths)) {
        if (!key.startsWith("charter_extraction_") || !key.endsWith("_prompt")) continue;
        const prompt = await readFile(path!, "utf8");
        expect(prompt).not.toContain(inspectionRun.host_workload_path);
        expect(prompt).not.toContain(first.result_path);
      }
      const statedPacket = many.access!.read_paths.find(path => path.endsWith("charter-extraction-stated-packet.md"))!;
      const packet = await readFile(statedPacket, "utf8");
      for (const line of doc.trimEnd().split("\n")) expect(packet).toContain(line);
      expect(packet).toContain("Preserve this named comment.");

      function result(item: AuditHostWorkItem) {
        return JSON.stringify({
          contract_version: "audit-host-result/v1alpha1", run_id: runId,
          result_id: `${item.id}-${item.prompt.sha256.slice(0, 12)}`,
          work_item_id: item.id, prompt_sha256: item.prompt.sha256,
          file_coverage: [{ path: "src/a.ts", reviewed_lines: 2, total_lines: 2 }], findings: [],
        });
      }
      const firstPath = resolve(root, first.result_path);
      await mkdir(dirname(firstPath), { recursive: true });
      await writeFile(firstPath, result(first));
      // A valid answer at a sibling's path is refused by the persisted binding.
      // This is submission validation, not an operating-system write sandbox.
      await writeFile(resolve(root, sibling.result_path), result(first));
      const ingest = () => ingestAuditHostResults({
        root, sourceRoot: root, artifactsDir, runId, auditTasks: bundle.audit_tasks!,
        pendingTaskIds: new Set(bundle.audit_tasks!.map(task => task.task_id)),
      });
      const wrongPath = await ingest();
      expect(wrongPath.accepted_results.map(item => item.task_id)).toEqual([first.id]);
      expect(wrongPath.issues).toContainEqual(expect.objectContaining({
        work_item_id: sibling.id, code: "submission_contract_invalid", check: "identity_binding",
      }));
      await writeFile(resolve(root, sibling.result_path), result(sibling));
      const last = workload.work_items.at(-1)!;
      await writeFile(resolve(root, last.result_path), result(last));
      const parallel = await ingest();
      expect(parallel.accepted_count).toBe(2);
      expect(parallel.accepted_results.map(item => item.task_id)).toEqual([first.id, sibling.id, last.id]);
    } finally {
      log.mockRestore();
      planner.result = undefined;
    }
  });
});
