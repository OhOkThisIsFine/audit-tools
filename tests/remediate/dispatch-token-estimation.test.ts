/**
 * Byte-based token estimation tests for prepareImplementDispatch.
 *
 * The flat constants previously used were ESTIMATED_ITEM_OVERHEAD_TOKENS = 600 and
 * ESTIMATED_PROMPT_OVERHEAD_TOKENS = 900. With byte-based estimation, a 4000-byte
 * file yields estimateTokensFromBytes(4000) = 1000 tokens PLUS 2000 overhead = 3000.
 * This is significantly larger than the old flat constants.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  prepareImplementDispatch,
} from "../../src/remediate/steps/dispatch.js";
import { StateStore } from "../../src/remediate/state/store.js";
import type { RemediationState } from "../../src/remediate/state/store.js";
import { BYTES_PER_TOKEN } from "audit-tools/shared";
import { makeState as makeBaseState } from "./test-helpers.js";

function makeState(overrides: Partial<RemediationState> = {}): RemediationState {
  return makeBaseState({ status: "implementing", ...overrides });
}

describe("byte-based token estimation — implement dispatch", () => {
  let tmpRoot: string;
  let artifactsDir: string;

  beforeAll(async () => {
    tmpRoot = join(tmpdir(), `dispatch-token-est-impl-${Date.now()}`);
    artifactsDir = join(tmpRoot, ".audit-tools", "remediation");
    await mkdir(tmpRoot, { recursive: true });
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(join(tmpRoot, "package.json"), JSON.stringify({ name: "test-repo" }));
  });

  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("derives implement slot estimate from readFiles byte sizes", async () => {
    const srcDir = join(tmpRoot, "src");
    await mkdir(srcDir, { recursive: true });
    const srcFile = join(srcDir, "impl.ts");
    await writeFile(srcFile, "y".repeat(8000));

    const findingId = "FINDING-TOK-003";
    const blockId = "BLOCK-TOK-001";
    const state = makeState({
      status: "implementing",
      plan: {
        // INV-RSM-STATE-COMPLETE: an implementing state persists plan identity.
        plan_id: "PLAN-TOK-IMPL",
        findings: [
          {
            id: findingId,
            title: "Impl token test",
            category: "maintainability",
            severity: "medium",
            confidence: "high",
            lens: "maintainability",
            summary: "Test finding",
            evidence: [],
            affected_files: [{ path: "src/impl.ts" }],
          },
        ],
        blocks: [
          {
            block_id: blockId,
            items: [findingId],
            parallel_safe: true,
            touched_files: [],
            dependencies: [],
          },
        ],
        themes: [],
        project_type: "unknown",
        candidate_closing_actions: [],
      },
      items: {
        [findingId]: {
          finding_id: findingId,
          block_id: blockId,
          status: "pending",
          item_spec: {
            finding_id: findingId,
            concrete_change: "Fix something",
            no_change: false,
            touched_files: ["src/impl.ts"],
            tests_to_write: [],
            not_applicable_steps: [],
          },
        },
      },
    });

    const store = new StateStore(artifactsDir);
    await store.saveState(state);

    const runId = `tok-impl-${Date.now()}`;
    await prepareImplementDispatch({ root: tmpRoot, artifactsDir }, runId);

    const { readJsonFile } = await import("audit-tools/shared");
    const quota = await readJsonFile<{ estimated_wave_tokens: number }>(
      join(artifactsDir, "runs", runId, "implement", "dispatch-quota.json"),
    );

    // 8000 bytes / 4 = 2000 tokens + 2000 overhead = 4000 total.
    // Old flat constant was 900. Our estimate should be >> 900.
    expect(quota.estimated_wave_tokens).toBeGreaterThan(900);
    expect(quota.estimated_wave_tokens).toBeGreaterThanOrEqual(
      Math.ceil(8000 / BYTES_PER_TOKEN),
    );
  });

  it("stamps a per-node estimate on the plan item that SCALES with the node", async () => {
    // The two fit gates (the hybrid frontier and the in-process engine) sized every
    // node at a flat 2000, so they could not tell a large node from a small one.
    // The real number already existed here — it fed `scheduleWave` and never left
    // the function. Persisting it on the item is what lets both gates read the ONE
    // number rather than deriving a second one. [[honest-estimate-needs-resumable-refusal]]
    const srcDir = join(tmpRoot, "scaled");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(srcDir, "small.ts"), "s".repeat(200));
    await writeFile(join(srcDir, "big.ts"), "b".repeat(120_000));

    const mk = (n: string, path: string) => ({
      id: `F-SCALE-${n}`,
      title: `Scale ${n}`,
      category: "maintainability",
      severity: "medium" as const,
      confidence: "high" as const,
      lens: "maintainability",
      summary: "Test finding",
      evidence: [] as string[],
      affected_files: [{ path }],
    });
    const state = makeState({
      plan: {
        plan_id: "PLAN-SCALE",
        findings: [mk("S", "scaled/small.ts"), mk("B", "scaled/big.ts")],
        blocks: [
          { block_id: "B-SMALL", items: ["F-SCALE-S"], parallel_safe: true, touched_files: ["scaled/small.ts"], dependencies: [] },
          { block_id: "B-BIG", items: ["F-SCALE-B"], parallel_safe: true, touched_files: ["scaled/big.ts"], dependencies: [] },
        ],
        themes: [],
        project_type: "unknown",
        candidate_closing_actions: [],
      },
      items: {
        "F-SCALE-S": {
          finding_id: "F-SCALE-S", block_id: "B-SMALL", status: "pending",
          item_spec: { finding_id: "F-SCALE-S", concrete_change: "x", no_change: false, touched_files: ["scaled/small.ts"], tests_to_write: [], not_applicable_steps: [] },
        },
        "F-SCALE-B": {
          finding_id: "F-SCALE-B", block_id: "B-BIG", status: "pending",
          item_spec: { finding_id: "F-SCALE-B", concrete_change: "y", no_change: false, touched_files: ["scaled/big.ts"], tests_to_write: [], not_applicable_steps: [] },
        },
      },
    });

    await new StateStore(artifactsDir).saveState(state);
    const plan = await prepareImplementDispatch(
      { root: tmpRoot, artifactsDir },
      `tok-scale-${Date.now()}`,
    );

    const small = plan.items.find((i) => i.block_id === "B-SMALL");
    const big = plan.items.find((i) => i.block_id === "B-BIG");
    expect(small?.estimated_input_tokens).toBeGreaterThan(0);
    expect(big?.estimated_input_tokens).toBeGreaterThan(0);
    // The whole point: a 120KB node must not be sized the same as a 200-byte one.
    expect(big!.estimated_input_tokens).toBeGreaterThan(
      small!.estimated_input_tokens * 2,
    );
    expect(big!.estimated_input_tokens).toBeGreaterThanOrEqual(
      Math.ceil(120_000 / BYTES_PER_TOKEN),
    );
  });
});
