import { describe, it, expect } from "vitest";
import { isInfraModifyingBlock } from "../src/steps/dispatch.js";
import type { RemediationBlock } from "../src/state/types.js";
import type { RemediationState } from "../src/state/store.js";
import type { Finding } from "@audit-tools/shared";

// ---------------------------------------------------------------------------
// isInfraModifyingBlock — predicate unit tests
// ---------------------------------------------------------------------------

describe("isInfraModifyingBlock returns true for engine files", () => {
  it("predicate returns true when write_paths includes nextStep.ts", () => {
    expect(
      isInfraModifyingBlock(["packages/remediate-code/src/steps/nextStep.ts"]),
    ).toBe(true);
  });

  it("predicate returns true when write_paths includes dispatch.ts", () => {
    expect(
      isInfraModifyingBlock(["packages/remediate-code/src/steps/dispatch.ts"]),
    ).toBe(true);
  });

  it("predicate returns true when write_paths includes store.ts", () => {
    expect(
      isInfraModifyingBlock(["packages/remediate-code/src/state/store.ts"]),
    ).toBe(true);
  });

  it("predicate returns true when write_paths includes waveScheduler.ts", () => {
    expect(
      isInfraModifyingBlock(["packages/remediate-code/src/steps/waveScheduler.ts"]),
    ).toBe(true);
  });

  it("predicate returns true when write_paths includes contractPipeline.ts", () => {
    expect(
      isInfraModifyingBlock(["packages/remediate-code/src/steps/contractPipeline.ts"]),
    ).toBe(true);
  });

  it("predicate returns true when write_paths includes stepWriter.ts", () => {
    expect(
      isInfraModifyingBlock(["packages/remediate-code/src/steps/stepWriter.ts"]),
    ).toBe(true);
  });

  it("predicate returns true for absolute path ending in the infra segment", () => {
    expect(
      isInfraModifyingBlock([
        "/some/absolute/repo/packages/remediate-code/src/steps/dispatch.ts",
      ]),
    ).toBe(true);
  });

  it("predicate returns true for Windows-style absolute path (backslashes)", () => {
    expect(
      isInfraModifyingBlock([
        "C:\\Code\\audit-tools\\packages\\remediate-code\\src\\steps\\dispatch.ts",
      ]),
    ).toBe(true);
  });

  it("predicate returns true when infra path is mixed with non-infra paths", () => {
    expect(
      isInfraModifyingBlock([
        "packages/remediate-code/src/phases/plan.ts",
        "packages/remediate-code/src/steps/dispatch.ts",
      ]),
    ).toBe(true);
  });
});

