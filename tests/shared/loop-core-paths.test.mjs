import { describe, it, expect } from "vitest";
import { LOOP_CORE_PATTERNS, isLoopCorePath } from "../../src/shared/index.ts";

describe("loopCorePaths — the single-sourced loop-core path set", () => {
  it("matches dispatch/quota/rolling/engine shared substrate (dir prefixes)", () => {
    expect(isLoopCorePath("src/shared/dispatch/admissionLoop.ts")).toBe(true);
    expect(isLoopCorePath("src/shared/quota/scheduler.ts")).toBe(true);
    expect(isLoopCorePath("src/shared/rolling/pausedState.ts")).toBe(true);
    expect(isLoopCorePath("src/shared/engine/obligationEngine.ts")).toBe(true);
  });

  it("matches audit + remediate orchestrator step machines and drivers", () => {
    expect(isLoopCorePath("src/audit/orchestrator/nextStep.ts")).toBe(true);
    expect(isLoopCorePath("src/audit/cli/dispatch.ts")).toBe(true);
    expect(isLoopCorePath("src/audit/cli/dispatch/packetPrompt.ts")).toBe(true);
    expect(isLoopCorePath("src/audit/cli/rollingAuditDispatch.ts")).toBe(true);
    expect(isLoopCorePath("src/remediate/steps/nextStep.ts")).toBe(true);
    expect(isLoopCorePath("src/remediate/steps/dispatch/acceptNode.ts")).toBe(true);
    expect(isLoopCorePath("src/remediate/steps/rollingSession.ts")).toBe(true);
    expect(isLoopCorePath("src/remediate/steps/contractPipeline.ts")).toBe(true);
    expect(isLoopCorePath("src/remediate/riskSignal.ts")).toBe(true);
  });

  it("normalizes win32 backslashes and a leading ./", () => {
    expect(isLoopCorePath("src\\shared\\quota\\state.ts")).toBe(true);
    expect(isLoopCorePath("./src/shared/dispatch/coordinator.ts")).toBe(true);
  });

  it("does NOT match ordinary non-loop-core source, tests, or docs", () => {
    expect(isLoopCorePath("src/shared/io/jsonIo.ts")).toBe(false);
    expect(isLoopCorePath("src/audit/reporting/scoreTokens.ts")).toBe(false);
    expect(isLoopCorePath("src/remediate/intake.ts")).toBe(false);
    expect(isLoopCorePath("docs/backlog.md")).toBe(false);
    expect(isLoopCorePath("tests/shared/loop-core-paths.test.mjs")).toBe(false);
    // A file that merely shares a prefix segment but is not under the dir.
    expect(isLoopCorePath("src/remediate/steps/nextStepHelpers.ts")).toBe(false);
  });

  it("exposes a non-empty, path-sorted, de-duplicated canonical pattern list", () => {
    expect(LOOP_CORE_PATTERNS.length).toBeGreaterThan(0);
    const arr = [...LOOP_CORE_PATTERNS];
    expect(arr).toEqual([...new Set(arr)]);
    expect(arr).toEqual([...arr].sort());
  });
});
