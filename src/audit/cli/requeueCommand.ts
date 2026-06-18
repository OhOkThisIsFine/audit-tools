import { loadArtifactBundle } from "../io/artifacts.js";
import { getArtifactsDir } from "./args.js";

export async function cmdRequeue(argv: string[]): Promise<void> {
  const artifactsDir = getArtifactsDir(argv);
  const bundle = await loadArtifactBundle(artifactsDir);
  console.log(
    JSON.stringify(
      {
        artifacts_dir: artifactsDir,
        task_count: bundle.requeue_tasks?.length ?? 0,
      },
      null,
      2,
    ),
  );
}
