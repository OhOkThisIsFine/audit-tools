import { getArtifactsDir, getExplicitProvider, getFlag, getHostMaxActiveSubagents, getHostModel, getRootDir } from "./args.js";
import { createFreshSessionProvider } from "../providers/index.js";
import { loadSessionConfig } from "../supervisor/sessionConfig.js";
import { prepareDispatchArtifacts } from "./dispatch.js";
import { packageRoot } from "./paths.js";
import type { SessionConfig } from "@audit-tools/shared";

export async function cmdPrepareDispatch(argv: string[]): Promise<void> {
  const runId = getFlag(argv, "--run-id");
  if (!runId) throw new Error("prepare-dispatch requires --run-id <run_id>");
  const artifactsDir = getArtifactsDir(argv);
  const sessionConfig = await loadSessionConfig(artifactsDir).catch(
    () => ({} as SessionConfig),
  );
  const provider = createFreshSessionProvider(getExplicitProvider(argv), sessionConfig);
  const hostModel = getHostModel(argv) ?? sessionConfig.block_quota?.host_model ?? null;
  const result = await prepareDispatchArtifacts({
    packageRoot,
    runId,
    artifactsDir,
    root: getFlag(argv, "--root") ? getRootDir(argv) : undefined,
    sessionConfig,
    hostModel,
    queryLimits: provider.queryLimits?.bind(provider),
    hostActiveSubagentLimit: getHostMaxActiveSubagents(argv),
  });
  console.log(JSON.stringify(result, null, 2));
}
