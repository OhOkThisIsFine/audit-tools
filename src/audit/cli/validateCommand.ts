import { join } from "node:path";
import {
  SESSION_INTENT_RELATIVE_PATH,
  loadSessionIntent,
} from "audit-tools/shared";
import { loadArtifactBundle } from "../io/artifacts.js";
import { validateArtifactBundle } from "../validation/artifacts.js";
import { getArtifactsDir, getRootDir } from "./args.js";

export async function cmdValidate(argv: string[]): Promise<void> {
  const artifactsDir = getArtifactsDir(argv);
  const root = getRootDir(argv);
  const bundle = await loadArtifactBundle(artifactsDir);
  const sessionIntent = await loadSessionIntent(root);
  const issues = validateArtifactBundle(bundle);

  console.log(
    JSON.stringify(
      {
        artifacts_dir: artifactsDir,
        session_config_path: join(root, ...SESSION_INTENT_RELATIVE_PATH.split("/")),
        session_config_present: sessionIntent.status === "configured",
        session_intent: sessionIntent.intent,
        artifact_issue_count: issues.length,
        session_config_issue_count: 0,
        issue_count: issues.length,
        issues,
      },
      null,
      2,
    ),
  );

  process.exitCode = issues.some((issue) => issue.severity === "error") ? 1 : 0;
}
