import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

    await executeBlock(block, tmpdir(), {
      state: state as any,
      options: { root: tmpdir(), artifactsDir: join(tmpdir(), "arts") },
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

    await executeBlock(block, tmpdir(), {
      state: state as any,
      options: { root: tmpdir(), artifactsDir: join(tmpdir(), "arts") },
      provider: { name: "test", launch: async () => {} },
      store: fakeSave as any,
    });

    expect(state.items.F1.status).toBe("blocked");
    expect(state.items.F1.failure_reason).toMatch(/item_spec/);
  });
});

// ── runStepWithProvider enriched error log (OBS-32fca1dd) ────────────────────

describe("runStepWithProvider enriched error log", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeState(planId: string, items: Record<string, any>) {
    return {
      status: "documenting" as const,
      plan: {
        plan_id: planId,
        findings: [],
        blocks: [],
        project_type: "typescript-node",
        test_command: undefined,
        candidate_closing_actions: [],
      },
      items,
    };
  }

  it("logs event=step_failed with finding_id and step when provider.launch() rejects", async () => {
    const artifactsDir = await mkdtemp(join(tmpdir(), "obs-32fca1dd-"));
    try {
      const planId = "PLAN-obs32";
      const state = makeState(planId, {
        F1: {
          finding_id: "F1",
          status: "documented",
          block_id: "B1",
          item_spec: {
            finding_id: "F1",
            concrete_change: "change",
            tests_to_write: [],
            not_applicable_steps: [
              { step: "Refactor Code" as const, rationale: "n/a" },
              { step: "Verify Code Against Documentation" as const, rationale: "n/a" },
            ],
          },
        },
      });
      const block: RemediationBlock = { block_id: "B1", items: ["F1"], parallel_safe: false };

      const launchError = Object.assign(new Error("spawn failed"), { exitCode: 127 });
      const fakeProvider = {
        name: "fake-provider",
        launch: async () => { throw launchError; },
      };

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const fakeSave = { saveState: async () => {} };

      await executeBlock(block, artifactsDir, {
        state: state as any,
        options: { root: artifactsDir, artifactsDir },
        provider: fakeProvider,
        store: fakeSave as any,
      });

      const errorArgs = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(errorArgs).toContain("event=step_failed");
      expect(errorArgs).toContain("finding_id=F1");
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  it("logs event=step_failed when provider.launch() rejects without an exitCode", async () => {
    const artifactsDir = await mkdtemp(join(tmpdir(), "obs-32fca1dd-nocode-"));
    try {
      const planId = "PLAN-obs32b";
      const state = makeState(planId, {
        F2: {
          finding_id: "F2",
          status: "documented",
          block_id: "B2",
          item_spec: {
            finding_id: "F2",
            concrete_change: "change",
            tests_to_write: [],
            not_applicable_steps: [
              { step: "Refactor Code" as const, rationale: "n/a" },
              { step: "Verify Code Against Documentation" as const, rationale: "n/a" },
            ],
          },
        },
      });
      const block: RemediationBlock = { block_id: "B2", items: ["F2"], parallel_safe: false };

      const launchError = new Error("network error"); // no exitCode
      const fakeProvider = {
        name: "net-provider",
        launch: async () => { throw launchError; },
      };

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const fakeSave = { saveState: async () => {} };

      await executeBlock(block, artifactsDir, {
        state: state as any,
        options: { root: artifactsDir, artifactsDir },
        provider: fakeProvider,
        store: fakeSave as any,
      });

      const errorArgs = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(errorArgs).toContain("event=step_failed");
      expect(errorArgs).toContain("finding_id=F2");
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  it("returns false after the enriched error log", async () => {
    const artifactsDir = await mkdtemp(join(tmpdir(), "obs-32fca1dd-ret-"));
    try {
      const state = makeState("PLAN-obs32c", {
        F3: {
          finding_id: "F3",
          status: "documented",
          block_id: "B3",
          item_spec: {
            finding_id: "F3",
            concrete_change: "change",
            tests_to_write: [],
            not_applicable_steps: [
              { step: "Refactor Code" as const, rationale: "n/a" },
              { step: "Verify Code Against Documentation" as const, rationale: "n/a" },
            ],
          },
        },
      });
      const block: RemediationBlock = { block_id: "B3", items: ["F3"], parallel_safe: false };

      const fakeProvider = {
        name: "prov",
        launch: async () => { throw new Error("fail"); },
      };

      vi.spyOn(console, "error").mockImplementation(() => {});
      const fakeSave = { saveState: async () => {} };

      await executeBlock(block, artifactsDir, {
        state: state as any,
        options: { root: artifactsDir, artifactsDir },
        provider: fakeProvider,
        store: fakeSave as any,
      });

      // executeBlock marks the item as blocked when the step returns false.
      expect(state.items.F3.status).toBe("blocked");
      expect(state.items.F3.failure_reason).toMatch(/Write Tests failed/);
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });
});

// ── runStepWithProvider structured log (OBS-a4428a4c) ────────────────────────

describe("runStepWithProvider structured log on provider launch failure", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeState(items: Record<string, any>) {
    return {
      status: "documenting" as const,
      plan: {
        plan_id: "PLAN-obs-a4",
        findings: [],
        blocks: [],
        project_type: "typescript-node",
        test_command: undefined,
        candidate_closing_actions: [],
      },
      items,
    };
  }

  it("emits event=step_failed when provider.launch() throws", async () => {
    const artifactsDir = await mkdtemp(join(tmpdir(), "obs-a4428a4c-"));
    try {
      const findingId = "FX1";
      const state = makeState({
        [findingId]: {
          finding_id: findingId,
          status: "documented",
          block_id: "BX1",
          item_spec: {
            finding_id: findingId,
            concrete_change: "change",
            tests_to_write: [],
            not_applicable_steps: [
              { step: "Refactor Code" as const, rationale: "n/a" },
              { step: "Verify Code Against Documentation" as const, rationale: "n/a" },
            ],
          },
        },
      });
      const block: RemediationBlock = { block_id: "BX1", items: [findingId], parallel_safe: false };
      const fakeProvider = {
        name: "prov-obs-a4",
        launch: async () => { throw new Error("launch failure"); },
      };
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const fakeSave = { saveState: async () => {} };

      await executeBlock(block, artifactsDir, {
        state: state as any,
        options: { root: artifactsDir, artifactsDir },
        provider: fakeProvider,
        store: fakeSave as any,
      });

      const logged = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toContain("event=step_failed");
      expect(logged).toContain(`finding_id=${findingId}`);
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  it("includes step= in the log line when provider.launch() throws", async () => {
    const artifactsDir = await mkdtemp(join(tmpdir(), "obs-a4428a4c-step-"));
    try {
      const findingId = "FX2";
      const state = makeState({
        [findingId]: {
          finding_id: findingId,
          status: "documented",
          block_id: "BX2",
          item_spec: {
            finding_id: findingId,
            concrete_change: "change",
            tests_to_write: [],
            not_applicable_steps: [
              { step: "Refactor Code" as const, rationale: "n/a" },
              { step: "Verify Code Against Documentation" as const, rationale: "n/a" },
            ],
          },
        },
      });
      const block: RemediationBlock = { block_id: "BX2", items: [findingId], parallel_safe: false };
      const fakeProvider = {
        name: "prov-obs-a4-step",
        launch: async () => { throw new Error("launch failure"); },
      };
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const fakeSave = { saveState: async () => {} };

      await executeBlock(block, artifactsDir, {
        state: state as any,
        options: { root: artifactsDir, artifactsDir },
        provider: fakeProvider,
        store: fakeSave as any,
      });

      const logged = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toContain("step=");
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  it("includes stdout= and stderr= artifact paths in the log line", async () => {
    const artifactsDir = await mkdtemp(join(tmpdir(), "obs-a4428a4c-paths-"));
    try {
      const findingId = "FX3";
      const state = makeState({
        [findingId]: {
          finding_id: findingId,
          status: "documented",
          block_id: "BX3",
          item_spec: {
            finding_id: findingId,
            concrete_change: "change",
            tests_to_write: [],
            not_applicable_steps: [
              { step: "Refactor Code" as const, rationale: "n/a" },
              { step: "Verify Code Against Documentation" as const, rationale: "n/a" },
            ],
          },
        },
      });
      const block: RemediationBlock = { block_id: "BX3", items: [findingId], parallel_safe: false };
      const fakeProvider = {
        name: "prov-obs-a4-paths",
        launch: async () => { throw new Error("launch failure"); },
      };
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const fakeSave = { saveState: async () => {} };

      await executeBlock(block, artifactsDir, {
        state: state as any,
        options: { root: artifactsDir, artifactsDir },
        provider: fakeProvider,
        store: fakeSave as any,
      });

      const logged = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toContain("stdout=");
      expect(logged).toContain("stderr=");
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  it("returns false (item blocked) when provider.launch() throws", async () => {
    const artifactsDir = await mkdtemp(join(tmpdir(), "obs-a4428a4c-ret-"));
    try {
      const findingId = "FX4";
      const state = makeState({
        [findingId]: {
          finding_id: findingId,
          status: "documented",
          block_id: "BX4",
          item_spec: {
            finding_id: findingId,
            concrete_change: "change",
            tests_to_write: [],
            not_applicable_steps: [
              { step: "Refactor Code" as const, rationale: "n/a" },
              { step: "Verify Code Against Documentation" as const, rationale: "n/a" },
            ],
          },
        },
      });
      const block: RemediationBlock = { block_id: "BX4", items: [findingId], parallel_safe: false };
      const fakeProvider = {
        name: "prov-obs-a4-ret",
        launch: async () => { throw new Error("launch failure"); },
      };
      vi.spyOn(console, "error").mockImplementation(() => {});
      const fakeSave = { saveState: async () => {} };

      await executeBlock(block, artifactsDir, {
        state: state as any,
        options: { root: artifactsDir, artifactsDir },
        provider: fakeProvider,
        store: fakeSave as any,
      });

      expect((state.items as any)[findingId].status).toBe("blocked");
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });
});

describe("runImplementPhase worktree execution", () => {
  const TEST_DIR = join(__dirname, ".test-implement-worktree");
  const REPO_DIR = join(TEST_DIR, "repo");
  const ARTIFACTS_DIR = join(TEST_DIR, "artifacts");

  function git(args: string[], cwd = REPO_DIR): void {
    execFileSync("git", args, { cwd, stdio: "ignore" });
  }

  function makeWorktreeState() {
    return {
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
  }

  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(REPO_DIR, { recursive: true });
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    git(["init"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test User"]);
    await writeFile(join(REPO_DIR, "README.md"), "initial", "utf8");
    git(["add", "."]);
    git(["commit", "-m", "init"]);
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("runs parallel-safe blocks through worktrees and merges block state", async () => {
    const state = makeWorktreeState();

    const result = await runImplementPhase(state, {
      root: REPO_DIR,
      artifactsDir: ARTIFACTS_DIR,
    });

    expect(result.items!.F1.status).toBe("resolved");
    expect(existsSync(join(ARTIFACTS_DIR, "worktrees", "B1"))).toBe(false);
  }, 15_000);

  it("recovers worktree mode despite a stale block branch from a crashed run", async () => {
    // Simulate a crashed prior attempt that leaked the per-block branch. The
    // old two-step creation then failed every retry on `git branch` and
    // permanently forced sequential mode, never cleaning the branch (COR-001).
    git(["branch", "remediator-block-B1"]);

    const state = makeWorktreeState();

    const result = await runImplementPhase(state, {
      root: REPO_DIR,
      artifactsDir: ARTIFACTS_DIR,
    });

    expect(result.items!.F1.status).toBe("resolved");
    // The stale branch must be gone: the fix deletes it, recreates the
    // worktree atomically, then removes the branch on merge. The old code
    // left it dangling because it bailed to sequential mode before any cleanup.
    const branches = execFileSync(
      "git",
      ["branch", "--list", "remediator-block-B1"],
      { cwd: REPO_DIR, encoding: "utf8" },
    );
    expect(branches.trim()).toBe("");
    expect(existsSync(join(ARTIFACTS_DIR, "worktrees", "B1"))).toBe(false);
  }, 15_000);
});
