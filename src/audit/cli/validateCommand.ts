import { loadArtifactBundle } from "../io/artifacts.js";
import { prefixValidationIssues } from "audit-tools/shared";
import type { SessionConfig } from "audit-tools/shared";
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
  // Only `error`-severity config issues make the config unusable — a
  // `warning` (e.g. dangerously_skip_permissions=true) is surfaced but must not
  // suppress provider probing/resolution or fail the command.
  const sessionConfigErrorCount = sessionConfigIssues.filter(
    (issue) => issue.severity === "error",
  ).length;
  const providerIssues =
    rawSessionConfig === undefined || sessionConfigErrorCount > 0
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
      ? "worker-command"
      : sessionConfigErrorCount > 0
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
  // Exit non-zero only when something is genuinely wrong (error severity);
  // advisory warnings are reported in `issues` but do not fail the command.
  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  process.exitCode = errorCount > 0 ? 1 : 0;
}
