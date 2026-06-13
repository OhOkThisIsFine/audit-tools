import { getArtifactsDir, getExplicitProvider, getFlag, getHostContextTokens, getHostMaxActiveSubagents, getHostModel, getHostModelId, getHostModelRoster, getHostOutputTokens, getRootDir } from "./args.js";
import { createFreshSessionProvider } from "../providers/index.js";
import { loadSessionConfig } from "../supervisor/sessionConfig.js";
import { prepareDispatchArtifacts } from "./dispatch.js";
import { packageRoot } from "./paths.js";
import type { SessionConfig } from "@audit-tools/shared";

export async function cmdPrepareDispatch(argv: string[]): Promise<void> {
  const runId = getFlag(argv, "--run-id");
  if (!runId) throw new Error("prepare-dispatch requires --run-id <run_id>");
  const artifactsDir = getArtifactsDir(argv);
  let sessionConfig: SessionConfig;
  try {
    sessionConfig = await loadSessionConfig(artifactsDir);
  } catch (e) {
    process.stderr.write(
      `[prepare-dispatch] session-config.json is invalid — using defaults. Error: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    sessionConfig = {} as SessionConfig;
  }
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
    hostContextTokens: getHostContextTokens(argv),
    hostOutputTokens: getHostOutputTokens(argv),
    hostModelRoster: getHostModelRoster(argv),
    hostModelId: getHostModelId(argv),
  });
  console.log(JSON.stringify(result, null, 2));
}
