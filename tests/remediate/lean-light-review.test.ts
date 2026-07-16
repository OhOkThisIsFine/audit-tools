// T1 slice 3b — the lean fast path is no longer a zero-scrutiny fork.
//
// An eligible run now runs ONE bounded LIGHT adversarial review over the
// approved findings before the lean plan is trusted (the floor, never off). A
// clear verdict proceeds to the lean plan; an escalate verdict raises the risk
// signal (evidence the work is harder than assessed) and routes to the full
// contract pipeline. Covers the pure verdict interpreter + the gate's
// emit → clear / escalate state machine through decideNextStep.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
import {
  interpretLeanLightReviewVerdict,
  LEAN_LIGHT_REVIEW_SCHEMA_VERSION,
  readIntakeRiskSignal,
} from "../../src/remediate/riskSignal.js";
import { createNextStepHarness } from "./helpers/nextStepHarness.js";

const FAST_PATH_FIXTURE = fileURLToPath(
  new URL("./fixtures/audit-findings-fast-path-eligible.json", import.meta.url),
);

describe("interpretLeanLightReviewVerdict (fail-safe toward escalation)", () => {
  it("clear disposition clears with no concerns", () => {
    expect(
      interpretLeanLightReviewVerdict({
        schema_version: LEAN_LIGHT_REVIEW_SCHEMA_VERSION,
        disposition: "clear",
      }),
    ).toEqual({
      disposition: "clear",
      concerns: [],
    });
  });

  it("escalate carries the stated concerns", () => {
    expect(
      interpretLeanLightReviewVerdict({
        schema_version: LEAN_LIGHT_REVIEW_SCHEMA_VERSION,
        disposition: "escalate",
        concerns: ["FIX-1 breaks a caller"],
      }),
    ).toEqual({ disposition: "escalate", concerns: ["FIX-1 breaks a caller"] });
  });

  it("escalate with no concern is still an escalation (with a synthesized reason)", () => {
    const r = interpretLeanLightReviewVerdict({
      schema_version: LEAN_LIGHT_REVIEW_SCHEMA_VERSION,
      disposition: "escalate",
    });
    expect(r.disposition).toBe("escalate");
    expect(r.concerns.length).toBeGreaterThan(0);
  });

  it("a verdict missing/with a wrong schema_version fails safe to escalate", () => {
    expect(
      interpretLeanLightReviewVerdict({ disposition: "clear" }).disposition,
    ).toBe("escalate");
    expect(
      interpretLeanLightReviewVerdict({
        schema_version: "wrong/v9",
        disposition: "clear",
      }).disposition,
    ).toBe("escalate");
  });

  it("a malformed / non-object verdict fails safe to escalate", () => {
    expect(interpretLeanLightReviewVerdict(null).disposition).toBe("escalate");
    expect(interpretLeanLightReviewVerdict("nope").disposition).toBe("escalate");
  });

  it("a missing / unknown disposition fails safe to escalate", () => {
    expect(interpretLeanLightReviewVerdict({}).disposition).toBe("escalate");
    expect(
      interpretLeanLightReviewVerdict({ disposition: "maybe" }).disposition,
    ).toBe("escalate");
  });
});

