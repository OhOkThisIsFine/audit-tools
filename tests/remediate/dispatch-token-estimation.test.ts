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
        findings: [
          {
            id: findingId,
            title: "Impl token test",
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
            depends_on: [],
          },
        ],
        themes: [],
      },
      items: {
        [findingId]: {
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
});
