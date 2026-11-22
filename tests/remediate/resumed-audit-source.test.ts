import { expect, test, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildAuditFindingsDeliverable } from "audit-tools/shared";
import { readPlanSource } from "../../src/remediate/contractPipeline/executionPlan.js";
import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
import { createNextStepHarness } from "./helpers/nextStepHarness.js";

const harness = createNextStepHarness(".test-resumed-audit-source");
beforeEach(harness.resetTestRepo);
afterEach(harness.cleanupTestRepo);

test.each([
  JSON.stringify(buildAuditFindingsDeliverable([], null)),
  "{",
])("resumed structured audit refuses retired or malformed bytes before it seeds planning (%s)", async raw => {
  const path = join(harness.REPO_DIR, "saved-input.json");
  await writeFile(path, raw, "utf8");
  // Pre-existing manifest and ready summary bypass interactive input discovery.
  await harness.writeReadyStructuredAuditIntake(path);

  const step = await decideNextStep({ root: harness.REPO_DIR });
  expect(step).toMatchObject({ step_kind: "collect_starting_point", status: "blocked" });
  expect(step.allowed_commands.some(command => command.includes("--input"))).toBe(true);
  expect(await readPlanSource(harness.ARTIFACTS_DIR)).toBeUndefined();
  expect(existsSync(join(harness.ARTIFACTS_DIR, "review_request.json"))).toBe(false);
  expect(await readFile(path, "utf8")).toBe(raw);
});
