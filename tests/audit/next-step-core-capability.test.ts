import { test, expect } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HEAVY_AUDIT_TEST_TIMEOUT_MS } from "../helpers/heavy-timeout.mjs";
import { walkStepsUntilTerminal } from "./helpers/step-driver.js";
import {
  ADVANCE_PAST_DESIGN_REVIEW_TERMINAL_KINDS,
  advancePastDesignReview,
  withTempRepo,
} from "./helpers/next-step-harness.js";

test.concurrent("next-step true emits dispatch_review and prepares dispatch artifacts", { timeout: HEAVY_AUDIT_TEST_TIMEOUT_MS }, async () => {
  await withTempRepo(async (root) => {
    const step = await advancePastDesignReview(
      root,
      [
        "next-step",
        "--auditor",
        '{"self":{"can_dispatch_subagents":true,"context_tokens":200000,"output_tokens":8000}}',
      ],
    );
    const plan = JSON.parse(await readFile(step.artifact_paths.dispatch_plan, "utf8"));
    const prompt = await readFile(step.prompt_path, "utf8");

    expect(step.step_kind).toBe("dispatch_review");
    expect(Array.isArray(plan)).toBe(true);
    expect(plan.length > 0).toBeTruthy();
    expect(prompt).toMatch(/Launch one subagent for each entry in the plan/);
    expect(prompt).not.toMatch(/admission\.granted_packet_ids/);
    expect(prompt).toMatch(/merge-and-ingest/);
    expect(prompt).not.toMatch(/single-task fallback/i);
  });
});

test.concurrent("next-step with can_dispatch_subagents:false still materializes the dispatch step (no capability branch)", { timeout: HEAVY_AUDIT_TEST_TIMEOUT_MS }, async () => {
  await withTempRepo(async (root) => {
    const step = await advancePastDesignReview(
      root,
      [
        "next-step",
        "--auditor",
        '{"self":{"can_dispatch_subagents":false,"context_tokens":200000,"output_tokens":8000}}',
      ],
    );
    const prompt = await readFile(step.prompt_path, "utf8");

    // Always-materialized fan-out (design resolution 2): identical artifacts on
    // every host — the capability-neutral prompt covers sequential self-execution.
    expect(step.step_kind).toBe("dispatch_review");
    const plan = JSON.parse(await readFile(step.artifact_paths.dispatch_plan, "utf8"));
    expect(Array.isArray(plan) && plan.length > 0).toBeTruthy();
    expect(prompt).toMatch(/sequentially yourself/);
  });
});

// This previously asserted against a hand-copied REPLICA of the walker declared
// inside the test body, so it passed regardless of what the real helper did —
// the production code could have been deleted outright and it would still have
// been green. The shared driver takes its transport as a parameter, so the
// unknown-kind case can now be driven against the REAL code with a stub
// transport, which is what this exercises.
test.concurrent("the step driver throws on an unknown step kind rather than returning it", { timeout: HEAVY_AUDIT_TEST_TIMEOUT_MS }, async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-unknown-pause-"));
  try {
    let calls = 0;
    await assert.rejects(
      () =>
        walkStepsUntilTerminal({
          root: tempDir,
          transport: async () => {
            calls++;
            return {
              contract_version: "audit-code-step/v1alpha1",
              step_kind: "unknown_future_pause",
              artifact_paths: {},
              prompt_path: "/dev/null",
            };
          },
          terminalKinds: ADVANCE_PAST_DESIGN_REVIEW_TERMINAL_KINDS,
          label: "advancePastDesignReview",
        }),
      (err: Error) => {
        expect(err.message).toMatch(/unexpected step kind/);
        expect(err.message).toMatch(/unknown_future_pause/);
        expect(err.message).toMatch(/advancePastDesignReview/);
        return true;
      },
    );
    // It must fail FAST on an unrecognised kind, not burn the whole pause budget.
    expect(calls).toBe(1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
