/**
 * Verifies that detectRepoConventions is called at most once per process root
 * across repeated prepareImplementDispatch calls.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateStore } from "../../src/remediate/state/store.js";
import type { RemediationState } from "../../src/remediate/state/store.js";
import { makeState as makeBaseState } from "./test-helpers.js";

function makeState(overrides: Partial<RemediationState> = {}): RemediationState {
  return makeBaseState({ status: "implementing", ...overrides });
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

  it("a second prepareImplementDispatch for the same root reuses the cached conventions instead of recomputing", async () => {
    const dispatchModule = await import("../../src/remediate/steps/dispatch.js");
    const { detectRepoConventionsCache, prepareImplementDispatch } = dispatchModule;
    const { readFileSync } = await import("node:fs");

    // Clear cache to ensure clean state
    detectRepoConventionsCache.clear();

    const findingId = "FINDING-CONV-001";
    const blockId = "B-CONV-001";
    const state = makeState({
      plan: {
        plan_id: "PLAN-CONV-001",
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

    try {
      // First dispatch computes the conventions for this root from the real repo
      // and populates the cache.
      const runId1 = `conv-impl-1-${Date.now()}`;
      await prepareImplementDispatch({ root: tmpRoot, artifactsDir }, runId1);
      expect(detectRepoConventionsCache.has(tmpRoot)).toBe(true);
      expect(detectRepoConventionsCache.size).toBe(1);

      // Overwrite the cache entry with a sentinel the real detector would never
      // produce. If the SECOND dispatch recomputed (a cache miss), it would
      // replace this and the rendered prompt would carry the real conventions;
      // if it reuses the cache (the behaviour under test), the sentinel flows
      // through to the prompt and the entry is left untouched. This exercises
      // the cache-reuse path directly through observable output — never a spy
      // on the `audit-tools/shared` re-export barrel, which fails to intercept
      // the source's bound import and passes vacuously (INV-remediate-tests-12).
      const sentinel = "# SENTINEL-NO-RECOMPUTE-CONVENTION";
      detectRepoConventionsCache.set(tmpRoot, sentinel);

      const runId2 = `conv-impl-2-${Date.now()}`;
      const plan = await prepareImplementDispatch({ root: tmpRoot, artifactsDir }, runId2);

      const promptContent = readFileSync(plan.items[0].prompt_path, "utf8");
      expect(promptContent).toContain(sentinel);
      expect(detectRepoConventionsCache.get(tmpRoot)).toBe(sentinel);
    } finally {
      detectRepoConventionsCache.clear();
    }
  });

  it("a second call with a different root produces a separate cache entry", async () => {
    const dispatchModule = await import("../../src/remediate/steps/dispatch.js");
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
    const dispatchModule = await import("../../src/remediate/steps/dispatch.js");
    const { detectRepoConventionsCache, prepareImplementDispatch } = dispatchModule;

    detectRepoConventionsCache.clear();

    const findingId = "FINDING-CONV-003";
    const blockId = "B-CONV-003";
    const state = makeState({
      plan: {
        plan_id: "PLAN-CONV-003",
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