describe("lean light-review gate — state machine through decideNextStep", () => {
  const harness = createNextStepHarness(".test-lean-light-review");
  const { REPO_DIR, ARTIFACTS_DIR, writeReadyStructuredAuditIntake, approveReviewGate } =
    harness;

  const verdictPath = join(ARTIFACTS_DIR, "lean_light_review_verdict.json");
  const decisionPath = join(ARTIFACTS_DIR, "lean_light_review_decision.json");
  const extractedPlanPath = join(ARTIFACTS_DIR, "extracted-plan.json");

  // Drive the proven fast-path-eligible fixture (FP-001/FP-002: grounded,
  // high-confidence, localized) up to the lean light-review step.
  async function reachLightReviewStep() {
    await writeReadyStructuredAuditIntake(FAST_PATH_FIXTURE);
    await approveReviewGate();
    await harness.acknowledgeResume();
    return decideNextStep({ root: REPO_DIR }); // → lean light-review step
  }

  let prevRollingEngine: string | undefined;
  beforeEach(async () => {
    await harness.resetTestRepo();
    prevRollingEngine = process.env.REMEDIATE_ROLLING_ENGINE;
    process.env.REMEDIATE_ROLLING_ENGINE = "false";
  });
  afterEach(async () => {
    await harness.cleanupTestRepo();
    if (prevRollingEngine === undefined) delete process.env.REMEDIATE_ROLLING_ENGINE;
    else process.env.REMEDIATE_ROLLING_ENGINE = prevRollingEngine;
  });

  it("an eligible run emits a lean_light_review step (NOT a direct lean plan)", async () => {
    const step = await reachLightReviewStep();

    expect(step.step_kind).toBe("lean_light_review");
    expect(step.artifact_paths.lean_light_review_verdict).toMatch(
      /lean_light_review_verdict\.json$/,
    );
    // The floor: no lean plan is written until the review clears.
    expect(existsSync(extractedPlanPath)).toBe(false);
    // The prompt presents the findings for the adversarial pass.
    const prompt = await readFile(step.prompt_path, "utf8");
    expect(prompt).toContain("FP-001");
    expect(prompt).toContain("FP-002");
    expect(prompt).toMatch(/light adversarial review/i);
  });

  it("a CLEAR verdict proceeds to the lean plan", async () => {
    await reachLightReviewStep();

    await writeFile(
      verdictPath,
      JSON.stringify({
        schema_version: "remediate-code-lean-light-review/v1alpha1",
        disposition: "clear",
        created_at: new Date().toISOString(),
      }),
      "utf8",
    );
    const step = await decideNextStep({ root: REPO_DIR });

    expect(step.step_kind).not.toBe("lean_light_review");
    expect(step.step_kind).not.toBe("contract_pipeline");
    // The lean plan is written and tagged as the fast-path source.
    const plan = JSON.parse(await readFile(extractedPlanPath, "utf8"));
    expect(plan.source).toBe("lean_fast_path");
    // A durable decision is recorded and the verdict archived (no re-emit).
    const decision = JSON.parse(await readFile(decisionPath, "utf8"));
    expect(decision.disposition).toBe("clear");
    expect(existsSync(verdictPath)).toBe(false);
  });

  it("an ESCALATE verdict raises the risk signal and routes to the full pipeline", async () => {
    await reachLightReviewStep();

    await writeFile(
      verdictPath,
      JSON.stringify({
        schema_version: "remediate-code-lean-light-review/v1alpha1",
        disposition: "escalate",
        concerns: ["FIX-1 and FIX-2 actually share a helper — not independent"],
        created_at: new Date().toISOString(),
      }),
      "utf8",
    );
    const step = await decideNextStep({ root: REPO_DIR });

    // Routed to the full contract pipeline; no lean plan written.
    expect(step.step_kind).toBe("contract_pipeline");
    expect(existsSync(extractedPlanPath)).toBe(false);
    // The risk signal was escalated (>= medium, so slice-3a depth = full).
    const signal = await readIntakeRiskSignal(ARTIFACTS_DIR);
    expect(signal?.escalated).toBe(true);
    expect(signal?.tier === "medium" || signal?.tier === "high").toBe(true);
    const decision = JSON.parse(await readFile(decisionPath, "utf8"));
    expect(decision.disposition).toBe("escalate");
  });

  it("re-running after a decision does not re-emit the light-review step", async () => {
    await reachLightReviewStep();
    await writeFile(
      verdictPath,
      JSON.stringify({ disposition: "clear" }),
      "utf8",
    );
    await decideNextStep({ root: REPO_DIR }); // consume

    const step = await decideNextStep({ root: REPO_DIR });
    expect(step.step_kind).not.toBe("lean_light_review");
  });
});
