import { getArtifactsDir, getAuditorDescriptor, getExplicitProvider, getFlag, getHostModel, getRootDir } from "./args.js";
import {
  createFreshSessionProvider,
  resolveFreshSessionProviderName,
} from "../providers/index.js";
import { loadSessionConfig } from "../supervisor/sessionConfig.js";
import { prepareDispatchArtifacts } from "./dispatch.js";
import { packageRoot } from "./paths.js";
import { resolveSessionConfig, type RepoSessionIntent, type SessionConfig } from "audit-tools/shared";

export async function cmdPrepareDispatch(argv: string[]): Promise<void> {
  const runId = getFlag(argv, "--run-id");
  if (!runId) throw new Error("prepare-dispatch requires --run-id <run_id>");
  const artifactsDir = getArtifactsDir(argv);
  let intent: RepoSessionIntent;
  try {
    intent = await loadSessionConfig(artifactsDir);
  } catch (e) {
    process.stderr.write(
      `[prepare-dispatch] session-config.json is invalid — using defaults. Error: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    intent = {};
  }
  // G2: the driver handshake arrives as one `--auditor <json>`; resolve it over the repo
  // INTENT so the dispatch pool/provider come from the descriptor, not the repo config.
  const descriptor = getAuditorDescriptor(argv);
  const sessionConfig: SessionConfig = resolveSessionConfig(intent, descriptor);
  const providerName = resolveFreshSessionProviderName(
    getExplicitProvider(argv) ??
      (sessionConfig.provider === undefined ? "auto" : undefined),
    sessionConfig,
  );
  const provider = createFreshSessionProvider(providerName, sessionConfig);
  const hostModel = getHostModel(argv) ?? sessionConfig.block_quota?.host_model ?? null;
  const self = descriptor?.self ?? {};
  const result = await prepareDispatchArtifacts({
    packageRoot,
    runId,
    artifactsDir,
    root: getFlag(argv, "--root") ? getRootDir(argv) : undefined,
    sessionConfig,
    providerName,
    hostModel,
    queryLimits: provider.queryLimits?.bind(provider),
    hostActiveSubagentLimit: self.max_active_subagents ?? null,
    hostContextTokens: self.context_tokens ?? null,
    hostOutputTokens: self.output_tokens ?? null,
    hostModelRoster: self.roster ?? null,
    hostModelId: self.model_id ?? null,
  });
  console.log(JSON.stringify(result, null, 2));
}
