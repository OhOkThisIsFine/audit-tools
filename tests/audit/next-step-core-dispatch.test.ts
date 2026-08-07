import { test, expect } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HEAVY_AUDIT_TEST_TIMEOUT_MS } from "../helpers/heavy-timeout.mjs";
import {
  advancePastDesignReview,
  TEST_AUDITOR_ARGS,
  withTempRepo,
} from "./helpers/next-step-harness.js";

test.concurrent("next-step defaults to dispatch_review when host dispatch capability is not configured", { timeout: HEAVY_AUDIT_TEST_TIMEOUT_MS }, async () => {
  await withTempRepo(async (root) => {
    const step = await advancePastDesignReview(root);
    const currentStep = JSON.parse(
      await readFile(join(root, ".audit-tools/audit", "steps", "current-step.json"), "utf8"),
    );
    const prompt = await readFile(step.prompt_path, "utf8");

    expect(step.step_kind).toBe("dispatch_review");
    expect(currentStep.step_kind).toBe("dispatch_review");
    expect(step.run_id).toBeTruthy();
    expect(prompt).toMatch(/merge-and-ingest/);
    expect(prompt).not.toMatch(/single-task fallback/i);
  });
});

test.concurrent("next-step reads host_can_dispatch_subagents from session-config", { timeout: HEAVY_AUDIT_TEST_TIMEOUT_MS }, async () => {
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      join(artifactsDir, "session-config.json"),
      JSON.stringify(
        {
          host_can_dispatch_subagents: true,
        },
        null,
        2,
      ) + "\n",
    );

    const step = await advancePastDesignReview(root, [
      "next-step",
      "--auditor",
      JSON.stringify({
        self: {
          provider: "worker-command",
          context_tokens: 200_000,
          output_tokens: 8_000,
        },
      }),
    ]);

    expect(step.step_kind).toBe("dispatch_review");
    expect(step.artifact_paths.dispatch_plan).toMatch(/dispatch-plan\.json$/);
  });
});

test.concurrent("next-step reads AUDIT_CODE_HOST_CAN_DISPATCH when no flag or session value is set", { timeout: HEAVY_AUDIT_TEST_TIMEOUT_MS }, async () => {
  await withTempRepo(async (root) => {
    const step = await advancePastDesignReview(
      root,
      ["next-step", ...TEST_AUDITOR_ARGS],
      { env: { AUDIT_CODE_HOST_CAN_DISPATCH: "true" } },
    );

    expect(step.step_kind).toBe("dispatch_review");
  });
});
