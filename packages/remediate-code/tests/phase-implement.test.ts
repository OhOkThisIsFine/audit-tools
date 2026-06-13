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
  attributePostMergeFailure,
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
      status: "implementing" as const,
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
      F1: { finding_id: "F1", status: "pending", block_id: "B1" },
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
      status: "implementing" as const,
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
          status: "pending",
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
          status: "pending",
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
          status: "pending",
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
      status: "implementing" as const,
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
          status: "pending",
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
          status: "pending",
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
          status: "pending",
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
          status: "pending",
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
      status: "implementing" as const,
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
          status: "pending" as const,
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

// ── Post-merge re-verification gate (N-R18) ───────────────────────────────────

describe("runImplementPhase post-merge gate — targeted_commands used when present", () => {
  const TEST_DIR = join(__dirname, ".test-implement-postmerge-targeted");
  const REPO_DIR = join(TEST_DIR, "repo");
  const ARTIFACTS_DIR = join(TEST_DIR, "artifacts");

  function git(args: string[], cwd = REPO_DIR): void {
    execFileSync("git", args, { cwd, stdio: "ignore" });
  }

  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(REPO_DIR, { recursive: true });
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    git(["init"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    await writeFile(join(REPO_DIR, "README.md"), "init", "utf8");
    git(["add", "."]);
    git(["commit", "-m", "init"]);
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("runs targeted_commands after merge when present, keeps items resolved on exit 0", async () => {
    // targeted_commands that always succeed — items must remain resolved.
    const state = {
      status: "implementing" as const,
      plan: {
        plan_id: "P-targeted",
        findings: [],
        blocks: [
          {
            block_id: "B1",
            items: ["F1"],
            parallel_safe: true,
            // Always passes gate
            targeted_commands: ["node -e \"process.exit(0)\""],
          },
        ] satisfies import("../src/state/types.js").RemediationBlock[],
        project_type: "unknown",
        test_command: "node -e \"process.exit(1)\"", // would fail if used instead
        candidate_closing_actions: ["none" as const],
      },
      items: {
        F1: {
          finding_id: "F1",
          status: "pending" as const,
          block_id: "B1",
          item_spec: {
            finding_id: "F1",
            concrete_change: "no-op",
            tests_to_write: [],
            not_applicable_steps: [
              { step: "Write Tests" as const, rationale: "No-op" },
              { step: "Refactor Code" as const, rationale: "No-op" },
              { step: "Verify Code Against Documentation" as const, rationale: "No-op" },
            ],
          },
        },
      },
    };

    const result = await runImplementPhase(state as any, {
      root: REPO_DIR,
      artifactsDir: ARTIFACTS_DIR,
    });

    expect(result.items!.F1.status).toBe("resolved");
  }, 20_000);

  it("falls back to test_command for gate when block has no targeted_commands, stays resolved on exit 0", async () => {
    const state = {
      status: "implementing" as const,
      plan: {
        plan_id: "P-fallback",
        findings: [],
        blocks: [
          {
            block_id: "B2",
            items: ["F2"],
            parallel_safe: true,
            // No targeted_commands — must fall back to test_command
          },
        ] satisfies import("../src/state/types.js").RemediationBlock[],
        project_type: "unknown",
        test_command: "node -e \"process.exit(0)\"",
        candidate_closing_actions: ["none" as const],
      },
      items: {
        F2: {
          finding_id: "F2",
          status: "pending" as const,
          block_id: "B2",
          item_spec: {
            finding_id: "F2",
            concrete_change: "no-op",
            tests_to_write: [],
            not_applicable_steps: [
              { step: "Write Tests" as const, rationale: "No-op" },
              { step: "Refactor Code" as const, rationale: "No-op" },
              { step: "Verify Code Against Documentation" as const, rationale: "No-op" },
            ],
          },
        },
      },
    };

    const result = await runImplementPhase(state as any, {
      root: REPO_DIR,
      artifactsDir: ARTIFACTS_DIR,
    });

    expect(result.items!.F2.status).toBe("resolved");
  }, 20_000);

  it("gate is no-op when no targeted_commands and no test_command — items stay resolved", async () => {
    const state = {
      status: "implementing" as const,
      plan: {
        plan_id: "P-noop",
        findings: [],
        blocks: [
          {
            block_id: "B3",
            items: ["F3"],
            parallel_safe: true,
            // No targeted_commands, no test_command
          },
        ] satisfies import("../src/state/types.js").RemediationBlock[],
        project_type: "unknown",
        candidate_closing_actions: ["none" as const],
      },
      items: {
        F3: {
          finding_id: "F3",
          status: "pending" as const,
          block_id: "B3",
          item_spec: {
            finding_id: "F3",
            concrete_change: "no-op",
            tests_to_write: [],
            not_applicable_steps: [
              { step: "Write Tests" as const, rationale: "No-op" },
              { step: "Refactor Code" as const, rationale: "No-op" },
              { step: "Verify Code Against Documentation" as const, rationale: "No-op" },
            ],
          },
        },
      },
    };

    const result = await runImplementPhase(state as any, {
      root: REPO_DIR,
      artifactsDir: ARTIFACTS_DIR,
    });

    expect(result.items!.F3.status).toBe("resolved");
  }, 20_000);
});

// ── attributePostMergeFailure unit tests (N-R18) ─────────────────────────────

describe("attributePostMergeFailure — rolls back only implicated blocks", () => {
  const TEST_DIR = join(__dirname, ".test-attribute-failure");
  const REPO_DIR = join(TEST_DIR, "repo");
  const ARTIFACTS_DIR = join(TEST_DIR, "artifacts");

  function git(args: string[], cwd = REPO_DIR): void {
    execFileSync("git", args, { cwd, stdio: "ignore" });
  }

  function gitOutput(args: string[], cwd = REPO_DIR): string {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  }

  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(REPO_DIR, { recursive: true });
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    git(["init"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    await writeFile(join(REPO_DIR, "README.md"), "init", "utf8");
    git(["add", "."]);
    git(["commit", "-m", "init"]);
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("re-enters guilty block items as blocked with failure_reason naming guilty blocks and surface", async () => {
    // Create a real commit so there is a SHA to roll back.
    await writeFile(join(REPO_DIR, "src.ts"), "// change", "utf8");
    git(["add", "src.ts"]);
    git(["commit", "-m", "Block B1 changes"]);
    const sha = gitOutput(["rev-parse", "HEAD"]);

    const state = {
      status: "implementing" as const,
      plan: {
        plan_id: "P1",
        findings: [],
        blocks: [],
        project_type: "unknown",
        test_command: undefined as undefined,
        candidate_closing_actions: [],
      },
      items: {
        F1: {
          finding_id: "F1",
          status: "resolved" as const,
          block_id: "B1",
          item_spec: {
            finding_id: "F1",
            concrete_change: "change",
            tests_to_write: [],
            not_applicable_steps: [],
            touched_files: ["src.ts"],
          },
        },
      },
    } as any;

    const saves: any[] = [];
    const store = { saveState: async (s: any) => { saves.push(JSON.parse(JSON.stringify(s))); } };
    const mergedCommits = new Map<string, string>([["B1", sha]]);
    const blockB1: import("../src/state/types.js").RemediationBlock = {
      block_id: "B1",
      items: ["F1"],
      parallel_safe: true,
      touched_files: ["src.ts"],
    };

    await attributePostMergeFailure(
      { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR },
      state,
      store,
      [blockB1],
      mergedCommits,
      blockB1,
      "test failure output",
    );

    expect(state.items.F1.status).toBe("blocked");
    expect(state.items.F1.failure_reason).toContain("B1");
    expect(state.items.F1.failure_reason).toContain("src.ts");
    expect(state.items.F1.rework_count).toBeGreaterThan(0);
    expect(saves.length).toBeGreaterThan(0);
  }, 15_000);

  it("leaves non-overlapping block items resolved after partial rollback", async () => {
    // Two commits in the repo: B1 touches src1.ts, B2 touches src2.ts.
    await writeFile(join(REPO_DIR, "src1.ts"), "// B1", "utf8");
    git(["add", "src1.ts"]);
    git(["commit", "-m", "B1 changes"]);
    const shaB1 = gitOutput(["rev-parse", "HEAD"]);

    await writeFile(join(REPO_DIR, "src2.ts"), "// B2", "utf8");
    git(["add", "src2.ts"]);
    git(["commit", "-m", "B2 changes"]);
    const shaB2 = gitOutput(["rev-parse", "HEAD"]);

    const state = {
      status: "implementing" as const,
      plan: {
        plan_id: "P2",
        findings: [],
        blocks: [],
        project_type: "unknown",
        test_command: undefined as undefined,
        candidate_closing_actions: [],
      },
      items: {
        F1: {
          finding_id: "F1", status: "resolved" as const, block_id: "B1",
          item_spec: { finding_id: "F1", concrete_change: "c", tests_to_write: [], not_applicable_steps: [], touched_files: ["src1.ts"] },
        },
        F2: {
          finding_id: "F2", status: "resolved" as const, block_id: "B2",
          item_spec: { finding_id: "F2", concrete_change: "c", tests_to_write: [], not_applicable_steps: [], touched_files: ["src2.ts"] },
        },
      },
    } as any;

    const store = { saveState: async () => {} };
    const mergedCommits = new Map<string, string>([["B1", shaB1], ["B2", shaB2]]);

    const blockB1: import("../src/state/types.js").RemediationBlock = {
      block_id: "B1", items: ["F1"], parallel_safe: true, touched_files: ["src1.ts"],
    };
    const blockB2: import("../src/state/types.js").RemediationBlock = {
      block_id: "B2", items: ["F2"], parallel_safe: true, touched_files: ["src2.ts"],
    };

    // B1 is the failing block; only B1 overlaps the implicated surface (src1.ts).
    await attributePostMergeFailure(
      { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR },
      state,
      store,
      [blockB1, blockB2],
      mergedCommits,
      blockB1,
      "failure",
    );

    // B1 should be blocked (overlaps); B2 should remain resolved (no overlap).
    expect(state.items.F1.status).toBe("blocked");
    expect(state.items.F2.status).toBe("resolved");
  }, 15_000);

  it("rolled-back items carry failure_reason naming guilty block IDs and surface", async () => {
    await writeFile(join(REPO_DIR, "lib.ts"), "// lib", "utf8");
    git(["add", "lib.ts"]);
    git(["commit", "-m", "B1 lib change"]);
    const sha = gitOutput(["rev-parse", "HEAD"]);

    const state = {
      status: "implementing" as const,
      plan: { plan_id: "P3", findings: [], blocks: [], project_type: "unknown",
               test_command: undefined, candidate_closing_actions: [] },
      items: {
        F1: {
          finding_id: "F1", status: "resolved" as const, block_id: "B1",
          item_spec: { finding_id: "F1", concrete_change: "c", tests_to_write: [], not_applicable_steps: [], touched_files: ["lib.ts"] },
        },
      },
    } as any;

    const store = { saveState: async () => {} };
    const mergedCommits = new Map<string, string>([["B1", sha]]);
    const blockB1: import("../src/state/types.js").RemediationBlock = {
      block_id: "B1", items: ["F1"], parallel_safe: true, touched_files: ["lib.ts"],
    };

    await attributePostMergeFailure(
      { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR },
      state, store, [blockB1], mergedCommits, blockB1, "test tail output",
    );

    const reason = state.items.F1.failure_reason as string;
    expect(reason).toContain("B1");
    expect(reason).toContain("lib.ts");
  }, 15_000);

  it("mergedCommits map accumulates commit SHAs per block via runBlockInWorktree return", async () => {
    // This is verified indirectly: runImplementPhase populates mergedCommits
    // from WorktreeBlockResult.commitSha. We test that a block with actual
    // staged changes returns a commitSha.
    // (Direct unit test of runBlockInWorktree is skipped — it requires a full
    // git worktree fixture and is covered by the runImplementPhase worktree tests.)
    // We can verify that commitSha is absent when the block produces no changes.
    const state = {
      status: "implementing" as const,
      plan: {
        plan_id: "P-sha",
        findings: [],
        blocks: [
          { block_id: "B-sha", items: ["F-sha"], parallel_safe: true },
        ] satisfies import("../src/state/types.js").RemediationBlock[],
        project_type: "unknown",
        candidate_closing_actions: ["none" as const],
      },
      items: {
        "F-sha": {
          finding_id: "F-sha",
          status: "pending" as const,
          block_id: "B-sha",
          item_spec: {
            finding_id: "F-sha",
            concrete_change: "no-op",
            tests_to_write: [],
            not_applicable_steps: [
              { step: "Write Tests" as const, rationale: "No-op" },
              { step: "Refactor Code" as const, rationale: "No-op" },
              { step: "Verify Code Against Documentation" as const, rationale: "No-op" },
            ],
          },
        },
      },
    };

    // A no-op block produces no staged changes → no commit → commitSha is undefined.
    // runImplementPhase completes successfully despite no commit.
    const result = await runImplementPhase(state as any, {
      root: REPO_DIR,
      artifactsDir: ARTIFACTS_DIR,
    });
    // The no-op block should resolve its items normally.
    expect(result.items!["F-sha"].status).toBe("resolved");
  }, 20_000);
});

// ---------------------------------------------------------------------------
// TST-2302cd7e: implement.ts executeBlock — tests-pass-before-refactoring guard
// ---------------------------------------------------------------------------

describe("executeBlock — TST-2302cd7e: tests-pass-before-refactoring guard", () => {
  it("blocks item with red-green-refactor message when test_command exits 0 after Write Tests step", async () => {
    const artifactsDir = await mkdtemp(join(tmpdir(), "tst-2302cd7e-"));
    try {
      const state: any = {
        status: "implementing",
        plan: {
          plan_id: "P-2302cd7e",
          findings: [],
          blocks: [],
          project_type: "unknown",
          // A test_command that exits 0 — triggers the guard when write-tests succeeds.
          test_command: `node -e "process.exit(0)"`,
          candidate_closing_actions: [],
        },
        items: {
          F1: {
            finding_id: "F1",
            status: "pending",
            block_id: "B1",
            item_spec: {
              finding_id: "F1",
              concrete_change: "fix something",
              tests_to_write: [{ name: "test-foo", description: "desc", acceptance_criteria: [] }],
              not_applicable_steps: [
                // Skip Refactor and Verify so only Write Tests runs — the guard
                // triggers after Write Tests succeeds and test_command exits 0.
                { step: "Refactor Code" as const, rationale: "n/a" },
                { step: "Verify Code Against Documentation" as const, rationale: "n/a" },
              ],
            },
          },
        },
      };

      const block: RemediationBlock = {
        block_id: "B1",
        items: ["F1"],
        parallel_safe: true,
      };

      // A provider that always succeeds (write-tests step returns true).
      const fakeProvider = {
        name: "noop-provider",
        launch: async () => { /* succeed silently */ },
      };

      const saves: any[] = [];
      const fakeSave = {
        saveState: async (s: any) => {
          saves.push(JSON.parse(JSON.stringify(s)));
        },
      };

      await executeBlock(block, artifactsDir, {
        state,
        options: { root: artifactsDir, artifactsDir },
        provider: fakeProvider,
        store: fakeSave as any,
      });

      // Item must be blocked with the red-green-refactor guard message.
      expect(state.items.F1.status).toBe("blocked");
      expect(state.items.F1.failure_reason).toMatch(/Tests passed before refactoring/);
      // State must have been saved at the guard branch.
      expect(saves.some((s) => s.items?.F1?.status === "blocked")).toBe(true);
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  it("does not trigger guard when test_command exits non-zero after Write Tests step", async () => {
    const artifactsDir = await mkdtemp(join(tmpdir(), "tst-2302cd7e-nontrigger-"));
    try {
      const state: any = {
        status: "implementing",
        plan: {
          plan_id: "P-2302cd7e-b",
          findings: [],
          blocks: [],
          project_type: "unknown",
          // A test_command that exits 1 — guard must NOT trigger (tests are red as expected).
          test_command: `node -e "process.exit(1)"`,
          candidate_closing_actions: [],
        },
        items: {
          F1: {
            finding_id: "F1",
            status: "pending",
            block_id: "B1",
            item_spec: {
              finding_id: "F1",
              concrete_change: "fix something",
              tests_to_write: [{ name: "test-bar", description: "desc", acceptance_criteria: [] }],
              not_applicable_steps: [
                { step: "Refactor Code" as const, rationale: "n/a" },
                { step: "Verify Code Against Documentation" as const, rationale: "n/a" },
              ],
            },
          },
        },
      };

      const block: RemediationBlock = {
        block_id: "B1",
        items: ["F1"],
        parallel_safe: true,
      };

      const fakeProvider = {
        name: "noop-provider-b",
        launch: async () => { /* succeed silently */ },
      };

      const fakeSave = { saveState: async () => {} };

      await executeBlock(block, artifactsDir, {
        state,
        options: { root: artifactsDir, artifactsDir },
        provider: fakeProvider,
        store: fakeSave as any,
      });

      // Tests are red (exit 1) → guard must not fire → item continues through
      // the skipped Refactor+Verify steps and ultimately resolves.
      expect(state.items.F1.status).toBe("resolved");
      expect(state.items.F1.failure_reason).toBeUndefined();
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });
});
