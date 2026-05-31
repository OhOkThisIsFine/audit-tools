import { writeFileSync } from "fs";
import { join } from "path";
import { loadArtifactBundle } from "./packages/audit-code/dist/io/artifacts.js";
import { buildPendingAuditTasks } from "./packages/audit-code/dist/cli/dispatch.js";

async function run() {
  const root = "C:\\Code\\audit-tools";
  const artifactsDir = join(root, ".audit-artifacts");
  const runDir = join(artifactsDir, "runs", "run_1");
  const bundle = await loadArtifactBundle(artifactsDir);
  const tasks = buildPendingAuditTasks(bundle);
  writeFileSync(join(runDir, "pending-audit-tasks.json"), JSON.stringify(tasks, null, 2));
  console.log("Created pending-audit-tasks.json");
}
run().catch(console.error);
