import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { callNextStep, withTempRepo } from "./helpers/completion-harness.js";
import { walkStepsUntilTerminal } from "./helpers/step-driver.js";

test("unrelated design review does not load a retired task-advisory carry", async () => {
  await withTempRepo(async root => {
    const artifactsDir = join(root, ".audit-tools", "audit");
    const stepsDir = join(artifactsDir, "steps");
    await mkdir(stepsDir, { recursive: true });
    const carryPath = join(stepsDir, "pending-advisories.json");
    const oldMessage = "synthetic-retired-advisory-must-not-cross-steps";
    const archivedTaskAdvisories = JSON.stringify({
      ingestIssues: [],
      validationWarnings: [{ work_item_id: "retired-fixture-task", message: oldMessage }],
    });
    await writeFile(carryPath, archivedTaskAdvisories);

    const step = await walkStepsUntilTerminal({
      transport: () => callNextStep(root, artifactsDir),
      terminalKinds: new Set(["design_review_parallel", "design_review_contract"]),
      label: "unrelated design review",
    });
    expect(step.status).toBe("ready");
    expect(typeof step.artifact_paths.contract_results).toBe("string");
    const prompt = await readFile(step.artifact_paths.current_prompt, "utf8");
    expect(prompt).not.toContain(oldMessage);
    expect(prompt).not.toContain("## Saved results not accepted");
    expect(await readFile(carryPath, "utf8")).toBe(archivedTaskAdvisories);
  });
});
