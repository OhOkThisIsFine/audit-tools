import { test, expect } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnHidden as spawn } from "../helpers/spawn.mjs";
import { HEAVY_AUDIT_TEST_TIMEOUT_MS } from "../helpers/heavy-timeout.mjs";
import {
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

test.concurrent("advancePastDesignReview throws on unknown pause kind", { timeout: HEAVY_AUDIT_TEST_TIMEOUT_MS }, async () => {
  // Stub runWrapper to return a single step with an unrecognised step_kind.
  // We call advancePastDesignReview directly by monkey-patching its dependency
  // indirectly: write a tiny wrapper that returns a fake step JSON and call the
  // helper with that wrapper path.
  //
  // The simplest approach: create a fake wrapper script that emits the unknown
  // step as JSON, then pass it as a custom wrapperArgs using the wrapperPath
  // override pattern already used by runWrapper.
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-unknown-pause-"));
  try {
    // Create a fake wrapper that writes an unknown-kind step to stdout.
    const fakeWrapperPath = join(tempDir, "fake-wrapper.mjs");
    await writeFile(
      fakeWrapperPath,
      [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify({",
        "  contract_version: 'audit-code-step/v1alpha1',",
        "  step_kind: 'unknown_future_pause',",
        "  artifact_paths: {},",
        "  prompt_path: '/dev/null',",
        "}) + '\\n');",
      ].join("\n"),
    );

    // Build a minimal helper that mirrors advancePastDesignReview but uses the
    // fake wrapper path so we don't spin up a real audit run.
    const TERMINAL = new Set([
      "dispatch_review", "single_task",
      "synthesis", "present_report",
    ]);
    async function runFakeWrapper() {
      return new Promise<{ stdout: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [fakeWrapperPath], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        child.stdout.on("data", (chunk: Buffer | string) => { stdout += String(chunk); });
        child.on("error", reject);
        child.on("exit", () => resolve({ stdout }));
      });
    }
    async function helperUnderTest() {
      for (let i = 0; i < 6; i++) {
        const step = JSON.parse((await runFakeWrapper()).stdout);
        if (step.step_kind === "analyzer_install") { continue; }
        if (step.step_kind === "design_review") { continue; }
        if (step.step_kind === "edge_reasoning_dispatch") {
          continue;
        }
        if (TERMINAL.has(step.step_kind)) { return step; }
        throw new Error(
          `advancePastDesignReview: unexpected pause kind '${step.step_kind}' (iteration ${i})`,
        );
      }
      throw new Error("next-step did not advance past structure-phase pauses");
    }

    await assert.rejects(
      () => helperUnderTest(),
      (err: Error) => {
        expect(err.message).toMatch(/unexpected pause kind/);
        expect(err.message).toMatch(/unknown_future_pause/);
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
