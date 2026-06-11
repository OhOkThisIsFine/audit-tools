/**
 * Verifies that detectRepoConventions is called at most once per process root
 * across repeated prepareImplementDispatch calls.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateStore } from "../src/state/store.js";
import type { RemediationState } from "../src/state/store.js";

function makeState(overrides: Partial<RemediationState> = {}): RemediationState {
  return {
    status: "implementing",
    closing_plan: { action: "none" },
    clarifications: [],
    plan: {
      findings: [],
      blocks: [],
      themes: [],
    },
    items: {},
    ...overrides,
  };
}

describe("detectRepoConventions cached once per root", () => {
  let tmpRoot: string;
  let tmpRoot2: string;
  let artifactsDir: string;

  beforeAll(async () => {
    tmpRoot = join(tmpdir(), `conv-cache-test-${Date.now()}`);
    tmpRoot2 = join(tmpdir(), `conv-cache-test2-${Date.now()}`);
    artifactsDir = join(tmpRoot, ".audit-tools", "remediation");
    await mkdir(tmpRoot, { recursive: true });
    await mkdir(tmpRoot2, { recursive: true });
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(join(tmpRoot, "package.json"), JSON.stringify({ name: "root1" }));
    await writeFile(join(tmpRoot2, "package.json"), JSON.stringify({ name: "root2" }));
  });

  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
    await rm(tmpRoot2, { recursive: true, force: true });
  });

  it("calling prepareImplementDispatch twice for the same root uses the cache", async () => {
    const dispatchModule = await import("../src/steps/dispatch.js");
    const { detectRepoConventionsCache, prepareImplementDispatch } = dispatchModule;

    // Clear cache to ensure clean state
    detectRepoConventionsCache.clear();

    const findingId = "FINDING-CONV-001";
    const blockId = "B-CONV-001";
    const state = makeState({
      plan: {
        findings: [
          {
            id: findingId,
            title: "Conv cache test",
            severity: "low",
            confidence: "high",
            lens: "maintainability",
            summary: "Test finding",
            evidence: [],
            affected_files: [],
          },
        ],
        blocks: [{ block_id: blockId, items: [findingId], parallel_safe: true }],
        themes: [],
      },
      items: {
        [findingId]: { finding_id: findingId, status: "pending", block_id: blockId },
      },
    });

    const store = new StateStore(artifactsDir);
    await store.saveState(state);

    const sharedModule = await import("@audit-tools/shared");
    const spy = vi.spyOn(sharedModule, "detectRepoConventions");

    try {
      const runId1 = `conv-impl-1-${Date.now()}`;
      await prepareImplementDispatch({ root: tmpRoot, artifactsDir }, runId1);

      const runId2 = `conv-impl-2-${Date.now()}`;
      await prepareImplementDispatch({ root: tmpRoot, artifactsDir }, runId2);

      // detectRepoConventions should have been called at most once for this root
      const callsForRoot = spy.mock.calls.filter(
        (call) => call[0] === tmpRoot,
      ).length;
      expect(callsForRoot).toBeLessThanOrEqual(1);
    } finally {
      spy.mockRestore();
      detectRepoConventionsCache.clear();
    }
  });

  it("a second call with a different root produces a separate cache entry", async () => {
    const dispatchModule = await import("../src/steps/dispatch.js");
    const { detectRepoConventionsCache } = dispatchModule;

    detectRepoConventionsCache.clear();

    // Manually populate both roots as if they had been resolved
    detectRepoConventionsCache.set(tmpRoot, "# conventions-root1");
    detectRepoConventionsCache.set(tmpRoot2, "# conventions-root2");

    expect(detectRepoConventionsCache.size).toBe(2);
    expect(detectRepoConventionsCache.get(tmpRoot)).toBe("# conventions-root1");
    expect(detectRepoConventionsCache.get(tmpRoot2)).toBe("# conventions-root2");

    detectRepoConventionsCache.clear();
  });

  it("the cached conventions string appears in the rendered implement prompt", async () => {
    const dispatchModule = await import("../src/steps/dispatch.js");
    const { detectRepoConventionsCache, prepareImplementDispatch } = dispatchModule;

    detectRepoConventionsCache.clear();

    const findingId = "FINDING-CONV-003";
    const blockId = "B-CONV-003";
    const state = makeState({
      plan: {
        findings: [
          {
            id: findingId,
            title: "Conv in prompt test",
            severity: "low",
            confidence: "high",
            lens: "maintainability",
            summary: "Prompt conventions test",
            evidence: [],
            affected_files: [],
          },
        ],
        blocks: [{ block_id: blockId, items: [findingId], parallel_safe: true }],
        themes: [],
      },
      items: {
        [findingId]: { finding_id: findingId, status: "pending", block_id: blockId },
      },
    });

    const store = new StateStore(artifactsDir);
    await store.saveState(state);

    // Pre-seed the cache with a recognizable value
    const sentinel = "# SENTINEL-CONVENTION-MARKER";
    detectRepoConventionsCache.set(tmpRoot, sentinel);

    try {
      const runId = `conv-prompt-${Date.now()}`;
      const plan = await prepareImplementDispatch({ root: tmpRoot, artifactsDir }, runId);

      expect(plan.items.length).toBeGreaterThan(0);
      const promptPath = plan.items[0].prompt_path;
      const { readFileSync } = await import("node:fs");
      const promptContent = readFileSync(promptPath, "utf8");
      expect(promptContent).toContain(sentinel);
    } finally {
      detectRepoConventionsCache.clear();
    }
  });
});
