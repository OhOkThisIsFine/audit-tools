import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isInfraModifyingBlock } from "../../src/remediate/steps/dispatch.js";
import type { RemediationBlock } from "../../src/remediate/state/types.js";
import type { RemediationState } from "../../src/remediate/state/store.js";
import type { Finding } from "audit-tools/shared";

// ---------------------------------------------------------------------------
// isInfraModifyingBlock — predicate unit tests
// ---------------------------------------------------------------------------

// Post-A12 the package is single-tree: infra modules live at
// `src/remediate/...`, NOT the former `packages/remediate-code/src/...`. These
// cases pin the predicate to the REAL on-disk layout — they would all fail
// against the stale pre-A12 path list (which matched nothing after the collapse,
// so every infra block rendered as non-infra).
describe("isInfraModifyingBlock returns true for engine files (current src/remediate layout)", () => {
  it("predicate returns true when write_paths includes nextStep.ts", () => {
    expect(isInfraModifyingBlock(["src/remediate/steps/nextStep.ts"])).toBe(true);
  });

  it("predicate returns true when write_paths includes dispatch.ts", () => {
    expect(isInfraModifyingBlock(["src/remediate/steps/dispatch.ts"])).toBe(true);
  });

  it("predicate returns true when write_paths includes store.ts", () => {
    expect(isInfraModifyingBlock(["src/remediate/state/store.ts"])).toBe(true);
  });

  it("predicate returns true when write_paths includes contractPipeline.ts", () => {
    expect(isInfraModifyingBlock(["src/remediate/steps/contractPipeline.ts"])).toBe(true);
  });

  it("predicate returns true when write_paths includes stepWriter.ts", () => {
    expect(isInfraModifyingBlock(["src/remediate/steps/stepWriter.ts"])).toBe(true);
  });

  it("predicate returns true for absolute path ending in the infra segment", () => {
    expect(
      isInfraModifyingBlock(["/some/absolute/repo/src/remediate/steps/dispatch.ts"]),
    ).toBe(true);
  });

  it("predicate returns true for Windows-style absolute path (backslashes normalized)", () => {
    expect(
      isInfraModifyingBlock([
        "C:\\Code\\audit-tools\\src\\remediate\\steps\\dispatch.ts",
      ]),
    ).toBe(true);
  });

  it("predicate returns true for a worktree absolute path (the dogfood spelling)", () => {
    expect(
      isInfraModifyingBlock([
        "C:\\Code\\audit-tools\\.audit-tools\\worktrees\\remediate-X\\src\\remediate\\state\\store.ts",
      ]),
    ).toBe(true);
  });

  it("predicate returns true when infra path is mixed with non-infra paths", () => {
    expect(
      isInfraModifyingBlock([
        "src/remediate/phases/plan.ts",
        "src/remediate/steps/dispatch.ts",
      ]),
    ).toBe(true);
  });
});

