import { loadArtifactBundle } from "../io/artifacts.js";
import { getArtifactsDir } from "./args.js";
import { outputJson } from "./cliHelpers.js";

export async function cmdRequeue(argv: string[]): Promise<void> {
  const artifactsDir = getArtifactsDir(argv);
  const bundle = await loadArtifactBundle(artifactsDir);
  outputJson({
    artifacts_dir: artifactsDir,
    task_count: bundle.requeue_tasks?.length ?? 0,
  });
}