describe("isInfraModifyingBlock returns false for non-infra files", () => {
  it("predicate returns false when write_paths contains only plan.ts", () => {
    expect(
      isInfraModifyingBlock(["packages/remediate-code/src/phases/plan.ts"]),
    ).toBe(false);
  });

  it("predicate returns false when write_paths contains only a test file path", () => {
    expect(
      isInfraModifyingBlock([
        "packages/remediate-code/tests/next-step.test.ts",
      ]),
    ).toBe(false);
  });

  it("predicate returns false for an empty write_paths array", () => {
    expect(isInfraModifyingBlock([])).toBe(false);
  });

  it("predicate returns false for unrelated source files", () => {
    expect(
      isInfraModifyingBlock([
        "packages/remediate-code/src/intake.ts",
        "packages/remediate-code/src/reporting/report.ts",
      ]),
    ).toBe(false);
  });

  it("predicate returns false for partial path match that is not a suffix", () => {
    // 'dispatch.ts' as a standalone basename in another package should not match
    expect(
      isInfraModifyingBlock([
        "packages/audit-code/src/steps/dispatch.ts",
      ]),
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

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { prepareImplementDispatch } from "../src/steps/dispatch.js";

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "F-001",
    title: "A finding",
    category: "correctness",
    severity: "medium",
    confidence: "medium",
    lens: "maintainability",
    summary: "Something to fix.",
    affected_files: [{ path: "packages/remediate-code/src/steps/dispatch.ts" }],
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
  it("rendered prompt contains 'Infra-modifying block' heading when isInfraModifyingBlock is true", async () => {
    const dir = join(tmpdir(), `infra-block-test-${Date.now()}`);
    const artifactsDir = join(dir, ".audit-tools", "remediation");
    await mkdir(artifactsDir, { recursive: true });
    await makeMinimalState(artifactsDir, [
      "packages/remediate-code/src/steps/dispatch.ts",
    ]);

    const plan = await prepareImplementDispatch(
      { root: dir, artifactsDir },
      "run-infra-test",
    );

    expect(plan.items.length).toBe(1);
    const promptPath = plan.items[0].prompt_path;
    const promptText = readFileSync(promptPath, "utf8");
    expect(promptText).toContain("Infra-modifying block");

    await rm(dir, { recursive: true, force: true });
  });

  it("infra section is BUILD-FREE: instructs npm run check, never a worker-side build (CE-001)", async () => {
    // The host builds the package centrally; an infra-modifying node must verify
    // build-free (no worker-side `npm run build`) to avoid racing the central
    // build's dist/. (Replaces the prior rebuild-instruction expectation.)
    const dir = join(tmpdir(), `infra-block-test-build-${Date.now()}`);
    const artifactsDir = join(dir, ".audit-tools", "remediation");
    await mkdir(artifactsDir, { recursive: true });
    await makeMinimalState(artifactsDir, [
      "packages/remediate-code/src/steps/dispatch.ts",
    ]);

    const plan = await prepareImplementDispatch(
      { root: dir, artifactsDir },
      "run-infra-build",
    );

    const promptText = readFileSync(plan.items[0].prompt_path, "utf8");
    expect(promptText).toContain("npm run check");
    expect(promptText).not.toContain("npm run build -w packages/remediate-code");

    await rm(dir, { recursive: true, force: true });
  });

  it("infra section does NOT instruct npm test -w (build-prepending) — uses a build-free runner", async () => {
    const dir = join(tmpdir(), `infra-block-test-smoke-${Date.now()}`);
    const artifactsDir = join(dir, ".audit-tools", "remediation");
    await mkdir(artifactsDir, { recursive: true });
    await makeMinimalState(artifactsDir, [
      "packages/remediate-code/src/steps/dispatch.ts",
    ]);

    const plan = await prepareImplementDispatch(
      { root: dir, artifactsDir },
      "run-infra-smoke",
    );

    const promptText = readFileSync(plan.items[0].prompt_path, "utf8");
    expect(promptText).not.toContain("npm test -w packages/remediate-code");
    // The build-free runner is what the worker is pointed at instead.
    expect(promptText).toContain("npx vitest run");

    await rm(dir, { recursive: true, force: true });
  });

  it("infra section delegates the central build + rollback to the host (no dist snapshot directive)", async () => {
    // Because the worker no longer builds/republishes the engine, it cannot
    // brick the live dispatcher; the host owns the central build and any dist
    // rollback. (Replaces the prior 'Snapshot dist' expectation.)
    const dir = join(tmpdir(), `infra-block-test-rollback-${Date.now()}`);
    const artifactsDir = join(dir, ".audit-tools", "remediation");
    await mkdir(artifactsDir, { recursive: true });
    await makeMinimalState(artifactsDir, [
      "packages/remediate-code/src/steps/dispatch.ts",
    ]);

    const plan = await prepareImplementDispatch(
      { root: dir, artifactsDir },
      "run-infra-rollback",
    );

    const promptText = readFileSync(plan.items[0].prompt_path, "utf8");
    expect(promptText).not.toContain("Snapshot dist");
    expect(promptText).toMatch(/host (builds the package centrally|owns the central build)/i);

    await rm(dir, { recursive: true, force: true });
  });

  it("rendered prompt does NOT contain infra section when isInfraModifyingBlock is false", async () => {
    const dir = join(tmpdir(), `infra-block-test-noinfra-${Date.now()}`);
    const artifactsDir = join(dir, ".audit-tools", "remediation");
    await mkdir(artifactsDir, { recursive: true });
    await makeMinimalState(artifactsDir, [
      "packages/remediate-code/src/phases/plan.ts",
    ]);

    const plan = await prepareImplementDispatch(
      { root: dir, artifactsDir },
      "run-noinfra",
    );

    expect(plan.items.length).toBe(1);
    const promptText = readFileSync(plan.items[0].prompt_path, "utf8");
    expect(promptText).not.toContain("Infra-modifying block");

    await rm(dir, { recursive: true, force: true });
  });
});
