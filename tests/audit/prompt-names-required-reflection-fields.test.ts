import { test, expect } from "vitest";
import { join } from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { AgentReflectionSchema, AGENT_FEEDBACK_FILENAME, parseReflectionsNdjson } from "../../src/shared/agentReflections.js";
import { writeCurrentStep, AGENT_FEEDBACK_ARTIFACT_KEY } from "../../src/audit/cli/steps.js";
import { functionalPreflightStep, functionalPreflightPath } from "../../src/audit/cli/functionalPreflight.js";
import { satisfyFunctionalPreflight } from "../helpers/functionalPreflightFixture.js";

// Preflight no longer asks the loader/host to hand-author a reflection. The
// production consumer writes it mechanically from validated capability evidence.
// Pin the original silent-loss defect at its current owner and actual path.
test("approved degraded preflight writes a complete reflection to the emitted step's feedback destination", async () => {
  const artifactsDir = await mkdtemp(join(tmpdir(), "audit-preflight-reflection-"));
  try {
    const plan = await functionalPreflightStep(artifactsDir, artifactsDir);
    expect(plan).toBeDefined();
    const step = await writeCurrentStep(plan!);
    await satisfyFunctionalPreflight(artifactsDir, artifactsDir);
    const path = functionalPreflightPath(artifactsDir);
    const report = JSON.parse(await readFile(path, "utf8"));
    report.relationship_inspection = { available: false, evidence: "Fixture relationship inspection is unavailable." };
    report.decision = "degraded";
    report.operator_approved_degraded = true;
    report.limitation = "Operator approved source-only review without relationship inspection.";
    await writeFile(path, JSON.stringify(report));
    expect(await functionalPreflightStep(artifactsDir, artifactsDir)).toBeUndefined();
    const feedbackPath = step.artifact_paths[AGENT_FEEDBACK_ARTIFACT_KEY];
    expect(typeof feedbackPath).toBe("string");
    const text = await readFile(feedbackPath!, "utf8");
    const raw = JSON.parse(text.trim());
    expect(AgentReflectionSchema.safeParse(raw).success).toBe(true);
    for (const [field, schema] of Object.entries(AgentReflectionSchema.shape)) {
      if (!schema.isOptional()) expect(raw).toHaveProperty(field);
    }
    const parsed = parseReflectionsNdjson(text);
    expect(parsed.reflections).toHaveLength(1);
    expect(parsed.reflections[0]).toMatchObject({ task_id: "audit-capability-preflight", severity: "high" });
  } finally {
    await rm(artifactsDir, { recursive: true, force: true });
  }
});

test("every emitted audit step carries the reflection path on the contract", async () => {
  const artifactsDir = await mkdtemp(join(tmpdir(), "audit-step-reflection-"));
  try {
    const step = await writeCurrentStep({
      artifactsDir,
      stepKind: "dispatch_review",
      status: "ready",
      runId: null,
      allowedCommands: [],
      stopCondition: "stop",
      repoRoot: artifactsDir,
      artifactPaths: { artifact_paths: "caller-value" },
      prompt: "do the work",
    });
    const emitted = step.artifact_paths[AGENT_FEEDBACK_ARTIFACT_KEY];
    expect(
      typeof emitted === "string" && emitted.endsWith(AGENT_FEEDBACK_FILENAME),
      `every audit step must carry artifact_paths.${AGENT_FEEDBACK_ARTIFACT_KEY} pointing at ` +
        `${AGENT_FEEDBACK_FILENAME} — a step without it makes the destination a guess again`,
    ).toBe(true);
    // It resolves inside the run's artifacts dir, and survives the writer's
    // forward-slash path normalization (so a host can use it as given).
    expect(emitted?.replace(/\\/g, "/")).toContain(
      `${artifactsDir.replace(/\\/g, "/")}/${AGENT_FEEDBACK_FILENAME}`,
    );
  } finally {
    await rm(artifactsDir, { recursive: true, force: true });
  }
});
