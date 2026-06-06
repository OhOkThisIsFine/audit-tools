import { loadArtifactBundle } from "../io/artifacts.js";
import { prefixValidationIssues } from "@audit-tools/shared";
import type { SessionConfig } from "@audit-tools/shared";
import { validateArtifactBundle } from "../validation/artifacts.js";
import {
  validateConfiguredProviderEnvironment,
  validateSessionConfig,
} from "../validation/sessionConfig.js";
import {
  resolveFreshSessionProviderName,
} from "../providers/index.js";
import {
  getSessionConfigPath,
  loadSessionConfig,
  readSessionConfigFile,
} from "../supervisor/sessionConfig.js";
import { getArtifactsDir } from "./args.js";

export async function cmdValidate(argv: string[]): Promise<void> {
  const artifactsDir = getArtifactsDir(argv);
  const bundle = await loadArtifactBundle(artifactsDir);
  const sessionConfigPath = getSessionConfigPath(artifactsDir);
  const rawSessionConfig = await readSessionConfigFile(artifactsDir);
  const artifactIssues = validateArtifactBundle(bundle);
  const sessionConfigIssues =
    rawSessionConfig === undefined
      ? []
      : prefixValidationIssues(
          "session_config",
          validateSessionConfig(rawSessionConfig),
        );
  const providerIssues =
    rawSessionConfig === undefined || sessionConfigIssues.length > 0
      ? []
      : prefixValidationIssues(
          "session_config",
          await validateConfiguredProviderEnvironment(rawSessionConfig as SessionConfig),
        );
  const issues = [
    ...artifactIssues,
    ...sessionConfigIssues,
    ...providerIssues,
  ];
  const resolvedProvider =
    rawSessionConfig === undefined
      ? "local-subprocess"
      : sessionConfigIssues.length > 0
        ? null
        : resolveFreshSessionProviderName(
            undefined,
            rawSessionConfig as SessionConfig,
          );
  console.log(
    JSON.stringify(
      {
        artifacts_dir: artifactsDir,
        session_config_path: sessionConfigPath,
        session_config_present: rawSessionConfig !== undefined,
        resolved_provider: resolvedProvider,
        artifact_issue_count: artifactIssues.length,
        session_config_issue_count:
          sessionConfigIssues.length + providerIssues.length,
        issue_count: issues.length,
        issues,
      },
      null,
      2,
    ),
  );
  process.exitCode = issues.length > 0 ? 1 : 0;
}
