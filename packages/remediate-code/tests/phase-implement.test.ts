import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  sortBlocksByDependency,
  executeBlock,
  runImplementPhase,
} from "../src/phases/implement.js";
import type { RemediationBlock } from "../src/state/types.js";

// --- sortBlocksByDependency ---

describe("sortBlocksByDependency", () => {
  it("returns single block unchanged", () => {
    const blocks: RemediationBlock[] = [
      { block_id: "A", items: [], parallel_safe: true },
    ];
    expect(sortBlocksByDependency(blocks).map((b) => b.block_id)).toEqual([
      "A",
    ]);
  });

  it("places dependency before dependent", () => {
    const blocks: RemediationBlock[] = [
      { block_id: "B", items: [], dependencies: ["A"], parallel_safe: false },
      { block_id: "A", items: [], parallel_safe: true },
    ];
    const ids = sortBlocksByDependency(blocks).map((b) => b.block_id);
    expect(ids.indexOf("A")).toBeLessThan(ids.indexOf("B"));
  });

  it("handles a chain A → B → C", () => {
    const blocks: RemediationBlock[] = [
      { block_id: "C", items: [], dependencies: ["B"], parallel_safe: false },
      { block_id: "A", items: [], parallel_safe: true },
      { block_id: "B", items: [], dependencies: ["A"], parallel_safe: false },
    ];
    const ids = sortBlocksByDependency(blocks).map((b) => b.block_id);
    expect(ids).toEqual(["A", "B", "C"]);
  });

  it("throws on circular dependency", () => {
    const blocks: RemediationBlock[] = [
      { block_id: "A", items: [], dependencies: ["B"], parallel_safe: false },
      { block_id: "B", items: [], dependencies: ["A"], parallel_safe: false },
    ];
    expect(() => sortBlocksByDependency(blocks)).toThrow(/Circular dependency/);
  });

  it("handles blocks with no dependencies array", () => {
    const blocks: RemediationBlock[] = [
      { block_id: "X", items: [], parallel_safe: true },
      { block_id: "Y", items: [], parallel_safe: true },
    ];
    const ids = sortBlocksByDependency(blocks).map((b) => b.block_id);
    expect(ids).toContain("X");
    expect(ids).toContain("Y");
  });
});

// --- executeBlock item skipping ---

describe("executeBlock", () => {
  function makeState(items: Record<string, any>) {
    return {
      status: "documenting" as const,
      plan: {
        plan_id: "P1",
        findings: [],
        blocks: [],
        project_type: "typescript-node",
        test_command: undefined,
        candidate_closing_actions: [],
      },
      items,
    };
  }

  it("skips items in terminal statuses without touching provider", async () => {
    const state = makeState({
      F1: { finding_id: "F1", status: "resolved", block_id: "B1" },
      F2: { finding_id: "F2", status: "ignored", block_id: "B1" },
      F3: { finding_id: "F3", status: "blocked", block_id: "B1" },
      F4: { finding_id: "F4", status: "pending", block_id: "B1" },
    });
    const block: RemediationBlock = {
      block_id: "B1",
      items: ["F1", "F2", "F3", "F4"],
      parallel_safe: true,
    };

    let providerCalled = false;
    const fakeProvider = {
      name: "test",
      launch: async () => {
        providerCalled = true;
      },
    };
    const fakeSave = { saveState: async () => {} };

    await executeBlock(block, "/tmp", {
      state: state as any,
      options: { root: "/tmp", artifactsDir: "/tmp/arts" },
      provider: fakeProvider,
      store: fakeSave as any,
    });

    expect(providerCalled).toBe(false);
  });

  it("blocks item when item_spec is missing", async () => {
    const state = makeState({
      F1: { finding_id: "F1", status: "documented", block_id: "B1" },
    });
    const block: RemediationBlock = {
      block_id: "B1",
      items: ["F1"],
      parallel_safe: true,
    };

    const saves: any[] = [];
    const fakeSave = {
      saveState: async (s: any) => {
        saves.push(JSON.parse(JSON.stringify(s)));
      },
    };

    await executeBlock(block, "/tmp", {
      state: state as any,
      options: { root: "/tmp", artifactsDir: "/tmp/arts" },
      provider: { name: "test", launch: async () => {} },
      store: fakeSave as any,
    });

    expect(state.items.F1.status).toBe("blocked");
    expect(state.items.F1.failure_reason).toMatch(/item_spec/);
  });
});

describe("runImplementPhase worktree execution", () => {
  const TEST_DIR = join(__dirname, ".test-implement-worktree");
  const REPO_DIR = join(TEST_DIR, "repo");
  const ARTIFACTS_DIR = join(TEST_DIR, "artifacts");

  function git(args: string[], cwd = REPO_DIR): void {
    execFileSync("git", args, { cwd, stdio: "ignore" });
  }

  it("runs parallel-safe blocks through worktrees and merges block state", async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(REPO_DIR, { recursive: true });
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    try {
      git(["init"]);
      git(["config", "user.email", "test@example.com"]);
      git(["config", "user.name", "Test User"]);
      await writeFile(join(REPO_DIR, "README.md"), "initial", "utf8");
      git(["add", "."]);
      git(["commit", "-m", "init"]);

      const state = {
        status: "documenting" as const,
        plan: {
          plan_id: "P-worktree",
          findings: [],
          blocks: [
            { block_id: "B1", items: ["F1"], parallel_safe: true },
          ] satisfies RemediationBlock[],
          project_type: "unknown",
          candidate_closing_actions: ["none" as const],
        },
        items: {
          F1: {
            finding_id: "F1",
            status: "documented" as const,
            block_id: "B1",
            item_spec: {
              finding_id: "F1",
              concrete_change: "No-op test fixture",
              tests_to_write: [],
              not_applicable_steps: [
                { step: "Write Tests" as const, rationale: "No-op" },
                { step: "Refactor Code" as const, rationale: "No-op" },
                {
                  step: "Verify Code Against Documentation" as const,
                  rationale: "No-op",
                },
              ],
            },
          },
        },
      };

      const result = await runImplementPhase(state, {
        root: REPO_DIR,
        artifactsDir: ARTIFACTS_DIR,
      });

      expect(result.items!.F1.status).toBe("resolved");
      expect(existsSync(join(ARTIFACTS_DIR, "worktrees", "B1"))).toBe(false);
    } finally {
      await rm(TEST_DIR, { recursive: true, force: true });
    }
  }, 15_000);
});
