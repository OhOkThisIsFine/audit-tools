// sites-pinned: tests/remediate/friction-capture-closeout.test.ts
import { dirname, join } from "node:path";
import type { RemediationState } from "../state/store.js";
import { stateRunId } from "../state/runIdentity.js";
import { writeCurrentStep } from "./stepWriter.js";
import type { RemediationStep } from "./types.js";

/** Present target outcomes independently of audit-tools development reflection. */
export async function presentReportStep(
  root: string,
  artifactsDir: string,
  state: RemediationState | null,
): Promise<RemediationStep> {
  const reportPath = join(dirname(artifactsDir), "remediation-report.md");
  return writeCurrentStep({
    stepKind: "present_report",
    status: "complete",
    runId: stateRunId(state),
    repoRoot: root,
    artifactsDir,
    prompt: `# Present Remediation Report\n\nRead \`${reportPath}\` and summarize the remediation outcome.\nMention resolved, ignored, and deemed-inappropriate counts plus the closing action.`,
    allowedCommands: [],
    stopCondition: "Present the remediation report summary and stop.",
    artifactPaths: { final_report: reportPath },
  });
}
