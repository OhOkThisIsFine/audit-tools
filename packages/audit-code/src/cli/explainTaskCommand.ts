import { loadArtifactBundle } from "../io/artifacts.js";
import { getArtifactsDir, getFlag } from "./args.js";

export async function cmdExplainTask(argv: string[]): Promise<void> {
  const artifactsDir = getArtifactsDir(argv);
  const taskId = getFlag(argv, "--task-id") ?? argv[3];
  if (!taskId) {
    throw new Error("explain-task requires <task_id> or --task-id <task_id>");
  }

  const bundle = await loadArtifactBundle(artifactsDir);
  const task =
    [...(bundle.audit_tasks ?? []), ...(bundle.requeue_tasks ?? [])].find(
      (item) => item.task_id === taskId,
    );
  if (!task) {
    throw new Error(`Unknown task_id '${taskId}'.`);
  }

  const coverageEntries = (bundle.coverage_matrix?.files ?? [])
    .filter((file) => task.file_paths.includes(file.path))
    .sort((a, b) => a.path.localeCompare(b.path));
  const matchingResults = (bundle.audit_results ?? []).filter(
    (result) => result.task_id === task.task_id,
  );

  console.log(
    JSON.stringify(
      {
        artifacts_dir: artifactsDir,
        task_id: task.task_id,
        task,
        file_count: task.file_paths.length,
        coverage_entries: coverageEntries,
        pending_coverage: coverageEntries
          .map((file) => ({
            path: file.path,
            missing_lenses: file.required_lenses.filter(
              (lens) => !file.completed_lenses.includes(lens),
            ),
          }))
          .filter((file) => file.missing_lenses.length > 0),
        matching_result_count: matchingResults.length,
        matching_finding_ids: matchingResults.flatMap((result) =>
          result.findings.map((finding) => finding.id),
        ),
      },
      null,
      2,
    ),
  );
}