describe("isInfraModifyingBlock returns false for non-infra files", () => {
  it("predicate returns false when write_paths contains only plan.ts", () => {
    expect(isInfraModifyingBlock(["src/remediate/phases/plan.ts"])).toBe(false);
  });

  it("predicate returns false when write_paths contains only a test file path", () => {
    expect(
      isInfraModifyingBlock(["tests/remediate/next-step.test.ts"]),
    ).toBe(false);
  });

  it("predicate returns false for an empty write_paths array", () => {
    expect(isInfraModifyingBlock([])).toBe(false);
  });

  it("predicate returns false for the now-removed waveScheduler.ts (inlined into dispatch)", () => {
    // waveScheduler.ts no longer exists post-inlining; it must NOT be flagged.
    expect(
      isInfraModifyingBlock(["src/remediate/steps/waveScheduler.ts"]),
    ).toBe(false);
  });

  it("predicate returns false for unrelated source files", () => {
    expect(
      isInfraModifyingBlock([
        "src/remediate/intake.ts",
        "src/remediate/reporting/report.ts",
      ]),
    ).toBe(false);
  });

  it("predicate returns false for a same-basename file in another area (src/audit)", () => {
    // 'dispatch.ts' under src/audit must not match src/remediate's infra entry.
    expect(
      isInfraModifyingBlock(["src/audit/steps/dispatch.ts"]),
    ).toBe(false);
  });

  it("predicate returns false for the stale pre-A12 monorepo path", () => {
    // The old packages/remediate-code/... spelling no longer corresponds to any
    // real file and must not be treated as infra.
    expect(
      isInfraModifyingBlock(["packages/remediate-code/src/steps/dispatch.ts"]),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// implementPrompt includes live-surface verification section for infra blocks
// ---------------------------------------------------------------------------

// We test the rendered prompt indirectly by exercising prepareImplementDispatch
// with a minimal state that contains a block whose write path is an infra file.
// To keep the test self-contained and fast we import the prompt builder helpers
// exposed from dispatch.ts and render the prompt directly.

// Re-export the private implementPrompt via a thin wrapper is not feasible
// without changing the module surface. Instead, we test via the dispatch plan
// artefacts produced by prepareImplementDispatch — but that requires a real
// filesystem and StateStore setup. A simpler, lower-friction approach is to
// directly test the exported predicate and verify the section text is present
// by constructing a minimal inline state and calling the internal logic through
// a thin test shim.
//
// Since implementPrompt is not exported, we verify the invariant through a
// snapshot of what the rendered file contains after calling
// prepareImplementDispatch with an infra-touching block. We import the
// relevant filesystem helpers inline.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { prepareImplementDispatch } from "../../src/remediate/steps/dispatch.js";

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "F-001",
    title: "A finding",
    category: "correctness",
    severity: "medium",
    confidence: "medium",
    lens: "maintainability",
    summary: "Something to fix.",
    affected_files: [{ path: "src/remediate/steps/dispatch.ts" }],
    evidence: [],
    ...overrides,
  };
}

async function makeMinimalState(
  artifactsDir: string,
  writePaths: string[],
): Promise<void> {
  const finding = makeFinding({
    affected_files: writePaths.map((p) => ({ path: p })),
  });
  const state = {
    status: "implementing",
    plan: {
      // INV-RSM-STATE-COMPLETE: an implementing state persists plan identity.
      plan_id: "PLAN-INFRA-TEST",
      findings: [finding],
      blocks: [
        {
          block_id: "TEST-BLOCK-001",
          items: [finding.id],
          deps: [],
        } as RemediationBlock,
      ],
    },
    items: {
      [finding.id]: {
        finding_id: finding.id,
        block_id: "TEST-BLOCK-001",
        status: "pending",
        item_spec: {
          finding_id: finding.id,
          concrete_change: "add the predicate",
          no_change: false,
          touched_files: writePaths,
          tests_to_write: [],
          not_applicable_steps: [],
        },
      },
    },
    closing_plan: { action: "none" },
  };
  await writeFile(join(artifactsDir, "state.json"), JSON.stringify(state, null, 2));
}

describe("implementPrompt includes live-surface verification section for infra-modifying blocks", () => {
  // TST-b08cda90: use a per-test mkdtemp scratch dir created/removed via
  // beforeEach/afterEach. mkdtemp guarantees a unique path (no Date.now()
  // collision when two cases run in the same millisecond), and afterEach removes
  // it even when an assertion throws mid-test (the prior inline `rm` leaked).
  let dir: string;
  let artifactsDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "infra-block-test-"));
    artifactsDir = join(dir, ".audit-tools", "remediation");
    await mkdir(artifactsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("rendered prompt contains 'Infra-modifying block' heading when isInfraModifyingBlock is true", async () => {
    await makeMinimalState(artifactsDir, [
      "src/remediate/steps/dispatch.ts",
    ]);

    const plan = await prepareImplementDispatch(
      { root: dir, artifactsDir },
      "run-infra-test",
    );

    expect(plan.items.length).toBe(1);
    const promptPath = plan.items[0].prompt_path;
    const promptText = readFileSync(promptPath, "utf8");
    expect(promptText).toContain("Infra-modifying block");
  });

  it("infra section is BUILD-FREE: instructs npm run check, never a worker-side build (CE-001)", async () => {
    // The host builds the package centrally; an infra-modifying node must verify
    // build-free (no worker-side `npm run build`) to avoid racing the central
    // build's dist/. (Replaces the prior rebuild-instruction expectation.)
    await makeMinimalState(artifactsDir, [
      "src/remediate/steps/dispatch.ts",
    ]);

    const plan = await prepareImplementDispatch(
      { root: dir, artifactsDir },
      "run-infra-build",
    );

    const promptText = readFileSync(plan.items[0].prompt_path, "utf8");
    expect(promptText).toContain("npm run check");
    // The stale pre-A12 workspace build directive must never resurface. (The
    // current `npm run build` string legitimately appears in the section's
    // "do NOT run `npm run build`" prose, so this negative stays spelled to the
    // dead -w directive form rather than matching that prohibition.)
    expect(promptText).not.toContain("npm run build -w packages/remediate-code");
  });

  it("infra section does NOT instruct npm test -w (build-prepending) — uses a build-free runner", async () => {
    await makeMinimalState(artifactsDir, [
      "src/remediate/steps/dispatch.ts",
    ]);

    const plan = await prepareImplementDispatch(
      { root: dir, artifactsDir },
      "run-infra-smoke",
    );

    const promptText = readFileSync(plan.items[0].prompt_path, "utf8");
    // The stale pre-A12 workspace test directive must never resurface. (`npm test`
    // appears in the section's "do NOT run `npm test`" prose, so this negative
    // stays spelled to the dead -w directive form, not the prohibition.)
    expect(promptText).not.toContain("npm test -w packages/remediate-code");
    // The build-free runner is what the worker is pointed at instead.
    expect(promptText).toContain("npx vitest run");
  });

  it("infra section delegates the central build + rollback to the host (no dist snapshot directive)", async () => {
    // Because the worker no longer builds/republishes the engine, it cannot
    // brick the live dispatcher; the host owns the central build and any dist
    // rollback. (Replaces the prior 'Snapshot dist' expectation.)
    await makeMinimalState(artifactsDir, [
      "src/remediate/steps/dispatch.ts",
    ]);

    const plan = await prepareImplementDispatch(
      { root: dir, artifactsDir },
      "run-infra-rollback",
    );

    const promptText = readFileSync(plan.items[0].prompt_path, "utf8");
    expect(promptText).not.toContain("Snapshot dist");
    expect(promptText).toMatch(/host (builds the package centrally|owns the central build)/i);
  });

  it("rendered prompt does NOT contain infra section when isInfraModifyingBlock is false", async () => {
    await makeMinimalState(artifactsDir, [
      "src/remediate/phases/plan.ts",
    ]);

    const plan = await prepareImplementDispatch(
      { root: dir, artifactsDir },
      "run-noinfra",
    );

    expect(plan.items.length).toBe(1);
    const promptText = readFileSync(plan.items[0].prompt_path, "utf8");
    expect(promptText).not.toContain("Infra-modifying block");
  });
});
